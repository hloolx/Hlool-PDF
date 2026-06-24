import { create } from 'zustand'
import { useStore } from 'zustand'
import { temporal } from 'zundo'
import {
  DEFAULT_SEAM,
  clamp,
  emptyConfig,
  type FileConfig,
  type LibrarySettings,
  type PDFFile,
  type Placement,
  type SeamConfig,
  type Selection,
  type StampAsset
} from '../lib/types'

export type ZoomPreset = 'fit' | '100' | '125' | '150' | 'custom'
export type StampDefaults = { sizeMm: number; opacity: number; rotation: number }
export type StampMeta = { alias?: string; sizeMm?: number }

export const MIN_ZOOM = 0.25
export const MAX_ZOOM = 3
export const MAX_PLACEMENTS_PER_JOB = 1000

// 侧栏停靠断点：窗口宽于此值时面板并排停靠，窄于时改为浮层抽屉。
export const LEFT_DOCK_BP = 820
export const RIGHT_DOCK_BP = 1024

// Device-local cache (instant boot). The library subset also syncs to the
// server (/api/settings) so it follows the account across devices.
type PersistedState = {
  theme: 'light' | 'dark'
  zoomPreset: ZoomPreset
  zoom: number
  stampDefaults: StampDefaults
  stampMeta: Record<string, StampMeta>
  outputNameTemplate: string
  /** 左侧（缩略图/印章架）面板是否展开。设备本地偏好，不同步服务端。 */
  leftOpen: boolean
  /** 右侧检查器面板是否展开。 */
  rightOpen: boolean
}

export type EditorState = PersistedState & {
  // configs are per-file (client fileId) and live only in memory, since PDFs
  // are transient browser-held bytes.
  configs: Record<string, FileConfig>
  files: PDFFile[]
  stamps: StampAsset[]
  /** 文件内容版本号：合并/重排（replaceFile）后递增，用于让缩略图拖拽顺序失效。 */
  fileRevs: Record<string, number>
  activeFileId: string | null
  currentPage: number
  selection: Selection
  selectedStampIds: string[]
  selectedPageNumbers: number[]
  armedStampId: string | null
  lastStampId: string | null
  rangeText: string
  lastAddedId: string | null
  outputPassword: string
  busy: string
  /** 服务端设置文档版本号（乐观并发）。 */
  settingsVersion: number
  /** 当前视口宽度，用于窄屏判定（瞬时态，不持久化）。 */
  viewportWidth: number
  /** 窄屏浮层抽屉当前打开的一侧（一次只开一个）。 */
  mobilePanel: 'left' | 'right' | null

  setBusy: (busy: string) => void
  setWorkspace: (files: PDFFile[], stamps: StampAsset[]) => void
  setStamps: (stamps: StampAsset[]) => void
  hydrateSettings: (settings: LibrarySettings, version: number) => void
  setSettingsVersion: (version: number) => void
  resetWorkspace: () => void
  upsertFiles: (files: PDFFile[]) => void
  /** 原位替换文件条目（fileId 不变，列表顺序保持）。 */
  replaceFile: (file: PDFFile) => void
  removeFile: (fileId: string) => void
  upsertStamps: (stamps: StampAsset[]) => void
  removeStamp: (stampId: string) => void
  removeStamps: (stampIds: string[]) => void
  _activateFile: (fileId: string | null) => void
  setCurrentPage: (page: number) => void
  setZoom: (zoom: number, preset: ZoomPreset) => void
  setTheme: (theme: 'light' | 'dark') => void
  setStampDefaults: (patch: Partial<StampDefaults>) => void
  setStampMeta: (stampId: string, patch: StampMeta) => void
  pruneStampMeta: (keepIds: string[]) => void
  setRangeText: (text: string) => void
  setOutputNameTemplate: (template: string) => void
  setOutputPassword: (password: string) => void
  toggleLeftPanel: (open?: boolean) => void
  toggleRightPanel: (open?: boolean) => void
  setViewportWidth: (width: number) => void
  closeMobilePanel: () => void
  select: (selection: Selection) => void
  setSelectedStampIds: (stampIds: string[]) => void
  setSelectedPageNumbers: (pageNumbers: number[]) => void
  clearBulkSelection: () => void
  arm: (stampId: string | null) => void
  clearLastAdded: () => void
  addPlacements: (placements: Placement[], options?: { select?: boolean }) => void
  updatePlacement: (id: string, patch: Partial<Placement>) => void
  replacePlacements: (remove: (p: Placement) => boolean, add: Placement[], selectId?: string | null) => void
  removePlacement: (id: string) => void
  clearPlacements: () => void
  setSeam: (patch: Partial<SeamConfig>) => void
  setSeamEnabled: (enabled: boolean) => void
  setConfig: (fileId: string, config: FileConfig) => void
  swapStamp: (oldId: string, newId: string) => void
}

const PERSIST_KEY = 'hlool-pdf:prefs-v3'

function readPersisted(): Partial<PersistedState> {
  try {
    const raw = window.localStorage.getItem(PERSIST_KEY)
    return raw ? (JSON.parse(raw) as Partial<PersistedState>) : {}
  } catch {
    return {}
  }
}

function updateActiveConfig(state: EditorState, mutate: (config: FileConfig) => FileConfig): Partial<EditorState> {
  const fileId = state.activeFileId
  if (!fileId) return {}
  const current = state.configs[fileId] ?? emptyConfig()
  return { configs: { ...state.configs, [fileId]: mutate(current) } }
}

const persisted = readPersisted()

export const useEditorStore = create<EditorState>()(
  temporal(
    (set, get) => ({
      theme: persisted.theme === 'dark' ? 'dark' : 'light',
      zoomPreset: persisted.zoomPreset ?? 'fit',
      zoom: clamp(Number(persisted.zoom) || 1, MIN_ZOOM, MAX_ZOOM),
      stampDefaults: {
        sizeMm: clamp(Number(persisted.stampDefaults?.sizeMm) || 42, 5, 120),
        opacity: clamp(Number(persisted.stampDefaults?.opacity) || 1, 0.1, 1),
        rotation: clamp(Number(persisted.stampDefaults?.rotation) || 0, -180, 180)
      },
      stampMeta: persisted.stampMeta ?? {},
      outputNameTemplate: persisted.outputNameTemplate || '{原名}-已盖章',
      leftOpen: persisted.leftOpen ?? true,
      rightOpen: persisted.rightOpen ?? true,

      configs: {},
      files: [],
      stamps: [],
      fileRevs: {},
      activeFileId: null,
      currentPage: 1,
      selection: null,
      selectedStampIds: [],
      selectedPageNumbers: [],
      armedStampId: null,
      lastStampId: null,
      rangeText: '全部',
      lastAddedId: null,
      outputPassword: '',
      busy: '',
      settingsVersion: 0,
      viewportWidth: typeof window === 'undefined' ? 1280 : window.innerWidth,
      mobilePanel: null,

      setBusy: (busy) => set({ busy }),

      setWorkspace: (files, stamps) =>
        set((state) => {
          const ids = new Set(files.map((f) => f.fileId))
          const configs = Object.fromEntries(Object.entries(state.configs).filter(([id]) => ids.has(id)))
          const activeFileId = state.activeFileId && ids.has(state.activeFileId) ? state.activeFileId : (files[0]?.fileId ?? null)
          return { files, stamps, configs, activeFileId }
        }),

      setStamps: (stamps) => set({ stamps }),

      hydrateSettings: (settings, version) =>
        set((state) => ({
          settingsVersion: version,
          stampDefaults: settings.stampDefaults
            ? {
                sizeMm: clamp(Number(settings.stampDefaults.sizeMm) || state.stampDefaults.sizeMm, 5, 120),
                opacity: clamp(Number(settings.stampDefaults.opacity) || state.stampDefaults.opacity, 0.1, 1),
                rotation: clamp(Number(settings.stampDefaults.rotation) || 0, -180, 180)
              }
            : state.stampDefaults,
          stampMeta: settings.stampMeta ?? state.stampMeta,
          outputNameTemplate: settings.outputNameTemplate || state.outputNameTemplate
        })),

      setSettingsVersion: (settingsVersion) => set({ settingsVersion }),

      resetWorkspace: () =>
        set({
          files: [],
          stamps: [],
          configs: {},
          fileRevs: {},
          activeFileId: null,
          currentPage: 1,
          selection: null,
          selectedStampIds: [],
          selectedPageNumbers: [],
          armedStampId: null,
          lastStampId: null,
          settingsVersion: 0
        }),

      upsertFiles: (incoming) =>
        set((state) => {
          const ids = new Set(incoming.map((f) => f.fileId))
          return { files: [...incoming, ...state.files.filter((f) => !ids.has(f.fileId))] }
        }),

      replaceFile: (file) =>
        set((state) => ({
          files: state.files.map((f) => (f.fileId === file.fileId ? file : f)),
          fileRevs: { ...state.fileRevs, [file.fileId]: (state.fileRevs[file.fileId] ?? 0) + 1 },
          currentPage: state.activeFileId === file.fileId ? Math.min(state.currentPage, file.pageCount) : state.currentPage
        })),

      removeFile: (fileId) =>
        set((state) => {
          const files = state.files.filter((f) => f.fileId !== fileId)
          const configs = { ...state.configs }
          delete configs[fileId]
          const activeFileId = state.activeFileId === fileId ? (files[0]?.fileId ?? null) : state.activeFileId
          return {
            files,
            configs,
            activeFileId,
            selection: state.activeFileId === fileId ? null : state.selection,
            selectedPageNumbers: state.activeFileId === fileId ? [] : state.selectedPageNumbers,
            currentPage: state.activeFileId === fileId ? 1 : state.currentPage
          }
        }),

      upsertStamps: (incoming) =>
        set((state) => {
          const ids = new Set(incoming.map((s) => s.stampId))
          return { stamps: [...incoming, ...state.stamps.filter((s) => !ids.has(s.stampId))] }
        }),

      removeStamp: (stampId) =>
        set((state) => {
          const configs: Record<string, FileConfig> = {}
          for (const [fileId, config] of Object.entries(state.configs)) {
            const placements = config.placements.filter((p) => p.stampId !== stampId)
            const seamUsesStamp = config.seam.stampId === stampId
            configs[fileId] = {
              placements,
              seamEnabled: seamUsesStamp ? false : config.seamEnabled,
              seam: seamUsesStamp ? { ...config.seam, stampId: null } : config.seam
            }
          }
          const stampMeta = { ...state.stampMeta }
          delete stampMeta[stampId]
          return {
            stamps: state.stamps.filter((s) => s.stampId !== stampId),
            configs,
            stampMeta,
            armedStampId: state.armedStampId === stampId ? null : state.armedStampId,
            lastStampId: state.lastStampId === stampId ? null : state.lastStampId,
            selectedStampIds: state.selectedStampIds.filter((id) => id !== stampId),
            selection: null
          }
        }),

      removeStamps: (stampIds) =>
        set((state) => {
          const remove = new Set(stampIds)
          if (remove.size === 0) return {}
          const configs: Record<string, FileConfig> = {}
          for (const [fileId, config] of Object.entries(state.configs)) {
            const placements = config.placements.filter((p) => !remove.has(p.stampId))
            const seamUsesStamp = config.seam.stampId ? remove.has(config.seam.stampId) : false
            configs[fileId] = {
              placements,
              seamEnabled: seamUsesStamp ? false : config.seamEnabled,
              seam: seamUsesStamp ? { ...config.seam, stampId: null } : config.seam
            }
          }
          const stampMeta = { ...state.stampMeta }
          for (const id of remove) delete stampMeta[id]
          return {
            stamps: state.stamps.filter((s) => !remove.has(s.stampId)),
            configs,
            stampMeta,
            armedStampId: state.armedStampId && remove.has(state.armedStampId) ? null : state.armedStampId,
            lastStampId: state.lastStampId && remove.has(state.lastStampId) ? null : state.lastStampId,
            selectedStampIds: [],
            selection: null
          }
        }),

      _activateFile: (fileId) =>
        set({
          activeFileId: fileId,
          currentPage: 1,
          selection: null,
          selectedStampIds: [],
          selectedPageNumbers: [],
          armedStampId: null,
          lastAddedId: null,
          rangeText: '全部'
        }),

      setCurrentPage: (page) => set({ currentPage: page }),
      setZoom: (zoom, preset) => set({ zoom: clamp(zoom, MIN_ZOOM, MAX_ZOOM), zoomPreset: preset }),
      setTheme: (theme) => set({ theme }),
      setStampDefaults: (patch) => set((state) => ({ stampDefaults: { ...state.stampDefaults, ...patch } })),
      setStampMeta: (stampId, patch) =>
        set((state) => ({ stampMeta: { ...state.stampMeta, [stampId]: { ...state.stampMeta[stampId], ...patch } } })),
      pruneStampMeta: (keepIds) =>
        set((state) => {
          const keep = new Set(keepIds)
          const entries = Object.entries(state.stampMeta).filter(([id]) => keep.has(id))
          if (entries.length === Object.keys(state.stampMeta).length) return {}
          return { stampMeta: Object.fromEntries(entries) }
        }),
      setRangeText: (rangeText) => set({ rangeText }),
      setOutputNameTemplate: (outputNameTemplate) => set({ outputNameTemplate }),
      setOutputPassword: (outputPassword) => set({ outputPassword }),
      toggleLeftPanel: (open) =>
        set((state) => {
          // 宽屏：切换停靠列；窄屏：切换浮层抽屉（开左自动收右）。
          if (state.viewportWidth >= LEFT_DOCK_BP) return { leftOpen: open ?? !state.leftOpen }
          const wantOpen = open ?? state.mobilePanel !== 'left'
          return { mobilePanel: wantOpen ? 'left' : null }
        }),
      toggleRightPanel: (open) =>
        set((state) => {
          if (state.viewportWidth >= RIGHT_DOCK_BP) return { rightOpen: open ?? !state.rightOpen }
          const wantOpen = open ?? state.mobilePanel !== 'right'
          return { mobilePanel: wantOpen ? 'right' : null }
        }),
      setViewportWidth: (viewportWidth) =>
        set((state) => {
          const patch: Partial<EditorState> = { viewportWidth }
          // 某侧重新停靠后，清掉它残留的浮层状态。
          if (state.mobilePanel === 'left' && viewportWidth >= LEFT_DOCK_BP) patch.mobilePanel = null
          else if (state.mobilePanel === 'right' && viewportWidth >= RIGHT_DOCK_BP) patch.mobilePanel = null
          return patch
        }),
      closeMobilePanel: () => set({ mobilePanel: null }),
      select: (selection) => set({ selection }),
      setSelectedStampIds: (selectedStampIds) => set({ selectedStampIds, selectedPageNumbers: [] }),
      setSelectedPageNumbers: (selectedPageNumbers) => set({ selectedPageNumbers, selectedStampIds: [] }),
      clearBulkSelection: () => set({ selectedStampIds: [], selectedPageNumbers: [] }),
      arm: (armedStampId) => set({ armedStampId, lastStampId: armedStampId ?? get().lastStampId, selection: armedStampId ? null : get().selection }),
      clearLastAdded: () => set({ lastAddedId: null }),

      addPlacements: (placements, options) =>
        set((state) => {
          if (placements.length === 0) return {}
          const patch = updateActiveConfig(state, (config) => ({
            ...config,
            placements: [...config.placements, ...placements]
          }))
          const last = placements[placements.length - 1]
          return {
            ...patch,
            lastStampId: last.stampId,
            lastAddedId: last.id,
            selection: options?.select === false ? state.selection : { kind: 'placement', id: last.id }
          }
        }),

      updatePlacement: (id, patch) =>
        set((state) =>
          updateActiveConfig(state, (config) => ({
            ...config,
            placements: config.placements.map((p) => (p.id === id ? { ...p, ...patch } : p))
          }))
        ),

      replacePlacements: (remove, add, selectId) =>
        set((state) => {
          const patch = updateActiveConfig(state, (config) => ({
            ...config,
            placements: [...config.placements.filter((p) => !remove(p)), ...add]
          }))
          return { ...patch, selection: selectId ? { kind: 'placement', id: selectId } : state.selection }
        }),

      removePlacement: (id) =>
        set((state) => {
          const patch = updateActiveConfig(state, (config) => ({
            ...config,
            placements: config.placements.filter((p) => p.id !== id)
          }))
          const selection = state.selection?.kind === 'placement' && state.selection.id === id ? null : state.selection
          return { ...patch, selection }
        }),

      clearPlacements: () =>
        set((state) => ({
          ...updateActiveConfig(state, (config) => ({ ...config, placements: [] })),
          selection: null
        })),

      setSeam: (patch) =>
        set((state) =>
          updateActiveConfig(state, (config) => ({ ...config, seam: { ...config.seam, ...patch } }))
        ),

      setSeamEnabled: (enabled) =>
        set((state) => {
          const patch = updateActiveConfig(state, (config) => ({
            ...config,
            seamEnabled: enabled,
            seam: { ...config.seam, stampId: config.seam.stampId ?? state.lastStampId ?? state.stamps[0]?.stampId ?? null }
          }))
          return { ...patch, selection: enabled ? { kind: 'seam' } : state.selection?.kind === 'seam' ? null : state.selection }
        }),

      setConfig: (fileId, config) =>
        set((state) => ({ configs: { ...state.configs, [fileId]: config } })),

      swapStamp: (oldId, newId) =>
        set((state) => {
          const configs: Record<string, FileConfig> = {}
          for (const [fileId, config] of Object.entries(state.configs)) {
            configs[fileId] = {
              ...config,
              placements: config.placements.map((p) => (p.stampId === oldId ? { ...p, stampId: newId } : p)),
              seam: config.seam.stampId === oldId ? { ...config.seam, stampId: newId } : config.seam
            }
          }
          const stampMeta = { ...state.stampMeta }
          if (stampMeta[oldId]) {
            stampMeta[newId] = stampMeta[oldId]
            delete stampMeta[oldId]
          }
          return {
            configs,
            stampMeta,
            stamps: state.stamps.filter((s) => s.stampId !== oldId),
            armedStampId: state.armedStampId === oldId ? newId : state.armedStampId,
            lastStampId: state.lastStampId === oldId ? newId : state.lastStampId
          }
        })
    }),
    {
      partialize: (state) => ({ configs: state.configs }),
      limit: 100,
      handleSet: (handle) => {
        let last = 0
        return (...args: Parameters<typeof handle>) => {
          const now = Date.now()
          if (now - last > 350) handle(...args)
          last = now
        }
      }
    }
  )
)

/* ---- 设备本地偏好（localStorage 镜像，防抖写入） ---- */
let persistTimer: number | undefined
useEditorStore.subscribe((state) => {
  window.clearTimeout(persistTimer)
  persistTimer = window.setTimeout(() => {
    const payload: PersistedState = {
      theme: state.theme,
      zoomPreset: state.zoomPreset,
      zoom: state.zoom,
      stampDefaults: state.stampDefaults,
      stampMeta: state.stampMeta,
      outputNameTemplate: state.outputNameTemplate,
      leftOpen: state.leftOpen,
      rightOpen: state.rightOpen
    }
    try {
      window.localStorage.setItem(PERSIST_KEY, JSON.stringify(payload))
    } catch {
      /* localStorage 不可用时静默忽略 */
    }
  }, 300)
})

/* ---- 撤销 / 重做 ---- */
export function useTemporal() {
  return useStore(useEditorStore.temporal)
}

export function undo() {
  useEditorStore.temporal.getState().undo()
}

export function redo() {
  useEditorStore.temporal.getState().redo()
}

/** 切换文件并清空撤销栈（撤销以单文件为作用域）。 */
export function switchFile(fileId: string | null) {
  useEditorStore.getState()._activateFile(fileId)
  useEditorStore.temporal.getState().clear()
}

/* ---- 派生选择器 ---- */
export function activeFile(state: EditorState): PDFFile | null {
  return state.files.find((f) => f.fileId === state.activeFileId) ?? null
}

const EMPTY_CONFIG = emptyConfig()

export function activeConfig(state: EditorState): FileConfig {
  if (!state.activeFileId) return EMPTY_CONFIG
  return state.configs[state.activeFileId] ?? EMPTY_CONFIG
}

export function selectedPlacement(state: EditorState): Placement | null {
  const selection = state.selection
  if (selection?.kind !== 'placement') return null
  const config = activeConfig(state)
  return config.placements.find((p) => p.id === selection.id) ?? null
}

export function stampById(state: EditorState, stampId: string | null | undefined): StampAsset | null {
  if (!stampId) return null
  return state.stamps.find((s) => s.stampId === stampId) ?? null
}

export function stampLabel(state: EditorState, stamp: StampAsset): string {
  return state.stampMeta[stamp.stampId]?.alias || stamp.name
}

export function hasConfig(config: FileConfig | undefined): boolean {
  return Boolean(config && (config.placements.length > 0 || (config.seamEnabled && config.seam.stampId)))
}

export function configuredFiles(state: EditorState): PDFFile[] {
  return state.files.filter((f) => hasConfig(state.configs[f.fileId]))
}

/* ---- 侧栏停靠 / 浮层判定 ---- */
export function leftDocked(state: EditorState): boolean {
  return state.viewportWidth >= LEFT_DOCK_BP
}

export function rightDocked(state: EditorState): boolean {
  return state.viewportWidth >= RIGHT_DOCK_BP
}

/** 左栏当前是否可见：宽屏看停靠偏好，窄屏看浮层抽屉。 */
export function leftPanelOpen(state: EditorState): boolean {
  return state.viewportWidth >= LEFT_DOCK_BP ? state.leftOpen : state.mobilePanel === 'left'
}

export function rightPanelOpen(state: EditorState): boolean {
  return state.viewportWidth >= RIGHT_DOCK_BP ? state.rightOpen : state.mobilePanel === 'right'
}

export function defaultSeam(): SeamConfig {
  return { ...DEFAULT_SEAM }
}

/** 抽取要同步到服务端的库设置子集。 */
export function librarySettings(state: EditorState): LibrarySettings {
  return {
    stampDefaults: state.stampDefaults,
    stampMeta: state.stampMeta,
    outputNameTemplate: state.outputNameTemplate
  }
}
