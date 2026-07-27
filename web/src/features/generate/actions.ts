import { ApiError, errorText, getBlob, postFormBlob } from '../../lib/api'
import { downloadBlob } from '../../lib/download'
import { normalizePageExpr, parsePageExpression } from '../../lib/pages'
import { DEFAULT_SCAN, type PDFFile, type ScanConfig } from '../../lib/types'
// 仅类型引用：编译期擦除，不会把懒加载分包拉进静态依赖图（拆包约定见 workspace/boot.ts）。
import type { PlacementParam, SeamSealParam } from './localEngine'
import { activeFile, configuredFiles, hasConfig, useEditorStore, withinLocalLimit, type EditorState } from '../../state/store'
import { toast } from '../../state/toasts'
import { requireReauth } from '../auth/useAuth'

export function generationStatus(state: EditorState): { ok: boolean; hint: string } {
  const file = activeFile(state)
  if (!file) return { ok: false, hint: '请先导入 PDF' }
  const config = state.configs[file.fileId]
  const hasPlacements = (config?.placements.length ?? 0) > 0
  const seamOn = Boolean(config?.seamEnabled)
  const scanOn = Boolean(config?.scanEnabled)
  // 没有任何印章：直接导出 / 拼接当前 PDF（仍可改名、加密、加扫描效果）。
  if (!hasPlacements && !seamOn) {
    return { ok: true, hint: scanOn ? '导出扫描效果 PDF，原文件不受影响' : '导出 PDF（未盖章），原文件不受影响' }
  }
  if (config?.seamEnabled) {
    if (!config.seam.stampId) return { ok: false, hint: '骑缝章还未选择印章图片' }
    const expr = parsePageExpression(config.seam.pages, file.pageCount)
    if (expr.invalidParts.length > 0) return { ok: false, hint: `骑缝章页范围无效：${expr.invalidParts.join('、')}` }
    if (expr.pages.length < 2) return { ok: false, hint: '骑缝章至少需要 2 页' }
  }
  return { ok: true, hint: '生成新的 PDF，原文件不受影响' }
}

export function outputNameFor(state: EditorState, file: PDFFile) {
  const base = file.name.replace(/\.pdf$/i, '')
  // 未盖任何章时按原名导出，避免“-已盖章”后缀误导。
  if (!hasConfig(state.configs[file.fileId])) return `${base}.pdf`
  const template = state.outputNameTemplate.trim() || '{原名}-已盖章'
  const name = template.replaceAll('{原名}', base)
  return name.toLowerCase().endsWith('.pdf') ? name : `${name}.pdf`
}

function buildParams(state: EditorState, file: PDFFile, options?: { omitOutputPassword?: boolean }) {
  const config = state.configs[file.fileId]
  const placements = (config?.placements ?? []).map(({ id: _id, sourceId: _sourceId, ...rest }) => rest)
  const seamSeals =
    config?.seamEnabled && config.seam.stampId
      ? [
          {
            stampId: config.seam.stampId,
            pages: normalizePageExpr(config.seam.pages),
            side: config.seam.side,
            sizePt: config.seam.sizePt,
            positionPercent: config.seam.positionPercent,
            marginPt: config.seam.marginPt,
            opacity: config.seam.opacity,
            maxSlices: config.seam.maxSlices,
            randomSeed: config.seam.randomSeed
          }
        ]
      : []
  return {
    placements,
    seamSeals,
    outputPassword: options?.omitOutputPassword ? '' : state.outputPassword,
    outputName: outputNameFor(state, file)
  }
}

export type ProcessRoute = { kind: 'local' | 'cloud'; reason?: string }

/**
 * 出件路由判定（LOCAL_FIRST.md 回退矩阵的静态部分）。UI 徽标与执行共用此函数，
 * 保证「显示的路径」与「实际走的路径」同源；本地引擎运行期异常另有动态回退。
 * P2 起加密输入/输出都由 qpdf-wasm 本地收编，只剩「开关关 / 超上限 / 运行期异常」走云端。
 */
export function decideRoute(state: EditorState, file: PDFFile): ProcessRoute {
  if (!state.preferLocalProcessing) return { kind: 'cloud', reason: '已关闭优先本地处理' }
  if (!withinLocalLimit(state, file.size)) return { kind: 'cloud', reason: `文件超过 ${state.localMaxMB}MB 上限` }
  return { kind: 'local' }
}

/**
 * 同步加工（出件唯一入口）：按回退矩阵分流 —— 本地引擎盖章（文件不上传）或
 * /api/process 云端盖章；开扫描则继续本地逐页重扫。返回成品字节与文件名。
 * 本地路径的任何异常自动落回云端管线（登录失效除外，直接抛给上层重新登录）。
 */
export async function processFile(file: PDFFile, busyPrefix = ''): Promise<{ blob: Blob; name: string }> {
  const state = useEditorStore.getState()
  const config = state.configs[file.fileId]
  const scanConfig = config?.scanEnabled ? (config.scanConfig ?? DEFAULT_SCAN) : null
  if (decideRoute(state, file).kind === 'local') {
    try {
      return await processLocally(state, file, scanConfig, busyPrefix)
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) throw err
      console.warn('[local-engine] 回退云端：', err)
      toast(`${file.name}：本地处理未成功，已转云端处理`)
    }
  }
  return processViaCloud(state, file, scanConfig, busyPrefix)
}

/**
 * 本地管线：（可选 qpdf 解锁加密输入）→ localEngine 盖章 →（可选）本地扫描 →
 * （可选 qpdf AES-256 输出加密）。印章字节从同源库接口拉取（几十 KB 级），
 * PDF 本体全程不出浏览器。盖章与解锁/加密默认在 Web Worker 里跑（大文件不卡
 * UI），Worker 不可用时降级主线程同逻辑。
 */
async function processLocally(
  state: EditorState,
  file: PDFFile,
  scanConfig: ScanConfig | null,
  busyPrefix: string
): Promise<{ blob: Blob; name: string }> {
  const params = buildParams(state, file, { omitOutputPassword: true })
  useEditorStore.getState().setBusy(`${busyPrefix}本地盖章…`)

  const assets = await fetchStampAssets(state, [
    ...params.placements.map((p) => p.stampId),
    ...params.seamSeals.map((s) => s.stampId)
  ])

  // 开扫描时先不加密（扫描要读明文产物），扫完再补加密；未开扫描则一趟出加密件。
  const outputPassword = scanConfig ? '' : state.outputPassword
  const stamped = await runStampJob({
    pdf: file.blob,
    params,
    stamps: assets,
    password: file.password ?? '',
    outputPassword,
    outputOwnerPassword: ''
  })
  let blob = new Blob([stamped as BlobPart], { type: 'application/pdf' })

  if (scanConfig) {
    blob = await applyScan(blob, scanConfig, busyPrefix)
    if (state.outputPassword) blob = await encryptLocally(blob, state.outputPassword, busyPrefix)
  }
  return { blob, name: params.outputName }
}

/**
 * 本地盖章作业的输入（Worker 与主线程降级路径共用同一形状）。
 * 字节全部以 Blob 传递：结构化克隆对 Blob 是零拷贝引用，且没有 ArrayBuffer
 * transfer 后 detach 的问题 —— Worker 起不来时主线程降级仍能读到完整数据。
 */
export type StampJobInput = {
  pdf: Blob
  params: { placements: PlacementParam[]; seamSeals: SeamSealParam[] }
  stamps: Record<string, { blob: Blob; widthPx: number; heightPx: number }>
  /** 加密输入的打开密码（qpdf 解锁）。 */
  password: string
  /** 非空则产物本地 AES-256 加密（qpdf）。 */
  outputPassword: string
  outputOwnerPassword: string
}

/** 优先把盖章作业交给 Web Worker；Worker 起不来（老浏览器/CSP）降级主线程同逻辑。 */
async function runStampJob(job: StampJobInput): Promise<Uint8Array> {
  try {
    return await runStampJobInWorker(job)
  } catch (err) {
    // Worker 自身的启动问题才降级主线程；作业内的业务错误原样上抛（回退云端）。
    if (!(err instanceof WorkerUnavailableError)) throw err
    const { runStampJobInline } = await import('./stampJob')
    return runStampJobInline(job)
  }
}

class WorkerUnavailableError extends Error {}

function runStampJobInWorker(job: StampJobInput): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    let worker: Worker
    try {
      worker = new Worker(new URL('./stampWorker.ts', import.meta.url), { type: 'module' })
    } catch (err) {
      reject(new WorkerUnavailableError(String(err)))
      return
    }
    const done = (fn: () => void) => {
      worker.terminate()
      fn()
    }
    worker.onmessage = (event: MessageEvent<{ ok: true; bytes: ArrayBuffer } | { ok: false; error: string }>) => {
      const data = event.data
      if (data.ok) done(() => resolve(new Uint8Array(data.bytes)))
      else done(() => reject(new Error(data.error)))
    }
    // onerror = worker 脚本没跑起来（加载失败等）——降级主线程；作业错误走 onmessage。
    worker.onerror = (event) => done(() => reject(new WorkerUnavailableError(event.message)))
    worker.postMessage(job)
  })
}

/** 本地 AES-256 加密（qpdf-wasm 懒加载）。 */
async function encryptLocally(blob: Blob, outputPassword: string, busyPrefix: string): Promise<Blob> {
  useEditorStore.getState().setBusy(`${busyPrefix}正在加密…`)
  const { encryptPdf } = await import('./qpdf')
  const bytes = await encryptPdf(new Uint8Array(await blob.arrayBuffer()), outputPassword)
  return new Blob([bytes as BlobPart], { type: 'application/pdf' })
}

/** 从同源印章库拉取引擎所需的印章字节与像素元数据（去重）。 */
async function fetchStampAssets(
  state: EditorState,
  stampIds: string[]
): Promise<Record<string, { blob: Blob; widthPx: number; heightPx: number }>> {
  const assets: Record<string, { blob: Blob; widthPx: number; heightPx: number }> = {}
  for (const id of new Set(stampIds)) {
    const meta = state.stamps.find((s) => s.stampId === id)
    if (!meta) throw new Error(`印章不在库中：${id}`)
    assets[id] = { blob: await getBlob(meta.url), widthPx: meta.widthPx, heightPx: meta.heightPx }
  }
  return assets
}

/**
 * 游离 PDF（不在工作区、页码已重映射）的本地优先盖章/加密，供单页导出等场景复用：
 * 本地引擎处理，异常回退云端 /api/process（与 processFile 同一回退语义）。
 */
export async function processDetachedPdf(
  blob: Blob,
  placements: PlacementParam[],
  outputPassword: string,
  outputName: string
): Promise<Blob> {
  const state = useEditorStore.getState()
  if (state.preferLocalProcessing && withinLocalLimit(state, blob.size)) {
    try {
      const assets = await fetchStampAssets(state, placements.map((p) => p.stampId))
      const bytes = await runStampJob({
        pdf: blob,
        params: { placements, seamSeals: [] },
        stamps: assets,
        password: '',
        outputPassword,
        outputOwnerPassword: ''
      })
      return new Blob([bytes as BlobPart], { type: 'application/pdf' })
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) throw err
      console.warn('[local-engine] 单页导出回退云端：', err)
    }
  }
  const form = new FormData()
  form.append('file', blob, outputName)
  form.append('params', JSON.stringify({ placements, seamSeals: [], outputPassword, outputName }))
  return postFormBlob('/api/process', form)
}

/** 云端管线（回退兜底，行为与本地化之前完全一致）：/api/process 盖章（可选）本地扫描（可选）补加密。 */
async function processViaCloud(
  state: EditorState,
  file: PDFFile,
  scanConfig: ScanConfig | null,
  busyPrefix: string
): Promise<{ blob: Blob; name: string }> {
  // pdf-lib 重建的 PDF 无法加密：开扫描时第一遍不带输出密码，扫描完再请服务端补加密。
  const params = buildParams(state, file, { omitOutputPassword: Boolean(scanConfig) })
  useEditorStore.getState().setBusy(`${busyPrefix}云端处理中…`)
  const form = new FormData()
  form.append('file', file.blob, file.name)
  form.append('params', JSON.stringify(params))
  if (file.password) form.append('password', file.password)
  let blob = await postFormBlob('/api/process', form)
  if (scanConfig) {
    blob = await applyScan(blob, scanConfig, busyPrefix, file.password)
    if (state.outputPassword) blob = await encryptViaCloud(blob, params.outputName, state.outputPassword, busyPrefix)
  }
  return { blob, name: params.outputName }
}

async function applyScan(blob: Blob, scanConfig: ScanConfig, busyPrefix: string, password?: string): Promise<Blob> {
  // 动态加载：pdfjs 与 pdf-lib 都很重，严禁静态引入（否则会进入口包，拆包约定见 boot.ts）。
  const { processPDFWithScan } = await import('../scan/processor')
  return processPDFWithScan(blob, scanConfig, {
    password,
    onProgress: (current, total) => useEditorStore.getState().setBusy(`${busyPrefix}扫描处理 ${current}/${total} 页…`)
  })
}

/** 服务端补加密：空章 + 输出密码的二遍 /api/process（产物很小的那份才上传，通常远小于源文件）。 */
async function encryptViaCloud(blob: Blob, outputName: string, outputPassword: string, busyPrefix: string): Promise<Blob> {
  useEditorStore.getState().setBusy(`${busyPrefix}正在加密…`)
  const form = new FormData()
  form.append('file', blob, outputName)
  form.append('params', JSON.stringify({ placements: [], seamSeals: [], outputPassword, outputName }))
  return postFormBlob('/api/process', form)
}

export async function generateCurrent() {
  const state = useEditorStore.getState()
  const status = generationStatus(state)
  const file = activeFile(state)
  if (!status.ok || !file) {
    toast(status.hint, { kind: 'error' })
    return
  }
  useEditorStore.getState().setBusy('正在生成…')
  try {
    // 前缀保证内部各阶段（本地盖章/扫描/加密）的 busy 文案都以「正在生成」开头，
    // TopBar 以此前缀判定生成中状态。
    const output = await processFile(file, '正在生成：')
    downloadBlob(output.blob, output.name)
    toast('已生成，开始下载', { kind: 'success' })
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) requireReauth()
    else toast(errorText(err), { kind: 'error' })
  } finally {
    useEditorStore.getState().setBusy('')
  }
}

/** ZIP 内文件名去重：重名追加 -2 / -3 …（浏览器多文件下载会被拦，ZIP 里重名会互相覆盖）。 */
function uniqueZipName(name: string, used: Set<string>): string {
  let candidate = name
  for (let i = 2; used.has(candidate.toLowerCase()); i++) {
    candidate = name.replace(/\.pdf$/i, '') + `-${i}.pdf`
  }
  used.add(candidate.toLowerCase())
  return candidate
}

function zipFileName(): string {
  const now = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `盖章文件-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}.zip`
}

/** 批量：逐个文件走 processFile（本地优先）；多个成品打包成一个 ZIP 单次下载（单文件保持直下）。 */
export async function generateAll() {
  const files = configuredFiles(useEditorStore.getState())
  if (files.length === 0) {
    toast('还没有任何文件配置了印章。', { kind: 'error' })
    return
  }
  const outputs: Array<{ blob: Blob; name: string }> = []
  let failed = 0
  try {
    for (const file of files) {
      const prefix = `正在生成 ${outputs.length + failed + 1}/${files.length}：`
      useEditorStore.getState().setBusy(`${prefix}处理中…`)
      try {
        outputs.push(await processFile(file, prefix))
      } catch (err) {
        failed++
        if (err instanceof ApiError && err.status === 401) {
          requireReauth()
          return
        }
        toast(`${file.name}：${errorText(err)}`, { kind: 'error' })
      }
    }
    if (outputs.length === 0) return
    if (outputs.length === 1) {
      downloadBlob(outputs[0].blob, outputs[0].name)
    } else {
      useEditorStore.getState().setBusy('正在打包 ZIP…')
      // 动态加载：jszip 只在批量出件时用到，不进入口包。
      const { default: JSZip } = await import('jszip')
      const zip = new JSZip()
      const used = new Set<string>()
      for (const output of outputs) {
        zip.file(uniqueZipName(output.name, used), output.blob)
      }
      // PDF 本身已压缩，STORE 打包速度快且体积几乎不变。
      const bundle = await zip.generateAsync({ type: 'blob', compression: 'STORE' })
      downloadBlob(bundle, zipFileName())
    }
  } finally {
    useEditorStore.getState().setBusy('')
  }
  if (failed === 0) {
    toast(outputs.length > 1 ? `已生成 ${outputs.length} 个文件，打包为 ZIP 下载` : '已生成，开始下载', { kind: 'success' })
  } else if (outputs.length > 0) {
    toast(`已生成 ${outputs.length} 个，失败 ${failed} 个`, { kind: 'error' })
  }
}
