from tests.conftest import make_user, auth_headers


def _imp(db, admin, target_id):
    return {**auth_headers(db, admin), "X-Impersonate": target_id}


def test_finalize_blocked_while_impersonating(client, db):
    admin = make_user(db, email="admin@test.fr", is_admin=True)
    target = make_user(db, email="user@test.fr", credits=100)
    doc = client.post("/api/documents", json={"title": "T"},
                      headers=auth_headers(db, target)).json()
    r = client.post(f"/api/documents/{doc['id']}/finalize",
                    headers=_imp(db, admin, target.id))
    assert r.status_code == 403
    assert r.json()["detail"] == "Action indisponible en mode impersonation"


def test_reocr_blocked_while_impersonating(client, db):
    admin = make_user(db, email="admin@test.fr", is_admin=True)
    target = make_user(db, email="user@test.fr", credits=100)
    r = client.post("/api/pages/whatever/reocr", headers=_imp(db, admin, target.id))
    assert r.status_code == 403
    assert r.json()["detail"] == "Action indisponible en mode impersonation"


def test_billing_blocked_while_impersonating(client, db):
    admin = make_user(db, email="admin@test.fr", is_admin=True)
    target = make_user(db, email="user@test.fr")
    r = client.post("/api/billing/intent", json={"pack_id": "starter"},
                    headers=_imp(db, admin, target.id))
    assert r.status_code == 403
    assert r.json()["detail"] == "Action indisponible en mode impersonation"


def test_benign_patch_allowed_while_impersonating(client, db):
    admin = make_user(db, email="admin@test.fr", is_admin=True)
    target = make_user(db, email="user@test.fr")
    r = client.post("/api/glossary", json={"term": "abbé"},
                    headers=_imp(db, admin, target.id))
    assert r.status_code == 200


def test_ai_suggest_not_blocked_while_impersonating(client, db):
    admin = make_user(db, email="admin@test.fr", is_admin=True)
    target = make_user(db, email="user@test.fr")
    r = client.post("/api/pages/missing/ai-suggest", json={},
                    headers=_imp(db, admin, target.id))
    assert r.status_code != 403


def test_get_billing_status_not_blocked_while_impersonating(client, db):
    admin = make_user(db, email="admin@test.fr", is_admin=True)
    target = make_user(db, email="user@test.fr")
    r = client.get("/api/billing/status", headers=_imp(db, admin, target.id))
    assert r.status_code != 403


def test_finalize_not_blocked_without_header(client, db):
    # a normal user hitting finalize on a missing doc gets 404, not the 403 block
    u = make_user(db, email="user@test.fr", credits=100)
    r = client.post("/api/documents/missing/finalize", json={"page_ids": ["x"]},
                    headers=auth_headers(db, u))
    assert r.status_code == 404
