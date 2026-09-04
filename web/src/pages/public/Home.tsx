import { Link, useLocation } from 'react-router-dom'
import { localeFromPath, useT } from '../../i18n'

export default function Home() {
  const { pathname } = useLocation()
  const locale = localeFromPath(pathname)
  const t = useT(locale)
  const registerPath = '/register'
  const pricingPath = locale === 'fr' ? '/tarifs' : '/en/pricing'

  const steps = t<{ title: string; body: string }[]>('home.how.steps')
  const items = t<string[]>('home.capabilities.items')
  const faq = t<{ q: string; a: string }[]>('home.faq.items')

  return (
    <>
      <section className="mx-auto max-w-5xl px-6 pb-16 pt-20">
        <h1
          style={{ fontFamily: 'var(--font-display)', fontSize: 'var(--text-display)', color: 'var(--color-ink)', overflowWrap: 'anywhere', minWidth: 0 }}
        >
          {t('home.hero.title')}
        </h1>
        <p className="mt-6 max-w-2xl" style={{ fontSize: 'var(--text-lg)', color: 'var(--color-ink-soft)' }}>
          {t('home.hero.subtitle')}
        </p>
        <div className="mt-8 flex flex-wrap items-start gap-x-4 gap-y-2">
          <div>
            <Link
              to={registerPath}
              className="inline-block rounded-md px-6 py-3 font-medium"
              style={{ background: 'var(--color-accent)', color: 'var(--color-accent-ink)', borderRadius: 'var(--radius-md)' }}
            >
              {t('home.hero.cta_primary')}
            </Link>
            <p className="mt-2 text-sm" style={{ color: 'var(--color-ink-soft)' }}>{t('home.hero.cta_primary_note')}</p>
          </div>
          <a
            href="#comment-ca-marche"
            className="rounded-md px-6 py-3 font-medium"
            style={{ border: '1px solid var(--color-border)', color: 'var(--color-ink)', borderRadius: 'var(--radius-md)' }}
          >
            {t('home.hero.cta_secondary')}
          </a>
        </div>
      </section>

      <section className="mx-auto max-w-5xl px-6 pb-16">
        <figure style={{ border: '1px solid var(--color-border)', borderRadius: 'var(--radius-lg)', overflow: 'hidden' }}>
          <img src="/workbench-screenshot.png" alt="" width={1200} height={750} style={{ display: 'block', width: '100%', height: 'auto' }} />
          <figcaption className="p-4 text-sm" style={{ color: 'var(--color-ink-soft)' }}>
            {t('home.workbench.caption')}
          </figcaption>
        </figure>
      </section>

      <section id="comment-ca-marche" className="mx-auto max-w-5xl px-6 pb-16">
        <h2 style={{ fontFamily: 'var(--font-display)', fontSize: 'var(--text-2xl)', color: 'var(--color-ink)' }}>
          {t('home.how.title')}
        </h2>
        <ol className="mt-8 grid gap-8 sm:grid-cols-3">
          {steps.map((step, i) => (
            <li key={step.title}>
              <span style={{ color: 'var(--color-accent)', fontFamily: 'var(--font-body)', fontWeight: 600 }}>{`0${i + 1}`}</span>
              <h3 className="mt-2" style={{ fontFamily: 'var(--font-display)', fontSize: 'var(--text-lg)', color: 'var(--color-ink)' }}>
                {step.title}
              </h3>
              <p className="mt-2" style={{ color: 'var(--color-ink-soft)' }}>{step.body}</p>
            </li>
          ))}
        </ol>
      </section>

      <section className="mx-auto max-w-5xl px-6 pb-16">
        <h2 style={{ fontFamily: 'var(--font-display)', fontSize: 'var(--text-2xl)', color: 'var(--color-ink)' }}>
          {t('home.capabilities.title')}
        </h2>
        <ul className="mt-6 grid gap-3 sm:grid-cols-2">
          {items.map((item) => (
            <li key={item} style={{ color: 'var(--color-ink-soft)' }}>{item}</li>
          ))}
        </ul>
        <p className="mt-6 text-sm" style={{ color: 'var(--color-ink-soft)', fontStyle: 'italic' }}>
          {t('home.capabilities.stat_slot_label')}
        </p>
      </section>

      <section
        className="mx-auto max-w-5xl px-6 pb-16"
        style={{ background: 'var(--color-paper-2)', borderRadius: 'var(--radius-lg)', padding: 'var(--space-8)' }}
      >
        <h2 style={{ fontFamily: 'var(--font-display)', fontSize: 'var(--text-2xl)', color: 'var(--color-ink)' }}>
          {t('home.pricing_teaser.title')}
        </h2>
        <p className="mt-2" style={{ color: 'var(--color-ink-soft)' }}>{t('home.pricing_teaser.body')}</p>
        <Link to={pricingPath} className="mt-4 inline-block font-medium" style={{ color: 'var(--color-accent)' }}>
          {t('home.pricing_teaser.cta')} →
        </Link>
      </section>

      <section className="mx-auto max-w-5xl px-6 pb-16">
        <h2 style={{ fontFamily: 'var(--font-display)', fontSize: 'var(--text-2xl)', color: 'var(--color-ink)' }}>
          {t('home.faq.title')}
        </h2>
        <dl className="mt-6 space-y-6">
          {faq.map((item) => (
            <div key={item.q}>
              <dt style={{ fontWeight: 600, color: 'var(--color-ink)' }}>{item.q}</dt>
              <dd className="mt-1" style={{ color: 'var(--color-ink-soft)' }}>{item.a}</dd>
            </div>
          ))}
        </dl>
      </section>

      <section className="mx-auto max-w-5xl px-6 pb-24 text-center">
        <h2 style={{ fontFamily: 'var(--font-display)', fontSize: 'var(--text-2xl)', color: 'var(--color-ink)' }}>
          {t('home.closing.title')}
        </h2>
        <Link
          to={registerPath}
          className="mt-6 inline-block rounded-md px-6 py-3 font-medium"
          style={{ background: 'var(--color-accent)', color: 'var(--color-accent-ink)', borderRadius: 'var(--radius-md)' }}
        >
          {t('home.closing.cta')}
        </Link>
      </section>
    </>
  )
}
