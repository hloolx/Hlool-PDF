import { expect, test, type Page } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import JSZip from 'jszip'
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib'

async function monitorLocalOnly(page: Page) {
  const requests: string[] = []
  const errors: string[] = []
  page.on('request', (request) => {
    if (new URL(request.url()).pathname.startsWith('/api/')) requests.push(request.url())
  })
  page.on('pageerror', (error) => errors.push(error.message))
  await page.route('**/api/**', (route) => route.abort())
  return { requests, errors }
}

async function openWorkspace(page: Page) {
  await page.goto('/')
  await expect(page.getByRole('button', { name: '本地资料', exact: true })).toBeVisible()
  await expect(page.getByText('把 PDF / 图片拖进窗口开始')).toBeVisible()
  await expect(page.getByRole('button', { name: /登录|注册|账户/ })).toHaveCount(0)
}

async function importStamp(page: Page, name = 'test-stamp.png') {
  const base64 = await page.evaluate(() => {
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = 160
    const context = canvas.getContext('2d')!
    context.fillStyle = '#fff'
    context.fillRect(0, 0, 160, 160)
    context.strokeStyle = '#b71c38'
    context.lineWidth = 9
    context.beginPath()
    context.arc(80, 80, 58, 0, Math.PI * 2)
    context.stroke()
    context.fillStyle = '#b71c38'
    context.font = 'bold 24px sans-serif'
    context.textAlign = 'center'
    context.fillText('TEST', 80, 88)
    return canvas.toDataURL('image/png').split(',')[1]
  })
  await page.getByLabel('导入印章', { exact: true }).setInputFiles({ name, mimeType: 'image/png', buffer: Buffer.from(base64, 'base64') })
  await expect(page.getByRole('img', { name, exact: true })).toHaveCount(1)
}

async function importPdf(page: Page) {
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  for (let i = 1; i <= 2; i += 1) {
    const sheet = doc.addPage([595, 842])
    sheet.drawText('Hlool PDF - Browser workspace', { x: 64, y: 754, size: 20, font, color: rgb(0.12, 0.17, 0.23) })
    sheet.drawText(`Local document / page ${i}`, { x: 64, y: 718, size: 12, font })
    sheet.drawLine({ start: { x: 64, y: 690 }, end: { x: 531, y: 690 }, thickness: 1, color: rgb(0.7, 0.73, 0.76) })
    sheet.drawText('Prepared and stamped entirely in this browser.', { x: 64, y: 652, size: 13, font })
  }
  await page.getByLabel('导入工作区 PDF 或图片', { exact: true }).setInputFiles({ name: 'browser-workspace.pdf', mimeType: 'application/pdf', buffer: Buffer.from(await doc.save()) })
  await expect(page.locator('[data-page="1"] canvas')).toBeVisible()
}

test('desktop local workspace exports a portable backup and restores stamps and preferences', async ({ page }, info) => {
  await page.setViewportSize({ width: 1440, height: 1000 })
  const traffic = await monitorLocalOnly(page)
  await openWorkspace(page)
  const repository = page.getByRole('link', { name: 'GitHub 项目仓库（新标签页）', exact: true })
  await expect(repository).toBeVisible()
  await expect(repository).toHaveAttribute('href', 'https://github.com/hloolx/Hlool-PDF')
  await expect(repository).toHaveAttribute('target', '_blank')
  await importStamp(page)
  const stamp = page.locator('[data-shelf-item]').filter({ has: page.getByRole('img', { name: 'test-stamp.png', exact: true }) })
  await stamp.hover()
  await stamp.getByTitle('别名与默认尺寸').click()
  await page.getByLabel('显示名称', { exact: true }).fill('本机测试印章')
  await page.keyboard.press('Escape')
  await importPdf(page)
  const stampButton = page.locator('[data-shelf-item]').filter({ has: page.getByRole('img', { name: '本机测试印章', exact: true }) }).getByRole('button').first()
  await stampButton.focus()
  await page.keyboard.press('Enter')
  await page.locator('[data-page="1"]').click({ position: { x: 240, y: 290 } })
  await page.keyboard.press('Escape')
  await expect(page.locator('[data-placement-id]')).toHaveCount(1)
  await page.screenshot({ path: info.outputPath('desktop-workspace.png'), fullPage: true, animations: 'disabled' })

  await page.getByRole('button', { name: '本地资料', exact: true }).click()
  await expect(page.getByRole('menu')).toContainText('不包含 PDF 文件或密码')
  await expect(page.getByTestId('offline-status')).toBeVisible()
  const downloadPromise = page.waitForEvent('download')
  await page.getByRole('menuitem', { name: '导出备份…', exact: true }).click()
  const download = await downloadPromise
  const path = await download.path()
  expect(path).not.toBeNull()
  const bytes = await readFile(path!)
  const zip = await JSZip.loadAsync(bytes)
  const manifest = JSON.parse(await zip.file('manifest.json')!.async('string'))
  expect(manifest.stamps).toHaveLength(1)
  expect(Object.values(manifest.settings.stampMeta)[0]).toMatchObject({ alias: '本机测试印章' })
  expect(Object.keys(zip.files).every((name) => name === 'manifest.json' || name.startsWith('images/'))).toBe(true)
  expect(JSON.stringify(manifest)).not.toContain('browser-workspace.pdf')
  await page.screenshot({ path: info.outputPath('desktop-local-data.png'), fullPage: true, animations: 'disabled' })
  await page.keyboard.press('Escape')

  await stampButton.hover()
  const deleteButton = page.getByRole('button', { name: '删除印章', exact: true })
  await deleteButton.click()
  await page.getByRole('button', { name: '再点一次删除', exact: true }).click()
  await expect(page.getByRole('img', { name: '本机测试印章', exact: true })).toHaveCount(0)
  await page.getByRole('button', { name: '本地资料', exact: true }).click()
  await page.getByLabel('选择本地资料备份', { exact: true }).setInputFiles({ name: 'library.zip', mimeType: 'application/zip', buffer: bytes })
  await expect(page.getByRole('menu')).toContainText('已导入 1 个印章')
  await page.keyboard.press('Escape')
  await expect(page.getByRole('img', { name: '本机测试印章', exact: true })).toHaveCount(1)
  page.once('dialog', (dialog) => dialog.accept())
  await page.reload()
  await expect(page.getByRole('img', { name: '本机测试印章', exact: true })).toHaveCount(1)
  await expect(page.getByText('把 PDF / 图片拖进窗口开始')).toBeVisible()
  expect(traffic.requests).toEqual([])
  expect(traffic.errors).toEqual([])
})

test('local white-background removal previews transparent pixels and saves without uploading', async ({ page }, info) => {
  const traffic = await monitorLocalOnly(page)
  await openWorkspace(page)
  await importStamp(page, 'white-stamp.png')
  await page.getByRole('button', { name: '撤销去底', exact: true }).click()
  await expect(page.getByText('已恢复为原图', { exact: true })).toBeVisible()
  const original = page.locator('[data-shelf-item]').filter({ has: page.getByRole('img', { name: 'white-stamp.png', exact: true }) })
  await original.hover()
  await original.getByRole('button', { name: '本地白底透明化', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '本地白底透明化' })
  await expect(dialog).toContainText('图片不上传')
  await dialog.getByRole('button', { name: '预览效果' }).click()
  const preview = dialog.getByRole('img', { name: '去白底后的印章' })
  await expect(preview).toBeVisible()
  const alpha = await preview.evaluate((image: HTMLImageElement) => {
    const canvas = document.createElement('canvas')
    canvas.width = image.naturalWidth
    canvas.height = image.naturalHeight
    const context = canvas.getContext('2d')!
    context.drawImage(image, 0, 0)
    return context.getImageData(0, 0, 1, 1).data[3]
  })
  expect(alpha).toBe(0)
  await page.screenshot({ path: info.outputPath('local-white-background.png'), fullPage: true, animations: 'disabled' })
  await dialog.getByRole('button', { name: '另存为新印章' }).evaluate((button: HTMLButtonElement) => { button.click(); button.click() })
  await expect(dialog).toHaveCount(0)
  await expect(page.locator('[data-shelf-item] img')).toHaveCount(2)
  await expect(page.getByRole('img', { name: 'white-stamp-透明.png', exact: true })).toHaveCount(1)
  await original.hover()
  await original.getByRole('button', { name: '本地白底透明化', exact: true }).click()
  await dialog.getByRole('button', { name: '预览效果' }).click()
  await expect(dialog.getByRole('img', { name: '去白底后的印章' })).toBeVisible()
  await dialog.getByRole('button', { name: '替换原印章' }).click()
  await expect(dialog).toHaveCount(0)
  await page.reload()
  await expect(page.locator('[data-shelf-item] img')).toHaveCount(2)
  expect(traffic.requests).toEqual([])
  expect(traffic.errors).toEqual([])
})

test('390px mobile workspace keeps controls and backup feedback inside the viewport', async ({ page }, info) => {
  await page.setViewportSize({ width: 390, height: 844 })
  const traffic = await monitorLocalOnly(page)
  await openWorkspace(page)
  await page.getByRole('button', { name: '更多', exact: true }).click()
  const repository = page.getByRole('menuitem', { name: /GitHub 项目仓库/ })
  await expect(repository).toBeVisible()
  await expect(repository).toHaveAttribute('href', 'https://github.com/hloolx/Hlool-PDF')
  await expect(repository).toHaveAttribute('target', '_blank')
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: '拉出缩略图与印章架' }).click()
  await importStamp(page)
  await page.getByRole('button', { name: '收起缩略图与印章架', exact: true }).click()
  await importPdf(page)
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
  await page.screenshot({ path: info.outputPath('mobile-workspace.png'), fullPage: true, animations: 'disabled' })
  const headerBox = await page.locator('header').boundingBox()
  const generateBox = await page.getByRole('button', { name: '生成选项' }).boundingBox()
  expect(headerBox!.width).toBeLessThanOrEqual(390)
  expect(generateBox!.x + generateBox!.width).toBeLessThanOrEqual(390)
  await page.getByRole('button', { name: '本地资料', exact: true }).click()
  await expect(page.getByRole('menuitem', { name: '导入备份…' })).toBeVisible()
  await page.getByLabel('选择本地资料备份', { exact: true }).setInputFiles({ name: 'invalid.zip', mimeType: 'application/zip', buffer: Buffer.from('invalid backup') })
  await expect(page.getByRole('menu').getByRole('alert')).toContainText('导入备份失败')
  await expect(page.getByRole('menuitem', { name: '导入备份…' })).toBeEnabled()
  await page.screenshot({ path: info.outputPath('mobile-local-data.png'), fullPage: true, animations: 'disabled' })
  const menuBox = await page.getByRole('menu').boundingBox()
  expect(menuBox!.x).toBeGreaterThanOrEqual(0)
  expect(menuBox!.x + menuBox!.width).toBeLessThanOrEqual(390)
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: '拉出缩略图与印章架' }).click()
  await expect(page.getByRole('button', { name: '本地白底透明化', exact: true })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('button', { name: '拉出缩略图与印章架' })).toBeFocused()
  await page.setViewportSize({ width: 320, height: 568 })
  await page.getByRole('button', { name: '本地资料', exact: true }).click()
  const smallMenuBox = await page.getByRole('menu').boundingBox()
  expect(smallMenuBox!.y).toBeGreaterThanOrEqual(0)
  expect(smallMenuBox!.y + smallMenuBox!.height).toBeLessThanOrEqual(568)
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320)
  await page.getByRole('menuitem', { name: '导入备份…' }).scrollIntoViewIfNeeded()
  await expect(page.getByRole('menuitem', { name: '导入备份…' })).toBeVisible()
  expect(traffic.requests).toEqual([])
  expect(traffic.errors).toEqual([])
})

test('blocked browser storage shows a recoverable boot error instead of an empty library', async ({ page }) => {
  const traffic = await monitorLocalOnly(page)
  await page.addInitScript(() => {
    const open = indexedDB.open.bind(indexedDB)
    indexedDB.open = function (...args: Parameters<IDBFactory['open']>) {
      indexedDB.open = open
      throw new DOMException('Storage blocked for test', 'SecurityError')
    }
  })
  await page.goto('/')
  await expect(page.getByRole('heading', { name: '无法打开本地资料' })).toBeVisible()
  await expect(page.getByText('把 PDF / 图片拖进窗口开始')).toHaveCount(0)
  await page.getByRole('button', { name: '重新加载本地资料' }).click()
  await expect(page.getByRole('button', { name: '本地资料', exact: true })).toBeVisible()
  expect(traffic.requests).toEqual([])
  expect(traffic.errors).toEqual([])
})

test('backup excludes overlapping actions and warns before a pending operation is interrupted', async ({ page }) => {
  const traffic = await monitorLocalOnly(page)
  await openWorkspace(page)
  await importStamp(page)
  // Hold actual backup hashing so the busy state spans user interaction without timing assumptions.
  await page.evaluate(() => {
    const digest = crypto.subtle.digest.bind(crypto.subtle)
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    crypto.subtle.digest = async (...args: Parameters<SubtleCrypto['digest']>) => { await gate; return digest(...args) }
    Object.assign(window, { releaseBackupHash: () => { crypto.subtle.digest = digest; release() } })
  })
  const downloads: string[] = []
  page.on('download', (download) => downloads.push(download.suggestedFilename()))
  await page.getByRole('button', { name: '本地资料', exact: true }).click()
  const downloadPromise = page.waitForEvent('download')
  await page.getByRole('menuitem', { name: '导出备份…', exact: true }).evaluate((item: HTMLElement) => { item.click(); item.click() })
  await expect(page.getByRole('menuitem', { name: '正在导出备份…', exact: true })).toBeDisabled()
  await expect(page.getByRole('menuitem', { name: '导入备份…', exact: true })).toBeDisabled()
  await page.keyboard.press('Escape')
  await expect(page.getByLabel('导入工作区 PDF 或图片', { exact: true })).toBeDisabled()
  await expect(page.getByLabel('导入印章', { exact: true })).toBeDisabled()
  await expect(page.getByRole('button', { name: '生成', exact: true })).toBeDisabled()
  const warning = page.waitForEvent('dialog')
  await page.evaluate(() => { window.setTimeout(() => window.location.reload(), 0) })
  const dialog = await warning
  expect(dialog.type()).toBe('beforeunload')
  await dialog.dismiss()
  await page.evaluate(() => (window as unknown as { releaseBackupHash: () => void }).releaseBackupHash())
  await downloadPromise
  await expect(page.getByLabel('导入印章', { exact: true })).toBeEnabled()
  expect(downloads).toHaveLength(1)
  expect(traffic.requests).toEqual([])
  expect(traffic.errors).toEqual([])
})

test('document refresh can be cancelled, hidden desktop panels and menus cannot alter the canvas', async ({ page }) => {
  const traffic = await monitorLocalOnly(page)
  await page.setViewportSize({ width: 1440, height: 900 })
  await openWorkspace(page)
  await importStamp(page)
  await importPdf(page)
  await page.getByRole('button', { name: 'test-stamp.png', exact: true }).click()
  await page.locator('[data-page="1"]').click({ position: { x: 240, y: 290 } })
  await page.keyboard.press('Escape')
  await page.locator('[data-placement-id]').click()
  await page.getByRole('button', { name: '本地资料', exact: true }).click()
  await page.keyboard.press('Delete')
  await expect(page.locator('[data-placement-id]')).toHaveCount(1)
  await page.keyboard.press('Escape')
  await page.locator('[data-panel-toggle="left"]').click()
  await expect(page.getByRole('button', { name: 'test-stamp.png', exact: true })).toHaveCount(0)
  await page.getByRole('button', { name: '切换右侧面板', exact: true }).click()
  await expect(page.getByRole('complementary')).toHaveCount(0)
  const warning = page.waitForEvent('dialog')
  await page.evaluate(() => { window.setTimeout(() => window.location.reload(), 0) })
  const dialog = await warning
  expect(dialog.type()).toBe('beforeunload')
  await dialog.dismiss()
  await expect(page.locator('[data-placement-id]')).toHaveCount(1)
  page.once('dialog', (nextDialog) => nextDialog.accept())
  await page.reload()
  await expect(page.getByText('把 PDF / 图片拖进窗口开始')).toBeVisible()
  expect(traffic.requests).toEqual([])
  expect(traffic.errors).toEqual([])
})

test('matting keeps its source snapshot and cannot overwrite a newer stamp from another tab', async ({ page, context }) => {
  const traffic = await monitorLocalOnly(page)
  await openWorkspace(page)
  await importStamp(page, 'versioned-stamp.png')
  const originalStamp = page.locator('[data-shelf-item]').filter({ has: page.getByRole('img', { name: 'versioned-stamp.png', exact: true }) })
  await originalStamp.hover()
  await originalStamp.getByRole('button', { name: '本地白底透明化', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '本地白底透明化' })
  const originalUrl = await dialog.getByRole('img', { name: '印章原图', exact: true }).getAttribute('src')
  await dialog.getByRole('button', { name: '预览效果', exact: true }).click()
  await expect(dialog.getByRole('img', { name: '去白底后的印章', exact: true })).toBeVisible()

  const other = await context.newPage()
  await openWorkspace(other)
  const newer = await other.evaluate(async () => {
    const storage = await import('/src/features/library/storage.ts')
    const stamp = (await storage.readLibrarySnapshot()).stamps[0]
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = 160
    const drawing = canvas.getContext('2d')!
    drawing.fillStyle = '#1234dd'
    drawing.fillRect(0, 0, 160, 160)
    const blob = await new Promise<Blob>((resolve) => canvas.toBlob((result) => resolve(result!), 'image/png'))
    await storage.replaceStoredStamp(stamp.stampId, blob, 'updated-in-another-tab.png')
    const updated = (await storage.readLibrarySnapshot()).stamps[0]
    return { stampId: updated.stampId, digest: updated.digest }
  })
  await page.bringToFront()
  await expect(dialog.getByRole('img', { name: '印章原图', exact: true })).toHaveAttribute('src', originalUrl!)
  await dialog.getByRole('button', { name: '替换原印章', exact: true }).click()
  await expect(dialog.getByRole('alert')).toContainText('已在其他窗口更新')
  await expect(dialog.getByRole('img', { name: '去白底后的印章', exact: true })).toBeVisible()
  await expect(dialog.getByRole('button', { name: '另存为新印章', exact: true })).toBeEnabled()
  const preserved = await other.evaluate(async (id) => (await (await import('/src/features/library/storage.ts')).readLibrarySnapshot()).stamps.find((stamp) => stamp.stampId === id)!.digest, newer.stampId)
  expect(preserved).toBe(newer.digest)
  await dialog.getByRole('button', { name: '另存为新印章', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  await expect(page.locator('[data-shelf-item] img')).toHaveCount(2)
  const after = await other.evaluate(async (id) => (await (await import('/src/features/library/storage.ts')).readLibrarySnapshot()).stamps.find((stamp) => stamp.stampId === id)!.digest, newer.stampId)
  expect(after).toBe(newer.digest)
  await other.close()
  expect(traffic.requests).toEqual([])
  expect(traffic.errors).toEqual([])
})
