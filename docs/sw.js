// 式が見える電卓：オフライン用のキャッシュ
// ファイルを更新したら CACHE の番号を上げると、次の起動で新しい版に入れ替わる
// docs/ にファイルを増やしたときは、下の FILES にも足す
// アイコンを差し替えたときは、index.html と manifest の「?v=」の番号も上げる（端末が古い画像を覚えているため）
const CACHE = "calc-v51";
const FILES = [
  "./",
  "./index.html",
  "./style.css",
  "./calc.js",
  "./app.js",
  "./manifest.webmanifest",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/maskable-512.png",
  "./icons/apple-touch-icon.png"
];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES.map(u => new Request(u, { cache: "reload" })))).then(() => self.skipWaiting()));
});

self.addEventListener("activate", e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// 保存してある版をすぐ返して起動を速くし、裏でネットから最新版を取り直しておく
self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET" || new URL(req.url).origin !== location.origin) return;
  e.respondWith(
    caches.open(CACHE).then(async cache => {
      const cached = await cache.match(req, { ignoreSearch: true });
      const update = fetch(req).then(res => {
        if (res && res.ok) cache.put(req, res.clone());
        return res;
      }).catch(() => cached);
      return cached || update;
    })
  );
});
