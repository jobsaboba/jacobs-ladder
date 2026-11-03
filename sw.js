/* Jacob's Ladder Racing — service worker (app shell cache + fresh data) */
const CACHE = "jlapp-v5";
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

/* ---- background race alerts (wake push when the app is fully closed) ---- */
const dayUrl = "./data/latest.json";

function idbOpen() {
  return new Promise((res, rej) => {
    const r = indexedDB.open("jlapp", 1);
    r.onupgradeneeded = () => r.result.createObjectStore("state");
    r.onsuccess = () => res(r.result);
    r.onerror = rej;
  });
}
async function mirrorGet() {
  try {
    const db = await idbOpen();
    return await new Promise((res) => {
      const rq = db.transaction("state").objectStore("state").get("ladder");
      rq.onsuccess = () => res(rq.result || null);
      rq.onerror = () => res(null);
    });
  } catch { return null; }
}
async function raceOfDay() {
  const res = await fetch(dayUrl + "?ts=" + Date.now(), { cache: "no-store" });
  if (!res.ok) return null;
  const day = await res.json();
  if (!day || !Array.isArray(day.finals)) return null;
  const now = Date.now();
  const times = (f) => new Date(`${day.date}T${f.time}:00`).getTime();
  const upcoming = day.finals.filter((f) => times(f) - now >= -5 * 60000);
  upcoming.sort((a, b) => times(a) - times(b));
  return { race: upcoming[0] || null, date: day.date };
}

self.addEventListener("push", (e) => {
  e.waitUntil((async () => {
    const { race } = await raceOfDay();
    if (!race) {
      return self.registration.showNotification("Jacob's Ladder", {
        body: "Race alert — open the app for today's selections",
        badge: "icons/icon-192.png",
      });
    }
    const m = await mirrorGet();
    const title = `${race.course} ${race.time} — ${race.horse}`;
    const body =
      (m && m.next ? `Place your stake ${m.next} — ` : "") +
      `${race.trainer} · ${race.odds} · ${"★".repeat(race.stars || 0)}`;
    await self.registration.showNotification(title, {
      body, tag: `${race.course}-${race.time}`,
      badge: "icons/icon-192.png", data: { url: "./" },
    });
  })());
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  e.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) =>
      list.length ? list[0].focus() : clients.openWindow(e.notification.data?.url || "./")
    )
  );
});

self.addEventListener("fetch", (e) => {  const url = new URL(e.request.url);
  if (url.origin !== self.location.origin) return;

  // selections JSON: always try the network first so race days stay fresh
  if (url.pathname.includes("/data/")) {
    e.respondWith(
      fetch(e.request)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
          return res;
        })
        .catch(() => caches.match(e.request))
    );
    return;
  }

  // app shell: network-first so updates always land (offline falls back to cache)
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy));
        return res;
      })
      .catch(() => caches.match(e.request).then((hit) => hit || caches.match("./index.html")))
  );
});
