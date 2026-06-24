import { ApiError, errorText, getJSON } from '../../lib/api'
import type { StampAsset } from '../../lib/types'
import { useEditorStore } from '../../state/store'
import { toast } from '../../state/toasts'
import { requireReauth } from '../auth/useAuth'
import { loadSettings, startSettingsSync } from '../library/settings'

/**
 * 启动引导（登录后）：拉取印章库与设置，开启设置同步。文件为内存态，初始为空。
 *
 * 单独成模块（不依赖 pdfDoc/pdfjs）：App 与 AuthScreen 仅需此函数即可引导会话，
 * 因此重达 ~120kB(gz) 的 pdfjs 不会被拉入认证前的入口包，只随工作区分包按需加载。
 */
export async function bootWorkspace(): Promise<void> {
  try {
    const [stamps] = await Promise.all([getJSON<StampAsset[]>('/api/stamps'), loadSettings()])
    const list = stamps ?? []
    useEditorStore.getState().setStamps(list)
    useEditorStore.getState().pruneStampMeta(list.map((s) => s.stampId))
    startSettingsSync()
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) {
      requireReauth()
      return
    }
    toast(errorText(err), { kind: 'error' })
  }
}
