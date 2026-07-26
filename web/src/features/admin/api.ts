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

export type AdminUser = {
  id: string
  username: string
  isGuest: boolean
  isAdmin: boolean
  createdAt: string
  stampCount: number
  libraryBytes: number
}

export function listUsers() {
  return getJSON<AdminUser[]>('/api/admin/users')
}

/** 重置密码同时吊销该用户全部会话。 */
export function resetUserPassword(id: string, password: string) {
  return postJSON<{ status: string }>(`/api/admin/users/${id}/reset-password`, { password })
}

/** 删除用户：账号 + 印章库一起焚毁。 */
export function deleteUser(id: string) {
  return deleteJSON(`/api/admin/users/${id}`)
}

/** 清理游客：all=false 只清过期（约 24h），all=true 连活跃游客一起。 */
export function cleanupGuests(all: boolean) {
  return postJSON<{ burned: number; failed: number }>('/api/admin/users/cleanup-guests', { all })
}
