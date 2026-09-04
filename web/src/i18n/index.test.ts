import { describe, expect, test, vi } from 'vitest'
import { localeFromPath, ROUTE_PAIRS, useT } from './index'

describe('localeFromPath', () => {
  test('defaults to fr for french paths', () => {
    expect(localeFromPath('/')).toBe('fr')
    expect(localeFromPath('/tarifs')).toBe('fr')
  })
  test('detects en prefix', () => {
    expect(localeFromPath('/en')).toBe('en')
    expect(localeFromPath('/en/pricing')).toBe('en')
  })
})

describe('ROUTE_PAIRS', () => {
  test('every fr path maps to an en path and back', () => {
    const pairs: [string, string][] = [
      ['/', '/en'],
      ['/tarifs', '/en/pricing'],
      ['/a-propos', '/en/about'],
      ['/confidentialite', '/en/privacy'],
      ['/cgu', '/en/terms'],
    ]
    for (const [fr, en] of pairs) {
      expect(ROUTE_PAIRS[fr]).toBe(en)
      expect(ROUTE_PAIRS[en]).toBe(fr)
    }
  })
})

describe('useT', () => {
  test('resolves a dotted key to a string', () => {
    const t = useT('fr')
    expect(t('home.hero.cta_primary')).toBe('Créer un compte — 100 pages offertes')
  })
  test('resolves the same key in english', () => {
    const t = useT('en')
    expect(t('home.hero.cta_primary')).toBe('Create an account — 100 free pages')
  })
  test('returns raw arrays for list content', () => {
    const t = useT('fr')
    const steps = t<{ title: string; body: string }[]>('home.how.steps')
    expect(steps).toHaveLength(3)
    expect(steps[0].title).toBe('Déposez')
  })
  test('logs and falls back to the key path when missing', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const t = useT('fr')
    expect(t('home.nonexistent.key')).toBe('home.nonexistent.key')
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })
})
