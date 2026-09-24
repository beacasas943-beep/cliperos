const CACHE_NAME = "clipcontrol-static-v441-clean-push-core";
const STATIC_ASSETS = [
  "./",
  "./index.html",
  "./styles.css",
  "./app.js",
  "./supabase-config.js",
  "./imagen1-optimized.webp",
  "./icon-192.png",
  "./icon-512.png",
  "./manifest.json"
];

self.addEventListener("install", event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => Promise.all(STATIC_ASSETS.map(asset => cache.add(asset).catch(() => null))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

function isPrivateOrDynamic(url) {
  return /\/rest\/v1|\/auth\/v1|\/functions\/v1|\/storage\/v1/i.test(url.pathname);
}

async function navigationResponse(request) {
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(CACHE_NAME);
      cache.put("./index.html", response.clone()).catch(() => null);
    }
    return response;
  } catch (_) {
    return (await caches.match("./index.html", { ignoreSearch:true })) || Response.error();
  }
}

async function staticResponse(request) {
  const cached = await caches.match(request, { ignoreSearch:true });
  const refresh = fetch(request).then(async response => {
    if (response.ok && response.type === "basic") {
      const cache = await caches.open(CACHE_NAME);
      cache.put(request, response.clone()).catch(() => null);
    }
    return response;
  }).catch(() => null);
  if (cached) {
    // stale-while-revalidate: respuesta inmediata en WebView y actualización en segundo plano.
    refresh.catch(() => null);
    return cached;
  }
  return (await refresh) || Response.error();
}

self.addEventListener("fetch", event => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || isPrivateOrDynamic(url)) return;
  if (request.mode === "navigate") {
    event.respondWith(navigationResponse(request));
    return;
  }
  const staticPath = STATIC_ASSETS.some(asset => {
    const clean = asset.replace(/^\.\//, "");
    return clean && url.pathname.endsWith(clean);
  });
  if (staticPath) event.respondWith(staticResponse(request));
});
