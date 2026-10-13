import type JSZip from 'jszip'
import type { LibrarySettings } from '../../lib/types'
import { librarySettings, useEditorStore } from '../../state/store'
import { flushSettings, loadSettings } from './settings'
import { listStamps, MAX_LIBRARY_BYTES, MAX_LIBRARY_STAMPS, mergeLibraryBackup, readLibrarySnapshot, validateSettings, validateStampImage, validStampId, type StoredStamp } from './storage'

const FORMAT = 'hlool-pdf-library'
const MAX_BYTES = MAX_LIBRARY_BYTES
// 1000 names + aliases of 500 non-ASCII characters exceed 2 MB in UTF-8.
const MAX_MANIFEST_BYTES = 8 * 1024 * 1024
const MAX_ARCHIVE_BYTES = MAX_BYTES + MAX_MANIFEST_BYTES + 1024 * 1024
type BackupStamp = Omit<StoredStamp, 'blob'> & { file: string }
type Manifest = { format: typeof FORMAT; version: 1; createdAt: string; settings: LibrarySettings; stamps: BackupStamp[] }

function invalid(message = '内容不完整或格式无效'): never {
  throw new Error(`资料备份${message}，未写入任何资料。请选择由 Hlool PDF 导出的有效备份。`)
}

const extension = (mime?: string) => mime === 'image/png' ? 'png' : mime === 'image/jpeg' ? 'jpg' : 'webp'

/** Deliberately excludes PDF bytes, filenames, placements and passwords. */
export async function exportLibraryBackup(): Promise<Blob> {
  await flushSettings()
  const { stamps, settings } = await readLibrarySnapshot()
  if (stamps.length > MAX_LIBRARY_STAMPS || stamps.reduce((sum, stamp) => sum + stamp.blob.size, 0) > MAX_BYTES) {
    throw new Error('资料备份超过 200 MB 或 1000 个印章，请先分批整理印章库。')
  }
  const { default: JSZip } = await import('jszip')
  const zip = new JSZip()
  const includedIds = new Set(stamps.map((stamp) => stamp.stampId))
  const preferences = validateSettings(settings?.data ?? librarySettings(useEditorStore.getState()))
  // A legacy cache or a concurrent deletion can leave orphaned metadata; never export an unrestorable reference.
  preferences.stampMeta = Object.fromEntries(Object.entries(preferences.stampMeta ?? {}).filter(([id]) => includedIds.has(id)))
  const manifest: Manifest = { format: FORMAT, version: 1, createdAt: new Date().toISOString(), settings: preferences, stamps: [] }
  for (const stamp of stamps) {
    const validated = await validateStampImage(stamp.blob)
    if (validated.digest !== stamp.digest || validated.widthPx !== stamp.widthPx || validated.heightPx !== stamp.heightPx) throw new Error('本机印章资料已损坏，无法生成完整备份，请保留浏览器数据并尝试恢复之前的资料备份。')
    const { blob, ...record } = stamp
    const file = `images/${stamp.stampId}.${extension(stamp.mime)}`
    manifest.stamps.push({ ...record, file })
    zip.file(file, await blob.arrayBuffer(), { createFolders: false })
  }
  const manifestBytes = new TextEncoder().encode(JSON.stringify(manifest, null, 2))
  if (manifestBytes.length > MAX_MANIFEST_BYTES) throw new Error('资料备份清单超过大小限制，请缩短印章名称或别名后重试。')
  zip.file('manifest.json', manifestBytes)
  return zip.generateAsync({ type: 'blob', mimeType: 'application/zip', compression: 'STORE' })
}

/** Enforce limits while inflating, even when an archive lies about its uncompressed size. */
function readEntry(entry: JSZip.JSZipObject, limit: number): Promise<Uint8Array<ArrayBuffer>> {
  // JSZip 3.10 supports this public method, but its bundled declarations omit it.
  const stream = (entry as JSZip.JSZipObject & { internalStream(type: 'uint8array'): JSZip.JSZipStreamHelper<Uint8Array> }).internalStream('uint8array')
  return new Promise((resolve, reject) => {
    let chunks: Uint8Array[] = []
    let length = 0
    let stopped = false
    stream.on('data', (chunk) => {
      if (stopped) return
      length += chunk.length
      if (length > limit) {
        stopped = true
        chunks = []
        stream.pause()
        reject(new Error('资料备份解压后文件超过限制，未写入任何资料。'))
        return
      }
      chunks.push(chunk)
    }).on('error', (error) => { chunks = []; stopped = true; reject(error) }).on('end', () => {
      if (stopped) return
      const result = new Uint8Array(length)
      let offset = 0
      for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length }
      chunks = []
      resolve(result)
    }).resume()
  })
}

function parseManifest(raw: string): Manifest {
  let value: unknown
  try { value = JSON.parse(raw) } catch { return invalid('清单不是有效 JSON') }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid()
  const manifest = value as Manifest
  if (Object.keys(manifest).some((key) => !['format', 'version', 'createdAt', 'settings', 'stamps'].includes(key))) return invalid()
  if (manifest.format !== FORMAT || manifest.version !== 1) return invalid('版本不受支持')
  if (typeof manifest.createdAt !== 'string' || !Number.isFinite(Date.parse(manifest.createdAt)) || !Array.isArray(manifest.stamps) || manifest.stamps.length > MAX_LIBRARY_STAMPS) return invalid()
  manifest.settings = validateSettings(manifest.settings)
  const seen = new Set<string>()
  for (const stamp of manifest.stamps) {
    if (!stamp || typeof stamp !== 'object' || Object.keys(stamp).some((key) => !['stampId', 'name', 'mime', 'size', 'widthPx', 'heightPx', 'createdAt', 'digest', 'file'].includes(key))) return invalid()
    if (!validStampId(stamp.stampId) || seen.has(stamp.stampId) || typeof stamp.name !== 'string' || !stamp.name.trim() || stamp.name.length > 500 || typeof stamp.createdAt !== 'string' || !Number.isFinite(Date.parse(stamp.createdAt))) return invalid()
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(stamp.mime ?? '') || !Number.isInteger(stamp.size) || !stamp.size || stamp.size < 0 || stamp.size > 25 * 1024 * 1024 || !Number.isInteger(stamp.widthPx) || stamp.widthPx < 1 || stamp.widthPx > 10000 || !Number.isInteger(stamp.heightPx) || stamp.heightPx < 1 || stamp.heightPx > 10000 || typeof stamp.digest !== 'string' || !/^[a-f0-9]{64}$/.test(stamp.digest)) return invalid()
    if (stamp.file !== `images/${stamp.stampId}.${extension(stamp.mime)}`) return invalid('图片路径无效')
    seen.add(stamp.stampId)
  }
  if (Object.keys(manifest.settings.stampMeta ?? {}).some((id) => !seen.has(id))) return invalid('设置引用了不存在的印章')
  return manifest
}

export async function importLibraryBackup(file: Blob): Promise<{ imported: number }> {
  if (!file.size || file.size > MAX_ARCHIVE_BYTES) return invalid('大小超出 200 MB 图片及清单的限制')
  const { default: JSZip } = await import('jszip')
  let zip: JSZip
  try { zip = await JSZip.loadAsync(await file.arrayBuffer()) } catch { return invalid('无法解压') }
  const entries = Object.values(zip.files)
  if (entries.length > MAX_LIBRARY_STAMPS + 2) return invalid('文件数量过多')
  let totalBytes = 0
  for (const entry of entries) {
    if (entry.dir) { if (entry.name !== 'images/') return invalid('包含未知目录'); continue }
    // JSZip exposes the original path after sanitizing it; reject traversal instead of accepting its renamed result.
    if (entry.unsafeOriginalName && entry.unsafeOriginalName !== entry.name) return invalid('图片路径无效')
    const size = (entry as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize
    if (!Number.isSafeInteger(size) || (size ?? -1) < 0 || (size ?? 0) > (entry.name === 'manifest.json' ? MAX_MANIFEST_BYTES : 25 * 1024 * 1024)) return invalid('解压后文件过大')
    totalBytes += size!
    if (totalBytes > MAX_BYTES + MAX_MANIFEST_BYTES) return invalid('解压后大小超过限制')
  }
  const manifestEntry = zip.file('manifest.json')
  if (!manifestEntry) return invalid('缺少清单')
  let manifest: Manifest
  try { manifest = parseManifest(new TextDecoder('utf-8', { fatal: true }).decode(await readEntry(manifestEntry, MAX_MANIFEST_BYTES))) } catch (error) {
    if (error instanceof Error && error.message.startsWith('资料备份')) throw error
    return invalid('清单设置无效')
  }
  const allowed = new Set(['manifest.json', ...manifest.stamps.map((stamp) => stamp.file)])
  if (entries.some((entry) => !entry.dir && !allowed.has(entry.name))) return invalid('包含未知文件')
  const stamps: StoredStamp[] = []
  for (const stamp of manifest.stamps) {
    const entry = zip.file(stamp.file)
    if (!entry) return invalid('缺少印章图片')
    try {
      const bytes = await readEntry(entry, Math.min(stamp.size!, 25 * 1024 * 1024))
      if (bytes.length !== stamp.size) return invalid('图片长度不匹配')
      const validated = await validateStampImage(new Blob([new Uint8Array(bytes)], { type: stamp.mime }))
      if (validated.mime !== stamp.mime || validated.digest !== stamp.digest || validated.widthPx !== stamp.widthPx || validated.heightPx !== stamp.heightPx) return invalid('图片校验失败')
      const { file: _file, ...record } = stamp
      stamps.push({ ...record, blob: validated.blob })
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('资料备份')) throw error
      return invalid('图片损坏或无法解码')
    }
  }
  // Every entry has been decoded and hashed before any writes begin.
  await flushSettings()
  const result = await mergeLibraryBackup(stamps, manifest.settings)
  await loadSettings()
  useEditorStore.getState().setStamps(await listStamps())
  return result
}
