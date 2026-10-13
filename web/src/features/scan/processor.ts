import { PDFDocument } from 'pdf-lib'
import { loadPdf } from '../../lib/pdfjs'
import type { ScanConfig } from '../../lib/types'
import { applyScanEffect, canvasToBlob } from './canvas'
import { clampScanScale } from './renderScale'

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
  const loading = loadPdf(data, password)
  try {
    const doc = await loading.promise
    const total = doc.numPages
    const output = await PDFDocument.create()
    for (let pageNum = 1; pageNum <= total; pageNum++) {
      throwIfAborted(signal)
      onProgress?.(pageNum, total)

      const page = await doc.getPage(pageNum)
      const base = page.getViewport({ scale: 1 })
      const viewport = page.getViewport({ scale: clampScanScale(config.scale, base.width, base.height) })
      const canvas = document.createElement('canvas')
      let processed: HTMLCanvasElement | undefined
      try {
        canvas.width = Math.max(1, Math.floor(viewport.width))
        canvas.height = Math.max(1, Math.floor(viewport.height))
        const ctx = canvas.getContext('2d')
        if (!ctx) throw new Error('当前浏览器不支持 Canvas')
        await page.render({ canvas, canvasContext: ctx, viewport }).promise
        throwIfAborted(signal)
        processed = applyScanEffect(canvas, config)
        const bytes = await (await canvasToBlob(processed, config.outputFormat)).arrayBuffer()
        const image = config.outputFormat === 'image/png' ? await output.embedPng(bytes) : await output.embedJpg(bytes)
        const outPage = output.addPage([base.width, base.height])
        outPage.drawImage(image, { x: 0, y: 0, width: base.width, height: base.height })
      } finally {
        canvas.width = canvas.height = 0
        if (processed) processed.width = processed.height = 0
        page.cleanup()
      }
      // 每页之间让出事件循环,busy 进度文案才能刷新。
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
    throwIfAborted(signal)
    const bytes = await output.save()
    return new Blob([new Uint8Array(bytes)], { type: 'application/pdf' })
  } finally {
    await loading.destroy()
  }
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw new DOMException('已取消', 'AbortError')
}
