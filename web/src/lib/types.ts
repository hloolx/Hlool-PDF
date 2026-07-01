export type PageInfo = {
  pageNumber: number
  widthPt: number
  heightPt: number
  rotation: number
}

/**
 * 一个工作区文件。PDF 的真源是浏览器内存里的 blob（阅后即焚：服务器不留存），
 * 页面几何由 PDF.js 在导入时算出（与服务端 pdfcore.PageInfo 同为未旋转 pt）。
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
}

export type StampAsset = {
  stampId: string
  name: string
  /** 后端代理内容地址 /api/stamps/{id}/content（同源带 cookie）。 */
  url: string
  mime?: string
  widthPx: number
  heightPx: number
  createdAt: string
}

export type AuthUser = {
  username: string
  /** 临时身份（未注册）：可正常使用，但库会在约 24 小时后清除。 */
  isGuest?: boolean
  isAdmin?: boolean
}

export type AuthConfig = {
  registerEnabled: boolean
  inviteRequired: boolean
  thirdPartyRegisterEnabled: boolean
  guestEnabled: boolean
}

/** 跟随账号、存到服务端 /api/settings 的用户库偏好（与设备无关的部分）。 */
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
