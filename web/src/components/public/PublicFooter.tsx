import { Link } from 'react-router-dom'
import { CONTACT_EMAIL, useT, type Locale } from '../../i18n'

export default function PublicFooter({ locale }: { locale: Locale }) {
  const t = useT(locale)
  const pricingPath = locale === 'fr' ? '/tarifs' : '/en/pricing'
  const aboutPath = locale === 'fr' ? '/a-propos' : '/en/about'
  const privacyPath = locale === 'fr' ? '/confidentialite' : '/en/privacy'
  const termsPath = locale === 'fr' ? '/cgu' : '/en/terms'

  return (
    <footer
      className="mt-24 border-t px-6 py-12"
      style={{ borderColor: 'var(--color-border)', background: 'var(--color-paper-2)', fontFamily: 'var(--font-body)' }}
    >
      <div className="mx-auto max-w-5xl">
        <p className="text-lg" style={{ fontFamily: 'var(--font-display)', color: 'var(--color-ink)' }}>
          {t('common.footer.statement')}
        </p>
        <nav className="mt-6 flex flex-wrap gap-x-6 gap-y-2" style={{ color: 'var(--color-ink-soft)' }}>
          <Link to={pricingPath}>{t('common.footer.links.pricing')}</Link>
          <Link to={aboutPath}>{t('common.footer.links.about')}</Link>
          <Link to={privacyPath}>{t('common.footer.links.privacy')}</Link>
          <Link to={termsPath}>{t('common.footer.links.terms')}</Link>
          <a href={`mailto:${CONTACT_EMAIL}`}>{t('common.footer.links.contact')}</a>
        </nav>
        <p className="mt-8 text-sm" style={{ color: 'var(--color-ink-soft)' }}>{t('common.footer.copyright')}</p>
      </div>
    </footer>
  )
}
