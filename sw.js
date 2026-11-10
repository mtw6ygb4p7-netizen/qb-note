// アプリの入れ物（画面とプログラム）を端末に保存して、電波が無くても開けるようにする。
// 問題データはここでは扱わない（IndexedDB に入る）。VERSION は tools/qb_mobile.py build が書き換える
const CACHE = "qb-note-20261110093155";
const FILES = ["./", "index.html", "app.js", "lib.js", "manifest.webmanifest", "icon-192.png", "icon-512.png", "apple-touch-icon.png"];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
// つながっているときは新しい版を取りに行き（3秒で返事が無ければ端末の分）、取れたら端末の分も新しくする。
// オフラインのときは端末に保存した分を返す
self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET" || new URL(req.url).origin !== location.origin) return;
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    try {
      const res = await Promise.race([fetch(req, { cache: "no-cache" }), new Promise((_, no) => setTimeout(() => no(new Error("timeout")), 3000))]);
      if (res.ok) cache.put(req, res.clone());
      return res;
    } catch (err) {
      return (await caches.match(req, { ignoreSearch: true })) || (req.mode === "navigate" ? await caches.match("index.html") : undefined) || Response.error();
    }
  })());
});
