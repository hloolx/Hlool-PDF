import { ApiError, getJSON, putJSON } from '../../lib/api'
import type { LibrarySettings } from '../../lib/types'
import { librarySettings, useEditorStore } from '../../state/store'

type SettingsResponse = { version: number; data?: LibrarySettings | null }

let lastSynced = ''
let timer: number | undefined
let started = false

/** 拉取服务端库设置并注入 store（覆盖本地缓存）。 */
export async function loadSettings(): Promise<void> {
  const res = await getJSON<SettingsResponse>('/api/settings')
  useEditorStore.getState().hydrateSettings((res.data ?? {}) as LibrarySettings, res.version)
  lastSynced = JSON.stringify(librarySettings(useEditorStore.getState()))
}

/** 订阅库设置变更，防抖推送到服务端（带版本乐观并发，冲突时本地覆盖重试一次）。 */
export function startSettingsSync(): void {
  if (started) return
  started = true
  useEditorStore.subscribe(() => {
    const snapshot = JSON.stringify(librarySettings(useEditorStore.getState()))
    if (snapshot === lastSynced) return
    window.clearTimeout(timer)
    timer = window.setTimeout(() => void flush(snapshot), 600)
  })
}

async function flush(snapshot: string): Promise<void> {
  const version = useEditorStore.getState().settingsVersion
  try {
    const res = await putJSON<SettingsResponse>('/api/settings', { version, data: JSON.parse(snapshot) })
    useEditorStore.getState().setSettingsVersion(res.version)
    lastSynced = snapshot
  } catch (err) {
    if (err instanceof ApiError && err.status === 409) {
      try {
        const current = await getJSON<SettingsResponse>('/api/settings')
        const res = await putJSON<SettingsResponse>('/api/settings', { version: current.version, data: JSON.parse(snapshot) })
        useEditorStore.getState().setSettingsVersion(res.version)
        lastSynced = snapshot
      } catch {
        /* 留待下次变更再试 */
      }
    }
    /* 其他错误静默：下次变更重试 */
  }
}

/** 注销时调用，丢弃同步基线。 */
export function resetSettingsSync(): void {
  lastSynced = ''
  window.clearTimeout(timer)
}
