// Zetme — juda oddiy service worker: faqat PWA sifatida "telefonga o'rnatish"
// imkoniyati va statik ikonalarni tez yuklash uchun. API so'rovlariga (/api/...)
// umuman aralashmaydi — har doim to'g'ridan-to'g'ri tarmoqdan boradi, shunda
// narx/mahsulot/savat ma'lumotlari HECH QACHON eskirib qolmaydi.
const CACHE = "zetme-shell-v1";
const SHELL = ["/icons/icon-192.png", "/icons/icon-512.png"];

self.addEventListener("install", (e) => {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).catch(() => {}));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  // API va boshqa domenlarga tegmaymiz — har doim tarmoqdan
  if (url.pathname.startsWith("/api/") || url.origin !== self.location.origin) return;
  // faqat GET so'rovlar uchun
  if (e.request.method !== "GET") return;

  // ikonalar/statik fayllar: cache-first (tezroq ochilish uchun)
  if (url.pathname.startsWith("/icons/") || url.pathname === "/manifest.json") {
    e.respondWith(
      caches.match(e.request).then((cached) => cached || fetch(e.request))
    );
    return;
  }
  // HTML sahifalar: network-first, tarmoq bo'lmasa keshdan (agar bor bo'lsa)
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => {});
        return res;
      })
      .catch(() => caches.match(e.request))
  );
});
