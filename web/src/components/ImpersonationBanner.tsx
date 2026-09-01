import { api, getImpersonation, setImpersonation } from '../api'

export default function ImpersonationBanner() {
  const target = getImpersonation()
  if (!target) return null
  const { id, email } = target

  async function stop() {
    try {
      await api.delete(`/api/admin/impersonate?user_id=${encodeURIComponent(id)}`)
    } catch {
      // Ignore: the local session must be cleared regardless of the server response.
    } finally {
      setImpersonation(null)
      window.location.assign('/admin')
    }
  }

  return (
    <div
      role="status"
      className="sticky top-0 z-50 flex items-center gap-3 bg-amber-500 px-4 py-2 text-sm text-white"
    >
      <span>
        Vous agissez en tant que <strong>{email}</strong>
      </span>
      <button onClick={stop} className="ml-auto rounded bg-white/20 px-2 py-1 font-medium">
        Arrêter
      </button>
    </div>
  )
}
