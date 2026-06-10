import { getBlob, upload } from '../../lib/api'
import { idbDeleteStamp, idbGetAllStamps, idbPutStamp, type StoredStamp } from '../../lib/stampDb'
import type { StampAsset } from '../../lib/types'
import { toast } from '../../state/toasts'

/**
 * 印章持久层协调器。印章的真源在浏览器 IndexedDB，后端 stamps/ 只是
 * 本次会话的工作缓存（重启即清）：boot 时把浏览器里的印章重新上传
 * （重水化），并把旧版本遗留在服务端的印章迁入浏览器后认领。
 */

/** 浏览器端生成跨会话稳定的印章 id（与后端 stampIDPattern 对应）。 */
export function generateStampId(): string {
  return 'stamp_' + crypto.randomUUID().replaceAll('-', '')
}

let warnedDegraded = false
function warnDegradedOnce() {
  if (warnedDegraded) return
  warnedDegraded = true
  toast('此浏览器无法持久保存印章（可能处于隐私模式），印章仅本次会话有效')
}

function toRecord(asset: StampAsset, blob: Blob): StoredStamp {
  return {
    id: asset.stampId,
    name: asset.name,
    mime: blob.type || 'image/png',
    blob,
    widthPx: asset.widthPx,
    heightPx: asset.heightPx,
    createdAt: Date.parse(asset.createdAt) || Date.now()
  }
}

/** 新上传的印章写入浏览器持久层；失败仅提示一次并退化为会话级。 */
export async function persistStamp(asset: StampAsset, blob: Blob): Promise<void> {
  const ok = await idbPutStamp(toRecord(asset, blob))
  if (!ok) warnDegradedOnce()
}

export async function forgetStamp(stampId: string): Promise<void> {
  await idbDeleteStamp(stampId)
}

/** 后端按文件名后缀校验格式，重水化上传前补齐缺失的扩展名。 */
function ensureExt(name: string, mime: string): string {
  if (/\.(png|jpe?g)$/i.test(name)) return name
  return `${name || '印章'}${mime === 'image/jpeg' ? '.jpg' : '.png'}`
}

function claimUpload(id: string, blob: Blob, name: string, mime: string) {
  return upload<StampAsset>('/api/stamps', blob, ensureExt(name, mime), { stampId: id })
}

/**
 * boot 重水化：对每个 id 在「IndexedDB ∪ 后端」并集上分三类处理——
 * 仅浏览器有（后端重启被清）→ 重新上传；仅后端有（旧版遗留/其他设备）
 * → 下载入库并认领；两边都有但未认领 → 补一次认领。
 * 返回合并后的印章列表、应保留别名的 id 并集、恢复失败数。
 */
export async function rehydrateStamps(
  backend: StampAsset[]
): Promise<{ stamps: StampAsset[]; keepMetaIds: string[]; failed: number }> {
  const stored = await idbGetAllStamps()
  if (stored === null) {
    // IndexedDB 不可用：服务端 legacy 印章受 sessionScoped=false 保护不会
    // 被启动清空，等价于退回旧的“应用层持久化”行为，无需打扰用户。
    return { stamps: backend, keepMetaIds: backend.map((s) => s.stampId), failed: 0 }
  }

  const byId = new Map(backend.map((s) => [s.stampId, s]))
  const storedIds = new Set(stored.map((r) => r.id))
  const keepMetaIds = new Set([...storedIds, ...byId.keys()])
  let failed = 0

  // createdAt 升序串行重水化，让后端记录顺序与原始导入顺序一致（印章架按时间排序）。
  for (const record of [...stored].sort((a, b) => a.createdAt - b.createdAt)) {
    const existing = byId.get(record.id)
    if (existing && existing.sessionScoped) continue
    try {
      const fresh = await claimUpload(record.id, record.blob, record.name, record.mime)
      byId.set(fresh.stampId, fresh)
    } catch {
      if (!existing) failed++
      // 已存在但认领失败无害：印章本会话仍可用，下次 boot 重试。
    }
  }

  // 仅后端有：下载进浏览器（升级迁移 + 其他标签页/设备上传的自愈补齐）。
  for (const asset of backend) {
    if (storedIds.has(asset.stampId)) continue
    try {
      const blob = await getBlob(asset.url)
      if (!(await idbPutStamp(toRecord(asset, blob)))) {
        warnDegradedOnce()
        continue // 写入失败不认领，保留 legacy 保护
      }
      if (!asset.sessionScoped) {
        const fresh = await claimUpload(asset.stampId, blob, asset.name, blob.type || 'image/png')
        byId.set(fresh.stampId, fresh)
      }
    } catch {
      // 下载/认领失败：印章本会话仍可用（后端还在），下次 boot 重试。
    }
  }

  const merged = [...byId.values()].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
  return { stamps: merged, keepMetaIds: [...keepMetaIds], failed }
}
