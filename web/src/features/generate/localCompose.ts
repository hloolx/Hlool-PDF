/**
 * 页面操作本地引擎：删/重排/多文件拼接/旋转烘录/图片转 PDF 在浏览器完成，
 * 与可选 Go 参考引擎的 ComposePDF / RotatePagesBaked / ImageToPDF 逐像素对比
 * （scripts/verify-local-engine.ps1），用于验证输出几何语义。
 *
 * 失败时抛给调用方说明原因，文件始终留在浏览器。
 * 懒加载分包，严禁进入口包（拆包约定见 workspace/boot.ts）。
 */
import { PDFDocument, type PDFPage } from 'pdf-lib'
import type { ComposePageRef } from '../workspace/actions'
import { bakePageRotation, embedWithInterpolate } from './pdfBake'
import { isEncryptedPdfError } from './localSafety'

/**
 * 把多个源 PDF 的页按给定顺序拼成一个新 PDF；每页可带 90° 倍数的顺时针旋转，
 * 旋转按「自带 /Rotate + 请求角」烘进页面几何（rotate.go 同式）。
 * password 可统一指定，也可为各源分别指定；qpdf-wasm 解锁后产物为明文。
 */
export async function composePdfLocally(
  blobs: Blob[],
  pages: ComposePageRef[],
  password?: string | (string | undefined)[]
): Promise<Uint8Array> {
  if (pages.length === 0) throw new Error('至少需要一页')
  const groups = new Map<number, Array<{ ref: ComposePageRef; outputIndex: number }>>()
  for (const ref of pages) {
    if (!Number.isInteger(ref.file) || ref.file < 0 || ref.file >= blobs.length) throw new Error('页面引用了未知的源文件')
    if (!Number.isInteger(ref.pageNumber) || ref.pageNumber < 1) throw new Error(`页码无效：${ref.pageNumber}`)
    const rotate = ref.rotate ?? 0
    if (!Number.isFinite(rotate) || rotate % 90 !== 0) throw new Error('旋转角必须是 90 的倍数')
  }
  pages.forEach((ref, outputIndex) => {
    const group = groups.get(ref.file) ?? []
    group.push({ ref, outputIndex })
    groups.set(ref.file, group)
  })

  const out = await PDFDocument.create()
  const copiedPages: PDFPage[] = new Array(pages.length)
  // 每次只打开一个被引用的源，避免同时保留所有来源的字节和解析树。
  for (const [file, group] of groups) {
    const source = await loadSource(blobs[file], Array.isArray(password) ? password[file] : password)
    for (const { ref } of group) {
      if (ref.pageNumber > source.getPageCount()) throw new Error(`页码越界：${ref.pageNumber}`)
    }
    const copied = await out.copyPages(source, group.map(({ ref }) => ref.pageNumber - 1))
    group.forEach(({ outputIndex }, index) => { copiedPages[outputIndex] = copied[index] })
  }
  for (const page of copiedPages) out.addPage(page)

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

/** 仅加密错误尝试解锁；损坏的 PDF 不重复解析或掩盖原始错误。 */
async function loadSource(blob: Blob, password?: string): Promise<PDFDocument> {
  const bytes = new Uint8Array(await blob.arrayBuffer())
  try {
    return await PDFDocument.load(bytes, { updateMetadata: false })
  } catch (err) {
    if (!isEncryptedPdfError(err)) throw err
    const { decryptPdf } = await import('./qpdf')
    // 空用户密码的权限保护 PDF 也需要解锁，不能用 password 的真值跳过。
    const unlocked = await decryptPdf(bytes, password ?? '')
    return PDFDocument.load(unlocked, { updateMetadata: false })
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
