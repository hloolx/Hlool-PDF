import { create } from 'zustand'

type OfflineStatus = 'preparing' | 'ready' | 'update' | 'error' | 'unsupported' | 'development'

export const useOffline = create<{ status: OfflineStatus }>(() => ({
  status: import.meta.env.DEV ? 'development' : 'preparing'
}))

let registering: Promise<void> | undefined
let inspection = 0
const watchedWorkers = new WeakSet<ServiceWorker>()
const watchedRegistrations = new WeakSet<ServiceWorkerRegistration>()

function cacheReady(worker: ServiceWorker, repair: boolean): Promise<boolean> {
  return new Promise((resolve) => {
    const channel = new MessageChannel()
    const finish = (ok: boolean) => {
      clearTimeout(timer)
      channel.port1.close()
      resolve(ok)
    }
    const timer = window.setTimeout(() => finish(false), repair ? 60_000 : 8_000)
    channel.port1.onmessage = (event) => finish(event.data?.ok === true)
    channel.port1.onmessageerror = () => finish(false)
    try {
      worker.postMessage({ type: repair ? 'HLOOL_OFFLINE_REPAIR' : 'HLOOL_OFFLINE_STATUS' }, [channel.port2])
    } catch { finish(false) }
  })
}

async function inspect(registration: ServiceWorkerRegistration, repair = false) {
  const request = ++inspection
  const active = registration.active
  if (!active || active.state !== 'activated') return
  const ready = await cacheReady(active, repair)
  if (request !== inspection) return
  useOffline.setState({ status: ready ? (registration.waiting ? 'update' : 'ready') : 'error' })
}

function watch(registration: ServiceWorkerRegistration, worker: ServiceWorker | null) {
  if (!worker || watchedWorkers.has(worker)) return
  watchedWorkers.add(worker)
  worker.addEventListener('statechange', () => {
    if (worker.state === 'redundant') {
      // A failed update must not hide an intact offline copy of the current app.
      if (registration.active?.state === 'activated') void inspect(registration)
      else useOffline.setState({ status: 'error' })
    }
    if (worker.state === 'activated' || (worker.state === 'installed' && registration.active)) void inspect(registration)
  })
}

export function prepareOffline({ repair = false }: { repair?: boolean } = {}): Promise<void> {
  if (import.meta.env.DEV) return Promise.resolve()
  if (!window.isSecureContext || !('serviceWorker' in navigator)) {
    useOffline.setState({ status: 'unsupported' })
    return Promise.resolve()
  }
  if (registering) return registering
  useOffline.setState({ status: 'preparing' })
  registering = (async () => {
    const url = new URL(`${import.meta.env.BASE_URL}sw.js`, location.href).href
    try {
      let registration: ServiceWorkerRegistration
      try {
        registration = await navigator.serviceWorker.register(url, { updateViaCache: 'none' })
      } catch (error) {
        // An offline update fetch can fail even though a working copy exists.
        const existing = await navigator.serviceWorker.getRegistration(import.meta.env.BASE_URL)
        if (existing?.active?.scriptURL !== url) throw error
        registration = existing
      }
      watch(registration, registration.installing)
      watch(registration, registration.active)
      if (!watchedRegistrations.has(registration)) {
        watchedRegistrations.add(registration)
        registration.addEventListener('updatefound', () => watch(registration, registration.installing))
      }
      await inspect(registration, repair)
    } catch {
      useOffline.setState({ status: 'error' })
    }
  })().finally(() => { registering = undefined })
  return registering
}
