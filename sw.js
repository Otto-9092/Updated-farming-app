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
const CACHE_VERSION = "opio-2026.09.08-20";
const CACHE_NAME = "opio-cache-" + CACHE_VERSION;
const HANDBOOK_CACHE_NAME = "opio-handbook-" + CACHE_VERSION;
const TESS_CACHE_NAME = "opio-tesseract-" + CACHE_VERSION;

// Core files that make up the app shell. The ?v= query strings match the
// versions referenced in index.html so the right copies are precached.
const CORE_ASSETS = [
  "./",
  "./styles.css?v=20260908-20",
  "./seedtag.css?v=20260908-20",
  "./config.js?v=20260908-20",
  "./app.js?v=20260908-20",
  "./uxenhancements.js?v=20260908-20",
  "./asapplied.js?v=20260908-20",
  "./seedtag.js?v=20260908-20",
  "./handbook.js?v=20260908-20",
  "./manifest.json",
  "./icon-16.png",
  "./icon-32.png",
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
      // addAll fails the whole install if any file 404s; use individual
      // puts so a missing optional file (e.g. favicon) won't break install.
      Promise.all(CORE_ASSETS.map((url) =>
        cache.add(url).catch((err) => console.warn("[SW] skip precache:", url, err))
      ))
    ).then(() => self.skipWaiting())
  );
});

// Activate: delete old caches, take control immediately.
// Keep any current handbook + tesseract caches; only expired versions are pruned.
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => {
        // Delete anything that doesn't match any current cache name
        return k !== CACHE_NAME && k !== HANDBOOK_CACHE_NAME && k !== TESS_CACHE_NAME;
      }).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// Should this request bypass the cache entirely? (always go to network)
function isNetworkOnly(url) {
  return (
    url.hostname.includes("googleapis.com") ||      // Maps JS API
    url.hostname.includes("gstatic.com") ||         // Maps tiles/assets
    url.hostname.includes("google.com") ||          // Maps misc
    url.hostname.includes("googleusercontent.com")
  );
}

// Is this a handbook section request?
function isHandbookRequest(url) {
  return url.href.startsWith(HANDBOOK_BASE);
}

// Is this a Tesseract.js OCR asset? (library, wasm core, or language data)
function isTesseractRequest(url) {
  if (!TESS_HOSTS.includes(url.hostname)) return false;
  // Only cache the specific Tesseract paths so we don't hoard unrelated
  // jsdelivr traffic if anything else ever loads from that CDN.
  return /tesseract/i.test(url.pathname) || /traineddata/i.test(url.pathname);
}

// Fetch strategy:
//  - Handbook sections (raw.githubusercontent.com): network-first, cache-fallback
//    so latest content shows when online, cached content shows when offline.
//  - Tesseract OCR assets: cache-first, network fallback (heavy files, rarely change)
//  - Maps & cross-origin Google: network-only (never cache).
//  - Navigation (HTML): network-first, fall back to cached index.html offline.
//  - Same-origin assets: cache-first, then network (and cache the result).
self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  let url;
  try { url = new URL(req.url); } catch (e) { return; }

  // Handbook sections — network first, cache fallback, keep the cache updated
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

  // Tesseract.js OCR assets — cache-first, network fallback (~2 MB, rarely change)
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

  // Never intercept Google Maps / other 3rd-party — let the browser handle it.
  if (isNetworkOnly(url)) return;

  // Only handle same-origin requests from here on.
  if (url.origin !== self.location.origin) return;

  // HTML navigations: network-first so updates show, offline falls back.
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

  // Everything else same-origin: cache-first, then network.
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

// Allow the page to tell a waiting SW to activate immediately.
self.addEventListener("message", (event) => {
  if (event.data === "SKIP_WAITING") self.skipWaiting();
});
