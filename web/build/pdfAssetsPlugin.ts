import { createRequire } from 'node:module'
import { cpSync, readFileSync } from 'node:fs'
import { dirname, join, extname, resolve } from 'node:path'
import type { Plugin, ResolvedConfig } from 'vite'

/** PDF.js requests some fonts, CMaps and image decoders only for specific PDFs. */
export function pdfAssetsPlugin(): Plugin {
  const require = createRequire(import.meta.url)
  const source = dirname(require.resolve('pdfjs-dist/package.json'))
  const groups = ['cmaps', 'standard_fonts', 'wasm', 'iccs']
  let config: ResolvedConfig
  return {
    name: 'hlool-pdf-resources',
    configResolved(value) { config = value },
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const path = new URL(request.url ?? '/', 'http://localhost').pathname
        const base = `${config.base}pdfjs/`
        if (!path.startsWith(base)) return next()
        const parts = path.slice(base.length).split('/')
        if (parts.length !== 2 || !groups.includes(parts[0]) || !/^[\w.-]+$/.test(parts[1]) || parts[1] === '..') {
          response.writeHead(404).end()
          return
        }
        try {
          const bytes = readFileSync(join(source, ...parts))
          const types: Record<string, string> = { '.js': 'text/javascript', '.wasm': 'application/wasm' }
          response.writeHead(200, { 'Content-Type': types[extname(parts[1])] ?? 'application/octet-stream' })
          response.end(bytes)
        } catch { response.writeHead(404).end() }
      })
    },
    writeBundle() {
      for (const group of groups) cpSync(join(source, group), resolve(config.root, config.build.outDir, 'pdfjs', group), { recursive: true })
    }
  }
}
