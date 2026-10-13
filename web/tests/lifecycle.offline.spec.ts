import { test, expect } from '@playwright/test'
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { resolve, sep, extname } from 'node:path'
import { fileURLToPath } from 'node:url'

const dist = fileURLToPath(new URL('../dist/', import.meta.url))

// Real HTTP responses exercise the browser's SW installer and update lifecycle.
// Playwright routing does not reliably intercept every worker-owned request.
async function serveBuild() {
  const state = { version: 1, rejectWasm: false }
  const server = createServer(async (request, response) => {
    try {
      const pathname = decodeURIComponent(new URL(request.url!, 'http://localhost').pathname)
      const file = resolve(dist, pathname === '/' ? 'index.html' : `.${pathname}`)
      if (!file.startsWith(resolve(dist) + sep)) { response.writeHead(404).end(); return }
      if (state.rejectWasm && file.endsWith('.wasm')) { response.writeHead(503).end(); return }
      let body = await readFile(file)
      if (file.endsWith('sw.js')) body = Buffer.from(body.toString().replace(/const VERSION = "([^"]+)"/, `const VERSION = "$1-test-${state.version}"`))
      if (file.endsWith('index.html')) body = Buffer.from(body.toString().replace('<title>hlool pdf</title>', `<title>Build ${state.version}</title>`))
      const mime: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' }
      response.writeHead(200, { 'Content-Type': mime[extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' })
      response.end(body)
    } catch { response.writeHead(404).end() }
  })
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('No test address')
  return {
    state,
    url: `http://127.0.0.1:${address.port}/`,
    close: async () => {
      server.closeAllConnections()
      await new Promise<void>((done, reject) => server.close((error) => error ? reject(error) : done()))
    }
  }
}

test('a failed precache can retry, and missing cached assets are detected and repaired', async ({ page }) => {
  const host = await serveBuild()
  try {
    host.state.rejectWasm = true
    await page.goto(host.url)
    await page.getByRole('button', { name: '本地资料', exact: true }).click()
    await expect(page.getByTestId('offline-status')).toHaveText('离线资源未准备完成', { timeout: 30_000 })
    host.state.rejectWasm = false
    await page.getByRole('menuitem', { name: '重新准备离线资源' }).click()
    await expect(page.getByTestId('offline-status')).toHaveText('离线已就绪', { timeout: 30_000 })
    const deleted = await page.evaluate(async () => {
      const name = (await caches.keys()).find((key) => key.startsWith('hlool-pdf-app:'))!
      const cache = await caches.open(name)
      const wasm = (await cache.keys()).find((request) => request.url.endsWith('.wasm'))!
      return cache.delete(wasm, { ignoreVary: true })
    })
    expect(deleted).toBe(true)
    await page.reload()
    await page.getByRole('button', { name: '本地资料', exact: true }).click()
    await expect(page.getByTestId('offline-status')).toHaveText('离线资源未准备完成')
    await page.getByRole('menuitem', { name: '重新准备离线资源' }).click()
    await expect(page.getByTestId('offline-status')).toHaveText('离线已就绪')
    await page.context().setOffline(true)
    await page.reload()
    await page.getByRole('button', { name: '本地资料', exact: true }).click()
    await expect(page.getByTestId('offline-status')).toHaveText('离线已就绪')
  } finally { await host.close() }
})

test('a downloaded update waits for every old tab and then retires only old application caches', async ({ page, context }) => {
  const host = await serveBuild()
  try {
    await page.goto(host.url)
    await page.getByRole('button', { name: '本地资料', exact: true }).click()
    await expect(page.getByTestId('offline-status')).toHaveText('离线已就绪', { timeout: 30_000 })
    await page.evaluate(async () => { await caches.open('unrelated-user-cache') })
    const second = await context.newPage()
    await second.goto(host.url)
    host.state.version = 2
    await page.evaluate(async () => { await (await navigator.serviceWorker.getRegistration())!.update() })
    await expect(page.getByTestId('offline-status')).toHaveText('新版已就绪 · 关闭所有窗口后生效', { timeout: 30_000 })
    await expect(page).toHaveTitle('Build 1')
    await second.reload()
    await expect(second).toHaveTitle('Build 1')
    await page.close()
    await second.close()
    await expect.poll(async () => {
      for (const worker of context.serviceWorkers()) {
        try {
          if (await worker.evaluate('VERSION.endsWith("-test-2") && self.registration.active?.state === "activated"')) return true
        } catch { /* The old worker can terminate while being inspected. */ }
      }
      return false
    }).toBe(true)
    const fresh = await context.newPage()
    await fresh.goto(host.url)
    await expect(fresh).toHaveTitle('Build 2')
    const keys = await fresh.evaluate(() => caches.keys())
    expect(keys).toContain('unrelated-user-cache')
    expect(keys.filter((key) => key.startsWith('hlool-pdf-app:'))).toHaveLength(1)
    expect(keys.some((key) => key.endsWith('-test-2'))).toBe(true)
  } finally { await host.close() }
})
