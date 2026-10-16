/* Kai Remote service worker: opens the app shell instantly and keeps posters offline.
   Registered only in secure contexts (https or localhost); plain http on the LAN skips it. */
const VERSION = "kai-remote-v1";
const SHELL = ["/", "/app.css", "/icons.svg", "/theme.js", "/ui.js", "/manifest.webmanifest"];
const IMG_CACHE = "kai-remote-img-v1";
const IMG_MAX = 300;

self.addEventListener("install", (e) => {
  // Cache each file on its own so one 401 (not paired yet) cannot fail the whole install.
  e.waitUntil(caches.open(VERSION).then((c) => Promise.all(SHELL.map((u) => c.add(u).catch(() => {})))));
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION && k !== IMG_CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

async function trim(cache) {
  const keys = await cache.keys();
  if (keys.length > IMG_MAX) await Promise.all(keys.slice(0, keys.length - IMG_MAX).map((k) => cache.delete(k)));
}

self.addEventListener("fetch", (e) => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== location.origin) return;
  if (url.pathname === "/ws/phone" || url.pathname === "/bridge") return;

  // Artwork never changes for a given URL and size: cache first.
  if (url.pathname === "/img") {
    e.respondWith(caches.open(IMG_CACHE).then(async (c) => {
      const hit = await c.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok) { c.put(req, res.clone()); trim(c); }
      return res;
    }));
    return;
  }

  // Shell and pages: network first so updates apply, cache as the offline fallback.
  e.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok) { const copy = res.clone(); caches.open(VERSION).then((c) => c.put(req, copy)); }
        return res;
      })
      .catch(async () => (await caches.match(req)) || (req.mode === "navigate" ? caches.match("/") : Response.error())),
  );
});
