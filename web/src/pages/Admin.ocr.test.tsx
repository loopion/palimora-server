import { beforeEach, expect, it, vi } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import Admin from './Admin'

const navigate = vi.fn()
vi.mock('react-router-dom', async (orig) => ({ ...(await orig<any>()), useNavigate: () => navigate }))

const localModels = [
  {
    slug: 'rec', protected: true, doi: null,
    summary: 'Modèle de reconnaissance baké par défaut', script: null,
    keywords: [], license: null, size_bytes: 4194304,
  },
  {
    slug: 'rec-21788409', protected: false, doi: '10.5281/zenodo.21788409',
    summary: 'French 18C cursive', script: 'Latn', keywords: ['french'],
    license: 'CC-BY-4.0', size_bytes: 1048576,
  },
]

const ocrData = {
  local_models: localModels,
  active_key: 'rec', active_slug: 'rec', active_source: 'fallback', kraken_error: null,
  recent: [{
    page_id: 'p1', document_id: 'd1', document_title: 'Doc A', processing_status: 'done',
    duration_s: 92.4, per_page_s: 92.4, model_key: 'rec', avg_confidence: 0.71,
    submitted_at: '2026-09-02T10:00:00Z',
  }],
  aggregates: [
    { model_key: 'rec', pages: 10, errors: 0, median_s: 90, p95_s: 140, avg_confidence: 0.7 },
    { model_key: 'rec-21788409', pages: 4, errors: 2, median_s: 30, p95_s: 45, avg_confidence: 0.65 },
  ],
}

const catalogData = {
  cached_at: '2026-09-05T08:00:00Z', stale: false, refreshing: false,
  models: [
    {
      doi: '10.5281/zenodo.999', summary: 'Latin medieval', script: 'Latn',
      keywords: ['latin', 'medieval'], license: 'CC-BY-4.0', already_local: false,
    },
    {
      doi: '10.5281/zenodo.21788409', summary: 'French 18C cursive', script: 'Latn',
      keywords: ['french'], license: 'CC-BY-4.0', already_local: true,
    },
  ],
}

/** Base router: every non-OCR admin call succeeds; `over` patches specific paths. */
function stubFetch(over: (url: string, opts: any) => Response | undefined = () => undefined) {
  vi.stubGlobal('fetch', vi.fn(async (url: string, opts: any) => {
    const patched = over(url, opts)
    if (patched) return patched
    if (url.endsWith('/api/auth/me')) return new Response(JSON.stringify({ is_admin: true }), { status: 200 })
    if (url.endsWith('/api/admin/users')) return new Response(JSON.stringify({ users: [] }), { status: 200 })
    if (url.endsWith('/api/admin/stats')) return new Response(JSON.stringify({ users: 0, documents: 0, pages_done: 0, pages_error: 0, pages_total: 0, credits_in_circulation: 0 }), { status: 200 })
    if (url.includes('/api/admin/audit')) return new Response(JSON.stringify({ rows: [] }), { status: 200 })
    if (url.endsWith('/api/admin/ocr')) return new Response(JSON.stringify(ocrData), { status: 200 })
    if (url.includes('/api/admin/ocr/catalog')) return new Response(JSON.stringify(catalogData), { status: 200 })
    if (url.endsWith('/api/admin/ocr/model')) return new Response(JSON.stringify({ active_key: 'rec-21788409' }), { status: 200 })
    return new Response('{}', { status: 200 })
  }))
}

const calls = () => (fetch as any).mock.calls as any[][]
const callTo = (pred: (u: string) => boolean, method?: string) =>
  calls().find((c) => pred(c[0]) && (!method || c[1]?.method === method))

beforeEach(() => {
  localStorage.clear(); localStorage.setItem('palimora_token', 'tok'); navigate.mockClear()
  stubFetch()
})

it('renders the three blocks with the live model list', async () => {
  render(<MemoryRouter><Admin /></MemoryRouter>)
  expect(await screen.findByText(/OCR \/ Modèles/i)).toBeInTheDocument()
  expect(screen.getByText(/Modèles téléchargés/i)).toBeInTheDocument()
  expect(screen.getByText(/Catalogue HTRMoPo/i)).toBeInTheDocument()
  await waitFor(() => expect(screen.getByRole('combobox', { name: /modèle actif/i })).toHaveValue('rec'))
  expect(screen.getByText('Doc A')).toBeInTheDocument()        // E2 recent table
  expect(screen.getByText(/fallback/)).toBeInTheDocument()     // source badge
  expect(screen.getByText('10.5281/zenodo.21788409')).toBeInTheDocument()
})

it('activating a model issues the PUT and refreshes', async () => {
  render(<MemoryRouter><Admin /></MemoryRouter>)
  const select = await screen.findByRole('combobox', { name: /modèle actif/i })
  await userEvent.selectOptions(select, 'rec-21788409')
  await userEvent.click(screen.getByRole('button', { name: /activer/i }))
  await waitFor(() => {
    const put = callTo((u) => u.endsWith('/api/admin/ocr/model'), 'PUT')
    expect(put).toBeTruthy()
    expect(JSON.parse(put![1].body)).toEqual({ key: 'rec-21788409' })
  })
})

it('disables delete for a protected model and for the active one', async () => {
  render(<MemoryRouter><Admin /></MemoryRouter>)
  await screen.findByText(/Modèles téléchargés/i)
  const recRow = screen.getByTestId('local-model-rec')
  expect(within(recRow).getByRole('button', { name: /supprimer/i })).toBeDisabled()
  const pulledRow = screen.getByTestId('local-model-rec-21788409')
  expect(within(pulledRow).getByRole('button', { name: /supprimer/i })).toBeEnabled()
})

it('the active model cannot be deleted from the UI', async () => {
  stubFetch((url) => url.endsWith('/api/admin/ocr')
    ? new Response(JSON.stringify({ ...ocrData, active_key: 'rec-21788409', active_slug: 'rec-21788409', active_source: 'setting' }), { status: 200 })
    : undefined)
  render(<MemoryRouter><Admin /></MemoryRouter>)
  await screen.findByText(/Modèles téléchargés/i)
  const row = screen.getByTestId('local-model-rec-21788409')
  expect(within(row).getByRole('button', { name: /supprimer/i })).toBeDisabled()
})

it('deleting goes through a confirm dialog, not window.confirm', async () => {
  const confirmSpy = vi.spyOn(window, 'confirm')
  render(<MemoryRouter><Admin /></MemoryRouter>)
  await screen.findByText(/Modèles téléchargés/i)
  const row = screen.getByTestId('local-model-rec-21788409')
  await userEvent.click(within(row).getByRole('button', { name: /supprimer/i }))
  const dialog = await screen.findByRole('dialog')
  expect(within(dialog).getByText(/rec-21788409/)).toBeInTheDocument()
  expect(callTo((u) => u.includes('/api/admin/ocr/models/'), 'DELETE')).toBeFalsy()
  await userEvent.click(within(dialog).getByRole('button', { name: /confirmer/i }))
  await waitFor(() =>
    expect(callTo((u) => u.endsWith('/api/admin/ocr/models/rec-21788409'), 'DELETE')).toBeTruthy())
  expect(confirmSpy).not.toHaveBeenCalled()
})

it('a relayed delete 409 shows the Kraken detail', async () => {
  stubFetch((url, opts) => url.endsWith('/api/admin/ocr/models/rec-21788409') && opts?.method === 'DELETE'
    ? new Response(JSON.stringify({ detail: 'Modèle protégé' }), { status: 409 })
    : undefined)
  render(<MemoryRouter><Admin /></MemoryRouter>)
  await screen.findByText(/Modèles téléchargés/i)
  await userEvent.click(within(screen.getByTestId('local-model-rec-21788409'))
    .getByRole('button', { name: /supprimer/i }))
  await userEvent.click(within(await screen.findByRole('dialog'))
    .getByRole('button', { name: /confirmer/i }))
  expect(await screen.findByText(/Modèle protégé/)).toBeInTheDocument()
})

it('the catalogue is lazy: no fetch until it is expanded', async () => {
  render(<MemoryRouter><Admin /></MemoryRouter>)
  await screen.findByText(/Catalogue HTRMoPo/i)
  expect(callTo((u) => u.includes('/api/admin/ocr/catalog'))).toBeFalsy()
  await userEvent.click(screen.getByRole('button', { name: /catalogue htrmopo/i }))
  await waitFor(() => {
    const get = callTo((u) => u.includes('/api/admin/ocr/catalog'))
    expect(get).toBeTruthy()
    expect(get![0]).toContain('script=Latn')
  })
  expect(await screen.findByText('Latin medieval')).toBeInTheDocument()
})

it('changing the script refetches the catalogue', async () => {
  render(<MemoryRouter><Admin /></MemoryRouter>)
  await userEvent.click(await screen.findByRole('button', { name: /catalogue htrmopo/i }))
  await screen.findByText('Latin medieval')
  await userEvent.selectOptions(screen.getByRole('combobox', { name: /écriture/i }), 'Grek')
  await waitFor(() =>
    expect(calls().some((c) => String(c[0]).includes('script=Grek'))).toBe(true))
})

it('pulling a model polls the job then refreshes the panel', async () => {
  stubFetch((url, opts) => {
    if (url.endsWith('/api/admin/ocr/models') && opts?.method === 'POST') {
      return new Response(JSON.stringify({ job_id: 'j-pull', slug: 'rec-999', status: 'started' }), { status: 202 })
    }
    if (url.endsWith('/api/admin/ocr/models/jobs/j-pull')) {
      return new Response(JSON.stringify({ kind: 'pull', job_id: 'j-pull', status: 'finished', slug: 'rec-999', error: null, progress: 100 }), { status: 200 })
    }
    return undefined
  })
  render(<MemoryRouter><Admin /></MemoryRouter>)
  await userEvent.click(await screen.findByRole('button', { name: /catalogue htrmopo/i }))
  const row = await screen.findByTestId('catalog-10.5281/zenodo.999')
  await userEvent.click(within(row).getByRole('button', { name: /télécharger/i }))
  await waitFor(() =>
    expect(callTo((u) => u.endsWith('/api/admin/ocr/models/jobs/j-pull'))).toBeTruthy())
  expect(await screen.findByText(/Modèle téléchargé/i)).toBeInTheDocument()
})

it('a failed pull job surfaces its error', async () => {
  stubFetch((url, opts) => {
    if (url.endsWith('/api/admin/ocr/models') && opts?.method === 'POST') {
      return new Response(JSON.stringify({ job_id: 'j-bad', slug: 'rec-999', status: 'started' }), { status: 202 })
    }
    if (url.endsWith('/api/admin/ocr/models/jobs/j-bad')) {
      return new Response(JSON.stringify({ kind: 'pull', job_id: 'j-bad', status: 'failed', error: 'pas un modèle de reconnaissance', progress: 0 }), { status: 200 })
    }
    return undefined
  })
  render(<MemoryRouter><Admin /></MemoryRouter>)
  await userEvent.click(await screen.findByRole('button', { name: /catalogue htrmopo/i }))
  const row = await screen.findByTestId('catalog-10.5281/zenodo.999')
  await userEvent.click(within(row).getByRole('button', { name: /télécharger/i }))
  expect(await screen.findByText(/pas un modèle de reconnaissance/)).toBeInTheDocument()
})

it('an already-local catalogue entry cannot be pulled', async () => {
  render(<MemoryRouter><Admin /></MemoryRouter>)
  await userEvent.click(await screen.findByRole('button', { name: /catalogue htrmopo/i }))
  const row = await screen.findByTestId('catalog-10.5281/zenodo.21788409')
  expect(within(row).getByRole('button', { name: /télécharger|déjà local/i })).toBeDisabled()
})

it('refreshing the catalogue polls the refresh job and refetches', async () => {
  stubFetch((url, opts) => {
    if (url.endsWith('/api/admin/ocr/catalog/refresh') && opts?.method === 'POST') {
      return new Response(JSON.stringify({ job_id: 'j-ref', status: 'started' }), { status: 202 })
    }
    if (url.endsWith('/api/admin/ocr/models/jobs/j-ref')) {
      return new Response(JSON.stringify({ kind: 'refresh', job_id: 'j-ref', status: 'finished', error: null }), { status: 200 })
    }
    return undefined
  })
  render(<MemoryRouter><Admin /></MemoryRouter>)
  await userEvent.click(await screen.findByRole('button', { name: /catalogue htrmopo/i }))
  await screen.findByText('Latin medieval')
  await userEvent.click(screen.getByRole('button', { name: /rafraîchir/i }))
  await waitFor(() =>
    expect(callTo((u) => u.endsWith('/api/admin/ocr/models/jobs/j-ref'))).toBeTruthy())
  expect(await screen.findByText(/Catalogue rafraîchi/i)).toBeInTheDocument()
})

it('a kraken_error renders a banner and still shows the aggregates', async () => {
  stubFetch((url) => url.endsWith('/api/admin/ocr')
    ? new Response(JSON.stringify({ ...ocrData, local_models: [], kraken_error: 'Service Kraken injoignable' }), { status: 200 })
    : undefined)
  render(<MemoryRouter><Admin /></MemoryRouter>)
  expect(await screen.findByText(/gestion des modèles indisponible/i)).toBeInTheDocument()
  expect(screen.getByText('Doc A')).toBeInTheDocument()
  expect(screen.getByText('140')).toBeInTheDocument()  // p95 from the aggregates table
})

it('still renders the console when /api/admin/ocr errors', async () => {
  stubFetch((url) => {
    if (url.endsWith('/api/admin/ocr')) return new Response('boom', { status: 500 })
    if (url.endsWith('/api/admin/users')) return new Response(JSON.stringify({ users: [{ id: 'u1', email: 'x@y.fr', display_name: 'X', credit_balance: 0, is_admin: false, is_active: true, created_at: '' }] }), { status: 200 })
    return undefined
  })
  render(<MemoryRouter><Admin /></MemoryRouter>)
  expect(await screen.findByText('x@y.fr')).toBeInTheDocument()
  expect(screen.queryByText(/OCR \/ Modèles/i)).toBeNull()
})
