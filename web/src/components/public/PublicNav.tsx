import { Link, useLocation } from 'react-router-dom'
import Mark from './Mark'
import { ROUTE_PAIRS, useT, type Locale } from '../../i18n'

export default function PublicNav({ locale, authed }: { locale: Locale; authed: boolean }) {
  const t = useT(locale)
  const { pathname } = useLocation()
  const homePath = locale === 'fr' ? '/' : '/en'
  const pricingPath = locale === 'fr' ? '/tarifs' : '/en/pricing'
  const aboutPath = locale === 'fr' ? '/a-propos' : '/en/about'
  const otherLocalePath = ROUTE_PAIRS[pathname] ?? (locale === 'fr' ? '/en' : '/')

  return (
    <header className="border-b" style={{ borderColor: 'var(--color-border)', background: 'var(--color-paper)' }}>
      <nav
        className="mx-auto flex max-w-5xl items-center justify-between px-6 py-4"
        aria-label={locale === 'fr' ? 'Navigation principale' : 'Main navigation'}
      >
        <Link to={homePath} className="flex items-center gap-2 font-semibold" style={{ fontFamily: 'var(--font-display)', color: 'var(--color-ink)' }}>
          <Mark size={28} />
          Palimora
        </Link>
        <div className="flex items-center gap-6" style={{ fontFamily: 'var(--font-body)' }}>
          <Link to={pricingPath} style={{ color: 'var(--color-ink-soft)' }}>{t('common.nav.pricing')}</Link>
          <Link to={aboutPath} style={{ color: 'var(--color-ink-soft)' }}>{t('common.nav.about')}</Link>
          <Link
            to={otherLocalePath}
            aria-label={locale === 'fr' ? 'Switch to English' : 'Passer en français'}
            style={{ color: 'var(--color-ink-soft)' }}
          >
            {t('common.nav.lang_toggle')}
          </Link>
          <Link
            to={authed ? '/station' : '/register'}
            className="rounded-md px-4 py-2 font-medium"
            style={{
              background: 'var(--color-accent)',
              color: 'var(--color-accent-ink)',
              borderRadius: 'var(--radius-md)',
            }}
          >
            {authed ? t('common.nav.cta_open_app') : t('common.nav.cta_signup')}
          </Link>
        </div>
      </nav>
    </header>
  )
}
