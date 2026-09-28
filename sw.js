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
const CACHE_VERSION = "opio-2026.09.28-22";
const CACHE_NAME = "opio-cache-" + CACHE_VERSION;
const HANDBOOK_CACHE_NAME = "opio-handbook-" + CACHE_VERSION;
const TESS_CACHE_NAME = "opio-tesseract-" + CACHE_VERSION;

// Core files that make up the app shell. The ?v= query strings match the
// versions referenced in index.html so the right copies are precached.
const CORE_ASSETS = [
  "./",
  "./styles.css?v=20260928-22",
  "./seedtag.css?v=20260928-22",
  "./config.js?v=20260928-22",
  "./app.js?v=20260928-22",
  "./uxenhancements.js?v=20260928-22",
  "./asapplied.js?v=20260928-22",
  "./seedtag.js?v=20260928-22",
  "./handbook.js?v=20260928-22",
  "./yieldmonitor.js?v=20260928-22",
  "./manifest.json",
  "./icon-16.png",
  "./icon-32.png",
  "./icon-180.png",
  "./icon-192.png",
  "./icon-512.png"
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
      Promise.all(CORE_ASSETS.map((url) =>
        cache.add(url).catch((err) => console.warn("[SW] skip precache:", url, err))
      ))
    ).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => {
        return k !== CACHE_NAME && k !== HANDBOOK_CACHE_NAME && k !== TESS_CACHE_NAME;
      }).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

function isNetworkOnly(url) {
  return (
    url.hostname.includes("googleapis.com") ||
    url.hostname.includes("gstatic.com") ||
    url.hostname.includes("google.com") ||
    url.hostname.includes("googleusercontent.com")
  );
}
function isHandbookRequest(url) {
  return url.href.startsWith(HANDBOOK_BASE);
}
function isTesseractRequest(url) {
  if (!TESS_HOSTS.includes(url.hostname)) return false;
  return /tesseract/i.test(url.pathname) || /traineddata/i.test(url.pathname);
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  let url;
  try { url = new URL(req.url); } catch (e) { return; }

  if (isHandbookRequest(url)) {
    event.respondWith(
      fetch(req).then((res) => {
        if (res && res.status === 200) {
          const copy = res.clone();
          caches.open(HANDBOOK_CACHE_NAME).then((c) => c.put(req, copy));
        }
        return res;
      }).catch(() =>
        caches.match(req).then((hit) => hit || new Response(
          "# Section unavailable offline\n\nThis section hasn't been viewed while online yet.",
          { headers: { "Content-Type": "text/markdown" } }
        ))
      )
    );
    return;
  }

  if (isTesseractRequest(url)) {
    event.respondWith(
      caches.match(req).then((hit) => {
        if (hit) return hit;
        return fetch(req).then((res) => {
          if (res && res.status === 200) {
            const copy = res.clone();
            caches.open(TESS_CACHE_NAME).then((c) => c.put(req, copy));
          }
          return res;
        });
      })
    );
    return;
  }

  if (isNetworkOnly(url)) return;
  if (url.origin !== self.location.origin) return;

  const isHTML = req.mode === "navigate" ||
    (req.headers.get("accept") || "").includes("text/html");
  if (isHTML) {
    event.respondWith(
      fetch(req).then((res) => {
        const copy = res.clone();
        caches.open(CACHE_NAME).then((c) => c.put(req, copy));
        return res;
      }).catch(() =>
        caches.match(req).then((hit) => hit || caches.match("./index.html"))
      )
    );
    return;
  }

  event.respondWith(
    caches.match(req).then((hit) => {
      if (hit) return hit;
      return fetch(req).then((res) => {
        if (res && res.status === 200 && res.type === "basic") {
          const copy = res.clone();
          caches.open(CACHE_NAME).then((c) => c.put(req, copy));
        }
        return res;
      }).catch(() => hit);
    })
  );
});

self.addEventListener("message", (event) => {
  if (event.data === "SKIP_WAITING") self.skipWaiting();
});
