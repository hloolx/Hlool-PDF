import { create } from 'zustand'
import { useStore } from 'zustand'
import { temporal } from 'zundo'
import {
  DEFAULT_SEAM,
  clamp,
  emptyConfig,
  type FileConfig,
  type Job,
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

type PersistedState = {
  configs: Record<string, FileConfig>
  theme: 'light' | 'dark'
  zoomPreset: ZoomPreset
  zoom: number
  stampDefaults: StampDefaults
  stampMeta: Record<string, StampMeta>
  outputNameTemplate: string
}

export type EditorState = PersistedState & {
  files: PDFFile[]
  stamps: StampAsset[]
  jobs: Job[]
  /** 文件内容版本号：原地并入/撤销后递增，用于绕过 pdf.js 与 HTTP 缓存。 */
  fileRevs: Record<string, number>
  activeFileId: string | null
  currentPage: number
  selection: Selection
  armedStampId: string | null
  lastStampId: string | null
  rangeText: string
  lastAddedId: string | null
  outputPassword: string
  busy: string

  setBusy: (busy: string) => void
  setWorkspace: (files: PDFFile[], stamps: StampAsset[], jobs: Job[]) => void
  upsertFiles: (files: PDFFile[]) => void
  /** 原位替换文件条目（fileId 不变，列表顺序保持），并递增内容版本号。 */
  replaceFile: (file: PDFFile) => void
  removeFile: (fileId: string) => void
  upsertStamps: (stamps: StampAsset[]) => void
  removeStamp: (stampId: string) => void
  setJobs: (jobs: Job[]) => void
  upsertJob: (job: Job) => void
  removeJob: (jobId: string) => void
  _activateFile: (fileId: string | null) => void
  setCurrentPage: (page: number) => void
  setZoom: (zoom: number, preset: ZoomPreset) => void
  setTheme: (theme: 'light' | 'dark') => void
  setStampDefaults: (patch: Partial<StampDefaults>) => void
  setStampMeta: (stampId: string, patch: StampMeta) => void
  /** 清理不再存在的印章的别名等元数据（boot 重水化后按 id 并集调用）。 */
  pruneStampMeta: (keepIds: string[]) => void
  setRangeText: (text: string) => void
  setOutputNameTemplate: (template: string) => void
  setOutputPassword: (password: string) => void
  select: (selection: Selection) => void
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
  /** 用新印章替换旧印章的所有引用（撤销白底处理时使用）。 */
  swapStamp: (oldId: string, newId: string) => void
}

const PERSIST_KEY = 'hlool-pdf:workspace-v2'

function readPersisted(): Partial<PersistedState> {
  try {
    const raw = window.localStorage.getItem(PERSIST_KEY)
    const parsed = raw ? (JSON.parse(raw) as Partial<PersistedState>) : {}
    // 旧版本持久化的 seam 可能缺少新增字段（如 randomSeed），统一补默认值。
    if (parsed.configs) {
      for (const config of Object.values(parsed.configs)) {
        config.seam = { ...DEFAULT_SEAM, ...config.seam }
        config.placements = config.placements ?? []
      }
    }
    return parsed
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
      configs: persisted.configs ?? {},
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

      files: [],
      stamps: [],
      jobs: [],
      fileRevs: {},
      activeFileId: null,
      currentPage: 1,
      selection: null,
      armedStampId: null,
      lastStampId: null,
      rangeText: '全部',
      lastAddedId: null,
      outputPassword: '',
      busy: '',

      setBusy: (busy) => set({ busy }),

      setWorkspace: (files, stamps, jobs) =>
        set((state) => {
          const ids = new Set(files.map((f) => f.fileId))
          const configs = Object.fromEntries(Object.entries(state.configs).filter(([id]) => ids.has(id)))
          const activeFileId = state.activeFileId && ids.has(state.activeFileId) ? state.activeFileId : (files[0]?.fileId ?? null)
          return { files, stamps, jobs, configs, activeFileId }
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
            selection: null
          }
        }),

      setJobs: (jobs) => set({ jobs }),
      upsertJob: (job) =>
        set((state) => ({ jobs: [job, ...state.jobs.filter((j) => j.jobId !== job.jobId)].slice(0, 50) })),
      removeJob: (jobId) => set((state) => ({ jobs: state.jobs.filter((j) => j.jobId !== jobId) })),

      _activateFile: (fileId) =>
        set({
          activeFileId: fileId,
          currentPage: 1,
          selection: null,
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
      select: (selection) => set({ selection }),
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

/* ---- 持久化（localStorage 镜像，防抖写入） ---- */
let persistTimer: number | undefined
useEditorStore.subscribe((state) => {
  window.clearTimeout(persistTimer)
  persistTimer = window.setTimeout(() => {
    const payload: PersistedState = {
      configs: state.configs,
      theme: state.theme,
      zoomPreset: state.zoomPreset,
      zoom: state.zoom,
      stampDefaults: state.stampDefaults,
      stampMeta: state.stampMeta,
      outputNameTemplate: state.outputNameTemplate
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

/** 文件内容 URL（带版本号，原地并入后自动失效旧缓存）。 */
export function fileContentSrc(state: EditorState, fileId: string): string {
  const rev = state.fileRevs[fileId] ?? 0
  return `/api/files/${fileId}/content${rev > 0 ? `?v=${rev}` : ''}`
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

export function defaultSeam(): SeamConfig {
  return { ...DEFAULT_SEAM }
}
