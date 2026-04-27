'use strict';

const SW_VERSION = '20260427-2';
const IS_IOS = /iPad|iPhone|iPod/.test(self.navigator.userAgent) ||
  (/Macintosh/.test(self.navigator.userAgent) && self.navigator.maxTouchPoints > 1);
const CORE_CACHE = `pastii-core-${SW_VERSION}`;
const RUNTIME_CACHE = `pastii-runtime-${SW_VERSION}`;
const MAX_RUNTIME_ENTRIES = IS_IOS ? 45 : 90;
const IOS_MAX_IMAGE_CACHE_BYTES = 350 * 1024;

const CORE_ASSETS = [
  '/',
  'index.html',
  'manifest.json',
  'version.json',
  'flutter.js',
  'flutter_bootstrap.js',
  'icons/Icon-192.png',
  'icons/Icon-maskable-192.png',
  'favicon.png',
  'splash/img/light-1x.png',
  'splash/img/dark-1x.png',
];

const CACHEABLE_DESTINATIONS = new Set([
  'script',
  'style',
  'font',
  'image',
  'fetch',
  'worker',
]);

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CORE_CACHE);
      await Promise.all(
        CORE_ASSETS.map(async (assetPath) => {
          try {
            const request = new Request(assetPath, { cache: 'reload' });
            const response = await fetch(request);
            if (response.ok || response.type === 'opaque') {
              await cache.put(request, response.clone());
            }
          } catch (error) {
            console.warn('Core asset not cached:', assetPath, error);
          }
        })
      );
      self.skipWaiting();
    })()
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const expectedCaches = new Set([CORE_CACHE, RUNTIME_CACHE]);
      const cacheKeys = await caches.keys();
      await Promise.all(
        cacheKeys.map((cacheKey) => {
          if (!expectedCaches.has(cacheKey)) {
            return caches.delete(cacheKey);
          }
          return Promise.resolve();
        })
      );
      if (self.registration.navigationPreload) {
        await self.registration.navigationPreload.enable();
      }
      await self.clients.claim();
    })()
  );
});

self.addEventListener('message', (event) => {
  if (event.data === 'skipWaiting') {
    self.skipWaiting();
  }
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') {
    return;
  }

  const requestUrl = new URL(request.url);
  if (requestUrl.origin !== self.location.origin) {
    return;
  }

  if (request.mode === 'navigate') {
    event.respondWith(handleNavigationRequest(event));
    return;
  }

  if (shouldHandleAsStaticAsset(request, requestUrl)) {
    if (isHighValueBinaryPath(requestUrl.pathname)) {
      event.respondWith(cacheFirstAsset(request, requestUrl));
      return;
    }

    event.respondWith(staleWhileRevalidate(request, requestUrl));
  }
});

function shouldHandleAsStaticAsset(request, requestUrl) {
  if (
    requestUrl.pathname.endsWith('.symbols') ||
    requestUrl.pathname.endsWith('.map') ||
    requestUrl.pathname.endsWith('.env')
  ) {
    return false;
  }

  return (
    CACHEABLE_DESTINATIONS.has(request.destination) ||
    requestUrl.pathname.startsWith('/assets/') ||
    requestUrl.pathname.startsWith('/canvaskit/')
  );
}

function isHighValueBinaryPath(pathname) {
  return pathname === '/main.dart.js' || pathname.endsWith('.wasm') || pathname.startsWith('/canvaskit/');
}

function shouldCacheResponse(request, requestUrl, response) {
  if (!(response.ok || response.type === 'opaque')) {
    return false;
  }

  if (!IS_IOS || response.type === 'opaque' || isHighValueBinaryPath(requestUrl.pathname)) {
    return true;
  }

  const responseSize = Number(response.headers.get('content-length') || 0);
  if (!Number.isFinite(responseSize) || responseSize <= 0) {
    return true;
  }

  const isImageRequest =
    request.destination === 'image' ||
    /\.(png|jpg|jpeg|gif|webp|svg)$/i.test(requestUrl.pathname);

  if (isImageRequest && responseSize > IOS_MAX_IMAGE_CACHE_BYTES) {
    return false;
  }

  return true;
}

async function cacheRuntimeResponse(runtimeCache, request, requestUrl, response) {
  if (!shouldCacheResponse(request, requestUrl, response)) {
    return;
  }

  await runtimeCache.put(request, response.clone());
  await trimRuntimeCache(runtimeCache);
}

async function handleNavigationRequest(event) {
  const request = event.request;
  const runtimeCache = await caches.open(RUNTIME_CACHE);

  try {
    const preloadResponse = await event.preloadResponse;
    if (preloadResponse) {
      await cacheRuntimeResponse(runtimeCache, request, new URL(request.url), preloadResponse);
      return preloadResponse;
    }

    const networkResponse = await fetch(request);
    await cacheRuntimeResponse(runtimeCache, request, new URL(request.url), networkResponse);
    return networkResponse;
  } catch (error) {
    const cachedResponse = await runtimeCache.match(request, { ignoreSearch: true });
    if (cachedResponse) {
      return cachedResponse;
    }

    const coreCache = await caches.open(CORE_CACHE);
    return (
      (await coreCache.match('index.html', { ignoreSearch: true })) ||
      (await coreCache.match('/', { ignoreSearch: true }))
    );
  }
}

async function cacheFirstAsset(request, requestUrl) {
  const runtimeCache = await caches.open(RUNTIME_CACHE);
  const cachedResponse = await runtimeCache.match(request, { ignoreSearch: true });
  if (cachedResponse) {
    return cachedResponse;
  }

  try {
    const networkResponse = await fetch(request);
    await cacheRuntimeResponse(runtimeCache, request, requestUrl, networkResponse);
    return networkResponse;
  } catch (error) {
    const coreCache = await caches.open(CORE_CACHE);
    return coreCache.match(request, { ignoreSearch: true });
  }
}

async function staleWhileRevalidate(request, requestUrl) {
  const runtimeCache = await caches.open(RUNTIME_CACHE);
  const cachedResponse = await runtimeCache.match(request, { ignoreSearch: true });

  const networkFetch = fetch(request)
    .then(async (networkResponse) => {
      await cacheRuntimeResponse(runtimeCache, request, requestUrl, networkResponse);
      return networkResponse;
    })
    .catch(() => undefined);

  if (cachedResponse) {
    return cachedResponse;
  }

  const networkResponse = await networkFetch;
  if (networkResponse) {
    return networkResponse;
  }

  const coreCache = await caches.open(CORE_CACHE);
  return coreCache.match(request, { ignoreSearch: true });
}

async function trimRuntimeCache(runtimeCache) {
  const requests = await runtimeCache.keys();
  if (requests.length <= MAX_RUNTIME_ENTRIES) {
    return;
  }

  const overflow = requests.length - MAX_RUNTIME_ENTRIES;
  await Promise.all(requests.slice(0, overflow).map((request) => runtimeCache.delete(request)));
}
