import { afterEach, expect, test, vi } from 'vitest'
import { api } from './api'

afterEach(() => vi.restoreAllMocks())

test('billing.catalogue calls the endpoint', async () => {
  const body = { packs: [], publishable_key: 'pk_test', enabled: true }
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })))
  const cat = await api.billing.catalogue()
  expect(cat.publishable_key).toBe('pk_test')
})

test('billing.intent posts pack_id', async () => {
  const spy = vi.fn(async () => new Response(JSON.stringify(
    { client_secret: 'cs', amount: 2900, currency: 'eur' }), { status: 200 }))
  vi.stubGlobal('fetch', spy)
  const r = await api.billing.intent('starter')
  expect(r.client_secret).toBe('cs')
  expect(JSON.parse((spy.mock.calls[0][1] as any).body)).toEqual({ pack_id: 'starter' })
})
