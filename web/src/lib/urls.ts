// Absolute base for the deployed Station app. Empty in dev / on the app
// host itself, where relative links are correct.
const STATION_URL = import.meta.env.VITE_STATION_URL ?? ''

/** Absolute Station link when VITE_STATION_URL is set (vitrine on home.
 *  linking across to app.), relative otherwise. */
export function stationHref(path = '/station'): string {
  return STATION_URL ? STATION_URL.replace(/\/$/, '') + path : path
}
