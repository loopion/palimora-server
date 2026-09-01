# E1 — Admin User Impersonation (debugging) — Design

Date: 2026-09-01
Status: implemented (E1)
Phase: E (admin + monitoring). Sub-project 1 of 2 (E1 impersonation, E2 Kraken model
monitoring/switching — separate spec/plan cycle after E1).

## 1. Goal

Let an admin act as another user through the existing web SPA to reproduce and
debug support issues, with a full audit trail. Impersonation is expressed as an
`X-Impersonate: <user_id>` HTTP header added by the SPA; the backend resolves it
in the auth layer. Money- and credit-spending actions are blocked while
impersonating; benign edits are allowed. Every session boundary and every
mutation is written to a new audit table, exposed via an admin endpoint and an
admin-panel section.

Non-goals for E1 (tracked / out of scope):
- Minted impersonation tokens or a signed "act-as" grant — rejected; the header
  + audit approach is deliberate.
- Read-only "view as" mode — rejected; benign writes are wanted.
- Kraken model monitoring, `rec_model_path` override, per-page OCR timing, model
  admin panel — all E2.
- Proactive alerting of any kind — E2 is admin-panel-only too.
- Time-boxing / auto-expiry of an impersonation session — not in E1; the admin
  ends it explicitly (or it ends when the SPA drops the header).

## 2. Resolution & guard rails (`app/auth.py`, `app/main.py`)

### 2.1 Header resolution — Approach A

Modify `get_current_user` (`app/auth.py`) so that, after the real device token
resolves to a `User`:

1. Read `request.headers.get("X-Impersonate")`. Absent → behave exactly as today,
   return the real user.
2. Present, but the real user is **not** `is_admin` → `403` "Impersonation
   réservée aux administrateurs".
3. Present, target id unknown **or** target `is_active` is false →
   `404` "Utilisateur introuvable".
4. Present, target `is_admin` is true → `403` "Impersonation d'un administrateur
   interdite".
5. Otherwise: set `request.state.impersonator_id = <real admin id>` and
   `request.state.impersonated_id = <target id>`, and **return the target
   `User`**.

`get_admin_user` stays `Depends(get_current_user)` + `is_admin` check. Because it
now receives the *target* (a non-admin, per rule 4), every `/api/admin/*` route
returns `403` automatically while impersonating — no per-route change. This is the
desired behaviour (an admin cannot use the admin panel "as" someone else).

`request.state` is not set for non-impersonated requests; middleware and handlers
must use `getattr(request.state, "impersonated_id", None)`.

Rejected alternatives:
- **Approach B** — a per-route `Actor` dependency threaded through all ~23
  mutating routes. Error-prone (easy to miss one), large diff.
- **Approach C** — minted token. User already declined.

### 2.2 Write block — one HTTP middleware

Add a single `@app.middleware("http")` in `app/main.py` (currently only
`CORSMiddleware` is registered). It inspects the request *before* calling the
route, and inspects the response *after*:

1. If `request.method` in `{GET, HEAD, OPTIONS}` → `call_next`, no checks.
2. Resolve whether this request is impersonated. The middleware runs before
   FastAPI dependency resolution, so `request.state.impersonated_id` is **not yet
   set**. The middleware therefore does its own lightweight check: read
   `X-Impersonate`; if absent → `call_next` unchanged. If present, it does not
   re-validate admin-ness (the dependency will do that and 403/404 as needed) —
   it only decides whether the *path* is allowed under impersonation.
3. Blocked path patterns (mutating requests only, i.e. non-GET) while
   `X-Impersonate` is present:
   - any path starting `/api/billing/`
   - any path starting `/api/stripe/` (webhook — belt and braces; the SPA would
     never call it, but the header must never reach a money path)
   - `POST /api/documents/{id}/finalize`
   - `POST /api/pages/{id}/reocr`
   → respond `403` JSON `{"detail": "Action indisponible en mode impersonation"}`,
   do not call the route.
4. `POST /api/pages/{id}/ai-suggest` is **allowed** (AI correction cost is 0
   today — D1 rebrand). Noted as a revisit point if AI ever costs credits again.
5. Everything else non-GET (upload, `PATCH .../transcription`, validate,
   glossary add/delete, document title `PATCH`, suggestion accept/reject,
   document delete) → allowed.
6. The two impersonation control endpoints themselves (`§3.2`) are matched
   *before* the block list and always allowed (they are admin-only via their own
   dependency, and must work regardless).

Path matching uses `request.url.path` with simple prefix / regex checks; the
`{id}` segments are matched with a regex like
`^/api/documents/[^/]+/finalize$`.

### 2.3 Interaction summary

| Request while impersonating        | Result |
|------------------------------------|--------|
| `GET` anything the target can see  | 200, target's data |
| `PATCH /api/pages/{id}/transcription` | 200 + audit row |
| `POST /api/documents/{id}/finalize`  | 403 (middleware) |
| `POST /api/pages/{id}/reocr`          | 403 (middleware) |
| `POST /api/billing/intent`           | 403 (middleware) |
| any `/api/admin/*`                    | 403 (target is non-admin) |
| `X-Impersonate` sent by a non-admin  | 403 (dependency) |
| `X-Impersonate` of an admin id       | 403 (dependency) |
| `X-Impersonate` of unknown/inactive  | 404 (dependency) |

## 3. Audit trail

### 3.1 New table `admin_audit_log` (`app/models.py`)

Auto-created by `Base.metadata.create_all(engine)` at startup — new table, no
`_migrate()` entry needed (matches D1's handling of brand-new tables; `_migrate()`
is only for `ADD COLUMN`).

| column           | type                        | notes |
|------------------|-----------------------------|-------|
| `id`             | `String(36)` PK             | `default=new_id` |
| `actor_user_id`  | `String(36)` FK→users, index | the real admin |
| `target_user_id` | `String(36)` FK→users, nullable, index | impersonated user; null only if ever logging non-impersonation events (not in E1) |
| `event`          | `String(20)`                | `impersonation.start` \| `impersonation.stop` \| `request` |
| `method`         | `String(10)` nullable       | null for start/stop |
| `path`           | `String(255)` nullable      | null for start/stop |
| `status_code`    | `Integer` nullable          | set for `request` after response |
| `created_at`     | `DateTime(timezone=True)` index | `default=now` |

No ORM relationships needed; queried directly. Retention: unbounded in E1 (low
volume — admin-only). A prune job is a later concern.

### 3.2 Control endpoints (`app/main.py`, admin routes block, `Depends(get_admin_user)`)

Note: these are called by the admin on their **own** (non-impersonated) session,
so `get_admin_user` resolves the real admin normally.

- `POST /api/admin/impersonate/{user_id}`
  - validate target: exists, `is_active`, not `is_admin` → else 404 / 403 (same
    rules as §2.1, kept in sync — factor into a helper
    `resolve_impersonation_target(db, target_id)` used by both the dependency and
    this endpoint).
  - write `admin_audit_log` row: `event="impersonation.start"`,
    `actor_user_id=admin.id`, `target_user_id=user_id`.
  - return `{"id", "email", "display_name"}` of the target (SPA shows it in the
    banner).
- `DELETE /api/admin/impersonate`
  - write `event="impersonation.stop"`, `actor_user_id=admin.id`. Target id: the
    SPA passes `?user_id=` (or a JSON body) so the stop row records who was being
    impersonated; if omitted, `target_user_id` is null.
  - returns `204`.

These two paths are excluded from the middleware block list (§2.2 step 6) and
from the `request` audit logging (§3.3) — they have their own explicit rows.

### 3.3 Request logging — in the same middleware

After `response = await call_next(request)` for a **non-GET** request that
carried `X-Impersonate` and was **not** blocked and is **not** a control
endpoint:

- open a fresh `SessionLocal()` (never reuse the request's session — it may have
  been rolled back by an error in the route), insert one `admin_audit_log` row:
  `event="request"`, `actor_user_id` = `X-Impersonate` *caller's* real id,
  `target_user_id` = the `X-Impersonate` value, `method`, `path`,
  `status_code=response.status_code`. Commit, close.
- The middleware does not have the real admin id directly (it did not resolve the
  token). Options: (a) re-run `bearer_token` + `get_user_by_token` in the
  middleware — one extra cheap query; (b) have the dependency stash
  `request.state.impersonator_id` and read it *after* `call_next` (state set
  during dependency resolution persists on the same `request`). **Choose (b)** —
  if `request.state.impersonator_id` is missing after `call_next` (e.g. the
  dependency 403'd the request), fall back to logging with `actor_user_id=None`
  is not allowed (FK, non-null) — so in that case skip the row (the rejection
  wasn't a real mutation anyway).
- Logging failure must never break the response: wrap in try/except, log to
  stderr on failure.

### 3.4 Consultation endpoint

- `GET /api/admin/audit?limit=100&target=<user_id?>` — `Depends(get_admin_user)`,
  ordered `created_at DESC`, `limit` capped at 500, optional `target` filter on
  `target_user_id`. Returns rows with actor + target email joined in
  (two small lookups or a join) for display.

## 4. Frontend (`web/`)

### 4.1 `web/src/api.ts`

- `getImpersonate()` / `setImpersonate(v)` — `localStorage` key
  `palimora_impersonate`, JSON `{id, email}` or null.
- In `request<T>()`, when an impersonation target is set, add header
  `X-Impersonate: <id>` to every call.
- 401 handling: currently a 401 on a non-`/auth/` path clears the token and
  redirects to `/login`. Add: if impersonation is active, a 401/403/404 that
  looks like an impersonation failure (`detail` contains "impersonation" or the
  target 404) clears **only** `palimora_impersonate` (not the admin's token) and
  reloads, so a bad target can't log the admin out.

### 4.2 `ImpersonationBanner` component (new, `web/src/components/`)

- Mounted once in the app shell (`App.tsx` / layout), above the router outlet.
- Renders only when `getImpersonate()` is set: a sticky full-width bar,
  "Vous agissez en tant que **{email}** — [Arrêter]".
- "Arrêter" → `api.delete('/api/admin/impersonate?user_id=<id>')`, clear the key,
  navigate to `/admin`.

### 4.3 `web/src/pages/Admin.tsx`

- Users table: for each **non-admin** row, an "Impersoner" button →
  `api.post('/api/admin/impersonate/' + u.id)` → `setImpersonate({id, email})` →
  `navigate('/')` (Station, now showing that user's data).
- New "Journal d'impersonation" section below the table: fetches
  `/api/admin/audit?limit=100`, table of `created_at`, actor email, target
  email, event, method, path, status. Optional filter input by target email
  (client-side or `?target=`).

## 5. Testing

Test infra now exists (added in D1: `pytest`, `conftest.py` SQLite fixture,
user factory).

### 5.1 pytest (`tests/test_impersonation.py`, `tests/test_audit.py`)

- admin + `X-Impersonate: <normal user>` → `GET /api/documents` returns the
  target's documents, not the admin's.
- non-admin + `X-Impersonate` header → 403.
- `X-Impersonate` of an unknown id → 404; of an inactive user → 404; of another
  admin → 403.
- blocked while impersonating: `POST .../finalize`, `POST .../reocr`,
  `POST /api/billing/intent`, `POST /api/billing/subscribe` → 403 with the
  impersonation detail (not the route's own logic).
- allowed while impersonating: `PATCH /api/pages/{id}/transcription` → 200 and
  an `admin_audit_log` row `event="request"` with correct actor/target/method/
  path/status.
- `POST /api/admin/impersonate/{id}` writes an `impersonation.start` row and
  returns `{id,email,display_name}`; `DELETE /api/admin/impersonate` writes
  `impersonation.stop`.
- `POST /api/admin/impersonate/{admin_id}` → 403; `/{unknown}` → 404.
- any `/api/admin/*` while impersonating → 403.
- `GET /api/admin/audit` returns rows newest-first, `target=` filter narrows,
  `limit` capped.
- a route that 500s while impersonated still writes the audit row (fresh session)
  with `status_code=500`.

### 5.2 vitest (`web/src/__tests__/`)

- `request()` adds `X-Impersonate` when the key is set, omits it otherwise.
- `ImpersonationBanner` renders the target email and nothing when the key is
  unset; "Arrêter" clears the key.

## 6. Files touched

| File | Change |
|------|--------|
| `app/models.py` | `+ AdminAuditLog` |
| `app/auth.py` | `get_current_user` resolves `X-Impersonate`; `+ resolve_impersonation_target` helper |
| `app/main.py` | `+ @app.middleware("http")` (block + request audit); `+ POST/DELETE /api/admin/impersonate`; `+ GET /api/admin/audit`; import `AdminAuditLog` |
| `web/src/api.ts` | impersonation target storage + `X-Impersonate` injection + scoped 401/403 handling |
| `web/src/components/ImpersonationBanner.tsx` | new |
| `web/src/App.tsx` (or shell) | mount the banner |
| `web/src/pages/Admin.tsx` | "Impersoner" buttons + audit-log section |
| `tests/test_impersonation.py`, `tests/test_audit.py` | new |
| `web/src/__tests__/impersonation.test.ts` | new |

No config / env additions. No `_migrate()` change (new table via `create_all`).

## 7. Open questions / risks

- **Middleware runs before dependencies** — it cannot see the resolved user, so
  it trusts the *presence* of `X-Impersonate` for path-blocking and relies on the
  dependency to reject non-admin callers. A non-admin sending the header at a
  blocked path gets 403 from the middleware (correct outcome, "wrong" reason) or
  403 from the dependency at a non-blocked path. Net: a non-admin can never
  successfully impersonate. Acceptable.
- **Audit completeness** — `request` rows are best-effort (try/except, skipped if
  `impersonator_id` state is missing). Session start/stop rows are transactional
  and authoritative. If tighter guarantees are wanted later, move request logging
  into a dependency.
- **`X-Impersonate` + real token both required** — the header alone is inert
  without a valid admin device token, so a leaked header value is harmless.
- **No auto-expiry** — an admin who forgets to click "Arrêter" keeps the SPA in
  impersonation until they clear it. The banner is loud and sticky to mitigate.
  Time-boxing can be added in E2 if it proves annoying.
- `charge.refunded` / webhook paths are blocked defensively though the SPA never
  calls them — keeps the money surface provably unreachable under impersonation.
