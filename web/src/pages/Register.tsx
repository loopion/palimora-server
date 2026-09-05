import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { api, setToken } from '../api'
import Mark from '../components/Mark'
import { Button } from '../components/ui/button'
import { Input } from '../components/ui/input'

export default function Register() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [name, setName] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const navigate = useNavigate()

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError('')
    try {
      const data = await api.post<{ token: string }>('/api/auth/register', {
        email, password, display_name: name,
      })
      setToken(data.token)
      navigate('/')
    } catch (err: any) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center p-6">
      <form onSubmit={submit}
            className="bg-card border rounded-xl shadow-sm p-8 w-full max-w-sm space-y-4">
        <div className="flex flex-col items-center gap-2">
          <Mark size={40} />
          <h1 className="font-display text-2xl font-semibold">Palimora</h1>
          <p className="text-sm text-muted-foreground text-center">
            Créer un compte — crédits de bienvenue offerts
          </p>
        </div>
        <Input placeholder="Nom affiché" value={name} onChange={(e) => setName(e.target.value)} />
        <Input type="email" placeholder="Email" required
               value={email} onChange={(e) => setEmail(e.target.value)} />
        <Input type="password" placeholder="Mot de passe (10 car. min)" required minLength={10}
               value={password} onChange={(e) => setPassword(e.target.value)} />
        {error && <p className="text-sm text-destructive">{error}</p>}
        <Button type="submit" size="lg" className="w-full" disabled={busy}>
          {busy ? 'Création…' : 'Créer le compte'}
        </Button>
        <p className="text-sm text-center text-muted-foreground">
          Déjà inscrit ?{' '}
          <Link className="text-primary underline-offset-4 hover:underline" to="/login">
            Se connecter
          </Link>
        </p>
      </form>
    </div>
  )
}
