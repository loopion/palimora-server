import { useEffect, useState } from 'react'
import { Navigate, Outlet, useLocation } from 'react-router-dom'
import { getToken } from '../../api'
import { localeFromPath } from '../../i18n'
import PublicNav from './PublicNav'
import PublicFooter from './PublicFooter'

export default function PublicLayout() {
  const { pathname } = useLocation()
  const locale = localeFromPath(pathname)
  const [authed, setAuthed] = useState(false)

  // Client-only: prerendered HTML always renders the logged-out shell;
  // this runs after hydration only, so it never affects SSR output.
  useEffect(() => {
    setAuthed(!!getToken())
  }, [])

  const isHomepage = pathname === '/' || pathname === '/en'
  if (isHomepage && authed) {
    return <Navigate to="/station" replace />
  }

  return (
    <div style={{ background: 'var(--color-paper)', minHeight: '100%', fontFamily: 'var(--font-body)' }}>
      <PublicNav locale={locale} authed={authed} />
      <main>
        <Outlet />
      </main>
      <PublicFooter locale={locale} />
    </div>
  )
}
