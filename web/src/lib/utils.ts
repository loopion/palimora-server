export { cn } from "cn"

const UNITS = ['Ko', 'Mo', 'Go']

/** Human-readable file size, French units. `null`/`undefined` = size not reported. */
export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined) return 'taille inconnue'
  if (bytes < 1024) return `${bytes} o`
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value.toFixed(1)} ${UNITS[unit]}`
}
