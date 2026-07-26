/**
 * 文件指纹：size + 文件名 + 首尾各 64KB 字节做哈希。
 * 只用于「同一个文件重新导入时恢复盖章配置」的本地匹配（不存 PDF 本身，
 * 不碰阅后即焚底线），不追求密码学强度：优先 SHA-256（需要安全上下文），
 * HTTP 自部署环境退化为 FNV-1a 双散列 + 长度。
 */
const CHUNK = 64 * 1024

export async function fileFingerprint(name: string, blob: Blob): Promise<string> {
  const head = new Uint8Array(await blob.slice(0, CHUNK).arrayBuffer())
  const tail = new Uint8Array(await blob.slice(Math.max(0, blob.size - CHUNK)).arrayBuffer())
  const meta = new TextEncoder().encode(`${blob.size}|${name}|`)
  const bytes = new Uint8Array(meta.length + head.length + tail.length)
  bytes.set(meta, 0)
  bytes.set(head, meta.length)
  bytes.set(tail, meta.length + head.length)
  if (crypto.subtle) {
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
    return 's-' + hex(digest.subarray(0, 16))
  }
  return `f-${fnv1a(bytes, 0x811c9dc5).toString(16)}-${fnv1a(bytes, 0x6c62272e).toString(16)}-${blob.size.toString(16)}`
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

function fnv1a(bytes: Uint8Array, seed: number): number {
  let hash = seed >>> 0
  for (let i = 0; i < bytes.length; i++) {
    hash ^= bytes[i]
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash >>> 0
}
