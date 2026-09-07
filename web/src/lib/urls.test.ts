import { afterEach, expect, test, vi } from 'vitest'

afterEach(() => {
  vi.unstubAllEnvs()
})

async function freshStationHref() {
  vi.resetModules()
  return (await import('./urls')).stationHref
}

test('returns a relative path when VITE_STATION_URL is unset', async () => {
  vi.stubEnv('VITE_STATION_URL', '')
  const stationHref = await freshStationHref()
  expect(stationHref('/station')).toBe('/station')
  expect(stationHref('/register')).toBe('/register')
})

test('returns an absolute URL when VITE_STATION_URL is set', async () => {
  vi.stubEnv('VITE_STATION_URL', 'https://app.example/')
  const stationHref = await freshStationHref()
  expect(stationHref('/station')).toBe('https://app.example/station')
  expect(stationHref()).toBe('https://app.example/station')
})
