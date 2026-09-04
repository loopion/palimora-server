import { fr } from './fr'
import { en } from './en'

export type Locale = 'fr' | 'en'
export const LOCALES: Locale[] = ['fr', 'en']

export const SITE_URL = 'https://home.palimora.pays.fr.eu.org'
export const CONTACT_EMAIL = 'contact@palimora.fr'

const DICTS: Record<Locale, unknown> = { fr, en }

export const ROUTE_PAIRS: Record<string, string> = {
  '/': '/en',
  '/en': '/',
  '/tarifs': '/en/pricing',
  '/en/pricing': '/tarifs',
  '/a-propos': '/en/about',
  '/en/about': '/a-propos',
  '/confidentialite': '/en/privacy',
  '/en/privacy': '/confidentialite',
  '/cgu': '/en/terms',
  '/en/terms': '/cgu',
}

export function localeFromPath(pathname: string): Locale {
  return pathname === '/en' || pathname.startsWith('/en/') ? 'en' : 'fr'
}

function get(obj: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((acc, key) => {
    if (acc && typeof acc === 'object' && key in (acc as Record<string, unknown>)) {
      return (acc as Record<string, unknown>)[key]
    }
    return undefined
  }, obj)
}

export function useT(locale: Locale) {
  const dict = DICTS[locale]
  return function t<T = string>(key: string): T {
    const value = get(dict, key)
    if (value === undefined) {
      console.warn(`[i18n] missing key "${key}" for locale "${locale}"`)
      return key as unknown as T
    }
    return value as T
  }
}
