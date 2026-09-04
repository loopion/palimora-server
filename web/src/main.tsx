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

function AppRoutes() {
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

const rootEl = document.getElementById('root')!
const app = (
  <React.StrictMode>
    <BrowserRouter>
      <ImpersonationBanner />
      <AppRoutes />
    </BrowserRouter>
  </React.StrictMode>
)

// Prerendered public pages ship real markup in #root; hydrate instead of
// clobbering it. App-only paths (no prerendered file) have an empty #root
// and get a normal client render.
if (rootEl.hasChildNodes()) {
  ReactDOM.hydrateRoot(rootEl, app)
} else {
  ReactDOM.createRoot(rootEl).render(app)
}
