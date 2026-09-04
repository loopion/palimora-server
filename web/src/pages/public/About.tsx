import { useLocation } from 'react-router-dom'
import { CONTACT_EMAIL, localeFromPath, useT } from '../../i18n'

export default function About() {
  const { pathname } = useLocation()
  const locale = localeFromPath(pathname)
  const t = useT(locale)
  const paragraphs = t<string[]>('about.paragraphs')

  return (
    <div className="mx-auto max-w-2xl px-6 py-16">
      <h1
        style={{ fontFamily: 'var(--font-display)', fontSize: 'var(--text-display-s)', color: 'var(--color-ink)', overflowWrap: 'anywhere', minWidth: 0 }}
      >
        {t('about.title')}
      </h1>
      <div className="mt-8 space-y-5" style={{ fontSize: 'var(--text-lg)', color: 'var(--color-ink-soft)' }}>
        {paragraphs.map((p) => <p key={p}>{p}</p>)}
      </div>
      <section className="mt-16">
        <h2 style={{ fontFamily: 'var(--font-display)', fontSize: 'var(--text-xl)', color: 'var(--color-ink)' }}>
          {t('about.contact_title')}
        </h2>
        <p className="mt-2" style={{ color: 'var(--color-ink-soft)' }}>
          {t('about.contact_body')}{' '}
          <a href={`mailto:${CONTACT_EMAIL}`} style={{ color: 'var(--color-accent)' }}>{CONTACT_EMAIL}</a>
        </p>
      </section>
    </div>
  )
}
