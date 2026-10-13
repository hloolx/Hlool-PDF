import type { LibrarySettings } from '../../lib/types'
import { librarySettings, useEditorStore } from '../../state/store'
import { toast } from '../../state/toasts'
import { localStorageError, nextSettingsTimestamp, onLibraryChange, readLibrarySnapshot, saveSettingsChanges, settingsFields, validSettingsChangeKey, type SettingsChange, type SettingsRecord } from './storage'

const JOURNAL_PREFIX = 'hlool-pdf:pending-settings:'
const client = crypto.randomUUID()
const journalKey = JOURNAL_PREFIX + client
let observed: LibrarySettings = {}
let pending: SettingsChange[] = []
let flushing: Promise<void> | undefined
let lastTime = Date.now()
let suppress = false
let stopStore: (() => void) | undefined
let stopExternal: (() => void) | undefined
let lastError = ''
let journalUnavailable = false

function report(error: unknown) {
  const message = localStorageError(error).message
  if (message !== lastError) toast(message, { kind: 'error', ttlMs: 15000 })
  lastError = message
}

function writeJournal(): void {
  try {
    if (pending.length) window.localStorage.setItem(journalKey, JSON.stringify([...new Map(pending.map((change) => [change.key, change])).values()]))
    else window.localStorage.removeItem(journalKey)
    journalUnavailable = false
  } catch (error) {
    journalUnavailable = true
    if (pending.length) report(error)
  }
}

function hydrate(record?: SettingsRecord) {
  // A slower read must not roll back a newer save or an edit still waiting for its transaction.
  if (pending.length || (record && record.version < useEditorStore.getState().settingsVersion)) return
  suppress = true
  try {
    if (record) {
      lastTime = Object.values(record.clocks ?? {}).reduce((maximum, clock) => Math.max(maximum, clock.time), lastTime)
      useEditorStore.getState().hydrateSettings(record.data, record.version)
    }
    observed = structuredClone(librarySettings(useEditorStore.getState()))
  } finally { suppress = false }
}

/** Synchronous journals bridge the interval between a preference edit and IDB commit, including window close. */
async function recoverJournals(): Promise<void> {
  const entries: Array<[string, string]> = []
  try {
    for (let index = 0; index < window.localStorage.length; index++) {
      const key = window.localStorage.key(index)
      if (!key?.startsWith(JOURNAL_PREFIX)) continue
      const raw = window.localStorage.getItem(key)
      if (raw) entries.push([key, raw])
    }
  } catch { return /* IDB remains usable; edits still report journal failures. */ }
  for (const [key, raw] of entries) {
    let changes: SettingsChange[]
    try {
      changes = JSON.parse(raw) as SettingsChange[]
      if (!Array.isArray(changes) || changes.length > 10000 || changes.some((change) => !change || !validSettingsChangeKey(change.key) || !Number.isSafeInteger(change.time) || change.time < 0 || typeof change.client !== 'string' || change.client.length > 128)) throw new Error('invalid')
    } catch { throw new Error('本机设置恢复日志已损坏，请保留浏览器数据并先导出印章资料，勿直接清除站点数据。') }
    await saveSettingsChanges(changes)
    // Another tab may have appended changes while this transaction was running.
    try { if (window.localStorage.getItem(key) === raw) window.localStorage.removeItem(key) } catch { /* Already committed in IDB. */ }
  }
}

export async function loadSettings(): Promise<void> {
  await flushSettings()
  await recoverJournals()
  // Initialize only absent fields inside the transaction; another tab's values and deletion clocks win.
  const time = Math.max(nextSettingsTimestamp(), lastTime + 1)
  await saveSettingsChanges(Object.entries(settingsFields(librarySettings(useEditorStore.getState()))).map(([key, value]) => ({ key, value, time, client })), true)
  let settings: SettingsRecord | undefined
  do {
    await flushSettings()
    ;({ settings } = await readLibrarySnapshot())
  } while (pending.length)
  hydrate(settings)
}

function captureChanges() {
  if (suppress) return
  const current = structuredClone(librarySettings(useEditorStore.getState()))
  const before = settingsFields(observed)
  const after = settingsFields(current)
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter((key) => JSON.stringify(before[key]) !== JSON.stringify(after[key]))
  if (!keys.length) return
  const time = Math.max(nextSettingsTimestamp(), lastTime + 1)
  const changes = keys.map((key) => ({ key, value: after[key], time, client }))
  lastTime = time
  observed = current
  pending.push(...changes)
  writeJournal()
  void flushSettings().catch(report)
}

/** Resolve only after every preference edit requested so far has committed. Export/import await this. */
export function flushSettings(): Promise<void> {
  if (flushing) return flushing
  if (!pending.length) return Promise.resolve()
  flushing = (async () => {
    while (pending.length) {
      const changes = pending.slice()
      const saved = await saveSettingsChanges(changes)
      pending.splice(0, changes.length)
      writeJournal()
      if (!pending.length) hydrate(saved)
    }
    lastError = ''
  })().finally(() => { flushing = undefined })
  return flushing
}

async function refreshExternal() {
  try {
    await flushSettings()
    const { settings } = await readLibrarySnapshot()
    // A user edit during the read wins its own fields and will merge in its transaction.
    if (!pending.length) hydrate(settings)
  } catch (error) { report(error) }
}

function onBeforeUnload(event: BeforeUnloadEvent) {
  writeJournal()
  if (pending.length && journalUnavailable) { event.preventDefault(); event.returnValue = '' }
}

function onPageHide() { writeJournal(); void flushSettings().catch(report) }
function onVisible() { if (document.visibilityState === 'visible') void refreshExternal() }

export function startSettingsSync(): void {
  if (stopStore) return
  observed = structuredClone(librarySettings(useEditorStore.getState()))
  stopStore = useEditorStore.subscribe(captureChanges)
  stopExternal = onLibraryChange((kind) => { if (kind !== 'stamps') void refreshExternal() })
  window.addEventListener('beforeunload', onBeforeUnload)
  window.addEventListener('pagehide', onPageHide)
  document.addEventListener('visibilitychange', onVisible)
}

export function resetSettingsSync(): void {
  stopStore?.()
  stopExternal?.()
  stopStore = undefined
  stopExternal = undefined
  window.removeEventListener('beforeunload', onBeforeUnload)
  window.removeEventListener('pagehide', onPageHide)
  document.removeEventListener('visibilitychange', onVisible)
  writeJournal()
  void flushSettings().catch(report)
}
