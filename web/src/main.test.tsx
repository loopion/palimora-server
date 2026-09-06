// web/src/main.tsx
// Route-table test: renders the real AppRoutes component (the same tree
// main.tsx mounts), not a hand-copied subset, so a future edit that
// accidentally drops a route or its auth wrapping fails this test.
import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router-dom'
import { vi } from 'vitest'

vi.mock('./api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./api')>()
  return {
    ...actual,
    getToken: vi.fn(() => null),
    api: { ...actual.api, billing: { catalogue: vi.fn().mockResolvedValue({ packs: [], publishable_key: '', enabled: true }) } },
  }
})

// Landing on the Station is a routing fact; mounting it drags in OpenSeadragon,
// which needs browser APIs jsdom does not have. Stand in for the page.
vi.mock('./pages/Station', () => ({ default: () => <div>station-page</div> }))

import { api, getToken } from './api'
import { AppRoutes } from './main'

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AppRoutes />
    </MemoryRouter>,
  )
}

// Records every path the router settles on, so a test can tell a direct
// redirect from one that lands somewhere else first.
function renderTrail(path: string) {
  const trail: string[] = []
  function Trail() {
    const { pathname } = useLocation()
    if (trail[trail.length - 1] !== pathname) trail.push(pathname)
    return null
  }
  render(
    <MemoryRouter initialEntries={[path]}>
      <Trail />
      <AppRoutes />
    </MemoryRouter>,
  )
  return trail
}

test('root path renders the homepage', () => {
  renderAt('/')
  expect(screen.getByRole('heading', { level: 1, name: /manuscrits ont une histoire/i })).toBeInTheDocument()
})

test('unknown path falls back to the homepage when signed out', () => {
  vi.mocked(getToken).mockReturnValue(null)
  renderAt('/nope')
  expect(screen.getByRole('heading', { level: 1, name: /manuscrits ont une histoire/i })).toBeInTheDocument()
})

test('unknown path falls back to the Station when signed in', () => {
  vi.mocked(getToken).mockReturnValue('a-token')
  renderAt('/nope')
  expect(screen.getByText('station-page')).toBeInTheDocument()
  expect(screen.queryByRole('heading', { level: 1, name: /manuscrits ont une histoire/i })).not.toBeInTheDocument()
})

test('a signed-in user reaches the Station without passing through the homepage', () => {
  vi.mocked(getToken).mockReturnValue('a-token')
  expect(renderTrail('/nope')).toEqual(['/nope', '/station'])
})

test('/tarifs renders the pricing page', async () => {
  renderAt('/tarifs')
  expect(screen.getByRole('heading', { level: 1, name: /tarifs simples/i })).toBeInTheDocument()
  await waitFor(() => expect(api.billing.catalogue).toHaveBeenCalled())
})

test('/station redirects to /login when unauthenticated', () => {
  vi.mocked(getToken).mockReturnValue(null)
  renderAt('/station')
  expect(screen.getByRole('button', { name: /se connecter/i })).toBeInTheDocument()
})

test('/admin redirects to /login when unauthenticated', () => {
  vi.mocked(getToken).mockReturnValue(null)
  renderAt('/admin')
  expect(screen.getByRole('button', { name: /se connecter/i })).toBeInTheDocument()
})

test('/billing redirects to /login when unauthenticated', () => {
  vi.mocked(getToken).mockReturnValue(null)
  renderAt('/billing')
  expect(screen.getByRole('button', { name: /se connecter/i })).toBeInTheDocument()
})
