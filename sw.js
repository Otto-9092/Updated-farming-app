/* ============================================================
   OπO Farming — Service Worker (PWA offline support)
   Caches the app shell so the app loads & runs with no signal.
   Google Maps tiles/scripts are NEVER cached (they need network).
   Handbook sections from raw.githubusercontent.com ARE cached
   after first fetch so the Field Guide works offline.
   Tesseract.js OCR engine + language data are cached after
   first successful load so seed-tag scanning works offline.
   Bump CACHE_VERSION whenever you ship new files.
   ============================================================ */
const CACHE_VERSION = "opio-2026.10.09-28";
const CACHE_NAME = "opio-cache-" + CACHE_VERSION;
const HANDBOOK_CACHE_NAME = "opio-handbook-" + CACHE_VERSION;
const TESS_CACHE_NAME = "opio-tesseract-" + CACHE_VERSION;

// Core files that make up the app shell. The ?v= query strings match the
// versions referenced in index.html so the right copies are precached.
const CORE_ASSETS = [
  "./",
  "./styles.css?v=20261009-28",
  "./seedtag.css?v=20261009-28",
  "./config.js?v=20261009-28",
  "./app.js?v=20261009-28",
  "./uxenhancements.js?v=20261009-28",
  "./asapplied.js?v=20261009-28",
  "./seedtag.js?v=20261009-28",
  "./handbook.js?v=20261009-28",
  "./yieldmonitor.js?v=20261009-28",
  "./mapexport.js?v=20261009-28",
  "./manifest.json",
  "./icon-16.png",
  "./icon-32.png",
  "./icon-180.png",
  "./icon-192.png",
  "./icon-512.png",
  "./opio-logo.png"
];

// Handbook base URL — used to identify handbook fetches and cache them.
const HANDBOOK_BASE = "https://raw.githubusercontent.com/Otto-9092/opio-field-guide/main/sections/";

// Tesseract.js OCR assets — cached on first fetch so seed-tag scanning
// works offline after the first successful scan.
const TESS_HOSTS = [
  "cdn.jsdelivr.net",           // tesseract.js library + wasm
  "tessdata.projectnaptha.com"  // eng.traineddata.gz
];

// Install: pre-cache the app shell.
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      cache.addAll(CORE_ASSETS).catch((err) => {
        // Don't let one missing icon kill the whole install.
        console.warn("[sw] precache partial failure:", err);
      })
    )
  );
  self.skipWaiting();
});

// Activate: drop old caches so stale builds don't linger.
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((k) =>
            k.startsWith("opio-cache-") ||
            k.startsWith("opio-handbook-") ||
            k.startsWith("opio-tesseract-")
          )
          .filter((k) =>
            k !== CACHE_NAME &&
            k !== HANDBOOK_CACHE_NAME &&
            k !== TESS_CACHE_NAME
          )
          .map((k) => caches.delete(k))
      )
    )
  );
  self.clients.claim();
});

// Fetch strategy:
//   • Handbook sections       — cache-first, fall through to network.
//   • Tesseract.js assets     — cache-first, fall through to network.
//   • Google Maps / anything else off-origin — network-only, no cache.
//   • App shell (same-origin) — cache-first with network fallback.
self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);

  // Handbook — long-lived cache.
  if (url.href.startsWith(HANDBOOK_BASE)) {
    event.respondWith(
      caches.open(HANDBOOK_CACHE_NAME).then(async (cache) => {
        const hit = await cache.match(req);
        if (hit) return hit;
        try {
          const res = await fetch(req);
          if (res && res.ok) cache.put(req, res.clone());
          return res;
        } catch (e) {
          return hit || Response.error();
        }
      })
    );
    return;
  }

  // Tesseract OCR assets.
  if (TESS_HOSTS.some((h) => url.hostname === h || url.hostname.endsWith("." + h))) {
    event.respondWith(
      caches.open(TESS_CACHE_NAME).then(async (cache) => {
        const hit = await cache.match(req);
        if (hit) return hit;
        try {
          const res = await fetch(req);
          if (res && res.ok) cache.put(req, res.clone());
          return res;
        } catch (e) {
          return hit || Response.error();
        }
      })
    );
    return;
  }

  // Off-origin (Google Maps, OAuth, etc.) — straight to network.
  if (url.origin !== self.location.origin) return;

  // App shell — cache-first.
  event.respondWith(
    caches.open(CACHE_NAME).then(async (cache) => {
      const hit = await cache.match(req);
      if (hit) return hit;
      try {
        const res = await fetch(req);
        if (res && res.ok) cache.put(req, res.clone());
        return res;
      } catch (e) {
        return hit || Response.error();
      }
    })
  );
});
