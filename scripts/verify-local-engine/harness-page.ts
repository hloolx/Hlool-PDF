/**
 * 对齐 harness 的浏览器侧（由 verify.mjs 通过 esbuild 打包为 /harness.js）。
 * 职责：
 *  1) hBuildFixtures —— 用 pdf-lib + canvas 确定性生成夹具（PDF 与印章 PNG/JPG），
 *     仓库里不存二进制；
 *  2) hRunLocal —— 调真实的 web/src/features/generate/localEngine.ts 产出本地产物；
 *  3) hCompare —— pdfjs 以给定 DPI 栅格化两份产物，逐像素比对并产差异热图。
 *
 * 所有字节经 base64 与 Node 侧（verify.mjs）互传。
 */
import { PDFDocument, StandardFonts, degrees, rgb } from 'pdf-lib'
import * as pdfjsLib from 'pdfjs-dist'
import { stampPdfLocally, type LocalStampParams } from '../../web/src/features/generate/localEngine'
import { composePdfLocally, imageToPdfLocally } from '../../web/src/features/generate/localCompose'
import { decryptPdf, encryptPdf } from '../../web/src/features/generate/qpdf'
import type { ComposePageRef } from '../../web/src/features/workspace/actions'

pdfjsLib.GlobalWorkerOptions.workerSrc = '/pdf.worker.js'

/* ---------------- base64 ---------------- */

function toB64(u8: Uint8Array): string {
  let s = ''
  const CHUNK = 0x8000
  for (let i = 0; i < u8.length; i += CHUNK) s += String.fromCharCode(...u8.subarray(i, i + CHUNK))
  return btoa(s)
}

function fromB64(s: string): Uint8Array {
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0))
}

/* ---------------- 夹具：PDF ---------------- */

const A4W = 595.28
const A4H = 841.89

type BaseOpts = {
  /** MediaBox 放大并把 CropBox 设为其中一块（验证「坐标相对 CropBox」语义）。 */
  cropBox?: boolean
  /** 逐页 /Rotate 角度（长度不足的页为 0）。 */
  rotates?: number[]
}

/** 每页有确定性、非对称的参照内容：外框、对角线、页码、逐页异色顶带、原点角标。 */
async function makeBasePdf(pageCount: number, opts: BaseOpts = {}): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.HelveticaBold)
  const colors = [rgb(0.85, 0.3, 0.25), rgb(0.25, 0.55, 0.85), rgb(0.3, 0.7, 0.4), rgb(0.8, 0.65, 0.2), rgb(0.6, 0.4, 0.8)]
  for (let i = 0; i < pageCount; i++) {
    const ox = opts.cropBox ? 50 : 0
    const oy = opts.cropBox ? 40 : 0
    const page = doc.addPage(opts.cropBox ? [A4W + 100, A4H + 90] : [A4W, A4H])
    if (opts.cropBox) page.setCropBox(ox, oy, A4W, A4H)
    // 参照物一律画在 CropBox 区域内（坐标 + 视口偏移）。
    page.drawRectangle({ x: ox + 12, y: oy + 12, width: A4W - 24, height: A4H - 24, borderColor: rgb(0.45, 0.45, 0.5), borderWidth: 2 })
    page.drawLine({ start: { x: ox + 12, y: oy + 12 }, end: { x: ox + A4W - 12, y: oy + A4H - 12 }, thickness: 1, color: rgb(0.7, 0.7, 0.75) })
    page.drawRectangle({ x: ox + 24, y: oy + A4H - 60, width: A4W - 48, height: 24, color: colors[i % colors.length] })
    page.drawRectangle({ x: ox + 12, y: oy + 12, width: 26, height: 26, color: rgb(0.2, 0.2, 0.25) })
    page.drawText(String(i + 1), { x: ox + A4W / 2 - 30, y: oy + A4H / 2 - 40, size: 110, font, color: rgb(0.75, 0.78, 0.82) })
    page.drawText('hlool harness', { x: ox + 30, y: oy + 50, size: 14, font, color: rgb(0.5, 0.5, 0.55) })
    const rot = opts.rotates?.[i] ?? 0
    if (rot !== 0) page.setRotation(degrees(rot))
  }
  return doc.save()
}

/* ---------------- 夹具：印章位图 ---------------- */

type StampFixture = { b64: string; widthPx: number; heightPx: number }

function canvas2d(w: number, h: number) {
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('no canvas 2d')
  return { canvas, ctx }
}

async function canvasBytes(canvas: HTMLCanvasElement, type: string): Promise<Uint8Array> {
  const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, type, 0.92))
  if (!blob) throw new Error('toBlob failed')
  return new Uint8Array(await blob.arrayBuffer())
}

/** 矩形章 200×120：不对称「F」+ 四角异色块 + 右缘 alpha 渐变（专供 ±37° 轴心与 SMask 验证）。 */
async function makeRectStamp(): Promise<StampFixture> {
  const { canvas, ctx } = canvas2d(200, 120)
  ctx.fillStyle = 'rgba(190,30,45,0.9)'
  ctx.beginPath()
  ctx.roundRect(4, 4, 192, 112, 12)
  ctx.fill()
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(28, 20, 14, 80) // F 竖
  ctx.fillRect(28, 20, 52, 14) // F 上横
  ctx.fillRect(28, 52, 40, 12) // F 中横
  ctx.fillStyle = 'rgba(30,180,200,0.95)'
  ctx.beginPath()
  ctx.moveTo(196, 116)
  ctx.lineTo(150, 116)
  ctx.lineTo(196, 70)
  ctx.fill()
  const cs = ['#e63946', '#f4d35e', '#2a9d8f', '#3557a7']
  ;[[0, 0], [190, 0], [0, 110], [190, 110]].forEach(([x, y], i) => {
    ctx.fillStyle = cs[i]
    ctx.fillRect(x, y, 10, 10)
  })
  const grad = ctx.createLinearGradient(120, 0, 200, 0)
  grad.addColorStop(0, 'rgba(255,255,255,0)')
  grad.addColorStop(1, 'rgba(255,255,255,0.85)')
  ctx.fillStyle = grad
  ctx.fillRect(120, 30, 76, 24)
  return { b64: toB64(await canvasBytes(canvas, 'image/png')), widthPx: 200, heightPx: 120 }
}

/** 方章 160×160：缺口圆环 + 偏心点（±90/180 用；宽=高避开服务端 ±90 特例差异）。 */
async function makeSquareStamp(): Promise<StampFixture> {
  const { canvas, ctx } = canvas2d(160, 160)
  ctx.strokeStyle = 'rgba(190,30,45,0.92)'
  ctx.lineWidth = 12
  ctx.beginPath()
  ctx.arc(80, 80, 66, 0.4, 2 * Math.PI - 0.4) // 右侧留缺口 → 不对称
  ctx.stroke()
  ctx.fillStyle = 'rgba(190,30,45,0.92)'
  ctx.fillRect(98, 72, 30, 16) // 偏心横杠
  ctx.beginPath()
  ctx.arc(64, 104, 10, 0, 2 * Math.PI)
  ctx.fill()
  ctx.fillStyle = 'rgba(30,60,160,0.9)'
  ctx.fillRect(40, 34, 18, 18)
  return { b64: toB64(await canvasBytes(canvas, 'image/png')), widthPx: 160, heightPx: 160 }
}

/** JPEG 章 180×100（无 alpha，白底）：验证 embedJpg 路径。 */
async function makeJpegStamp(): Promise<StampFixture> {
  const { canvas, ctx } = canvas2d(180, 100)
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, 180, 100)
  ctx.fillStyle = '#28527a'
  ctx.fillRect(12, 12, 156, 76)
  ctx.fillStyle = '#f2a541'
  ctx.beginPath()
  ctx.moveTo(24, 82)
  ctx.lineTo(70, 22)
  ctx.lineTo(112, 82)
  ctx.fill()
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(126, 24, 30, 30)
  return { b64: toB64(await canvasBytes(canvas, 'image/jpeg')), widthPx: 180, heightPx: 100 }
}

/** 竖向 PNG 大图 300×520（图片转 PDF 的纵向 A4 用例）。 */
async function makePortraitImage(): Promise<StampFixture> {
  const { canvas, ctx } = canvas2d(300, 520)
  ctx.fillStyle = '#e8ecf3'
  ctx.fillRect(0, 0, 300, 520)
  ctx.fillStyle = '#28527a'
  ctx.fillRect(20, 20, 260, 160)
  ctx.fillStyle = '#b23a48'
  ctx.beginPath()
  ctx.arc(150, 330, 90, 0, 2 * Math.PI)
  ctx.fill()
  ctx.fillStyle = '#f2a541'
  ctx.fillRect(40, 460, 100, 40)
  return { b64: toB64(await canvasBytes(canvas, 'image/png')), widthPx: 300, heightPx: 520 }
}

/* ---------------- window API ---------------- */

declare global {
  interface Window {
    hBuildFixtures: () => Promise<{ pdfs: Record<string, string>; stamps: Record<string, StampFixture> }>
    hRunLocal: (params: LocalStampParams, pdfB64: string, stamps: Record<string, StampFixture>) => Promise<string>
    hRunLocalCompose: (pdfsB64: string[], pages: ComposePageRef[], password?: string) => Promise<string>
    hRunLocalImage: (imageB64: string) => Promise<string>
    hEncrypt: (pdfB64: string, password: string) => Promise<string>
    hDecrypt: (pdfB64: string, password: string) => Promise<string>
    hCompare: (aB64: string, bB64: string, dpi: number, wantHeat: boolean, passwordA?: string, passwordB?: string) => Promise<CompareResult>
    hReady: boolean
  }
}

window.hBuildFixtures = async () => {
  const [rect, square, jpeg, portrait] = [
    await makeRectStamp(),
    await makeSquareStamp(),
    await makeJpegStamp(),
    await makePortraitImage()
  ]
  const pdfs: Record<string, string> = {
    base3: toB64(await makeBasePdf(3)),
    base5: toB64(await makeBasePdf(5)),
    cropbox: toB64(await makeBasePdf(2, { cropBox: true })),
    rotsrc: toB64(await makeBasePdf(3, { rotates: [90, 90, 0] })),
    rotsrc2: toB64(await makeBasePdf(2, { rotates: [270, 180] }))
  }
  return { pdfs, stamps: { rect, square, jpeg, portrait } }
}

window.hRunLocal = async (params, pdfB64, stamps) => {
  const assets: Record<string, { bytes: Uint8Array; widthPx: number; heightPx: number }> = {}
  for (const [id, s] of Object.entries(stamps)) {
    assets[id] = { bytes: fromB64(s.b64), widthPx: s.widthPx, heightPx: s.heightPx }
  }
  const out = await stampPdfLocally(fromB64(pdfB64), params, assets)
  return toB64(out)
}

window.hRunLocalCompose = async (pdfsB64, pages, password) => {
  const blobs = pdfsB64.map((b) => new Blob([fromB64(b) as BlobPart], { type: 'application/pdf' }))
  return toB64(await composePdfLocally(blobs, pages, password))
}

window.hRunLocalImage = async (imageB64) => {
  return toB64(await imageToPdfLocally(new Blob([fromB64(imageB64) as BlobPart])))
}

window.hEncrypt = async (pdfB64, password) => toB64(await encryptPdf(fromB64(pdfB64), password))

window.hDecrypt = async (pdfB64, password) => toB64(await decryptPdf(fromB64(pdfB64), password))

/* ---------------- 栅格化与比对 ---------------- */

type PageDiff = { ratio: number; w: number; h: number; sizeMismatch?: string; heat?: string }
type CompareResult = { pages: PageDiff[]; error?: string }

async function renderPdf(bytes: Uint8Array, scale: number, password?: string): Promise<ImageData[]> {
  const loading = pdfjsLib.getDocument({ data: bytes, password })
  try {
    const doc = await loading.promise
    const out: ImageData[] = []
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i)
      const viewport = page.getViewport({ scale })
      const { canvas, ctx } = canvas2d(Math.round(viewport.width), Math.round(viewport.height))
      ctx.fillStyle = '#ffffff'
      ctx.fillRect(0, 0, canvas.width, canvas.height)
      await page.render({ canvas, canvasContext: ctx, viewport }).promise
      out.push(ctx.getImageData(0, 0, canvas.width, canvas.height))
      page.cleanup()
    }
    return out
  } finally {
    await loading.destroy()
  }
}

/** 通道差 > 24 计为差异像素（容忍两套写入器的渲染微噪），比例即 diffRatio。 */
function diffPage(a: ImageData, b: ImageData, wantHeat: boolean): PageDiff {
  if (Math.abs(a.width - b.width) > 2 || Math.abs(a.height - b.height) > 2) {
    return { ratio: 1, w: a.width, h: a.height, sizeMismatch: `${a.width}x${a.height} vs ${b.width}x${b.height}` }
  }
  const w = Math.min(a.width, b.width)
  const h = Math.min(a.height, b.height)
  const heat = wantHeat ? new Uint8ClampedArray(w * h * 4) : null
  let diff = 0
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const ia = (y * a.width + x) * 4
      const ib = (y * b.width + x) * 4
      const d = Math.max(
        Math.abs(a.data[ia] - b.data[ib]),
        Math.abs(a.data[ia + 1] - b.data[ib + 1]),
        Math.abs(a.data[ia + 2] - b.data[ib + 2])
      )
      const bad = d > 24
      if (bad) diff++
      if (heat) {
        const ih = (y * w + x) * 4
        if (bad) {
          heat[ih] = 230
          heat[ih + 1] = 30
          heat[ih + 2] = 30
        } else {
          const g = 255 - ((255 - a.data[ia]) >> 2) // 原图淡化为背景
          heat[ih] = g
          heat[ih + 1] = g
          heat[ih + 2] = g
        }
        heat[ih + 3] = 255
      }
    }
  }
  const out: PageDiff = { ratio: diff / (w * h), w, h }
  if (heat) {
    const { canvas, ctx } = canvas2d(w, h)
    ctx.putImageData(new ImageData(heat, w, h), 0, 0)
    out.heat = canvas.toDataURL('image/png').split(',')[1]
  }
  return out
}

window.hCompare = async (aB64, bB64, dpi, wantHeat, passwordA, passwordB) => {
  const scale = dpi / 72
  const A = await renderPdf(fromB64(aB64), scale, passwordA)
  const B = await renderPdf(fromB64(bB64), scale, passwordB)
  if (A.length !== B.length) return { pages: [], error: `page count ${A.length} vs ${B.length}` }
  return { pages: A.map((img, i) => diffPage(img, B[i], wantHeat)) }
}

window.hReady = true
