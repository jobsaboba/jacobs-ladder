/* Jacob's Ladder Racing — service worker (app shell cache + fresh data) */
const CACHE = "jlapp-v10";
const SHELL = ["./", "./index.html", "./manifest.webmanifest", "./icons/icon-192.png", "./icons/icon-512.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (url.origin !== self.location.origin) return;
  if (e.request.method !== "GET") return;
  if (e.request.headers.has("range")) return;

  // GitHub Pages caches files for 10 minutes and shares that copy across
  // loads — right after a deploy the app can be served yesterday's shell.
  // A unique query per fetch always misses the CDN and pulls from origin.
  const busted = url.pathname + "?sw=" + Date.now();
  e.respondWith(
    fetch(busted, { cache: "no-store" })
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy));
        return res;
      })
      .catch(() => caches.match(e.request).then((hit) => hit || caches.match("./index.html")))
  );
});
