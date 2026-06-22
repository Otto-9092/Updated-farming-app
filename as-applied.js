// ============================================================
// OπO Farming — As-Applied Data Layer + Edit-Bushels (ALL-IN-ONE)
// ------------------------------------------------------------
// 100% SELF-CONTAINED. You insert NOTHING into app.js.
// Just add ONE line to index.html AFTER the app.js script tag:
//
//     <script src="app.js?v=..."></script>
//     <script src="asapplied.js?v=20260622-2"></script>
//
// This module RUNTIME-PATCHES (monkey-patches) the existing global
// functions in app.js so all behavior is added without editing them:
//   • onPos              -> tags each trail point with applied rate
//   • drawCoveragePolygon-> respects a manual bushels lock
//   • updateMetrics      -> won't overwrite a locked bushels tile
//   • startSession       -> clears the manual lock for a new session
//   • the Save Report flow-> embeds as-applied data + bushelsManual,
//                            and persists the layer to IndexedDB
//   • the PDF flow        -> not patched (kept simple); summary is in the
//                            saved report object for your own use
//
// It also injects its own dialog + buttons + CSS into the DOM, so
// you don't have to touch index.html beyond the one script tag.
//
// Depends only on globals app.js already defines:
//   state, $, $id, openDlg, closeDlg, appAlert, downloadFile,
//   _shpZip, _SHP_PRJ, _SHP_CPG, _shpClockwise, fitMapToBoundary
// ============================================================
(function () {
  "use strict";

  function byId(id) { return document.getElementById(id); }
  function ready(fn) {
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", fn);
    else fn();
  }

  // ----------------------------------------------------------
  // RATE HELPERS — mirror the live logic in drawCoveragePolygon()
  // ----------------------------------------------------------
  function currentRateUnit() {
    switch (state.equipment.type) {
      case "sprayer":  return "GPA";
      case "combine":  return "bu/ac";
      case "spreader": return "lbs/ac";
      default:         return "rate";
    }
  }
  function currentAppliedRate() {
    var t = state.equipment.type;
    if (t === "sprayer")  return +((state.sprayer && state.sprayer.gpa) || 0);
    if (t === "spreader") return +((state.spreader && state.spreader.rate) || 0);
    if (t === "combine") {
      return state.field.crop === "Soybeans" ? 55
           : state.field.crop === "Wheat"    ? 70 : 180;
    }
    return 0;
  }

  // ----------------------------------------------------------
  // BUILD DATA LAYER — normalize coverage polys + trail points
  // ----------------------------------------------------------
  function polyToRing(poly) {
    var latlngs = [];
    try {
      var path = poly.getPath();
      for (var k = 0; k < path.getLength(); k++) {
        var ll = path.getAt(k);
        latlngs.push({ lat: ll.lat(), lng: ll.lng() });
      }
    } catch (e) {
      if (Array.isArray(poly)) latlngs = poly.slice();
    }
    var ring = latlngs.map(function (p) { return { lat: p.lat, lng: p.lng }; });
    if (ring.length &&
        (ring[0].lat !== ring[ring.length - 1].lat ||
         ring[0].lng !== ring[ring.length - 1].lng)) {
      ring.push({ lat: ring[0].lat, lng: ring[0].lng });
    }
    return ring;
  }

  function buildDataLayer() {
    var unit = currentRateUnit();
    var pts = (state.trailPoints || []).filter(function (p) {
      return p && isFinite(p.lat) && isFinite(p.lng);
    });
    var rates = pts.map(function (p) { return +p.rate || 0; })
                   .filter(function (r) { return r > 0; });
    var sum = rates.reduce(function (a, b) { return a + b; }, 0);
    var avg = rates.length ? sum / rates.length : currentAppliedRate();
    var min = rates.length ? Math.min.apply(null, rates) : avg;
    var max = rates.length ? Math.max.apply(null, rates) : avg;

    var pointFeatures = pts.map(function (p, i) {
      return {
        lng: p.lng, lat: p.lat,
        props: {
          SEQ:   i + 1,
          RATE:  +(p.rate != null ? p.rate : avg),
          UNIT:  p.rateUnit || unit,
          SPEED: +(p.speed || 0)
        }
      };
    });

    var polyFeatures = (state.coveragePolys || []).map(function (poly, i) {
      return {
        ring: polyToRing(poly),
        props: { SEQ: i + 1, RATE: +avg.toFixed(2), UNIT: unit, SPEED: 0 }
      };
    }).filter(function (f) { return f.ring.length >= 4; });

    return {
      generatedAt: Date.now(),
      equipment:   state.equipment.type,
      crop:        state.field.crop,
      product:     (state.sprayer && state.sprayer.product) ||
                   (state.spreader && state.spreader.productName) || "",
      units:       unit,
      stats: {
        pointCount: pointFeatures.length,
        polyCount:  polyFeatures.length,
        avgRate:    +avg.toFixed(2),
        minRate:    +min.toFixed(2),
        maxRate:    +max.toFixed(2),
        acres:      +((state.acres || 0)).toFixed(2)
      },
      points:   pointFeatures,
      polygons: polyFeatures
    };
  }

  // ----------------------------------------------------------
  // AS-APPLIED SHAPEFILE WRITER (independent of boundary writer)
  // ----------------------------------------------------------
  function buildDbf(records, fields) {
    var nrec = records.length;
    var headerLen = 32 + fields.length * 32 + 1;
    var recLen = 1;
    fields.forEach(function (f) { recLen += f.len; });
    var u = new Uint8Array(headerLen + nrec * recLen + 1), dv = new DataView(u.buffer);
    u[0] = 3;
    var d = new Date();
    u[1] = d.getFullYear() - 1900; u[2] = d.getMonth() + 1; u[3] = d.getDate();
    dv.setInt32(4, nrec, true);
    dv.setInt16(8, headerLen, true);
    dv.setInt16(10, recLen, true);
    var fo = 32;
    fields.forEach(function (f) {
      var nm = f.name.slice(0, 10);
      for (var i = 0; i < nm.length; i++) u[fo + i] = nm.charCodeAt(i);
      u[fo + 11] = f.type.charCodeAt(0);
      u[fo + 16] = f.len;
      u[fo + 17] = f.dec || 0;
      fo += 32;
    });
    u[fo] = 0x0D; fo += 1;
    var p = fo;
    records.forEach(function (rec) {
      u[p++] = 0x20;
      fields.forEach(function (f) {
        var raw = rec[f.name], s;
        if (f.type === "N") {
          var num = (raw == null || isNaN(raw)) ? 0 : Number(raw);
          s = num.toFixed(f.dec || 0);
          if (s.length > f.len) s = s.slice(0, f.len);
          while (s.length < f.len) s = " " + s;
        } else {
          s = String(raw == null ? "" : raw).replace(/[^\x00-\x7F]/g, "?");
          if (s.length > f.len) s = s.slice(0, f.len);
          while (s.length < f.len) s = s + " ";
        }
        for (var j = 0; j < f.len; j++) u[p + j] = s.charCodeAt(j);
        p += f.len;
      });
    });
    u[p] = 0x1A;
    return u;
  }

  function buildPointShpShx(points) {
    var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    points.forEach(function (p) {
      if (p.lng < minX) minX = p.lng; if (p.lng > maxX) maxX = p.lng;
      if (p.lat < minY) minY = p.lat; if (p.lat > maxY) maxY = p.lat;
    });
    var recs = points.map(function (p) {
      var buf = new ArrayBuffer(20), dv = new DataView(buf);
      dv.setInt32(0, 1, true);
      dv.setFloat64(4, p.lng, true);
      dv.setFloat64(12, p.lat, true);
      return new Uint8Array(buf);
    });
    return assembleShpShx(recs, 1, minX, minY, maxX, maxY);
  }

  function buildPolyShpShx(rings) {
    var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    rings.forEach(function (ring) {
      ring.forEach(function (p) {
        if (p.lng < minX) minX = p.lng; if (p.lng > maxX) maxX = p.lng;
        if (p.lat < minY) minY = p.lat; if (p.lat > maxY) maxY = p.lat;
      });
    });
    var recs = rings.map(function (ringRaw) {
      var ring = (typeof _shpClockwise === "function") ? _shpClockwise(ringRaw) : ringRaw.slice();
      if (ring.length && (ring[0].lat !== ring[ring.length - 1].lat ||
                          ring[0].lng !== ring[ring.length - 1].lng)) {
        ring = ring.concat([ring[0]]);
      }
      var n = ring.length;
      var rxmin = Infinity, rymin = Infinity, rxmax = -Infinity, rymax = -Infinity;
      ring.forEach(function (p) {
        if (p.lng < rxmin) rxmin = p.lng; if (p.lng > rxmax) rxmax = p.lng;
        if (p.lat < rymin) rymin = p.lat; if (p.lat > rymax) rymax = p.lat;
      });
      var buf = new ArrayBuffer(4 + 32 + 4 + 4 + 4 + n * 16);
      var dv = new DataView(buf), o = 0;
      dv.setInt32(o, 5, true); o += 4;
      dv.setFloat64(o, rxmin, true); o += 8; dv.setFloat64(o, rymin, true); o += 8;
      dv.setFloat64(o, rxmax, true); o += 8; dv.setFloat64(o, rymax, true); o += 8;
      dv.setInt32(o, 1, true); o += 4;
      dv.setInt32(o, n, true); o += 4;
      dv.setInt32(o, 0, true); o += 4;
      ring.forEach(function (p) {
        dv.setFloat64(o, p.lng, true); o += 8;
        dv.setFloat64(o, p.lat, true); o += 8;
      });
      return new Uint8Array(buf);
    });
    return assembleShpShx(recs, 5, minX, minY, maxX, maxY);
  }

  function assembleShpShx(recs, shapeType, minX, minY, maxX, maxY) {
    var shpWords = 50; recs.forEach(function (c) { shpWords += 4 + c.length / 2; });
    var shxWords = 50 + recs.length * 4;
    function header(dv, lenWords) {
      dv.setInt32(0, 9994, false);
      dv.setInt32(24, lenWords, false);
      dv.setInt32(28, 1000, true);
      dv.setInt32(32, shapeType, true);
      dv.setFloat64(36, minX, true); dv.setFloat64(44, minY, true);
      dv.setFloat64(52, maxX, true); dv.setFloat64(60, maxY, true);
    }
    var shp = new Uint8Array(shpWords * 2), shpDv = new DataView(shp.buffer); header(shpDv, shpWords);
    var shx = new Uint8Array(shxWords * 2), shxDv = new DataView(shx.buffer); header(shxDv, shxWords);
    var pos = 100, off = 50, sp = 100;
    recs.forEach(function (c, i) {
      var cw = c.length / 2;
      shpDv.setInt32(pos, i + 1, false); pos += 4;
      shpDv.setInt32(pos, cw, false);    pos += 4;
      shp.set(c, pos); pos += c.length;
      shxDv.setInt32(sp, off, false); sp += 4;
      shxDv.setInt32(sp, cw, false);  sp += 4;
      off += 4 + cw;
    });
    return { shp: shp, shx: shx };
  }

  function bytesFromStr(s) {
    var a = new Uint8Array(s.length);
    for (var i = 0; i < s.length; i++) a[i] = s.charCodeAt(i);
    return a;
  }

  var DBF_FIELDS = [
    { name: "SEQ",   type: "N", len: 9,  dec: 0 },
    { name: "RATE",  type: "N", len: 13, dec: 2 },
    { name: "UNIT",  type: "C", len: 10, dec: 0 },
    { name: "SPEED", type: "N", len: 9,  dec: 1 }
  ];

  function safeName(s) {
    return String(s || "field").replace(/[^A-Za-z0-9_-]+/g, "_").slice(0, 40) || "field";
  }

  function exportAsAppliedShapefile() {
    var layer = buildDataLayer();
    if (!layer.points.length && !layer.polygons.length) {
      appAlert("No as-applied data yet — start a session and paint some coverage first.",
               "Nothing to export");
      return;
    }
    var base = safeName((state.field && state.field.name) || "field") + "_asapplied";
    var prj = bytesFromStr(_SHP_PRJ);
    var cpg = bytesFromStr(typeof _SHP_CPG === "string" ? _SHP_CPG : "UTF-8");
    var files = [];
    if (layer.polygons.length) {
      var pShp = buildPolyShpShx(layer.polygons.map(function (f) { return f.ring; }));
      var pRecs = layer.polygons.map(function (f) { return f.props; });
      files.push(
        { name: base + "_poly.shp", data: pShp.shp },
        { name: base + "_poly.shx", data: pShp.shx },
        { name: base + "_poly.dbf", data: buildDbf(pRecs, DBF_FIELDS) },
        { name: base + "_poly.prj", data: prj },
        { name: base + "_poly.cpg", data: cpg }
      );
    }
    if (layer.points.length) {
      var ptShp = buildPointShpShx(layer.points.map(function (f) {
        return { lng: f.lng, lat: f.lat };
      }));
      var ptRecs = layer.points.map(function (f) { return f.props; });
      files.push(
        { name: base + "_pts.shp", data: ptShp.shp },
        { name: base + "_pts.shx", data: ptShp.shx },
        { name: base + "_pts.dbf", data: buildDbf(ptRecs, DBF_FIELDS) },
        { name: base + "_pts.prj", data: prj },
        { name: base + "_pts.cpg", data: cpg }
      );
    }
    var zip = _shpZip(files);
    var stamp = new Date().toISOString().slice(0, 10);
    downloadFile(base + "_" + stamp + ".zip", zip, "application/zip");
    var hint = byId("asAppliedHint");
    if (hint) {
      hint.textContent = "Exported " + layer.stats.polyCount + " coverage polygon(s) and " +
        layer.stats.pointCount + " applied point(s). Avg rate " +
        layer.stats.avgRate + " " + layer.units + ".";
    }
  }

  // ----------------------------------------------------------
  // RATE-COLORED HEAT OVERLAY (View As-Applied on the map)
  // Re-draws coverage polygons colored green->yellow->red by rate.
  // ----------------------------------------------------------
  var _heatLayer = [];
  var _heatOn = false;

  function clearHeat() {
    _heatLayer.forEach(function (poly) { try { poly.setMap(null); } catch (e) {} });
    _heatLayer = [];
    _heatOn = false;
    var b = byId("btnViewAsApplied");
    if (b) b.textContent = "\uD83D\uDC41\uFE0F View As-Applied Map";
  }

  // Green (low) -> Yellow (mid) -> Red (high). t in [0,1].
  function rateColor(t) {
    t = Math.max(0, Math.min(1, t));
    var r, g, b = 0;
    if (t < 0.5) { r = Math.round(510 * t); g = 200; }       // green->yellow
    else { r = 255; g = Math.round(200 * (1 - (t - 0.5) * 2)); } // yellow->red
    function hex(n) { var s = n.toString(16); return s.length < 2 ? "0" + s : s; }
    return "#" + hex(r) + hex(g) + hex(b);
  }

  function showHeatMap() {
    if (!state.map) { appAlert("Map isn't ready yet."); return; }
    var layer = buildDataLayer();
    if (!layer.polygons.length && !layer.points.length) {
      appAlert("No as-applied data to show yet — paint some coverage first.", "As-Applied");
      return;
    }
    if (_heatOn) { clearHeat(); return; }   // toggle off

    var min = layer.stats.minRate, max = layer.stats.maxRate;
    var span = (max - min) || 1;

    // Prefer polygons; fall back to small point dots if no polys.
    if (layer.polygons.length) {
      layer.polygons.forEach(function (f) {
        var t = (f.props.RATE - min) / span;
        var poly = new google.maps.Polygon({
          paths: f.ring.map(function (p) { return { lat: p.lat, lng: p.lng }; }),
          strokeWeight: 0,
          fillColor: rateColor(t),
          fillOpacity: 0.75,
          map: state.map,
          zIndex: 5
        });
        _heatLayer.push(poly);
      });
    } else {
      layer.points.forEach(function (f) {
        var t = (f.props.RATE - min) / span;
        var dot = new google.maps.Marker({
          position: { lat: f.lat, lng: f.lng },
          map: state.map,
          icon: {
            path: google.maps.SymbolPath.CIRCLE,
            scale: 4,
            fillColor: rateColor(t),
            fillOpacity: 0.9,
            strokeWeight: 0
          }
        });
        _heatLayer.push(dot);
      });
    }

    _heatOn = true;
    var b = byId("btnViewAsApplied");
    if (b) b.textContent = "\u2716\uFE0F Hide As-Applied Map";

    // Fit the map to the coverage so the operator sees it immediately.
    try {
      var allPts = [];
      layer.polygons.forEach(function (f) { f.ring.forEach(function (p) { allPts.push(p); }); });
      layer.points.forEach(function (f) { allPts.push({ lat: f.lat, lng: f.lng }); });
      if (typeof fitMapToBoundary === "function" && allPts.length) fitMapToBoundary(allPts);
    } catch (e) {}

    var hint = byId("asAppliedHint");
    if (hint) {
      hint.textContent = "Showing rate map: " + rateColor(0) + " (low " + min + ") \u2192 " +
        rateColor(1) + " (high " + max + ") " + layer.units +
        ". Tap again to hide.";
    }
  }

  // ----------------------------------------------------------
  // INDEXEDDB — own DB so we don't bump the photos DB version
  // ----------------------------------------------------------
  var AA_DB = "opio_asapplied_db", AA_STORE = "asApplied", _aaPromise = null;
  function aaOpen() {
    if (_aaPromise) return _aaPromise;
    _aaPromise = new Promise(function (resolve, reject) {
      if (!("indexedDB" in window)) { reject(new Error("IndexedDB unavailable")); return; }
      var req = indexedDB.open(AA_DB, 1);
      req.onupgradeneeded = function () {
        var db = req.result;
        if (!db.objectStoreNames.contains(AA_STORE)) {
          db.createObjectStore(AA_STORE, { keyPath: "reportId" });
        }
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
    return _aaPromise;
  }
  function aaSave(reportId, layer) {
    return aaOpen().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(AA_STORE, "readwrite");
        tx.objectStore(AA_STORE).put({ reportId: reportId, layer: layer, savedAt: Date.now() });
        tx.oncomplete = function () { resolve(true); };
        tx.onerror = function () { reject(tx.error); };
      });
    });
  }

  // ----------------------------------------------------------
  // EDIT TOTAL BUSHELS dialog (themed; matches showTitleDialog)
  // ----------------------------------------------------------
  function showBushelsDialog() {
    return new Promise(function (resolve) {
      var input = byId("dlgBushels");
      if (input) input.value = state.bushels ? Math.round(state.bushels) : "";
      var hint = byId("dlgBushelsHint");
      if (hint) {
        hint.textContent = state.bushelsManual
          ? "Using your entered number. Tap \u201CUse Auto-Estimate\u201D to return to the GPS estimate."
          : "Auto-estimated from acres \u00D7 yield. Enter your scale-ticket total to override.";
      }
      openDlg("bushelsDlg", "dlgBushels");
      if (input) { try { input.select(); } catch (e) {} }

      function cleanup() {
        byId("bushelsDlgSave").removeEventListener("click", onSave);
        byId("bushelsDlgAuto").removeEventListener("click", onAuto);
        byId("bushelsDlgCancel").removeEventListener("click", onCancel);
        byId("bushelsDlg").removeEventListener("click", onBackdrop);
        if (input) input.removeEventListener("keydown", onKey);
      }
      function onSave() {
        var v = parseFloat(input && input.value);
        if (isNaN(v) || v < 0) { appAlert("Enter a valid bushels number (0 or more)."); return; }
        state.bushels = v;
        state.bushelsManual = true;
        if (byId("mBu")) byId("mBu").textContent = Math.round(v);
        closeDlg("bushelsDlg"); cleanup(); resolve(true);
      }
      function onAuto() {
        state.bushelsManual = false;
        if (byId("mBu")) byId("mBu").textContent = Math.round(state.bushels);
        closeDlg("bushelsDlg"); cleanup(); resolve(true);
      }
      function onCancel() { closeDlg("bushelsDlg"); cleanup(); resolve(false); }
      function onBackdrop(ev) { if (ev.target === byId("bushelsDlg")) onCancel(); }
      function onKey(ev) { if (ev.key === "Enter") { ev.preventDefault(); onSave(); } }

      byId("bushelsDlgSave").addEventListener("click", onSave);
      byId("bushelsDlgAuto").addEventListener("click", onAuto);
      byId("bushelsDlgCancel").addEventListener("click", onCancel);
      byId("bushelsDlg").addEventListener("click", onBackdrop);
      if (input) input.addEventListener("keydown", onKey);
    });
  }

  // ==========================================================
  // RUNTIME PATCHING — wrap existing app.js globals (NO EDITS)
  // ==========================================================
  function applyPatches() {
    // make sure the state flag exists
    if (typeof state.bushelsManual === "undefined") state.bushelsManual = false;

    // 1) onPos -> after it runs, tag the newest trail point(s) with rate.
    if (typeof window.onPos === "function" && !window.onPos.__aaPatched) {
      var _onPos = window.onPos;
      window.onPos = function () {
        var beforeLen = (state.trailPoints && state.trailPoints.length) || 0;
        var ret = _onPos.apply(this, arguments);
        var tp = state.trailPoints || [];
        // tag any newly-added points (usually 1) that don't yet carry a rate
        for (var i = beforeLen; i < tp.length; i++) {
          if (tp[i] && tp[i].rate == null) {
            tp[i].rate = currentAppliedRate();
            tp[i].rateUnit = currentRateUnit();
          }
        }
        return ret;
      };
      window.onPos.__aaPatched = true;
    }

    // 2) drawCoveragePolygon -> if bushels is locked, restore it after the
    //    original (which would otherwise add to the auto-estimate).
    if (typeof window.drawCoveragePolygon === "function" && !window.drawCoveragePolygon.__aaPatched) {
      var _draw = window.drawCoveragePolygon;
      window.drawCoveragePolygon = function () {
        var locked = state.bushelsManual;
        var saved = state.bushels;
        var ret = _draw.apply(this, arguments);
        if (locked) state.bushels = saved;   // undo any auto-estimate bump
        return ret;
      };
      window.drawCoveragePolygon.__aaPatched = true;
    }

    // 3) updateMetrics -> after it runs, if locked, rewrite the tile with
    //    the manual value (original sets it from state.bushels which we keep).
    if (typeof window.updateMetrics === "function" && !window.updateMetrics.__aaPatched) {
      var _um = window.updateMetrics;
      window.updateMetrics = function () {
        var ret = _um.apply(this, arguments);
        if (state.bushelsManual && byId("mBu")) {
          byId("mBu").textContent = Math.round(state.bushels);
        }
        return ret;
      };
      window.updateMetrics.__aaPatched = true;
    }

    // 4) startSession -> clear the manual lock + heat overlay for a new run.
    if (typeof window.startSession === "function" && !window.startSession.__aaPatched) {
      var _ss = window.startSession;
      window.startSession = function () {
        state.bushelsManual = false;
        clearHeat();
        return _ss.apply(this, arguments);
      };
      window.startSession.__aaPatched = true;
    }
  }

  // ==========================================================
  // SAVE-REPORT HOOK — embed as-applied data into saved reports
  // We can't wrap the inline btnSave click easily, so instead we
  // post-process: when a new report appears in localStorage, attach
  // asApplied + bushelsManual and persist the layer to IndexedDB.
  // Implemented by wrapping localStorage.setItem for the reports key.
  // ==========================================================
  function hookReportSave() {
    var LS_REPS_KEY = (typeof LS_REPS !== "undefined") ? LS_REPS : "opio_reports";
    var _setItem = localStorage.setItem.bind(localStorage);
    if (localStorage.__aaSaveHooked) return;
    localStorage.setItem = function (key, value) {
      if (key === LS_REPS_KEY) {
        try {
          var obj = JSON.parse(value);
          // find report(s) missing our fields and enrich the newest one
          var ids = Object.keys(obj);
          var newest = null, newestT = -1;
          ids.forEach(function (id) {
            var r = obj[id];
            if (r && r.asApplied === undefined) {
              var t = new Date(r.date || 0).getTime() || 0;
              if (t >= newestT) { newestT = t; newest = id; }
            }
          });
          if (newest) {
            var layer = buildDataLayer();
            obj[newest].asApplied = layer;
            obj[newest].bushelsManual = !!state.bushelsManual;
            value = JSON.stringify(obj);
            // persist big geometry to IndexedDB too (best-effort)
            try { aaSave(newest, layer); } catch (e) {}
          }
        } catch (e) { /* leave value untouched on any parse error */ }
      }
      return _setItem(key, value);
    };
    localStorage.__aaSaveHooked = true;
  }

  // ==========================================================
  // DOM INJECTION — dialog, buttons, CSS (no index.html edits)
  // ==========================================================
  function injectCss() {
    if (byId("aaStyles")) return;
    var css =
      "#mBuBox{position:relative;}" +
      ".tile-edit-btn{position:absolute;top:4px;right:4px;background:transparent;" +
      "border:none;font-size:14px;line-height:1;cursor:pointer;opacity:.55;" +
      "padding:2px 4px;touch-action:manipulation;}" +
      ".tile-edit-btn:active{opacity:1;}";
    var s = document.createElement("style");
    s.id = "aaStyles"; s.textContent = css;
    document.head.appendChild(s);
  }

  function injectDialog() {
    if (byId("bushelsDlg")) return;
    var div = document.createElement("div");
    div.innerHTML =
      '<div id="bushelsDlg" class="dlg-overlay hidden" role="dialog" aria-modal="true">' +
        '<div class="dlg-card">' +
          '<div class="dlg-header"><div class="dlg-title">\uD83C\uDF3E Edit Total Bushels</div></div>' +
          '<div class="dlg-body">' +
            '<label>Total bushels harvested' +
              '<input id="dlgBushels" type="number" inputmode="decimal" min="0" step="1" placeholder="e.g. 12450" />' +
            '</label>' +
            '<div class="hint" id="dlgBushelsHint"></div>' +
          '</div>' +
          '<div class="dlg-footer">' +
            '<button id="bushelsDlgAuto" class="btn btn-ghost">\u21BA Use Auto-Estimate</button>' +
            '<button id="bushelsDlgCancel" class="btn btn-ghost">Cancel</button>' +
            '<button id="bushelsDlgSave" class="btn btn-primary">\uD83D\uDCBE Save</button>' +
          '</div>' +
        '</div>' +
      '</div>';
    document.body.appendChild(div.firstChild);
  }

  function injectBushelsPencil() {
    var box = byId("mBuBox");
    if (!box || byId("btnEditBushels")) return;
    var b = document.createElement("button");
    b.id = "btnEditBushels";
    b.type = "button";
    b.className = "tile-edit-btn";
    b.title = "Edit total bushels";
    b.setAttribute("aria-label", "Edit total bushels");
    b.textContent = "\u270F\uFE0F";
    b.addEventListener("click", showBushelsDialog);
    box.insertBefore(b, box.firstChild);
  }

  function injectExportButtons() {
    if (byId("btnExportAsApplied")) return;
    // Place next to the boundary export button if present, else on body.
    var anchor = byId("btnExportShp");
    var wrap = document.createElement("div");
    wrap.id = "aaExportWrap";
    wrap.style.marginTop = "8px";
    wrap.innerHTML =
      '<button id="btnExportAsApplied" class="btn">\uD83D\uDDFA\uFE0F Export As-Applied (Shapefile)</button> ' +
      '<button id="btnViewAsApplied" class="btn">\uD83D\uDC41\uFE0F View As-Applied Map</button>' +
      '<div class="hint" id="asAppliedHint">Exports painted coverage + applied points with a RATE column ' +
      '(GPA / bu\u00A0ac / lbs\u00A0ac) and shows a rate-colored map.</div>';
    if (anchor && anchor.parentNode) {
      anchor.parentNode.insertBefore(wrap, anchor.nextSibling);
    } else {
      document.body.appendChild(wrap);
    }
    byId("btnExportAsApplied").addEventListener("click", exportAsAppliedShapefile);
    byId("btnViewAsApplied").addEventListener("click", showHeatMap);
  }

  // ==========================================================
  // BOOT
  // ==========================================================
  ready(function () {
    try { applyPatches(); } catch (e) { console.warn("[as-applied] patch failed", e); }
    try { hookReportSave(); } catch (e) { console.warn("[as-applied] save hook failed", e); }
    injectCss();
    injectDialog();
    injectBushelsPencil();
    injectExportButtons();
    // expose a few helpers for debugging / future use
    window.OPIO_buildDataLayer = buildDataLayer;
    window.OPIO_exportAsAppliedShapefile = exportAsAppliedShapefile;
    window.OPIO_showBushelsDialog = showBushelsDialog;
    window.OPIO_showAsAppliedMap = showHeatMap;
    try { console.log("O\u03c0O As-Applied module loaded (all-in-one, no edits)."); } catch (e) {}
  });
})();
