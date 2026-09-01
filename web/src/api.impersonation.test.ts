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

  it('returns null on malformed JSON', () => {
    localStorage.setItem('palimora_impersonate', 'not-valid-json')
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
  it('clears only the impersonation key on a bad-target 404, keeps token', async () => {
    setImpersonation({ id: 'bad', email: 'x@test.fr' })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ detail: 'Utilisateur à impersoner introuvable' }), { status: 404 })))
    const reload = vi.fn()
    vi.stubGlobal('location', { reload } as any)

    await api.get('/api/documents').catch(() => {})
    expect(getImpersonation()).toBeNull()
    expect(localStorage.getItem('palimora_token')).toBe('tok')
    expect(reload).toHaveBeenCalled()
  })

  it('clears impersonation when detail contains "impersonation", keeps token', async () => {
    setImpersonation({ id: 'bad', email: 'x@test.fr' })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ detail: 'Impersonation réservée aux administrateurs' }), { status: 403 })))
    const reload = vi.fn()
    vi.stubGlobal('location', { reload } as any)
    await api.get('/api/documents').catch(() => {})
    expect(getImpersonation()).toBeNull()
    expect(localStorage.getItem('palimora_token')).toBe('tok')
    expect(reload).toHaveBeenCalled()
  })

  it('keeps impersonation on an unrelated 404 (deleted document)', async () => {
    setImpersonation({ id: 'u1', email: 'u@test.fr' })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ detail: 'Document introuvable' }), { status: 404 })))
    const reload = vi.fn()
    vi.stubGlobal('location', { reload } as any)
    await api.get('/api/documents/x').catch(() => {})
    expect(getImpersonation()).toEqual({ id: 'u1', email: 'u@test.fr' })
    expect(reload).not.toHaveBeenCalled()
  })
})

describe('401 during impersonation', () => {
  it('clears token + impersonation and redirects to /login', async () => {
    setImpersonation({ id: 'u1', email: 'u@test.fr' })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ detail: 'Jeton invalide ou expiré' }), { status: 401 })))
    const loc = { href: '' } as any
    vi.stubGlobal('location', loc)
    await api.get('/api/documents').catch(() => {})
    expect(getImpersonation()).toBeNull()
    expect(localStorage.getItem('palimora_token')).toBeNull()
    expect(loc.href).toBe('/login')
  })
})
