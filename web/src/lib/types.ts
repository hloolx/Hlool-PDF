export type PageInfo = {
  pageNumber: number
  widthPt: number
  heightPt: number
  rotation: number
}

/**
 * 一个工作区文件。PDF 只存在于浏览器内存中的 blob，不上传、不自动持久化。
 * 页面几何由 PDF.js 在导入时算出，单位为未旋转 pt。
 */
export type PDFFile = {
  fileId: string
  name: string
  size: number
  pageCount: number
  pages: PageInfo[]
  createdAt: string
  /** PDF 字节，仅存在于浏览器内存。 */
  blob: Blob
  /** 加密 PDF 的打开密码（渲染与加工都要用）。 */
  password?: string
  /** 文件指纹（size+名字+首尾字节哈希），用于配置防丢的本地匹配。 */
  fingerprint?: string
}

export type StampAsset = {
  stampId: string
  name: string
  /** 当前页面创建的本地 Blob URL，不写入持久存储。 */
  url: string
  mime?: string
  /** 图片字节数（印章架容量条用；旧会话数据可能缺省）。 */
  size?: number
  widthPx: number
  heightPx: number
  createdAt: string
}

/** 与印章一同保存在本机 IndexedDB、可导入导出备份的偏好。 */
export type LibrarySettings = {
  stampDefaults?: { sizeMm: number; opacity: number; rotation: number }
  stampMeta?: Record<string, { alias?: string; sizeMm?: number }>
  outputNameTemplate?: string
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
  scanEnabled?: boolean
  scanConfig?: ScanConfig
}

export type ScanConfig = {
  preset: string
  rotate: number
  rotateVariance: number
  colorspace: 'gray' | 'sRGB'
  blur: number
  noise: number
  border: boolean
  scale: number
  brightness: number
  yellowish: number
  contrast: number
  outputFormat: 'image/png' | 'image/jpeg'
}

export const DEFAULT_SCAN: ScanConfig = {
  preset: 'office-copy',
  rotate: 0.6,
  rotateVariance: 0.3,
  colorspace: 'sRGB',
  blur: 0.25,
  noise: 0.12,
  border: false,
  scale: 1.5,
  brightness: 1.02,
  yellowish: 0.08,
  contrast: 1.05,
  // 默认 JPEG:噪点会让 PNG 无法压缩(整本文件轻松上百 MB),真实扫描件也是 JPEG。
  outputFormat: 'image/jpeg'
}

export type Selection = { kind: 'placement'; id: string } | { kind: 'seam' } | { kind: 'scan' } | null

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
  return { placements: [], seamEnabled: false, seam: { ...DEFAULT_SEAM }, scanEnabled: false, scanConfig: { ...DEFAULT_SCAN } }
}

export function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max)
}
