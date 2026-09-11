const CACHE = "control-movimientos-v11.4";
const ASSETS = [
  "./",
  "./index.html",
  "./app.js?v=11.4",
  "./supabase-config.js?v=11.4",
  "./manifest.webmanifest",
  "./icon-192.png",
  "./icon-512.png"
];
self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)));
  self.skipWaiting();
});
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))));
  self.clients.claim();
});
self.addEventListener("fetch", e => {
  if(e.request.method !== "GET") return;
  const url = new URL(e.request.url);
  const isAppFile = e.request.mode === "navigate" || url.pathname.endsWith("/index.html") || url.pathname.endsWith("/app.js") || url.pathname.endsWith("/supabase-config.js");
  if(isAppFile){
    e.respondWith(fetch(e.request).then(resp => { const clone=resp.clone(); caches.open(CACHE).then(c=>c.put(e.request,clone)); return resp; }).catch(()=>caches.match(e.request).then(r=>r||caches.match("./index.html"))));
    return;
  }
  e.respondWith(caches.match(e.request).then(cached => cached || fetch(e.request).then(resp => { if(resp && (resp.status===200 || resp.type==="opaque")){ const clone=resp.clone(); caches.open(CACHE).then(c=>c.put(e.request,clone)); } return resp; })));
});
