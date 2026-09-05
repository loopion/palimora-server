import { api, getImpersonation, setImpersonation } from '../api'
import { Alert, AlertAction, AlertDescription } from './ui/alert'
import { Button } from './ui/button'

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
    <div className="sticky top-0 z-50 px-3 pt-2">
      <Alert className="border-primary/40 bg-primary/10">
        <AlertDescription className="text-foreground">
          Vous agissez en tant que <strong className="font-semibold">{email}</strong>
        </AlertDescription>
        <AlertAction>
          <Button size="xs" variant="outline" onClick={stop}>Arrêter</Button>
        </AlertAction>
      </Alert>
    </div>
  )
}
