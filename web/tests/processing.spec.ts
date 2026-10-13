import { expect, test, type Page } from '@playwright/test'
import { PDFDocument, PDFName, rgb } from 'pdf-lib'
import createQpdf from '@neslinesli93/qpdf-wasm'
import { createRequire } from 'node:module'
import { readFile } from 'node:fs/promises'
import JSZip from 'jszip'

const require = createRequire(import.meta.url)

async function sourcePdf(width = 200, count = 2): Promise<number[]> {
  const document = await PDFDocument.create()
  for (let n = 0; n < count; n++) {
    const page = document.addPage([width, 300])
    page.drawRectangle({ x: 10, y: 10, width: 50 + n * 10, height: 80, color: rgb(0.2, 0.4, 0.7) })
  }
  return Array.from(await document.save())
}

async function noUploadPage(page: Page, renderWorkspace = true) {
  const forbidden: string[] = []
  await page.route('**/*', async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    if (!['GET', 'HEAD'].includes(request.method()) || /^\/(api|auth)(\/|$)/.test(url.pathname)
      || (url.protocol.startsWith('http') && !['127.0.0.1', 'localhost'].includes(url.hostname))) {
      forbidden.push(`${request.method()} ${request.url()}`)
      await route.abort()
    } else if (!renderWorkspace && url.pathname === '/__processing_harness__') {
      await route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body><main>Processing test harness</main></body></html>' })
    } else await route.continue()
  })
  await page.goto(renderWorkspace ? '/' : '/__processing_harness__')
  await page.waitForLoadState('networkidle')
  return forbidden
}

test('real Worker stamps from IndexedDB, applies seams and scan, and encrypts entirely in the browser', async ({ page }) => {
  const forbidden = await noUploadPage(page)
  const workers: string[] = []
  page.on('worker', (worker) => workers.push(worker.url()))
  const source = await sourcePdf()
  const result = await page.evaluate(async (data) => {
    const { encryptPdf, decryptPdf } = await import('/src/features/generate/qpdf.ts')
    const { makePdfFile } = await import('/src/lib/pdfDoc.ts')
    const { useEditorStore } = await import('/src/state/store.ts')
    const { emptyConfig, DEFAULT_SCAN } = await import('/src/lib/types.ts')
    const { saveStamp } = await import('/src/features/library/storage.ts')
    const { processFile } = await import('/src/features/generate/actions.ts')
    const encrypted = await encryptPdf(new Uint8Array(data), 'input-password')
    const file = await makePdfFile(new Blob([encrypted], { type: 'application/pdf' }), '浏览器测试.pdf', 'input-password')
    const canvas = document.createElement('canvas')
    canvas.width = 100
    canvas.height = 60
    const context = canvas.getContext('2d')!
    context.fillStyle = '#d22'
    context.fillRect(5, 5, 90, 50)
    const image = await new Promise<Blob>((resolve) => canvas.toBlob((blob) => resolve(blob!), 'image/png'))
    const stamp = await saveStamp(image, '本机测试印章.png')
    const state = useEditorStore.getState()
    state.setStamps([stamp])
    state.upsertFiles([file])
    state.setOutputPassword('output-password')
    const config = emptyConfig()
    config.placements = [{ id: 'placement-test', stampId: stamp.stampId, pageNumber: 1, xPt: 50, yPt: 80, widthPt: 50, heightPt: 30, rotation: 20, opacity: 0.8 }]
    config.seamEnabled = true
    config.seam = { ...config.seam, stampId: stamp.stampId, pages: 'all', sizePt: 50 }
    config.scanEnabled = true
    config.scanConfig = { ...DEFAULT_SCAN, scale: 1 }
    state.setConfig(file.fileId, config)
    const output = await processFile(file)
    const bytes = new Uint8Array(await output.blob.arrayBuffer())
    let wrongPassword = ''
    try { await decryptPdf(bytes, 'wrong-password') } catch (error) { wrongPassword = String(error) }
    const decrypted = await decryptPdf(bytes, 'output-password')
    return { bytes: Array.from(decrypted), wrongPassword, name: output.name, changed: output.blob.size !== file.blob.size }
  }, source)
  expect(result.wrongPassword).toContain('检查打开密码')
  expect(result.changed).toBe(true)
  expect(result.name).toMatch(/\.pdf$/)
  expect(workers.some((url) => url.includes('stampWorker'))).toBe(true)
  const output = await PDFDocument.load(new Uint8Array(result.bytes))
  expect(output.getPageCount()).toBe(2)
  for (const pdfPage of output.getPages()) {
    expect([pdfPage.getWidth(), pdfPage.getHeight()]).toEqual([200, 300])
    expect(pdfPage.node.Resources()?.has(PDFName.of('XObject'))).toBe(true)
  }
  expect(forbidden).toEqual([])
})

test('different input passwords and empty user password compose with local qpdf', async ({ page }) => {
  const forbidden = await noUploadPage(page)
  const first = await sourcePdf(200, 1)
  const second = await sourcePdf(400, 1)
  // Node only builds an owner-protected fixture; the app's real browser qpdf performs its decryption.
  const module = await (createQpdf as unknown as (options: object) => Promise<{
    callMain(args: string[]): number
    FS: { writeFile(path: string, bytes: Uint8Array): void; readFile(path: string): Uint8Array }
  }>)({ locateFile: () => require.resolve('@neslinesli93/qpdf-wasm/dist/qpdf.wasm'), noInitialRun: true })
  module.FS.writeFile('/source.pdf', new Uint8Array(first))
  expect(module.callMain(['--encrypt', '', 'owner-password', '256', '--', '/source.pdf', '/protected.pdf'])).toBe(0)
  const protectedSource = Array.from(module.FS.readFile('/protected.pdf'))
  const result = await page.evaluate(async ({ first, second, protectedSource }) => {
    const { encryptPdf } = await import('/src/features/generate/qpdf.ts')
    const { composePdf } = await import('/src/features/workspace/actions.ts')
    const firstEncrypted = await encryptPdf(new Uint8Array(first), 'first-password')
    const secondEncrypted = await encryptPdf(new Uint8Array(second), 'second-password')
    const sources = [new Blob([firstEncrypted]), new Blob([secondEncrypted]), new Blob([new Uint8Array(protectedSource)])]
    const refs = [{ file: 1, pageNumber: 1 }, { file: 0, pageNumber: 1, rotate: 90 }, { file: 2, pageNumber: 1 }]
    const output = await composePdf(sources, refs, '合并.pdf', ['first-password', 'second-password', undefined])
    let wrongPassword = ''
    try { await composePdf(sources, refs, '不应生成.pdf', ['wrong-password', 'second-password', undefined]) }
    catch (error) { wrongPassword = String(error) }
    return { bytes: Array.from(new Uint8Array(await output.arrayBuffer())), wrongPassword }
  }, { first, second, protectedSource })
  const output = await PDFDocument.load(new Uint8Array(result.bytes))
  expect(output.getPages().map((pdfPage) => [pdfPage.getWidth(), pdfPage.getHeight()])).toEqual([[400, 300], [300, 200], [200, 300]])
  expect(result.wrongPassword).toContain('检查打开密码')
  expect(forbidden).toEqual([])
})

test('oversized and damaged inputs fail locally without server fallback', async ({ page }) => {
  const forbidden = await noUploadPage(page)
  const result = await page.evaluate(async (source) => {
    const { useEditorStore } = await import('/src/state/store.ts')
    const { processDetachedPdf } = await import('/src/features/generate/actions.ts')
    const blob = new Blob([new Uint8Array(source)], { type: 'application/pdf' })
    useEditorStore.getState().setLocalMaxMB(0.00001)
    let limitError = ''
    try { await processDetachedPdf(blob, [], '', '超限.pdf') } catch (error) { limitError = String(error) }
    useEditorStore.getState().setLocalMaxMB(0)
    let damagedError = ''
    try { await processDetachedPdf(new Blob(['not a PDF']), [], 'password', '损坏.pdf') }
    catch (error) { damagedError = String(error) }
    return { limitError, damagedError }
  }, await sourcePdf())
  expect(result.limitError).toContain('本地处理上限')
  expect(result.damagedError).toContain('重新导出')
  expect(forbidden).toEqual([])
})

test('batch export freezes names, configurations and passwords when editing changes during the first job', async ({ page }) => {
  const forbidden = await noUploadPage(page)
  const downloaded = page.waitForEvent('download')
  const stateAfter = await page.evaluate(async (data) => {
    const { useEditorStore } = await import('/src/state/store.ts')
    const { makePdfFile } = await import('/src/lib/pdfDoc.ts')
    const { emptyConfig, DEFAULT_SCAN } = await import('/src/lib/types.ts')
    const { generateAll } = await import('/src/features/generate/actions.ts')
    const blob = new Blob([new Uint8Array(data)], { type: 'application/pdf' })
    const files = [await makePdfFile(blob, 'one.pdf'), await makePdfFile(blob, 'two.pdf')]
    const state = useEditorStore.getState()
    state.upsertFiles(files)
    state.setOutputPassword('initial-password')
    state.setOutputNameTemplate('{原名}-initial')
    for (const file of files) state.setConfig(file.fileId, { ...emptyConfig(), scanEnabled: true, scanConfig: { ...DEFAULT_SCAN, scale: 1 } })
    let changed = false
    const unsubscribe = useEditorStore.subscribe((next) => {
      if (!changed && next.busy.includes('正在生成 1/2：本地处理中')) {
        changed = true
        next.setOutputPassword('later-password')
        next.setOutputNameTemplate('{原名}-later')
        next.setConfig(files[1].fileId, emptyConfig())
      }
    })
    try { await generateAll() } finally { unsubscribe() }
    return { changed, busy: useEditorStore.getState().busy }
  }, await sourcePdf(200, 1))
  expect(stateAfter).toEqual({ changed: true, busy: '' })
  const download = await downloaded
  const archive = await JSZip.loadAsync(await readFile((await download.path())!))
  expect(Object.keys(archive.files).sort()).toEqual(['one-initial.pdf', 'two-initial.pdf'])
  for (const file of Object.values(archive.files)) {
    const decrypted = await page.evaluate(async (bytes) => {
      const { decryptPdf } = await import('/src/features/generate/qpdf.ts')
      return Array.from(await decryptPdf(new Uint8Array(bytes), 'initial-password'))
    }, Array.from(await file.async('uint8array')))
    expect((await PDFDocument.load(new Uint8Array(decrypted))).getPageCount()).toBe(1)
  }
  expect(forbidden).toEqual([])
})

test('single-page export uses its own file configuration even when another file is active', async ({ page }) => {
  const forbidden = await noUploadPage(page)
  const downloaded = page.waitForEvent('download')
  await page.evaluate(async (data) => {
    const { makePdfFile } = await import('/src/lib/pdfDoc.ts')
    const { useEditorStore } = await import('/src/state/store.ts')
    const { emptyConfig } = await import('/src/lib/types.ts')
    const { exportPagePdf } = await import('/src/features/viewer/pageActions.ts')
    const source = await makePdfFile(new Blob([new Uint8Array(data)]), 'original.pdf')
    const other = { ...source, fileId: 'other-file', name: 'other.pdf' }
    useEditorStore.getState().upsertFiles([source, other])
    useEditorStore.setState({ activeFileId: other.fileId })
    useEditorStore.getState().setConfig(other.fileId, {
      ...emptyConfig(), placements: [{ id: 'other-placement', stampId: 'stamp_missing_in_other_file', pageNumber: 1, xPt: 10, yPt: 10, widthPt: 20, heightPt: 20, rotation: 0, opacity: 1 }]
    })
    await exportPagePdf(null, source, source.pages[0])
  }, await sourcePdf(200, 1))
  const download = await downloaded
  expect(download.suggestedFilename()).toBe('original-第1页.pdf')
  expect((await PDFDocument.load(await readFile((await download.path())!))).getPage(0).getWidth()).toBe(200)
  expect(forbidden).toEqual([])
})

test('page operations preserve a newer file, migrate intervening edits, and retain unrelated undo history', async ({ page }) => {
  // Exercise state/engine integration without mounting Viewer: its initial scroll tracking
  // intentionally sets currentPage to the visible page, independently of a background edit.
  const forbidden = await noUploadPage(page, false)
  const result = await page.evaluate(async (data) => {
    const { makePdfFile } = await import('/src/lib/pdfDoc.ts')
    const { useEditorStore } = await import('/src/state/store.ts')
    const { emptyConfig } = await import('/src/lib/types.ts')
    const { reorderPages } = await import('/src/features/thumbnails/reorder.ts')
    const source = await makePdfFile(new Blob([new Uint8Array(data)]), 'source.pdf')
    const other = { ...source, fileId: 'other-file', name: 'other.pdf' }
    const state = useEditorStore.getState()
    state.upsertFiles([source, other])
    useEditorStore.setState({ activeFileId: other.fileId, rangeText: '2', currentPage: 2 })
    const pending = reorderPages(source, [2, 1])
    const replacement = { ...source, blob: source.blob.slice(), name: 'newer.pdf' }
    useEditorStore.getState().replaceFile(replacement)
    const conflictAccepted = await pending
    const preserved = useEditorStore.getState().files.find((file) => file.fileId === source.fileId)?.blob === replacement.blob
    const unrelatedHistory = { ...emptyConfig(), scanEnabled: true }
    useEditorStore.temporal.setState({ pastStates: [{ configs: { [other.fileId]: unrelatedHistory } }], futureStates: [] })
    const pendingEdit = reorderPages(replacement, [2, 1])
    const intervening = { ...emptyConfig(), placements: [{ id: 'new-during-processing', stampId: 'stamp_example', pageNumber: 1, xPt: 10, yPt: 10, widthPt: 20, heightPt: 20, rotation: 0, opacity: 1 }] }
    useEditorStore.getState().setConfig(source.fileId, intervening)
    const success = await pendingEdit
    const latest = useEditorStore.getState()
    return {
      conflictAccepted, preserved, success,
      movedPage: latest.configs[source.fileId].placements[0]?.pageNumber,
      active: latest.activeFileId, range: latest.rangeText, page: latest.currentPage, busy: latest.busy,
      historyPreserved: useEditorStore.temporal.getState().pastStates.some((entry) => entry.configs?.[other.fileId] === unrelatedHistory)
    }
  }, await sourcePdf())
  expect(result).toEqual({ conflictAccepted: false, preserved: true, success: true, movedPage: 2, active: 'other-file', range: '2', page: 2, busy: '', historyPreserved: true })
  expect(forbidden).toEqual([])
})

test('operation ownership rejects concurrent commands and only clears its own busy state', async ({ page }) => {
  await noUploadPage(page)
  const result = await page.evaluate(async () => {
    const { beginOperation } = await import('/src/state/operations.ts')
    const { useEditorStore } = await import('/src/state/store.ts')
    const { importPicked } = await import('/src/features/workspace/actions.ts')
    const { useImportPrompt } = await import('/src/features/workspace/importPrompt.ts')
    const first = beginOperation('first')!
    const denied = beginOperation('second') === null
    await importPicked([new File(['ignored while busy'], 'file.pdf')])
    const noPrompt = useImportPrompt.getState().pending === null
    first.setBusy('first-progress')
    first.end()
    const released = useEditorStore.getState().busy === ''
    const next = beginOperation('next')!
    first.end()
    const retained = useEditorStore.getState().busy === 'next'
    useEditorStore.getState().setBusy('external-owner')
    next.end()
    const externalRetained = useEditorStore.getState().busy === 'external-owner'
    useEditorStore.getState().setBusy('')
    return { denied, noPrompt, released, retained, externalRetained }
  })
  expect(result).toEqual({ denied: true, noPrompt: true, released: true, retained: true, externalRetained: true })
})
