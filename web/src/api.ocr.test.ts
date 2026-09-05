import { beforeEach, expect, it, vi } from 'vitest'
import { api, setToken } from './api'
import type { CatalogResponse, LocalModel, ModelJob, OcrPanelData } from './api'

beforeEach(() => { localStorage.clear(); setToken('tok'); vi.restoreAllMocks() })

it('api.put issues a PUT with a JSON body', async () => {
  const fetchMock = vi.fn().mockResolvedValue(
    new Response(JSON.stringify({ active_key: 'rec-21788409' }), { status: 200 }))
  vi.stubGlobal('fetch', fetchMock)
  const out = await api.put('/api/admin/ocr/model', { key: 'rec-21788409' })
  expect(out).toEqual({ active_key: 'rec-21788409' })
  const [, opts] = fetchMock.mock.calls[0]
  expect(opts.method).toBe('PUT')
  expect(JSON.parse(opts.body)).toEqual({ key: 'rec-21788409' })
  expect(opts.headers['Content-Type']).toBe('application/json')
})

it('api.delete issues a DELETE with no body', async () => {
  const fetchMock = vi.fn().mockResolvedValue(
    new Response(JSON.stringify({ deleted: 'rec-21788409' }), { status: 200 }))
  vi.stubGlobal('fetch', fetchMock)
  const out = await api.delete('/api/admin/ocr/models/rec-21788409')
  expect(out).toEqual({ deleted: 'rec-21788409' })
  const [url, opts] = fetchMock.mock.calls[0]
  expect(url).toBe('/api/admin/ocr/models/rec-21788409')
  expect(opts.method).toBe('DELETE')
  expect(opts.body).toBeUndefined()
})

it('api.get on the catalogue keeps the query string', async () => {
  const fetchMock = vi.fn().mockResolvedValue(
    new Response(JSON.stringify({ cached_at: null, stale: true, refreshing: false, models: [] }),
      { status: 200 }))
  vi.stubGlobal('fetch', fetchMock)
  const out = await api.get<CatalogResponse>('/api/admin/ocr/catalog?script=Grek&all=false')
  expect(out.stale).toBe(true)
  expect(fetchMock.mock.calls[0][0]).toBe('/api/admin/ocr/catalog?script=Grek&all=false')
})

it('a relayed 409 surfaces the Kraken detail', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
    new Response(JSON.stringify({ detail: 'Modèle déjà présent' }), { status: 409 })))
  await expect(api.post('/api/admin/ocr/models', { doi: '10.5281/zenodo.1' }))
    .rejects.toThrow('Modèle déjà présent')
})

it('the E3-B panel types compile against a realistic payload', () => {
  const model: LocalModel = {
    slug: 'rec-21788409', protected: false, doi: '10.5281/zenodo.21788409',
    summary: 'French 18C', script: 'Latn', keywords: ['french'],
    license: 'CC-BY-4.0', size_bytes: 128,
  }
  const job: ModelJob = {
    kind: 'pull', job_id: 'j1', status: 'finished',
    doi: '10.5281/zenodo.21788409', slug: 'rec-21788409', error: null, progress: 100,
  }
  const panel: OcrPanelData = {
    local_models: [model], active_key: 'rec-21788409', active_slug: 'rec-21788409',
    active_source: 'setting', kraken_error: null, recent: [], aggregates: [],
  }
  expect(panel.local_models[0].slug).toBe(job.slug)
})
