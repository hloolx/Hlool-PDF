import { deleteJSON, getJSON, patchJSON, postJSON, putJSON } from '../../lib/api'
import type { AuthConfig } from '../../lib/types'

export type AdminSettings = AuthConfig

export type RegistrationInvite = {
  id: number
  code?: string
  codeHint: string
  name: string
  maxUses: number
  usedCount: number
  expiresAt?: string
  disabled: boolean
  createdAt: string
  usedAt?: string
  status: 'active' | 'used' | 'disabled' | 'expired'
}

export function getAdminSettings() {
  return getJSON<AdminSettings>('/api/admin/settings')
}

export function saveAdminSettings(settings: AdminSettings) {
  return putJSON<AdminSettings>('/api/admin/settings', settings)
}

export function listInvites() {
  return getJSON<RegistrationInvite[]>('/api/admin/invites')
}

export function createInvites(input: { name: string; count: number; maxUses: number; expiresInDays: number }) {
  return postJSON<RegistrationInvite[]>('/api/admin/invites', input)
}

export function setInviteDisabled(id: number, disabled: boolean) {
  return patchJSON<{ status: string }>(`/api/admin/invites/${id}`, { disabled })
}

export function deleteInvite(id: number) {
  return deleteJSON(`/api/admin/invites/${id}`)
}
