/**
 * 本地盖章 Web Worker 壳：大文件的解锁/盖章/加密不占主线程（LOCAL_FIRST.md P3）。
 * 消息协议：入 StampJobInput（buffer 走 transfer），出 { ok, bytes | error }。
 * 业务错误经 onmessage 回传（调用方回退云端）；Worker 自身起不来由调用方降级主线程。
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
