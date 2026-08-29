const TOKEN_KEY = 'palimora_token'

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY)
}

export function setToken(token: string | null) {
  if (token) localStorage.setItem(TOKEN_KEY, token)
  else localStorage.removeItem(TOKEN_KEY)
}

export class ApiError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

async function request<T>(path: string, options: Omit<RequestInit, 'body'> & { body?: unknown } = {}): Promise<T> {
  const token = getToken()
  const headers: Record<string, string> = { ...(options.headers as any) }
  if (token) headers['Authorization'] = `Bearer ${token}`
  let body: BodyInit | undefined
  if (options.body !== undefined && typeof options.body !== 'string' && !(options.body instanceof Blob)) {
    headers['Content-Type'] = 'application/json'
    body = JSON.stringify(options.body)
  } else if (options.body !== undefined) {
    body = options.body as BodyInit
  }
  const resp = await fetch(path, { ...options, headers, body })
  if (resp.status === 401 && !path.includes('/auth/')) {
    setToken(null)
    window.location.href = '/login'
    throw new ApiError(401, 'Session expirée')
  }
  const text = await resp.text()
  const data = text ? JSON.parse(text) : null
  if (!resp.ok) {
    throw new ApiError(resp.status, data?.detail || `Erreur ${resp.status}`)
  }
  return data as T
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'POST', body: body !== undefined ? body : {} }),
  patch: <T>(path: string, body: unknown) => request<T>(path, { method: 'PATCH', body }),
  delete: <T>(path: string) => request<T>(path, { method: 'DELETE' }),
}

export interface Me {
  id: string
  email: string
  display_name: string
  is_admin: boolean
  credit_balance: number
  email_verified: boolean
}

export interface QueueItem {
  id: string
  title: string
  status: string
  pages: number
  done: number
  error: number
  validated: number
  updated_at: string
}

export interface PageSummary {
  id: string
  document_id: string
  page_number: number
  content_type: string
  processing_status: string
  validation_status: string
  error: string
}

export interface Segment {
  id: string
  reading_order: number
  source_text: string
  edited_text: string
  confidence: number
  bbox: any
  is_uncertain: boolean
  is_validated: boolean
}

export interface Suggestion {
  id: string
  original_text: string
  suggested_text: string
  explanation: string
  confidence: number
  status: string
}

export interface PageDetail extends PageSummary {
  image_url: string
  transcription: { id: string; raw_htr_text: string; edited_text: string; confidence: number; version: number } | null
  segments: Segment[]
  suggestions: Suggestion[]
}
