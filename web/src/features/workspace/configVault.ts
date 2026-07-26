import { DEFAULT_SCAN, DEFAULT_SEAM, emptyConfig, type FileConfig, type PDFFile } from '../../lib/types'
import { hasConfig, useEditorStore } from '../../state/store'
import { toast } from '../../state/toasts'

/**
 * 配置防丢：把每个文件的盖章配置按文件指纹落到 localStorage，刷新 / 误关标签后
 * 重新导入同一个文件时自动恢复。只存配置（章位、骑缝、扫描参数），绝不存 PDF
 * 字节——阅后即焚的底线不动。
 */
const VAULT_KEY = 'hlool-pdf:file-configs-v1'
const MAX_ENTRIES = 60

type VaultEntry = { name: string; savedAt: number; config: FileConfig }
type Vault = Record<string, VaultEntry>

function readVault(): Vault {
  try {
    const raw = window.localStorage.getItem(VAULT_KEY)
    const parsed = raw ? (JSON.parse(raw) as Vault) : {}
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function writeVault(vault: Vault) {
  const entries = Object.entries(vault).sort((a, b) => (b[1]?.savedAt ?? 0) - (a[1]?.savedAt ?? 0))
  // 超配额时按最近使用截半重试，最后放弃（防丢是尽力而为，不能打断正常使用）。
  for (let keep = Math.min(entries.length, MAX_ENTRIES); keep >= 1; keep = Math.floor(keep / 2)) {
    try {
      window.localStorage.setItem(VAULT_KEY, JSON.stringify(Object.fromEntries(entries.slice(0, keep))))
      return
    } catch {
      /* retry with fewer entries */
    }
  }
}

function persistNow() {
  const state = useEditorStore.getState()
  const vault = readVault()
  let changed = false
  for (const file of state.files) {
    if (!file.fingerprint) continue
    const config = state.configs[file.fileId]
    if (config && hasConfig(config)) {
      vault[file.fingerprint] = { name: file.name, savedAt: Date.now(), config }
      changed = true
    } else if (vault[file.fingerprint]) {
      delete vault[file.fingerprint]
      changed = true
    }
  }
  if (changed) writeVault(vault)
}

let started = false

/** 启动配置落盘：配置变化防抖写入，页面卸载前补一次同步写。可重复调用。 */
export function startConfigVault() {
  if (started) return
  started = true
  let prevConfigs = useEditorStore.getState().configs
  let timer: number | undefined
  useEditorStore.subscribe((state) => {
    if (state.configs === prevConfigs) return
    prevConfigs = state.configs
    window.clearTimeout(timer)
    timer = window.setTimeout(persistNow, 500)
  })
  window.addEventListener('beforeunload', persistNow)
}

/** 恢复出来的配置要过一遍现实校验：印章可能已删、页数可能对不上。 */
function sanitizeRestored(saved: FileConfig, file: PDFFile, stampIds: Set<string>): FileConfig {
  const config = emptyConfig()
  config.placements = (saved.placements ?? []).filter(
    (p) =>
      p &&
      stampIds.has(p.stampId) &&
      Number.isInteger(p.pageNumber) &&
      p.pageNumber >= 1 &&
      p.pageNumber <= file.pageCount &&
      [p.xPt, p.yPt, p.widthPt, p.heightPt, p.rotation, p.opacity].every(Number.isFinite)
  )
  const seamStampId = saved.seam?.stampId && stampIds.has(saved.seam.stampId) ? saved.seam.stampId : null
  config.seam = { ...DEFAULT_SEAM, ...(saved.seam ?? {}), stampId: seamStampId }
  config.seamEnabled = Boolean(saved.seamEnabled && seamStampId)
  config.scanEnabled = Boolean(saved.scanEnabled)
  config.scanConfig = { ...DEFAULT_SCAN, ...(saved.scanConfig ?? {}) }
  return config
}

/** 对一批刚导入的文件尝试恢复上次配置，并 toast 告知（单文件可一键撤销）。 */
export function restoreConfigs(files: PDFFile[]) {
  let vault: Vault | null = null
  const state = useEditorStore.getState()
  const stampIds = new Set(state.stamps.map((s) => s.stampId))
  const restored: Array<{ file: PDFFile; config: FileConfig }> = []
  for (const file of files) {
    if (!file.fingerprint) continue
    vault ??= readVault()
    const entry = vault[file.fingerprint]
    if (!entry?.config) continue
    if (hasConfig(state.configs[file.fileId])) continue
    const config = sanitizeRestored(entry.config, file, stampIds)
    if (!hasConfig(config)) continue
    useEditorStore.getState().setConfig(file.fileId, config)
    restored.push({ file, config })
  }
  if (restored.length === 1) {
    const { file, config } = restored[0]
    const parts: string[] = []
    if (config.placements.length > 0) parts.push(`${config.placements.length} 个印章`)
    if (config.seamEnabled) parts.push('骑缝章')
    if (config.scanEnabled) parts.push('扫描效果')
    toast(`已恢复上次的${parts.join('、')}`, {
      kind: 'success',
      action: { label: '不要恢复', onClick: () => useEditorStore.getState().setConfig(file.fileId, emptyConfig()) }
    })
  } else if (restored.length > 1) {
    toast(`已恢复 ${restored.length} 个文件上次的盖章配置`, { kind: 'success' })
  }
}
