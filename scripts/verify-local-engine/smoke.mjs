/**
 * 发版前集成冒烟：构建真实服务器（embed 前端）→ Playwright 真浏览器走完整用户流，
 * 验证 harness 覆盖不到的集成层 —— 路由分流、Web Worker、qpdf 懒加载、印章拉取、
 * UI 交互与云端回退。
 *
 * 断言核心是网络行为：本地路径全程不得出现 /api/process、/api/compose、
 * /api/image-to-pdf；关闭「优先本地处理」后必须出现（回退管线完好）。
 *
 * 运行：node scripts/verify-local-engine/smoke.mjs（会自建 vite 产物与临时 Go 二进制）。
 */
import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { chromium } from 'playwright'

const DIR = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(DIR, '..', '..')
const WEB = join(ROOT, 'web')
const SMOKE = join(DIR, '.work', 'smoke')
const ADDR = '127.0.0.1:18099'
const BASE = `http://${ADDR}`
const ADMIN = { username: 'smoke', password: 'smoke-pass-12345' }

const log = (m) => console.log(m)
const results = []
let serverProc = null

function check(name, ok, detail = '') {
  results.push({ name, ok, detail })
  log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`)
}

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: 'inherit', shell: false, ...opts })
  if (r.error) throw r.error
  if ((r.status ?? 1) !== 0) throw new Error(`${cmd} ${args.join(' ')} exited ${r.status}`)
}

async function waitHealthy() {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`${BASE}/healthz`)
      if (res.ok) return
    } catch {
      /* server not up yet */
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error('server did not become healthy')
}

/* ---------------- 构建与启动 ---------------- */

rmSync(SMOKE, { recursive: true, force: true })
mkdirSync(SMOKE, { recursive: true })

log('== build web (embed) ==')
run('npm', ['--prefix', WEB, 'run', 'build'], { cwd: ROOT, shell: true })
log('== build server ==')
const exe = join(SMOKE, 'hlool-pdf-smoke.exe')
run('go', ['build', '-tags', 'embed', '-o', exe, './cmd/hlool-pdf'], { cwd: ROOT })

log('== start server ==')
serverProc = spawn(exe, [], {
  env: {
    ...process.env,
    HLOOL_ADDR: ADDR,
    HLOOL_DATA_DIR: join(SMOKE, 'data'),
    HLOOL_ADMIN_USERNAME: ADMIN.username,
    HLOOL_ADMIN_PASSWORD: ADMIN.password
  },
  stdio: 'ignore'
})
await waitHealthy()

/* ---------------- 夹具（Node 侧） ---------------- */

// pdf-lib 直接从 web/node_modules 以文件 URL 引入（本脚本无自己的依赖树）。
const { PDFDocument, StandardFonts, rgb } = await import(
  pathToFileURL(join(WEB, 'node_modules', 'pdf-lib', 'dist', 'pdf-lib.esm.js')).href
)

async function makeTestPdf(pages) {
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.HelveticaBold)
  for (let i = 0; i < pages; i++) {
    const page = doc.addPage([595.28, 841.89])
    page.drawRectangle({ x: 20, y: 20, width: 555, height: 800, borderColor: rgb(0.4, 0.4, 0.5), borderWidth: 2 })
    page.drawText(`smoke ${i + 1}`, { x: 60, y: 400, size: 48, font, color: rgb(0.3, 0.3, 0.4) })
  }
  return doc.save()
}

const srcPdfPath = join(SMOKE, 'src.pdf')
writeFileSync(srcPdfPath, await makeTestPdf(3))

/* ---------------- 浏览器 ---------------- */

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1600, height: 950 }, acceptDownloads: true })
page.setDefaultTimeout(60_000)

const apiHits = []
page.on('request', (req) => {
  const url = req.url()
  if (/\/api\/(process|compose|image-to-pdf)/.test(url)) apiHits.push(new URL(url).pathname)
})
let wasmRequested = false
page.on('request', (req) => {
  if (req.url().endsWith('.wasm')) wasmRequested = true
})
page.on('console', (msg) => {
  const text = msg.text()
  if (msg.type() === 'error' || text.includes('回退') || text.includes('local-engine') || text.includes('local-compose')) {
    console.log('[browser]', msg.type(), text)
  }
})
// 诊断：记录所有非 2xx 响应（URL + 状态 + 资源类型），定位真正 401 的请求。
page.on('response', (res) => {
  const s = res.status()
  if (s >= 400) console.log('[http]', s, res.request().resourceType(), new URL(res.url()).pathname)
})
// 诊断：Worker 内部的失败请求经由 page 的 requestfailed 也可见。
page.on('requestfailed', (req) => {
  console.log('[reqfail]', req.resourceType(), new URL(req.url()).pathname, req.failure()?.errorText ?? '')
})

async function download(action) {
  const [dl] = await Promise.all([page.waitForEvent('download'), action()])
  const path = join(SMOKE, `dl-${Date.now()}-${dl.suggestedFilename()}`)
  await dl.saveAs(path)
  return readFileSync(path)
}

const canLoad = async (bytes) => {
  try {
    await PDFDocument.load(new Uint8Array(bytes))
    return true
  } catch {
    return false
  }
}

try {
  await page.goto(BASE)
  // 用 Playwright request context 登录（与 page 共享 cookie jar），然后直接 goto 进工作区。
  const loginRes = await page.request.post(`${BASE}/auth/login`, {
    data: ADMIN,
    headers: { 'Content-Type': 'application/json' }
  })
  if (!loginRes.ok()) throw new Error(`login failed: ${loginRes.status()}`)
  // 带 cookie 重新导航到工作区（不用 reload，避免 cookie 时序问题）。
  await page.goto(BASE)
  // 等工作区完全就绪：印章架的导入按钮出现说明 bootWorkspace 已完成（stamps 已加载）。
  await page.waitForSelector('label:has-text("导入印章")', { state: 'visible' })

  // 印章 PNG 在页面里用 canvas 生成（200×120 半透明红底 + 白 F）。
  const stampB64 = await page.evaluate(async () => {
    const canvas = document.createElement('canvas')
    canvas.width = 200
    canvas.height = 120
    const ctx = canvas.getContext('2d')
    ctx.fillStyle = 'rgba(190,30,45,0.9)'
    ctx.fillRect(4, 4, 192, 112)
    ctx.fillStyle = '#fff'
    ctx.fillRect(28, 20, 14, 80)
    ctx.fillRect(28, 20, 52, 14)
    const blob = await new Promise((r) => canvas.toBlob(r, 'image/png'))
    const buf = new Uint8Array(await blob.arrayBuffer())
    let s = ''
    for (const b of buf) s += String.fromCharCode(b)
    return btoa(s)
  })
  const stampPath = join(SMOKE, 'stamp.png')
  writeFileSync(stampPath, Buffer.from(stampB64, 'base64'))

  // S1 导入 PDF（首个项目，无去向对话框）。
  await page.setInputFiles('header input[type="file"]', srcPdfPath)
  await page.waitForSelector('header :text("3 页")')

  // S2 上传印章到库，等待印章卡片出现且 URL 可访问（state.stamps 已更新）。
  await page.setInputFiles('input[accept="image/png,image/jpeg,image/webp"]', stampPath)
  await page.waitForSelector('[data-shelf-item] img[src*="/api/stamps/"]')

  // S3 摆章：点印章卡片（arm）→ 点页面画布放置（连续盖章模式，放一次即可）。
  await page.click('[data-shelf-item]:has(img)')
  const overlay = page.locator('.cursor-crosshair').first()
  await overlay.waitFor()
  const box = await overlay.boundingBox()
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
  await page.keyboard.press('Escape') // 退出连续盖章

  // S4 本地出件：生成 → 产物 3 页、有章（≠源字节）、零上传。
  apiHits.length = 0
  const stamped = await download(() => page.click('header button:has-text("生成")'))
  check('本地出件：零上传', apiHits.length === 0, apiHits.join(','))
  check('本地出件：产物可解析且 3 页', await canLoad(stamped) && (await PDFDocument.load(new Uint8Array(stamped))).getPageCount() === 3)
  check('本地出件：确实盖了章', !readFileSync(srcPdfPath).equals(stamped))

  // S5 本地加密出件：设输出密码 → 产物已加密、qpdf.wasm 被拉取、仍零上传。
  // 密码框在「输出设置」Section 内，该 Section 默认折叠（DocumentPanel.tsx defaultOpen=false），
  // 先点标题展开。右侧检查器在 1600px 视口下默认停靠展开（RIGHT_DOCK_BP=1024）。
  const pwd = page.locator('input[type="password"][autocomplete="new-password"]')
  if (!(await pwd.isVisible().catch(() => false))) {
    await page.click('button:has-text("输出设置")')
  }
  await pwd.waitFor({ state: 'visible' })
  await pwd.fill('smoke-密码1')
  apiHits.length = 0
  wasmRequested = false
  const encrypted = await download(() => page.click('header button:has-text("生成")'))
  check('加密出件：零上传', apiHits.length === 0, apiHits.join(','))
  check('加密出件：qpdf.wasm 已按需加载', wasmRequested)
  check('加密出件：产物已加密（pdf-lib 打不开）', !(await canLoad(encrypted)))
  await page.fill('input[type="password"][autocomplete="new-password"]', '')

  // S6 图片导入（imageToPdf + compose 本地）：两张图 → 新项目，零上传。
  apiHits.length = 0
  await page.setInputFiles('header input[type="file"]', [stampPath, stampPath])
  await page.click('button:has-text("作为新项目打开")')
  await page.waitForSelector('header :text("2 页")')
  check('图片导入合并：零上传（imageToPdf+compose 均本地）', apiHits.length === 0, apiHits.join(','))

  // S7 关闭「优先本地处理」→ 云端回退管线完好。
  await page.click('header button[aria-label="生成选项"]')
  await page.click(':text("优先本地处理：开")')
  await page.keyboard.press('Escape')
  apiHits.length = 0
  const cloudOut = await download(() => page.click('header button:has-text("生成")'))
  check('关开关走云端：/api/process 被调用', apiHits.includes('/api/process'), apiHits.join(','))
  check('云端产物可解析', await canLoad(cloudOut))
} catch (err) {
  check('冒烟流程执行', false, String(err?.message ?? err))
} finally {
  await browser.close()
  serverProc?.kill()
}

const failed = results.filter((r) => !r.ok)
log(failed.length === 0 ? `\nSMOKE ALL PASS (${results.length})` : `\nSMOKE FAILURES: ${failed.length}/${results.length}`)
process.exit(failed.length === 0 ? 0 : 1)
