const TOKEN_KEY = 'palimora_token'

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY)
}

export function setToken(token: string | null) {
  if (token) localStorage.setItem(TOKEN_KEY, token)
  else localStorage.removeItem(TOKEN_KEY)
}

const IMPERSONATE_KEY = 'palimora_impersonate'

export function getImpersonation(): { id: string; email: string } | null {
  const raw = localStorage.getItem(IMPERSONATE_KEY)
  if (!raw) return null
  try {
    const v = JSON.parse(raw)
    return (v && typeof v === 'object' && typeof v.id === 'string') ? v : null
  } catch {
    return null
  }
}

export function setImpersonation(v: { id: string; email: string } | null) {
  if (v) localStorage.setItem(IMPERSONATE_KEY, JSON.stringify(v))
  else localStorage.removeItem(IMPERSONATE_KEY)
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
  const impersonation = getImpersonation()
  if (impersonation) headers['X-Impersonate'] = impersonation.id
  let body: BodyInit | undefined
  if (options.body !== undefined && typeof options.body !== 'string' && !(options.body instanceof Blob)) {
    headers['Content-Type'] = 'application/json'
    body = JSON.stringify(options.body)
  } else if (options.body !== undefined) {
    body = options.body as BodyInit
  }
  const resp = await fetch(path, { ...options, headers, body })
  if (resp.status === 401 && !path.includes('/auth/')) {
    // A bad impersonation target never yields 401 (it is 403/404), so a genuine
    // 401 here means the admin's own token expired: drop everything and re-login.
    setImpersonation(null)
    setToken(null)
    window.location.href = '/login'
    throw new ApiError(401, 'Session expirée')
  }
  const text = await resp.text()
  const data = text ? JSON.parse(text) : null
  if (!resp.ok) {
    const detail: string = data?.detail || ''
    if (getImpersonation() && /imperson/i.test(detail)) {
      setImpersonation(null)
      window.location.reload()
    }
    throw new ApiError(resp.status, detail || `Erreur ${resp.status}`)
  }
  return data as T
}

export interface BillingApi {
  catalogue(): Promise<BillingCatalogue>
  status(): Promise<BillingStatus>
  intent(packId: string): Promise<{ client_secret: string; amount: number; currency: string }>
  subscribe(planId: string): Promise<{ client_secret: string; subscription_id: string }>
  cancel(): Promise<{ status: string }>
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'POST', body: body !== undefined ? body : {} }),
  patch: <T>(path: string, body: unknown) => request<T>(path, { method: 'PATCH', body }),
  put: <T>(path: string, body: unknown) => request<T>(path, { method: 'PUT', body }),
  delete: <T>(path: string) => request<T>(path, { method: 'DELETE' }),
  billing: {
    catalogue: () => request<BillingCatalogue>('/api/billing/catalogue'),
    status: () => request<BillingStatus>('/api/billing/status'),
    intent: (packId: string) =>
      request<{ client_secret: string; amount: number; currency: string }>(
        '/api/billing/intent', { method: 'POST', body: { pack_id: packId } }),
    subscribe: (planId: string) =>
      request<{ client_secret: string; subscription_id: string }>(
        '/api/billing/subscribe', { method: 'POST', body: { plan_id: planId } }),
    cancel: () =>
      request<{ status: string }>('/api/billing/cancel', { method: 'POST', body: {} }),
  } as BillingApi,
}

export interface BillingPack {
  id: string
  kind: 'one_shot' | 'subscription'
  credits: number
  amount_eur: number
  price_per_page: number
  label: string
  stripe_price_id: string
  interval?: 'month'
}

export interface BillingCatalogue {
  packs: BillingPack[]
  publishable_key: string
  enabled: boolean
}

export interface BillingSubscription {
  plan_id: string
  status: string
  current_period_end: string | null
  cancel_at_period_end: boolean
}

export interface BillingStatus {
  credit_balance: number
  subscription: BillingSubscription | null
  purchases: { reason: string; delta: number; created_at: string | null; note: string }[]
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
  tags: string[]
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

export interface OcrModel { key: string; seg_path: string; rec_path: string }
export interface OcrRecentRow {
  page_id: string; document_id: string; document_title: string
  processing_status: string
  duration_s: number | null; per_page_s: number | null
  model_key: string; avg_confidence: number | null; submitted_at: string | null
}
export interface OcrAggregate {
  model_key: string; pages: number
  median_s: number | null; p95_s: number | null; avg_confidence: number | null
}
export interface OcrPanelData {
  models: OcrModel[]
  active_key: string
  active_source: 'setting' | 'env_default' | 'fallback'
  recent: OcrRecentRow[]
  aggregates: OcrAggregate[]
}
