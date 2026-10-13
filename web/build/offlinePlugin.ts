import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Plugin, ResolvedConfig } from 'vite'

/** Precache the finished build, including assets emitted by Vite's worker build. */
export function offlinePlugin(): Plugin {
  let config: ResolvedConfig
  return {
    name: 'hlool-offline-build',
    apply: 'build',
    configResolved(value) { config = value },
    closeBundle() {
      const output = join(config.root, config.build.outDir)
      function filesAt(directory: string): string[] {
        return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
          const path = join(directory, entry.name)
          return entry.isDirectory() ? filesAt(path) : [path]
        })
      }
      const files = filesAt(output).filter((path) => !path.endsWith('.map') && !path.endsWith('sw.js')).sort()
      const hash = createHash('sha256')
      const paths = files.map((path) => {
        const name = relative(output, path).replaceAll('\\', '/')
        hash.update(name).update(readFileSync(path))
        return name
      })
      const template = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'service-worker.js'), 'utf8')
      hash.update(template)
      writeFileSync(join(output, 'sw.js'), template
        .replace('__BUILD_VERSION__', JSON.stringify(hash.digest('hex').slice(0, 20)))
        .replace('__BUILD_FILES__', JSON.stringify(paths)))
    }
  }
}
