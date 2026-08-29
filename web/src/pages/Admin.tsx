import { useCallback, useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { api, setToken } from '../api'

interface AdminUser {
  id: string; email: string; display_name: string
  credit_balance: number; is_admin: boolean; is_active: boolean; created_at: string
}
interface Stats {
  users: number; documents: number; pages_done: number
  pages_error: number; pages_total: number; credits_in_circulation: number
}

export default function Admin() {
  const [users, setUsers] = useState<AdminUser[]>([])
  const [stats, setStats] = useState<Stats | null>(null)
  const [grant, setGrant] = useState<Record<string, string>>({})
  const [toast, setToast] = useState('')
  const navigate = useNavigate()

  const refresh = useCallback(async () => {
    const [u, s] = await Promise.all([
      api.get<{ users: AdminUser[] }>('/api/admin/users'),
      api.get<Stats>('/api/admin/stats'),
    ])
    setUsers(u.users)
    setStats(s)
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
