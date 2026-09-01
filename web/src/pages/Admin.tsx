import { useCallback, useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { api, setImpersonation, setToken } from '../api'

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

      {toast && (
        <div className="fixed bottom-4 left-1/2 -translate-x-1/2 bg-slate-900 text-white text-sm rounded-lg px-4 py-2">
          {toast}
        </div>
      )}
    </div>
  )
}
