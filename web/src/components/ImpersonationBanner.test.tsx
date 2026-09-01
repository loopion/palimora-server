import { beforeEach, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import ImpersonationBanner from './ImpersonationBanner'
import { setImpersonation } from '../api'

beforeEach(() => { localStorage.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

it('renders nothing when not impersonating', () => {
  const { container } = render(<ImpersonationBanner />)
  expect(container).toBeEmptyDOMElement()
})

it('shows the target email and stops on click', async () => {
  setImpersonation({ id: 'u1', email: 'cible@test.fr' })
  // jsdom's Response constructor rejects a 204 body; a minimal stub matches what api.delete reads.
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 204, text: () => Promise.resolve('') }))
  const assign = vi.fn()
  vi.stubGlobal('location', { assign, reload: vi.fn() } as any)
  localStorage.setItem('palimora_token', 'tok')

  render(<ImpersonationBanner />)
  expect(screen.getByText(/cible@test\.fr/)).toBeInTheDocument()

  await userEvent.click(screen.getByRole('button', { name: /arrêter/i }))
  expect(fetch).toHaveBeenCalledWith(
    '/api/admin/impersonate?user_id=u1',
    expect.objectContaining({ method: 'DELETE' }),
  )
  expect(localStorage.getItem('palimora_impersonate')).toBeNull()
  expect(assign).toHaveBeenCalledWith('/admin')
})

it('clears impersonation and navigates even if DELETE fails', async () => {
  setImpersonation({ id: 'u1', email: 'cible@test.fr' })
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network')))
  const assign = vi.fn()
  vi.stubGlobal('location', { assign, reload: vi.fn() } as any)
  localStorage.setItem('palimora_token', 'tok')
  render(<ImpersonationBanner />)
  await userEvent.click(screen.getByRole('button', { name: /arrêter/i }))
  expect(localStorage.getItem('palimora_impersonate')).toBeNull()
  expect(assign).toHaveBeenCalledWith('/admin')
})
