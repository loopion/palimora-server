import { beforeEach, describe, expect, it, vi } from 'vitest'
import { api, getImpersonation, setImpersonation, setToken } from './api'

beforeEach(() => {
  localStorage.clear()
  setToken('tok')
  vi.restoreAllMocks()
})

describe('impersonation storage', () => {
  it('round-trips', () => {
    expect(getImpersonation()).toBeNull()
    setImpersonation({ id: 'u1', email: 'u@test.fr' })
    expect(getImpersonation()).toEqual({ id: 'u1', email: 'u@test.fr' })
    setImpersonation(null)
    expect(getImpersonation()).toBeNull()
  })
})

describe('X-Impersonate header', () => {
  it('is sent when a target is set, absent otherwise', async () => {
    const fetchMock = vi.fn().mockImplementation(
      () => Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 })))
    vi.stubGlobal('fetch', fetchMock)

    await api.get('/api/documents')
    expect(fetchMock.mock.calls[0][1].headers['X-Impersonate']).toBeUndefined()

    setImpersonation({ id: 'u1', email: 'u@test.fr' })
    await api.get('/api/documents')
    expect(fetchMock.mock.calls[1][1].headers['X-Impersonate']).toBe('u1')
  })
})

describe('bad impersonation target', () => {
  it('clears only the impersonation key on 404, keeps token', async () => {
    setImpersonation({ id: 'bad', email: 'x@test.fr' })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ detail: 'Utilisateur introuvable' }), { status: 404 })))
    const reload = vi.fn()
    vi.stubGlobal('location', { reload } as any)

    await api.get('/api/documents').catch(() => {})
    expect(getImpersonation()).toBeNull()
    expect(localStorage.getItem('palimora_token')).toBe('tok')
    expect(reload).toHaveBeenCalled()
  })
})
