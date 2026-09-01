import { beforeEach, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import Admin from './Admin'
import ImpersonationBanner from '../components/ImpersonationBanner'
import { setImpersonation } from '../api'

const navigate = vi.fn()
vi.mock('react-router-dom', async (orig) => ({
  ...(await orig<any>()),
  useNavigate: () => navigate,
}))

beforeEach(() => {
  localStorage.clear()
  localStorage.setItem('palimora_token', 'tok')
  navigate.mockClear()
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.endsWith('/api/auth/me')) return new Response(JSON.stringify({ is_admin: true }), { status: 200 })
    if (url.endsWith('/api/admin/users')) return new Response(JSON.stringify({ users: [
      { id: 'u1', email: 'user@test.fr', display_name: 'U', credit_balance: 5, is_admin: false, is_active: true, created_at: '2026-09-01T00:00:00Z' },
    ] }), { status: 200 })
    if (url.endsWith('/api/admin/stats')) return new Response(JSON.stringify({
      users: 1, documents: 0, pages_done: 0, pages_error: 0, pages_total: 0, credits_in_circulation: 5 }), { status: 200 })
    if (url.includes('/api/admin/audit')) return new Response(JSON.stringify({ rows: [
      { id: 'a1', created_at: '2026-09-01T10:00:00Z', event: 'impersonation.start', method: null, path: null, status_code: null, actor_email: 'admin@test.fr', target_email: 'user@test.fr' },
    ] }), { status: 200 })
    if (url.match(/\/api\/admin\/impersonate\/u1$/)) return new Response(JSON.stringify({ id: 'u1', email: 'user@test.fr', display_name: 'U' }), { status: 200 })
    return new Response('{}', { status: 200 })
  }))
})

it('impersonate button stores target and hard-navigates home', async () => {
  const assign = vi.fn()
  vi.stubGlobal('location', { assign, href: '' } as any)
  render(<MemoryRouter><Admin /></MemoryRouter>)
  const btn = await screen.findByRole('button', { name: /impersoner/i })
  await userEvent.click(btn)
  await waitFor(() => {
    expect(localStorage.getItem('palimora_impersonate')).toContain('u1')
    expect(assign).toHaveBeenCalledWith('/')
  })
})

it('banner renders once a target is stored (post-reload state)', () => {
  setImpersonation({ id: 'u1', email: 'user@test.fr' })
  render(<MemoryRouter><ImpersonationBanner /><Admin /></MemoryRouter>)
  expect(screen.getByText(/Vous agissez en tant que/i)).toBeInTheDocument()
})

it('failed impersonate shows toast and does not navigate', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.endsWith('/api/auth/me')) return new Response(JSON.stringify({ is_admin: true }), { status: 200 })
    if (url.endsWith('/api/admin/users')) return new Response(JSON.stringify({ users: [
      { id: 'u1', email: 'user@test.fr', display_name: 'U', credit_balance: 5, is_admin: false, is_active: true, created_at: '2026-09-01T00:00:00Z' },
    ] }), { status: 200 })
    if (url.endsWith('/api/admin/stats')) return new Response(JSON.stringify({
      users: 1, documents: 0, pages_done: 0, pages_error: 0, pages_total: 0, credits_in_circulation: 5 }), { status: 200 })
    if (url.includes('/api/admin/audit')) return new Response(JSON.stringify({ rows: [] }), { status: 200 })
    if (url.match(/\/api\/admin\/impersonate\/u1$/)) return new Response(JSON.stringify({ detail: 'nope' }), { status: 500 })
    return new Response('{}', { status: 200 })
  }))
  render(<MemoryRouter><Admin /></MemoryRouter>)
  const btn = await screen.findByRole('button', { name: /impersoner/i })
  await userEvent.click(btn)
  expect(await screen.findByText(/Erreur lors de l'impersonation/i)).toBeInTheDocument()
  expect(navigate).not.toHaveBeenCalledWith('/')
})

it('renders the audit journal', async () => {
  render(<MemoryRouter><Admin /></MemoryRouter>)
  expect(await screen.findByText(/Journal d'impersonation/i)).toBeInTheDocument()
  await waitFor(() => expect(screen.getByText('impersonation.start')).toBeInTheDocument())
})
