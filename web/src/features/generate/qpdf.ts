/**
 * qpdf-wasm 封装：输出 AES-256 加密与加密输入解锁在浏览器本地完成
 * （LOCAL_FIRST.md P2-2「加密收编」）。
 *
 * - 懒加载：本模块自身是异步分包，qpdf.wasm（约 1.3MB）只在用到密码功能时下载；
 * - 参数与服务端对齐：加密 = pdfcpu NewAESConfiguration(user, owner, 256) +
 *   PermissionsAll ↔ qpdf `--encrypt user owner 256 --`（qpdf 缺省权限即全开，
 *   owner 为空时沿用 user，与 pdf.go StampPDF:163-168 同义）；
 *   解锁 = pdfcpu api.DecryptFile ↔ qpdf `--password=… --decrypt`。
 * - 每次调用新建 wasm 实例：qpdf 的 main() 不保证可重入，wasm 字节有 HTTP 缓存，
 *   实例化开销毫秒级，可靠性优先。
 */
import wasmUrl from '@neslinesli93/qpdf-wasm/dist/qpdf.wasm?url'

type QpdfFS = {
  writeFile: (path: string, data: Uint8Array) => void
  readFile: (path: string) => Uint8Array
}

async function runQpdf(args: string[], input: Uint8Array): Promise<Uint8Array> {
  const { default: createModule } = await import('@neslinesli93/qpdf-wasm')
  // 包自带 d.ts 只声明了部分 FS 方法（缺 writeFile），按实际 Emscripten 形状收窄。
  const qpdf = await (createModule as unknown as (opts: object) => Promise<{ callMain: (a: string[]) => number; FS: QpdfFS }>)({
    locateFile: () => wasmUrl,
    noInitialRun: true,
    // 静默 qpdf 的 stdout/stderr（Emscripten 默认打到 console）。
    print: () => {},
    printErr: () => {}
  })
  qpdf.FS.writeFile('/in.pdf', input)
  let code: number
  try {
    code = qpdf.callMain(args)
  } catch (err) {
    // Emscripten 以 ExitStatus 异常表达非零退出。
    const status = (err as { status?: number }).status
    if (typeof status === 'number') code = status
    else throw err
  }
  // qpdf 退出码 3 = 带警告成功。
  if (code !== 0 && code !== 3) throw new Error(`qpdf 处理失败（退出码 ${code}）`)
  return qpdf.FS.readFile('/out.pdf')
}

/** AES-256 加密（权限全开）。owner 密码为空时沿用打开密码，与服务端一致。 */
export async function encryptPdf(bytes: Uint8Array, userPassword: string, ownerPassword = ''): Promise<Uint8Array> {
  if (!userPassword) throw new Error('缺少输出密码')
  const owner = ownerPassword || userPassword
  return runQpdf(['--encrypt', userPassword, owner, '256', '--', '/in.pdf', '/out.pdf'], bytes)
}

/** 用打开密码解锁，输出明文 PDF（服务端 DecryptPDF 同义）。 */
export async function decryptPdf(bytes: Uint8Array, password: string): Promise<Uint8Array> {
  if (!password) throw new Error('缺少打开密码')
  return runQpdf([`--password=${password}`, '--decrypt', '/in.pdf', '/out.pdf'], bytes)
}
