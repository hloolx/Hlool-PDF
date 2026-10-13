import assert from 'node:assert/strict'
import { test } from 'node:test'
import { runBrowserJob, type BrowserWorkerReply } from './browserWorker'

class FakeWorker {
  onmessage: ((event: MessageEvent<BrowserWorkerReply>) => void) | null = null
  onerror: ((event: ErrorEvent) => void) | null = null
  onmessageerror: (() => void) | null = null
  sent: unknown[] = []
  terminated = 0
  postMessage(input: unknown) { this.sent.push(input) }
  terminate() { this.terminated++ }
  emit(data: BrowserWorkerReply) { this.onmessage?.({ data } as MessageEvent<BrowserWorkerReply>) }
  error() { this.onerror?.({ preventDefault() {} } as ErrorEvent) }
  factory = () => this as unknown as Worker
}

test('worker unavailable: inline path can still read the complete input Blob', async () => {
  const input = new Blob(['original PDF bytes'])
  const result = await runBrowserJob(() => { throw new Error('CSP blocks worker') }, input, async (blob) => {
    assert.equal(await blob.text(), 'original PDF bytes')
    return new Uint8Array([42])
  })
  assert.deepEqual([...result], [42])
})

test('handshake sends the job once; success terminates the worker and removes handlers', async () => {
  const worker = new FakeWorker()
  const input = new Blob(['pdf'])
  const result = runBrowserJob(worker.factory, input, async () => { throw new Error('unexpected replay') })
  assert.equal(worker.sent.length, 0)
  worker.emit({ ready: true })
  worker.emit({ ready: true })
  assert.deepEqual(worker.sent, [input])
  worker.emit({ ok: true, bytes: new Uint8Array([1, 2]).buffer })
  assert.deepEqual([...await result], [1, 2])
  assert.equal(worker.terminated, 1)
  assert.equal(worker.onmessage, null)
  assert.equal(worker.onerror, null)
  assert.equal(worker.onmessageerror, null)
})

test('worker startup error and startup timeout fall back locally after cleanup', async () => {
  for (const failure of ['error', 'timeout']) {
    const worker = new FakeWorker()
    let inlineCalls = 0
    const result = runBrowserJob(worker.factory, {}, async () => {
      inlineCalls++
      return new Uint8Array([3])
    }, { startupTimeoutMs: 5 })
    if (failure === 'error') worker.error()
    assert.deepEqual([...await result], [3])
    assert.equal(inlineCalls, 1)
    assert.equal(worker.sent.length, 0)
    assert.equal(worker.terminated, 1)
  }
})

test('business errors, crashes and timeouts stop without replaying or making any network request', async () => {
  const originalFetch = globalThis.fetch
  let networkCalls = 0
  globalThis.fetch = async () => { networkCalls++; throw new Error('network prohibited') }
  try {
    for (const failure of ['business', 'crash', 'timeout', 'message']) {
      const worker = new FakeWorker()
      let inlineCalls = 0
      const result = runBrowserJob(worker.factory, {}, async () => {
        inlineCalls++
        return new Uint8Array()
      }, { jobTimeoutMs: 5 })
      worker.emit({ ready: true })
      if (failure === 'business') worker.emit({ ok: false, error: '损坏的 PDF' })
      if (failure === 'crash') worker.error()
      if (failure === 'message') worker.onmessageerror?.()
      await assert.rejects(result, failure === 'business' ? /损坏的 PDF/ : /本地处理|意外停止|无法读取/)
      assert.equal(inlineCalls, 0, failure)
      assert.equal(worker.terminated, 1, failure)
    }
    assert.equal(networkCalls, 0)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('inline failure is propagated; an invalid worker response never becomes an output', async () => {
  const inlineError = new Error('本地引擎也无法解析此 PDF')
  await assert.rejects(runBrowserJob(() => { throw new Error('unavailable') }, {}, async () => {
    throw inlineError
  }), (error) => error === inlineError)
  const worker = new FakeWorker()
  const result = runBrowserJob(worker.factory, {}, async () => new Uint8Array())
  worker.emit({ ok: true, bytes: new ArrayBuffer(0) })
  await assert.rejects(result, /无效响应/)
  assert.equal(worker.terminated, 1)
})

test('malformed messages and empty output reject promptly and clean up the worker', async () => {
  for (const message of ['unexpected string', { ok: true, bytes: new ArrayBuffer(0) }]) {
    const worker = new FakeWorker()
    const result = runBrowserJob(worker.factory, {}, async () => { throw new Error('must not replay') })
    worker.emit({ ready: true })
    worker.emit(message as BrowserWorkerReply)
    await assert.rejects(result, /无效响应|未返回有效文件/)
    assert.equal(worker.terminated, 1)
  }
})
