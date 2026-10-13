import { expect, test, type Page } from '@playwright/test'
import { PDFDocument, degrees, rgb } from 'pdf-lib'

async function prepareDocument(page: Page, geometry?: 'rotation' | 'crop') {
  await page.goto('/')
  await expect(page.getByRole('button', { name: '本地资料', exact: true })).toBeVisible()
  const pdf = await PDFDocument.create()
  for (let index = 0; index < 2; index++) {
    const sheet = pdf.addPage([595, 842])
    if (geometry === 'rotation') sheet.setRotation(degrees(90))
    if (geometry === 'crop') sheet.setCropBox(30, 40, 500, 700)
    sheet.drawText(`Scan preview / page ${index + 1}`, { x: 50, y: 770, size: 22 })
    sheet.drawRectangle({ x: 50, y: 660, width: 90, height: 70, color: index === 0 ? rgb(0.1, 0.2, 0.7) : rgb(0.1, 0.7, 0.2) })
    sheet.drawText('Document, stamp and seam share the scan effect.', { x: 50, y: 610, size: 14 })
  }
  await page.getByLabel('导入工作区 PDF 或图片', { exact: true }).setInputFiles({
    name: 'scan-preview.pdf', mimeType: 'application/pdf', buffer: Buffer.from(await pdf.save())
  })
  await expect(page.locator('[data-page="1"] canvas')).toBeVisible()
  await expect.poll(() => page.evaluate(async () => Boolean((await import('/src/state/store.ts')).useEditorStore.getState().busy))).toBe(false)
  const stamp = await page.evaluate(() => {
    const canvas = document.createElement('canvas')
    canvas.width = 80; canvas.height = 60
    const context = canvas.getContext('2d')!
    context.fillStyle = '#d02030'
    context.fillRect(0, 0, 80, 60)
    return canvas.toDataURL().split(',')[1]
  })
  await page.getByLabel('导入印章', { exact: true }).setInputFiles({
    name: 'scan-stamp.png', mimeType: 'image/png', buffer: Buffer.from(stamp, 'base64')
  })
  await expect(page.getByRole('img', { name: 'scan-stamp.png', exact: true, includeHidden: true })).toHaveCount(1)
  await expect.poll(() => page.evaluate(async () => Boolean((await import('/src/state/store.ts')).useEditorStore.getState().busy))).toBe(false)
  // Deterministic geometry makes pixels prove both overlays are composed before
  // scanning; all preview entry/exit and preset changes below use real controls.
  await page.evaluate(async () => {
    const { useEditorStore, activeFile, activeConfig } = await import('/src/state/store.ts')
    const state = useEditorStore.getState()
    const stampId = state.stamps[0].stampId
    state.setConfig(activeFile(state)!.fileId, {
      ...activeConfig(state),
      placements: [{ id: 'scan-placement', stampId, pageNumber: 1, xPt: 100, yPt: 200, widthPt: 80, heightPt: 60, rotation: 0, opacity: 1 }],
      seamEnabled: true,
      seam: { ...activeConfig(state).seam, stampId, pages: '全部', sizePt: 60 },
      scanConfig: { ...activeConfig(state).scanConfig!, scale: 1, rotate: 0, rotateVariance: 0, blur: 0, noise: 0, brightness: 1, contrast: 1, yellowish: 0 }
    })
  })
}

for (const geometry of ['aspect', 'rotation', 'crop'] as const) {
  test(`scan preview matches generated page geometry and stamp pixels after ${geometry}`, async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 1000 })
    await prepareDocument(page, geometry === 'aspect' ? undefined : geometry)
    await page.evaluate(async (geometry) => {
      const { useEditorStore, activeFile, activeConfig } = await import('/src/state/store.ts')
      if (geometry === 'aspect') {
        const { replaceStampImage } = await import('/src/features/workspace/actions.ts')
        const canvas = document.createElement('canvas')
        canvas.width = 80; canvas.height = 120
        const context = canvas.getContext('2d')!
        context.fillStyle = '#d02030'
        context.fillRect(0, 0, 80, 120)
        const blob = await new Promise<Blob>((resolve) => canvas.toBlob((blob) => resolve(blob!), 'image/png'))
        if (!await replaceStampImage(useEditorStore.getState().stamps[0], blob, 'tall-stamp.png')) throw new Error('Fixture stamp replacement failed')
      }
      const state = useEditorStore.getState()
      const config = activeConfig(state)
      state.setConfig(activeFile(state)!.fileId, {
        ...config,
        placements: geometry === 'crop' ? [] : config.placements.map((placement) => ({ ...placement, rotation: geometry === 'aspect' ? 30 : 0 })),
        seamEnabled: geometry === 'crop',
        scanConfig: { ...config.scanConfig!, outputFormat: 'image/png' }
      })
    }, geometry)
    await page.getByRole('switch', { name: '启用扫描效果', exact: true }).click()
    await expect(page.locator('[data-page="1"]').getByTestId('scan-page-preview')).toHaveAttribute('aria-busy', 'false')
    const result = await page.evaluate(async () => {
      const { useEditorStore, activeFile } = await import('/src/state/store.ts')
      const { processFile } = await import('/src/features/generate/actions.ts')
      const { loadPdf } = await import('/src/lib/pdfjs.ts')
      const preview = document.querySelector<HTMLCanvasElement>('canvas[data-scan-canvas="1"]')!
      const previewPixels = preview.getContext('2d')!.getImageData(0, 0, preview.width, preview.height).data
      const previewSize = [preview.width, preview.height]
      const frame = document.querySelector('[data-page="1"]')!.getBoundingClientRect()
      const output = await processFile(activeFile(useEditorStore.getState())!)
      const loading = loadPdf(await output.blob.arrayBuffer())
      const renderedDoc = await loading.promise
      const pdfPage = await renderedDoc.getPage(1)
      const viewport = pdfPage.getViewport({ scale: 1 })
      const canvas = window.document.createElement('canvas')
      canvas.width = Math.round(viewport.width); canvas.height = Math.round(viewport.height)
      await pdfPage.render({ canvas, canvasContext: canvas.getContext('2d')!, viewport }).promise
      const pixels = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data
      let actual = 0, expected = 0, intersection = 0, union = 0
      const actualBounds = [Infinity, Infinity, -1, -1]
      for (let offset = 0; offset < pixels.length; offset += 4) {
        const isRed = (data: Uint8ClampedArray) => data[offset] > 120 && data[offset] > data[offset + 1] * 1.7 && data[offset] > data[offset + 2] * 1.5
        const a = isRed(previewPixels), b = isRed(pixels)
        if (a) {
          actual++
          const x = (offset / 4) % previewSize[0], y = Math.floor(offset / 4 / previewSize[0])
          actualBounds[0] = Math.min(actualBounds[0], x); actualBounds[1] = Math.min(actualBounds[1], y)
          actualBounds[2] = Math.max(actualBounds[2], x); actualBounds[3] = Math.max(actualBounds[3], y)
        }
        if (b) expected++
        if (a && b) intersection++
        if (a || b) union++
      }
      await loading.destroy()
      return { previewSize, outputSize: [canvas.width, canvas.height], actual, actualBounds, expected, overlap: union ? intersection / union : 1, frameRatio: frame.width / frame.height }
    })
    expect(result.previewSize).toEqual(result.outputSize)
    expect(result.frameRatio).toBeCloseTo(result.outputSize[0] / result.outputSize[1], 3)
    if (geometry === 'crop') {
      // The engine places the seam at MediaBox's right edge, outside CropBox.
      expect(result.expected).toBe(0)
      expect(result.actual, JSON.stringify(result)).toBe(0)
    } else {
      expect(result.expected).toBeGreaterThan(3000)
      expect(result.overlap).toBeGreaterThan(0.94)
    }
  })
}

async function sampledPixels(page: Page, pageNumber = 1) {
  return page.locator(`canvas[data-scan-canvas="${pageNumber}"]`).evaluate((element) => {
    const canvas = element as HTMLCanvasElement
    if (!canvas.width || !canvas.height) return []
    const context = canvas.getContext('2d')!
    return [[140, 612], [575, 421], [90, 147]].map(([x, y]) => Array.from(context.getImageData(x, y, 1, 1).data).slice(0, 3))
  })
}

test('central scan preview includes stamps and seams, follows pages and zoom, and exits without disabling output', async ({ page }, info) => {
  await page.setViewportSize({ width: 1440, height: 1000 })
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await prepareDocument(page)
  await page.getByRole('switch', { name: '启用扫描效果', exact: true }).click()
  const firstPreview = page.locator('[data-page="1"]').getByTestId('scan-page-preview')
  await expect(firstPreview).toHaveAttribute('aria-busy', 'false')
  await expect(page.getByRole('region', { name: '文档工作区' }).locator('canvas[data-scan-canvas="1"]')).toBeVisible()
  const color = await sampledPixels(page)
  for (const pixel of color.slice(0, 2)) expect(pixel[0]).toBeGreaterThan(pixel[1] * 2)
  await expect(page.locator('aside').filter({ has: page.getByRole('button', { name: '返回文档', exact: true }) }).locator('canvas')).toHaveCount(0)
  // Rapid changes must leave the final selected effect, including on the seal.
  await page.getByRole('button', { name: '黑白扫描', exact: true }).click()
  await page.getByRole('button', { name: '轻度扫描', exact: true }).click()
  await page.getByRole('button', { name: '黑白扫描', exact: true }).click()
  await expect(firstPreview).toHaveAttribute('aria-busy', 'false')
  const gray = await sampledPixels(page)
  expect(gray).toHaveLength(3)
  for (const pixel of gray) {
    expect(Math.max(...pixel) - Math.min(...pixel)).toBeLessThan(3)
    expect(pixel[0]).toBeLessThan(230)
  }
  await page.screenshot({ path: info.outputPath('scan-desktop.png'), fullPage: true, animations: 'disabled' })
  await page.keyboard.press('PageDown')
  await expect.poll(() => page.evaluate(async () => (await import('/src/state/store.ts')).useEditorStore.getState().currentPage)).toBe(2)
  await expect(page.locator('[data-page="2"]').getByTestId('scan-page-preview')).toHaveAttribute('aria-busy', 'false')
  const second = await sampledPixels(page, 2)
  expect(second[2][0]).toBeGreaterThan(gray[2][0] + 30)
  await page.getByRole('button', { name: /^\d+%$/ }).click()
  await page.getByRole('menuitem', { name: '100%', exact: true }).click()
  await expect(page.locator('[data-page="2"]')).toHaveCSS('width', '595px')
  expect(await sampledPixels(page, 2)).toEqual(second)
  const settings = await page.evaluate(async () => {
    const store = await import('/src/state/store.ts')
    return store.activeConfig(store.useEditorStore.getState()).scanConfig
  })
  await page.getByRole('button', { name: '退出预览', exact: true }).click()
  await expect(page.getByTestId('scan-preview-toolbar')).toHaveCount(0)
  await expect(page.getByRole('switch', { name: '启用扫描效果', exact: true })).toBeChecked()
  await page.getByTitle('点击编辑扫描效果参数').click()
  await page.getByRole('button', { name: '返回文档', exact: true }).click()
  await expect(page.getByRole('switch', { name: '启用扫描效果', exact: true })).toBeChecked()
  await page.getByTitle('点击编辑扫描效果参数').click()
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('scan-preview-toolbar')).toHaveCount(0)
  await page.getByTitle('点击编辑扫描效果参数').click()
  await page.getByRole('switch', { name: '生成时应用扫描效果', exact: true }).click()
  await expect(page.getByRole('switch', { name: '启用扫描效果', exact: true })).not.toBeChecked()
  expect(await page.evaluate(async () => {
    const store = await import('/src/state/store.ts')
    return store.activeConfig(store.useEditorStore.getState()).scanConfig
  })).toEqual(settings)
  expect(errors).toEqual([])
})

for (const width of [390, 320]) {
  test(`scan preview and return controls stay usable at ${width}px`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 844 })
    await prepareDocument(page)
    await page.getByRole('button', { name: '更多', exact: true }).click()
    await page.getByRole('menuitem', { name: '显示属性面板', exact: true }).click()
    await page.getByRole('switch', { name: '启用扫描效果', exact: true }).click()
    await expect(page.locator('[data-page="1"]').getByTestId('scan-page-preview')).toHaveAttribute('aria-busy', 'false')
    await expect(page.getByRole('button', { name: '退出预览', exact: true })).toBeVisible()
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width)
    await page.screenshot({ path: info.outputPath(`scan-mobile-${width}.png`), fullPage: true, animations: 'disabled' })
    await page.getByRole('button', { name: '调整参数', exact: true }).click()
    await expect(page.getByRole('button', { name: '返回文档', exact: true })).toBeVisible()
    await page.getByRole('button', { name: '黑白扫描', exact: true }).click()
    await page.getByRole('button', { name: '收起参数，查看预览', exact: true }).click()
    await expect(page.getByRole('button', { name: '退出预览', exact: true })).toBeVisible()
    await page.getByRole('button', { name: '退出预览', exact: true }).click()
    await expect(page.getByTestId('scan-preview-toolbar')).toHaveCount(0)
    await page.getByRole('button', { name: '更多', exact: true }).click()
    await page.getByRole('menuitem', { name: '显示属性面板', exact: true }).click()
    await expect(page.getByRole('switch', { name: '启用扫描效果', exact: true })).toBeChecked()
    await page.getByTitle('点击编辑扫描效果参数').click()
    await page.getByRole('button', { name: '调整参数', exact: true }).click()
    await page.getByRole('button', { name: '返回文档', exact: true }).click()
    await expect(page.getByTestId('scan-preview-toolbar')).toHaveCount(0)
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width)
  })
}
