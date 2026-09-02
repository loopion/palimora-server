import { useCallback, useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { api, setImpersonation, setToken } from '../api'
import type { OcrPanelData } from '../api'

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
      <header className="bg-white border-b px-4 py-2 flex items-center gap-3">
        <Link to="/" className="text-sm text-indigo-600">← Station</Link>
        <h1 className="font-semibold">Administration</h1>
        <div className="flex-1" />
        <button className="text-sm text-slate-500" onClick={() => { setToken(null); navigate('/login') }}>
          Déconnexion
        </button>
      </header>

      {stats && (
        <div className="grid grid-cols-6 gap-3 p-4">
          {[
            ['Utilisateurs', stats.users], ['Documents', stats.documents],
            ['Pages totales', stats.pages_total], ['Pages OK', stats.pages_done],
            ['Pages en erreur', stats.pages_error], ['Crédits en circulation', stats.credits_in_circulation],
          ].map(([label, value]) => (
            <div key={label as string} className="bg-white rounded-lg border p-3">
              <p className="text-xs text-slate-500">{label}</p>
              <p className="text-2xl font-semibold">{value}</p>
            </div>
          ))}
        </div>
      )}

      <div className="px-4 pb-8">
        <table className="w-full bg-white rounded-lg border text-sm">
          <thead>
            <tr className="text-left text-slate-500 border-b">
              <th className="p-2">Email</th><th className="p-2">Nom</th>
              <th className="p-2">Crédits</th><th className="p-2">Rôle</th>
              <th className="p-2">Statut</th><th className="p-2">Créditer</th>
              <th className="p-2">Actions</th>
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id} className="border-b">
                <td className="p-2">{u.email}</td>
                <td className="p-2">{u.display_name}</td>
                <td className="p-2 font-semibold">{u.credit_balance}</td>
                <td className="p-2">{u.is_admin ? 'admin' : 'user'}</td>
                <td className="p-2">
                  <button onClick={() => toggleActive(u.id)}
                          className={u.is_active ? 'text-emerald-600' : 'text-red-600'}>
                    {u.is_active ? 'actif' : 'désactivé'}
                  </button>
                </td>
                <td className="p-2">
                  <div className="flex gap-1">
                    <input className="w-20 border rounded px-2 py-1"
                           value={grant[u.id] || ''} placeholder="±N"
                           onChange={(e) => setGrant({ ...grant, [u.id]: e.target.value })} />
                    <button className="bg-indigo-600 text-white rounded px-2"
                            onClick={() => addCredits(u.id)}>OK</button>
                  </div>
                </td>
                <td className="p-2">
                  {!u.is_admin && (
                    <button className="text-indigo-600 disabled:opacity-50"
                            disabled={impersonating} onClick={() => impersonate(u)}>
                      Impersoner
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="px-4 pb-12">
        <h2 className="mb-2 font-semibold">Journal d'impersonation</h2>
        <table className="w-full bg-white rounded-lg border text-sm">
          <thead>
            <tr className="text-left text-slate-500 border-b">
              <th className="p-2">Date</th><th className="p-2">Admin</th>
              <th className="p-2">Cible</th><th className="p-2">Événement</th>
              <th className="p-2">Méthode</th><th className="p-2">Chemin</th>
              <th className="p-2">Statut</th>
            </tr>
          </thead>
          <tbody>
            {audit.map((r) => (
              <tr key={r.id} className="border-b">
                <td className="p-2">{r.created_at ? new Date(r.created_at).toLocaleString('fr-FR') : ''}</td>
                <td className="p-2">{r.actor_email}</td>
                <td className="p-2">{r.target_email}</td>
                <td className="p-2">{r.event}</td>
                <td className="p-2">{r.method}</td>
                <td className="p-2 font-mono text-xs">{r.path}</td>
                <td className="p-2">{r.status_code}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {ocr && (
        <div className="px-4 pb-12">
          <h2 className="mb-2 font-semibold">OCR / Modèles</h2>

          {ocr.models.length === 0 ? (
            <p className="text-sm text-slate-500">
              Aucun modèle alternatif configuré (env <code>KRAKEN_MODELS</code>).
            </p>
          ) : (
            <div className="mb-4 flex items-center gap-2 text-sm">
              <select className="border rounded px-2 py-1"
                      value={effectiveKey} onChange={(e) => setModelKey(e.target.value)}>
                {effectiveKey === '' && <option value="" disabled>— défaut Kraken —</option>}
                {ocr.models.map((m) => <option key={m.key} value={m.key}>{m.key}</option>)}
              </select>
              <button className="bg-indigo-600 text-white rounded px-3 py-1 disabled:opacity-50"
                      disabled={savingModel || effectiveKey === ''} onClick={saveModel}>
                Enregistrer
              </button>
              <span className="text-xs text-slate-500">source&nbsp;: {ocr.active_source}</span>
            </div>
          )}

          <table className="w-full bg-white rounded-lg border text-sm mb-6">
            <thead><tr className="text-left text-slate-500 border-b">
              <th className="p-2">Modèle</th><th className="p-2">Pages</th>
              <th className="p-2">Erreurs</th>
              <th className="p-2">Médiane (s)</th><th className="p-2">p95 (s)</th>
              <th className="p-2">Confiance moy.</th>
            </tr></thead>
            <tbody>
              {ocr.aggregates.map((a) => (
                <tr key={a.model_key || '—'} className="border-b">
                  <td className="p-2">{a.model_key || '—'}</td>
                  <td className="p-2">{a.pages}</td>
                  <td className="p-2">{a.errors}</td>
                  <td className="p-2">{a.median_s ?? '—'}</td>
                  <td className="p-2">{a.p95_s ?? '—'}</td>
                  <td className="p-2">{a.avg_confidence ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <table className="w-full bg-white rounded-lg border text-sm">
            <thead><tr className="text-left text-slate-500 border-b">
              <th className="p-2">Date</th><th className="p-2">Document</th>
              <th className="p-2">Statut</th><th className="p-2">Durée (s)</th>
              <th className="p-2">Durée/page (s)</th><th className="p-2">Modèle</th>
              <th className="p-2">Confiance</th>
            </tr></thead>
            <tbody>
              {ocr.recent.map((r) => (
                <tr key={r.page_id} className="border-b">
                  <td className="p-2">{r.submitted_at ? new Date(r.submitted_at).toLocaleString('fr-FR') : '—'}</td>
                  <td className="p-2">{r.document_title}</td>
                  <td className="p-2">{r.processing_status}</td>
                  <td className="p-2">{r.duration_s ?? '—'}</td>
                  <td className="p-2">{r.per_page_s ?? '—'}</td>
                  <td className="p-2">{r.model_key || '—'}</td>
                  <td className="p-2">{r.avg_confidence ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {toast && (
        <div className="fixed bottom-4 left-1/2 -translate-x-1/2 bg-slate-900 text-white text-sm rounded-lg px-4 py-2">
          {toast}
        </div>
      )}
    </div>
  )
}
