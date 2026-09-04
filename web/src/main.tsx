import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import { getToken } from './api'
import ImpersonationBanner from './components/ImpersonationBanner'
import PublicLayout from './components/public/PublicLayout'
import Home from './pages/public/Home'
import Pricing from './pages/public/Pricing'
import About from './pages/public/About'
import Privacy from './pages/public/Privacy'
import Terms from './pages/public/Terms'
import Admin from './pages/Admin'
import Billing from './pages/Billing'
import Login from './pages/Login'
import Register from './pages/Register'
import Station from './pages/Station'
import './index.css'

function RequireAuth({ children }: { children: React.ReactNode }) {
  if (!getToken()) return <Navigate to="/login" replace />
  return <>{children}</>
}

export function AppRoutes() {
  return (
    <Routes>
      <Route element={<PublicLayout />}>
        <Route path="/" element={<Home />} />
        <Route path="/en" element={<Home />} />
        <Route path="/tarifs" element={<Pricing />} />
        <Route path="/en/pricing" element={<Pricing />} />
        <Route path="/a-propos" element={<About />} />
        <Route path="/en/about" element={<About />} />
        <Route path="/confidentialite" element={<Privacy />} />
        <Route path="/en/privacy" element={<Privacy />} />
        <Route path="/cgu" element={<Terms />} />
        <Route path="/en/terms" element={<Terms />} />
      </Route>
      <Route path="/login" element={<Login />} />
      <Route path="/register" element={<Register />} />
      <Route path="/station" element={<RequireAuth><Station /></RequireAuth>} />
      <Route path="/admin" element={<RequireAuth><Admin /></RequireAuth>} />
      <Route path="/billing" element={<RequireAuth><Billing /></RequireAuth>} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}

// Guarded on rootEl existing so importing AppRoutes for tests (main.test.tsx)
// doesn't try to mount into a #root jsdom never creates.
const rootEl = document.getElementById('root')
if (rootEl) {
  const app = (
    <React.StrictMode>
      <BrowserRouter>
        <ImpersonationBanner />
        <AppRoutes />
      </BrowserRouter>
    </React.StrictMode>
  )

  // Prerendered public pages ship real markup in #root, tagged with the
  // route it was rendered for (see web/scripts/prerender.mjs); hydrate only
  // when that tag matches the path actually being loaded. Everything else —
  // app-only paths served from app.html (empty #root, no tag), or a
  // prerendered file loaded at the wrong path — gets a normal client render
  // against a clean #root instead of hydrating against the wrong tree.
  if (rootEl.dataset.prerenderedPath === window.location.pathname) {
    ReactDOM.hydrateRoot(rootEl, app)
  } else {
    rootEl.innerHTML = ''
    ReactDOM.createRoot(rootEl).render(app)
  }
}
