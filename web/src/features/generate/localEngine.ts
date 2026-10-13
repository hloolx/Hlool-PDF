/**
 * 本地盖章引擎：在浏览器内完成 placements + 骑缝章 + 直通导出，
 * 输出与服务端管线（internal/pdf/pdf.go StampPDF）像素级对齐 ——
 * 对齐由 scripts/verify-local-engine.mjs harness 持续验收（150dpi 逐像素）。
 *
 * 与服务端的语义对应关系（改任何一边都必须同步另一边并跑 harness）：
 *  - 堆叠次序：placements 先、骑缝后，同 pdf.go StampPDF:123-152
 *    （服务端 batchByOpacity 只是写入 pass 的优化，不改变前后序）；
 *  - placements 几何：localEngineMath.placementDraw ↔ pdf.go watermarkDesc；
 *  - 骑缝切片：../seam/slices.ts（与 pdf.go sliceBoundaries 逐位一致）；
 *  - 骑缝落位：../seam/slices.ts seamRectPt ↔ pdf.go seamPlacement，页面尺寸
 *    取「烘录前 MediaBox + /Rotate 交换」（serverPageDim ↔ pdfcpu PageDims）；
 *  - /Rotate 源页：仅对被盖章的页烘录（pdfcpu addPageWatermark 同款不对称行为）。
 *
 * 差异（有意不复刻）：placements 旋转恰为 ±90.000 时 pdfcpu 的边界对齐特例
 * （矩形章偏移 |W−H|/2 的「预览≠产物」怪癖）—— 本地始终绕中心。
 *
 * 失败策略：任何异常直接抛出，由 processFile 显示可操作的本地错误。
 * 本模块是懒加载分包（pdf-lib 很重），严禁被入口包静态引用（拆包约定见
 * features/workspace/boot.ts）。
 */
import { PDFDocument, degrees, type PDFImage } from 'pdf-lib'
import { parsePageExpression } from '../../lib/pages'
import type { Placement, SeamSide } from '../../lib/types'
import { seamCrop, seamRectPt, type SeamCrop } from '../seam/slices'
import { normalizedOpacity, placementDraw, serverPageDim } from './localEngineMath'
import { bakePageRotation, embedWithInterpolate } from './pdfBake'

export type PlacementParam = Omit<Placement, 'id' | 'sourceId'>

export type SeamSealParam = {
  stampId: string
  pages: string
  side: SeamSide
  sizePt: number
  positionPercent: number
  marginPt: number
  opacity: number
  maxSlices: number
  randomSeed: number
}

export type LocalStampParams = {
  placements: PlacementParam[]
  seamSeals: SeamSealParam[]
}

export type LocalStampAsset = {
  bytes: ArrayBuffer | Uint8Array
  widthPx: number
  heightPx: number
}

export async function stampPdfLocally(
  pdfBytes: ArrayBuffer | Uint8Array,
  params: LocalStampParams,
  stamps: Record<string, LocalStampAsset>
): Promise<Uint8Array> {
  const placements = params.placements ?? []
  const seams = params.seamSeals ?? []
  const src = pdfBytes instanceof Uint8Array ? pdfBytes : new Uint8Array(pdfBytes)
  if (!new TextDecoder('ascii').decode(src.subarray(0, 1024)).includes('%PDF-')) {
    throw new Error('无法识别 PDF 文件，请从原软件重新导出有效的 PDF 后导入。')
  }
  if (placements.length === 0 && seams.length === 0) {
    // 直通导出：与服务端 copyFile 同义，源字节原样输出。
    return src.slice()
  }

  // 加密由作业层解锁；损坏的 PDF 直接向用户报告错误。
  const doc = await PDFDocument.load(src, { updateMetadata: false })
  const pages = doc.getPages()

  // 服务端 PageInfo 语义的页面尺寸（烘录前读取，骑缝落位公式专用）。
  const dims = pages.map((p) => {
    const media = p.getMediaBox()
    return serverPageDim(media.width, media.height, p.getRotation().angle)
  })

  const seamPlans = seams.map((seal) => {
    const normalized = normalizeSeal(seal)
    const expr = parsePageExpression(seal.pages || '全部', pages.length)
    if (expr.invalidParts.length > 0) throw new Error(`骑缝章页范围无效: ${expr.invalidParts.join(',')}`)
    if (expr.pages.length < 2) throw new Error('骑缝章至少需要 2 页')
    return { seal: normalized, pages: expr.pages }
  })

  for (const pl of placements) {
    if (!Number.isInteger(pl.pageNumber) || pl.pageNumber < 1 || pl.pageNumber > pages.length) throw new Error(`页码越界: ${pl.pageNumber}`)
    if (![pl.xPt, pl.yPt, pl.widthPt, pl.heightPt, pl.rotation, pl.opacity].every(Number.isFinite)) {
      throw new Error('印章参数包含无效数值，请重新设置位置、尺寸或透明度。')
    }
    if (!(pl.widthPt > 0) || !(pl.heightPt > 0)) throw new Error('印章宽度和高度必须大于 0')
    if (pl.opacity < 0 || pl.opacity > 1) throw new Error('印章透明度必须介于 0 和 1 之间')
    if (!stamps[pl.stampId]) throw new Error(`缺少印章数据: ${pl.stampId}`)
    const asset = stamps[pl.stampId]
    if (!(asset.widthPx > 0) || !(asset.heightPx > 0) || !Number.isFinite(asset.widthPx) || !Number.isFinite(asset.heightPx)) {
      throw new Error('印章图片尺寸无效，请重新导入印章。')
    }
  }
  for (const plan of seamPlans) {
    if (!stamps[plan.seal.stampId]) throw new Error(`缺少印章数据: ${plan.seal.stampId}`)
  }

  // 仅对「有水印落上去的页」烘录自带 /Rotate（pdfcpu 同款不对称行为：其余页保留标记）。
  const targets = new Set<number>(placements.map((p) => p.pageNumber))
  for (const plan of seamPlans) for (const n of plan.pages) targets.add(n)
  for (const pageNo of targets) bakePageRotation(doc, pages[pageNo - 1], 0)

  const embedCache = new Map<string, Promise<PDFImage>>()
  const embedStamp = (stampId: string): Promise<PDFImage> => {
    let cached = embedCache.get(stampId)
    if (!cached) {
      cached = embedImageBytes(doc, toU8(stamps[stampId].bytes))
      embedCache.set(stampId, cached)
    }
    return cached
  }

  // placements：数组顺序即堆叠顺序（先画的在下）。
  for (const pl of placements) {
    const stamp = stamps[pl.stampId]
    const page = pages[pl.pageNumber - 1]
    const crop = page.getCropBox()
    // 缩放语义与服务端一致：只信 widthPt 与库元数据像素尺寸（pdf.go:256）。
    const spec = placementDraw(pl, stamp.widthPx, stamp.heightPx, crop.x, crop.y)
    page.drawImage(await embedStamp(pl.stampId), {
      x: spec.x,
      y: spec.y,
      width: spec.width,
      height: spec.height,
      rotate: degrees(spec.rotateDeg),
      opacity: normalizedOpacity(pl.opacity)
    })
  }

  // 骑缝章：整图裁片 → 逐页贴。切片几何吃「实际位图尺寸」（服务端 loadRGBA
  // 的 Bounds 同义），与 placements 用库元数据是两套有意区分的语义。
  for (const plan of seamPlans) {
    const seal = plan.seal
    const bitmap = await decodeBitmap(toU8(stamps[seal.stampId].bytes))
    try {
      const opacity = normalizedOpacity(seal.opacity)
      for (let i = 0; i < plan.pages.length; i++) {
        const pageNo = plan.pages[i]
        const crop = seamCrop(bitmap.width, bitmap.height, i, plan.pages.length, seal.maxSlices, seal.side, seal.randomSeed)
        const piece = await embedWithInterpolate(await doc.embedPng(await cropToPng(bitmap, crop)))
        const rect = seamRectPt(dims[pageNo - 1], crop, seal)
        const page = pages[pageNo - 1]
        const box = page.getCropBox()
        page.drawImage(piece, {
          x: box.x + rect.xPt,
          y: box.y + rect.yPt,
          width: rect.widthPt,
          height: rect.heightPt,
          opacity
        })
      }
    } finally {
      bitmap.close?.()
    }
  }

  return doc.save()
}

/* ---------------- helpers ---------------- */

function toU8(bytes: ArrayBuffer | Uint8Array): Uint8Array {
  return bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
}

/** 服务端 buildSeamWatermarks 的参数归一：非法值落到与 pdf.go:283-299 相同的缺省。 */
function normalizeSeal(seal: SeamSealParam) {
  if (![seal.sizePt, seal.positionPercent, seal.marginPt, seal.opacity, seal.maxSlices, seal.randomSeed].every(Number.isFinite)) {
    throw new Error('骑缝章参数包含无效数值，请重新设置。')
  }
  const side = (['left', 'right', 'top', 'bottom'] as const).includes(seal.side) ? seal.side : 'right'
  return {
    ...seal,
    side,
    sizePt: seal.sizePt > 0 ? seal.sizePt : 120,
    positionPercent: seal.positionPercent >= 0 && seal.positionPercent <= 100 ? seal.positionPercent : 50,
    maxSlices: seal.maxSlices > 0 ? seal.maxSlices : 20,
    stampId: seal.stampId
  }
}

/** PNG/JPEG 以字节头识别；其余格式不支持，应在印章导入时转换。 */
async function embedImageBytes(doc: PDFDocument, bytes: Uint8Array): Promise<PDFImage> {
  if (bytes.length > 3 && bytes[0] === 0x89 && bytes[1] === 0x50) return embedWithInterpolate(await doc.embedPng(bytes))
  if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8) return embedWithInterpolate(await doc.embedJpg(bytes))
  throw new Error('不支持的印章图片格式')
}

async function decodeBitmap(bytes: Uint8Array): Promise<ImageBitmap> {
  // ArrayBuffer 视图直接进 Blob；createImageBitmap 全平台目标浏览器可用。
  return createImageBitmap(new Blob([bytes as BlobPart]))
}

async function cropToPng(bitmap: ImageBitmap, c: SeamCrop): Promise<ArrayBuffer> {
  if (typeof OffscreenCanvas !== 'undefined') {
    const canvas = new OffscreenCanvas(c.sw, c.sh)
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('Canvas 不可用')
    ctx.drawImage(bitmap, c.sx, c.sy, c.sw, c.sh, 0, 0, c.sw, c.sh)
    const blob = await canvas.convertToBlob({ type: 'image/png' })
    return blob.arrayBuffer()
  }
  const canvas = document.createElement('canvas')
  canvas.width = c.sw
  canvas.height = c.sh
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Canvas 不可用')
  ctx.drawImage(bitmap, c.sx, c.sy, c.sw, c.sh, 0, 0, c.sw, c.sh)
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'))
  if (!blob) throw new Error('切片编码失败')
  return blob.arrayBuffer()
}
