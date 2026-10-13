/** Worker messages distinguish startup availability from a failed operation. */
export type BrowserWorkerReply =
  | { ready: true }
  | { ok: true; bytes: ArrayBuffer }
  | { ok: false; error: string }

export class WorkerUnavailableError extends Error {}

type WorkerJobOptions = {
  startupTimeoutMs?: number
  jobTimeoutMs?: number
}

/**
 * Only a worker that never became ready can fall back to the main thread.
 * A timeout, crash or business error after startup must not replay expensive work.
 */
export async function runBrowserJob<T>(
  createWorker: () => Worker,
  input: T,
  inline: (input: T) => Promise<Uint8Array>,
  options: WorkerJobOptions = {}
): Promise<Uint8Array> {
  try {
    return await runInWorker(createWorker, input, options)
  } catch (error) {
    if (!(error instanceof WorkerUnavailableError)) throw error
    return inline(input)
  }
}

function runInWorker<T>(createWorker: () => Worker, input: T, options: WorkerJobOptions): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    let worker: Worker
    try {
      worker = createWorker()
    } catch (error) {
      reject(new WorkerUnavailableError('浏览器无法启动后台处理。', { cause: error }))
      return
    }
    let ready = false
    let settled = false
    let timer: ReturnType<typeof setTimeout>
    const finish = (callback: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      worker.onmessage = null
      worker.onerror = null
      worker.onmessageerror = null
      worker.terminate()
      callback()
    }
    timer = setTimeout(
      () => finish(() => reject(new WorkerUnavailableError('后台处理组件启动超时。'))),
      options.startupTimeoutMs ?? 30_000
    )
    worker.onmessage = (event: MessageEvent<BrowserWorkerReply>) => {
      const data = event.data
      if (!data || typeof data !== 'object') {
        finish(() => reject(new Error('本地处理组件返回了无效响应，请刷新页面后重试。')))
        return
      }
      if ('ready' in data && data.ready === true) {
        if (ready) return
        ready = true
        clearTimeout(timer)
        timer = setTimeout(
          () => finish(() => reject(new Error('本地处理超过 5 分钟，已停止。请拆分文件或降低扫描清晰度后重试。'))),
          options.jobTimeoutMs ?? 5 * 60_000
        )
        try {
          // Blobs remain readable if worker startup is unavailable; do not transfer source buffers.
          worker.postMessage(input)
        } catch (error) {
          finish(() => reject(new Error('无法向后台传递文件，请重新导入后重试。', { cause: error })))
        }
        return
      }
      if (!ready || !data || !('ok' in data)) {
        finish(() => reject(new Error('本地处理组件返回了无效响应，请刷新页面后重试。')))
      } else if (data.ok === true && data.bytes instanceof ArrayBuffer && data.bytes.byteLength > 0) {
        finish(() => resolve(new Uint8Array(data.bytes)))
      } else if (data.ok === false && typeof data.error === 'string') {
        finish(() => reject(new Error(data.error)))
      } else {
        finish(() => reject(new Error('本地处理组件未返回有效文件，请重新导入后重试。')))
      }
    }
    worker.onerror = (event) => {
      event.preventDefault()
      finish(() => reject(ready
        ? new Error('浏览器后台处理意外停止，请关闭其他标签页或拆分文件后重试。')
        : new WorkerUnavailableError('后台处理组件加载失败。')))
    }
    worker.onmessageerror = () => finish(() => reject(new Error('无法读取后台处理结果，请重新导入后重试。')))
  })
}
