import { beforeEach, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import Admin from './Admin'

const navigate = vi.fn()
vi.mock('react-router-dom', async (orig) => ({ ...(await orig<any>()), useNavigate: () => navigate }))

const ocrData = {
  models: [
    { key: 'défaut', seg_path: '/m/s', rec_path: '/m/r' },
    { key: 'rapide', seg_path: '/m/s', rec_path: '/m/rf' },
  ],
  active_key: 'défaut', active_source: 'env_default',
  recent: [{
    page_id: 'p1', document_id: 'd1', document_title: 'Doc A', processing_status: 'done',
    duration_s: 92.4, per_page_s: 92.4, model_key: 'défaut', avg_confidence: 0.71,
    submitted_at: '2026-09-02T10:00:00Z',
  }],
  aggregates: [
    { model_key: 'défaut', pages: 10, errors: 0, median_s: 90, p95_s: 140, avg_confidence: 0.7 },
    { model_key: 'rapide', pages: 4, errors: 2, median_s: 30, p95_s: 45, avg_confidence: 0.65 },
  ],
}

beforeEach(() => {
  localStorage.clear(); localStorage.setItem('palimora_token', 'tok'); navigate.mockClear()
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.endsWith('/api/auth/me')) return new Response(JSON.stringify({ is_admin: true }), { status: 200 })
    if (url.endsWith('/api/admin/users')) return new Response(JSON.stringify({ users: [] }), { status: 200 })
    if (url.endsWith('/api/admin/stats')) return new Response(JSON.stringify({ users: 0, documents: 0, pages_done: 0, pages_error: 0, pages_total: 0, credits_in_circulation: 0 }), { status: 200 })
    if (url.includes('/api/admin/audit')) return new Response(JSON.stringify({ rows: [] }), { status: 200 })
    if (url.endsWith('/api/admin/ocr')) return new Response(JSON.stringify(ocrData), { status: 200 })
    if (url.endsWith('/api/admin/ocr/model')) return new Response(JSON.stringify({ active_key: 'rapide' }), { status: 200 })
    return new Response('{}', { status: 200 })
  }))
})

it('renders the model selector, aggregates and recent tables', async () => {
  render(<MemoryRouter><Admin /></MemoryRouter>)
  expect(await screen.findByText(/OCR \/ Modèles/i)).toBeInTheDocument()
  await waitFor(() => expect(screen.getByRole('combobox')).toHaveValue('défaut'))
  expect(screen.getByText('Doc A')).toBeInTheDocument()
  expect(screen.getByText(/env_default/)).toBeInTheDocument()
  expect(screen.getAllByText('rapide').length).toBeGreaterThan(0)
})

it('saving a new model calls PUT', async () => {
  render(<MemoryRouter><Admin /></MemoryRouter>)
  await screen.findByRole('combobox')
  await userEvent.selectOptions(screen.getByRole('combobox'), 'rapide')
  await userEvent.click(screen.getByRole('button', { name: /enregistrer/i }))
  await waitFor(() => {
    const putCall = (fetch as any).mock.calls.find((c: any[]) => c[0].endsWith('/api/admin/ocr/model'))
    expect(putCall).toBeTruthy()
    expect(putCall[1].method).toBe('PUT')
  })
})

it('disables the button while the PUT is in flight (single PUT on double-click)', async () => {
  let release: () => void = () => {}
  ;(fetch as any).mockImplementation(async (url: string) => {
    if (url.endsWith('/api/admin/ocr/model')) {
      await new Promise<void>((res) => { release = res })
      return new Response(JSON.stringify({ active_key: 'rapide' }), { status: 200 })
    }
    if (url.endsWith('/api/auth/me')) return new Response(JSON.stringify({ is_admin: true }), { status: 200 })
    if (url.endsWith('/api/admin/users')) return new Response(JSON.stringify({ users: [] }), { status: 200 })
    if (url.endsWith('/api/admin/stats')) return new Response(JSON.stringify({ users: 0, documents: 0, pages_done: 0, pages_error: 0, pages_total: 0, credits_in_circulation: 0 }), { status: 200 })
    if (url.includes('/api/admin/audit')) return new Response(JSON.stringify({ rows: [] }), { status: 200 })
    if (url.endsWith('/api/admin/ocr')) return new Response(JSON.stringify(ocrData), { status: 200 })
    return new Response('{}', { status: 200 })
  })
  render(<MemoryRouter><Admin /></MemoryRouter>)
  await screen.findByRole('combobox')
  await userEvent.selectOptions(screen.getByRole('combobox'), 'rapide')
  const btn = screen.getByRole('button', { name: /enregistrer/i })
  await userEvent.click(btn)
  expect(btn).toBeDisabled()
  await userEvent.click(btn)
  release()
  await waitFor(() => expect(btn).not.toBeDisabled())
  const putCalls = (fetch as any).mock.calls.filter((c: any[]) => c[0].endsWith('/api/admin/ocr/model'))
  expect(putCalls.length).toBe(1)
})

it('shows a disabled placeholder selector when the active model is a fallback', async () => {
  ;(fetch as any).mockImplementation(async (url: string) => {
    if (url.endsWith('/api/admin/ocr')) return new Response(JSON.stringify({ ...ocrData, active_key: 'défaut', active_source: 'fallback', models: [{ key: 'rapide', seg_path: '/m/s', rec_path: '/m/rf' }] }), { status: 200 })
    if (url.endsWith('/api/auth/me')) return new Response(JSON.stringify({ is_admin: true }), { status: 200 })
    if (url.endsWith('/api/admin/users')) return new Response(JSON.stringify({ users: [] }), { status: 200 })
    if (url.endsWith('/api/admin/stats')) return new Response(JSON.stringify({ users: 0, documents: 0, pages_done: 0, pages_error: 0, pages_total: 0, credits_in_circulation: 0 }), { status: 200 })
    if (url.includes('/api/admin/audit')) return new Response(JSON.stringify({ rows: [] }), { status: 200 })
    return new Response('{}', { status: 200 })
  })
  render(<MemoryRouter><Admin /></MemoryRouter>)
  await screen.findByRole('combobox')
  expect(screen.getByRole('combobox')).toHaveValue('')
  expect(screen.getByRole('button', { name: /enregistrer/i })).toBeDisabled()
})

it('still renders the console when /api/admin/ocr errors', async () => {
  ;(fetch as any).mockImplementation(async (url: string) => {
    if (url.endsWith('/api/admin/ocr')) return new Response('boom', { status: 500 })
    if (url.endsWith('/api/auth/me')) return new Response(JSON.stringify({ is_admin: true }), { status: 200 })
    if (url.endsWith('/api/admin/users')) return new Response(JSON.stringify({ users: [{ id: 'u1', email: 'x@y.fr', display_name: 'X', credit_balance: 0, is_admin: false, is_active: true, created_at: '' }] }), { status: 200 })
    if (url.endsWith('/api/admin/stats')) return new Response(JSON.stringify({ users: 3, documents: 0, pages_done: 0, pages_error: 0, pages_total: 0, credits_in_circulation: 0 }), { status: 200 })
    if (url.includes('/api/admin/audit')) return new Response(JSON.stringify({ rows: [] }), { status: 200 })
    return new Response('{}', { status: 200 })
  })
  render(<MemoryRouter><Admin /></MemoryRouter>)
  expect(await screen.findByText('x@y.fr')).toBeInTheDocument()
  expect(screen.getByText(/Journal d'impersonation/i)).toBeInTheDocument()
  expect(screen.queryByText(/OCR \/ Modèles/i)).toBeNull()
})

it('shows a message and no selector when no models configured', async () => {
  ;(fetch as any).mockImplementation(async (url: string) => {
    if (url.endsWith('/api/admin/ocr')) return new Response(JSON.stringify({ ...ocrData, models: [] }), { status: 200 })
    if (url.endsWith('/api/auth/me')) return new Response(JSON.stringify({ is_admin: true }), { status: 200 })
    if (url.endsWith('/api/admin/users')) return new Response(JSON.stringify({ users: [] }), { status: 200 })
    if (url.endsWith('/api/admin/stats')) return new Response(JSON.stringify({ users: 0, documents: 0, pages_done: 0, pages_error: 0, pages_total: 0, credits_in_circulation: 0 }), { status: 200 })
    if (url.includes('/api/admin/audit')) return new Response(JSON.stringify({ rows: [] }), { status: 200 })
    return new Response('{}', { status: 200 })
  })
  render(<MemoryRouter><Admin /></MemoryRouter>)
  expect(await screen.findByText(/Aucun modèle alternatif configuré/i)).toBeInTheDocument()
  expect(screen.queryByRole('combobox')).toBeNull()
})
