import { downloadBlob } from '../../lib/download'
import type { PDFDocumentProxy } from '../../lib/pdfjs'
import { parsePageExpression } from '../../lib/pages'
import type { FileConfig, PDFFile, PageInfo, Placement, StampAsset } from '../../lib/types'
import { emptyConfig } from '../../lib/types'
import { useEditorStore, type EditorState } from '../../state/store'
import { toast } from '../../state/toasts'
import { beginOperation } from '../../state/operations'
import { composePdf } from '../workspace/actions'
import { processDetachedPdf } from '../generate/actions'
import { isEncryptedPdfError, localProcessingError } from '../generate/localSafety'
import { normalizedOpacity, placementDraw } from '../generate/localEngineMath'
import { seamCrop, seamRectPt } from '../seam/slices'
import { readStampAssets } from '../library/storage'
import { snapshotContentTransform, stampedSnapshotGeometry, type SnapshotGeometry, type SourcePageGeometry } from './snapshotGeometry'

const MAX_SNAPSHOT_EDGE = 4096
const SNAPSHOT_SCALE = 2.5
const geometryCache = new WeakMap<Blob, Promise<SourcePageGeometry[]>>()
const snapshotSizes = new WeakMap<HTMLCanvasElement, { widthPt: number; heightPt: number }>()

/** Physical output size, which can differ from the imported unrotated page. */
export function pageSnapshotSize(canvas: HTMLCanvasElement) {
  return snapshotSizes.get(canvas)
}

function sourcePageGeometry(file: PDFFile): Promise<SourcePageGeometry[]> {
  const cached = geometryCache.get(file.blob)
  if (cached) return cached
  const pending = (async () => {
    const [{ PDFDocument }, buffer] = await Promise.all([import('pdf-lib'), file.blob.arrayBuffer()])
    let bytes: Uint8Array<ArrayBufferLike> = new Uint8Array(buffer)
    let pdf
    try {
      pdf = await PDFDocument.load(bytes, { updateMetadata: false })
    } catch (error) {
      if (!isEncryptedPdfError(error)) throw error
      const { decryptPdf } = await import('../generate/qpdf')
      bytes = await decryptPdf(bytes, file.password ?? '')
      pdf = await PDFDocument.load(bytes, { updateMetadata: false })
    }
    // Retain only numbers, never a second parsed document or its input bytes.
    return pdf.getPages().map((page) => ({ crop: page.getCropBox(), media: page.getMediaBox(), rotation: page.getRotation().angle }))
  })().catch((error: unknown) => {
    geometryCache.delete(file.blob)
    throw error
  })
  geometryCache.set(file.blob, pending)
  return pending
}

type OverlaySnapshot = {
  config: FileConfig
  stamps: Pick<StampAsset, 'stampId' | 'widthPx' | 'heightPx'>[]
  assets: Awaited<ReturnType<typeof readStampAssets>>
  images: Map<string, ImageBitmap>
}

async function overlaySnapshot(file: PDFFile, pageNumber: number, state: EditorState): Promise<OverlaySnapshot> {
  const source = state.configs[file.fileId] ?? emptyConfig()
  const config = { ...source, placements: source.placements.filter((p) => p.pageNumber === pageNumber).map((p) => ({ ...p })), seam: { ...source.seam } }
  const assets = await readStampAssets([
    ...config.placements.map((p) => p.stampId),
    ...(config.seamEnabled && config.seam.stampId ? [config.seam.stampId] : [])
  ])
  return {
    config,
    assets,
    images: new Map(),
    stamps: Object.entries(assets).map(([stampId, asset]) => ({ stampId, widthPx: asset.widthPx, heightPx: asset.heightPx }))
  }
}

async function snapshotImage(snapshot: OverlaySnapshot, stampId: string): Promise<ImageBitmap> {
  const existing = snapshot.images.get(stampId)
  if (existing) return existing
  const asset = snapshot.assets[stampId]
  if (!asset) throw new Error('印章图片已不可用，请重新选择印章。')
  const bitmap = await createImageBitmap(asset.blob)
  snapshot.images.set(stampId, bitmap)
  return bitmap
}

function releaseSnapshot(snapshot?: OverlaySnapshot) {
  for (const image of snapshot?.images.values() ?? []) image.close()
}

function baseName(name: string) {
  return name.replace(/\.pdf$/i, '')
}

function pageFileName(file: PDFFile, pageNumber: number, ext: 'pdf' | 'png') {
  return `${baseName(file.name)}-第${pageNumber}页.${ext}`
}

function snapshotScale(pageInfo: PageInfo) {
  const maxEdge = Math.max(pageInfo.widthPt, pageInfo.heightPt)
  if (!Number.isFinite(maxEdge) || maxEdge <= 0) return 1
  return Math.min(SNAPSHOT_SCALE, MAX_SNAPSHOT_EDGE / maxEdge)
}

function canvasBlob(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('无法生成图片'))), type, quality)
  })
}

function placementPayload(placement: Placement, pageNumber = placement.pageNumber) {
  const { id: _id, sourceId: _sourceId, ...rest } = placement
  return { ...rest, pageNumber }
}

function seamVisualForPage(file: PDFFile, pageNumber: number, snapshot: OverlaySnapshot) {
  const config = snapshot.config
  if (!config.seamEnabled || !config.seam.stampId) return null
  const pages = parsePageExpression(config.seam.pages, file.pageCount).pages
  const index = pages.indexOf(pageNumber)
  if (index < 0 || pages.length < 2) return null
  const stamp = snapshot.stamps.find((item) => item.stampId === config.seam.stampId)
  if (!stamp) return null
  return { seal: config.seam, stamp, index, total: pages.length }
}

async function drawPlacement(
  context: CanvasRenderingContext2D,
  snapshot: OverlaySnapshot,
  geometry: SnapshotGeometry,
  placement: Placement,
  scale: number
) {
  const stamp = snapshot.stamps.find((item) => item.stampId === placement.stampId)
  if (!stamp) throw new Error('引用的印章已不可用，请重新选择。')
  const img = await snapshotImage(snapshot, stamp.stampId)
  const spec = placementDraw(placement, stamp.widthPx, stamp.heightPx, geometry.stampBox.x, geometry.stampBox.y)
  const s = scale * geometry.userUnit
  context.save()
  context.globalAlpha = normalizedOpacity(placement.opacity)
  context.translate((spec.x - geometry.view.x) * s, (geometry.view.y + geometry.view.height - spec.y) * s)
  context.rotate((-spec.rotateDeg * Math.PI) / 180)
  context.drawImage(img, 0, -spec.height * s, spec.width * s, spec.height * s)
  context.restore()
}

async function drawPageOverlays(
  context: CanvasRenderingContext2D,
  file: PDFFile,
  pageInfo: PageInfo,
  scale: number,
  snapshot: OverlaySnapshot,
  geometry: SnapshotGeometry
) {
  const config = snapshot.config
  for (const placement of config.placements.filter((item) => item.pageNumber === pageInfo.pageNumber)) {
    await drawPlacement(context, snapshot, geometry, placement, scale)
  }

  const seam = seamVisualForPage(file, pageInfo.pageNumber, snapshot)
  if (!seam) return
  const img = await snapshotImage(snapshot, seam.stamp.stampId)
  const crop = seamCrop(
    seam.stamp.widthPx,
    seam.stamp.heightPx,
    seam.index,
    seam.total,
    seam.seal.maxSlices,
    seam.seal.side,
    seam.seal.randomSeed
  )
  const rect = seamRectPt(geometry.seamSize, crop, seam.seal)
  const s = scale * geometry.userUnit
  context.save()
  context.globalAlpha = normalizedOpacity(seam.seal.opacity)
  context.drawImage(
    img,
    crop.sx,
    crop.sy,
    crop.sw,
    crop.sh,
    (geometry.stampBox.x + rect.xPt - geometry.view.x) * s,
    (geometry.view.y + geometry.view.height - geometry.stampBox.y - rect.yPt - rect.heightPt) * s,
    rect.widthPt * s,
    rect.heightPt * s
  )
  context.restore()
}

async function renderPageSnapshot(
  doc: PDFDocumentProxy,
  file: PDFFile,
  pageInfo: PageInfo,
  snapshot: OverlaySnapshot,
  requestedScale?: number,
  signal?: AbortSignal
) {
  signal?.throwIfAborted()
  const page = await doc.getPage(pageInfo.pageNumber)
  signal?.throwIfAborted()
  const hasOverlays = snapshot.config.placements.length > 0 || Boolean(seamVisualForPage(file, pageInfo.pageNumber, snapshot))
  let geometry: SnapshotGeometry | undefined
  if (hasOverlays) {
    const source = (await sourcePageGeometry(file))[pageInfo.pageNumber - 1]
    if (!source) throw new Error('页面已不可用，请重新选择文档。')
    geometry = stampedSnapshotGeometry(source, page.userUnit)
  }
  signal?.throwIfAborted()
  const base = page.getViewport({ scale: 1 })
  const widthPt = geometry ? geometry.view.width * geometry.userUnit : base.width
  const heightPt = geometry ? geometry.view.height * geometry.userUnit : base.height
  const limit = requestedScale === undefined ? MAX_SNAPSHOT_EDGE : 4000
  const scale = Math.min(requestedScale ?? snapshotScale(pageInfo), limit / Math.max(widthPt, heightPt))
  const viewport = page.getViewport({ scale })
  if (geometry) {
    // The engine bakes /Rotate into content before adding stamps. Render that
    // same content matrix, rather than mixing rotated pixels with raw boxes.
    const { view } = geometry
    viewport.width = widthPt * scale
    viewport.height = heightPt * scale
    viewport.viewBox = [view.x, view.y, view.x + view.width, view.y + view.height]
    viewport.transform = snapshotContentTransform(geometry, scale)
  }
  const canvas = document.createElement('canvas')
  const round = requestedScale === undefined ? Math.round : Math.floor
  canvas.width = Math.max(1, round(viewport.width))
  canvas.height = Math.max(1, round(viewport.height))
  snapshotSizes.set(canvas, { widthPt, heightPt })
  // Match scan/processor's alpha-enabled surface: an opaque Canvas can use LCD
  // text antialiasing, introducing colored glyph fringes absent from output.
  const context = canvas.getContext('2d', { alpha: requestedScale !== undefined })
  if (!context) throw new Error('无法创建画布')
  context.fillStyle = '#fff'
  context.fillRect(0, 0, canvas.width, canvas.height)
  let renderTask: ReturnType<typeof page.render> | undefined
  const cancel = () => renderTask?.cancel()
  try {
    renderTask = page.render({ canvas, canvasContext: context, viewport })
    signal?.addEventListener('abort', cancel, { once: true })
    await renderTask.promise
    signal?.throwIfAborted()
    if (geometry) await drawPageOverlays(context, file, pageInfo, scale, snapshot, geometry)
    signal?.throwIfAborted()
    return canvas
  } catch (error) {
    canvas.width = canvas.height = 0
    throw error
  } finally {
    signal?.removeEventListener('abort', cancel)
  }
}

/** A stable current-page composition shared by scan preview and page exports. */
export async function renderPagePreview(
  doc: PDFDocumentProxy,
  file: PDFFile,
  pageInfo: PageInfo,
  state: EditorState,
  scale: number,
  signal: AbortSignal
) {
  let snapshot: OverlaySnapshot | undefined
  try {
    signal.throwIfAborted()
    snapshot = await overlaySnapshot(file, pageInfo.pageNumber, state)
    signal.throwIfAborted()
    return await renderPageSnapshot(doc, file, pageInfo, snapshot, scale, signal)
  } finally {
    releaseSnapshot(snapshot)
  }
}

async function writePngToClipboard(blob: Blob) {
  if (!navigator.clipboard?.write || typeof ClipboardItem === 'undefined') {
    throw new Error('clipboard image write is unsupported')
  }
  await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })])
}

function pdfNumber(value: number) {
  return Number.isFinite(value) ? String(Math.round(value * 100) / 100) : '1'
}

function makeJpegPdf(jpeg: Uint8Array, imageWidth: number, imageHeight: number, pageWidthPt: number, pageHeightPt: number) {
  const encoder = new TextEncoder()
  const chunks: ArrayBuffer[] = []
  const offsets: number[] = [0]
  let length = 0

  function push(bytes: Uint8Array) {
    const copy = new Uint8Array(bytes.byteLength)
    copy.set(bytes)
    chunks.push(copy.buffer)
    length += bytes.byteLength
  }
  function text(value: string) {
    push(encoder.encode(value))
  }
  function object(id: number, body: string) {
    offsets[id] = length
    text(`${id} 0 obj\n${body}\nendobj\n`)
  }

  const pageWidth = pdfNumber(Math.max(1, pageWidthPt))
  const pageHeight = pdfNumber(Math.max(1, pageHeightPt))
  const content = `q\n${pageWidth} 0 0 ${pageHeight} 0 0 cm\n/Im0 Do\nQ\n`

  text('%PDF-1.4\n')
  object(1, '<< /Type /Catalog /Pages 2 0 R >>')
  object(2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>')
  object(
    3,
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageWidth} ${pageHeight}] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>`
  )
  offsets[4] = length
  text(
    `4 0 obj\n<< /Type /XObject /Subtype /Image /Width ${imageWidth} /Height ${imageHeight} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.byteLength} >>\nstream\n`
  )
  push(jpeg)
  text('\nendstream\nendobj\n')
  object(5, `<< /Length ${encoder.encode(content).byteLength} >>\nstream\n${content}endstream`)

  const xref = length
  text('xref\n0 6\n0000000000 65535 f \n')
  for (let i = 1; i <= 5; i++) text(`${String(offsets[i]).padStart(10, '0')} 00000 n \n`)
  text(`trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`)
  return new Blob(chunks, { type: 'application/pdf' })
}

async function rasterPdfFromCanvas(canvas: HTMLCanvasElement, pageInfo: PageInfo) {
  const jpegBlob = await canvasBlob(canvas, 'image/jpeg', 0.94)
  const jpeg = new Uint8Array(await jpegBlob.arrayBuffer())
  const size = pageSnapshotSize(canvas) ?? pageInfo
  return makeJpegPdf(jpeg, canvas.width, canvas.height, size.widthPt, size.heightPt)
}

/** 单页盖章/加密完全在浏览器完成，页码已重映射到 1。 */
async function processOnePagePdf(blob: Blob, name: string, placements: Placement[], state: EditorState, snapshot: OverlaySnapshot) {
  return processDetachedPdf(
    blob,
    placements.map((placement) => placementPayload(placement, 1)),
    state.outputPassword,
    name,
    { state, assets: snapshot.assets }
  )
}

export async function copyPageAsPng(doc: PDFDocumentProxy | null, file: PDFFile, pageInfo: PageInfo) {
  if (!doc) {
    toast('页面还在加载，稍后再复制。', { kind: 'error' })
    return
  }
  const name = pageFileName(file, pageInfo.pageNumber, 'png')
  const state = useEditorStore.getState()
  const operation = beginOperation(`正在复制第 ${pageInfo.pageNumber} 页…`)
  if (!operation) return
  let snapshot: OverlaySnapshot | undefined
  let canvas: HTMLCanvasElement | undefined
  try {
    snapshot = await overlaySnapshot(file, pageInfo.pageNumber, state)
    canvas = await renderPageSnapshot(doc, file, pageInfo, snapshot)
    const blob = await canvasBlob(canvas, 'image/png')
    try {
      await writePngToClipboard(blob)
      toast(`已复制第 ${pageInfo.pageNumber} 页为 PNG`, { kind: 'success' })
    } catch {
      downloadBlob(blob, name)
      toast('浏览器限制写入剪贴板，已改为下载 PNG。', { kind: 'error' })
    }
  } catch (err) {
    toast(localProcessingError(err).message, { kind: 'error' })
  } finally {
    if (canvas) canvas.width = canvas.height = 0
    releaseSnapshot(snapshot)
    operation.end()
  }
}

export async function exportPagePdf(doc: PDFDocumentProxy | null, file: PDFFile, pageInfo: PageInfo) {
  const state = useEditorStore.getState()
  const name = pageFileName(file, pageInfo.pageNumber, 'pdf')
  const operation = beginOperation(`正在导出第 ${pageInfo.pageNumber} 页…`)
  if (!operation) return
  let snapshot: OverlaySnapshot | undefined
  let canvas: HTMLCanvasElement | undefined
  try {
    snapshot = await overlaySnapshot(file, pageInfo.pageNumber, state)
    const placements = snapshot.config.placements
    const hasSeamVisual = Boolean(seamVisualForPage(file, pageInfo.pageNumber, snapshot))
    let output: Blob
    if (hasSeamVisual) {
      if (!doc) throw new Error('页面还在加载，稍后再导出。')
      canvas = await renderPageSnapshot(doc, file, pageInfo, snapshot)
      output = await rasterPdfFromCanvas(canvas, pageInfo)
      if (state.outputPassword) output = await processOnePagePdf(output, name, [], state, snapshot)
    } else {
      const onePage = await composePdf([file.blob], [{ file: 0, pageNumber: pageInfo.pageNumber }], name, file.password)
      output =
        placements.length > 0 || state.outputPassword
          ? await processOnePagePdf(onePage, name, placements, state, snapshot)
          : onePage
    }
    downloadBlob(output, name)
    toast(`已导出第 ${pageInfo.pageNumber} 页 PDF`, { kind: 'success' })
  } catch (err) {
    toast(localProcessingError(err).message, { kind: 'error' })
  } finally {
    if (canvas) canvas.width = canvas.height = 0
    releaseSnapshot(snapshot)
    operation.end()
  }
}
