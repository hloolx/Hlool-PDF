import { errorText, postFormBlob } from '../../lib/api'
import { downloadBlob } from '../../lib/download'
import type { PDFDocumentProxy } from '../../lib/pdfjs'
import { parsePageExpression } from '../../lib/pages'
import type { FileConfig, PDFFile, PageInfo, Placement, StampAsset } from '../../lib/types'
import { activeConfig, useEditorStore, type EditorState } from '../../state/store'
import { toast } from '../../state/toasts'
import { composePdf } from '../workspace/actions'
import { seamCrop, seamRectPt } from '../seam/slices'
import { loadImage } from './imageCache'

const MAX_SNAPSHOT_EDGE = 4096
const SNAPSHOT_SCALE = 2.5

type OverlaySnapshot = {
  config: FileConfig
  stamps: StampAsset[]
}

function overlaySnapshot(state: EditorState = useEditorStore.getState()): OverlaySnapshot {
  const config = activeConfig(state)
  return {
    config: {
      placements: [...config.placements],
      seamEnabled: config.seamEnabled,
      seam: { ...config.seam }
    },
    stamps: [...state.stamps]
  }
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
  return Math.max(0.5, Math.min(SNAPSHOT_SCALE, MAX_SNAPSHOT_EDGE / maxEdge))
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
  pageInfo: PageInfo,
  placement: Placement,
  scale: number
) {
  const stamp = snapshot.stamps.find((item) => item.stampId === placement.stampId)
  if (!stamp) return
  const img = await loadImage(stamp.url)
  const x = placement.xPt * scale
  const top = (pageInfo.heightPt - placement.yPt - placement.heightPt) * scale
  const width = placement.widthPt * scale
  const height = placement.heightPt * scale
  context.save()
  context.globalAlpha = placement.opacity
  context.translate(x + width / 2, top + height / 2)
  context.rotate((placement.rotation * Math.PI) / 180)
  context.drawImage(img, -width / 2, -height / 2, width, height)
  context.restore()
}

async function drawPageOverlays(
  context: CanvasRenderingContext2D,
  file: PDFFile,
  pageInfo: PageInfo,
  scale: number,
  snapshot: OverlaySnapshot
) {
  const config = snapshot.config
  for (const placement of config.placements.filter((item) => item.pageNumber === pageInfo.pageNumber)) {
    await drawPlacement(context, snapshot, pageInfo, placement, scale)
  }

  const seam = seamVisualForPage(file, pageInfo.pageNumber, snapshot)
  if (!seam) return
  const img = await loadImage(seam.stamp.url)
  const crop = seamCrop(
    seam.stamp.widthPx,
    seam.stamp.heightPx,
    seam.index,
    seam.total,
    seam.seal.maxSlices,
    seam.seal.side,
    seam.seal.randomSeed
  )
  const rect = seamRectPt(pageInfo, crop, seam.seal)
  context.save()
  context.globalAlpha = seam.seal.opacity
  context.drawImage(
    img,
    crop.sx,
    crop.sy,
    crop.sw,
    crop.sh,
    rect.xPt * scale,
    (pageInfo.heightPt - rect.yPt - rect.heightPt) * scale,
    rect.widthPt * scale,
    rect.heightPt * scale
  )
  context.restore()
}

async function renderPageSnapshot(doc: PDFDocumentProxy, file: PDFFile, pageInfo: PageInfo, snapshot: OverlaySnapshot) {
  const page = await doc.getPage(pageInfo.pageNumber)
  const scale = snapshotScale(pageInfo)
  const viewport = page.getViewport({ scale })
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(viewport.width))
  canvas.height = Math.max(1, Math.round(viewport.height))
  const context = canvas.getContext('2d', { alpha: false })
  if (!context) throw new Error('无法创建画布')
  context.fillStyle = '#fff'
  context.fillRect(0, 0, canvas.width, canvas.height)
  await page.render({ canvas, canvasContext: context, viewport }).promise
  await drawPageOverlays(context, file, pageInfo, scale, snapshot)
  return canvas
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
  return makeJpegPdf(jpeg, canvas.width, canvas.height, pageInfo.widthPt, pageInfo.heightPt)
}

async function processOnePagePdf(blob: Blob, name: string, placements: Placement[], outputPassword: string) {
  const form = new FormData()
  form.append('file', blob, name)
  form.append(
    'params',
    JSON.stringify({
      placements: placements.map((placement) => placementPayload(placement, 1)),
      seamSeals: [],
      outputPassword,
      outputName: name
    })
  )
  return postFormBlob('/api/process', form)
}

export async function copyPageAsPng(doc: PDFDocumentProxy | null, file: PDFFile, pageInfo: PageInfo) {
  if (!doc) {
    toast('页面还在加载，稍后再复制。', { kind: 'error' })
    return
  }
  const name = pageFileName(file, pageInfo.pageNumber, 'png')
  useEditorStore.getState().setBusy(`正在复制第 ${pageInfo.pageNumber} 页…`)
  try {
    const snapshot = overlaySnapshot()
    const canvas = await renderPageSnapshot(doc, file, pageInfo, snapshot)
    const blob = await canvasBlob(canvas, 'image/png')
    try {
      await writePngToClipboard(blob)
      toast(`已复制第 ${pageInfo.pageNumber} 页为 PNG`, { kind: 'success' })
    } catch {
      downloadBlob(blob, name)
      toast('浏览器限制写入剪贴板，已改为下载 PNG。', { kind: 'error' })
    }
  } catch (err) {
    toast(errorText(err), { kind: 'error' })
  } finally {
    useEditorStore.getState().setBusy('')
  }
}

export async function exportPagePdf(doc: PDFDocumentProxy | null, file: PDFFile, pageInfo: PageInfo) {
  const state = useEditorStore.getState()
  const snapshot = overlaySnapshot(state)
  const name = pageFileName(file, pageInfo.pageNumber, 'pdf')
  const placements = snapshot.config.placements.filter((placement) => placement.pageNumber === pageInfo.pageNumber)
  const hasSeamVisual = Boolean(seamVisualForPage(file, pageInfo.pageNumber, snapshot))
  useEditorStore.getState().setBusy(`正在导出第 ${pageInfo.pageNumber} 页…`)
  try {
    let output: Blob
    if (hasSeamVisual) {
      if (!doc) throw new Error('页面还在加载，稍后再导出。')
      const canvas = await renderPageSnapshot(doc, file, pageInfo, snapshot)
      output = await rasterPdfFromCanvas(canvas, pageInfo)
      if (state.outputPassword) output = await processOnePagePdf(output, name, [], state.outputPassword)
    } else {
      const onePage = await composePdf([file.blob], [{ file: 0, pageNumber: pageInfo.pageNumber }], name, file.password)
      output =
        placements.length > 0 || state.outputPassword
          ? await processOnePagePdf(onePage, name, placements, state.outputPassword)
          : onePage
    }
    downloadBlob(output, name)
    toast(`已导出第 ${pageInfo.pageNumber} 页 PDF`, { kind: 'success' })
  } catch (err) {
    toast(errorText(err), { kind: 'error' })
  } finally {
    useEditorStore.getState().setBusy('')
  }
}
