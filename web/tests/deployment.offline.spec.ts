import { test, expect } from '@playwright/test'
import { createServer } from 'node:http'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, extname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ResolvedConfig } from 'vite'
import { offlinePlugin } from '../build/offlinePlugin'

const web = fileURLToPath(new URL('../', import.meta.url))
const dist = join(web, 'dist')
const metadata = ['_headers', '_redirects', '_routes.json', '_worker.js', '.assetsignore']

function manifest(worker: string) {
  return {
    version: JSON.parse(worker.match(/^const VERSION = (.+)$/m)![1]) as string,
    files: JSON.parse(worker.match(/^const FILES = (.+)$/m)![1]) as string[]
  }
}

test('deployment metadata is versioned but never requested by the offline installer', async ({}, testInfo) => {
  const root = testInfo.outputPath('fixture')
  const output = join(root, 'dist')
  const fixtures: Record<string, string> = {
    'index.html': '<html></html>',
    'assets/app.js': 'console.log("app")',
    'assets/app.js.map': '{}',
    'pdfjs/wasm/openjpeg.wasm': 'wasm fixture',
    '_headers': '/*\n  X-Content-Type-Options: nosniff',
    '_redirects': '/old / 301',
    '_routes.json': '{}',
    '_worker.js/index.js': 'export default {}',
    '.assetsignore': 'private/*',
    'sw.js': 'obsolete worker'
  }
  for (const [name, contents] of Object.entries(fixtures)) {
    await mkdir(dirname(join(output, name)), { recursive: true })
    await writeFile(join(output, name), contents)
  }
  const plugin = offlinePlugin()
  const configure = plugin.configResolved as (config: ResolvedConfig) => void
  const build = plugin.closeBundle as () => void
  configure({ root, build: { outDir: 'dist' } } as ResolvedConfig)
  build()
  const initial = manifest(await readFile(join(output, 'sw.js'), 'utf8'))
  expect(initial.files).toEqual(['assets/app.js', 'index.html', 'pdfjs/wasm/openjpeg.wasm'])
  await writeFile(join(output, '_headers'), '/*\n  Referrer-Policy: no-referrer')
  build()
  const updated = manifest(await readFile(join(output, 'sw.js'), 'utf8'))
  expect(updated.files).toEqual(initial.files)
  expect(updated.version).not.toBe(initial.version)
})

test('Pages-style metadata 404 responses preserve production offline installation', async ({ page, context }) => {
  const headersFile = await readFile(join(dist, '_headers'), 'utf8')
  const common = headersFile.match(/^\/\*\r?\n((?:[ \t]+[^\r\n]+\r?\n)+)/m)![1]
  const securityHeaders = Object.fromEntries(common.trim().split(/\r?\n/).map((line) => {
    const colon = line.indexOf(':')
    return [line.slice(0, colon).trim(), line.slice(colon + 1).trim()]
  }))
  // These policies must agree across the three supported production hosts.
  const preview = await readFile(join(web, 'vite.config.ts'), 'utf8')
  const nginx = await readFile(join(web, '../deploy/nginx-static.conf'), 'utf8')
  for (const [header, value] of Object.entries(securityHeaders)) {
    expect(preview).toContain(header)
    expect(preview).toContain(value)
    expect(nginx).toContain(header)
    expect(nginx).toContain(value)
  }
  expect(securityHeaders['Content-Security-Policy']).toContain("'wasm-unsafe-eval'")
  const missingRequests: string[] = []
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  const server = createServer(async (request, response) => {
    try {
      const pathname = decodeURIComponent(new URL(request.url!, 'http://localhost').pathname)
      if (metadata.includes(pathname.split('/')[1])) {
        missingRequests.push(pathname)
        response.writeHead(404).end()
        return
      }
      const file = resolve(dist, pathname === '/' ? 'index.html' : `.${pathname}`)
      if (!file.startsWith(resolve(dist) + sep)) { response.writeHead(404).end(); return }
      const body = await readFile(file)
      const mime: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' }
      response.writeHead(200, { ...securityHeaders, 'Content-Type': mime[extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' })
      response.end(body)
    } catch { response.writeHead(404).end() }
  })
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  try {
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('No test address')
    await page.goto(`http://127.0.0.1:${address.port}/`)
    await page.getByRole('button', { name: '本地资料', exact: true }).click()
    await expect(page.getByTestId('offline-status')).toHaveText('离线已就绪', { timeout: 30_000 })
    await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true)
    expect(missingRequests).toEqual([])
    const cached = await page.evaluate(async () => {
      const name = (await caches.keys()).find((key) => key.startsWith('hlool-pdf-app:'))!
      return (await (await caches.open(name)).keys()).map((request) => new URL(request.url).pathname)
    })
    expect(cached.some((path) => path.endsWith('.wasm'))).toBe(true)
    expect(cached.filter((path) => metadata.includes(path.split('/')[1]))).toEqual([])
    await context.setOffline(true)
    await page.reload()
    await page.getByRole('button', { name: '本地资料', exact: true }).click()
    await expect(page.getByTestId('offline-status')).toHaveText('离线已就绪')
    expect(errors).toEqual([])
  } finally {
    server.closeAllConnections()
    await new Promise<void>((done, reject) => server.close((error) => error ? reject(error) : done()))
  }
})
