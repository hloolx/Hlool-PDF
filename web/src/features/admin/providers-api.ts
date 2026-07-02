import { deleteJSON, getJSON, postJSON, putJSON } from '../../lib/api'
import type { Provider } from './types'

export type { Provider }

export function getProviders(): Promise<Provider[]> {
  return getJSON<Provider[]>('/api/admin/providers')
}

export function createProvider(provider: Partial<Provider>): Promise<{ id: string }> {
  return postJSON<{ id: string }>('/api/admin/providers/create', provider)
}

export function updateProvider(id: string, provider: Partial<Provider>): Promise<void> {
  return putJSON<{ status: string }>(`/api/admin/providers/${id}`, provider).then(() => undefined)
}

export function deleteProvider(id: string): Promise<void> {
  return deleteJSON(`/api/admin/providers/${id}`).then(() => undefined)
}

export function testProvider(id: string): Promise<{ success: boolean; error?: string }> {
  return postJSON<{ success: boolean; error?: string }>(`/api/admin/providers/${id}/test`, {})
}
