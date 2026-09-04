import { useLocation } from 'react-router-dom'
import { localeFromPath, useT } from '../../i18n'

export default function LegalPage({ namespace }: { namespace: 'privacy' | 'terms' }) {
  const { pathname } = useLocation()
  const locale = localeFromPath(pathname)
  const t = useT(locale)
  const sections = t<{ heading: string; body: string }[]>(`${namespace}.sections`)

  return (
    <div className="mx-auto max-w-2xl px-6 py-16">
      <h1 style={{ fontFamily: 'var(--font-display)', fontSize: 'var(--text-display-s)', color: 'var(--color-ink)' }}>
        {t(`${namespace}.title`)}
      </h1>
      <p className="mt-4 text-sm italic" style={{ color: 'var(--color-ink-soft)' }}>{t(`${namespace}.intro`)}</p>
      <div className="mt-10 space-y-8">
        {sections.map((s) => (
          <section key={s.heading}>
            <h2 style={{ fontFamily: 'var(--font-display)', fontSize: 'var(--text-lg)', color: 'var(--color-ink)' }}>{s.heading}</h2>
            <p className="mt-2" style={{ color: 'var(--color-ink-soft)' }}>{s.body}</p>
          </section>
        ))}
      </div>
    </div>
  )
}
