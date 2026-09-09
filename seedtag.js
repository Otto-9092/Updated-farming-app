// ============================================================
// OπO Farming — SEED TAG READER + LOT INVENTORY (self-contained)
// ------------------------------------------------------------
// Adds a "Seed Inventory" card under the Equipment Library card,
// with camera-based OCR of seed tags (Tesseract.js, on-device),
// lot-level tracking, auto-decrement on planter reports, and a
// smart variety picker inside the planter setup dialog.
//
// Fully additive: does NOT modify app.js state or existing tabs.
// Two tiny hooks in app.js call into SeedTag.* — see README.
//
// Depends only on globals app.js already defines:
//   $, $id, openDlg, closeDlg, appAlert, appConfirm,
//   state, downloadFile, LS_* (via localStorage keys directly)
// ============================================================
(function () {
  "use strict";

  // ----------------------------------------------------------
  // CONSTANTS
  // ----------------------------------------------------------
  var LS_INV       = "dof_seed_inventory";        // { id: entry }
  var LS_TOMB_INV  = "dof_tomb_seed_inventory";   // { id: ts } for sync
  var IDB_NAME     = "opio-seedtags";             // separate DB from field-note photos
  var IDB_STORE    = "tagPhotos";
  var TESS_CDN     = "https://cdn.jsdelivr.net/npm/tesseract.js@5.1.0/dist/tesseract.min.js";
  var TESS_WORKER  = "https://cdn.jsdelivr.net/npm/tesseract.js@5.1.0/dist/worker.min.js";
  var TESS_CORE    = "https://cdn.jsdelivr.net/npm/tesseract.js-core@5.0.0/tesseract-core-simd.wasm.js";
  var TESS_LANG    = "https://tessdata.projectnaptha.com/4.0.0/eng.traineddata.gz";

  var CROP_OPTIONS = ["Corn", "Soybean", "Wheat", "Sorghum", "Sunflower", "Alfalfa", "Other"];

  // ==========================================================
  // DEBUG OVERLAY — on-screen event log for iPhone / iPad
  // ----------------------------------------------------------
  // Turn ON:  add ?seeddebug=1 to the URL, OR run in Safari address bar:
  //           javascript:localStorage.setItem('seedDebug','1');location.reload();
  // Turn OFF: tap the ❌ on the overlay, or run:
  //           javascript:localStorage.removeItem('seedDebug');location.reload();
  // ==========================================================
  var _debugOn = false;
  try {
    _debugOn = /[?&]seeddebug=1/.test(location.search) ||
               localStorage.getItem("seedDebug") === "1";
  } catch (e) {}
  var _debugLog = [];
  var _debugHost = null;
  var _debugBody = null;

  function dbg(tag, data) {
    var stamp = new Date().toISOString().slice(11, 23);
    var line = "[" + stamp + "] " + tag;
    if (data !== undefined) {
      try {
        line += " — " + (typeof data === "string" ? data : JSON.stringify(data));
      } catch (e) { line += " — (unstringifiable: " + e.message + ")"; }
    }
    _debugLog.push(line);
    if (_debugLog.length > 200) _debugLog.shift();
    try { console.log("[SeedTag]", tag, data); } catch (e) {}
    renderDebugPanel();
  }

  function renderDebugPanel() {
    if (!_debugOn) return;
    if (!_debugHost) return;   // panel not built yet
    if (!_debugBody) return;
    _debugBody.textContent = _debugLog.slice(-40).join("\n");
    _debugBody.scrollTop = _debugBody.scrollHeight;
  }

  function buildDebugPanel() {
    if (!_debugOn) return;
    if (_debugHost) return;
    _debugHost = document.createElement("div");
    _debugHost.id = "seedDebugPanel";
    _debugHost.style.cssText = [
      "position:fixed",
      "left:8px",
      "right:8px",
      "bottom:8px",
      "max-height:45vh",
      "z-index:99999",
      "background:rgba(20,20,20,0.92)",
      "color:#7fff7f",
      "font:11px/1.3 ui-monospace,SFMono-Regular,Menlo,monospace",
      "border:1px solid #4c4",
      "border-radius:8px",
      "padding:6px 8px",
      "display:flex",
      "flex-direction:column",
      "gap:4px",
      "box-shadow:0 4px 16px rgba(0,0,0,0.5)"
    ].join(";");
    var header = document.createElement("div");
    header.style.cssText = "display:flex;gap:6px;align-items:center;color:#eee;font-weight:bold;";
    var title = document.createElement("span");
    title.textContent = "🔍 SeedTag Debug";
    title.style.flex = "1";
    var btnCopy = document.createElement("button");
    btnCopy.textContent = "📋 Copy";
    btnCopy.style.cssText = "font:11px sans-serif;padding:2px 6px;border-radius:4px;background:#333;color:#fff;border:1px solid #666;";
    btnCopy.addEventListener("click", function () {
      var txt = _debugLog.join("\n");
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(txt).then(function () {
          btnCopy.textContent = "✓ Copied";
          setTimeout(function () { btnCopy.textContent = "📋 Copy"; }, 1200);
        }, function () { btnCopy.textContent = "❌ "; });
      } else {
        // Fallback: show in a prompt so user can long-press to copy
        window.prompt("Copy the log below:", txt);
      }
    });
    var btnClear = document.createElement("button");
    btnClear.textContent = "🧹 Clear";
    btnClear.style.cssText = btnCopy.style.cssText;
    btnClear.addEventListener("click", function () { _debugLog.length = 0; renderDebugPanel(); });
    var btnClose = document.createElement("button");
    btnClose.textContent = "❌";
    btnClose.style.cssText = btnCopy.style.cssText;
    btnClose.addEventListener("click", function () {
      try { localStorage.removeItem("seedDebug"); } catch (e) {}
      _debugHost.remove();
      _debugHost = null;
      _debugOn = false;
    });
    header.appendChild(title);
    header.appendChild(btnCopy);
    header.appendChild(btnClear);
    header.appendChild(btnClose);
    _debugHost.appendChild(header);
    _debugBody = document.createElement("pre");
    _debugBody.style.cssText = "margin:0;overflow:auto;flex:1;white-space:pre-wrap;word-break:break-word;color:#7fff7f;";
    _debugHost.appendChild(_debugBody);
    (document.body || document.documentElement).appendChild(_debugHost);
    renderDebugPanel();
  }

  // Catch every uncaught error and unhandled promise rejection
  if (_debugOn) {
    window.addEventListener("error", function (e) {
      dbg("🚨 window.error", {
        message: e.message,
        filename: e.filename,
        line: e.lineno,
        col: e.colno,
        stack: e.error && e.error.stack ? String(e.error.stack).slice(0, 400) : null
      });
    });
    window.addEventListener("unhandledrejection", function (e) {
      var r = e.reason;
      dbg("🚨 unhandledrejection", {
        message: r && r.message ? r.message : String(r),
        stack: r && r.stack ? String(r.stack).slice(0, 400) : null
      });
    });
  }
  // ----------------------------------------------------------
  // TINY DOM HELPERS (avoid clashing with app.js's $)
  // ----------------------------------------------------------
  function byId(id) { return document.getElementById(id); }
  function h(tag, attrs, children) {
    var el = document.createElement(tag);
    if (attrs) {
      for (var k in attrs) {
        if (!Object.prototype.hasOwnProperty.call(attrs, k)) continue;
        if (k === "class") el.className = attrs[k];
        else if (k === "style") el.setAttribute("style", attrs[k]);
        else if (k === "html") el.innerHTML = attrs[k];
        else if (k.slice(0, 2) === "on") el.addEventListener(k.slice(2), attrs[k]);
        else el.setAttribute(k, attrs[k]);
      }
    }
    if (children) {
      (Array.isArray(children) ? children : [children]).forEach(function (c) {
        if (c == null) return;
        el.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
      });
    }
    return el;
  }
  function ready(fn) {
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", fn);
    else fn();
  }
  function escapeHtml(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }
  function toast(msg, kind) {
    if (typeof window.showToast === "function") { window.showToast(msg, { kind: kind || "info" }); return; }
    if (typeof window.appAlert === "function") { window.appAlert(msg); return; }
    console.log("[SeedTag]", msg);
  }
  function nowMs() { return Date.now(); }
  function newId(prefix) {
    return (prefix || "seed") + "_" + nowMs() + "_" + Math.random().toString(36).slice(2, 7);
  }

  // ----------------------------------------------------------
  // STORAGE — LocalStorage (metadata) + IndexedDB (photos)
  // ----------------------------------------------------------
  function loadInv() {
    try { return JSON.parse(localStorage.getItem(LS_INV) || "{}") || {}; }
    catch (e) { console.warn("[SeedTag] LS parse failed:", e); return {}; }
  }
  function saveInv(lib) {
    localStorage.setItem(LS_INV, JSON.stringify(lib));
    // Fire a change event so the sync module (if present) can pick it up
    try { window.dispatchEvent(new CustomEvent("seedinv:change")); } catch (e) {}
  }
  function tombstone(id) {
    try {
      var t = JSON.parse(localStorage.getItem(LS_TOMB_INV) || "{}");
      t[id] = nowMs();
      localStorage.setItem(LS_TOMB_INV, JSON.stringify(t));
    } catch (e) {}
  }

  // IndexedDB for tag photos (mirror of app.js's photo pattern)
  var _dbPromise = null;
  function openDB() {
    if (_dbPromise) return _dbPromise;
    _dbPromise = new Promise(function (resolve, reject) {
      if (!("indexedDB" in window)) { reject(new Error("IndexedDB unavailable")); return; }
      var req = indexedDB.open(IDB_NAME, 1);
      req.onupgradeneeded = function () {
        var db = req.result;
        if (!db.objectStoreNames.contains(IDB_STORE)) db.createObjectStore(IDB_STORE);
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
    return _dbPromise;
  }
  function putPhoto(id, dataUrl) {
    return openDB().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(IDB_STORE, "readwrite");
        tx.objectStore(IDB_STORE).put(dataUrl, id);
        tx.oncomplete = resolve;
        tx.onerror = function () { reject(tx.error); };
      });
    });
  }
  function getPhoto(id) {
    return openDB().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(IDB_STORE, "readonly");
        var req = tx.objectStore(IDB_STORE).get(id);
        req.onsuccess = function () { resolve(req.result || null); };
        req.onerror = function () { reject(req.error); };
      });
    });
  }
  function deletePhoto(id) {
    return openDB().then(function (db) {
      return new Promise(function (resolve) {
        var tx = db.transaction(IDB_STORE, "readwrite");
        tx.objectStore(IDB_STORE).delete(id);
        tx.oncomplete = resolve;
        tx.onerror = resolve;   // best-effort
      });
    }).catch(function () { /* IDB unavailable — ignore */ });
  }

  // ----------------------------------------------------------
  // IMAGE PIPELINE — file/camera -> compressed dataURL + preprocess canvas
  // ----------------------------------------------------------
  // Returns a Promise<{ displayDataUrl, ocrDataUrl }>.
  //   displayDataUrl: JPEG ~1600px long-edge, quality 0.82 (what we store)
  //   ocrDataUrl:     grayscale + contrast bumped, sized for OCR
  function fileToProcessed(file) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onerror = function () { reject(new Error("Could not read image")); };
      reader.onload = function () {
        var img = new Image();
        img.onload = function () {
          try {
            // ---- displayDataUrl (for storage / audit view) ----
            var maxLong = 1600;
            var w = img.width, hh = img.height;
            var scale = Math.min(1, maxLong / Math.max(w, hh));
            var dw = Math.round(w * scale), dh = Math.round(hh * scale);
            var c1 = document.createElement("canvas");
            c1.width = dw; c1.height = dh;
            var ctx1 = c1.getContext("2d");
            ctx1.drawImage(img, 0, 0, dw, dh);
            var displayDataUrl = c1.toDataURL("image/jpeg", 0.82);

            // ---- ocrDataUrl (grayscale + contrast) ----
            // Use a slightly higher target long-edge for OCR; Tesseract likes ~1800-2200px.
            var ocrLong = 2000;
            var ocrScale = Math.min(1, ocrLong / Math.max(w, hh));
            var ow = Math.round(w * ocrScale), oh = Math.round(hh * ocrScale);
            var c2 = document.createElement("canvas");
            c2.width = ow; c2.height = oh;
            var ctx2 = c2.getContext("2d");
            ctx2.drawImage(img, 0, 0, ow, oh);
            var imgData = ctx2.getImageData(0, 0, ow, oh);
            var d = imgData.data;
            // Grayscale + linear contrast boost around midtone
            var CONTRAST = 1.35;   // >1 sharpens contrast
            var MIDPOINT = 128;
            for (var i = 0; i < d.length; i += 4) {
              var g = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
              g = MIDPOINT + (g - MIDPOINT) * CONTRAST;
              if (g < 0) g = 0; else if (g > 255) g = 255;
              d[i] = d[i + 1] = d[i + 2] = g;
            }
            ctx2.putImageData(imgData, 0, 0);
            var ocrDataUrl = c2.toDataURL("image/jpeg", 0.85);

            resolve({ displayDataUrl: displayDataUrl, ocrDataUrl: ocrDataUrl });
          } catch (e) { reject(e); }
        };
        img.onerror = function () { reject(new Error("Could not decode image")); };
        img.src = reader.result;
      };
      reader.readAsDataURL(file);
    });
  }

  // ----------------------------------------------------------
  // TESSERACT.JS LOADER (lazy)
  // ----------------------------------------------------------
  var _tessScriptPromise = null;
  function loadTesseract() {
    if (window.Tesseract) return Promise.resolve(window.Tesseract);
    if (_tessScriptPromise) return _tessScriptPromise;
    _tessScriptPromise = new Promise(function (resolve, reject) {
      var s = document.createElement("script");
      s.src = TESS_CDN;
      s.async = true;
      s.onload = function () {
        if (window.Tesseract) resolve(window.Tesseract);
        else reject(new Error("Tesseract global missing after load"));
      };
      s.onerror = function () { reject(new Error("Could not load Tesseract.js from CDN (offline or blocked?)")); };
      document.head.appendChild(s);
    });
    return _tessScriptPromise;
  }

  // Reusable worker — created on first OCR, kept alive for later scans.
  var _workerPromise = null;
  function getWorker(progressCb) {
    if (_workerPromise) return _workerPromise;
    _workerPromise = loadTesseract().then(function (T) {
      // Tesseract v5 API: createWorker(langs, oem, opts) returns a Promise
      return T.createWorker("eng", 1, {
        workerPath: TESS_WORKER,
        corePath: TESS_CORE,
        langPath: "https://tessdata.projectnaptha.com/4.0.0",
        logger: function (m) {
          if (progressCb && m && typeof m.progress === "number") {
            progressCb(m.status || "working", m.progress);
          }
        }
      }).then(function (worker) {
        // Whitelist characters common on seed tags. Helps a lot.
        return worker.setParameters({
          tessedit_char_whitelist:
            "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789 .,-/#:()%"
        }).then(function () { return worker; });
      });
    }).catch(function (err) {
      _workerPromise = null;   // let user retry next time
      throw err;
    });
    return _workerPromise;
  }

  function runOCR(ocrDataUrl, progressCb) {
    return getWorker(progressCb).then(function (worker) {
      return worker.recognize(ocrDataUrl).then(function (res) {
        return {
          text: (res && res.data && res.data.text) || "",
          confidence: (res && res.data && res.data.confidence) || 0
        };
      });
    });
  }

  // ----------------------------------------------------------
  // PARSERS — pull structured fields out of raw OCR text
  // ----------------------------------------------------------
  // Pioneer corn: P####AM, P####Q, P####R, PH####, etc.
  //   Trait suffixes we look for: AM, AMXT, AMX, Q, R, YHR, PRO, VYHR, VT2P
  // Dekalb corn:  DKC##-## (two digits, dash, two digits) + optional trait
  // Soybean examples: P25T50E, P29A25X (Pioneer soy), AG28X (Asgrow)
  // Wheat/others: harder — we fall back to raw text if nothing matched.
  function parseTag(rawText) {
    var text = (rawText || "").replace(/\r/g, "\n");
    var upper = text.toUpperCase();
    var flat = upper.replace(/\s+/g, " ");

    var out = {
      variety: "",
      crop: "",
      lotNumber: "",
      seedsPerBag: null,
      bagWeightLbs: null,
      treatment: "",
      matches: []      // { field, value, source } for debug
    };

    // ---- VARIETY ----
    // Pioneer corn: P + 3-4 digits + trait letters (2-5 letters).
    var pioneerCorn = flat.match(/\bP\s?H?\s?(\d{3,4})\s?([A-Z]{2,5})\b/);
    // Pioneer with dashes/dots common in OCR noise: P 1197 AM, P1197-AM
    var pioneerAlt  = flat.match(/\bP[-. ]?(\d{3,4})[-. ]?([A-Z]{1,5})\b/);
    var dekalb      = flat.match(/\bDKC\s?(\d{2})\s?-?\s?(\d{2})\b/);
    var asgrow      = flat.match(/\bAG\s?(\d{2}[A-Z]?\d{0,2})[A-Z]{0,3}\b/);
    // Pioneer soybean pattern: P##T##E / P##A##X etc.
    var pioneerSoy  = flat.match(/\bP\s?(\d{2})\s?([TA])\s?(\d{2})\s?([A-Z]{0,3})\b/);

    if (pioneerCorn) {
      out.variety = "P" + pioneerCorn[1] + pioneerCorn[2];
      out.crop = "Corn";
      out.matches.push({ field: "variety", value: out.variety, source: "pioneer-corn" });
    } else if (dekalb) {
      out.variety = "DKC" + dekalb[1] + "-" + dekalb[2];
      out.crop = "Corn";
      out.matches.push({ field: "variety", value: out.variety, source: "dekalb" });
    } else if (pioneerSoy) {
      out.variety = "P" + pioneerSoy[1] + pioneerSoy[2] + pioneerSoy[3] + pioneerSoy[4];
      out.crop = "Soybean";
      out.matches.push({ field: "variety", value: out.variety, source: "pioneer-soy" });
    } else if (asgrow) {
      out.variety = "AG" + asgrow[1];
      out.crop = "Soybean";
      out.matches.push({ field: "variety", value: out.variety, source: "asgrow" });
    } else if (pioneerAlt) {
      out.variety = "P" + pioneerAlt[1] + pioneerAlt[2];
      out.crop = "Corn";
      out.matches.push({ field: "variety", value: out.variety, source: "pioneer-alt" });
    }

    // ---- LOT NUMBER ----
    // "LOT: KE1234A56", "LOT # ...", "LOT NO ...", or just "LOT" followed by an
    // 8-14 char alphanumeric run (may contain a single dash).
    var lotMatch = flat.match(/LOT\s*(?:NO\.?|NUMBER|#|:)?\s*([A-Z0-9][A-Z0-9\-]{6,14})/);
    if (lotMatch) {
      out.lotNumber = lotMatch[1].replace(/-+$/, "");
      out.matches.push({ field: "lotNumber", value: out.lotNumber, source: "lot-keyword" });
    } else {
      // Fallback: look for a plausible lot-shaped token in isolation.
      var loose = flat.match(/\b([A-Z]{2}\d{4}[A-Z]?\d{2,3})\b/);
      if (loose) {
        out.lotNumber = loose[1];
        out.matches.push({ field: "lotNumber", value: out.lotNumber, source: "loose-pattern" });
      }
    }

    // ---- SEEDS PER BAG ----
    // "80,000 SEEDS", "140000 KERNELS", "80M SEEDS" (M = thousand on some tags)
    var sc1 = flat.match(/(\d{2,3}(?:,\d{3})?)\s*(?:SEEDS?|KERNELS?)/);
    var sc2 = flat.match(/(\d{2,3})\s*M\s*(?:SEEDS?|KERNELS?)/);
    var sc3 = flat.match(/(\d{2,3}(?:,\d{3})?)\s*CT\b/);
    if (sc1) {
      out.seedsPerBag = parseInt(sc1[1].replace(/,/g, ""), 10);
      out.matches.push({ field: "seedsPerBag", value: out.seedsPerBag, source: "seeds-count" });
    } else if (sc2) {
      out.seedsPerBag = parseInt(sc2[1], 10) * 1000;
      out.matches.push({ field: "seedsPerBag", value: out.seedsPerBag, source: "seeds-M-notation" });
    } else if (sc3) {
      out.seedsPerBag = parseInt(sc3[1].replace(/,/g, ""), 10);
      out.matches.push({ field: "seedsPerBag", value: out.seedsPerBag, source: "count-ct" });
    }

    // ---- BAG WEIGHT ----
    // "50 LB", "50 LBS", "50 POUNDS", "22.7 KG" (convert)
    var w1 = flat.match(/(\d{2,3}(?:\.\d)?)\s*(?:LB|LBS|POUNDS?)\b/);
    var w2 = flat.match(/(\d{2,3}(?:\.\d)?)\s*KG\b/);
    if (w1) {
      out.bagWeightLbs = parseFloat(w1[1]);
      out.matches.push({ field: "bagWeightLbs", value: out.bagWeightLbs, source: "lbs" });
    } else if (w2) {
      out.bagWeightLbs = Math.round(parseFloat(w2[1]) * 2.20462 * 10) / 10;
      out.matches.push({ field: "bagWeightLbs", value: out.bagWeightLbs, source: "kg-converted" });
    }

    // ---- TREATMENT ----
    // Known treatment/coating names — we grab whichever ones appear, joined.
    var TREATMENTS = [
      "LUMIVIA CPL", "LUMIVIA", "LUMIGEN", "PONCHO/VOTIVO", "PONCHO", "VOTIVO",
      "CRUISER MAXX", "CRUISER", "MAXIM", "APRON", "ACCELERON",
      "GAUCHO", "NIPSIT", "TRILEX", "WARDEN", "EVERGOL",
      "B-360", "B-300", "PARTNER"
    ];
    var found = [];
    for (var t = 0; t < TREATMENTS.length; t++) {
      if (flat.indexOf(TREATMENTS[t]) !== -1 && found.indexOf(TREATMENTS[t]) === -1) {
        found.push(TREATMENTS[t]);
      }
    }
    if (found.length) {
      out.treatment = found.join(" + ");
      out.matches.push({ field: "treatment", value: out.treatment, source: "known-treatments" });
    }

    // ---- CROP fallback if variety didn't set it ----
    if (!out.crop) {
      if (/\bSOYBEAN|SOY\b/.test(flat)) out.crop = "Soybean";
      else if (/\bWHEAT\b/.test(flat)) out.crop = "Wheat";
      else if (/\bCORN|MAIZE\b/.test(flat)) out.crop = "Corn";
      else if (/\bSORGHUM|MILO\b/.test(flat)) out.crop = "Sorghum";
      else if (/\bSUNFLOWER\b/.test(flat)) out.crop = "Sunflower";
    }

    return out;
  }

  // ----------------------------------------------------------
  // GEO — pull a quick, best-effort lat/lon so we know where the bag
  // was scanned (grain elevator vs. the farm shed).
  // ----------------------------------------------------------
  function getFixOnce() {
    return new Promise(function (resolve) {
      if (!navigator.geolocation) return resolve(null);
      var settled = false;
      var timer = setTimeout(function () {
        if (settled) return;
        settled = true;
        resolve(null);
      }, 3000);
      navigator.geolocation.getCurrentPosition(function (pos) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ lat: pos.coords.latitude, lon: pos.coords.longitude });
      }, function () {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(null);
      }, { enableHighAccuracy: false, maximumAge: 60000, timeout: 3000 });
    });
  }

  // ----------------------------------------------------------
  // CARD UI (rendered under the Equipment Library card)
  // ----------------------------------------------------------
  function ensureCard() {
    if (byId("seedInvCard")) return;
    // Find the Equipment Library card by title text.
    var titles = document.querySelectorAll(".card .card-title");
    var eqCard = null;
    for (var i = 0; i < titles.length; i++) {
      if ((titles[i].textContent || "").trim().indexOf("Equipment Library") === 0) {
        eqCard = titles[i].closest(".card"); break;
      }
    }
    if (!eqCard || !eqCard.parentNode) return;   // Setup tab not present — bail quietly

    var card = h("div", { class: "card", id: "seedInvCard" }, [
      h("div", { class: "card-title" }, "🌱 Seed Inventory"),
      h("div", { class: "hint", id: "seedInvHint" },
        "Scan a seed tag with your camera or add a lot by hand. Bag counts auto-decrement when you save a planter report."),
      h("div", { class: "btn-row" }, [
        h("button", { id: "btnScanSeedTag", class: "btn btn-primary" }, "📷 Scan Seed Tag"),
        h("button", { id: "btnAddSeedLotManual", class: "btn" }, "➕ Add Lot Manually")
      ]),
      // Hidden inputs — one for camera capture, one for file fallback
      h("input", { type: "file", id: "seedTagCamera", accept: "image/*", capture: "environment", style: "display:none" }),
      h("div", { id: "seedInvList", class: "seed-inv-list" }),
      h("div", { class: "btn-row", style: "margin-top:8px" }, [
        h("button", { id: "btnExportSeedInvCSV", class: "btn" }, "📤 Export Inventory CSV")
      ])
    ]);
    eqCard.parentNode.insertBefore(card, eqCard.nextSibling);

    byId("btnScanSeedTag").addEventListener("click", function () { byId("seedTagCamera").click(); });
    byId("seedTagCamera").addEventListener("change", onCameraFile);
    byId("btnAddSeedLotManual").addEventListener("click", function () {
      dbg("👆 tap: Add Lot Manually");
      try {
        openReviewDialog(null, null, null, null);
        dbg("✓ openReviewDialog returned normally");
      } catch (err) {
        dbg("🚨 openReviewDialog threw", { message: err && err.message, stack: err && err.stack && String(err.stack).slice(0, 400) });
      }
    });
    byId("btnExportSeedInvCSV").addEventListener("click", exportInventoryCSV);

    renderList();
  }

  function renderList() {
    var host = byId("seedInvList");
    if (!host) return;
    var lib = loadInv();
    var ids = Object.keys(lib).filter(function (id) { return !lib[id]._deleted; });
    if (!ids.length) {
      host.innerHTML = '<div class="hint" style="padding:8px 0">No lots yet. Tap <b>Scan Seed Tag</b> to add your first one.</div>';
      return;
    }
    // Sort: crop, then variety, then lot
    ids.sort(function (a, b) {
      var A = lib[a], B = lib[b];
      var c = (A.crop || "").localeCompare(B.crop || "");
      if (c) return c;
      var v = (A.variety || "").localeCompare(B.variety || "");
      if (v) return v;
      return (A.lotNumber || "").localeCompare(B.lotNumber || "");
    });

    var html = "";
    ids.forEach(function (id) {
      var e = lib[id];
      var bags = (e.bagsOnHand != null ? e.bagsOnHand : e.originalBagCount) || 0;
      var orig = e.originalBagCount || bags || 0;
      var pct = orig > 0 ? Math.max(0, Math.min(100, Math.round((bags / orig) * 100))) : 0;
      var barColor = pct > 50 ? "var(--green)" : pct > 20 ? "var(--accent)" : "var(--red)";
      var subline = [
        e.lotNumber ? ("Lot " + escapeHtml(e.lotNumber)) : "No lot #",
        e.seedsPerBag ? (Number(e.seedsPerBag).toLocaleString() + " seeds/bag") : null,
        e.bagWeightLbs ? (e.bagWeightLbs + " lb/bag") : null,
        e.treatment ? escapeHtml(e.treatment) : null
      ].filter(Boolean).join(" · ");
      html += '<div class="seed-inv-row" data-id="' + id + '">' +
        '<div class="seed-inv-main">' +
          '<div class="seed-inv-title">' +
            '<span class="seed-inv-crop">' + escapeHtml(e.crop || "Seed") + '</span> ' +
            '<b>' + escapeHtml(e.variety || "(no variety)") + '</b>' +
          '</div>' +
          '<div class="seed-inv-sub">' + subline + '</div>' +
          '<div class="seed-inv-bar-wrap"><div class="seed-inv-bar" style="width:' + pct + '%;background:' + barColor + '"></div></div>' +
          '<div class="seed-inv-count">' +
            '<b>' + bags + '</b> / ' + orig + ' bags' +
            (e.acresRemaining != null ? ' · ~' + (+e.acresRemaining).toFixed(1) + ' ac left' : '') +
          '</div>' +
        '</div>' +
        '<div class="seed-inv-actions">' +
          '<button class="btn btn-ghost seed-inv-edit"  data-id="' + id + '">✏️</button>' +
          '<button class="btn btn-ghost seed-inv-photo" data-id="' + id + '">🖼️</button>' +
          '<button class="btn btn-ghost seed-inv-del"   data-id="' + id + '">🗑</button>' +
        '</div>' +
      '</div>';
    });
    host.innerHTML = html;

    host.querySelectorAll(".seed-inv-edit").forEach(function (b) {
      b.addEventListener("click", function () { editEntry(b.getAttribute("data-id")); });
    });
    host.querySelectorAll(".seed-inv-photo").forEach(function (b) {
      b.addEventListener("click", function () { showTagPhoto(b.getAttribute("data-id")); });
    });
    host.querySelectorAll(".seed-inv-del").forEach(function (b) {
      b.addEventListener("click", function () { deleteEntry(b.getAttribute("data-id")); });
    });
  }

  function editEntry(id) {
    var lib = loadInv();
    if (!lib[id]) return;
    openReviewDialog(null, null, null, lib[id]);
  }
  function deleteEntry(id) {
    var lib = loadInv();
    if (!lib[id]) return;
    var e = lib[id];
    var label = (e.variety || "(no variety)") + (e.lotNumber ? " · Lot " + e.lotNumber : "");
    var confirmFn = window.appConfirm || function (m, o) {
      return Promise.resolve(window.confirm(m));
    };
    confirmFn('Delete seed lot "' + label + '"?', { title: "Delete lot", okLabel: "Delete", danger: true })
      .then(function (ok) {
        if (!ok) return;
        var photoId = e.tagPhotoId;
        delete lib[id];
        saveInv(lib);
        tombstone(id);
        if (photoId) deletePhoto(photoId);
        renderList();
      });
  }
  function showTagPhoto(id) {
    var lib = loadInv();
    var e = lib[id];
    if (!e || !e.tagPhotoId) { toast("No photo saved for this lot.", "warn"); return; }
    getPhoto(e.tagPhotoId).then(function (dataUrl) {
      if (!dataUrl) { toast("Photo not found in local storage.", "warn"); return; }
      var dlg = ensureViewerDialog();
      dlg.querySelector(".seed-viewer-img").src = dataUrl;
      dlg.querySelector(".seed-viewer-caption").textContent =
        (e.variety || "(no variety)") + (e.lotNumber ? " · Lot " + e.lotNumber : "");
      openAnyDialog(dlg);
    });
  }

  // ----------------------------------------------------------
  // CAMERA / FILE HANDLER
  // ----------------------------------------------------------
  function onCameraFile(evt) {
    var file = evt.target.files && evt.target.files[0];
    evt.target.value = "";   // reset so the same file can be picked again
    if (!file) return;

    var scanning = openScanProgressDialog();

    fileToProcessed(file).then(function (imgs) {
      scanning.setStatus("Loading OCR engine…");
      return getFixOnce().then(function (fix) {
        return runOCR(imgs.ocrDataUrl, function (status, progress) {
          scanning.setStatus(status + " " + Math.round((progress || 0) * 100) + "%");
        }).then(function (ocr) {
          scanning.close();
          var parsed = parseTag(ocr.text);
          openReviewDialog(imgs.displayDataUrl, parsed, {
            rawText: ocr.text,
            confidence: ocr.confidence,
            fix: fix
          }, null);
        });
      });
    }).catch(function (err) {
      scanning.close();
      console.error("[SeedTag] scan failed:", err);
      var msg = /CDN|Tesseract|offline|blocked/i.test(err && err.message || "")
        ? "OCR engine couldn't load (offline or blocked). You can still add this lot by hand — the tag photo will be saved."
        : "Couldn't process this photo: " + (err && err.message || "unknown error");
      toast(msg, "warn");
      // Fall through: still let them save the photo manually.
      fileToProcessed(file).then(function (imgs) {
        openReviewDialog(imgs.displayDataUrl, null, { rawText: "", confidence: 0, fix: null }, null);
      }).catch(function () { /* nothing else to do */ });
    });
  }

  // ----------------------------------------------------------
  // SCAN-PROGRESS DIALOG
  // ----------------------------------------------------------
  function openScanProgressDialog() {
    var dlg = byId("seedScanDlg");
    if (!dlg) {
      dlg = h("dialog", { id: "seedScanDlg", class: "seed-dlg" }, [
        h("div", { class: "seed-dlg-body" }, [
          h("h3", null, "Reading seed tag…"),
          h("div", { id: "seedScanStatus", class: "hint" }, "Starting…"),
          h("div", { class: "seed-progress-wrap" }, h("div", { id: "seedScanBar", class: "seed-progress-bar" }))
        ])
      ]);
      document.body.appendChild(dlg);
    }
    openAnyDialog(dlg);
    var bar = byId("seedScanBar");
    return {
      setStatus: function (text) {
        var lbl = byId("seedScanStatus");
        if (lbl) lbl.textContent = text;
        // crude bar drive off the percentage in the text
        var m = /(\d+)\s*%/.exec(text || "");
        if (m && bar) bar.style.width = m[1] + "%";
      },
      close: function () { closeAnyDialog(dlg); }
    };
  }

  // ----------------------------------------------------------
  // REVIEW DIALOG (create/edit an inventory entry)
  //   photo:   dataURL of the tag (or null in manual mode)
  //   parsed:  parseTag() result (or null)
  //   ocrMeta: { rawText, confidence, fix } (or null)
  //   existing: an existing inventory entry to edit (or null)
  // ----------------------------------------------------------
  function openReviewDialog(photo, parsed, ocrMeta, existing) {
    dbg("openReviewDialog:start", { hasPhoto: !!photo, isEdit: !!existing });
    var isEdit = !!existing;
    var seed = existing || {};
    var p = parsed || {};
    var crop = seed.crop || p.crop || "Corn";
    var cropOpts = CROP_OPTIONS.map(function (c) {
      return '<option value="' + c + '"' + (c === crop ? " selected" : "") + ">" + c + "</option>";
    }).join("");

    var dlg = byId("seedReviewDlg");
    if (!dlg) {
      dbg("openReviewDialog:creating <dialog> element");
      dlg = h("dialog", { id: "seedReviewDlg", class: "seed-dlg" });
      document.body.appendChild(dlg);
      dbg("openReviewDialog:dialog appended", { inDom: !!document.getElementById("seedReviewDlg"), showModalType: typeof dlg.showModal });
    } else {
      dbg("openReviewDialog:reusing existing dialog", { open: dlg.open });
    }
    var confVal = ocrMeta && typeof ocrMeta.confidence === "number" ? Math.round(ocrMeta.confidence) : null;
    dlg.innerHTML =
      '<div class="seed-dlg-body">' +
        '<h3>' + (isEdit ? "Edit Seed Lot" : (photo ? "Review Scanned Tag" : "Add Seed Lot Manually")) + '</h3>' +
        (photo ? ('<div class="seed-review-photo"><img alt="tag" src="' + photo + '"/></div>') : '') +
        (confVal != null ? ('<div class="hint">OCR confidence: <b>' + confVal + '%</b>' +
          (confVal < 60 ? ' — review carefully.' : '') + '</div>') : '') +
        '<div class="seed-form-grid">' +
          '<label>Crop <select id="srCrop">' + cropOpts + '</select></label>' +
          '<label>Variety <input id="srVariety" type="text" value="' + escapeHtml(seed.variety || p.variety || "") + '" placeholder="e.g. P1197AM"/></label>' +
          '<label>Lot Number <input id="srLot" type="text" value="' + escapeHtml(seed.lotNumber || p.lotNumber || "") + '"/></label>' +
          '<label>Seeds / Bag <input id="srSeedsPerBag" type="number" min="0" step="1" value="' + (seed.seedsPerBag != null ? seed.seedsPerBag : (p.seedsPerBag != null ? p.seedsPerBag : "")) + '"/></label>' +
          '<label>Bag Weight (lb) <input id="srBagLbs" type="number" min="0" step="0.1" value="' + (seed.bagWeightLbs != null ? seed.bagWeightLbs : (p.bagWeightLbs != null ? p.bagWeightLbs : "")) + '"/></label>' +
          '<label>Treatment <input id="srTreatment" type="text" value="' + escapeHtml(seed.treatment || p.treatment || "") + '"/></label>' +
          '<label>Bags on Hand <input id="srBags" type="number" min="0" step="1" value="' + (seed.bagsOnHand != null ? seed.bagsOnHand : "") + '" placeholder="e.g. 40"/></label>' +
          '<label>Notes <input id="srNotes" type="text" value="' + escapeHtml(seed.notes || "") + '"/></label>' +
        '</div>' +
        (ocrMeta && ocrMeta.rawText ? ('<details class="seed-raw"><summary>OCR raw text</summary><pre>' + escapeHtml(ocrMeta.rawText) + '</pre></details>') : '') +
        '<div class="btn-row seed-dlg-actions">' +
          '<button id="srCancel" class="btn">Cancel</button>' +
          '<button id="srSave" class="btn btn-primary">' + (isEdit ? "Save Changes" : "Save Lot") + '</button>' +
        '</div>' +
      '</div>';

    dbg("openReviewDialog:calling openAnyDialog");
    openAnyDialog(dlg);
    dbg("openReviewDialog:openAnyDialog returned", { hasOpenAttr: dlg.hasAttribute("open"), dlgOpen: dlg.open, computedDisplay: getComputedStyle(dlg).display, computedVisibility: getComputedStyle(dlg).visibility });

    byId("srCancel").addEventListener("click", function () { closeAnyDialog(dlg); });
    byId("srSave").addEventListener("click", function () {
      var crop     = byId("srCrop").value;
      var variety  = (byId("srVariety").value || "").trim();
      var lotNumber= (byId("srLot").value || "").trim();
      var seedsPerBag  = parseInt(byId("srSeedsPerBag").value, 10);
      var bagWeightLbs = parseFloat(byId("srBagLbs").value);
      var treatment = (byId("srTreatment").value || "").trim();
      var bags     = parseInt(byId("srBags").value, 10);
      var notes    = (byId("srNotes").value || "").trim();

      if (!variety && !lotNumber) {
        toast("Enter at least a variety or a lot number.", "warn");
        return;
      }
      if (isNaN(bags) || bags < 0) bags = 0;

      var lib = loadInv();
      var id = existing ? existing.id : newId("seed");
      var entry = {
        id: id,
        crop: crop,
        variety: variety,
        lotNumber: lotNumber,
        seedsPerBag: isNaN(seedsPerBag) ? null : seedsPerBag,
        bagWeightLbs: isNaN(bagWeightLbs) ? null : bagWeightLbs,
        treatment: treatment,
        bagsOnHand: bags,
        originalBagCount: existing ? (existing.originalBagCount || bags) : bags,
        acresRemaining: existing ? existing.acresRemaining : null,
        tagPhotoId: existing ? existing.tagPhotoId : null,
        ocrRawText: existing ? existing.ocrRawText : (ocrMeta && ocrMeta.rawText) || "",
        ocrConfidence: existing ? existing.ocrConfidence : (ocrMeta && ocrMeta.confidence) || 0,
        scannedAt: existing ? existing.scannedAt : new Date().toISOString(),
        scannedLat: existing ? existing.scannedLat : (ocrMeta && ocrMeta.fix ? ocrMeta.fix.lat : null),
        scannedLon: existing ? existing.scannedLon : (ocrMeta && ocrMeta.fix ? ocrMeta.fix.lon : null),
        notes: notes,
        _updated: nowMs(),
        _deleted: false
      };

      // Handle photo storage
      var photoPromise = Promise.resolve();
      if (photo && !existing) {
        var photoId = newId("tag");
        entry.tagPhotoId = photoId;
        photoPromise = putPhoto(photoId, photo).catch(function (err) {
          console.warn("[SeedTag] photo save failed:", err);
          // Keep the entry anyway; just no photo
          entry.tagPhotoId = null;
        });
      }

      photoPromise.then(function () {
        lib[id] = entry;
        saveInv(lib);
        closeAnyDialog(dlg);
        renderList();
        refreshPlanterDropdown();
        toast(isEdit ? "Lot updated." : "Seed lot saved.", "ok");
      });
    });
  }

  // ----------------------------------------------------------
  // TAG-PHOTO VIEWER DIALOG
  // ----------------------------------------------------------
  function ensureViewerDialog() {
    var dlg = byId("seedViewerDlg");
    if (dlg) return dlg;
    dlg = h("dialog", { id: "seedViewerDlg", class: "seed-dlg" }, [
      h("div", { class: "seed-dlg-body" }, [
        h("h3", null, "Tag Photo"),
        h("div", { class: "seed-viewer-caption hint" }, ""),
        h("div", { class: "seed-review-photo" }, h("img", { class: "seed-viewer-img", alt: "tag photo" })),
        h("div", { class: "btn-row seed-dlg-actions" },
          h("button", { class: "btn", onclick: function () { closeAnyDialog(dlg); } }, "Close"))
      ])
    ]);
    document.body.appendChild(dlg);
    return dlg;
  }

  // ----------------------------------------------------------
  // DIALOG HELPERS — use native <dialog>.showModal() first, then
  // fall back to a CSS-overlay shim if the browser doesn't support
  // <dialog>. NOTE: we DO NOT call app.js's openDlg/closeDlg here
  // because those work on a different overlay pattern (hidden-class
  // toggles on a <div>) and are shaped for string IDs, not <dialog>
  // elements. Trying to use them here just silently no-ops.
  // ----------------------------------------------------------
  function openAnyDialog(dlg) {
    if (!dlg) { dbg("openAnyDialog:null dlg"); return; }
    // First choice: native <dialog>.showModal() — modern Chrome / Safari / Firefox / WebView
    if (typeof dlg.showModal === "function") {
      dbg("openAnyDialog:trying showModal", { alreadyOpen: dlg.open });
      try {
        if (!dlg.open) dlg.showModal();
        dbg("openAnyDialog:showModal succeeded", { open: dlg.open });
        return;
      } catch (e) {
        // showModal() throws if dlg isn't in the DOM yet, or on old iOS — fall through
        dbg("openAnyDialog:showModal threw — falling back", { message: e && e.message });
        console.warn("[SeedTag] showModal failed, falling back to overlay:", e);
      }
    } else {
      dbg("openAnyDialog:no showModal available — using shim");
    }
    // Fallback: CSS overlay. Force-visible via inline styles so we don't depend on the
    // browser's default <dialog> stylesheet (which some old WebViews get wrong).
    dlg.setAttribute("open", "");
    dlg.style.display        = "block";
    dlg.style.position       = "fixed";
    dlg.style.top            = "50%";
    dlg.style.left           = "50%";
    dlg.style.transform      = "translate(-50%, -50%)";
    dlg.style.zIndex         = "10000";
    dlg.style.margin         = "0";
    dlg.style.maxHeight      = "90vh";
    dlg.style.overflow       = "auto";
    // Add a backdrop <div> since ::backdrop only works with the native dialog
    var backdrop = document.getElementById("seedDlgBackdrop");
    if (!backdrop) {
      backdrop = document.createElement("div");
      backdrop.id = "seedDlgBackdrop";
      backdrop.style.cssText =
        "position:fixed;inset:0;background:rgba(0,0,0,0.45);z-index:9999;";
      document.body.appendChild(backdrop);
    } else {
      backdrop.style.display = "block";
    }
    dlg.dataset.shimmed = "1";
    dbg("openAnyDialog:shim applied", { hasOpen: dlg.hasAttribute("open"), display: dlg.style.display });
  }
  function closeAnyDialog(dlg) {
    if (!dlg) return;
    // Native path
    if (typeof dlg.close === "function" && dlg.open && dlg.dataset.shimmed !== "1") {
      try { dlg.close(); return; } catch (e) {}
    }
    // Shim path
    dlg.removeAttribute("open");
    dlg.style.display = "none";
    delete dlg.dataset.shimmed;
    var backdrop = document.getElementById("seedDlgBackdrop");
    if (backdrop) backdrop.style.display = "none";
  }

  // ----------------------------------------------------------
  // PLANTER DROPDOWN INTEGRATION
  // ----------------------------------------------------------
  // Replace the plain #plVariety text input with a picker + text.
  // Called on tab-setup init and every time the inventory changes.
  function ensurePlanterPicker() {
    var host = byId("plVariety");
    if (!host) return;
    // Already installed?
    if (host.dataset.seedPickerInstalled === "1") { refreshPlanterDropdown(); return; }

    // Wrap the existing input so we can prepend a select in the same label.
    var label = host.closest("label");
    if (!label) return;

    var pickerWrap = h("div", { class: "seed-picker-wrap", id: "plVarietyPickerWrap" }, [
      h("select", { id: "plVarietyPicker", class: "seed-picker" }, []),
      h("div", { class: "hint seed-picker-hint", id: "plVarietyPickerHint" }, "")
    ]);
    label.insertBefore(pickerWrap, host);
    host.dataset.seedPickerInstalled = "1";
    host.placeholder = "Type variety manually";

    var picker = byId("plVarietyPicker");
    picker.addEventListener("change", function () {
      var val = picker.value;
      if (!val) { host.value = ""; updatePickerHint(""); return; }
      var lib = loadInv();
      var e = lib[val];
      if (!e) return;
      host.value = e.variety || "";
      // Stash the chosen lot ID on the input so the equipment save handler can grab it.
      host.dataset.seedLotId = val;
      updatePickerHint(val);
    });
    host.addEventListener("input", function () {
      // If the user types manually, unlink from any selected lot.
      delete host.dataset.seedLotId;
      picker.value = "";
      updatePickerHint("");
    });

    refreshPlanterDropdown();
  }
  function updatePickerHint(id) {
    var hint = byId("plVarietyPickerHint");
    if (!hint) return;
    if (!id) { hint.textContent = ""; return; }
    var lib = loadInv();
    var e = lib[id];
    if (!e) { hint.textContent = ""; return; }
    var bags = (e.bagsOnHand != null ? e.bagsOnHand : e.originalBagCount) || 0;
    var parts = [e.lotNumber ? "Lot " + e.lotNumber : "no lot #"];
    if (e.seedsPerBag) parts.push(Number(e.seedsPerBag).toLocaleString() + " seeds/bag");
    parts.push(bags + " bags left");
    hint.textContent = "Selected: " + parts.join(" · ");
  }
  function refreshPlanterDropdown() {
    var picker = byId("plVarietyPicker");
    if (!picker) return;
    var lib = loadInv();
    var ids = Object.keys(lib).filter(function (id) {
      var e = lib[id];
      return !e._deleted && (e.bagsOnHand == null || e.bagsOnHand > 0);
    });
    // Group by crop
    var byCrop = {};
    ids.forEach(function (id) {
      var e = lib[id];
      var c = e.crop || "Other";
      (byCrop[c] = byCrop[c] || []).push(id);
    });
    var cropsInOrder = Object.keys(byCrop).sort();
    var html = '<option value="">— Pick from inventory (or type below) —</option>';
    cropsInOrder.forEach(function (c) {
      html += '<optgroup label="' + escapeHtml(c) + '">';
      byCrop[c].sort(function (a, b) {
        return (lib[a].variety || "").localeCompare(lib[b].variety || "");
      }).forEach(function (id) {
        var e = lib[id];
        var bags = (e.bagsOnHand != null ? e.bagsOnHand : e.originalBagCount) || 0;
        var label = (e.variety || "(no variety)") +
          (e.lotNumber ? " · " + e.lotNumber : "") +
          " · " + bags + " bags";
        html += '<option value="' + id + '">' + escapeHtml(label) + '</option>';
      });
      html += '</optgroup>';
    });
    picker.innerHTML = html;

    // Re-select current lot if the input was set by an earlier pick
    var input = byId("plVariety");
    if (input && input.dataset.seedLotId && lib[input.dataset.seedLotId]) {
      picker.value = input.dataset.seedLotId;
      updatePickerHint(picker.value);
    }
  }

  // ----------------------------------------------------------
  // AUTO-DECREMENT ON REPORT SAVE
  // Called from a one-line hook in app.js's Save Report handler.
  // Given a saved report, if it's a planter session, find the linked
  // lot and subtract the seed used. Never goes negative.
  // ----------------------------------------------------------
  function decrementAfterReport(rep) {
    try {
      if (!rep || !rep.equipment || rep.equipment.type !== "planter") return;
      var planter = (rep.equipment && rep.equipment) || {};
      // The lot ID lives on state.planter._seedLotId (see hook).
      var lotId = (rep.planter && rep.planter._seedLotId)
        || (window.state && window.state.planter && window.state.planter._seedLotId)
        || null;
      if (!lotId) return;
      var lib = loadInv();
      var e = lib[lotId];
      if (!e) return;

      var acres = +rep.acres || 0;
      var pop = +(rep.planter && rep.planter.population)
        || +(window.state && window.state.planter && window.state.planter.population)
        || 0;
      if (!acres || !pop || !e.seedsPerBag || e.seedsPerBag <= 0) {
        // Not enough info to auto-decrement — leave a breadcrumb for the user
        toast("Planter report saved, but couldn't auto-decrement (missing acres, population, or seeds/bag).", "warn");
        return;
      }
      var totalSeeds = acres * pop;
      var bagsUsedRaw = totalSeeds / e.seedsPerBag;
      var bagsUsed = Math.ceil(bagsUsedRaw * 10) / 10;   // 0.1-bag precision
      var newCount = Math.max(0, (e.bagsOnHand || 0) - bagsUsed);
      // Track acresRemaining too, in case seeds/bag is missing later
      var newAcresRem = null;
      if (newCount > 0 && pop > 0 && e.seedsPerBag) {
        newAcresRem = (newCount * e.seedsPerBag) / pop;
      } else if (newCount === 0) {
        newAcresRem = 0;
      }
      e.bagsOnHand = +newCount.toFixed(1);
      e.acresRemaining = newAcresRem != null ? +newAcresRem.toFixed(2) : null;
      e._updated = nowMs();
      lib[lotId] = e;
      saveInv(lib);
      renderList();
      refreshPlanterDropdown();

      var label = (e.variety || "(no variety)") + (e.lotNumber ? " · " + e.lotNumber : "");
      toast("Decremented " + bagsUsed.toFixed(1) + " bags from " + label + " (" + e.bagsOnHand.toFixed(1) + " left)", "ok");
    } catch (err) {
      console.warn("[SeedTag] decrementAfterReport failed:", err);
    }
  }

  // ----------------------------------------------------------
  // CSV EXPORT
  // ----------------------------------------------------------
  function exportInventoryCSV() {
    var lib = loadInv();
    var rows = [[
      "Crop", "Variety", "Lot Number", "Seeds/Bag", "Bag Weight (lb)",
      "Treatment", "Bags on Hand", "Original Bags", "Acres Remaining",
      "Scanned At", "OCR Confidence", "Notes"
    ]];
    Object.keys(lib).forEach(function (id) {
      var e = lib[id];
      if (e._deleted) return;
      rows.push([
        e.crop || "", e.variety || "", e.lotNumber || "",
        e.seedsPerBag != null ? e.seedsPerBag : "",
        e.bagWeightLbs != null ? e.bagWeightLbs : "",
        e.treatment || "",
        e.bagsOnHand != null ? e.bagsOnHand : "",
        e.originalBagCount != null ? e.originalBagCount : "",
        e.acresRemaining != null ? e.acresRemaining : "",
        e.scannedAt || "",
        e.ocrConfidence != null ? e.ocrConfidence : "",
        e.notes || ""
      ]);
    });
    if (rows.length === 1) { toast("No lots to export yet.", "warn"); return; }
    var csv = rows.map(function (r) {
      return r.map(function (c) {
        var s = String(c == null ? "" : c);
        return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
      }).join(",");
    }).join("\r\n");
    var ts = new Date().toISOString().slice(0, 10);
    if (typeof window.downloadFile === "function") {
      window.downloadFile("DiamondO_SeedInventory_" + ts + ".csv", "\ufeff" + csv, "text/csv;charset=utf-8");
    } else {
      var blob = new Blob(["\ufeff" + csv], { type: "text/csv;charset=utf-8" });
      var url = URL.createObjectURL(blob);
      var a = document.createElement("a");
      a.href = url; a.download = "DiamondO_SeedInventory_" + ts + ".csv";
      document.body.appendChild(a); a.click();
      setTimeout(function () { URL.revokeObjectURL(url); a.remove(); }, 300);
    }
  }

  // ----------------------------------------------------------
  // INIT — wire up the card and the planter dropdown, then keep
  // them in sync as the user navigates.
  // ----------------------------------------------------------
  ready(function () {
    buildDebugPanel();   // no-op unless debug is turned on
    dbg("init:ready", { debugOn: _debugOn, ua: navigator.userAgent.slice(0, 80) });
    try {
      ensureCard();
      dbg("init:ensureCard done", { cardPresent: !!document.getElementById("seedInvCard"), btnPresent: !!document.getElementById("btnAddSeedLotManual") });
    } catch (err) {
      dbg("🚨 ensureCard threw", { message: err && err.message });
    }
    // The planter fields live inside a modal that may not yet be in the DOM at load,
    // so try now, then retry on any tab click and on any modal open.
    ensurePlanterPicker();

    document.addEventListener("click", function (e) {
      // Cheap heuristic: any click that plausibly opened the equipment modal.
      var t = e.target;
      if (!t) return;
      var id = t.id || "";
      if (id === "btnEditEqParams" || t.closest && t.closest("#btnEditEqParams")) {
        setTimeout(ensurePlanterPicker, 50);
      }
    });

    // If the inventory changes elsewhere (sync, import), refresh UI.
    window.addEventListener("seedinv:change", function () {
      renderList();
      refreshPlanterDropdown();
    });

    // Also refresh when the Setup tab becomes visible (defensive).
    document.querySelectorAll(".tab").forEach(function (tab) {
      tab.addEventListener("click", function () {
        setTimeout(function () {
          ensureCard();
          renderList();
          ensurePlanterPicker();
        }, 60);
      });
    });
  });

  // ----------------------------------------------------------
  // PUBLIC API
  // ----------------------------------------------------------
  window.SeedTag = {
    // Called by the app.js hook in the Save Report handler
    decrementAfterReport: decrementAfterReport,
    // Called by the app.js hook in setEquipmentFromInputs (planter branch)
    // to stash the selected lot ID on state.planter
    captureSelectedLot: function () {
      var input = byId("plVariety");
      if (!input) return null;
      return input.dataset.seedLotId || null;
    },
    // Utilities you might want to call from the console:
    refresh: function () { renderList(); refreshPlanterDropdown(); },
    loadAll: loadInv,
    parseTag: parseTag
  };
})();
