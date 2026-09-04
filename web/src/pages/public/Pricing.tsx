import { useEffect, useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { api, BillingPack } from '../../api'
import { localeFromPath, useT } from '../../i18n'

export default function Pricing() {
  const { pathname } = useLocation()
  const locale = localeFromPath(pathname)
  const t = useT(locale)
  const [packs, setPacks] = useState<BillingPack[] | null>(null)
  const [error, setError] = useState(false)

  // Client-only fetch: prerendered HTML ships the static copy below plus
  // the loading state; live prices arrive after hydration.
  useEffect(() => {
    let cancelled = false
    api.billing
      .catalogue()
      .then((cat) => { if (!cancelled) setPacks(cat.packs) })
      .catch(() => { if (!cancelled) setError(true) })
    return () => { cancelled = true }
  }, [])

  const faq = t<{ q: string; a: string }[]>('pricing.faq.items')

  return (
    <div className="mx-auto max-w-5xl px-6 py-16">
      <h1 style={{ fontFamily: 'var(--font-display)', fontSize: 'var(--text-display-s)', color: 'var(--color-ink)' }}>
        {t('pricing.title')}
      </h1>
      <p className="mt-4 max-w-2xl" style={{ color: 'var(--color-ink-soft)' }}>{t('pricing.intro')}</p>

      <div className="mt-12">
        {error && <p style={{ color: 'var(--color-accent)' }}>{t('pricing.error')}</p>}
        {!error && !packs && <p style={{ color: 'var(--color-ink-soft)' }}>{t('pricing.loading')}</p>}
        {packs && (
          <ul className="grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
            {packs.map((pack) => (
              <li
                key={pack.id}
                style={{ border: '1px solid var(--color-border)', borderRadius: 'var(--radius-lg)', padding: 'var(--space-6)' }}
              >
                <p style={{ fontFamily: 'var(--font-display)', fontSize: 'var(--text-lg)', color: 'var(--color-ink)' }}>{pack.label}</p>
                <p className="mt-2" style={{ fontSize: 'var(--text-2xl)', color: 'var(--color-ink)' }}>
                  {pack.amount_eur.toFixed(0)} €{pack.kind === 'subscription' ? '/mois' : ''}
                </p>
                <p className="mt-1 text-sm" style={{ color: 'var(--color-ink-soft)' }}>
                  {pack.credits} crédits · {pack.price_per_page.toFixed(3)} €/page
                </p>
              </li>
            ))}
          </ul>
        )}
      </div>

      <section className="mt-16" style={{ background: 'var(--color-paper-2)', borderRadius: 'var(--radius-lg)', padding: 'var(--space-8)' }}>
        <h2 style={{ fontFamily: 'var(--font-display)', fontSize: 'var(--text-xl)', color: 'var(--color-ink)' }}>
          {t('pricing.credits_explainer.title')}
        </h2>
        <p className="mt-2" style={{ color: 'var(--color-ink-soft)' }}>{t('pricing.credits_explainer.body')}</p>
      </section>

      <section className="mt-16">
        <dl className="space-y-6">
          {faq.map((item) => (
            <div key={item.q}>
              <dt style={{ fontWeight: 600, color: 'var(--color-ink)' }}>{item.q}</dt>
              <dd className="mt-1" style={{ color: 'var(--color-ink-soft)' }}>{item.a}</dd>
            </div>
          ))}
        </dl>
      </section>

      <Link
        to="/register"
        className="mt-16 inline-block rounded-md px-6 py-3 font-medium"
        style={{ background: 'var(--color-accent)', color: 'var(--color-accent-ink)', borderRadius: 'var(--radius-md)' }}
      >
        {t('pricing.cta')}
      </Link>
    </div>
  )
}
