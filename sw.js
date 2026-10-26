// Keeps the app opening when there's no signal: always tries the network first,
// and falls back to the last copy it saw.
const CACHE = "prompter-v1";

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin) return;
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    try {
      const res = await fetch(e.request, { cache: "no-store" });
      if (res.ok) cache.put(url.pathname, res.clone());
      return res;
    } catch {
      return (await cache.match(url.pathname)) || (await cache.match(url.pathname.replace(/\/$/, "/index.html"))) || Response.error();
    }
  })());
});
