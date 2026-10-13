import { readdir, mkdir } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { build } from 'esbuild'

const root = fileURLToPath(new URL('../', import.meta.url))
const output = join(root, '.test-work')
async function collect(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  const files = await Promise.all(entries.map((entry) => entry.isDirectory()
    ? collect(join(directory, entry.name))
    : entry.name.endsWith('.test.ts') ? [join(directory, entry.name)] : []))
  return files.flat()
}
await mkdir(output, { recursive: true })
const tests = await collect(resolve(root, 'src'))
const bundled = []
for (const [index, entry] of tests.entries()) {
  const outfile = join(output, `unit-${index}.cjs`)
  await build({ entryPoints: [entry], outfile, bundle: true, format: 'cjs', platform: 'node', target: 'node22', external: ['@neslinesli93/qpdf-wasm*'], logLevel: 'silent' })
  bundled.push(outfile)
}
if (!bundled.length) throw new Error('No unit tests were found')
const result = spawnSync(process.execPath, ['--test', ...bundled], { cwd: root, stdio: 'inherit' })
if (result.error) throw result.error
process.exitCode = result.status ?? 1
