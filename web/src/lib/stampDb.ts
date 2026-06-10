/**
 * 最小 IndexedDB 封装：印章图片的浏览器端持久层。
 * 所有错误都被吞掉并转为 null/false——隐私模式等不可用环境下退化为
 * “会话级”，降级提示由上层（features/stamps/persistence.ts）负责。
 */

export type StoredStamp = {
  id: string
  name: string
  mime: string
  blob: Blob
  widthPx: number
  heightPx: number
  createdAt: number
}

const DB_NAME = 'hlool-pdf'
const STORE = 'stamps'

let dbPromise: Promise<IDBDatabase | null> | null = null

function openDb(): Promise<IDBDatabase | null> {
  dbPromise ??= new Promise((resolve) => {
    try {
      if (typeof indexedDB === 'undefined') {
        resolve(null)
        return
      }
      const req = indexedDB.open(DB_NAME, 1)
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(STORE)) {
          req.result.createObjectStore(STORE, { keyPath: 'id' })
        }
      }
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => resolve(null)
      req.onblocked = () => resolve(null)
    } catch {
      resolve(null)
    }
  })
  return dbPromise
}

function inTransaction<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>) {
  return openDb().then((db) => {
    if (!db) return null
    return new Promise<T | null>((resolve) => {
      try {
        const tx = db.transaction(STORE, mode)
        const req = run(tx.objectStore(STORE))
        tx.oncomplete = () => resolve(req.result)
        tx.onerror = () => resolve(null)
        tx.onabort = () => resolve(null)
      } catch {
        resolve(null)
      }
    })
  })
}

/** 返回 null 表示 IndexedDB 不可用（与“空列表”区分开）。 */
export async function idbGetAllStamps(): Promise<StoredStamp[] | null> {
  const result = await inTransaction('readonly', (store) => store.getAll() as IDBRequest<StoredStamp[]>)
  return result
}

export async function idbPutStamp(record: StoredStamp): Promise<boolean> {
  const result = await inTransaction('readwrite', (store) => store.put(record))
  return result !== null
}

export async function idbDeleteStamp(id: string): Promise<void> {
  await inTransaction('readwrite', (store) => store.delete(id))
}
