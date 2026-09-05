import { useCallback, useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { api, setImpersonation, setToken } from '../api'
import type { OcrPanelData } from '../api'
import Mark from '../components/Mark'
import { Badge } from '../components/ui/badge'
import { Button } from '../components/ui/button'
import { Input } from '../components/ui/input'
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '../components/ui/table'

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
  const navigate = useNavigate()

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
      .then((o) => { setOcr(o); setModelKey(o.active_key) })
      .catch(() => setOcr(null))
  }, [])

  useEffect(() => {
    api.get('/api/auth/me')
      .then((me: any) => { if (!me.is_admin) navigate('/') })
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

  // '' when the active model isn't one of the configurable keys (fallback):
  // don't pretend the first listed model is selected.
  const effectiveKey =
    ocr && ocr.models.some((m) => m.key === modelKey) ? modelKey : ''

  async function saveModel() {
    setSavingModel(true)
    try {
      await api.put('/api/admin/ocr/model', { key: effectiveKey })
      setToast('Modèle OCR mis à jour')
      setTimeout(() => setToast(''), 2500)
      refresh()
    } catch {
      setToast('Erreur mise à jour modèle')
      setTimeout(() => setToast(''), 2500)
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
        <Link to="/" className="flex items-center gap-2">
          <Mark size={24} />
          <span className="font-display font-semibold">Palimora</span>
        </Link>
        <span className="text-muted-foreground">/</span>
        <h1 className="font-display font-semibold">Administration</h1>
        <div className="flex-1" />
        <Button variant="ghost" size="sm" asChild><Link to="/">← Station</Link></Button>
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
        <div className="px-4 pb-12">
          <h2 className="mb-2 font-display font-semibold">OCR / Modèles</h2>

          {ocr.models.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Aucun modèle alternatif configuré (env <code>KRAKEN_MODELS</code>).
            </p>
          ) : (
            <div className="mb-4 flex items-center gap-2 text-sm">
              {/* Native select on purpose: the shadcn/Radix Select renders a
                  listbox in a portal, which the OCR panel's tests drive with
                  selectOptions/toHaveValue. */}
              <select
                className="h-8 rounded-lg border border-input bg-card px-2 text-sm
                           outline-none focus-visible:border-ring focus-visible:ring-3
                           focus-visible:ring-ring/50"
                value={effectiveKey} onChange={(e) => setModelKey(e.target.value)}>
                {effectiveKey === '' && <option value="" disabled>— défaut Kraken —</option>}
                {ocr.models.map((m) => <option key={m.key} value={m.key}>{m.key}</option>)}
              </select>
              <Button disabled={savingModel || effectiveKey === ''} onClick={saveModel}>
                Enregistrer
              </Button>
              <span className="text-xs text-muted-foreground">source&nbsp;: {ocr.active_source}</span>
            </div>
          )}

          <div className="bg-card rounded-lg border overflow-hidden mb-6">
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

      {toast && (
        <div className="fixed bottom-4 left-1/2 -translate-x-1/2 bg-foreground text-background
                        text-sm rounded-lg px-4 py-2 shadow-lg">
          {toast}
        </div>
      )}
    </div>
  )
}
