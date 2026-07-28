import type { ApiResponse, BootstrapState } from './contracts'

export class ApiError extends Error {
  code: string
  fields?: Record<string, string>

  constructor(message: string, code = 'REQUEST_FAILED', fields?: Record<string, string>) {
    super(message)
    this.name = 'ApiError'
    this.code = code
    this.fields = fields
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers)
  if (init.body && !(init.body instanceof FormData)) headers.set('Content-Type', 'application/json')

  const response = await fetch(path, {
    ...init,
    headers,
    credentials: 'include',
  })

  let payload: ApiResponse<T> | undefined
  try {
    payload = await response.json() as ApiResponse<T>
  } catch {
    throw new ApiError(response.ok ? '服务返回了无法识别的数据' : `请求失败（${response.status}）`, 'INVALID_RESPONSE')
  }

  if (!response.ok || !payload.ok) {
    throw new ApiError(payload.error?.message ?? `请求失败（${response.status}）`, payload.error?.code, payload.error?.fields)
  }

  return payload.data as T
}

export function getBootstrap() {
  return request<BootstrapState>('/api/bootstrap')
}

export function login(username: string, password: string, remember: boolean) {
  return request<BootstrapState>('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ username, password, remember }),
  })
}

export function logout() {
  return request<unknown>('/api/auth/logout', { method: 'POST' })
}

export function performAction<T = unknown>(type: string, payload: Record<string, unknown> = {}) {
  return request<T>('/api/action', {
    method: 'POST',
    body: JSON.stringify({ type, payload }),
  })
}

export interface PrototypeCapability {
  url: string
  expiresAt: string
}

export function issuePrototypeCapability(productId: string, version: string) {
  return request<PrototypeCapability>('/api/prototype-capability', {
    method: 'POST',
    body: JSON.stringify({ productId, version }),
  })
}

export interface ProductUploadPayload {
  mode: 'create' | 'update'
  productId?: string
  name: string
  manager: string
  description: string
  longNote: string
  ownerId: string
  accessCode: string
  accessCodeExpiresAt?: string | null
  versionNote: string
  file: File
}

export function uploadProduct(input: ProductUploadPayload) {
  const form = new FormData()
  form.append('mode', input.mode)
  if (input.productId) form.append('productId', input.productId)
  form.append('name', input.name)
  form.append('manager', input.manager)
  form.append('description', input.description)
  form.append('longNote', input.longNote)
  form.append('ownerId', input.ownerId)
  form.append('accessCode', input.accessCode)
  form.append('accessCodeExpiresAt', input.accessCodeExpiresAt ?? '')
  form.append('versionNote', input.versionNote)
  form.append('note', input.versionNote)
  form.append('file', input.file)
  return request<unknown>('/api/upload', { method: 'POST', body: form })
}
