// ============================================================
// OπO Farming — MAP EXPORT (self-contained) — build-29
// ------------------------------------------------------------
// Adds a 📸 Capture Map button on the Operate screen AND a
// 📸/🔄 Re-capture Map button on the Reports screen, and injects
// the captured map image + OπO logo header into the existing
// Report PDF flow. Fully additive: no changes to app.js state,
// no edits to existing tabs. We monkey-patch the Save Report
// persistence to carry the image, and the PDF HTML builder to
// render it.
//
// Depends only on globals app.js already defines:
//   state, $, $id, appAlert, showToast
//
// --- build-29 additions ---
//   • Re-capture Map from the Reports tab — rebuilds the Static
//     Map from the report's saved coveragePaths + boundaryPath
//     (persisted on every save as of build-29). Reports saved
//     before build-29 won't have these fields, so their
//     Re-capture button is disabled with a tooltip explaining why.
//   • Customer / operator pre-fill on the signature block —
//     operator name is prompted once and stored at
//     dof_operator_name; customer is the field's farmName (or
//     name) at capture time. Pen-signature line stays blank.
//   • html2canvas fallback — if the Static Maps URL can't fit
//     under Google's ~8 K char limit even after Douglas-Peucker
//     simplification, we lazy-load html2canvas@1.4.1 from
//     jsDelivr and screenshot the live Google Map div.
//
// Titles are chosen by equipment.type:
//   planter / drill → "As-Planted Map"
//   combine         → "As-Harvested Map"
//   sprayer         → "As-Applied Map"
//   everything else → "Coverage Map"
// ============================================================
(function () {
  "use strict";

  // ----------------------------------------------------------
  // CONSTANTS
  // ----------------------------------------------------------
  var LOGO_URL         = "opio-logo.png";
  var STATIC_MAP_BASE  = "https://maps.googleapis.com/maps/api/staticmap";
  var STATIC_MAP_SIZE  = "640x640";          // free tier max
  var STATIC_MAP_SCALE = 2;                   // retina — doubles effective resolution
  var URL_LIMIT        = 8000;                // Google says 8192; stay under
  var COVERAGE_COLOR   = "0x2ecc71";          // matches the live map paint
  var COVERAGE_FILL    = "0x2ecc7188";        // 0x88 alpha
  var BOUNDARY_COLOR   = "0xe89400";          // amber accent
  var BOUNDARY_WEIGHT  = 3;
  var H2C_CDN          = "https://cdn.jsdelivr.net/npm/html2canvas@1.4.1/dist/html2canvas.min.js";
  var LS_OPERATOR_KEY  = "dof_operator_name";
  var LS_REPS_KEY      = "dof_reports";

  function byId(id) { return document.getElementById(id); }
  function ready(fn) {
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", fn);
    else fn();
  }

  // ----------------------------------------------------------
  // TITLE PICKER — by equipment type
  // ----------------------------------------------------------
  function mapTitleFor(eqType) {
    switch ((eqType || "").toLowerCase()) {
      case "planter":  return "As-Planted Map";
      case "drill":    return "As-Planted Map";
      case "combine":  return "As-Harvested Map";
      case "sprayer":  return "As-Applied Map";
      default:         return "Coverage Map";
    }
  }

  // ----------------------------------------------------------
  // OPERATOR NAME — prompt once, persist in localStorage
  // ----------------------------------------------------------
  function getOperatorName() {
    try { return localStorage.getItem(LS_OPERATOR_KEY) || ""; }
    catch (e) { return ""; }
  }
  function setOperatorName(name) {
    try { localStorage.setItem(LS_OPERATOR_KEY, name || ""); } catch (e) {}
  }
  function ensureOperatorName() {
    var cur = getOperatorName();
    if (cur) return Promise.resolve(cur);
    return new Promise(function (resolve) {
      promptOperator(function (name) {
        if (name) setOperatorName(name);
        resolve(name || "");
      });
    });
  }
  function promptOperator(cb) {
    var old = byId("mapexpOpPrompt");
    if (old) old.remove();
    var d = document.createElement("div");
    d.id = "mapexpOpPrompt";
    d.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,0.6);display:flex;align-items:center;justify-content:center;z-index:10000;padding:16px;";
    d.innerHTML =
      "<div style='background:var(--panel,#fffdf7);color:var(--text,#2a2620);border:1px solid var(--border,#d6cdb8);border-radius:12px;max-width:420px;width:100%;padding:16px;'>" +
        "<div style='font-weight:700;margin-bottom:8px;'>Operator name</div>" +
        "<div style='font-size:0.9rem;color:var(--muted,#6b6557);margin-bottom:10px;'>Shown on customer-facing PDFs. You can change this later from a browser console with <code>localStorage.setItem('dof_operator_name','...')</code>.</div>" +
        "<input id='mapexpOpInput' type='text' placeholder='e.g. Mike Otto' style='width:100%;padding:8px 10px;border:1px solid var(--border,#d6cdb8);border-radius:8px;background:var(--panel-2,#ece5d3);color:var(--text,#2a2620);font-size:1rem;' />" +
        "<div style='display:flex;gap:8px;justify-content:flex-end;margin-top:12px;'>" +
          "<button id='mapexpOpSkip' style='padding:8px 14px;border:1px solid var(--border,#d6cdb8);background:var(--panel-2,#ece5d3);color:var(--text,#2a2620);border-radius:8px;cursor:pointer;'>Skip</button>" +
          "<button id='mapexpOpSave' style='padding:8px 14px;border:none;background:var(--green,#2e9e57);color:#fff;border-radius:8px;cursor:pointer;font-weight:600;'>Save</button>" +
        "</div>" +
      "</div>";
    document.body.appendChild(d);
    var input = byId("mapexpOpInput");
    if (input) setTimeout(function () { input.focus(); }, 50);
    function finish(name) { d.remove(); cb(name); }
    byId("mapexpOpSkip").onclick = function () { finish(""); };
    byId("mapexpOpSave").onclick = function () {
      finish((input && input.value || "").trim());
    };
    if (input) {
      input.addEventListener("keydown", function (e) {
        if (e.key === "Enter") finish((input.value || "").trim());
      });
    }
  }

  // ----------------------------------------------------------
  // STATIC MAPS URL BUILDER — takes a {coveragePaths, boundaryPath}
  // bundle rather than reading globals, so it works for both live
  // sessions and re-capture from saved reports.
  // ----------------------------------------------------------
  function buildStaticMapUrl(bundle, simplifyTolerance) {
    var key = window.GOOGLE_MAPS_API_KEY;
    if (!key) return null;
    if (!bundle || !bundle.coveragePaths || !bundle.coveragePaths.length) return null;

    var params = [
      "size=" + STATIC_MAP_SIZE,
      "scale=" + STATIC_MAP_SCALE,
      "maptype=satellite",
      "key=" + encodeURIComponent(key)
    ];

    // Boundary (optional)
    var bnd = bundle.boundaryPath || [];
    if (bnd.length >= 3) {
      var bndPts = simplifyTolerance > 0 ? dpSimplify(bnd, simplifyTolerance) : bnd;
      params.push(
        "path=color:" + BOUNDARY_COLOR +
        "|weight:" + BOUNDARY_WEIGHT +
        "|" + bndPts.map(function (p) {
          return p.lat.toFixed(6) + "," + p.lng.toFixed(6);
        }).join("|") +
        "|" + bndPts[0].lat.toFixed(6) + "," + bndPts[0].lng.toFixed(6)
      );
    }

    // Coverage polys
    for (var i = 0; i < bundle.coveragePaths.length; i++) {
      var pts = bundle.coveragePaths[i];
      if (!pts || pts.length < 2) continue;
      if (simplifyTolerance > 0) pts = dpSimplify(pts, simplifyTolerance);
      params.push(
        "path=color:" + COVERAGE_COLOR +
        "|weight:1" +
        "|fillcolor:" + COVERAGE_FILL +
        "|" + pts.map(function (p) {
          return p.lat.toFixed(6) + "," + p.lng.toFixed(6);
        }).join("|")
      );
    }

    return STATIC_MAP_BASE + "?" + params.join("&");
  }

  // Build a bundle from live session state (for the Operate button).
  function bundleFromLiveState() {
    var polys = (state.coveragePolys || []).filter(function (p) {
      return p && typeof p.getPath === "function";
    });
    var coveragePaths = polys.map(function (p) {
      var out = [];
      var path = p.getPath();
      for (var i = 0; i < path.getLength(); i++) {
        var ll = path.getAt(i);
        out.push({ lat: ll.lat(), lng: ll.lng() });
      }
      return out;
    });
    var boundaryPath = (state.boundary && state.boundary.points && state.boundary.points.length >= 3)
      ? state.boundary.points.slice() : null;
    return { coveragePaths: coveragePaths, boundaryPath: boundaryPath };
  }

  // Build a bundle from a saved report (for Re-capture).
  function bundleFromReport(rep) {
    if (!rep) return null;
    var cp = rep.coveragePaths;
    var bp = rep.boundaryPath;
    if (!cp || !cp.length) return null;
    return { coveragePaths: cp, boundaryPath: bp || null };
  }

  // Douglas-Peucker polyline simplification. Operates on {lat,lng} in
  // degrees; tolerance is also in degrees (small values like 0.00001).
  function dpSimplify(points, tolerance) {
    if (!points || points.length < 3) return points;
    function pdist(p, a, b) {
      var dx = b.lng - a.lng, dy = b.lat - a.lat;
      if (dx === 0 && dy === 0) {
        return Math.sqrt(Math.pow(p.lng - a.lng, 2) + Math.pow(p.lat - a.lat, 2));
      }
      var t = ((p.lng - a.lng) * dx + (p.lat - a.lat) * dy) / (dx * dx + dy * dy);
      t = Math.max(0, Math.min(1, t));
      var projX = a.lng + t * dx;
      var projY = a.lat + t * dy;
      return Math.sqrt(Math.pow(p.lng - projX, 2) + Math.pow(p.lat - projY, 2));
    }
    function run(start, end, keep) {
      var maxD = 0, idx = -1;
      for (var i = start + 1; i < end; i++) {
        var d = pdist(points[i], points[start], points[end]);
        if (d > maxD) { maxD = d; idx = i; }
      }
      if (maxD > tolerance && idx !== -1) {
        run(start, idx, keep);
        run(idx, end, keep);
      } else {
        keep.push(end);
      }
    }
    var keep = [0];
    run(0, points.length - 1, keep);
    return keep.sort(function (a, b) { return a - b; }).map(function (i) { return points[i]; });
  }

  // Build the smallest URL that fits under URL_LIMIT by progressively
  // simplifying. Returns the URL or null if even full simplification
  // can't fit — in which case the caller falls through to html2canvas.
  function buildFittingStaticMapUrl(bundle) {
    var tolerances = [0, 0.00001, 0.00003, 0.00008, 0.0002, 0.0005];
    for (var i = 0; i < tolerances.length; i++) {
      var url = buildStaticMapUrl(bundle, tolerances[i]);
      if (!url) return null;
      if (url.length <= URL_LIMIT) {
        if (i > 0) {
          try {
            console.log("[mapexport] simplified polys with tolerance " +
              tolerances[i] + " to fit static-map URL (" + url.length + " chars)");
          } catch (e) {}
        }
        return url;
      }
    }
    try { console.warn("[mapexport] couldn't fit static-map URL under " + URL_LIMIT + " chars — falling back to html2canvas"); } catch (e) {}
    return null;
  }

  // Fetch an image URL and return it as a data URL (so it embeds in
  // the PDF and survives localStorage/sync).
  function fetchAsDataUrl(url) {
    return fetch(url, { mode: "cors" })
      .then(function (r) {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.blob();
      })
      .then(function (blob) {
        return new Promise(function (resolve, reject) {
          var fr = new FileReader();
          fr.onload = function () { resolve(fr.result); };
          fr.onerror = function () { reject(fr.error); };
          fr.readAsDataURL(blob);
        });
      });
  }

  // ----------------------------------------------------------
  // HTML2CANVAS FALLBACK — lazy-loaded, snapshots the live map div.
  // Only used when the Static Maps URL can't be made to fit.
  // Not usable for re-capture (there's no live map for a saved report).
  // ----------------------------------------------------------
  var _h2cPromise = null;
  function loadHtml2Canvas() {
    if (window.html2canvas) return Promise.resolve(window.html2canvas);
    if (_h2cPromise) return _h2cPromise;
    _h2cPromise = new Promise(function (resolve, reject) {
      var s = document.createElement("script");
      s.src = H2C_CDN;
      s.async = true;
      s.onload = function () {
        if (window.html2canvas) resolve(window.html2canvas);
        else reject(new Error("html2canvas failed to load"));
      };
      s.onerror = function () { reject(new Error("html2canvas script error")); };
      document.head.appendChild(s);
    });
    return _h2cPromise;
  }

  function snapshotLiveMap() {
    var mapDiv = byId("map") || document.querySelector(".map, #gmap, [data-map]");
    if (!mapDiv) return Promise.reject(new Error("No live map element found for html2canvas fallback."));
    return loadHtml2Canvas().then(function (h2c) {
      return h2c(mapDiv, {
        useCORS: true,
        allowTaint: false,
        backgroundColor: null,
        logging: false,
        scale: 2
      });
    }).then(function (canvas) {
      return canvas.toDataURL("image/png");
    });
  }

  // ----------------------------------------------------------
  // CAPTURE FLOWS — live-session and re-capture share the same tail.
  // ----------------------------------------------------------
  function captureMap() {
    if (!state || !state.running) {
      if (typeof appAlert === "function") appAlert("Start a session first.");
      return;
    }
    if (!state.coveragePolys || !state.coveragePolys.length) {
      if (typeof appAlert === "function") appAlert("No painted coverage yet — drive a bit first.");
      return;
    }
    ensureOperatorName().then(function () {
      runCapture(bundleFromLiveState(), /*liveMapFallbackOk=*/true)
        .then(function (dataUrl) {
          state.capturedMapImage = {
            dataUrl: dataUrl,
            capturedAt: new Date().toISOString(),
            title: mapTitleFor(state.equipment && state.equipment.type),
            customer: (state.field && (state.field.farmName || state.field.name)) || "",
            operator: getOperatorName() || ""
          };
          showPreviewDialog(dataUrl, { source: "live" });
        })
        .catch(function (err) {
          try { console.error("[mapexport] capture failed", err); } catch (e) {}
          if (typeof appAlert === "function") appAlert("Map capture failed: " + (err && err.message ? err.message : String(err)));
        });
    });
  }

  function recaptureFromReport(repId) {
    var reps = {};
    try { reps = JSON.parse(localStorage.getItem(LS_REPS_KEY) || "{}"); } catch (e) {}
    var rep = reps[repId];
    if (!rep) {
      if (typeof appAlert === "function") appAlert("Report not found.");
      return;
    }
    var bundle = bundleFromReport(rep);
    if (!bundle) {
      if (typeof appAlert === "function") appAlert(
        "This report was saved before build-29, so it has no coverage geometry on file. " +
        "New reports (saved from build-29 onward) can be re-captured any time."
      );
      return;
    }
    ensureOperatorName().then(function () {
      runCapture(bundle, /*liveMapFallbackOk=*/false)
        .then(function (dataUrl) {
          // Write the image onto the report and persist.
          rep.mapImage = {
            dataUrl: dataUrl,
            capturedAt: new Date().toISOString(),
            title: mapTitleFor(rep.equipment && rep.equipment.type),
            customer: (rep.field && (rep.field.farmName || rep.field.name)) || "",
            operator: getOperatorName() || ""
          };
          rep._modified = new Date().toISOString();
          reps[repId] = rep;
          try { localStorage.setItem(LS_REPS_KEY, JSON.stringify(reps)); }
          catch (e) {
            if (typeof appAlert === "function") appAlert("Couldn't save: " + (e && e.message ? e.message : String(e)));
            return;
          }
          if (typeof loadReportsList === "function") {
            try { loadReportsList(); } catch (e) {}
          }
          refreshRecaptureButton();
          showPreviewDialog(dataUrl, { source: "recapture", repName: rep.name });
        })
        .catch(function (err) {
          try { console.error("[mapexport] recapture failed", err); } catch (e) {}
          if (typeof appAlert === "function") appAlert("Map re-capture failed: " + (err && err.message ? err.message : String(err)));
        });
    });
  }

  // Common tail used by both captureMap and recaptureFromReport.
  // Resolves to a data URL. Tries Static Maps first; if the URL can't
  // fit and liveMapFallbackOk, falls through to html2canvas on the live map.
  function runCapture(bundle, liveMapFallbackOk) {
    showCapturingDialog();
    return new Promise(function (resolve, reject) {
      var url = buildFittingStaticMapUrl(bundle);
      if (url) {
        fetchAsDataUrl(url).then(function (dataUrl) {
          closeCapturingDialog();
          resolve(dataUrl);
        }).catch(function (err) {
          closeCapturingDialog();
          reject(err);
        });
        return;
      }
      // Static Maps couldn't fit — html2canvas fallback.
      if (!liveMapFallbackOk) {
        closeCapturingDialog();
        reject(new Error(
          "Saved coverage is too complex for a static snapshot, and the " +
          "html2canvas fallback needs a live session with the map visible. " +
          "Future build will handle this by rendering an offscreen map."
        ));
        return;
      }
      snapshotLiveMap().then(function (dataUrl) {
        closeCapturingDialog();
        resolve(dataUrl);
      }).catch(function (err) {
        closeCapturingDialog();
        reject(err);
      });
    });
  }

  // ----------------------------------------------------------
  // DIALOGS — kept dead-simple, no reliance on app.js's dialog system
  // ----------------------------------------------------------
  function showCapturingDialog() {
    var host = byId("mapexpBusy") || (function () {
      var d = document.createElement("div");
      d.id = "mapexpBusy";
      d.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,0.55);display:flex;align-items:center;justify-content:center;z-index:9999;color:#fff;font-size:1.1rem;";
      d.innerHTML = "<div style='background:#2a2620;padding:20px 28px;border-radius:12px;'>\ud83d\udcf8 Capturing map…</div>";
      document.body.appendChild(d);
      return d;
    })();
    host.style.display = "flex";
  }
  function closeCapturingDialog() {
    var host = byId("mapexpBusy");
    if (host) host.style.display = "none";
  }

  function showPreviewDialog(dataUrl, opts) {
    opts = opts || {};
    var old = byId("mapexpPreview");
    if (old) old.remove();
    var caption = opts.source === "recapture"
      ? "This map has been attached to <strong>" + escapeHtml(opts.repName || "the report") + "</strong>. Open the report and \"Export PDF\" to use it."
      : "This map will be embedded in the Report PDF when you Save Report \u2192 Print PDF.";
    var d = document.createElement("div");
    d.id = "mapexpPreview";
    d.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,0.65);display:flex;align-items:center;justify-content:center;z-index:9999;padding:16px;";
    d.innerHTML =
      "<div style='background:var(--panel,#fffdf7);color:var(--text,#2a2620);border:1px solid var(--border,#d6cdb8);border-radius:12px;max-width:720px;width:100%;max-height:92vh;display:flex;flex-direction:column;overflow:hidden;'>" +
        "<div style='padding:12px 16px;border-bottom:1px solid var(--border,#d6cdb8);display:flex;align-items:center;justify-content:space-between;'>" +
          "<strong>\ud83d\udcf8 Map Captured</strong>" +
          "<button id='mapexpClose' aria-label='Close' style='background:none;border:none;font-size:1.4rem;cursor:pointer;color:var(--muted,#6b6557);'>\u00d7</button>" +
        "</div>" +
        "<div style='padding:12px 16px;overflow:auto;'>" +
          "<p style='margin:0 0 10px 0;color:var(--muted,#6b6557);font-size:0.9rem;'>" + caption + "</p>" +
          "<img src='" + dataUrl + "' alt='Captured map' style='max-width:100%;border-radius:8px;border:1px solid var(--border,#d6cdb8);' />" +
        "</div>" +
        "<div style='padding:12px 16px;border-top:1px solid var(--border,#d6cdb8);display:flex;gap:8px;justify-content:flex-end;'>" +
          (opts.source === "recapture"
            ? "<button id='mapexpKeep' style='padding:8px 14px;border:none;background:var(--green,#2e9e57);color:#fff;border-radius:8px;cursor:pointer;font-weight:600;'>Done</button>"
            : "<button id='mapexpRetake' style='padding:8px 14px;border:1px solid var(--border,#d6cdb8);background:var(--panel-2,#ece5d3);color:var(--text,#2a2620);border-radius:8px;cursor:pointer;'>Retake</button>" +
              "<button id='mapexpKeep' style='padding:8px 14px;border:none;background:var(--green,#2e9e57);color:#fff;border-radius:8px;cursor:pointer;font-weight:600;'>Keep</button>") +
        "</div>" +
      "</div>";
    document.body.appendChild(d);

    function close() { d.remove(); }
    byId("mapexpClose").onclick = close;
    byId("mapexpKeep").onclick = function () {
      close();
      if (typeof showToast === "function") {
        showToast(opts.source === "recapture" ? "Map saved to report" : "Map saved to this session", { kind: "ok" });
      }
    };
    var retake = byId("mapexpRetake");
    if (retake) {
      retake.onclick = function () {
        state.capturedMapImage = null;
        close();
        captureMap();
      };
    }
  }

  // ----------------------------------------------------------
  // BUTTON INJECTION — Operate screen (capture) + Reports screen (recapture)
  // ----------------------------------------------------------
  function injectCaptureButton() {
    if (byId("btnCaptureMap")) return;

    // Prefer sitting next to the Start/Stop pair.
    var stop = byId("btnStop");
    var start = byId("btnStart");
    var anchor = stop || start;
    if (!anchor || !anchor.parentNode) {
      // Fallback: pin to the Operate tab panel's header area
      var op = byId("tab-operate");
      if (!op) return;
      anchor = op.firstElementChild;
      if (!anchor) return;
    }

    var btn = document.createElement("button");
    btn.id = "btnCaptureMap";
    btn.type = "button";
    btn.textContent = "\ud83d\udcf8 Capture Map";
    btn.style.cssText =
      "margin-left:6px;padding:8px 14px;border:1px solid var(--border,#d6cdb8);" +
      "background:var(--panel-2,#ece5d3);color:var(--text,#2a2620);border-radius:8px;" +
      "cursor:pointer;font-weight:600;";
    btn.addEventListener("click", captureMap);

    if (anchor === stop || anchor === start) {
      anchor.parentNode.insertBefore(btn, anchor.nextSibling);
    } else {
      anchor.appendChild(btn);
    }
  }

  function injectRecaptureButton() {
    if (byId("btnRecaptureMap")) return;
    var pdfBtn = byId("btnPdfRep");
    if (!pdfBtn || !pdfBtn.parentNode) {
      // Try again shortly — the Reports tab markup may render late.
      setTimeout(injectRecaptureButton, 400);
      return;
    }
    var btn = document.createElement("button");
    btn.id = "btnRecaptureMap";
    btn.type = "button";
    btn.className = "btn";
    btn.textContent = "\ud83d\udcf8 Capture Map";
    btn.addEventListener("click", onRecaptureClick);
    pdfBtn.parentNode.insertBefore(btn, pdfBtn.nextSibling);

    // Keep the label in sync with the currently selected report.
    var sel = byId("repSelect");
    if (sel) {
      sel.addEventListener("change", refreshRecaptureButton);
      sel.addEventListener("input", refreshRecaptureButton);
    }
    refreshRecaptureButton();
  }

  function selectedReport() {
    var sel = byId("repSelect");
    if (!sel || !sel.value) return null;
    var reps = {};
    try { reps = JSON.parse(localStorage.getItem(LS_REPS_KEY) || "{}"); } catch (e) {}
    return reps[sel.value] || null;
  }

  function refreshRecaptureButton() {
    var btn = byId("btnRecaptureMap");
    if (!btn) return;
    var rep = selectedReport();
    if (!rep) {
      btn.textContent = "\ud83d\udcf8 Capture Map";
      btn.disabled = true;
      btn.title = "Select a report first.";
      return;
    }
    var hasImg = !!(rep.mapImage && rep.mapImage.dataUrl);
    var hasPaths = !!(rep.coveragePaths && rep.coveragePaths.length);
    if (!hasPaths) {
      btn.textContent = "\ud83d\udcf8 Capture Map";
      btn.disabled = true;
      btn.title = "This report was saved before build-29, so there's no saved coverage to re-render. New reports can be re-captured any time.";
      return;
    }
    btn.disabled = false;
    btn.textContent = hasImg ? "\ud83d\udd04 Re-capture Map" : "\ud83d\udcf8 Capture Map";
    btn.title = hasImg
      ? "Replace the existing map image on this report."
      : "Generate a map image from this report's saved coverage.";
  }

  function onRecaptureClick() {
    var sel = byId("repSelect");
    if (!sel || !sel.value) {
      if (typeof appAlert === "function") appAlert("Select a report first.");
      return;
    }
    recaptureFromReport(sel.value);
  }

  // ----------------------------------------------------------
  // SAVE-REPORT HOOK — attaches the live-session capturedMapImage to
  // the newest saved report when app.js writes dof_reports.
  // ----------------------------------------------------------
  function hookReportSave() {
    var origSetItem = localStorage.setItem.bind(localStorage);
    localStorage.setItem = function (key, value) {
      if (key === LS_REPS_KEY && state && state.capturedMapImage) {
        try {
          var obj = JSON.parse(value);
          if (obj && typeof obj === "object") {
            // Find the newest report by savedAt; attach the image.
            var newestId = null, newestTs = 0;
            Object.keys(obj).forEach(function (k) {
              var r = obj[k];
              if (!r || !r.savedAt) return;
              var t = Date.parse(r.savedAt) || 0;
              if (t > newestTs) { newestTs = t; newestId = k; }
            });
            if (newestId && !obj[newestId].mapImage) {
              obj[newestId].mapImage = state.capturedMapImage;
              value = JSON.stringify(obj);
              state.capturedMapImage = null;
            }
          }
        } catch (e) {
          try { console.warn("[mapexport] save hook failed, proceeding without image", e); } catch (e2) {}
        }
      }
      return origSetItem(key, value);
    };
  }

  // Clear the session image whenever a new session starts.
  function hookSessionStart() {
    if (typeof window.startSession !== "function" || window.startSession.__mapexpPatched) return;
    var orig = window.startSession;
    window.startSession = function () {
      state.capturedMapImage = null;
      return orig.apply(this, arguments);
    };
    window.startSession.__mapexpPatched = true;
  }

  // ----------------------------------------------------------
  // PDF HEADER INJECTION — Intercept window.open and, when the popup's
  // document contains Report-PDF markers, prepend our header + map +
  // signature + footer.
  // ----------------------------------------------------------
  function hookPopupPDF() {
    var origOpen = window.open;
    window.open = function () {
      var win = origOpen.apply(this, arguments);
      try { decoratePopup(win); } catch (e) {
        try { console.warn("[mapexport] popup decorate failed", e); } catch (e2) {}
      }
      return win;
    };
  }

  function decoratePopup(win) {
    if (!win) return;
    var tries = 0;
    function attempt() {
      tries++;
      try {
        var doc = win.document;
        if (!doc || !doc.body) {
          if (tries < 20) return setTimeout(attempt, 100);
          return;
        }
        var title = (doc.title || "") + " " + (doc.body.textContent || "").slice(0, 200);
        var isReport =
          /OπO Farming|O\u03C0O|Diamond O|Field Report|Season Summary|Reports Export/i.test(title);
        if (!isReport) return;
        if (doc.body.getAttribute("data-mapexp-decorated") === "1") return;
        doc.body.setAttribute("data-mapexp-decorated", "1");

        injectPopupHeader(doc);
        var attached = injectPopupMapImage(doc);
        injectPopupSignatureBlock(doc, attached);
      } catch (e) {
        if (tries < 20) return setTimeout(attempt, 100);
      }
    }
    setTimeout(attempt, 50);
  }

  function injectPopupHeader(doc) {
    var logoAbs = new URL(LOGO_URL, window.location.href).href;
    var header = doc.createElement("div");
    header.className = "mapexp-header";
    header.innerHTML =
      "<img src='" + logoAbs + "' alt='OπO Farming' />" +
      "<div class='mapexp-wordmark'>" +
        "<div class='mapexp-brand'>OπO Farming</div>" +
        "<div class='mapexp-tag'>Data Systems Pro</div>" +
      "</div>";
    header.style.cssText =
      "display:flex;align-items:center;gap:14px;padding:12px 16px;" +
      "border-bottom:2px solid #2e9e57;margin-bottom:16px;";
    var style = doc.createElement("style");
    style.textContent =
      ".mapexp-header img{width:64px;height:64px;object-fit:contain;}" +
      ".mapexp-header .mapexp-brand{font-size:1.6rem;font-weight:700;color:#2a2620;line-height:1;}" +
      ".mapexp-header .mapexp-tag{font-size:0.85rem;color:#6b6557;margin-top:4px;}" +
      ".mapexp-map-wrap{margin:10px 0 20px 0;}" +
      ".mapexp-map-wrap h2{margin:0 0 8px 0;font-size:1.2rem;color:#2a2620;}" +
      ".mapexp-map-wrap img{max-width:100%;border:1px solid #d6cdb8;border-radius:6px;}" +
      ".mapexp-sig{margin-top:24px;padding-top:16px;border-top:1px dashed #6b6557;" +
        "display:flex;gap:32px;flex-wrap:wrap;font-size:0.95rem;color:#2a2620;}" +
      ".mapexp-sig .mapexp-sig-line{flex:1;min-width:220px;}" +
      ".mapexp-sig .mapexp-sig-line .mapexp-sig-label{font-size:0.75rem;color:#6b6557;" +
        "text-transform:uppercase;letter-spacing:0.05em;margin-bottom:4px;}" +
      ".mapexp-sig .mapexp-sig-line .mapexp-sig-prefill{font-size:0.95rem;color:#2a2620;" +
        "margin-bottom:4px;font-weight:500;}" +
      ".mapexp-sig .mapexp-sig-line .mapexp-sig-rule{border-bottom:1px solid #2a2620;height:28px;}" +
      ".mapexp-footer{margin-top:24px;padding-top:10px;border-top:1px solid #d6cdb8;" +
        "font-size:0.75rem;color:#6b6557;text-align:center;}" +
      "@media print{" +
        ".mapexp-header{border-bottom-color:#2e9e57;}" +
        ".mapexp-map-wrap{page-break-inside:avoid;}" +
        ".mapexp-sig{page-break-inside:avoid;}" +
      "}";
    doc.head.appendChild(style);
    doc.body.insertBefore(header, doc.body.firstChild);

    // Rename the browser tab title so saved-PDF filenames use OπO branding.
    try {
      if (doc.title && /Diamond O/i.test(doc.title)) {
        doc.title = doc.title.replace(/Diamond O(?: Farms)?/gi, "OπO Farming");
      }
    } catch (e) {}
  }

  // Returns the attached report object (or null) so the signature block
  // can pre-fill customer / operator from it.
  function injectPopupMapImage(doc) {
    var reps = null;
    try { reps = JSON.parse(localStorage.getItem(LS_REPS_KEY) || "{}"); } catch (e) { return null; }
    if (!reps || typeof reps !== "object") return null;

    var bodyText = (doc.body.textContent || "").slice(0, 4000);
    var candidate = null;
    Object.keys(reps).forEach(function (k) {
      var r = reps[k];
      if (!r || !r.mapImage || !r.mapImage.dataUrl) return;
      var fieldName = (r.field && r.field.name) || r.fieldName || "";
      if (fieldName && bodyText.indexOf(fieldName) === -1) return;
      var ts = Date.parse(r.savedAt) || 0;
      if (!candidate || ts > candidate._ts) {
        candidate = r; candidate._ts = ts;
      }
    });
    if (!candidate) return null;

    var title = (candidate.mapImage && candidate.mapImage.title) ||
                mapTitleFor(candidate.equipment && candidate.equipment.type);
    var fieldName = (candidate.field && candidate.field.name) || candidate.fieldName || "";

    var wrap = doc.createElement("div");
    wrap.className = "mapexp-map-wrap";
    wrap.innerHTML =
      "<h2>" + escapeHtml(title) + (fieldName ? " \u2014 " + escapeHtml(fieldName) : "") + "</h2>" +
      "<img src='" + candidate.mapImage.dataUrl + "' alt='" + escapeHtml(title) + "' />";

    var header = doc.querySelector(".mapexp-header");
    if (header && header.nextSibling) {
      doc.body.insertBefore(wrap, header.nextSibling);
    } else {
      doc.body.appendChild(wrap);
    }
    return candidate;
  }

  function injectPopupSignatureBlock(doc, attachedRep) {
    // Skip signature on multi-report rollups (Reports Export, Season).
    var h2s = doc.querySelectorAll("h2").length;
    var hasMap = doc.querySelector(".mapexp-map-wrap");
    if (h2s > 3 && !hasMap) return;

    // Pre-fill: prefer the attached report's own saved operator/customer
    // (so an old captured map keeps the original name), else fall back to
    // the current operator name + the attached report's farm/field.
    var opName = "";
    var custName = "";
    if (attachedRep && attachedRep.mapImage) {
      opName  = attachedRep.mapImage.operator || "";
      custName = attachedRep.mapImage.customer || "";
    }
    if (!opName) opName = getOperatorName() || "";
    if (!custName && attachedRep && attachedRep.field) {
      custName = attachedRep.field.farmName || attachedRep.field.name || "";
    }

    // Build today's date in DD/MM/YYYY (Mike's preferred format).
    var now = new Date();
    var dd = String(now.getDate()).padStart(2, "0");
    var mm = String(now.getMonth() + 1).padStart(2, "0");
    var yyyy = now.getFullYear();
    var dateStr = dd + "/" + mm + "/" + yyyy;

    var sig = doc.createElement("div");
    sig.className = "mapexp-sig";
    sig.innerHTML =
      "<div class='mapexp-sig-line'>" +
        "<div class='mapexp-sig-label'>Operator Signature</div>" +
        (opName ? "<div class='mapexp-sig-prefill'>" + escapeHtml(opName) + "</div>" : "") +
        "<div class='mapexp-sig-rule'></div>" +
      "</div>" +
      "<div class='mapexp-sig-line'>" +
        "<div class='mapexp-sig-label'>Customer / Delivered To</div>" +
        (custName ? "<div class='mapexp-sig-prefill'>" + escapeHtml(custName) + "</div>" : "") +
        "<div class='mapexp-sig-rule'></div>" +
      "</div>" +
      "<div class='mapexp-sig-line'>" +
        "<div class='mapexp-sig-label'>Date</div>" +
        "<div class='mapexp-sig-prefill'>" + dateStr + "</div>" +
        "<div class='mapexp-sig-rule'></div>" +
      "</div>";

    var printBtn = doc.querySelector(".btn-print");
    if (printBtn && printBtn.parentNode) {
      printBtn.parentNode.insertBefore(sig, printBtn);
    } else {
      doc.body.appendChild(sig);
    }

    var footer = doc.createElement("div");
    footer.className = "mapexp-footer";
    var build = window.APP_VERSION_LABEL || window.APP_BUILD || "";
    var hh = String(now.getHours()).padStart(2, "0");
    var mn = String(now.getMinutes()).padStart(2, "0");
    footer.textContent = "Generated by OπO Farming" +
      (build ? " · " + build : "") +
      " · " + dateStr + " " + hh + mn;
    if (printBtn && printBtn.parentNode) {
      printBtn.parentNode.insertBefore(footer, printBtn);
    } else {
      doc.body.appendChild(footer);
    }
  }

  function escapeHtml(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  // ----------------------------------------------------------
  // BOOT
  // ----------------------------------------------------------
  ready(function () {
    try { injectCaptureButton();   } catch (e) { try { console.warn("[mapexport] capture-button inject failed", e); } catch (e2) {} }
    try { injectRecaptureButton(); } catch (e) { try { console.warn("[mapexport] recapture-button inject failed", e); } catch (e2) {} }
    try { hookReportSave();        } catch (e) { try { console.warn("[mapexport] save hook failed", e); } catch (e2) {} }
    try { hookSessionStart();      } catch (e) { try { console.warn("[mapexport] session hook failed", e); } catch (e2) {} }
    try { hookPopupPDF();          } catch (e) { try { console.warn("[mapexport] popup hook failed", e); } catch (e2) {} }
    try { console.log("[mapexport] ready — build-29"); } catch (e) {}
  });

  // Public surface for future wiring / debugging.
  window.MapExport = {
    captureMap: captureMap,
    recaptureFromReport: recaptureFromReport,
    mapTitleFor: mapTitleFor,
    buildStaticMapUrl: buildStaticMapUrl,
    getOperatorName: getOperatorName,
    setOperatorName: setOperatorName
  };
})();
