/* Generated with every static build. Only application assets enter this cache. */
const VERSION = __BUILD_VERSION__
const FILES = __BUILD_FILES__
const SCOPE = self.registration.scope
const PREFIX = `hlool-pdf-app:${SCOPE}:`
const CACHE = PREFIX + VERSION
const URLS = FILES.map((file) => new URL(file, SCOPE).href)
const ASSETS = new Set(URLS)
const INDEX = new URL('index.html', SCOPE).href
let repairing

async function missingAssets() {
  const cache = await caches.open(CACHE)
  const present = await Promise.all(URLS.map((url) => cache.match(url, { ignoreVary: true })))
  return URLS.filter((_, index) => !present[index])
}

// An active registration can outlive its cache. Report actual cache health and
// repair only missing application files, without touching the user's library.
self.addEventListener('message', (event) => {
  const type = event.data?.type
  if (!event.ports[0] || !['HLOOL_OFFLINE_STATUS', 'HLOOL_OFFLINE_REPAIR'].includes(type)) return
  event.waitUntil((async () => {
    try {
      if (type === 'HLOOL_OFFLINE_REPAIR') {
        repairing ??= (async () => {
          const missing = await missingAssets()
          if (missing.length) {
            const cache = await caches.open(CACHE)
            await cache.addAll(missing.map((url) => new Request(url, { cache: 'reload' })))
          }
        })().finally(() => { repairing = undefined })
        await repairing
      }
      event.ports[0].postMessage({ ok: (await missingAssets()).length === 0, version: VERSION })
    } catch {
      event.ports[0].postMessage({ ok: false, version: VERSION })
    }
  })())
})

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE)
    try {
      await cache.addAll(URLS.map((url) => new Request(url, { cache: 'reload' })))
    } catch (error) {
      await caches.delete(CACHE)
      throw error
    }
    // Updates wait for all old tabs to close. Never replace an engine mid-job.
  })())
})

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys()
    await Promise.all(keys.filter((key) => key.startsWith(PREFIX) && key !== CACHE).map((key) => caches.delete(key)))
    await self.clients.claim()
  })())
})

self.addEventListener('fetch', (event) => {
  const request = event.request
  if (request.method !== 'GET') return
  const url = new URL(request.url)
  if (url.origin !== self.location.origin || !url.href.startsWith(SCOPE)) return
  const navigation = request.mode === 'navigate'
  if (!navigation && !ASSETS.has(url.href)) return
  event.respondWith((async () => {
    const cache = await caches.open(CACHE)
    // Keep HTML and lazy-loaded engines on the same build, even across updates.
    // Build files are immutable and explicitly allowlisted. Ignore Vary: Origin:
    // precache and browser module requests may carry different Origin headers.
    const cached = await cache.match(navigation ? INDEX : request, { ignoreVary: true })
    // Static hosts may redirect index.html to the directory URL. Navigation
    // requests reject redirected responses supplied by a service worker. Keep
    // the cached build and its security headers, but remove that redirect flag.
    if (navigation && cached?.redirected) {
      return new Response(cached.body, {
        status: cached.status,
        statusText: cached.statusText,
        headers: cached.headers
      })
    }
    return cached || fetch(request)
  })())
})
