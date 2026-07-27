/**
 * 页面操作本地引擎：删/重排/多文件拼接/旋转烘录/图片转 PDF 在浏览器完成，
 * 语义对齐服务端 /api/compose（pdf.go ComposePDF + rotate.go RotatePagesBaked）
 * 与 /api/image-to-pdf（pdf.go ImageToPDF）。对齐由 harness 的 compose/image
 * 用例逐像素验收（scripts/verify-local-engine.ps1）——改任何一边都必须同步另一边。
 *
 * 失败策略与盖章引擎一致：任何异常抛给调用方（workspace/actions.ts）回退云端。
 * 懒加载分包，严禁进入口包（拆包约定见 workspace/boot.ts）。
 */
import { PDFDocument } from 'pdf-lib'
import type { ComposePageRef } from '../workspace/actions'
import { bakePageRotation, embedWithInterpolate } from './pdfBake'

/**
 * 把多个源 PDF 的页按给定顺序拼成一个新 PDF；每页可带 90° 倍数的顺时针旋转，
 * 旋转按「自带 /Rotate + 请求角」烘进页面几何（rotate.go 同式）。
 * password 用于解锁受保护的源（qpdf-wasm，产物为明文，与服务端行为一致）。
 */
export async function composePdfLocally(blobs: Blob[], pages: ComposePageRef[], password?: string): Promise<Uint8Array> {
  if (pages.length === 0) throw new Error('至少需要一页')
  const sources = await Promise.all(
    blobs.map(async (blob) => maybeDecrypt(new Uint8Array(await blob.arrayBuffer()), password))
  )
  const srcDocs = await Promise.all(sources.map((bytes) => PDFDocument.load(bytes, { updateMetadata: false })))

  for (const ref of pages) {
    if (ref.file < 0 || ref.file >= srcDocs.length) throw new Error('页面引用了未知的源文件')
    if (ref.pageNumber < 1 || ref.pageNumber > srcDocs[ref.file].getPageCount()) {
      throw new Error(`页码越界: ${ref.pageNumber}`)
    }
  }

  const out = await PDFDocument.create()
  // 与服务端 buildComposeRuns 同构：连续同文件段一次 copyPages（保持顺序，可重复）。
  let i = 0
  while (i < pages.length) {
    const file = pages[i].file
    let j = i
    while (j < pages.length && pages[j].file === file) j++
    const indices = pages.slice(i, j).map((ref) => ref.pageNumber - 1)
    const copied = await out.copyPages(srcDocs[file], indices)
    for (const page of copied) out.addPage(page)
    i = j
  }

  // 逐输出页烘录请求旋转（0 保留原样——含自带 /Rotate，与服务端只处理 rotations map 一致）。
  const outPages = out.getPages()
  pages.forEach((ref, idx) => {
    const rot = ((Math.round(ref.rotate ?? 0) % 360) + 360) % 360
    if (rot === 0) return
    if (rot % 90 !== 0) throw new Error('旋转角必须是 90 的倍数')
    bakePageRotation(out, outPages[idx], rot)
  })

  return out.save()
}

/** 源是否加密以「pdf-lib 能否打开」判定；加密则 qpdf 解锁（缺密码直接抛错回退云端）。 */
async function maybeDecrypt(bytes: Uint8Array, password?: string): Promise<Uint8Array> {
  try {
    await PDFDocument.load(bytes, { updateMetadata: false })
    return bytes
  } catch (err) {
    if (!password) throw err
    const { decryptPdf } = await import('./qpdf')
    return decryptPdf(bytes, password)
  }
}

/** A4 页面尺寸（pt），与服务端 pdf.go A4WidthPt/A4HeightPt 逐位一致。 */
const A4W = 595.27
const A4H = 841.89

/**
 * 单张图片 → 一页 PDF：横图横向 A4、竖图纵向，等比缩放到页面内最大并居中，
 * 不裁切不变形（pdf.go ImageToPDF 的 pos:center + 相对缩放 1 同义）。
 */
export async function imageToPdfLocally(imageBlob: Blob): Promise<Uint8Array> {
  const bytes = new Uint8Array(await imageBlob.arrayBuffer())
  const doc = await PDFDocument.create()
  const raw =
    bytes.length > 3 && bytes[0] === 0x89 && bytes[1] === 0x50
      ? await doc.embedPng(bytes)
      : bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8
        ? await doc.embedJpg(bytes)
        : null
  if (!raw) throw new Error('不支持的图片格式')
  const image = await embedWithInterpolate(raw)
  const landscape = image.width > image.height
  const pageW = landscape ? A4H : A4W
  const pageH = landscape ? A4W : A4H
  const scale = Math.min(pageW / image.width, pageH / image.height)
  const w = image.width * scale
  const h = image.height * scale
  const page = doc.addPage([pageW, pageH])
  page.drawImage(image, { x: (pageW - w) / 2, y: (pageH - h) / 2, width: w, height: h })
  return doc.save()
}
