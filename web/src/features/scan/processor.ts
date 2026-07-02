import { PDFDocument } from 'pdf-lib'
import { pdfjsLib } from '../../lib/pdfjs'
import type { ScanConfig } from '../../lib/types'
import { applyScanEffect, canvasToBlob } from './canvas'

/** 单页渲染上限:长边 4000px、总量 1600 万像素,超出等比降 scale,防止大页面撑爆画布(iOS 上限约 16M 像素)。 */
const MAX_EDGE_PX = 4000
const MAX_AREA_PX = 16_000_000

export interface ScanProcessOptions {
  /** 源 PDF 的打开密码(加密 PDF 渲染需要)。 */
  password?: string
  onProgress?: (current: number, total: number) => void
  signal?: AbortSignal
}

/**
 * 把整份 PDF 逐页「重新扫描」:pdfjs 渲染 → 叠加扫描瑕疵 → 以整页图片重建新 PDF。
 * 新 PDF 的页面尺寸取原页 pt 尺寸(scale=1 viewport),渲染倍率只影响清晰度,
 * 不改变纸张物理大小(旧实现把渲染像素当 pt 写入,输出纸张会放大 scale 倍)。
 */
export async function processPDFWithScan(source: Blob, config: ScanConfig, options: ScanProcessOptions = {}): Promise<Blob> {
  const { password, onProgress, signal } = options
  const data = await source.arrayBuffer()
  const doc = await pdfjsLib.getDocument({ data, password }).promise
  try {
    const total = doc.numPages
    const output = await PDFDocument.create()
    for (let pageNum = 1; pageNum <= total; pageNum++) {
      throwIfAborted(signal)
      onProgress?.(pageNum, total)

      const page = await doc.getPage(pageNum)
      const base = page.getViewport({ scale: 1 })
      const viewport = page.getViewport({ scale: clampScale(config.scale, base.width, base.height) })
      const canvas = document.createElement('canvas')
      canvas.width = Math.floor(viewport.width)
      canvas.height = Math.floor(viewport.height)
      const ctx = canvas.getContext('2d')
      if (!ctx) throw new Error('当前浏览器不支持 Canvas')
      await page.render({ canvas, canvasContext: ctx, viewport }).promise
      throwIfAborted(signal)

      const processed = applyScanEffect(canvas, config)
      const bytes = await (await canvasToBlob(processed, config.outputFormat)).arrayBuffer()
      const image = config.outputFormat === 'image/png' ? await output.embedPng(bytes) : await output.embedJpg(bytes)
      const outPage = output.addPage([base.width, base.height])
      outPage.drawImage(image, { x: 0, y: 0, width: base.width, height: base.height })

      page.cleanup()
      // 每页之间让出事件循环,busy 进度文案才能刷新。
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
    throwIfAborted(signal)
    const bytes = await output.save()
    return new Blob([new Uint8Array(bytes)], { type: 'application/pdf' })
  } finally {
    void doc.destroy()
  }
}

function clampScale(scale: number, widthPt: number, heightPt: number): number {
  let s = Math.min(Math.max(scale, 0.5), 3)
  const longEdge = Math.max(widthPt, heightPt)
  if (longEdge * s > MAX_EDGE_PX) s = MAX_EDGE_PX / longEdge
  if (widthPt * heightPt * s * s > MAX_AREA_PX) s = Math.sqrt(MAX_AREA_PX / (widthPt * heightPt))
  return s
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw new DOMException('已取消', 'AbortError')
}
