import { expect, test } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import { PDFDocument, rgb } from 'pdf-lib'

test('a fresh production tab reloads offline and can first-use stamping, encryption and backup', async ({ page, context }) => {
  const unexpected: string[] = []
  const errors: string[] = []
  context.on('request', (request) => {
    const url = new URL(request.url())
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return
    if (url.origin !== 'http://127.0.0.1:4174' || !['GET', 'HEAD'].includes(request.method()) || /^\/(api|auth)(\/|$)/.test(url.pathname)) unexpected.push(request.url())
  })
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto('/')
  await page.getByRole('button', { name: '本地资料', exact: true }).click()
  await expect(page.getByTestId('offline-status')).toHaveText('离线已就绪', { timeout: 30_000 })
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true)
  await page.keyboard.press('Escape')
  const stamp = await page.evaluate(() => {
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = 100
    const ctx = canvas.getContext('2d')!
    ctx.strokeStyle = '#bc2525'
    ctx.lineWidth = 8
    ctx.strokeRect(12, 12, 76, 76)
    return canvas.toDataURL('image/png').split(',')[1]
  })
  await page.getByLabel('导入印章', { exact: true }).setInputFiles({ name: 'offline-stamp.png', mimeType: 'image/png', buffer: Buffer.from(stamp, 'base64') })
  await expect(page.getByRole('img', { name: 'offline-stamp.png', exact: true })).toHaveCount(1)
  // No PDF, scan or encryption has been used yet. All their resources must be
  // available from the precache rather than a lucky warm HTTP/module cache.
  await context.setOffline(true)
  await page.reload()
  await expect(page.getByRole('img', { name: 'offline-stamp.png', exact: true })).toHaveCount(1)
  await page.getByRole('button', { name: '本地资料', exact: true }).click()
  await expect(page.getByTestId('offline-status')).toHaveText('离线已就绪')
  await page.keyboard.press('Escape')
  const doc = await PDFDocument.create()
  for (let i = 0; i < 2; i++) {
    const sheet = doc.addPage([595, 842])
    sheet.drawRectangle({ x: 60, y: 600, width: 300, height: 60, color: rgb(0.2, 0.4, 0.6) })
  }
  await page.getByLabel('导入工作区 PDF 或图片', { exact: true }).setInputFiles({ name: 'offline-document.pdf', mimeType: 'application/pdf', buffer: Buffer.from(await doc.save()) })
  await expect(page.locator('[data-page="1"] canvas')).toBeVisible()
  await page.locator('[data-shelf-item]').getByRole('button', { name: 'offline-stamp.png', exact: true }).click()
  await page.locator('[data-page="1"]').click({ position: { x: 240, y: 300 } })
  await page.keyboard.press('Escape')
  await expect(page.locator('[data-placement-id]')).toHaveCount(1)
  await page.getByRole('button', { name: '输出设置', exact: true }).click()
  await page.getByRole('textbox', { name: /^打开密码（可选）/ }).fill('offline-only-password')
  const downloadPromise = page.waitForEvent('download')
  await page.getByRole('button', { name: '生成', exact: true }).click()
  const download = await downloadPromise
  const output = await readFile((await download.path())!)
  expect(output.subarray(0, 5).toString()).toBe('%PDF-')
  await expect(PDFDocument.load(output)).rejects.toThrow(/encrypted/i)
  await page.getByRole('button', { name: '本地资料', exact: true }).click()
  const backupPromise = page.waitForEvent('download')
  await page.getByRole('menuitem', { name: '导出备份…', exact: true }).click()
  const backup = await backupPromise
  expect(backup.suggestedFilename()).toMatch(/\.zip$/)
  const cached = await page.evaluate(async () => {
    const entries: string[] = []
    for (const name of await caches.keys()) {
      if (name.startsWith('hlool-pdf-app:')) entries.push(...(await (await caches.open(name)).keys()).map((request) => request.url))
    }
    return entries
  })
  expect(cached.some((url) => url.endsWith('.wasm'))).toBe(true)
  expect(cached.some((url) => url.includes('stampWorker-'))).toBe(true)
  for (const resource of ['pdfjs/cmaps/UniGB-UCS2-H.bcmap', 'pdfjs/standard_fonts/FoxitSymbol.pfb', 'pdfjs/wasm/openjpeg.wasm', 'pdfjs/iccs/CGATS001Compat-v2-micro.icc']) {
    expect(cached.some((url) => url.endsWith(resource))).toBe(true)
    const length = await page.evaluate(async (path) => {
      const response = await fetch(path)
      if (!response.ok) throw new Error(`Offline resource unavailable: ${path}`)
      return (await response.arrayBuffer()).byteLength
    }, resource)
    expect(length).toBeGreaterThan(0)
  }
  expect(cached.some((url) => /offline-document|offline-stamp|\.pdf$|\.zip$/.test(url))).toBe(false)
  expect(unexpected).toEqual([])
  expect(errors).toEqual([])
})
