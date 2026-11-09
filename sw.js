// アプリの入れ物（画面とプログラム）を端末に保存して、電波が無くても開けるようにする。
// 問題データはここでは扱わない（IndexedDB に入る）。VERSION は tools/qb_mobile.py build が書き換える
const CACHE = "qb-note-20261109171611";
const FILES = ["./", "index.html", "app.js", "lib.js", "manifest.webmanifest", "icon-192.png", "icon-512.png", "apple-touch-icon.png"];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
// 端末に保存した分を先に返す（速く、オフラインでも開ける）。新しい版は次に開いたときに入れ替わる
self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET" || new URL(req.url).origin !== location.origin) return;
  e.respondWith(
    caches.match(req, { ignoreSearch: true }).then(hit =>
      hit || (req.mode === "navigate" ? caches.match("index.html") : null)
    ).then(hit => hit || fetch(req))
  );
});
