import { beforeEach, expect, it, vi } from 'vitest'
import { api, setToken } from './api'

beforeEach(() => { localStorage.clear(); setToken('tok'); vi.restoreAllMocks() })

it('api.put issues a PUT with a JSON body', async () => {
  const fetchMock = vi.fn().mockResolvedValue(
    new Response(JSON.stringify({ active_key: 'rapide' }), { status: 200 }))
  vi.stubGlobal('fetch', fetchMock)
  const out = await api.put('/api/admin/ocr/model', { key: 'rapide' })
  expect(out).toEqual({ active_key: 'rapide' })
  const [, opts] = fetchMock.mock.calls[0]
  expect(opts.method).toBe('PUT')
  expect(JSON.parse(opts.body)).toEqual({ key: 'rapide' })
  expect(opts.headers['Content-Type']).toBe('application/json')
})
