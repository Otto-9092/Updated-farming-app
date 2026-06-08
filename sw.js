/* ============================================================
   OπO Farming — Service Worker (PWA offline support)
   Caches the app shell so the app loads & runs with no signal.
   Google Maps tiles/scripts are NEVER cached (they need network).
   Bump CACHE_VERSION whenever you ship new files.
   ============================================================ */
const CACHE_VERSION = "opio-2026.06.08-2355";
const CACHE_NAME = "opio-cache-" + CACHE_VERSION;

// Core files that make up the app shell. The ?v= query strings match the
// versions referenced in index.html so the right copies are precached.
const CORE_ASSETS = [
  "./",
  "./index.html",
  "./styles.css",
  "./config.js?v=20260605-1745",
  "./app.js?v=20260605-1745",
  "./manifest.json",
  "./icon-16.png",
  "./icon-32.png",
  "./icon-192.png",
  "./icon-512.png"
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
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
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

// Fetch strategy:
//  - Maps & cross-origin Google: network-only (never cache).
//  - Navigation (HTML): network-first, fall back to cached index.html offline.
//  - Same-origin assets: cache-first, then network (and cache the result).
self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  let url;
  try { url = new URL(req.url); } catch (e) { return; }

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
