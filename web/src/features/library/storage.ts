import type { LibrarySettings, StampAsset } from '../../lib/types'
import { generateStampId } from '../stamps/persistence'

const DB_NAME = 'hlool-pdf-library'
const MAX_IMAGE_BYTES = 25 * 1024 * 1024
export const MAX_LIBRARY_STAMPS = 1000
export const MAX_LIBRARY_BYTES = 200 * 1024 * 1024
const STAMP_ID = /^stamp_[a-zA-Z0-9_-]{1,100}$/

export type StoredStamp = Omit<StampAsset, 'url'> & { blob: Blob; digest: string }
export type SettingsChange = { key: string; value?: unknown; time: number; client: string }
export type SettingsRecord = { key: 'settings'; data: LibrarySettings; version: number; clocks: Record<string, { time: number; client: string }> }
export type LibrarySnapshot = { stamps: StoredStamp[]; settings?: SettingsRecord }

let database: Promise<IDBDatabase> | undefined
let pending: Promise<unknown> = Promise.resolve()
let latestSettingsTime = Date.now()
const objectURLs = new Map<string, { digest: string; url: string }>()
type LibraryChange = 'stamps' | 'settings' | 'all'
const listeners = new Set<(kind: LibraryChange) => void>()
const channel = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel('hlool-pdf-library')
channel?.addEventListener('message', (event: MessageEvent<LibraryChange>) => {
  if (['stamps', 'settings', 'all'].includes(event.data)) listeners.forEach((listener) => listener(event.data))
})

export function onLibraryChange(listener: (kind: LibraryChange) => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function announce(kind: LibraryChange = 'stamps') { channel?.postMessage(kind) }

export function localStorageError(error: unknown): Error {
  if (error instanceof Error && error.message.startsWith('本机')) return error
  const name = error instanceof Error ? error.name : ''
  if (name === 'QuotaExceededError') return new Error('本机存储空间不足，保存未完成。请先导出资料备份，再释放磁盘或浏览器空间后重试。')
  if (name === 'SecurityError' || name === 'InvalidStateError' || name === 'NotAllowedError') {
    return new Error('本机存储不可用。请退出隐私浏览，允许此站点保存数据，并使用同一浏览器和地址重新打开。')
  }
  return new Error(`本机资料库操作失败，修改未确认保存。请保留当前页面并重试；不要清除浏览器数据。${error instanceof Error ? `（${error.message}）` : ''}`)
}

function openDatabase(): Promise<IDBDatabase> {
  if (database) return database
  database = new Promise<IDBDatabase>((resolve, reject) => {
    if (!globalThis.indexedDB) { reject(new Error('本机存储不可用，请使用支持 IndexedDB 的现代浏览器并退出隐私浏览。')); return }
    const request = indexedDB.open(DB_NAME, 1)
    request.onupgradeneeded = () => {
      request.result.createObjectStore('stamps', { keyPath: 'stampId' })
      request.result.createObjectStore('preferences', { keyPath: 'key' })
    }
    let abandoned = false
    request.onblocked = () => {
      abandoned = true
      reject(new Error('本机资料库正在被其他标签页占用，请关闭其他 Hlool PDF 标签页后重试。'))
    }
    request.onerror = () => reject(localStorageError(request.error))
    request.onsuccess = () => {
      const db = request.result
      if (abandoned) { db.close(); return }
      db.onversionchange = () => { db.close(); database = undefined }
      db.onclose = () => { database = undefined }
      resolve(db)
    }
  }).catch((error) => { database = undefined; throw localStorageError(error) })
  return database
}

function requestValue<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

function completed(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onabort = () => reject(transaction.error ?? new Error('事务已取消'))
    transaction.onerror = () => { /* abort supplies the final failure */ }
  })
}

/** Includes image preparation, so an export never races an already requested save. */
export function serializeLibrary<T>(operation: () => Promise<T>): Promise<T> {
  const result = pending.then(operation).catch((error) => { throw localStorageError(error) })
  pending = result.catch(() => undefined)
  return result
}

export async function waitForLibraryWrites(): Promise<void> { await pending }

export function validStampId(value: unknown): value is string { return typeof value === 'string' && STAMP_ID.test(value) }

export async function validateStampImage(blob: Blob): Promise<{ blob: Blob; widthPx: number; heightPx: number; digest: string; mime: string }> {
  if (!(blob instanceof Blob) || !blob.size || blob.size > MAX_IMAGE_BYTES) throw new Error('本机印章图片必须介于 1 字节和 25 MB 之间。')
  const bytes = new Uint8Array(await blob.arrayBuffer())
  const mime = bytes[0] === 137 && bytes[1] === 80 && bytes[2] === 78 && bytes[3] === 71 && bytes[4] === 13 && bytes[5] === 10 && bytes[6] === 26 && bytes[7] === 10
    ? 'image/png'
    : bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
      ? 'image/jpeg'
      : String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF' && String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP' ? 'image/webp' : ''
  if (!mime) throw new Error('本机印章仅接受可解码的 PNG、JPEG 或 WebP 图片，请先转换图片格式。')
  const normalized = new Blob([bytes], { type: mime })
  let widthPx: number, heightPx: number
  try {
    const bitmap = await createImageBitmap(normalized)
    widthPx = bitmap.width
    heightPx = bitmap.height
    bitmap.close()
  } catch { throw new Error('本机印章图片已损坏或浏览器无法解码，请重新选择有效图片。') }
  if (!widthPx || !heightPx || widthPx > 10000 || heightPx > 10000 || widthPx * heightPx > 40_000_000) {
    throw new Error('本机印章图片尺寸过大，请缩小到 10000 像素以内且不超过 4000 万像素。')
  }
  const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (value) => value.toString(16).padStart(2, '0')).join('')
  return { blob: normalized, widthPx, heightPx, digest, mime }
}

export function validateSettings(value: unknown): LibrarySettings {
  const fail = () => { throw new Error('本机资料设置格式无效或已损坏，请使用有效的资料备份重试。') }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail()
  const input = value as Record<string, unknown>
  if (Object.keys(input).some((key) => !['stampDefaults', 'stampMeta', 'outputNameTemplate'].includes(key))) return fail()
  const result: LibrarySettings = {}
  if (input.stampDefaults !== undefined) {
    const defaults = input.stampDefaults as Record<string, unknown>
    if (!defaults || typeof defaults !== 'object' || Object.keys(defaults).sort().join(',') !== 'opacity,rotation,sizeMm') return fail()
    const { sizeMm, opacity, rotation } = defaults
    if (typeof sizeMm !== 'number' || !Number.isFinite(sizeMm) || sizeMm < 5 || sizeMm > 120 || typeof opacity !== 'number' || !Number.isFinite(opacity) || opacity < 0.1 || opacity > 1 || typeof rotation !== 'number' || !Number.isFinite(rotation) || rotation < -180 || rotation > 180) return fail()
    result.stampDefaults = { sizeMm, opacity, rotation }
  }
  if (input.outputNameTemplate !== undefined) {
    if (typeof input.outputNameTemplate !== 'string' || input.outputNameTemplate.length > 500) return fail()
    result.outputNameTemplate = input.outputNameTemplate
  }
  if (input.stampMeta !== undefined) {
    if (!input.stampMeta || typeof input.stampMeta !== 'object' || Array.isArray(input.stampMeta) || Object.keys(input.stampMeta).length > MAX_LIBRARY_STAMPS) return fail()
    result.stampMeta = {}
    for (const [id, raw] of Object.entries(input.stampMeta)) {
      if (!validStampId(id) || !raw || typeof raw !== 'object' || Array.isArray(raw)) return fail()
      const meta = raw as Record<string, unknown>
      if (Object.keys(meta).some((key) => !['alias', 'sizeMm'].includes(key))) return fail()
      if (meta.alias !== undefined && (typeof meta.alias !== 'string' || meta.alias.length > 500)) return fail()
      if (meta.sizeMm !== undefined && (typeof meta.sizeMm !== 'number' || !Number.isFinite(meta.sizeMm) || meta.sizeMm < 5 || meta.sizeMm > 120)) return fail()
      result.stampMeta[id] = { ...(meta.alias !== undefined ? { alias: meta.alias as string } : {}), ...(meta.sizeMm !== undefined ? { sizeMm: meta.sizeMm as number } : {}) }
    }
  }
  return result
}

function validateStoredStamp(stamp: StoredStamp): void {
  if (!stamp || !validStampId(stamp.stampId) || typeof stamp.name !== 'string' || !stamp.name.trim() || stamp.name.length > 500 || !(stamp.blob instanceof Blob) || !stamp.blob.size || stamp.blob.size > MAX_IMAGE_BYTES || stamp.blob.size !== stamp.size || stamp.blob.type !== stamp.mime || !['image/png', 'image/jpeg', 'image/webp'].includes(stamp.mime ?? '') || !Number.isInteger(stamp.widthPx) || stamp.widthPx < 1 || stamp.widthPx > 10000 || !Number.isInteger(stamp.heightPx) || stamp.heightPx < 1 || stamp.heightPx > 10000 || stamp.widthPx * stamp.heightPx > 40_000_000 || !/^[a-f0-9]{64}$/.test(stamp.digest) || !Number.isFinite(Date.parse(stamp.createdAt))) {
    throw new Error('本机印章记录已损坏。请保留浏览器数据，使用有效的资料备份恢复。')
  }
}

async function verifyStoredBytes(stamp: StoredStamp): Promise<void> {
  const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', await stamp.blob.arrayBuffer())), (value) => value.toString(16).padStart(2, '0')).join('')
  if (digest !== stamp.digest) throw new Error('本机印章图片校验失败，资料可能已损坏。请保留浏览器数据并使用有效的资料备份恢复。')
}

function assetOf(stamp: StoredStamp): StampAsset {
  validateStoredStamp(stamp)
  let cached = objectURLs.get(stamp.stampId)
  if (!cached || cached.digest !== stamp.digest) {
    if (cached) retireURL(cached.url)
    cached = { digest: stamp.digest, url: URL.createObjectURL(stamp.blob) }
    objectURLs.set(stamp.stampId, cached)
  }
  const { blob: _blob, digest: _digest, ...asset } = stamp
  return { ...asset, url: cached.url }
}

// Existing previews / image decoding may still be consuming the old URL during a replacement.
function retireURL(url: string) { window.setTimeout(() => URL.revokeObjectURL(url), 60_000) }

async function snapshotNow(): Promise<LibrarySnapshot> {
  const db = await openDatabase()
  const tx = db.transaction(['stamps', 'preferences'], 'readonly')
  const done = completed(tx)
  const [stamps, settings] = await Promise.all([
    requestValue(tx.objectStore('stamps').getAll()) as Promise<StoredStamp[]>,
    requestValue(tx.objectStore('preferences').get('settings')) as Promise<SettingsRecord | undefined>,
    done
  ])
  stamps.forEach(validateStoredStamp)
  if (settings) validateSettingsRecord(settings)
  return { stamps, settings }
}

export function readLibrarySnapshot(): Promise<LibrarySnapshot> { return serializeLibrary(snapshotNow) }

export function listStamps(): Promise<StampAsset[]> {
  return serializeLibrary(async () => {
    const { stamps } = await snapshotNow()
    for (const stamp of stamps) await verifyStoredBytes(stamp)
    const keep = new Set(stamps.map((stamp) => stamp.stampId))
    for (const [id, entry] of objectURLs) if (!keep.has(id)) { retireURL(entry.url); objectURLs.delete(id) }
    return stamps.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(assetOf)
  })
}

export function saveStamp(blob: Blob, name: string, stampId = generateStampId()): Promise<StampAsset> {
  return serializeLibrary(async () => {
    if (!validStampId(stampId)) throw new Error('本机印章编号无效，请重新添加印章。')
    const validated = await validateStampImage(blob)
    const record: StoredStamp = { ...validated, stampId, name: name.trim().slice(0, 500) || '未命名印章', size: validated.blob.size, createdAt: new Date().toISOString() }
    const db = await openDatabase()
    const tx = db.transaction('stamps', 'readwrite')
    const done = completed(tx)
    const store = tx.objectStore('stamps')
    const read = store.getAll()
    let failure: unknown
    read.onsuccess = () => {
      try {
        assertLibraryCapacity([...read.result as StoredStamp[], record])
        // add, rather than put: a stale tab or repeated id must never destroy another image.
        store.add(record)
      } catch (error) { failure = error; tx.abort() }
    }
    try { await done } catch (error) { throw failure ?? error }
    announce()
    return assetOf(record)
  })
}

export function getStampBlob(id: string): Promise<Blob> {
  return readStampAssets([id]).then((assets) => assets[id].blob)
}

export function readStampAssets(ids: string[]): Promise<Record<string, { blob: Blob; widthPx: number; heightPx: number }>> {
  if (!ids.length) return Promise.resolve({})
  return serializeLibrary(async () => {
    if (ids.some((id) => !validStampId(id))) throw new Error('本机印章编号无效，请重新选择印章。')
    const db = await openDatabase()
    const tx = db.transaction('stamps', 'readonly')
    const done = completed(tx)
    const uniqueIds = [...new Set(ids)]
    const reads = uniqueIds.map((id) => requestValue(tx.objectStore('stamps').get(id)) as Promise<StoredStamp | undefined>)
    const [stamps] = await Promise.all([Promise.all(reads), done])
    const result: Record<string, { blob: Blob; widthPx: number; heightPx: number }> = {}
    for (const stamp of stamps) {
      if (!stamp) throw new Error('本机印章不存在，可能已在其他标签页删除。请重新添加印章。')
      validateStoredStamp(stamp)
      await verifyStoredBytes(stamp)
      result[stamp.stampId] = { blob: stamp.blob, widthPx: stamp.widthPx, heightPx: stamp.heightPx }
    }
    return result
  })
}

export function replaceStoredStamp(stampId: string, blob: Blob, name: string, expectedDigest?: string): Promise<StampAsset> {
  return serializeLibrary(async () => {
    const validated = await validateStampImage(blob)
    const db = await openDatabase()
    const tx = db.transaction('stamps', 'readwrite')
    const done = completed(tx)
    const store = tx.objectStore('stamps')
    const read = store.getAll()
    let record: StoredStamp | undefined
    let failure: unknown
    read.onsuccess = () => {
      try {
        const all = read.result as StoredStamp[]
        const existing = all.find((stamp) => stamp.stampId === stampId)
        if (!existing) throw new Error('本机印章不存在，可能已在其他标签页删除。请重新添加印章。')
        validateStoredStamp(existing)
        if (expectedDigest !== undefined && existing.digest !== expectedDigest) throw new Error('本机印章已在其他窗口更新，请重新打开后再替换，或另存为新印章。')
        record = { ...existing, ...validated, size: validated.blob.size, name: name.trim().slice(0, 500) || existing.name }
        assertLibraryCapacity(all.map((stamp) => stamp.stampId === stampId ? record! : stamp))
        store.put(record)
      } catch (error) { failure = error; tx.abort() }
    }
    try { await done } catch (error) { throw failure ?? error }
    announce()
    return assetOf(record!)
  })
}

export function deleteStamp(id: string): Promise<void> {
  return serializeLibrary(async () => {
    const db = await openDatabase()
    const tx = db.transaction(['stamps', 'preferences'], 'readwrite')
    const done = completed(tx)
    tx.objectStore('stamps').delete(id)
    const preferences = tx.objectStore('preferences')
    const read = preferences.get('settings')
    let failure: unknown
    read.onsuccess = () => {
      try {
        const record = read.result as SettingsRecord | undefined
        if (!record) return
        const time = nextSettingsTime(record)
        preferences.put(applyChanges(record, ['alias', 'sizeMm'].map((field) => ({ key: `stampMeta:${id}:${field}`, time, client: 'delete-stamp' }))))
      } catch (error) { failure = error; tx.abort() }
    }
    try { await done } catch (error) { throw failure ?? error }
    const old = objectURLs.get(id)
    if (old) retireURL(old.url)
    objectURLs.delete(id)
    announce('all')
  })
}

function assertLibraryCapacity(stamps: StoredStamp[]): void {
  if (stamps.length > MAX_LIBRARY_STAMPS || stamps.reduce((sum, stamp) => sum + stamp.blob.size, 0) > MAX_LIBRARY_BYTES) {
    throw new Error('本机印章库最多保存 1000 个印章、共 200 MB，以保证能完整备份。请先导出资料备份，再整理不需要的印章。')
  }
}

export function settingsFields(settings: LibrarySettings): Record<string, unknown> {
  return {
    ...Object.fromEntries(Object.entries(settings.stampDefaults ?? {}).map(([field, value]) => [`stampDefaults:${field}`, value])),
    ...(settings.outputNameTemplate !== undefined ? { outputNameTemplate: settings.outputNameTemplate } : {}),
    ...Object.fromEntries(Object.entries(settings.stampMeta ?? {}).flatMap(([id, meta]) => Object.entries(meta).map(([field, value]) => [`stampMeta:${id}:${field}`, value])))
  }
}

export function validSettingsChangeKey(key: unknown): key is string {
  return typeof key === 'string' && /^(stampDefaults(?::(?:sizeMm|opacity|rotation))?|outputNameTemplate|stampMeta:stamp_[a-zA-Z0-9_-]{1,100}(?::(?:alias|sizeMm))?)$/.test(key)
}

function granularKeys(key: string): string[] {
  if (key === 'stampDefaults') return ['sizeMm', 'opacity', 'rotation'].map((field) => `stampDefaults:${field}`)
  if (key.startsWith('stampMeta:') && key.split(':').length === 2) return ['alias', 'sizeMm'].map((field) => `${key}:${field}`)
  return [key]
}

function validateSettingsRecord(record: SettingsRecord): void {
  if (!record || record.key !== 'settings' || !Number.isSafeInteger(record.version) || record.version < 0 || !record.clocks || typeof record.clocks !== 'object' || Array.isArray(record.clocks) || Object.entries(record.clocks).some(([key, clock]) => !validSettingsChangeKey(key) || !clock || !Number.isSafeInteger(clock.time) || clock.time < 0 || typeof clock.client !== 'string' || clock.client.length > 128)) {
    throw new Error('本机设置记录已损坏。请保留浏览器数据并使用有效的资料备份恢复。')
  }
  record.data = validateSettings(record.data)
  latestSettingsTime = Object.values(record.clocks).reduce((maximum, clock) => Math.max(maximum, clock.time), latestSettingsTime)
}

export function nextSettingsTimestamp(): number {
  latestSettingsTime = Math.max(Date.now(), latestSettingsTime + 1)
  return latestSettingsTime
}

function nextSettingsTime(record?: SettingsRecord): number {
  if (record) validateSettingsRecord(record)
  return nextSettingsTimestamp()
}

function applyChanges(record: SettingsRecord | undefined, changes: SettingsChange[]): SettingsRecord {
  if (record) validateSettingsRecord(record)
  const fields = settingsFields(record?.data ?? {})
  const clocks: SettingsRecord['clocks'] = {}
  const newer = (first: { time: number; client: string }, second: { time: number; client: string }) => first.time > second.time || (first.time === second.time && first.client >= second.client)
  // Upgrade the original aggregate clocks and crash journals without losing their ordering.
  for (const [group, clock] of Object.entries(record?.clocks ?? {})) {
    for (const key of granularKeys(group)) if (!clocks[key] || newer(clock, clocks[key])) clocks[key] = clock
  }
  for (const change of changes) {
    if (!validSettingsChangeKey(change.key) || !Number.isSafeInteger(change.time) || change.time < 0 || typeof change.client !== 'string' || change.client.length > 128) throw new Error('本机设置变更格式无效，请保留页面并重新加载。')
    latestSettingsTime = Math.max(latestSettingsTime, change.time)
    const keys = granularKeys(change.key)
    if (keys.length > 1 && change.value !== undefined) {
      if (change.key === 'stampDefaults') validateSettings({ stampDefaults: change.value })
      else validateSettings({ stampMeta: { [change.key.slice(10)]: change.value } })
    }
    for (const key of keys) {
      const old = clocks[key]
      if (old && newer(old, change)) continue
      const value = keys.length === 1 ? change.value : (change.value as Record<string, unknown> | undefined)?.[key.slice(key.lastIndexOf(':') + 1)]
      if (value === undefined) delete fields[key]
      else fields[key] = value
      clocks[key] = { time: change.time, client: change.client }
    }
  }
  const defaults = Object.fromEntries(Object.entries(fields).filter(([key]) => key.startsWith('stampDefaults:')).map(([key, value]) => [key.slice(14), value]))
  const metadata: Record<string, Record<string, unknown>> = {}
  for (const [key, value] of Object.entries(fields)) {
    if (!key.startsWith('stampMeta:')) continue
    const [, id, field] = key.split(':')
    ;(metadata[id] ??= {})[field] = value
  }
  const data = validateSettings({
    ...(Object.keys(defaults).length ? { stampDefaults: defaults } : {}),
    ...(fields.outputNameTemplate !== undefined ? { outputNameTemplate: fields.outputNameTemplate } : {}),
    stampMeta: metadata
  })
  return { key: 'settings', data, clocks, version: (record?.version ?? 0) + 1 }
}

export function saveSettingsChanges(changes: SettingsChange[], initializeMissing = false): Promise<SettingsRecord> {
  return serializeLibrary(async () => {
    const db = await openDatabase()
    const tx = db.transaction(['preferences', 'stamps'], 'readwrite')
    const done = completed(tx)
    let result: SettingsRecord
    let failure: unknown
    let written = false
    const stampIds = tx.objectStore('stamps').getAllKeys()
    const read = tx.objectStore('preferences').get('settings')
    read.onsuccess = () => {
      try {
        const current = read.result as SettingsRecord | undefined
        if (current) validateSettingsRecord(current)
        const fields = settingsFields(current?.data ?? {})
        const initialized = new Set([...Object.keys(fields), ...Object.keys(current?.clocks ?? {}).flatMap(granularKeys)])
        const validIds = new Set(stampIds.result)
        const selected = (initializeMissing ? changes.filter((change) => granularKeys(change.key).every((key) => !initialized.has(key))) : changes)
          .filter((change) => !change.key.startsWith('stampMeta:') || change.value === undefined || validIds.has(change.key.split(':')[1]))
        // Clear only metadata proven orphaned in this same transaction; a concurrent add cannot race this check.
        for (const id of Object.keys(current?.data.stampMeta ?? {})) {
          if (!validIds.has(id)) selected.push({ key: `stampMeta:${id}`, time: nextSettingsTime(current), client: 'remove-orphan' })
        }
        if (current && !selected.length) { result = current; return }
        result = applyChanges(current, selected)
        tx.objectStore('preferences').put(result)
        written = true
      }
      catch (error) { failure = error; tx.abort() }
    }
    try { await done } catch (error) { throw failure ?? error }
    if (written) announce('settings')
    return result!
  })
}

/** Both stores are committed in one transaction. All decoding and ZIP validation happen before this call. */
export function mergeLibraryBackup(incoming: StoredStamp[], importedSettings: LibrarySettings): Promise<{ imported: number }> {
  return serializeLibrary(async () => {
    const db = await openDatabase()
    const tx = db.transaction(['stamps', 'preferences'], 'readwrite')
    const done = completed(tx)
    const stampsStore = tx.objectStore('stamps')
    const settingsStore = tx.objectStore('preferences')
    const readStamps = stampsStore.getAll()
    const readSettings = settingsStore.get('settings')
    let imported = 0
    let failure: unknown
    readSettings.onsuccess = () => {
      try {
        const existing = new Map((readStamps.result as StoredStamp[]).map((stamp) => [stamp.stampId, stamp]))
        const metadata = { ...(readSettings.result as SettingsRecord | undefined)?.data.stampMeta }
        for (const stamp of incoming) {
          const old = existing.get(stamp.stampId)
          let id = stamp.stampId
          if (old && old.digest !== stamp.digest) {
            const alreadyRestored = [...existing.values()].find((item) => item.digest === stamp.digest && item.name === stamp.name && item.createdAt === stamp.createdAt)
            if (alreadyRestored) id = alreadyRestored.stampId
            else do { id = generateStampId() } while (existing.has(id))
          }
          if (!existing.has(id)) {
            const copy = { ...stamp, stampId: id }
            stampsStore.add(copy)
            existing.set(id, copy)
            imported++
          }
          if (importedSettings.stampMeta?.[stamp.stampId]) metadata[id] = { ...importedSettings.stampMeta[stamp.stampId], ...metadata[id] }
        }
        assertLibraryCapacity([...existing.values()])
        const current = readSettings.result as SettingsRecord | undefined
        const data = { ...(current?.data ?? {}), ...importedSettings, stampMeta: metadata }
        const time = nextSettingsTime(current)
        const before = settingsFields(current?.data ?? {})
        const changes = Object.entries(settingsFields(data))
          .filter(([key, value]) => JSON.stringify(before[key]) !== JSON.stringify(value))
          .map(([key, value]) => ({ key, value, time, client: 'backup' }))
        settingsStore.put(applyChanges(current, changes))
      } catch (error) { failure = error; tx.abort() }
    }
    try { await done } catch (error) { throw failure ?? error }
    announce('all')
    return { imported }
  })
}
