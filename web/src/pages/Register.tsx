import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { api, setToken } from '../api'

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
    <div className="min-h-screen flex items-center justify-center">
      <form onSubmit={submit} className="bg-white rounded-xl shadow p-8 w-full max-w-sm space-y-4">
        <h1 className="text-2xl font-semibold text-center">📜 Palimora</h1>
        <p className="text-sm text-slate-500 text-center">Créer un compte — crédits de bienvenue offerts</p>
        <input className="w-full border rounded-lg px-3 py-2" placeholder="Nom affiché"
               value={name} onChange={(e) => setName(e.target.value)} />
        <input className="w-full border rounded-lg px-3 py-2" type="email" placeholder="Email"
               value={email} onChange={(e) => setEmail(e.target.value)} required />
        <input className="w-full border rounded-lg px-3 py-2" type="password" placeholder="Mot de passe (10 car. min)"
               value={password} onChange={(e) => setPassword(e.target.value)} required minLength={10} />
        {error && <p className="text-red-600 text-sm">{error}</p>}
        <button disabled={busy}
                className="w-full bg-indigo-600 text-white rounded-lg py-2 font-medium disabled:opacity-50">
          {busy ? 'Création…' : 'Créer le compte'}
        </button>
        <p className="text-sm text-center text-slate-500">
          Déjà inscrit ? <Link className="text-indigo-600" to="/login">Se connecter</Link>
        </p>
      </form>
    </div>
  )
}
