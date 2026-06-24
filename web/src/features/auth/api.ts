import { ApiError, postJSON } from '../../lib/api'
import type { AuthUser } from '../../lib/types'

/** 当前登录用户；未登录返回 null（401）。 */
export async function fetchMe(): Promise<AuthUser | null> {
  const res = await fetch('/auth/me')
  if (res.status === 401) return null
  if (!res.ok) throw new ApiError('请求失败', res.status)
  return (await res.json()) as AuthUser
}

export function login(username: string, password: string) {
  return postJSON<AuthUser>('/auth/login', { username, password })
}

export function register(username: string, password: string) {
  return postJSON<AuthUser>('/auth/register', { username, password })
}

/** 申领临时身份（匿名会话）。后端禁用游客模式时抛 403。 */
export function createGuest() {
  return postJSON<AuthUser>('/auth/guest', {})
}

export async function logout(): Promise<void> {
  await postJSON('/auth/logout', {})
}
