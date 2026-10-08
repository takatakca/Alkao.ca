// Run 51: the tickets page opens without a network (a campground's weak signal at the gate).
// Only the page's own files, network first: online, the newest version; offline, the last
// one seen. The order itself is kept by the page on the device (app.js), never here.
const CACHE = "alkao-billets-v1";
const FILES = [
  "/billets", "/billets/app.js", "/billets/styles.css", "/billets/i18n.js", "/billets/calendar.js",
  "/billets/vendor/htm-preact.js", "/billets/vendor/qrcode.mjs",
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || url.origin !== self.location.origin || !FILES.includes(url.pathname)) return;
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        if (response.ok) {
          const copy = response.clone();
          event.waitUntil(caches.open(CACHE).then((cache) => cache.put(url.pathname, copy)));
        }
        return response;
      })
      .catch(() => caches.match(url.pathname).then((hit) => hit ?? Response.error())),
  );
});
