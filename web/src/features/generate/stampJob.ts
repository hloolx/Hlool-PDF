/**
 * 本地盖章作业核心：（可选）qpdf 解锁加密输入 → localEngine 盖章 →（可选）
 * qpdf AES-256 输出加密。Web Worker（stampWorker.ts）与主线程降级路径共用，
 * 保证两条路径行为完全一致。
 */
import type { StampJobInput } from './actions'

export async function runStampJobInline(job: StampJobInput): Promise<Uint8Array> {
  let bytes: Uint8Array<ArrayBufferLike> = new Uint8Array(await job.pdf.arrayBuffer())
  if (job.password) {
    const { decryptPdf } = await import('./qpdf')
    bytes = await decryptPdf(bytes, job.password)
  }
  const stamps: Record<string, { bytes: ArrayBuffer; widthPx: number; heightPx: number }> = {}
  for (const [id, s] of Object.entries(job.stamps)) {
    stamps[id] = { bytes: await s.blob.arrayBuffer(), widthPx: s.widthPx, heightPx: s.heightPx }
  }
  const { stampPdfLocally } = await import('./localEngine')
  let out = await stampPdfLocally(bytes, job.params, stamps)
  if (job.outputPassword) {
    const { encryptPdf } = await import('./qpdf')
    out = await encryptPdf(out, job.outputPassword, job.outputOwnerPassword)
  }
  return out
}
