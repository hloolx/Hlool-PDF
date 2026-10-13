/**
 * 本地盖章 Web Worker 壳：大文件的解锁/盖章/加密不占主线程（LOCAL_FIRST.md P3）。
 * 消息协议：先发 ready，入 StampJobInput（Blob），出 { ok, bytes | error }。
 * 业务错误直接显示给用户；仅 Worker 启动失败才在主线程处理。
 */
import type { StampJobInput } from './actions'
import { runStampJobInline } from './stampJob'

const port = self as unknown as Worker

self.onmessage = async (event: MessageEvent<StampJobInput>) => {
  try {
    const out = await runStampJobInline(event.data)
    const buffer = out.byteOffset === 0 && out.byteLength === out.buffer.byteLength ? out.buffer : out.slice().buffer
    port.postMessage({ ok: true, bytes: buffer }, [buffer as ArrayBuffer])
  } catch (err) {
    port.postMessage({ ok: false, error: err instanceof Error ? err.message : String(err) })
  }
}

port.postMessage({ ready: true })
