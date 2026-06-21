const CACHE_NAME = "fusion-cache-v5";
const APP_SHELL_URLS = [
  "/",
  "/index.html",
  "/manifest.json",
  "/logo.svg",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
];

self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SKIP_WAITING") {
    self.skipWaiting();
  }
});

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    try {
      const cache = await caches.open(CACHE_NAME);
      await cache.addAll(APP_SHELL_URLS);
      await self.skipWaiting();
    } catch (error) {
      console.warn("[sw] install cache warmup failed", error);
    }
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    try {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((key) => key !== CACHE_NAME)
          .map((key) => caches.delete(key)),
      );
      await self.clients.claim();
    } catch (error) {
      console.warn("[sw] activate cleanup failed", error);
    }
  })());
});

self.addEventListener("fetch", (event) => {
  const request = event.request;

  if (request.method !== "GET") {
    return;
  }

  const url = new URL(request.url);
  const accept = request.headers.get("accept") ?? "";
  const isApiRequest = url.pathname.startsWith("/api/");
  const isEventStreamRequest =
    accept.includes("text/event-stream") ||
    url.pathname === "/api/events" ||
    url.pathname.startsWith("/api/events/");
  const isNavigationRequest =
    request.mode === "navigate" ||
    request.destination === "document" ||
    url.pathname === "/" ||
    url.pathname === "/index.html";
  const isBuiltAssetRequest =
    url.pathname.startsWith("/assets/") ||
    request.destination === "script" ||
    request.destination === "style" ||
    request.destination === "font";

  // EventSource requests stay open indefinitely. Waiting on cache.put() for an
  // infinite response body prevents the browser from ever receiving the stream
  // and leaks the underlying connection across reloads. Let SSE bypass the
  // service worker entirely so the browser talks to the network directly.
  if (isEventStreamRequest) {
    return;
  }

  // Always revalidate the HTML shell so navigation picks up the latest hashed
  // asset names instead of getting stuck on a cached index.html that points at
  // a stale bundle.
  if (isNavigationRequest) {
    event.respondWith((async () => {
      try {
        const networkResponse = await fetch(request);
        try {
          const cache = await caches.open(CACHE_NAME);
          await cache.put(request, networkResponse.clone());
        } catch (cacheError) {
          console.warn("[sw] navigation cache put failed", cacheError);
        }
        return networkResponse;
      } catch (networkError) {
        const fallback = await caches.match(request);
        if (fallback) {
          return fallback;
        }
        throw networkError;
      }
    })());
    return;
  }

  if (isApiRequest) {
    event.respondWith((async () => {
      try {
        const networkResponse = await fetch(request);
        try {
          const cache = await caches.open(CACHE_NAME);
          await cache.put(request, networkResponse.clone());
        } catch (cacheError) {
          console.warn("[sw] api cache put failed", cacheError);
        }
        return networkResponse;
      } catch (networkError) {
        try {
          const cachedResponse = await caches.match(request);
          if (cachedResponse) {
            return cachedResponse;
          }
        } catch (cacheError) {
          console.warn("[sw] api cache lookup failed", cacheError);
        }
        throw networkError;
      }
    })());
    return;
  }

  // Built assets are content-hashed, but an already-controlled browser can
  // keep old entries in this named cache across local rebuilds. Prefer the
  // server response so tabs cannot stay on stale JS/CSS and render a blank
  // shell after an update. The cache remains an offline fallback.
  if (isBuiltAssetRequest) {
    event.respondWith((async () => {
      try {
        const networkResponse = await fetch(request);
        try {
          const cache = await caches.open(CACHE_NAME);
          await cache.put(request, networkResponse.clone());
        } catch (cacheError) {
          console.warn("[sw] asset cache put failed", cacheError);
        }
        return networkResponse;
      } catch (networkError) {
        try {
          const cachedResponse = await caches.match(request);
          if (cachedResponse) {
            return cachedResponse;
          }
        } catch (cacheError) {
          console.warn("[sw] asset cache lookup failed", cacheError);
        }
        throw networkError;
      }
    })());
    return;
  }

  event.respondWith((async () => {
    try {
      const cache = await caches.open(CACHE_NAME);
      const cachedResponse = await cache.match(request);
      if (cachedResponse) {
        return cachedResponse;
      }

      const networkResponse = await fetch(request);
      await cache.put(request, networkResponse.clone());
      return networkResponse;
    } catch (error) {
      console.warn("[sw] static cache flow failed", error);
      return fetch(request);
    }
  })());
});
