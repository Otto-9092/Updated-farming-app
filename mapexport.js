// ============================================================
// OπO Farming — MAP EXPORT (self-contained)
// ------------------------------------------------------------
// Adds a 📸 Capture Map button on the Operate screen and injects
// the captured map image + OπO logo header into the existing
// Report PDF flow. Fully additive: no changes to app.js state,
// no changes to existing tabs, no changes to how the PDF is
// built. We monkey-patch the Save Report persistence to carry
// the image, and the PDF HTML builder to render it.
//
// Depends only on globals app.js already defines:
//   state, $, $id, appAlert, showToast
//
// Capture technique:
//   • Primary — Google Static Maps API URL, encoding the field
//     boundary + painted coverage polygons as styled paths with
//     the current GOOGLE_MAPS_API_KEY. Fast, reliable, CORS-free.
//   • Fallback — if the encoded URL would exceed Google's ~8192
//     char limit, we Douglas-Peucker simplify the polygons until
//     it fits. If it still doesn't fit (ridiculous coverage), we
//     fall through to html2canvas on the live map div.
//
// Trigger UX:
//   • Button becomes active while a session is running AND
//     state.coveragePolys has at least one painted stripe.
//   • Tap → fetches the static map, previews it in a dialog
//     with Retake / Keep buttons.
//   • Kept image → stored on state.capturedMapImage (data URL).
//   • When Save Report runs, we embed the image in the saved
//     report record so it survives sync + reload.
//   • When Print PDF runs, the PDF HTML template is wrapped to
//     render the OπO logo header + captured map at the top.
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
  // STATIC MAPS URL BUILDER
  // ----------------------------------------------------------
  // Encodes current state.coveragePolys + state.boundary.points as
  // Google Static Maps "path" params. Each polygon becomes one path.
  // Returns null if the live state has no paint to export.
  // ----------------------------------------------------------
  function buildStaticMapUrl(simplifyTolerance) {
    var key = window.GOOGLE_MAPS_API_KEY;
    if (!key) return null;

    var polys = (state.coveragePolys || []).filter(function (p) {
      return p && typeof p.getPath === "function";
    });
    if (!polys.length) return null;

    var params = [
      "size=" + STATIC_MAP_SIZE,
      "scale=" + STATIC_MAP_SCALE,
      "maptype=satellite",
      "key=" + encodeURIComponent(key)
    ];

    // Boundary path (if we have one)
    var bnd = (state.boundary && state.boundary.points) || [];
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
    for (var i = 0; i < polys.length; i++) {
      var path = polys[i].getPath();
      var pts = [];
      for (var j = 0; j < path.getLength(); j++) {
        var ll = path.getAt(j);
        pts.push({ lat: ll.lat(), lng: ll.lng() });
      }
      if (pts.length < 2) continue;
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
  // can't fit (which means we have to fall through to html2canvas).
  function buildFittingStaticMapUrl() {
    var tolerances = [0, 0.00001, 0.00003, 0.00008, 0.0002, 0.0005];
    for (var i = 0; i < tolerances.length; i++) {
      var url = buildStaticMapUrl(tolerances[i]);
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
    try { console.warn("[mapexport] couldn't fit static-map URL under " + URL_LIMIT + " chars"); } catch (e) {}
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
  // CAPTURE FLOW
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
    var url = buildFittingStaticMapUrl();
    if (!url) {
      if (typeof appAlert === "function") appAlert("Map export is too complex to render (over 8K chars). Try capturing earlier in the session, or we can add an html2canvas fallback in a future build.");
      return;
    }
    showCapturingDialog();
    fetchAsDataUrl(url).then(function (dataUrl) {
      state.capturedMapImage = {
        dataUrl: dataUrl,
        capturedAt: new Date().toISOString(),
        title: mapTitleFor(state.equipment && state.equipment.type)
      };
      closeCapturingDialog();
      showPreviewDialog(dataUrl);
    }).catch(function (err) {
      closeCapturingDialog();
      try { console.error("[mapexport] capture failed", err); } catch (e) {}
      if (typeof appAlert === "function") appAlert("Map capture failed: " + (err && err.message ? err.message : String(err)));
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
      d.innerHTML = "<div style='background:#2a2620;padding:20px 28px;border-radius:12px;'>📸 Capturing map…</div>";
      document.body.appendChild(d);
      return d;
    })();
    host.style.display = "flex";
  }
  function closeCapturingDialog() {
    var host = byId("mapexpBusy");
    if (host) host.style.display = "none";
  }

  function showPreviewDialog(dataUrl) {
    var old = byId("mapexpPreview");
    if (old) old.remove();
    var d = document.createElement("div");
    d.id = "mapexpPreview";
    d.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,0.65);display:flex;align-items:center;justify-content:center;z-index:9999;padding:16px;";
    d.innerHTML =
      "<div style='background:var(--panel,#fffdf7);color:var(--text,#2a2620);border:1px solid var(--border,#d6cdb8);border-radius:12px;max-width:720px;width:100%;max-height:92vh;display:flex;flex-direction:column;overflow:hidden;'>" +
        "<div style='padding:12px 16px;border-bottom:1px solid var(--border,#d6cdb8);display:flex;align-items:center;justify-content:space-between;'>" +
          "<strong>📸 Map Captured</strong>" +
          "<button id='mapexpClose' aria-label='Close' style='background:none;border:none;font-size:1.4rem;cursor:pointer;color:var(--muted,#6b6557);'>×</button>" +
        "</div>" +
        "<div style='padding:12px 16px;overflow:auto;'>" +
          "<p style='margin:0 0 10px 0;color:var(--muted,#6b6557);font-size:0.9rem;'>" +
            "This map will be embedded in the Report PDF when you Save Report → Print PDF." +
          "</p>" +
          "<img src='" + dataUrl + "' alt='Captured map' style='max-width:100%;border-radius:8px;border:1px solid var(--border,#d6cdb8);' />" +
        "</div>" +
        "<div style='padding:12px 16px;border-top:1px solid var(--border,#d6cdb8);display:flex;gap:8px;justify-content:flex-end;'>" +
          "<button id='mapexpRetake' style='padding:8px 14px;border:1px solid var(--border,#d6cdb8);background:var(--panel-2,#ece5d3);color:var(--text,#2a2620);border-radius:8px;cursor:pointer;'>Retake</button>" +
          "<button id='mapexpKeep' style='padding:8px 14px;border:none;background:var(--green,#2e9e57);color:#fff;border-radius:8px;cursor:pointer;font-weight:600;'>Keep</button>" +
        "</div>" +
      "</div>";
    document.body.appendChild(d);

    function close() { d.remove(); }
    byId("mapexpClose").onclick = close;
    byId("mapexpKeep").onclick = function () {
      close();
      if (typeof showToast === "function") showToast("Map saved to this session", { kind: "ok" });
    };
    byId("mapexpRetake").onclick = function () {
      state.capturedMapImage = null;
      close();
      captureMap();
    };
  }

  // ----------------------------------------------------------
  // BUTTON INJECTION — adds the 📸 Capture Map button to the Operate screen
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
    btn.textContent = "📸 Capture Map";
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

  // ----------------------------------------------------------
  // SAVE-REPORT HOOK
  // ----------------------------------------------------------
  // We can't easily locate app.js's save function by name without
  // reading it, so we hook localStorage.setItem on the reports key.
  // When app.js writes dof_reports, we inject the capturedMapImage
  // into whichever report was just added (the newest by savedAt).
  // ----------------------------------------------------------
  function hookReportSave() {
    var LS_REPS_KEY = "dof_reports";
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
              // Clear the session-side image so the next report starts fresh
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
  // PDF HEADER INJECTION
  // ----------------------------------------------------------
  // app.js builds the PDF HTML string in-page then window.print()s a
  // popup. We don't rewrite that; instead we intercept window.open and,
  // when the popup's document is written to, inject our header above
  // the existing content and a signature block at the bottom.
  //
  // The hook runs for ANY popup, but only mutates one whose document
  // contains "<title>OπO" (or the legacy Diamond O marker from older
  // app.js versions) — i.e. a Report PDF popup.
  // ----------------------------------------------------------
  function hookPopupPDF() {
    var origOpen = window.open;
    window.open = function (url, name, features) {
      var win = origOpen.apply(this, arguments);
      try { decoratePopup(win); } catch (e) {
        try { console.warn("[mapexport] popup decorate failed", e); } catch (e2) {}
      }
      return win;
    };
  }

  function decoratePopup(win) {
    if (!win) return;
    // Give the popup a moment to receive its document.write() content,
    // then run our injection. We retry a few times because browsers
    // vary on when document.readyState goes to "complete".
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
        // Match the Report PDF popups app.js produces. We look for
        // tell-tale strings rather than rebranding every popup.
        var isReport =
          /OπO Farming|O\u03C0O|Diamond O|Field Report|Season Summary|Reports Export/i.test(title);
        if (!isReport) return;
        if (doc.body.getAttribute("data-mapexp-decorated") === "1") return;
        doc.body.setAttribute("data-mapexp-decorated", "1");

        injectPopupHeader(doc);
        injectPopupMapImage(doc);
        injectPopupSignatureBlock(doc);
      } catch (e) {
        if (tries < 20) return setTimeout(attempt, 100);
      }
    }
    setTimeout(attempt, 50);
  }

  function injectPopupHeader(doc) {
    // Resolve the logo URL relative to the app's origin, since the popup
    // is at about:blank and relative URLs would fail.
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
    // Insert style for the header + print rules
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

    // Also replace the browser tab title so the saved-PDF name is OπO-branded.
    try {
      if (doc.title && /Diamond O/i.test(doc.title)) {
        doc.title = doc.title.replace(/Diamond O(?: Farms)?/gi, "OπO Farming");
      }
    } catch (e) {}
  }

  function injectPopupMapImage(doc) {
    // Look for the most recent report's mapImage. We don't have the
    // specific report id here, so we take the newest one that has an
    // image AND whose field name appears in the popup body.
    var reps = null;
    try { reps = JSON.parse(localStorage.getItem("dof_reports") || "{}"); } catch (e) { return; }
    if (!reps || typeof reps !== "object") return;

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
    if (!candidate) return;

    var title = (candidate.mapImage && candidate.mapImage.title) ||
                mapTitleFor(candidate.equipment && candidate.equipment.type);
    var fieldName = (candidate.field && candidate.field.name) || candidate.fieldName || "";

    var wrap = doc.createElement("div");
    wrap.className = "mapexp-map-wrap";
    wrap.innerHTML =
      "<h2>" + escapeHtml(title) + (fieldName ? " — " + escapeHtml(fieldName) : "") + "</h2>" +
      "<img src='" + candidate.mapImage.dataUrl + "' alt='" + escapeHtml(title) + "' />";

    // Insert the map right after our header (which is now the first child).
    var header = doc.querySelector(".mapexp-header");
    if (header && header.nextSibling) {
      doc.body.insertBefore(wrap, header.nextSibling);
    } else {
      doc.body.appendChild(wrap);
    }
  }

  function injectPopupSignatureBlock(doc) {
    // Only add a signature block to single-report PDFs, not the big
    // multi-report "Reports Export" or Season rollups. Heuristic: if
    // the popup body already has multiple <h2>s AND no mapexp-map-wrap,
    // it's a list export, skip.
    var h2s = doc.querySelectorAll("h2").length;
    var hasMap = doc.querySelector(".mapexp-map-wrap");
    if (h2s > 3 && !hasMap) return;

    var sig = doc.createElement("div");
    sig.className = "mapexp-sig";
    sig.innerHTML =
      "<div class='mapexp-sig-line'>" +
        "<div class='mapexp-sig-label'>Operator Signature</div>" +
        "<div class='mapexp-sig-rule'></div>" +
      "</div>" +
      "<div class='mapexp-sig-line'>" +
        "<div class='mapexp-sig-label'>Customer / Delivered To</div>" +
        "<div class='mapexp-sig-rule'></div>" +
      "</div>" +
      "<div class='mapexp-sig-line'>" +
        "<div class='mapexp-sig-label'>Date</div>" +
        "<div class='mapexp-sig-rule'></div>" +
      "</div>";

    // Place the signature block before any existing print button, if present.
    var printBtn = doc.querySelector(".btn-print");
    if (printBtn && printBtn.parentNode) {
      printBtn.parentNode.insertBefore(sig, printBtn);
    } else {
      doc.body.appendChild(sig);
    }

    // Footer with build + generated-at timestamp.
    var footer = doc.createElement("div");
    footer.className = "mapexp-footer";
    var build = window.APP_VERSION_LABEL || window.APP_BUILD || "";
    var now = new Date();
    var dd = String(now.getDate()).padStart(2, "0");
    var mm = String(now.getMonth() + 1).padStart(2, "0");
    var yyyy = now.getFullYear();
    var hh = String(now.getHours()).padStart(2, "0");
    var mn = String(now.getMinutes()).padStart(2, "0");
    footer.textContent = "Generated by OπO Farming" +
      (build ? " · " + build : "") +
      " · " + dd + "/" + mm + "/" + yyyy + " " + hh + mn;
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
    try { injectCaptureButton(); } catch (e) { try { console.warn("[mapexport] button inject failed", e); } catch (e2) {} }
    try { hookReportSave();     } catch (e) { try { console.warn("[mapexport] save hook failed", e); } catch (e2) {} }
    try { hookSessionStart();   } catch (e) { try { console.warn("[mapexport] session hook failed", e); } catch (e2) {} }
    try { hookPopupPDF();       } catch (e) { try { console.warn("[mapexport] popup hook failed", e); } catch (e2) {} }
    try { console.log("[mapexport] ready — build-28"); } catch (e) {}
  });

  // Expose a tiny public surface for debugging / future wiring.
  window.MapExport = {
    captureMap: captureMap,
    mapTitleFor: mapTitleFor,
    buildStaticMapUrl: buildStaticMapUrl
  };
})();
