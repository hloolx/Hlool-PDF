import { expect, test, type Page } from '@playwright/test'
import JSZip from 'jszip'

async function openLibrary(page: Page) {
  await page.goto('/')
  await page.evaluate(async () => {
    await (await import('/src/features/workspace/boot.ts')).bootWorkspace()
    ;(window as any).makeStamp = async (color = '#e00000') => {
      const canvas = document.createElement('canvas')
      canvas.width = 40
      canvas.height = 24
      const context = canvas.getContext('2d')!
      context.fillStyle = color
      context.fillRect(1, 1, 38, 22)
      return new Promise<Blob>((resolve) => canvas.toBlob((blob) => resolve(blob!), 'image/png'))
    }
  })
}

async function backupBytes(page: Page): Promise<number[]> {
  return page.evaluate(async () => Array.from(new Uint8Array(await (await (await import('/src/features/library/backup.ts')).exportLibraryBackup()).arrayBuffer())))
}

test('stamp bytes survive reload and deletion is durable', async ({ page }) => {
  await openLibrary(page)
  const saved = await page.evaluate(async () => {
    const storage = await import('/src/features/library/storage.ts')
    const stamp = await storage.saveStamp(await (window as any).makeStamp(), '公司公章.png')
    return { ...stamp, digest: (await storage.readLibrarySnapshot()).stamps[0].digest }
  })
  expect(saved.url).toMatch(/^blob:/)
  expect(saved.widthPx).toBe(40)
  expect(saved.heightPx).toBe(24)
  await page.reload()
  const persisted = await page.evaluate(async () => {
    const storage = await import('/src/features/library/storage.ts')
    const stamps = await storage.listStamps()
    return { stamps, digest: (await storage.readLibrarySnapshot()).stamps[0].digest, size: (await storage.getStampBlob(stamps[0].stampId)).size }
  })
  expect(persisted.stamps).toHaveLength(1)
  expect(persisted.stamps[0].stampId).toBe(saved.stampId)
  expect(persisted.digest).toBe(saved.digest)
  expect(persisted.size).toBe(saved.size)
  await page.evaluate(async (id) => (await import('/src/features/library/storage.ts')).deleteStamp(id), saved.stampId)
  await page.reload()
  expect(await page.evaluate(async () => (await import('/src/features/library/storage.ts')).listStamps())).toHaveLength(0)
})

test('invalid images and duplicate ids cannot overwrite; replacement retains identity', async ({ page }) => {
  await openLibrary(page)
  const result = await page.evaluate(async () => {
    const storage = await import('/src/features/library/storage.ts')
    const blob = await (window as any).makeStamp()
    const first = await storage.saveStamp(blob, '原件', 'stamp_test')
    const originalDigest = (await storage.readLibrarySnapshot()).stamps[0].digest
    let invalidRejected = false, duplicateRejected = false
    try { await storage.replaceStoredStamp(first.stampId, new Blob(['broken'], { type: 'image/png' }), '损坏') } catch { invalidRejected = true }
    try { await storage.saveStamp(await (window as any).makeStamp('#00f'), '重复', first.stampId) } catch { duplicateRejected = true }
    const preservedDigest = (await storage.readLibrarySnapshot()).stamps[0].digest
    const replacement = await storage.replaceStoredStamp(first.stampId, await (window as any).makeStamp('#00f'), '新图')
    let staleError = ''
    try { await storage.replaceStoredStamp(first.stampId, blob, '过期处理结果', originalDigest) } catch (error) { staleError = (error as Error).message }
    const finalDigest = (await storage.readLibrarySnapshot()).stamps[0].digest
    return { first, replacement, invalidRejected, duplicateRejected, staleError, originalDigest, preservedDigest, finalDigest, oldURLReadable: (await fetch(first.url)).ok }
  })
  expect(result.invalidRejected).toBe(true)
  expect(result.duplicateRejected).toBe(true)
  expect(result.preservedDigest).toBe(result.originalDigest)
  expect(result.finalDigest).not.toBe(result.originalDigest)
  expect(result.staleError).toContain('印章已在其他窗口更新')
  expect(result.replacement.stampId).toBe(result.first.stampId)
  expect(result.replacement.createdAt).toBe(result.first.createdAt)
  expect(result.replacement.url).not.toBe(result.first.url)
  expect(result.oldURLReadable).toBe(true)
})

test('backup waits for pending save and restores settings without PDF or password data', async ({ page }) => {
  await openLibrary(page)
  const bytes = await page.evaluate(async () => {
    const storage = await import('/src/features/library/storage.ts')
    const { useEditorStore } = await import('/src/state/store.ts')
    const backup = await import('/src/features/library/backup.ts')
    const blob = await (window as any).makeStamp()
    const saving = storage.saveStamp(blob, '备份公章', 'stamp_backup')
    useEditorStore.getState().setStampMeta('stamp_backup', { alias: '采购公章', sizeMm: 36 })
    useEditorStore.getState().setOutputNameTemplate('{原名}-本地')
    useEditorStore.getState().setOutputPassword('NEVER-EXPORT-THIS-SECRET')
    const exported = await backup.exportLibraryBackup()
    await saving
    await storage.deleteStamp('stamp_backup')
    useEditorStore.getState().removeStamp('stamp_backup')
    await (await import('/src/features/library/settings.ts')).flushSettings()
    return Array.from(new Uint8Array(await exported.arrayBuffer()))
  })
  const zip = await JSZip.loadAsync(Uint8Array.from(bytes))
  const manifestText = await zip.file('manifest.json')!.async('string')
  expect(manifestText).not.toContain('NEVER-EXPORT')
  expect(Object.keys(zip.files).sort()).toEqual(['images/stamp_backup.png', 'manifest.json'])
  const result = await page.evaluate(async (data) => {
    const { importLibraryBackup } = await import('/src/features/library/backup.ts')
    const { useEditorStore } = await import('/src/state/store.ts')
    const imported = await importLibraryBackup(new Blob([Uint8Array.from(data)]))
    const state = useEditorStore.getState()
    return { imported, stamps: state.stamps, meta: state.stampMeta, template: state.outputNameTemplate }
  }, bytes)
  expect(result.imported.imported).toBe(1)
  expect(result.stamps).toHaveLength(1)
  expect(result.meta.stamp_backup).toEqual({ alias: '采购公章', sizeMm: 36 })
  expect(result.template).toBe('{原名}-本地')
})

test('a damaged backup is rejected without writing any image or settings', async ({ page }) => {
  await openLibrary(page)
  await page.evaluate(async () => {
    const storage = await import('/src/features/library/storage.ts')
    await storage.saveStamp(await (window as any).makeStamp(), '一', 'stamp_one')
    await storage.saveStamp(await (window as any).makeStamp('#00f'), '二', 'stamp_two')
  })
  const zip = await JSZip.loadAsync(Uint8Array.from(await backupBytes(page)))
  const manifest = JSON.parse(await zip.file('manifest.json')!.async('string'))
  manifest.settings.outputNameTemplate = '不应写入'
  zip.file('manifest.json', JSON.stringify(manifest))
  zip.file(manifest.stamps[1].file, 'corrupted image')
  const corrupted = Array.from(await zip.generateAsync({ type: 'uint8array' }))
  const result = await page.evaluate(async (data) => {
    const storage = await import('/src/features/library/storage.ts')
    await storage.deleteStamp('stamp_one')
    await storage.deleteStamp('stamp_two')
    const before = await storage.readLibrarySnapshot()
    let error = ''
    try { await (await import('/src/features/library/backup.ts')).importLibraryBackup(new Blob([Uint8Array.from(data)])) } catch (caught) { error = (caught as Error).message }
    const after = await storage.readLibrarySnapshot()
    return { error, count: after.stamps.length, before: before.settings?.data, after: after.settings?.data }
  }, corrupted)
  expect(result.error).toContain('未写入任何资料')
  expect(result.count).toBe(0)
  expect(result.after).toEqual(result.before)
})

test('same id with different image is remapped and keeps both metadata records', async ({ page }) => {
  await openLibrary(page)
  await page.evaluate(async () => {
    await (await import('/src/features/library/storage.ts')).saveStamp(await (window as any).makeStamp(), '红章', 'stamp_collision')
    ;(await import('/src/state/store.ts')).useEditorStore.getState().setStampMeta('stamp_collision', { alias: '红色别名', sizeMm: 32 })
  })
  const bytes = await backupBytes(page)
  const result = await page.evaluate(async (data) => {
    const storage = await import('/src/features/library/storage.ts')
    const { useEditorStore } = await import('/src/state/store.ts')
    await storage.deleteStamp('stamp_collision')
    await storage.saveStamp(await (window as any).makeStamp('#00f'), '蓝章', 'stamp_collision')
    useEditorStore.getState().setStampMeta('stamp_collision', { alias: '蓝色别名', sizeMm: 45 })
    const before = (await storage.readLibrarySnapshot()).stamps[0].digest
    const imported = await (await import('/src/features/library/backup.ts')).importLibraryBackup(new Blob([Uint8Array.from(data)]))
    const repeated = await (await import('/src/features/library/backup.ts')).importLibraryBackup(new Blob([Uint8Array.from(data)]))
    const snapshot = await storage.readLibrarySnapshot()
    return { imported, repeated, before, stamps: snapshot.stamps.map(({ blob: _blob, ...stamp }) => stamp), metadata: snapshot.settings?.data.stampMeta }
  }, bytes)
  expect(result.imported.imported).toBe(1)
  expect(result.repeated.imported).toBe(0)
  expect(result.stamps).toHaveLength(2)
  const original = result.stamps.find((stamp) => stamp.stampId === 'stamp_collision')!
  const remapped = result.stamps.find((stamp) => stamp.stampId !== 'stamp_collision')!
  expect(original.digest).toBe(result.before)
  expect(result.metadata?.stamp_collision).toEqual({ alias: '蓝色别名', sizeMm: 45 })
  expect(result.metadata?.[remapped.stampId]).toEqual({ alias: '红色别名', sizeMm: 32 })
})

test('two tabs merge different settings and share durable stamps', async ({ page, context }) => {
  await openLibrary(page)
  await page.evaluate(async () => (await import('/src/features/library/settings.ts')).flushSettings())
  const other = await context.newPage()
  await openLibrary(other)
  await Promise.all([
    page.evaluate(async () => {
      const { useEditorStore } = await import('/src/state/store.ts')
      useEditorStore.getState().setOutputNameTemplate('{原名}-多标签')
      await (await import('/src/features/library/settings.ts')).flushSettings()
    }),
    other.evaluate(async () => {
      const { useEditorStore } = await import('/src/state/store.ts')
      useEditorStore.getState().setStampDefaults({ sizeMm: 35 })
      await (await import('/src/features/library/settings.ts')).flushSettings()
      await (await import('/src/features/library/storage.ts')).saveStamp(await (window as any).makeStamp(), '共享章', 'stamp_shared')
    })
  ])
  await expect.poll(() => page.evaluate(async () => {
    const { useEditorStore } = await import('/src/state/store.ts')
    const state = useEditorStore.getState()
    return { template: state.outputNameTemplate, size: state.stampDefaults.sizeMm, ids: state.stamps.map((stamp) => stamp.stampId) }
  })).toEqual({ template: '{原名}-多标签', size: 35, ids: ['stamp_shared'] })
})

test('pending settings journal is recovered on reopening', async ({ page }) => {
  await openLibrary(page)
  await page.evaluate(async () => {
    await (await import('/src/features/library/settings.ts')).flushSettings()
    localStorage.setItem('hlool-pdf:pending-settings:closed-tab', JSON.stringify([{ key: 'outputNameTemplate', value: '{原名}-恢复', time: Date.now() + 1000, client: 'closed-tab' }]))
  })
  await page.reload()
  await expect.poll(() => page.evaluate(async () => (await import('/src/state/store.ts')).useEditorStore.getState().outputNameTemplate)).toBe('{原名}-恢复')
  expect(await page.evaluate(() => localStorage.getItem('hlool-pdf:pending-settings:closed-tab'))).toBeNull()
})

test('quota failure during import rolls back images and settings together', async ({ page }) => {
  await openLibrary(page)
  await page.evaluate(async () => {
    await (await import('/src/features/library/storage.ts')).saveStamp(await (window as any).makeStamp(), '事务测试', 'stamp_atomic')
  })
  const bytes = await backupBytes(page)
  const result = await page.evaluate(async (data) => {
    const storage = await import('/src/features/library/storage.ts')
    await storage.deleteStamp('stamp_atomic')
    await (await import('/src/features/library/settings.ts')).flushSettings()
    const before = await storage.readLibrarySnapshot()
    const put = IDBObjectStore.prototype.put
    IDBObjectStore.prototype.put = function (...args: Parameters<typeof put>) {
      if (this.name === 'preferences') throw new DOMException('Simulated disk full', 'QuotaExceededError')
      return put.apply(this, args)
    }
    let error = ''
    try { await (await import('/src/features/library/backup.ts')).importLibraryBackup(new Blob([Uint8Array.from(data)])) }
    catch (caught) { error = (caught as Error).message }
    finally { IDBObjectStore.prototype.put = put }
    const after = await storage.readLibrarySnapshot()
    return { error, count: after.stamps.length, before: before.settings?.data, after: after.settings?.data }
  }, bytes)
  expect(result.error).toContain('存储空间不足')
  expect(result.count).toBe(0)
  expect(result.after).toEqual(result.before)
})

test('stored image corruption is reported instead of loading a broken stamp', async ({ page }) => {
  await openLibrary(page)
  const error = await page.evaluate(async () => {
    const storage = await import('/src/features/library/storage.ts')
    await storage.saveStamp(await (window as any).makeStamp(), '完整性', 'stamp_integrity')
    const [record] = (await storage.readLibrarySnapshot()).stamps
    const bytes = new Uint8Array(await record.blob.arrayBuffer())
    bytes[bytes.length - 1] ^= 1
    record.blob = new Blob([bytes], { type: record.mime })
    await new Promise<void>((resolve, reject) => {
      const open = indexedDB.open('hlool-pdf-library', 1)
      open.onsuccess = () => {
        const db = open.result
        const tx = db.transaction('stamps', 'readwrite')
        tx.objectStore('stamps').put(record)
        tx.oncomplete = () => { db.close(); resolve() }
        tx.onabort = () => { db.close(); reject(tx.error) }
      }
      open.onerror = () => reject(open.error)
    })
    try { await storage.listStamps(); return '' } catch (caught) { return (caught as Error).message }
  })
  expect(error).toContain('图片校验失败')
})

test('stale tabs merge separate properties of defaults and the same stamp metadata', async ({ page, context }) => {
  // Hold external notifications so both editors definitely start from the same, stale snapshot.
  await context.addInitScript(() => {
    const original = BroadcastChannel.prototype.addEventListener
    BroadcastChannel.prototype.addEventListener = function (type: string, ...args: any[]) {
      if (type !== 'message') return (original as any).call(this, type, ...args)
    }
  })
  await openLibrary(page)
  await page.evaluate(async () => {
    await (await import('/src/features/library/storage.ts')).saveStamp(await (window as any).makeStamp(), '共同印章', 'stamp_fields')
    const { useEditorStore } = await import('/src/state/store.ts')
    useEditorStore.getState().setStampMeta('stamp_fields', { alias: '原别名', sizeMm: 42 })
    await (await import('/src/features/library/settings.ts')).flushSettings()
  })
  const other = await context.newPage()
  await openLibrary(other)
  await page.evaluate(async () => {
    const { useEditorStore } = await import('/src/state/store.ts')
    useEditorStore.getState().setStampDefaults({ sizeMm: 35 })
    useEditorStore.getState().setStampMeta('stamp_fields', { alias: '新的别名' })
    await (await import('/src/features/library/settings.ts')).flushSettings()
  })
  await other.evaluate(async () => {
    const { useEditorStore } = await import('/src/state/store.ts')
    useEditorStore.getState().setStampDefaults({ opacity: 0.45 })
    useEditorStore.getState().setStampMeta('stamp_fields', { sizeMm: 51 })
    await (await import('/src/features/library/settings.ts')).flushSettings()
  })
  const saved = await page.evaluate(async () => (await (await import('/src/features/library/storage.ts')).readLibrarySnapshot()).settings!.data)
  expect(saved.stampDefaults).toEqual({ sizeMm: 35, opacity: 0.45, rotation: 0 })
  expect(saved.stampMeta?.stamp_fields).toEqual({ alias: '新的别名', sizeMm: 51 })
})

test('deletion removes metadata atomically and stale local preferences cannot resurrect it', async ({ page }) => {
  await openLibrary(page)
  const saved = await page.evaluate(async () => {
    const storage = await import('/src/features/library/storage.ts')
    const { useEditorStore } = await import('/src/state/store.ts')
    await storage.saveStamp(await (window as any).makeStamp(), '删除测试', 'stamp_deleted')
    useEditorStore.getState().setStampMeta('stamp_deleted', { alias: '旧别名', sizeMm: 35 })
    await (await import('/src/features/library/settings.ts')).flushSettings()
    await storage.deleteStamp('stamp_deleted')
    // Simulate a close before the caller has a chance to update its in-memory state / preference mirror.
    const snapshot = await storage.readLibrarySnapshot()
    const prefs = JSON.parse(localStorage.getItem('hlool-pdf:prefs-v3') || '{}')
    prefs.stampMeta = { stamp_deleted: { alias: '旧别名', sizeMm: 35 } }
    localStorage.setItem('hlool-pdf:prefs-v3', JSON.stringify(prefs))
    return { count: snapshot.stamps.length, metadata: snapshot.settings!.data.stampMeta }
  })
  expect(saved).toEqual({ count: 0, metadata: {} })
  await page.reload()
  await expect.poll(() => page.evaluate(async () => (await import('/src/state/store.ts')).useEditorStore.getState().stampMeta)).toEqual({})
  expect(await page.evaluate(async () => (await (await import('/src/features/library/storage.ts')).readLibrarySnapshot()).settings!.data.stampMeta)).toEqual({})
})

test('legacy aggregate crash journals retain their ordering while migrating to per-property clocks', async ({ page }) => {
  await openLibrary(page)
  await page.evaluate(async () => {
    await (await import('/src/features/library/storage.ts')).saveStamp(await (window as any).makeStamp(), '旧版日志', 'stamp_legacy')
    const time = Date.now() + 1000
    localStorage.setItem('hlool-pdf:pending-settings:legacy-tab', JSON.stringify([
      { key: 'stampDefaults', value: { sizeMm: 33, opacity: 0.6, rotation: 10 }, time, client: 'legacy-tab' },
      { key: 'stampMeta:stamp_legacy', value: { alias: '旧版恢复', sizeMm: 39 }, time, client: 'legacy-tab' }
    ]))
  })
  await page.reload()
  await expect.poll(() => page.evaluate(async () => (await import('/src/state/store.ts')).useEditorStore.getState().stampDefaults)).toEqual({ sizeMm: 33, opacity: 0.6, rotation: 10 })
  const result = await page.evaluate(async () => {
    const { useEditorStore } = await import('/src/state/store.ts')
    useEditorStore.getState().setStampMeta('stamp_legacy', { sizeMm: 41 })
    await (await import('/src/features/library/settings.ts')).flushSettings()
    return (await (await import('/src/features/library/storage.ts')).readLibrarySnapshot()).settings!
  })
  expect(result.data.stampMeta?.stamp_legacy).toEqual({ alias: '旧版恢复', sizeMm: 41 })
  expect(result.clocks['stampMeta:stamp_legacy:sizeMm']).toBeDefined()
  expect(result.clocks.stampDefaults).toBeUndefined()
})

test('saving beyond the backup capacity rejects without altering the existing library', async ({ page }) => {
  await openLibrary(page)
  const result = await page.evaluate(async () => {
    const storage = await import('/src/features/library/storage.ts')
    await storage.saveStamp(await (window as any).makeStamp(), '容量测试', 'stamp_capacity_0')
    const [record] = (await storage.readLibrarySnapshot()).stamps
    await new Promise<void>((resolve, reject) => {
      const open = indexedDB.open('hlool-pdf-library', 1)
      open.onsuccess = () => {
        const db = open.result
        const tx = db.transaction('stamps', 'readwrite')
        for (let i = 1; i < 1000; i++) tx.objectStore('stamps').add({ ...record, stampId: `stamp_capacity_${i}` })
        tx.oncomplete = () => { db.close(); resolve() }
        tx.onabort = () => { db.close(); reject(tx.error) }
      }
      open.onerror = () => reject(open.error)
    })
    let error = ''
    try { await storage.saveStamp(await (window as any).makeStamp('#00f'), '超出上限', 'stamp_overflow') } catch (caught) { error = (caught as Error).message }
    const count = (await storage.readLibrarySnapshot()).stamps.length
    return { error, count }
  })
  expect(result.error).toContain('1000 个印章')
  expect(result.count).toBe(1000)
})

test('long Chinese names and aliases produce a backup that can be imported again', async ({ page }) => {
  test.setTimeout(120_000)
  await openLibrary(page)
  const result = await page.evaluate(async () => {
    const storage = await import('/src/features/library/storage.ts')
    const { exportLibraryBackup, importLibraryBackup } = await import('/src/features/library/backup.ts')
    await storage.saveStamp(await (window as any).makeStamp(), '章'.repeat(500), 'stamp_names_0')
    const [record] = (await storage.readLibrarySnapshot()).stamps
    await new Promise<void>((resolve, reject) => {
      const open = indexedDB.open('hlool-pdf-library', 1)
      open.onsuccess = () => {
        const db = open.result
        const tx = db.transaction('stamps', 'readwrite')
        for (let i = 1; i < 700; i++) tx.objectStore('stamps').add({ ...record, stampId: `stamp_names_${i}` })
        tx.oncomplete = () => { db.close(); resolve() }
        tx.onabort = () => { db.close(); reject(tx.error) }
      }
      open.onerror = () => reject(open.error)
    })
    await storage.saveSettingsChanges(Array.from({ length: 700 }, (_, i) => ({ key: `stampMeta:stamp_names_${i}:alias`, value: '名'.repeat(500), time: Date.now() + 1000, client: 'names-test' })))
    const backup = await exportLibraryBackup()
    const imported = await importLibraryBackup(backup)
    const snapshot = await storage.readLibrarySnapshot()
    return { bytes: backup.size, count: snapshot.stamps.length, imported: imported.imported, alias: snapshot.settings!.data.stampMeta!.stamp_names_699.alias }
  })
  expect(result.bytes).toBeGreaterThan(2 * 1024 * 1024)
  expect(result.count).toBe(700)
  expect(result.imported).toBe(0)
  expect(result.alias).toBe('名'.repeat(500))
})

test('stamp processing snapshot pairs each image with its persisted dimensions', async ({ page }) => {
  await openLibrary(page)
  const result = await page.evaluate(async () => {
    const storage = await import('/src/features/library/storage.ts')
    await storage.saveStamp(await (window as any).makeStamp(), '一', 'stamp_snapshot_one')
    const canvas = document.createElement('canvas')
    canvas.width = 18
    canvas.height = 32
    const other = await new Promise<Blob>((resolve) => canvas.toBlob((blob) => resolve(blob!), 'image/png'))
    await storage.saveStamp(other, '二', 'stamp_snapshot_two')
    const snapshot = await storage.readStampAssets(['stamp_snapshot_one', 'stamp_snapshot_two', 'stamp_snapshot_one'])
    const pairs = await Promise.all(Object.entries(snapshot).map(async ([id, value]) => {
      const bitmap = await createImageBitmap(value.blob)
      const pair = { id, width: value.widthPx, height: value.heightPx, decodedWidth: bitmap.width, decodedHeight: bitmap.height }
      bitmap.close()
      return pair
    }))
    let missingError = ''
    try { await storage.readStampAssets(['stamp_snapshot_one', 'stamp_missing']) } catch (error) { missingError = (error as Error).message }
    return { pairs, missingError }
  })
  expect(result.pairs).toEqual([
    { id: 'stamp_snapshot_one', width: 40, height: 24, decodedWidth: 40, decodedHeight: 24 },
    { id: 'stamp_snapshot_two', width: 18, height: 32, decodedWidth: 18, decodedHeight: 32 }
  ])
  expect(result.missingError).toContain('印章不存在')
})

test('forged ZIP size cannot bypass the streaming decompression limit', async ({ page }) => {
  await openLibrary(page)
  const zip = new JSZip()
  zip.file('manifest.json', 'x'.repeat(9 * 1024 * 1024))
  const data = await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' })
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  for (let offset = 0; offset + 46 <= data.length; offset++) {
    if (view.getUint32(offset, true) === 0x02014b50) view.setUint32(offset + 24, 1, true)
    if (view.getUint32(offset, true) === 0x04034b50) view.setUint32(offset + 22, 1, true)
  }
  const result = await page.evaluate(async (bytes) => {
    let error = ''
    try { await (await import('/src/features/library/backup.ts')).importLibraryBackup(new Blob([Uint8Array.from(bytes)])) }
    catch (caught) { error = (caught as Error).message }
    return { error, count: (await (await import('/src/features/library/storage.ts')).listStamps()).length }
  }, Array.from(data))
  expect(result.error).toContain('超过限制')
  expect(result.count).toBe(0)
})
