// ============================================================
// debug-hud.js  —  OπO Farming diagnostic overlay
//
// WHAT IT DOES
//   Shows a floating black box in the bottom-right corner of the app
//   that logs the fate of every GPS position event during a session:
//     PAINTED         — a swath stripe was drawn
//     too-still       — moved less than 0.5 m, no paint
//     rejected-acc    — GPS accuracy worse than the current filter
//     rejected-speed  — speed > 60 mph (iOS speed-spike bug catcher)
//     boundary-mode   — fix consumed by boundary recorder, no paint
//     first-fix       — first valid fix of the session, lastPos seeded
//
// HOW TO USE
//   1. Keep this file in the same folder as app.js
//   2. Add this line to index.html, just before </body>, AFTER app.js:
//        <script src="debug-hud.js?v=1"></script>
//   3. Append ?debug=1 to your app URL (e.g. .../index.html?debug=1)
//   4. Start a session and walk around. Watch the HUD.
//
// SAFE TO LEAVE IN PRODUCTION
//   Without ?debug=1 in the URL, the HUD never renders and the
//   onPos() wrapper is a straight pass-through. Zero side effects.
//
// TO REMOVE
//   Delete the <script> tag from index.html. Done.
// ============================================================

(function () {
  var enabled = /[?&]debug=1\b/.test(window.location.search);
  if (!enabled) {
    // Still expose a no-op so any future caller can log without a guard.
    window.DEBUG_HUD = { enabled: false, log: function () {} };
    return;
  }

  var events = [];
  var panel = null;

  function ensurePanel() {
    if (panel) return;
    panel = document.createElement("div");
    panel.id = "debugHud";
    panel.style.cssText = [
      "position:fixed",
      "bottom:8px",
      "right:8px",
      "z-index:99999",
      "background:rgba(0,0,0,0.82)",
      "color:#0f0",
      "font:11px/1.3 ui-monospace,Menlo,Consolas,monospace",
      "padding:8px 10px",
      "border-radius:6px",
      "max-width:92vw",
      "pointer-events:none",
      "white-space:pre",
      "box-shadow:0 2px 8px rgba(0,0,0,0.4)",
      "border:1px solid #0f0"
    ].join(";");
    panel.textContent = "DEBUG HUD armed — waiting for GPS fixes…";
    (document.body || document.documentElement).appendChild(panel);
  }

  function log(fate, data) {
    ensurePanel();
    var now = new Date();
    var ts = now.toTimeString().slice(0, 8);
    events.unshift({ ts: ts, fate: fate, data: data || {} });
    if (events.length > 5) events.pop();
    render();
  }

  function render() {
    if (!panel) return;
    var lines = [];
    lines.push("DEBUG HUD  " + (window.APP_VERSION || "(no version)"));
    try {
      lines.push(
        "eq=" + (state.equipment.type || "?") +
        "  w=" + (state.equipment.width || "?") + "ft" +
        "  secF=" + state.sections.full +
        "  run=" + state.running +
        "  bAct=" + state.boundary.active
      );
    } catch (e) {
      lines.push("(state not ready)");
    }
    try {
      lines.push("filter=" + (typeof getGpsFilterKey === "function" ? getGpsFilterKey() : "?"));
    } catch (e) {
      lines.push("filter=?");
    }
    lines.push("─────────────");
    events.forEach(function (e) {
      var d = e.data;
      var row = e.ts + "  " + e.fate;
      if (d.acc != null)   row += "  acc=" + (+d.acc).toFixed(1);
      if (d.mph != null)   row += "  mph=" + (+d.mph).toFixed(1);
      if (d.moved != null) row += "  mv=" + (+d.moved).toFixed(2) + "m";
      lines.push(row);
    });
    panel.textContent = lines.join("\n");
  }

  window.DEBUG_HUD = { enabled: true, log: log, render: render };

  // ============================================================
  // Monkey-patch onPos() to tag each exit point without modifying
  // the function in app.js. We wrap it so the original logic runs
  // untouched; we just observe which branch executed by watching
  // state before and after.
  // ============================================================
  function wrapOnPos() {
    if (typeof window.onPos !== "function") {
      // app.js may not have run yet — try again shortly.
      return false;
    }
    if (window.onPos.__hudWrapped) return true;

    var original = window.onPos;

    window.onPos = function (pos) {
      var acc = pos.coords.accuracy != null ? pos.coords.accuracy : 999;
      var speedMps = pos.coords.speed;
      var MPS_TO_MPH_LOCAL = 2.23694;
      var rawMphApprox = 0;
      if (speedMps != null && !isNaN(speedMps) && speedMps >= 0) {
        rawMphApprox = speedMps * MPS_TO_MPH_LOCAL;
      }

      // --- Pre-call checks that mirror the guards in app.js ---
      // (These match the thresholds in onPos but don't change behavior.)
      var filterMax = (typeof getGpsAccuracyMax === "function") ? getGpsAccuracyMax() : 15;
      if (acc > filterMax) {
        log("rejected-acc", { acc: acc, mph: rawMphApprox });
        return original.apply(this, arguments);
      }
      if (rawMphApprox > 60) {
        log("rejected-speed", { acc: acc, mph: rawMphApprox });
        return original.apply(this, arguments);
      }
      if (state.boundary && state.boundary.active) {
        log("boundary-mode", { acc: acc, mph: rawMphApprox });
        return original.apply(this, arguments);
      }

      // --- Snapshot lastPos and painted-polygon count BEFORE the call ---
      var hadLastPos = !!state.lastPos;
      var prevLat = hadLastPos ? state.lastPos.lat : null;
      var prevLng = hadLastPos ? state.lastPos.lng : null;
      var prevPolyCount = (state.coveragePolys && state.coveragePolys.length) || 0;

      // --- Run the real onPos ---
      var ret = original.apply(this, arguments);

      // --- Classify what happened ---
      var newPolyCount = (state.coveragePolys && state.coveragePolys.length) || 0;
      var painted = newPolyCount > prevPolyCount;

      var moved = null;
      if (hadLastPos && typeof haversine === "function") {
        try {
          moved = haversine(prevLat, prevLng, pos.coords.latitude, pos.coords.longitude);
        } catch (e) { moved = null; }
      }

      if (painted) {
        log("PAINTED", { acc: acc, mph: rawMphApprox, moved: moved });
      } else if (!hadLastPos) {
        log("first-fix", { acc: acc, mph: rawMphApprox });
      } else {
        log("too-still", { acc: acc, mph: rawMphApprox, moved: moved });
      }

      return ret;
    };

    window.onPos.__hudWrapped = true;
    return true;
  }

  // app.js may finish loading after this script runs, so poll briefly
  // until onPos exists, then wrap it.
  var tries = 0;
  var maxTries = 60; // ~6 seconds at 100ms
  var timer = setInterval(function () {
    tries++;
    if (wrapOnPos() || tries >= maxTries) {
      clearInterval(timer);
      if (tries >= maxTries && !window.onPos) {
        ensurePanel();
        panel.textContent = "DEBUG HUD: couldn't find onPos() — is app.js loaded?";
      }
    }
  }, 100);

  // Also re-render periodically so state changes (equipment, filter) show
  // even if no GPS fix has arrived yet.
  setInterval(render, 2000);
})();
