import type { CSSProperties, ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { stationHref } from '../../lib/urls'

/** Links from the vitrine (home.) across to the Station (app.). Renders a
 *  plain <a> for the absolute cross-host URL when VITE_STATION_URL is set,
 *  and a react-router <Link> for the relative path otherwise. */
export default function StationLink({
  path = '/station',
  className,
  style,
  children,
}: {
  path?: string
  className?: string
  style?: CSSProperties
  children: ReactNode
}) {
  const href = stationHref(path)
  if (/^https?:\/\//.test(href)) {
    return (
      <a href={href} className={className} style={style}>
        {children}
      </a>
    )
  }
  return (
    <Link to={href} className={className} style={style}>
      {children}
    </Link>
  )
}
