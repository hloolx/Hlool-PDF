import { pdfjsLib } from './pdfjs'
import type { PageInfo, PDFFile } from './types'

/** 浏览器端生成的工作区文件 id（仅本会话有效，PDF 字节存内存）。 */
export function genFileId(): string {
  return 'file_' + crypto.randomUUID().replaceAll('-', '')
}

/** 判断是否为 PDF.js 的“需要 / 错误密码”异常。 */
export function isPasswordException(err: unknown): boolean {
  return Boolean(err) && typeof err === 'object' && (err as { name?: string }).name === 'PasswordException'
}

/**
 * 用 PDF.js 读取页面几何（未旋转 pt，原点左下），与服务端 pdfcore.PageInfo 对齐，
 * 保证界面摆放坐标与服务端盖章坐标一致。
 */
export async function readPdfPages(blob: Blob, password?: string): Promise<PageInfo[]> {
  const data = await blob.arrayBuffer()
  const doc = await pdfjsLib.getDocument({ data, password }).promise
  try {
    const pages: PageInfo[] = []
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i)
      const [x0, y0, x1, y1] = page.view
      pages.push({ pageNumber: i, widthPt: x1 - x0, heightPt: y1 - y0, rotation: 0 })
    }
    return pages
  } finally {
    await doc.destroy()
  }
}

export function ensurePdfName(name: string): string {
  const trimmed = name.trim() || '文档'
  return /\.pdf$/i.test(trimmed) ? trimmed : `${trimmed}.pdf`
}

/** 把一段 PDF 字节封装成工作区文件（读取页面几何，分配 client fileId）。 */
export async function makePdfFile(blob: Blob, name: string, password?: string): Promise<PDFFile> {
  const pages = await readPdfPages(blob, password)
  return {
    fileId: genFileId(),
    name: ensurePdfName(name),
    size: blob.size,
    pageCount: pages.length,
    pages,
    createdAt: new Date().toISOString(),
    blob,
    password
  }
}
