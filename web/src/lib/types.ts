export type PageInfo = {
  pageNumber: number
  widthPt: number
  heightPt: number
  rotation: number
}

export type PDFFile = {
  fileId: string
  name: string
  size: number
  pageCount: number
  pages: PageInfo[]
  createdAt: string
}

export type StampAsset = {
  stampId: string
  name: string
  url: string
  widthPx: number
  heightPx: number
  createdAt: string
}

export type Placement = {
  id: string
  sourceId?: string
  stampId: string
  pageNumber: number
  xPt: number
  yPt: number
  widthPt: number
  heightPt: number
  rotation: number
  opacity: number
}

export type SeamSide = 'left' | 'right' | 'top' | 'bottom'

export type SeamConfig = {
  stampId: string | null
  pages: string
  side: SeamSide
  sizePt: number
  positionPercent: number
  marginPt: number
  opacity: number
  maxSlices: number
  /** 非 0 时启用确定性随机分割（与后端同种子同算法，预览即产物）。 */
  randomSeed: number
}

export type FileConfig = {
  placements: Placement[]
  seamEnabled: boolean
  seam: SeamConfig
}

export type JobStatus = 'queued' | 'running' | 'done' | 'failed'

export type Job = {
  jobId: string
  fileId: string
  status: JobStatus
  progress: number
  error?: string
  downloadUrl?: string
  outputName?: string
  createdAt: string
  updatedAt: string
}

export type Selection = { kind: 'placement'; id: string } | { kind: 'seam' } | null

/** 42mm（标准公章直径）换算成 pt，与界面尺寸预设保持一致。 */
const SEAM_DEFAULT_SIZE_PT = (42 / 25.4) * 72

export const DEFAULT_SEAM: SeamConfig = {
  stampId: null,
  pages: '全部',
  side: 'right',
  sizePt: SEAM_DEFAULT_SIZE_PT,
  positionPercent: 50,
  marginPt: 0,
  opacity: 1,
  maxSlices: 20,
  randomSeed: 0
}

export function emptyConfig(): FileConfig {
  return { placements: [], seamEnabled: false, seam: { ...DEFAULT_SEAM } }
}

export function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max)
}
