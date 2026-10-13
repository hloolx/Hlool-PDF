/**
 * 可选的浏览器引擎与 Go 参考引擎对比（不属于应用构建依赖）。
 *
 * 同一夹具与参数分别过：
 *   Go 参考引擎 go run ./cmd/refstamp（直调 internal/pdf 的 StampPDF / ComposePDF+
 *               RotatePagesBaked / ImageToPDF / DecryptPDF，绕过 HTTP/鉴权）
 *   本地引擎    web/src/features/generate/{localEngine,localCompose,qpdf}.ts
 *               （Playwright Chromium 里跑真码）
 * 再由 pdfjs 以 150dpi 栅格化两份产物逐像素比对；红线 = 差异像素占比 < 0.5%。
 * 加密对齐无法比字节：验收「qpdf 加密件 pdfcpu/pdfjs 能开、解密后像素一致」双向往返。
 *
 * 运行：scripts/verify-local-engine.ps1（或本目录 node verify.mjs）。
 */
import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { chromium } from 'playwright'

const DIR = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(DIR, '..', '..')
const WEB = join(ROOT, 'web')
const WORK = join(DIR, '.work')

const DPI = 150
const RED_LINE = 0.005
const PW = 'hlool-测试密码-42'

/* ---------------- 用例矩阵 ----------------
 * kind: 'stamp'（缺省）| 'compose' | 'image'；red=false 是已知怪癖的信息化记录。
 * 参数沿用原参考引擎模型，测试过程不需要应用 API。
 */
const seam = (over) => ({
  stampId: 'square',
  pages: 'all',
  side: 'right',
  sizePt: 119,
  positionPercent: 50,
  marginPt: 0,
  opacity: 1,
  maxSlices: 20,
  randomSeed: 0,
  ...over
})
const pl = (over) => ({ stampId: 'rect', pageNumber: 1, xPt: 120, yPt: 500, widthPt: 150, heightPt: 90, rotation: 0, opacity: 1, ...over })
const ROT0_PARAMS = { placements: [pl({})], seamSeals: [] }

const JOBS = [
  { name: 'rot0', input: 'base3', red: true, params: ROT0_PARAMS },
  { name: 'rot+37', input: 'base3', red: true, params: { placements: [pl({ rotation: 37 })], seamSeals: [] } },
  { name: 'rot-37', input: 'base3', red: true, params: { placements: [pl({ rotation: -37 })], seamSeals: [] } },
  { name: 'rot90-square', input: 'base3', red: true, params: { placements: [pl({ stampId: 'square', xPt: 180, yPt: 420, widthPt: 130, heightPt: 130, rotation: 90 })], seamSeals: [] } },
  { name: 'rot180', input: 'base3', red: true, params: { placements: [pl({ xPt: 160, yPt: 360, rotation: 180 })], seamSeals: [] } },
  {
    name: 'opacity-overlap',
    input: 'base3',
    red: true,
    params: {
      placements: [
        pl({ pageNumber: 2, xPt: 100, yPt: 300 }),
        pl({ pageNumber: 2, xPt: 150, yPt: 340, rotation: 15, opacity: 0.45 }),
        pl({ pageNumber: 2, stampId: 'square', xPt: 120, yPt: 280, widthPt: 120, heightPt: 120, rotation: -30, opacity: 0.7 })
      ],
      seamSeals: []
    }
  },
  { name: 'jpeg-15', input: 'base3', red: true, params: { placements: [pl({ stampId: 'jpeg', xPt: 200, yPt: 240, widthPt: 140, heightPt: 77.78, rotation: 15, opacity: 0.85 })], seamSeals: [] } },
  { name: 'seam-right-even', input: 'base5', red: true, params: { placements: [], seamSeals: [seam({})] } },
  { name: 'seam-right-rand', input: 'base5', red: true, params: { placements: [], seamSeals: [seam({ randomSeed: 123456789, maxSlices: 3, positionPercent: 35, marginPt: 6, opacity: 0.9 })] } },
  { name: 'seam-top', input: 'base5', red: true, params: { placements: [], seamSeals: [seam({ side: 'top', randomSeed: 99, sizePt: 100, positionPercent: 60, marginPt: 8 })] } },
  { name: 'seam-bottom', input: 'base5', red: true, params: { placements: [], seamSeals: [seam({ side: 'bottom', randomSeed: 7, sizePt: 90, positionPercent: 25, marginPt: 12 })] } },
  { name: 'seam-left', input: 'base5', red: true, params: { placements: [], seamSeals: [seam({ side: 'left', randomSeed: 3, sizePt: 110, positionPercent: 80, marginPt: 4 })] } },
  { name: 'seam-pages-expr', input: 'base5', red: true, params: { placements: [], seamSeals: [seam({ pages: '1,3-5', randomSeed: 5 })] } },
  {
    name: 'mixed',
    input: 'base3',
    red: true,
    params: {
      placements: [pl({ rotation: 20 }), pl({ stampId: 'square', pageNumber: 3, xPt: 300, yPt: 150, widthPt: 110, heightPt: 110, rotation: -45 })],
      seamSeals: [seam({ randomSeed: 42 })]
    }
  },
  { name: 'cropbox-placement', input: 'cropbox', red: true, params: { placements: [pl({ xPt: 100, yPt: 200, rotation: 25 })], seamSeals: [] } },
  { name: 'seam-cropbox', input: 'cropbox', red: true, params: { placements: [], seamSeals: [seam({ randomSeed: 11 })] } },
  {
    name: 'rotate-src-90',
    input: 'rotsrc',
    red: true,
    params: {
      placements: [pl({ xPt: 80, yPt: 200, widthPt: 140, heightPt: 84, rotation: 33 }), pl({ pageNumber: 3, xPt: 100, yPt: 350 })],
      seamSeals: []
    }
  },
  {
    name: 'rotate-src-270-180',
    input: 'rotsrc2',
    red: true,
    params: {
      placements: [
        pl({ stampId: 'square', xPt: 90, yPt: 300, widthPt: 120, heightPt: 120 }),
        pl({ pageNumber: 2, xPt: 60, yPt: 420, rotation: -20 })
      ],
      seamSeals: []
    }
  },
  { name: 'passthrough', input: 'base3', red: true, byteEqual: true, params: { placements: [], seamSeals: [] } },
  // ---- P2：页面操作（compose / 图片转 PDF）----
  { name: 'compose-reorder', kind: 'compose', inputs: ['base5'], red: true, pages: [{ file: 0, pageNumber: 5 }, { file: 0, pageNumber: 3 }, { file: 0, pageNumber: 1 }] },
  {
    name: 'compose-merge',
    kind: 'compose',
    inputs: ['base3', 'base5'],
    red: true,
    pages: [{ file: 0, pageNumber: 1 }, { file: 1, pageNumber: 2 }, { file: 0, pageNumber: 3 }, { file: 1, pageNumber: 5 }]
  },
  {
    name: 'compose-rotate',
    kind: 'compose',
    inputs: ['base3'],
    red: true,
    pages: [{ file: 0, pageNumber: 1, rotate: 90 }, { file: 0, pageNumber: 2, rotate: 180 }, { file: 0, pageNumber: 3, rotate: 270 }]
  },
  {
    // 页1 自带 /Rotate90 + 请求 90 = 复合 180；页2 自带 90 不请求（保留 /Rotate）；页3 无自带 + 90。
    name: 'compose-rotate-src',
    kind: 'compose',
    inputs: ['rotsrc'],
    red: true,
    pages: [{ file: 0, pageNumber: 1, rotate: 90 }, { file: 0, pageNumber: 2 }, { file: 0, pageNumber: 3, rotate: 90 }]
  },
  { name: 'compose-dup', kind: 'compose', inputs: ['base3'], red: true, pages: [{ file: 0, pageNumber: 2 }, { file: 0, pageNumber: 2, rotate: 90 }] },
  { name: 'image-jpeg-landscape', kind: 'image', image: 'jpeg', red: true },
  { name: 'image-png-portrait', kind: 'image', image: 'portrait', red: true },
  // 已知服务端怪癖（信息化）：pdfcpu 在 rot 恰为 ±90.000 时矩形章走边界对齐特例，
  // 与「预览即产物」（绕中心）相差 |W−H|/2 —— 本地有意不复刻，见 localEngineMath.ts 头注。
  { name: 'quirk-rot90-rect', input: 'base3', red: false, params: { placements: [pl({ rotation: 90 })], seamSeals: [] } }
]

/* ---------------- 工具 ---------------- */

const log = (msg) => console.log(msg)
const b64file = (path) => readFileSync(path).toString('base64')

function fail(msg) {
  console.error(`\nFATAL: ${msg}`)
  process.exit(1)
}

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: 'inherit', shell: false, ...opts })
  if (r.error) throw r.error
  return r.status ?? 1
}

/* ---------------- esbuild 插件 ----------------
 * ?url 资产：Vite 的 `import x from '...?url'`（qpdf.wasm）在 esbuild 下没有对应
 * loader —— 解析为 http 路径字符串，实际文件由主流程拷进 .work。
 * Node 内置空桩：qpdf 的 Emscripten glue 引用 fs/path/crypto（仅 Node 分支用到），
 * 浏览器运行时有环境守卫，打包时替换为空对象即可。
 */
const vitePlugins = [
  {
    name: 'vite-url-suffix',
    setup(b) {
      b.onResolve({ filter: /\?url$/ }, (args) => ({ path: args.path.replace(/\?url$/, ''), namespace: 'url-asset' }))
      b.onLoad({ filter: /.*/, namespace: 'url-asset' }, (args) => ({
        contents: `export default '/${args.path.split('/').pop()}'`,
        loader: 'js'
      }))
    }
  },
  {
    name: 'node-builtin-stub',
    setup(b) {
      b.onResolve({ filter: /^(fs|path|crypto)$/ }, (args) => ({ path: args.path, namespace: 'node-stub' }))
      b.onLoad({ filter: /.*/, namespace: 'node-stub' }, () => ({ contents: 'export default {}', loader: 'js' }))
    }
  }
]

/* ---------------- 阶段 1：单元测试（三语义点 + 烘录矩阵） ---------------- */

async function runUnitTests() {
  const out = join(WORK, 'unit.test.mjs')
  await build({
    entryPoints: [join(WEB, 'src', 'features', 'generate', 'localEngineMath.test.ts')],
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node22',
    outfile: out,
    nodePaths: [join(WEB, 'node_modules')],
    logLevel: 'silent'
  })
  log('== unit: localEngineMath.test.ts ==')
  if (run(process.execPath, ['--test', out]) !== 0) fail('数学单测未通过 —— 语义点被破坏，先修数学再谈对齐')
}

/* ---------------- 阶段 2：打包浏览器 harness ---------------- */

async function bundleHarness() {
  await build({
    entryPoints: [join(DIR, 'harness-page.ts')],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    outfile: join(WORK, 'harness.js'),
    nodePaths: [join(WEB, 'node_modules')],
    plugins: vitePlugins,
    logLevel: 'silent'
  })
  await build({
    entryPoints: [join(WEB, 'node_modules', 'pdfjs-dist', 'build', 'pdf.worker.mjs')],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    outfile: join(WORK, 'pdf.worker.js'),
    logLevel: 'silent'
  })
  copyFileSync(join(WEB, 'node_modules', '@neslinesli93', 'qpdf-wasm', 'dist', 'qpdf.wasm'), join(WORK, 'qpdf.wasm'))
}

/* ---------------- 静态服务（Worker/wasm 不能跑在 file:// 下） ---------------- */

function serve() {
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.wasm': 'application/wasm' }
  const server = http.createServer((req, res) => {
    const url = (req.url ?? '/').split('?')[0]
    try {
      if (url === '/') {
        res.setHeader('content-type', 'text/html')
        res.end(readFileSync(join(DIR, 'index.html')))
        return
      }
      const file = join(WORK, url.replaceAll('..', ''))
      res.setHeader('content-type', types[file.slice(file.lastIndexOf('.'))] ?? 'application/octet-stream')
      res.end(readFileSync(file))
    } catch {
      res.statusCode = 404
      res.end('not found')
    }
  })
  return new Promise((resolvePort) => {
    server.listen(0, '127.0.0.1', () => resolvePort({ server, port: server.address().port }))
  })
}

/* ---------------- 主流程 ---------------- */

rmSync(WORK, { recursive: true, force: true })
for (const d of ['', 'fixtures', 'out-server', 'out-local', 'diff']) mkdirSync(join(WORK, d), { recursive: true })

await runUnitTests()
await bundleHarness()

const { server, port } = await serve()
const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || undefined })
const page = await browser.newPage()
page.setDefaultTimeout(120_000)
page.on('pageerror', (err) => console.error('[page error]', err.message))
page.on('console', (msg) => {
  if (msg.type() === 'error') console.error('[page console]', msg.text())
})

const stampFile = (id) => `stamp-${id}${id === 'jpeg' ? '.jpg' : '.png'}`

try {
  await page.goto(`http://127.0.0.1:${port}/`)
  await page.waitForFunction(() => window.hReady === true)

  // 夹具：浏览器里确定性生成，落盘供 refstamp 与人工检查。
  log('== fixtures ==')
  const fixtures = await page.evaluate(() => window.hBuildFixtures())
  for (const [name, b64] of Object.entries(fixtures.pdfs)) {
    writeFileSync(join(WORK, 'fixtures', `${name}.pdf`), Buffer.from(b64, 'base64'))
  }
  for (const [id, s] of Object.entries(fixtures.stamps)) {
    writeFileSync(join(WORK, 'fixtures', stampFile(id)), Buffer.from(s.b64, 'base64'))
  }

  // 服务器参考产物：jobs 翻译成 refstamp 形状（路径相对 jobs.json 所在目录）。
  // 头两个作业为加密往返准备夹具：enc-src（pdfcpu 加密的输入）与其服务器盖章产物。
  const serverJobs = [
    {
      name: 'make-enc-src',
      kind: 'stamp',
      input: 'fixtures/base3.pdf',
      output: 'fixtures/enc-src.pdf',
      stamps: {},
      params: { placements: [], seamSeals: [], outputPassword: PW }
    },
    {
      name: 'stamp-enc-server',
      kind: 'stamp',
      input: 'fixtures/enc-src.pdf',
      password: PW,
      output: 'out-server/stamp-enc.pdf',
      stamps: { rect: stampRef('rect') },
      params: ROT0_PARAMS
    },
    ...JOBS.map((j) => {
      if (j.kind === 'compose') {
        return { name: j.name, kind: 'compose', inputs: j.inputs.map((k) => `fixtures/${k}.pdf`), pages: j.pages, output: `out-server/${j.name}.pdf` }
      }
      if (j.kind === 'image') {
        return { name: j.name, kind: 'image', input: `fixtures/${stampFile(j.image)}`, output: `out-server/${j.name}.pdf` }
      }
      return {
        name: j.name,
        input: `fixtures/${j.input}.pdf`,
        output: `out-server/${j.name}.pdf`,
        stamps: Object.fromEntries(usedStamps(j).map((id) => [id, stampRef(id)])),
        params: j.params
      }
    })
  ]
  writeFileSync(join(WORK, 'jobs.server.json'), JSON.stringify(serverJobs, null, 1))
  log('== server engine (refstamp) ==')
  if (run('go', ['run', './cmd/refstamp', join(WORK, 'jobs.server.json')], { cwd: ROOT }) !== 0) {
    fail('refstamp 失败 —— 服务器参考产物未生成')
  }

  // 本地引擎产物：浏览器里跑真实 localEngine / localCompose。
  log('== local engine ==')
  const localFailures = {}
  for (const j of JOBS) {
    try {
      let outB64
      if (j.kind === 'compose') {
        outB64 = await page.evaluate(
          ({ pdfs, pages }) => window.hRunLocalCompose(pdfs, pages),
          { pdfs: j.inputs.map((k) => fixtures.pdfs[k]), pages: j.pages }
        )
      } else if (j.kind === 'image') {
        outB64 = await page.evaluate(({ img }) => window.hRunLocalImage(img), { img: fixtures.stamps[j.image].b64 })
      } else {
        const stampsSubset = Object.fromEntries(usedStamps(j).map((id) => [id, fixtures.stamps[id]]))
        outB64 = await page.evaluate(
          ({ params, pdf, stamps }) => window.hRunLocal(params, pdf, stamps),
          { params: j.params, pdf: fixtures.pdfs[j.input], stamps: stampsSubset }
        )
      }
      writeFileSync(join(WORK, 'out-local', `${j.name}.pdf`), Buffer.from(outB64, 'base64'))
    } catch (err) {
      localFailures[j.name] = String(err?.message ?? err)
    }
  }

  // 比对与报告。
  log('== compare (150dpi, per-pixel) ==\n')
  const report = []
  let redFailed = 0
  for (const j of JOBS) {
    const row = await compareJob(j, localFailures[j.name])
    if (j.red && row.verdict !== 'PASS') redFailed++
    report.push(row)
    printRow(row)
  }

  // ---- P2 加密往返（红线）----
  log('\n== encryption roundtrip (qpdf-wasm ↔ pdfcpu) ==\n')

  // A) 本地 qpdf 加密 → pdfjs 直开 + pdfcpu 解密后像素一致。
  {
    const row = { name: 'encrypt-local-out', red: true, verdict: 'PASS', maxRatio: 0, pages: [] }
    try {
      const plainB64 = b64file(join(WORK, 'out-local', 'rot0.pdf'))
      const encB64 = await page.evaluate(({ p, pw }) => window.hEncrypt(p, pw), { p: plainB64, pw: PW })
      writeFileSync(join(WORK, 'out-local', 'enc-by-qpdf.pdf'), Buffer.from(encB64, 'base64'))
      // pdfjs 带密码直开加密件 vs 明文
      let res = await page.evaluate(({ a, b, dpi, pa }) => window.hCompare(a, b, dpi, false, pa), { a: encB64, b: plainB64, dpi: DPI, pa: PW })
      if (res.error) throw new Error(`pdfjs 打开 qpdf 加密件失败: ${res.error}`)
      row.maxRatio = Math.max(...res.pages.map((p) => p.ratio))
      // pdfcpu（refstamp decrypt）解密 → 再比一次
      const decJobs = [{ name: 'qpdf-enc-open', kind: 'decrypt', input: 'out-local/enc-by-qpdf.pdf', output: 'out-server/qpdf-dec.pdf', password: PW }]
      writeFileSync(join(WORK, 'jobs.decrypt.json'), JSON.stringify(decJobs, null, 1))
      if (run('go', ['run', './cmd/refstamp', join(WORK, 'jobs.decrypt.json')], { cwd: ROOT }) !== 0) {
        throw new Error('pdfcpu 无法解密 qpdf 加密的产物')
      }
      res = await page.evaluate(({ a, b, dpi }) => window.hCompare(a, b, dpi, false), { a: b64file(join(WORK, 'out-server', 'qpdf-dec.pdf')), b: plainB64, dpi: DPI })
      if (res.error) throw new Error(res.error)
      row.maxRatio = Math.max(row.maxRatio, ...res.pages.map((p) => p.ratio))
      row.pages = res.pages.map((p) => ({ ratio: p.ratio, w: p.w, h: p.h }))
      if (row.maxRatio >= RED_LINE) row.verdict = 'FAIL'
    } catch (err) {
      row.verdict = 'ERROR'
      row.error = String(err?.message ?? err)
    }
    if (row.verdict !== 'PASS') redFailed++
    report.push(row)
    printRow(row)
  }

  // B) pdfcpu 加密的输入 → 本地 qpdf 解锁 + 本地盖章 vs 服务器带密码盖章。
  {
    const row = { name: 'decrypt-local-in', red: true, verdict: 'PASS', maxRatio: 0, pages: [] }
    try {
      const encSrcB64 = b64file(join(WORK, 'fixtures', 'enc-src.pdf'))
      const plainB64 = await page.evaluate(({ p, pw }) => window.hDecrypt(p, pw), { p: encSrcB64, pw: PW })
      const stampedB64 = await page.evaluate(
        ({ params, pdf, stamps }) => window.hRunLocal(params, pdf, stamps),
        { params: ROT0_PARAMS, pdf: plainB64, stamps: { rect: fixtures.stamps.rect } }
      )
      writeFileSync(join(WORK, 'out-local', 'stamp-enc.pdf'), Buffer.from(stampedB64, 'base64'))
      const res = await page.evaluate(({ a, b, dpi }) => window.hCompare(a, b, dpi, false), { a: b64file(join(WORK, 'out-server', 'stamp-enc.pdf')), b: stampedB64, dpi: DPI })
      if (res.error) throw new Error(res.error)
      row.maxRatio = Math.max(...res.pages.map((p) => p.ratio))
      row.pages = res.pages.map((p) => ({ ratio: p.ratio, w: p.w, h: p.h }))
      if (row.maxRatio >= RED_LINE) row.verdict = 'FAIL'
    } catch (err) {
      row.verdict = 'ERROR'
      row.error = String(err?.message ?? err)
    }
    if (row.verdict !== 'PASS') redFailed++
    report.push(row)
    printRow(row)
  }

  writeFileSync(join(WORK, 'report.json'), JSON.stringify(report, null, 2))
  log(`\nreport: ${join(WORK, 'report.json')}`)
  const redTotal = JOBS.filter((j) => j.red).length + 2
  log(redFailed === 0 ? `\nALL RED-LINE JOBS PASS (${redTotal})` : `\nRED-LINE FAILURES: ${redFailed}`)
  process.exitCode = redFailed === 0 ? 0 : 1

  /* -------- 内联工具（引用 page/fixtures 等闭包） -------- */

  function stampRef(id) {
    return { path: `fixtures/${stampFile(id)}`, widthPx: fixtures.stamps[id].widthPx, heightPx: fixtures.stamps[id].heightPx }
  }

  async function compareJob(j, localError) {
    const row = { name: j.name, red: j.red, verdict: 'PASS', maxRatio: 0, pages: [] }
    if (localError) {
      row.verdict = 'ERROR'
      row.error = localError
      return row
    }
    const serverPath = join(WORK, 'out-server', `${j.name}.pdf`)
    const localPath = join(WORK, 'out-local', `${j.name}.pdf`)
    if (j.byteEqual) {
      const src = readFileSync(join(WORK, 'fixtures', `${j.input}.pdf`))
      const okSrv = src.equals(readFileSync(serverPath))
      const okLoc = src.equals(readFileSync(localPath))
      if (!okSrv || !okLoc) {
        row.verdict = 'FAIL'
        row.error = `passthrough bytes differ (server=${okSrv} local=${okLoc})`
        return row
      }
    }
    let res = await page.evaluate(({ a, b, dpi }) => window.hCompare(a, b, dpi, false), {
      a: b64file(serverPath),
      b: b64file(localPath),
      dpi: DPI
    })
    if (res.error) {
      row.verdict = 'FAIL'
      row.error = res.error
      return row
    }
    row.maxRatio = Math.max(...res.pages.map((p) => p.ratio))
    row.pages = res.pages.map((p) => ({ ratio: p.ratio, w: p.w, h: p.h, sizeMismatch: p.sizeMismatch }))
    const bad = row.maxRatio >= RED_LINE || res.pages.some((p) => p.sizeMismatch)
    if (bad) {
      row.verdict = j.red ? 'FAIL' : 'INFO-DIFF'
      // 失败/信息化差异才生成热图（较慢），供人工定位。
      res = await page.evaluate(({ a, b, dpi }) => window.hCompare(a, b, dpi, true), {
        a: b64file(serverPath),
        b: b64file(localPath),
        dpi: DPI
      })
      res.pages.forEach((p, i) => {
        if (p.heat && (p.ratio >= RED_LINE || p.sizeMismatch)) {
          writeFileSync(join(WORK, 'diff', `${j.name}-p${i + 1}.png`), Buffer.from(p.heat, 'base64'))
        }
      })
    }
    return row
  }
} finally {
  await browser.close()
  server.close()
}

function printRow(row) {
  const ratioText = row.pages.length ? (row.maxRatio * 100).toFixed(4) + '%' : '-'
  log(`${row.verdict.padEnd(9)} ${row.name.padEnd(22)} maxDiff=${ratioText}${row.error ? '  ' + row.error : ''}`)
}

function usedStamps(job) {
  const ids = new Set()
  for (const p of job.params.placements) ids.add(p.stampId)
  for (const s of job.params.seamSeals) ids.add(s.stampId)
  return [...ids]
}
