import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { api, setImpersonation, setToken } from '../api'
import type { CatalogModel, CatalogResponse, LocalModel, ModelJob, OcrPanelData } from '../api'
import Mark from '../components/Mark'
import { Alert, AlertDescription, AlertTitle } from '../components/ui/alert'
import { Badge } from '../components/ui/badge'
import { Button, buttonVariants } from '../components/ui/button'
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '../components/ui/dialog'
import { Input } from '../components/ui/input'
import {
  Popover, PopoverContent, PopoverTitle, PopoverTrigger,
} from '../components/ui/popover'
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '../components/ui/table'
import { cn, formatBytes } from '../lib/utils'

interface AdminUser {
  id: string; email: string; display_name: string
  credit_balance: number; is_admin: boolean; is_active: boolean; created_at: string
}
interface Stats {
  users: number; documents: number; pages_done: number
  pages_error: number; pages_total: number; credits_in_circulation: number
}
interface AuditRow {
  id: string; created_at: string | null; event: string
  method: string | null; path: string | null; status_code: number | null
  actor_email: string | null; target_email: string | null
}

const SCRIPTS = ['Latn', 'Grek', 'Arab', 'Hebr', 'Cyrl', 'Syrc', 'Deva']
const JOB_POLL_MS = 3000
// Native <select> on purpose (as in E2): the Radix Select renders its listbox in
// a portal, which the panel's tests drive with selectOptions/toHaveValue.
const selectClass =
  'h-8 rounded-lg border border-input bg-card px-2 text-sm outline-none ' +
  'focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50'

type SortField = 'name' | 'doi' | 'script' | 'size'

const SORT_LABELS: [SortField, string][] = [
  ['name', 'Nom'], ['doi', 'DOI'], ['script', 'Écriture'], ['size', 'Taille'],
]

/** Entries with no value for the active field sit at the bottom in both directions. */
const nullsLast = (a: unknown, b: unknown) => (a === null ? 1 : 0) - (b === null ? 1 : 0)

function compareCatalog(a: CatalogModel, b: CatalogModel, field: SortField, dir: number): number {
  if (field === 'size') {
    if (a.size_bytes === null || b.size_bytes === null) return nullsLast(a.size_bytes, b.size_bytes)
    return dir * (a.size_bytes - b.size_bytes)
  }
  const key = (m: CatalogModel) =>
    field === 'doi' ? m.doi : field === 'script' ? m.script : m.summary || m.doi
  const av = key(a)
  const bv = key(b)
  if (av === null || bv === null) return nullsLast(av, bv)
  return dir * av.localeCompare(bv, 'fr')
}

async function pollJob(jobId: string, onTick: (j: ModelJob) => void): Promise<ModelJob> {
  for (;;) {
    const job = await api.get<ModelJob>(`/api/admin/ocr/models/jobs/${jobId}`)
    onTick(job)
    if (job.status === 'finished' || job.status === 'failed') return job
    await new Promise((r) => setTimeout(r, JOB_POLL_MS))
  }
}

export default function Admin() {
  const [users, setUsers] = useState<AdminUser[]>([])
  const [stats, setStats] = useState<Stats | null>(null)
  const [grant, setGrant] = useState<Record<string, string>>({})
  const [toast, setToast] = useState('')
  const [audit, setAudit] = useState<AuditRow[]>([])
  const [ocr, setOcr] = useState<OcrPanelData | null>(null)
  const [modelKey, setModelKey] = useState('')
  const [savingModel, setSavingModel] = useState(false)
  const [impersonating, setImpersonating] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<LocalModel | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [catalogOpen, setCatalogOpen] = useState(false)
  const [catalog, setCatalog] = useState<CatalogResponse | null>(null)
  const [catalogScript, setCatalogScript] = useState('Latn')
  const [catalogAll, setCatalogAll] = useState(false)
  const [catalogLoading, setCatalogLoading] = useState(false)
  const [refreshingCatalog, setRefreshingCatalog] = useState(false)
  const [pullJobs, setPullJobs] = useState<Record<string, ModelJob>>({})
  const [sortField, setSortField] = useState<SortField>('name')
  const [sortAsc, setSortAsc] = useState(true)
  const [tagQuery, setTagQuery] = useState('')
  const navigate = useNavigate()

  const visibleCatalog = useMemo(() => {
    const dir = sortAsc ? 1 : -1
    const q = tagQuery.trim().toLowerCase()
    const kept = (catalog?.models || []).filter(
      (m) => q === '' || m.keywords.some((k) => k.toLowerCase().includes(q)))
    return kept.sort((a, b) => compareCatalog(a, b, sortField, dir) || a.doi.localeCompare(b.doi))
  }, [catalog, sortField, sortAsc, tagQuery])

  const refresh = useCallback(async () => {
    const [u, s, a] = await Promise.all([
      api.get<{ users: AdminUser[] }>('/api/admin/users'),
      api.get<Stats>('/api/admin/stats'),
      api.get<{ rows: AuditRow[] }>('/api/admin/audit?limit=100'),
    ])
    setUsers(u.users)
    setStats(s)
    setAudit(a.rows)
    // OCR panel is non-critical: fetch it independently so its failure
    // (500 / timeout) degrades gracefully instead of blanking the console.
    api.get<OcrPanelData>('/api/admin/ocr')
      .then((o) => { setOcr(o); setModelKey(o.active_slug) })
      .catch(() => setOcr(null))
  }, [])

  useEffect(() => {
    api.get('/api/auth/me')
      .then((me: any) => { if (!me.is_admin) navigate('/station') })
      .catch(() => navigate('/login'))
    refresh()
  }, [refresh, navigate])

  async function addCredits(userId: string) {
    const delta = parseInt(grant[userId] || '0', 10)
    if (!delta) return
    await api.post(`/api/admin/users/${userId}/credits`, { delta, note: 'Crédit manuel admin' })
    setGrant({ ...grant, [userId]: '' })
    setToast('Crédits ajoutés')
    setTimeout(() => setToast(''), 2500)
    refresh()
  }

  async function impersonate(u: AdminUser) {
    setImpersonating(true)
    try {
      await api.post(`/api/admin/impersonate/${u.id}`)
      setImpersonation({ id: u.id, email: u.email })
      // Hard reload so <ImpersonationBanner /> (mounted outside the router) re-evaluates.
      window.location.assign('/')
    } catch {
      setToast("Erreur lors de l'impersonation")
      setTimeout(() => setToast(''), 2500)
      setImpersonating(false)
    }
  }

  const say = useCallback((msg: string) => {
    setToast(msg)
    setTimeout(() => setToast(''), 3500)
  }, [])

  const loadCatalog = useCallback(async (script: string, all: boolean) => {
    setCatalogLoading(true)
    try {
      const params = new URLSearchParams({ script, all: all ? 'true' : 'false' })
      setCatalog(await api.get<CatalogResponse>(`/api/admin/ocr/catalog?${params}`))
    } catch (e: any) {
      setCatalog(null)
      say(e?.message || 'Catalogue indisponible')
    } finally {
      setCatalogLoading(false)
    }
  }, [say])

  function toggleCatalog() {
    const next = !catalogOpen
    setCatalogOpen(next)
    if (next && catalog === null) loadCatalog(catalogScript, catalogAll)
  }

  function changeScript(value: string) {
    const all = value === 'all'
    const script = all ? catalogScript : value
    setCatalogAll(all)
    if (!all) setCatalogScript(value)
    setTagQuery('')  // the tag universe belongs to the script being listed
    loadCatalog(script, all)
  }

  async function refreshCatalog() {
    setRefreshingCatalog(true)
    try {
      const { job_id } = await api.post<{ job_id: string }>('/api/admin/ocr/catalog/refresh')
      const job = await pollJob(job_id, () => {})
      if (job.status === 'failed') say(job.error || 'Rafraîchissement en échec')
      else { say('Catalogue rafraîchi'); await loadCatalog(catalogScript, catalogAll) }
    } catch (e: any) {
      say(e?.message || 'Rafraîchissement impossible')
    } finally {
      setRefreshingCatalog(false)
    }
  }

  async function pullModel(doi: string) {
    try {
      const started = await api.post<{ job_id: string }>('/api/admin/ocr/models', { doi })
      const job = await pollJob(started.job_id, (j) => setPullJobs((p) => ({ ...p, [doi]: j })))
      if (job.status === 'failed') {
        say(job.error || 'Téléchargement en échec')
      } else {
        say('Modèle téléchargé')
        await loadCatalog(catalogScript, catalogAll)
        refresh()
      }
    } catch (e: any) {
      say(e?.message || 'Téléchargement impossible')
    } finally {
      setPullJobs((p) => { const { [doi]: _drop, ...rest } = p; return rest })
    }
  }

  async function confirmDelete() {
    if (!deleteTarget) return
    setDeleting(true)
    try {
      await api.delete(`/api/admin/ocr/models/${deleteTarget.slug}`)
      say('Modèle supprimé')
      setDeleteTarget(null)
      refresh()
    } catch (e: any) {
      say(e?.message || 'Suppression impossible')
      setDeleteTarget(null)
    } finally {
      setDeleting(false)
    }
  }

  // '' when the stored slug is no longer in the live list: don't pretend the
  // first listed model is selected.
  const effectiveKey =
    ocr && ocr.local_models.some((m) => m.slug === modelKey) ? modelKey : ''

  async function saveModel() {
    setSavingModel(true)
    try {
      await api.put('/api/admin/ocr/model', { key: effectiveKey })
      say('Modèle OCR mis à jour')
      refresh()
    } catch (e: any) {
      say(e?.message || 'Erreur mise à jour modèle')
    } finally {
      setSavingModel(false)
    }
  }

  async function toggleActive(userId: string) {
    await api.post(`/api/admin/users/${userId}/toggle-active`)
    refresh()
  }

  return (
    <div className="min-h-screen">
      <header className="bg-card border-b px-4 py-2.5 flex items-center gap-3">
        <Link to="/station" className="flex items-center gap-2">
          <Mark size={24} />
          <span className="font-display font-semibold">Palimora</span>
        </Link>
        <span className="text-muted-foreground">/</span>
        <h1 className="font-display font-semibold">Administration</h1>
        <div className="flex-1" />
        <Button variant="ghost" size="sm" asChild><Link to="/station">← Station</Link></Button>
        <Button variant="ghost" size="sm" onClick={() => { setToken(null); navigate('/login') }}>
          Déconnexion
        </Button>
      </header>

      {stats && (
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3 p-4">
          {[
            ['Utilisateurs', stats.users], ['Documents', stats.documents],
            ['Pages totales', stats.pages_total], ['Pages OK', stats.pages_done],
            ['Pages en erreur', stats.pages_error], ['Crédits en circulation', stats.credits_in_circulation],
          ].map(([label, value]) => (
            <div key={label as string} className="bg-card rounded-lg border p-3">
              <p className="text-xs text-muted-foreground">{label}</p>
              <p className="font-display text-2xl font-semibold">{value}</p>
            </div>
          ))}
        </div>
      )}

      <div className="px-4 pb-8">
        <div className="bg-card rounded-lg border overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Email</TableHead><TableHead>Nom</TableHead>
                <TableHead>Crédits</TableHead><TableHead>Rôle</TableHead>
                <TableHead>Statut</TableHead><TableHead>Créditer</TableHead>
                <TableHead>Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {users.map((u) => (
                <TableRow key={u.id}>
                  <TableCell>{u.email}</TableCell>
                  <TableCell>{u.display_name}</TableCell>
                  <TableCell className="font-semibold">{u.credit_balance}</TableCell>
                  <TableCell>
                    <Badge variant={u.is_admin ? 'default' : 'outline'}>
                      {u.is_admin ? 'admin' : 'user'}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <Button size="xs" variant={u.is_active ? 'ghost' : 'destructive'}
                            onClick={() => toggleActive(u.id)}>
                      {u.is_active ? 'actif' : 'désactivé'}
                    </Button>
                  </TableCell>
                  <TableCell>
                    <div className="flex gap-1">
                      <Input className="w-20 h-7" value={grant[u.id] || ''} placeholder="±N"
                             onChange={(e) => setGrant({ ...grant, [u.id]: e.target.value })} />
                      <Button size="sm" onClick={() => addCredits(u.id)}>OK</Button>
                    </div>
                  </TableCell>
                  <TableCell>
                    {!u.is_admin && (
                      <Button size="xs" variant="outline"
                              disabled={impersonating} onClick={() => impersonate(u)}>
                        Impersoner
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </div>

      <div className="px-4 pb-12">
        <h2 className="mb-2 font-display font-semibold">Journal d'impersonation</h2>
        <div className="bg-card rounded-lg border overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Date</TableHead><TableHead>Admin</TableHead>
                <TableHead>Cible</TableHead><TableHead>Événement</TableHead>
                <TableHead>Méthode</TableHead><TableHead>Chemin</TableHead>
                <TableHead>Statut</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {audit.map((r) => (
                <TableRow key={r.id}>
                  <TableCell>{r.created_at ? new Date(r.created_at).toLocaleString('fr-FR') : ''}</TableCell>
                  <TableCell>{r.actor_email}</TableCell>
                  <TableCell>{r.target_email}</TableCell>
                  <TableCell>{r.event}</TableCell>
                  <TableCell>{r.method}</TableCell>
                  <TableCell className="font-mono text-xs">{r.path}</TableCell>
                  <TableCell>{r.status_code}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </div>

      {ocr && (
        <div className="px-4 pb-12 space-y-6">
          <h2 className="font-display font-semibold">OCR / Modèles</h2>

          {ocr.kraken_error && (
            <Alert variant="destructive">
              <AlertTitle>Service Kraken injoignable</AlertTitle>
              <AlertDescription>
                Gestion des modèles indisponible. Les statistiques ci-dessous
                proviennent de la base et restent à jour.
              </AlertDescription>
            </Alert>
          )}

          {/* ── Block 1 — Modèle actif & performance ───────────────────── */}
          <section className="space-y-3">
            <h3 className="font-display text-sm font-semibold">Modèle actif</h3>
            {ocr.local_models.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                Aucun modèle local — Kraken indisponible ou volume vide.
              </p>
            ) : (
              <div className="flex items-center gap-2 text-sm">
                <label className="sr-only" htmlFor="active-model">Modèle actif</label>
                <select id="active-model" aria-label="Modèle actif" className={selectClass}
                        value={effectiveKey} onChange={(e) => setModelKey(e.target.value)}>
                  {effectiveKey === '' && (
                    <option value="" disabled>— rec (défaut Kraken) —</option>
                  )}
                  {ocr.local_models.map((m) => (
                    <option key={m.slug} value={m.slug}>
                      {m.summary ? `${m.slug} — ${m.summary}` : m.slug}
                    </option>
                  ))}
                </select>
                <Button disabled={savingModel || effectiveKey === '' || effectiveKey === ocr.active_slug}
                        onClick={saveModel}>
                  Activer
                </Button>
                <Badge variant="outline">source&nbsp;: {ocr.active_source}</Badge>
              </div>
            )}

            <div className="bg-card rounded-lg border overflow-hidden">
              <Table>
                <TableHeader><TableRow>
                  <TableHead>Modèle</TableHead><TableHead>Pages</TableHead>
                  <TableHead>Erreurs</TableHead>
                  <TableHead>Médiane (s)</TableHead><TableHead>p95 (s)</TableHead>
                  <TableHead>Confiance moy.</TableHead>
                </TableRow></TableHeader>
                <TableBody>
                  {ocr.aggregates.map((a) => (
                    <TableRow key={a.model_key || '—'}>
                      <TableCell>{a.model_key || '—'}</TableCell>
                      <TableCell>{a.pages}</TableCell>
                      <TableCell>{a.errors}</TableCell>
                      <TableCell>{a.median_s ?? '—'}</TableCell>
                      <TableCell>{a.p95_s ?? '—'}</TableCell>
                      <TableCell>{a.avg_confidence ?? '—'}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </section>

          {/* ── Block 2 — Modèles téléchargés ──────────────────────────── */}
          <section className="space-y-2">
            <h3 className="font-display text-sm font-semibold">Modèles téléchargés</h3>
            <div className="bg-card rounded-lg border overflow-hidden">
              <Table>
                <TableHeader><TableRow>
                  <TableHead>Slug</TableHead><TableHead>DOI</TableHead>
                  <TableHead>Écriture</TableHead><TableHead>Taille</TableHead>
                  <TableHead>Actions</TableHead>
                </TableRow></TableHeader>
                <TableBody>
                  {ocr.local_models.map((m) => (
                    <TableRow key={m.slug} data-testid={`local-model-${m.slug}`}>
                      <TableCell className="font-mono text-xs">{m.slug}</TableCell>
                      <TableCell className="font-mono text-xs">{m.doi || '—'}</TableCell>
                      <TableCell>{m.script || '—'}</TableCell>
                      <TableCell>{formatBytes(m.size_bytes)}</TableCell>
                      <TableCell>
                        <Button size="xs" variant="destructive"
                                disabled={m.protected || m.slug === ocr.active_slug}
                                onClick={() => setDeleteTarget(m)}>
                          Supprimer
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </section>

          {/* ── Block 3 — Catalogue HTRMoPo (lazy) ─────────────────────── */}
          <section className="space-y-2">
            <div className="flex items-center gap-1">
              <Button variant="ghost" size="sm" onClick={toggleCatalog}
                      aria-expanded={catalogOpen}>
                {catalogOpen ? '▾' : '▸'} Catalogue HTRMoPo
              </Button>
              <Popover>
                {/* Styled directly rather than via <Button asChild>: Button is not
                    forwardRef, and Radix needs the trigger ref to place the popover. */}
                <PopoverTrigger
                  className={cn(buttonVariants({ variant: 'ghost', size: 'icon-sm' }),
                                'rounded-full')}
                  aria-label="Aide sur les champs du catalogue">
                  ?
                </PopoverTrigger>
                <PopoverContent align="start" className="w-96">
                  <PopoverTitle>Champs du catalogue</PopoverTitle>
                  <ul className="space-y-1.5 text-xs text-muted-foreground">
                    <li>
                      DOI — identifiant permanent du dépôt Zenodo qui héberge le modèle.
                    </li>
                    <li>
                      Écriture — système d'écriture que le modèle sait lire
                      (Latn = latin, Grek = grec, Arab = arabe, Cyrl = cyrillique…).
                    </li>
                    <li>
                      Licence — conditions de réutilisation publiées par l'auteur du modèle.
                    </li>
                    <li>
                      Mots-clés — étiquettes libres du dépôt (langue, période, type d'écriture).
                      Cliquez-les sous ce bloc pour filtrer la liste.
                    </li>
                    <li>
                      Taille — poids du fichier modèle à télécharger sur le volume Kraken.
                    </li>
                    <li>
                      Déjà local — le modèle a déjà été téléchargé sur le serveur Kraken&nbsp;;
                      il est sélectionnable comme modèle actif.
                    </li>
                  </ul>
                </PopoverContent>
              </Popover>
            </div>

            {catalogOpen && (
              <div className="space-y-3">
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  <label className="sr-only" htmlFor="catalog-script">Écriture</label>
                  <select id="catalog-script" aria-label="Écriture" className={selectClass}
                          value={catalogAll ? 'all' : catalogScript}
                          onChange={(e) => changeScript(e.target.value)}>
                    {SCRIPTS.map((s) => <option key={s} value={s}>{s}</option>)}
                    <option value="all">tous</option>
                  </select>
                  <Button size="sm" variant="outline" disabled={refreshingCatalog}
                          onClick={refreshCatalog}>
                    {refreshingCatalog ? 'Rafraîchissement…' : 'Rafraîchir'}
                  </Button>
                  {catalog?.cached_at && (
                    <span className="text-xs text-muted-foreground">
                      cache&nbsp;: {new Date(catalog.cached_at).toLocaleString('fr-FR')}
                    </span>
                  )}
                  {catalog?.stale && <Badge variant="outline">obsolète</Badge>}
                  {catalog?.refreshing && <Badge variant="outline">en cours…</Badge>}
                </div>

                <div className="flex flex-wrap items-center gap-2 text-sm">
                  <label className="sr-only" htmlFor="catalog-sort">Trier par</label>
                  <select id="catalog-sort" aria-label="Trier par" className={selectClass}
                          value={sortField}
                          onChange={(e) => setSortField(e.target.value as SortField)}>
                    {SORT_LABELS.map(([value, label]) => (
                      <option key={value} value={value}>{label}</option>
                    ))}
                  </select>
                  <Button size="sm" variant="outline" aria-label="Inverser l'ordre de tri"
                          onClick={() => setSortAsc((v) => !v)}>
                    {sortAsc ? '↑ croissant' : '↓ décroissant'}
                  </Button>
                </div>

                <Input type="search" placeholder="Filtrer par tag…" aria-label="Filtrer par tag"
                       value={tagQuery} onChange={(e) => setTagQuery(e.target.value)}
                       className="h-8 max-w-[16rem] text-sm" />

                {catalogLoading && (
                  <p className="text-sm text-muted-foreground">Chargement du catalogue…</p>
                )}

                <div className="grid gap-2 md:grid-cols-2">
                  {visibleCatalog.map((m) => {
                    const job = pullJobs[m.doi]
                    return (
                      <div key={m.doi} data-testid={`catalog-${m.doi}`}
                           className="bg-card rounded-lg border p-3 space-y-1.5">
                        <p className="text-sm font-medium">{m.summary || m.doi}</p>
                        <p className="font-mono text-xs text-muted-foreground">{m.doi}</p>
                        <p className="text-xs text-muted-foreground">{formatBytes(m.size_bytes)}</p>
                        <div className="flex flex-wrap gap-1">
                          {m.script && <Badge variant="outline">{m.script}</Badge>}
                          {m.keywords.map((k) => <Badge key={k} variant="outline">{k}</Badge>)}
                          {m.license && <Badge variant="outline">{m.license}</Badge>}
                        </div>
                        {job && (
                          <div className="h-1.5 w-full rounded bg-muted overflow-hidden">
                            <div className="h-full bg-primary transition-all"
                                 style={{ width: `${job.progress ?? 0}%` }} />
                          </div>
                        )}
                        <Button size="xs" disabled={m.already_local || Boolean(job)}
                                onClick={() => pullModel(m.doi)}>
                          {m.already_local ? 'Déjà local'
                            : job ? 'Téléchargement…' : 'Télécharger'}
                        </Button>
                      </div>
                    )
                  })}
                </div>
              </div>
            )}
          </section>

          {/* ── E2 recent-pages table (unchanged) ──────────────────────── */}
          <div className="bg-card rounded-lg border overflow-hidden">
            <Table>
              <TableHeader><TableRow>
                <TableHead>Date</TableHead><TableHead>Document</TableHead>
                <TableHead>Statut</TableHead><TableHead>Durée (s)</TableHead>
                <TableHead>Durée/page (s)</TableHead><TableHead>Modèle</TableHead>
                <TableHead>Confiance</TableHead>
              </TableRow></TableHeader>
              <TableBody>
                {ocr.recent.map((r) => (
                  <TableRow key={r.page_id}>
                    <TableCell>
                      {r.submitted_at ? new Date(r.submitted_at).toLocaleString('fr-FR') : '—'}
                    </TableCell>
                    <TableCell>{r.document_title}</TableCell>
                    <TableCell>{r.processing_status}</TableCell>
                    <TableCell>{r.duration_s ?? '—'}</TableCell>
                    <TableCell>{r.per_page_s ?? '—'}</TableCell>
                    <TableCell>{r.model_key || '—'}</TableCell>
                    <TableCell>{r.avg_confidence ?? '—'}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </div>
      )}

      <Dialog open={deleteTarget !== null}
              onOpenChange={(open) => { if (!open) setDeleteTarget(null) }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Supprimer le modèle</DialogTitle>
            <DialogDescription>
              <span className="font-mono">{deleteTarget?.slug}</span> sera supprimé
              du volume Kraken. Les pages déjà transcrites ne changent pas.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setDeleteTarget(null)}>Annuler</Button>
            <Button variant="destructive" disabled={deleting} onClick={confirmDelete}>
              Confirmer
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {toast && (
        <div className="fixed bottom-4 left-1/2 -translate-x-1/2 bg-foreground text-background
                        text-sm rounded-lg px-4 py-2 shadow-lg">
          {toast}
        </div>
      )}
    </div>
  )
}
