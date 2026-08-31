import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { Elements, PaymentElement, AddressElement, useElements, useStripe }
  from '@stripe/react-stripe-js'
import { loadStripe, Stripe } from '@stripe/stripe-js'
import { api, BillingCatalogue, BillingStatus, BillingPack } from '../api'

function CheckoutForm({ onDone }: { onDone: () => void }) {
  const stripe = useStripe()
  const elements = useElements()
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!stripe || !elements) return
    setBusy(true); setErr('')
    const { error } = await stripe.confirmPayment({
      elements,
      confirmParams: { return_url: `${window.location.origin}/billing?done=1` },
      redirect: 'if_required',
    })
    setBusy(false)
    if (error) setErr(error.message || 'Paiement refusé')
    else onDone()
  }

  return (
    <form onSubmit={submit} className="space-y-3">
      <AddressElement options={{ mode: 'billing' }} />
      <PaymentElement />
      {err && <p className="text-sm text-red-600">{err}</p>}
      <button disabled={!stripe || busy}
              className="w-full bg-indigo-600 text-white rounded-md py-2 text-sm disabled:opacity-50">
        {busy ? 'Traitement…' : 'Payer'}
      </button>
    </form>
  )
}

const REASON_LABELS: Record<string, string> = {
  purchase: 'Achat',
  subscription_grant: 'Abonnement',
  refund: 'Remboursement',
  rebase_topup: 'Ajustement',
}

export default function Billing() {
  const [cat, setCat] = useState<BillingCatalogue | null>(null)
  const [status, setStatus] = useState<BillingStatus | null>(null)
  const [clientSecret, setClientSecret] = useState<string | null>(null)
  const [selected, setSelected] = useState<BillingPack | null>(null)
  const [msg, setMsg] = useState('')
  const [err, setErr] = useState('')
  const [confirmingCancel, setConfirmingCancel] = useState(false)
  const [justPaid, setJustPaid] = useState(false)

  const stripePromise = useMemo<Promise<Stripe | null> | null>(
    () => (cat?.publishable_key ? loadStripe(cat.publishable_key) : null), [cat?.publishable_key])

  const reload = () => Promise.all([api.billing.catalogue(), api.billing.status()])
    .then(([c, s]) => { setCat(c); setStatus(s) })

  useEffect(() => { reload() }, [])

  // Return from Stripe redirect (?done=1): poll the balance for a short while.
  useEffect(() => {
    if (!new URLSearchParams(window.location.search).get('done')) return
    setMsg('Paiement reçu — les crédits arrivent dans quelques secondes.')
    const t = setInterval(() => api.billing.status().then(setStatus).catch(() => {}), 2500)
    const stop = setTimeout(() => clearInterval(t), 20000)
    return () => { clearInterval(t); clearTimeout(stop) }
  }, [])

  // In-page payment confirmed (redirect: 'if_required'): poll until unmount / timeout.
  useEffect(() => {
    if (!justPaid) return
    const t = setInterval(() => api.billing.status().then(setStatus).catch(() => {}), 2000)
    const stop = setTimeout(() => { clearInterval(t); setJustPaid(false) }, 20000)
    return () => { clearInterval(t); clearTimeout(stop) }
  }, [justPaid])

  async function pick(p: BillingPack) {
    setSelected(p); setClientSecret(null); setMsg(''); setErr('')
    try {
      const r = p.kind === 'subscription'
        ? await api.billing.subscribe(p.id)
        : await api.billing.intent(p.id)
      setClientSecret(r.client_secret)
    } catch (e: any) {
      setErr(e?.message || 'Impossible de démarrer le paiement.')
    }
  }

  async function cancelSub() {
    setConfirmingCancel(false)
    setErr('')
    try {
      await api.billing.cancel()
      setMsg('Abonnement résilié à la fin de la période.')
      reload()
    } catch (e: any) {
      setErr(e?.message || 'Échec de la résiliation.')
    }
  }

  if (!cat || !status) return <div className="p-8 text-slate-400">Chargement…</div>

  return (
    <div className="max-w-3xl mx-auto p-6">
      <div className="flex items-center gap-3 mb-4">
        <Link to="/" className="text-sm text-slate-500">← Station</Link>
        <h1 className="text-lg font-semibold">Crédits</h1>
        <span className="text-sm bg-indigo-50 text-indigo-700 rounded-full px-3 py-1">
          {status.credit_balance} crédits
        </span>
      </div>

      <p className="text-sm text-slate-500 mb-4">1 crédit = 1 page. La correction IA est offerte.</p>
      {msg && <p className="text-sm text-emerald-700 bg-emerald-50 rounded-md p-2 mb-4">{msg}</p>}
      {err && <p className="text-sm text-red-600 bg-red-50 rounded-md p-2 mb-4">{err}</p>}

      {!cat.enabled && (
        <p className="text-sm text-amber-700 bg-amber-50 rounded-md p-3">
          Les paiements sont temporairement indisponibles.
        </p>
      )}

      {status.subscription && (
        <div className="border rounded-lg p-3 mb-4 text-sm">
          Abonnement <b>{status.subscription.plan_id}</b> — {status.subscription.status}
          {status.subscription.cancel_at_period_end
            ? ' (résiliation programmée)'
            : confirmingCancel
              ? (
                <span className="ml-3 inline-flex items-center gap-2">
                  Résilier l'abonnement ?
                  <button className="text-red-600 font-medium" onClick={cancelSub}>Oui, résilier</button>
                  <button className="text-slate-500" onClick={() => setConfirmingCancel(false)}>Annuler</button>
                </span>
              )
              : <button className="ml-3 text-red-600" onClick={() => setConfirmingCancel(true)}>Résilier</button>}
        </div>
      )}

      <div className="grid sm:grid-cols-2 gap-3">
        {cat.packs.map((p) => (
          <button key={p.id} onClick={() => pick(p)} disabled={!cat.enabled}
                  className={`text-left border rounded-lg p-4 hover:border-indigo-400 disabled:opacity-40
                              ${selected?.id === p.id ? 'border-indigo-500 ring-1 ring-indigo-300' : ''}`}>
            <div className="flex items-center justify-between">
              <span className="font-medium">{p.label}</span>
              {p.id === 'chercheur' && (
                <span className="text-[10px] bg-indigo-100 text-indigo-700 rounded px-1.5 py-0.5">
                  meilleur rapport
                </span>
              )}
            </div>
            <p className="text-2xl font-semibold mt-1">
              {p.amount_eur.toFixed(0)} €{p.interval ? <span className="text-sm">/mois</span> : null}
            </p>
            <p className="text-xs text-slate-500">
              {p.credits} crédits · {(p.price_per_page).toFixed(3)} €/page
            </p>
          </button>
        ))}
      </div>

      {clientSecret && stripePromise && (
        <div className="border rounded-lg p-4 mt-5">
          <h2 className="text-sm font-semibold mb-3">Paiement — {selected?.label}</h2>
          <Elements stripe={stripePromise} options={{ clientSecret }}>
            <CheckoutForm onDone={() => {
              setClientSecret(null)
              setMsg('Paiement confirmé — mise à jour du solde…')
              setJustPaid(true)
            }} />
          </Elements>
        </div>
      )}

      {status.purchases.length > 0 && (
        <div className="mt-6">
          <h2 className="text-sm font-semibold mb-2">Historique</h2>
          <ul className="text-sm divide-y border rounded-lg">
            {status.purchases.map((p, i) => (
              <li key={i} className="flex items-center justify-between px-3 py-2">
                <span>{REASON_LABELS[p.reason] ?? p.reason}</span>
                <span className={p.delta >= 0 ? 'text-emerald-700' : 'text-red-600'}>
                  {p.delta >= 0 ? '+' : ''}{p.delta} crédits
                </span>
                <span className="text-slate-400">
                  {p.created_at ? new Date(p.created_at).toLocaleDateString('fr-FR') : '—'}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
