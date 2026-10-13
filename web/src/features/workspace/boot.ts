import { useEditorStore } from '../../state/store'
import { toast } from '../../state/toasts'
import { loadSettings, startSettingsSync } from '../library/settings'
import { listStamps, onLibraryChange } from '../library/storage'
import { startConfigVault } from './configVault'

let booting: Promise<void> | undefined
let listenForChanges = false

async function refreshStamps() {
  const stamps = await listStamps()
  const removed = useEditorStore.getState().stamps.filter((stamp) => !stamps.some((item) => item.stampId === stamp.stampId))
  // Clear placements that reference a stamp removed in another tab.
  if (removed.length) useEditorStore.getState().removeStamps(removed.map((stamp) => stamp.stampId))
  useEditorStore.getState().setStamps(stamps)
}

/** Open the device's library; rejection prevents unavailable storage from appearing as an empty library. */
export function bootWorkspace(): Promise<void> {
  if (booting) return booting
  booting = (async () => {
    await loadSettings()
    await refreshStamps()
    startConfigVault()
    startSettingsSync()
    if (!listenForChanges) {
      listenForChanges = true
      onLibraryChange((kind) => { if (kind !== 'settings') void refreshStamps().catch((error) => toast(error instanceof Error ? error.message : '本机印章库刷新失败，请重新打开页面。', { kind: 'error' })) })
    }
  })().finally(() => { booting = undefined })
  return booting
}
