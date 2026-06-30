// ============================================================
// OπO Farming — UX ENHANCEMENTS (additive, self-contained)
// Loaded AFTER app.js. Adds, without modifying core logic:
//   1. Haptic feedback (navigator.vibrate)
//   2. Toast / snackbar with optional UNDO
//   3. Voice dictation for Field Notes (Web Speech API)
//   4. ARIA labels on dynamically-generated icon buttons
//   5. Peripheral GPS-quality border (glanceable signal health)
//   6. Larger primary-action + live-metric emphasis hooks
//   7. "More" collapse memory for the Operate screen
// All features degrade gracefully if an API or element is missing.
// ============================================================
(function () {
  "use strict";

  var D = document;
  var byId = function (id) { return D.getElementById(id); };

  // ----------------------------------------------------------
  // 1. HAPTIC FEEDBACK
  // ----------------------------------------------------------
  // Patterns: tap=light confirm, ok=success, warn=destructive/error.
  var HAPTIC = { tap: 25, ok: [35, 50, 35], warn: [80, 40, 80] };
  function haptic(kind) {
    try {
      if (!navigator.vibrate) return;
      var pref = localStorage.getItem("haptics");
      if (pref === "off") return;            // user opt-out respected
      navigator.vibrate(HAPTIC[kind] != null ? HAPTIC[kind] : kind);
    } catch (e) { /* unsupported - ignore */ }
  }
  window.haptic = haptic;   // expose for any future use

  // ----------------------------------------------------------
  // 2. TOAST / SNACKBAR  (non-blocking, optional Undo)
  //    showToast("Saved", { kind:"ok", undo: fn, duration: 5000 })
  // ----------------------------------------------------------
  var toastTimer = null;
  function ensureToastHost() {
    var host = byId("toastHost");
    if (!host) {
      host = D.createElement("div");
      host.id = "toastHost";
      host.setAttribute("role", "status");
      host.setAttribute("aria-live", "polite");
      D.body.appendChild(host);
    }
    return host;
  }
  function showToast(message, opts) {
    opts = opts || {};
    var host = ensureToastHost();
    host.innerHTML = "";
    if (toastTimer) { clearTimeout(toastTimer); toastTimer = null; }

    var bar = D.createElement("div");
    bar.className = "toast toast-" + (opts.kind || "info");

    var msg = D.createElement("span");
    msg.className = "toast-msg";
    msg.textContent = message == null ? "" : String(message);
    bar.appendChild(msg);

    var duration = opts.duration || (opts.undo ? 6000 : 3000);

    if (typeof opts.undo === "function") {
      var btn = D.createElement("button");
      btn.className = "toast-undo";
      btn.type = "button";
      btn.textContent = "UNDO";
      btn.setAttribute("aria-label", "Undo: " + message);
      btn.addEventListener("click", function () {
        haptic("ok");
        try { opts.undo(); } catch (e) {}
        dismiss();
      });
      bar.appendChild(btn);
    }

    function dismiss() {
      bar.classList.add("toast-out");
      setTimeout(function () { if (bar.parentNode) bar.parentNode.removeChild(bar); }, 220);
    }
    host.appendChild(bar);
    // force reflow so the entrance transition runs
    void bar.offsetWidth;
    bar.classList.add("toast-in");
    toastTimer = setTimeout(dismiss, duration);
  }
  window.showToast = showToast;

  // ----------------------------------------------------------
  // Wire haptics + toasts onto existing buttons (no core edits)
  // ----------------------------------------------------------
  function on(id, kind) {
    var el = byId(id);
    if (el) el.addEventListener("click", function () { haptic(kind); }, true);
  }
  function wireHaptics() {
    on("btnStart", "ok");
    on("btnStop", "warn");
    on("btnSave", "ok");
    on("btnAddNote", "tap");
    on("btnRefill", "ok");
    on("btnUnload", "ok");
    on("btnBale", "ok");
    on("btnRecenter", "tap");
    on("btnSyncNow", "tap");
    on("noteSave", "ok");
    // Section + map toggles: light tap
    ["secLeft","secFull","secRight","btnOrient","btnAutoZoom","btnAutoCenter","btnTrail",
     "btnExpandMap","btnToggleMetrics","btnThemeToggle","btnSetA","btnSetB"].forEach(function (id) {
      on(id, "tap");
    });
    // Destructive: warn buzz
    ["btnResetPaint","btnClearTrail","btnClearAB","btnBoundClear","btnDeleteRep",
     "btnDeleteEq","btnDeleteField"].forEach(function (id) { on(id, "warn"); });
  }

  // ----------------------------------------------------------
  // Toast confirmations + UNDO for the two riskiest local actions:
  //   • Reset Painted Area   • Clear Trail
  // We wrap them defensively: snapshot -> let core run -> offer Undo.
  // ----------------------------------------------------------
  function wireUndoableActions() {
    // ---- Clear Trail ----
    var clearTrailBtn = byId("btnClearTrail");
    if (clearTrailBtn && window.state) {
      clearTrailBtn.addEventListener("click", function () {
        // Snapshot AFTER core handler runs on next tick (core clears it).
        var saved = (state.trailSegments || []).slice();
        var savedPts = (state.trailPoints || []).slice();
        setTimeout(function () {
          if (!saved.length && !savedPts.length) return;
          showToast("Trail cleared", {
            kind: "warn",
            undo: function () {
              try {
                saved.forEach(function (s) { if (s && s.setMap) s.setMap(state.map); });
                state.trailSegments = saved;
                state.trailPoints = savedPts;
                showToast("Trail restored", { kind: "ok" });
              } catch (e) {}
            }
          });
        }, 0);
      }, true);   // capture: snapshot reference before core mutates array identity
    }

    // ---- Reset Painted Area ----
    // appConfirm is async; we snapshot now, then watch acres to detect the reset.
    var resetBtn = byId("btnResetPaint");
    if (resetBtn && window.state) {
      resetBtn.addEventListener("click", function () {
        var snap = {
          polys: (state.coveragePolys || []).slice(),
          cells: new Set(state.coverageCells || []),
          acres: state.acres, bushels: state.bushels, gallons: state.gallons,
          effH: state.efficiencyHits, effA: state.efficiencyAttempts
        };
        var before = state.coveragePolys ? state.coveragePolys.length : 0;
        // Poll briefly for the confirm->reset to complete (max ~12s).
        var tries = 0;
        var iv = setInterval(function () {
          tries++;
          var now = state.coveragePolys ? state.coveragePolys.length : 0;
          if (now === 0 && before > 0) {
            clearInterval(iv);
            showToast("Painted area reset", {
              kind: "warn",
              undo: function () {
                try {
                  snap.polys.forEach(function (p) { if (p && p.setMap) p.setMap(state.map); });
                  state.coveragePolys = snap.polys;
                  state.coverageCells = snap.cells;
                  state.acres = snap.acres; state.bushels = snap.bushels; state.gallons = snap.gallons;
                  state.efficiencyHits = snap.effH; state.efficiencyAttempts = snap.effA;
                  if (byId("mAcres")) byId("mAcres").textContent = state.acres.toFixed(2);
                  if (byId("mBu")) byId("mBu").textContent = Math.round(state.bushels);
                  if (byId("mGal")) byId("mGal").textContent = state.gallons.toFixed(1);
                  showToast("Painted area restored", { kind: "ok" });
                } catch (e) {}
              }
            });
          } else if (tries > 120) {   // give up after ~12s (cancelled)
            clearInterval(iv);
          }
        }, 100);
      }, true);
    }
  }

  // ----------------------------------------------------------
  // 3. VOICE DICTATION for Field Notes (Web Speech API)
  // ----------------------------------------------------------
  function wireVoiceDictation() {
    var SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    var micBtn = byId("noteMicBtn");
    var ta = byId("noteText");
    if (!micBtn || !ta) return;
    if (!SR) { micBtn.style.display = "none"; return; }   // unsupported browser

    var rec = null, listening = false;
    function stop() {
      listening = false;
      micBtn.classList.remove("listening");
      micBtn.textContent = "🎤";
      micBtn.setAttribute("aria-label", "Start voice dictation");
      if (rec) { try { rec.stop(); } catch (e) {} }
    }
    micBtn.addEventListener("click", function () {
      if (listening) { stop(); return; }
      haptic("tap");
      rec = new SR();
      rec.lang = "en-US";
      rec.interimResults = true;
      rec.continuous = true;
      var base = ta.value ? (ta.value.replace(/\s+$/, "") + " ") : "";
      rec.onresult = function (ev) {
        var finalTxt = "", interim = "";
        for (var i = ev.resultIndex; i < ev.results.length; i++) {
          var r = ev.results[i];
          if (r.isFinal) finalTxt += r[0].transcript;
          else interim += r[0].transcript;
        }
        if (finalTxt) base += finalTxt + " ";
        ta.value = (base + interim).replace(/\s+/g, " ").replace(/^\s/, "");
      };
      rec.onerror = function () { showToast("Voice input unavailable", { kind: "warn" }); stop(); };
      rec.onend = function () { if (listening) { try { rec.start(); } catch (e) { stop(); } } };
      try {
        rec.start();
        listening = true;
        micBtn.classList.add("listening");
        micBtn.textContent = "🔴";
        micBtn.setAttribute("aria-label", "Stop voice dictation");
      } catch (e) { showToast("Could not start microphone", { kind: "warn" }); stop(); }
    });

    // Stop listening when the note dialog closes (cancel/save).
    ["noteCancel", "noteSave"].forEach(function (id) {
      var b = byId(id);
      if (b) b.addEventListener("click", stop);
    });
  }

  // ----------------------------------------------------------
  // 4. ARIA LABELS on dynamically-created icon/text controls.
  //    A MutationObserver labels obvious icon-only buttons so
  //    VoiceOver announces something meaningful.
  // ----------------------------------------------------------
  var ICON_LABELS = {
    "✕": "Close", "✖": "Close", "🗑": "Delete", "🗑️": "Delete",
    "✏️": "Rename", "✏": "Rename", "👁️": "View", "👁": "View",
    "📄": "Export PDF", "📍": "Location", "🎤": "Voice dictation",
    "🔴": "Stop voice dictation", "📂": "Load", "💾": "Save", "↻": "Refresh"
  };
  function labelIfIcon(el) {
    if (!el || el.getAttribute("aria-label") || el.getAttribute("title")) return;
    var txt = (el.textContent || "").trim();
    if (!txt) return;
    if (ICON_LABELS[txt]) { el.setAttribute("aria-label", ICON_LABELS[txt]); return; }
    // Pure-emoji button (no letters/numbers) -> use first key match
    if (!/[a-z0-9]/i.test(txt)) {
      for (var k in ICON_LABELS) {
        if (txt.indexOf(k) !== -1) { el.setAttribute("aria-label", ICON_LABELS[k]); return; }
      }
    }
  }
  function sweepAria(root) {
    (root || D).querySelectorAll("button").forEach(labelIfIcon);
  }
  function wireAriaObserver() {
    sweepAria(D);
    try {
      var mo = new MutationObserver(function (muts) {
        muts.forEach(function (m) {
          m.addedNodes && m.addedNodes.forEach(function (n) {
            if (n.nodeType !== 1) return;
            if (n.tagName === "BUTTON") labelIfIcon(n);
            if (n.querySelectorAll) n.querySelectorAll("button").forEach(labelIfIcon);
          });
        });
      });
      mo.observe(D.body, { childList: true, subtree: true });
    } catch (e) { /* observer unsupported - one-time sweep already done */ }
  }

  // ----------------------------------------------------------
  // 5. PERIPHERAL GPS-QUALITY BORDER
  //    Mirrors the #gpsPill class onto a full-screen frame so a
  //    degrading fix is visible without reading text.
  // ----------------------------------------------------------
  function wireGpsBorder() {
    var frame = byId("gpsFrame");
    if (!frame) {
      frame = D.createElement("div");
      frame.id = "gpsFrame";
      frame.setAttribute("aria-hidden", "true");
      D.body.appendChild(frame);
    }
    var pill = byId("gpsPill");
    if (!pill) return;

    // Show the border ONLY when a session is actively running.
    function sessionRunning() {
      try {
        if (window.state && typeof window.state.running === "boolean") return window.state.running;
      } catch (e) {}
      // Fallback: the Stop button is enabled only while running.
      var stop = byId("btnStop");
      return !!(stop && stop.disabled === false);
    }
    // User on/off switch (default ON). Stored in localStorage as "gpsBorder".
    function borderEnabled() {
      try { return localStorage.getItem("gpsBorder") !== "off"; } catch (e) { return true; }
    }

    function sync() {
      frame.classList.remove("gps-good", "gps-warn", "gps-bad");
      // Hidden entirely unless enabled AND a session is running.
      if (!borderEnabled() || !sessionRunning()) return;
      var c = pill.className || "";
      if (c.indexOf("pill-good") !== -1) frame.classList.add("gps-good");
      else if (c.indexOf("pill-warn") !== -1) frame.classList.add("gps-warn");
      else if (c.indexOf("pill-bad") !== -1) frame.classList.add("gps-bad");
    }
    // Expose so the Settings toggle can refresh the border live.
    window._opioSyncGpsBorder = sync;

    sync();
    try {
      // React to GPS-quality changes (pill class) ...
      var mo = new MutationObserver(sync);
      mo.observe(pill, { attributes: true, attributeFilter: ["class"] });
      // ... and to Start/Stop (which enable/disable the Stop button).
      var stop = byId("btnStop");
      var start = byId("btnStart");
      if (stop) {
        var mo2 = new MutationObserver(sync);
        mo2.observe(stop, { attributes: true, attributeFilter: ["disabled"] });
      }
      // Belt-and-suspenders: also re-check on clicks.
      if (start) start.addEventListener("click", function () { setTimeout(sync, 50); });
      if (stop) stop.addEventListener("click", function () { setTimeout(sync, 50); });
    } catch (e) {}
  }

  // ----------------------------------------------------------
  // 7. "MORE" collapse memory on the Operate screen
  // ----------------------------------------------------------
  function wireMoreToggle() {
    var btn = byId("btnToggleMore");
    var wrap = byId("operateMore");
    if (!btn || !wrap) return;
    function apply(open) {
      wrap.classList.toggle("hidden", !open);
      btn.setAttribute("aria-expanded", open ? "true" : "false");
      btn.textContent = open ? "▲ Fewer controls" : "⋯ More controls";
    }
    var open = false;
    try { open = localStorage.getItem("operateMoreOpen") === "1"; } catch (e) {}
    apply(open);
    btn.addEventListener("click", function () {
      haptic("tap");
      open = wrap.classList.contains("hidden");
      apply(open);
      try { localStorage.setItem("operateMoreOpen", open ? "1" : "0"); } catch (e) {}
    });
  }

  // ----------------------------------------------------------
  // 8. SPOKEN CONFIRMATIONS (optional, off by default)
  // ----------------------------------------------------------
  function speak(text) {
    try {
      if (localStorage.getItem("voiceFeedback") !== "on") return;
      if (!("speechSynthesis" in window)) return;
      var u = new SpeechSynthesisUtterance(String(text));
      u.rate = 1.0; u.volume = 1.0;
      window.speechSynthesis.cancel();   // don't stack utterances
      window.speechSynthesis.speak(u);
    } catch (e) { /* unsupported - ignore */ }
  }
  window.speak = speak;

  // ----------------------------------------------------------
  // 9. SETTINGS TOGGLES (haptics + spoken confirmations)
  // ----------------------------------------------------------
  function wireSettings() {
    var h = byId("setHaptics");
    if (h) {
      // Default ON unless explicitly turned off.
      var hapOff = false;
      try { hapOff = localStorage.getItem("haptics") === "off"; } catch (e) {}
      h.checked = !hapOff;
      // Hide the toggle entirely on devices with no vibration support.
      if (!navigator.vibrate) {
        var row = h.closest ? h.closest(".setting-row") : null;
        if (row) row.style.opacity = "0.5";
      }
      h.addEventListener("change", function () {
        try { localStorage.setItem("haptics", h.checked ? "on" : "off"); } catch (e) {}
        if (h.checked) haptic("ok");
      });
    }
    var v = byId("setVoiceFeedback");
    if (v) {
      var vOn = false;
      try { vOn = localStorage.getItem("voiceFeedback") === "on"; } catch (e) {}
      v.checked = vOn;
      if (!("speechSynthesis" in window)) {
        var vrow = v.closest ? v.closest(".setting-row") : null;
        if (vrow) vrow.style.opacity = "0.5";
      }
      v.addEventListener("change", function () {
        try { localStorage.setItem("voiceFeedback", v.checked ? "on" : "off"); } catch (e) {}
        if (v.checked) speak("Spoken confirmations on");
      });
    }
    var g = byId("setGpsBorder");
    if (g) {
      var gOff = false;
      try { gOff = localStorage.getItem("gpsBorder") === "off"; } catch (e) {}
      g.checked = !gOff;   // default ON unless explicitly turned off
      g.addEventListener("change", function () {
        try { localStorage.setItem("gpsBorder", g.checked ? "on" : "off"); } catch (e) {}
        // Refresh the border immediately so the change is visible.
        try { if (window._opioSyncGpsBorder) window._opioSyncGpsBorder(); } catch (e) {}
      });
    }
    var rt = byId("btnReplayTour");
    if (rt) {
      rt.addEventListener("click", function () {
        haptic("tap");
        if (window._opioStartTour) window._opioStartTour();
      });
    }
  }

  // ----------------------------------------------------------
  // 10. TOAST + SPOKEN CONFIRMATIONS for common success actions.
  //     Listens on existing buttons; no core-logic changes.
  // ----------------------------------------------------------
  function confirmAction(id, message, kind, spokenText) {
    var el = byId(id);
    if (!el) return;
    el.addEventListener("click", function () {
      // Defer so the core handler runs first (it may open a dialog).
      setTimeout(function () {
        showToast(message, { kind: kind || "ok" });
        speak(spokenText || message);
      }, 0);
    });
  }
  function wireSuccessToasts() {
    confirmAction("btnStart", "Session started", "ok", "Session started");
    confirmAction("btnRefill", "Tank refilled", "ok", "Tank refilled");
    confirmAction("btnUnload", "Grain unloaded", "ok", "Grain unloaded");
    confirmAction("btnBale", "Bale counted", "ok", "Bale counted");
    confirmAction("btnLoadField", "Field loaded", "ok", "Field loaded");
    confirmAction("btnSaveField", "Field saved", "ok", "Field saved");
    confirmAction("btnLoadEq", "Equipment loaded", "ok", "Equipment loaded");
    confirmAction("btnSaveEq", "Equipment saved", "ok", "Equipment saved");
    confirmAction("noteSave", "Note saved", "ok", "Note saved");
    // Stop session is handled by wireHoldToStop() below (hold-to-confirm),
    // which also speaks "Session stopped" when it actually stops.
  }

  // ----------------------------------------------------------
  // SESSION SUMMARY (shown when a session ends via hold-to-Stop)
  //   captureSessionSummary() reads the live totals BEFORE stopSession
  //   resets anything; showSessionSummary() renders a recap card with a
  //   one-tap "Save Report" that routes to the app's existing Save flow.
  // ----------------------------------------------------------
  function captureSessionSummary() {
    var st = window.state || {};
    function n(v) { return (typeof v === "number" && isFinite(v)) ? v : 0; }
    var avg = (st.speedCount > 0) ? (st.speedSum / st.speedCount) : 0;
    var elapsedMs = st.sessionStart ? (Date.now() - st.sessionStart) : 0;
    var elapsedHr = elapsedMs / 3600000;
    var acres = n(st.acres);
    var acresPerHr = elapsedHr > 0 ? (acres / elapsedHr) : 0;
    var type = (st.equipment && st.equipment.type) || "none";
    return {
      fieldName: (st.field && st.field.name) || "",
      crop: (st.field && st.field.crop) || "",
      equipName: (st.equipment && st.equipment.name) || "",
      equipType: type,
      acres: acres,
      boundaryAcres: n(st.boundary && st.boundary.acres),
      bushels: n(st.bushels),
      gallons: n(st.gallons),
      loads: n(st.loads),
      bales: n(st.bales),
      avgSpeed: avg,
      maxSpeed: n(st.speedMax),
      acresPerHr: acresPerHr,
      elapsedMs: elapsedMs
    };
  }

  function fmtDuration(ms) {
    var mins = Math.max(0, Math.round(ms / 60000));
    var h = Math.floor(mins / 60), m = mins % 60;
    return h > 0 ? (h + "h " + m + "m") : (m + "m");
  }

  function showSessionSummary(s) {
    if (!s) return;
    var existing = byId("sessionSummaryOverlay");
    if (existing) existing.remove();

    var overlay = D.createElement("div");
    overlay.id = "sessionSummaryOverlay";
    overlay.className = "ss-overlay";

    var card = D.createElement("div");
    card.className = "ss-card";
    overlay.appendChild(card);

    // Header
    var title = s.fieldName ? ("\u201c" + s.fieldName + "\u201d") : "Session";
    var sub = [s.crop, s.equipName].filter(Boolean).join(" \u00b7 ");
    var head = D.createElement("div");
    head.className = "ss-head";
    head.innerHTML = "<div class=\"ss-title\">\u2705 Session complete</div>" +
      "<div class=\"ss-sub\">" + title + (sub ? (" &middot; " + sub) : "") + "</div>";
    card.appendChild(head);

    // Build the stat rows relevant to this equipment type.
    var stats = [];
    stats.push(["\u23f1 Time", fmtDuration(s.elapsedMs)]);
    var acresStr = s.acres.toFixed(2) + " ac";
    if (s.boundaryAcres > 0) {
      var pct = Math.min(100, Math.round((s.acres / s.boundaryAcres) * 100));
      acresStr += " of " + s.boundaryAcres.toFixed(2) + " (" + pct + "%)";
    }
    stats.push(["\ud83c\udf3e Acres", acresStr]);
    stats.push(["\u26a1 Acres/hr", s.acresPerHr.toFixed(2)]);
    stats.push(["\ud83d\ude9c Avg speed", s.avgSpeed.toFixed(1) + " mph"]);
    stats.push(["\ud83d\udca8 Max speed", s.maxSpeed.toFixed(1) + " mph"]);
    if (s.equipType === "combine") {
      stats.push(["\ud83c\udf3d Bushels", Math.round(s.bushels).toLocaleString()]);
      if (s.loads > 0) stats.push(["\ud83d\ude9b Unloads", String(s.loads)]);
    } else if (s.equipType === "sprayer") {
      if (s.gallons > 0) stats.push(["\ud83d\udca7 Gallons", Math.round(s.gallons).toLocaleString()]);
      if (s.loads > 0) stats.push(["\ud83d\udd04 Refills", String(s.loads)]);
    } else if (s.equipType === "baler") {
      if (s.bales > 0) stats.push(["\ud83d\udfe1 Bales", String(s.bales)]);
    } else if (s.equipType === "spreader") {
      if (s.loads > 0) stats.push(["\ud83d\udd04 Refills", String(s.loads)]);
    }

    var grid = D.createElement("div");
    grid.className = "ss-grid";
    stats.forEach(function (row) {
      var cell = D.createElement("div");
      cell.className = "ss-stat";
      cell.innerHTML = "<div class=\"ss-label\">" + row[0] + "</div>" +
                       "<div class=\"ss-value\">" + row[1] + "</div>";
      grid.appendChild(cell);
    });
    card.appendChild(grid);

    // Action buttons.
    var actions = D.createElement("div");
    actions.className = "ss-actions";
    var saveBtn = D.createElement("button");
    saveBtn.className = "btn btn-primary";
    saveBtn.textContent = "\ud83d\udcbe Save Report";
    var closeBtn = D.createElement("button");
    closeBtn.className = "btn btn-ghost";
    closeBtn.textContent = "Close";

    saveBtn.addEventListener("click", function () {
      haptic("ok");
      overlay.remove();
      // Route to the app's existing Save Report flow.
      var realSave = byId("btnSave");
      if (realSave) realSave.click();
      else showToast("Save Report button not found", { kind: "warn" });
    });
    closeBtn.addEventListener("click", function () {
      haptic("tap");
      overlay.remove();
    });
    overlay.addEventListener("click", function (e) {
      if (e.target === overlay) overlay.remove();   // tap backdrop to dismiss
    });

    actions.appendChild(saveBtn);
    actions.appendChild(closeBtn);
    card.appendChild(actions);

    D.body.appendChild(overlay);
  }
  // ----------------------------------------------------------
  // 11. HOLD-TO-STOP GUARD
  //     A single tap on Stop no longer ends the session (too easy to
  //     hit by accident in a moving cab). The user must PRESS AND HOLD
  //     for ~1.5s; a progress ring fills and a haptic fires, then the
  //     real stopSession() runs. Tapping briefly shows a hint toast.
  // ----------------------------------------------------------
  function wireHoldToStop() {
    var btn = byId("btnStop");
    if (!btn) return;

    var HOLD_MS = 1500;
    var holdTimer = null;
    var rafId = null;
    var startTs = 0;
    var fired = false;
    var originalLabel = btn.textContent;

    // Visual fill: a conic-gradient overlay that grows as you hold.
    function setProgress(pct) {
      // pct 0..1 -> green sweep on the button background
      if (pct <= 0) { btn.style.backgroundImage = ""; return; }
      var deg = Math.round(pct * 360);
      btn.style.backgroundImage =
        "conic-gradient(rgba(214,59,41,0.85) " + deg + "deg, rgba(0,0,0,0.08) " + deg + "deg)";
    }

    function clearHold() {
      if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; }
      if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
      setProgress(0);
      btn.textContent = originalLabel;
    }

    function tick() {
      var elapsed = Date.now() - startTs;
      var pct = Math.min(elapsed / HOLD_MS, 1);
      setProgress(pct);
      btn.textContent = "Hold to stop\u2026 " + Math.ceil((HOLD_MS - elapsed) / 1000) + "s";
      if (pct < 1) rafId = requestAnimationFrame(tick);
    }

    function begin(e) {
      // Only guard while a session is actually running.
      if (btn.disabled) return;
      if (e && e.type === "mousedown" && e.button !== 0) return;
      fired = false;
      startTs = Date.now();
      originalLabel = (btn.textContent || "").indexOf("Hold") === -1 ? btn.textContent : originalLabel;
      haptic("tap");
      rafId = requestAnimationFrame(tick);
      holdTimer = setTimeout(function () {
        fired = true;
        clearHold();
        haptic("warn");
        try { speak("Session stopped"); } catch (_) {}
        // Capture the session totals BEFORE stopping (stopSession may
        // reset UI tiles), then run the app's real stop, then show the
        // summary card.
        var summary = captureSessionSummary();
        if (typeof window.stopSession === "function") {
          try { window.stopSession(); } catch (_) {}
        } else {
          btn._opioForceStop = true;
          btn.click();
        }
        try { showSessionSummary(summary); } catch (e) { try { console.warn("[ux] summary failed:", e); } catch (_) {} }
      }, HOLD_MS);
    }

    function cancel() {
      if (fired) return;            // already stopped; nothing to undo
      var wasHolding = !!(holdTimer || rafId);
      clearHold();
      if (wasHolding) {
        showToast("Hold the Stop button for 1.5s to end the session", { kind: "warn", duration: 2600 });
      }
    }

    // Swallow plain clicks so a quick tap never calls stopSession().
    btn.addEventListener("click", function (e) {
      if (btn._opioForceStop) { btn._opioForceStop = false; return; }  // our own synthetic click
      e.preventDefault();
      e.stopImmediatePropagation();
    }, true);  // capture phase: run before app.js's own click handler

    // Pointer / touch / mouse press lifecycle.
    btn.addEventListener("pointerdown", begin);
    btn.addEventListener("pointerup", cancel);
    btn.addEventListener("pointerleave", cancel);
    btn.addEventListener("pointercancel", cancel);
    // Fallbacks for older browsers without Pointer Events.
    if (!("PointerEvent" in window)) {
      btn.addEventListener("mousedown", begin);
      btn.addEventListener("mouseup", cancel);
      btn.addEventListener("mouseleave", cancel);
      btn.addEventListener("touchstart", begin, { passive: true });
      btn.addEventListener("touchend", cancel);
      btn.addEventListener("touchcancel", cancel);
    }
  }

  // ----------------------------------------------------------
  // 12. AUTO-RESUME (crash / accidental-refresh recovery)
  //     While a session runs, periodically snapshot the recoverable
  //     totals to localStorage. On load, if an UNFINISHED snapshot is
  //     found (recent, and not cleanly stopped), offer to resume the
  //     running totals and keep tracking forward.
  //
  //     NOTE: this restores the NUMBERS (acres, bushels, gallons,
  //     loads, bales, elapsed time, field/equipment) so you never lose
  //     your tallies. It does not redraw the previously-painted
  //     coverage map (that lives in core app.js); tracking continues
  //     forward from the moment you resume.
  // ----------------------------------------------------------
  function wireAutoResume() {
    var KEY = "opioSessionSnapshot";
    var MAX_AGE_MS = 12 * 60 * 60 * 1000;   // ignore snapshots older than 12h
    var SNAP_EVERY_MS = 10000;              // save every 10s while running

    var st = window.state;
    if (!st) return;   // core not loaded; nothing to snapshot

    function num(v) { return (typeof v === "number" && isFinite(v)) ? v : 0; }

    function takeSnapshot() {
      try {
        if (!st.running) return;
        var snap = {
          savedAt: Date.now(),
          sessionStart: st.sessionStart || Date.now(),
          acres: num(st.acres),
          bushels: num(st.bushels),
          gallons: num(st.gallons),
          loads: num(st.loads),
          bales: num(st.bales),
          fieldName: (st.field && st.field.name) || "",
          crop: (st.field && st.field.crop) || "",
          equipName: (st.equipment && st.equipment.name) || "",
          equipType: (st.equipment && st.equipment.type) || "none"
        };
        localStorage.setItem(KEY, JSON.stringify(snap));
      } catch (e) {}
    }

    function clearSnapshot() {
      try { localStorage.removeItem(KEY); } catch (e) {}
    }

    function readSnapshot() {
      try {
        var raw = localStorage.getItem(KEY);
        if (!raw) return null;
        var s = JSON.parse(raw);
        if (!s || !s.savedAt) return null;
        if (Date.now() - s.savedAt > MAX_AGE_MS) { clearSnapshot(); return null; }
        return s;
      } catch (e) { return null; }
    }

    function fmtElapsed(ms) {
      var mins = Math.max(0, Math.round(ms / 60000));
      var h = Math.floor(mins / 60), m = mins % 60;
      return h > 0 ? (h + "h " + m + "m") : (m + "m");
    }

    // ----- the resume banner -----
    function showResumeBanner(snap) {
      if (byId("resumeBanner")) return;
      var bar = D.createElement("div");
      bar.id = "resumeBanner";
      bar.setAttribute("role", "alertdialog");
      bar.setAttribute("aria-live", "assertive");

      var elapsed = fmtElapsed((snap.savedAt || Date.now()) - (snap.sessionStart || snap.savedAt));
      var where = snap.fieldName ? (" in \u201c" + snap.fieldName + "\u201d") : "";
      var msg = D.createElement("div");
      msg.className = "resume-msg";
      msg.innerHTML =
        "\u26a0\ufe0f <b>Unfinished session found</b>" + where + "<br>" +
        "Running about " + elapsed + " \u2014 " + snap.acres.toFixed(2) + " ac" +
        (snap.bushels > 0 ? ", " + Math.round(snap.bushels) + " bu" : "") +
        (snap.gallons > 0 ? ", " + Math.round(snap.gallons) + " gal" : "") + ".";

      var row = D.createElement("div");
      row.className = "resume-actions";
      var resumeBtn = D.createElement("button");
      resumeBtn.className = "btn";
      resumeBtn.textContent = "\u25b6 Resume tracking";
      var discardBtn = D.createElement("button");
      discardBtn.className = "btn btn-ghost";
      discardBtn.textContent = "Discard";

      resumeBtn.addEventListener("click", function () {
        haptic("ok");
        doResume(snap);
        bar.remove();
      });
      discardBtn.addEventListener("click", function () {
        haptic("tap");
        clearSnapshot();
        bar.remove();
      });

      row.appendChild(resumeBtn);
      row.appendChild(discardBtn);
      bar.appendChild(msg);
      bar.appendChild(row);
      D.body.appendChild(bar);
    }

    // ----- restore totals + continue a live session -----
    function doResume(snap) {
      try {
        st.acres = num(snap.acres);
        st.bushels = num(snap.bushels);
        st.gallons = num(snap.gallons);
        st.loads = num(snap.loads);
        st.bales = num(snap.bales);
        // Keep elapsed time continuous: shift sessionStart back by prior elapsed.
        var priorElapsed = (snap.savedAt || Date.now()) - (snap.sessionStart || snap.savedAt);
        st.sessionStart = Date.now() - Math.max(0, priorElapsed);

        // Push the recovered numbers onto the live tiles, using whatever
        // refresh hooks the core exposes (best-effort, all optional).
        if (typeof window.updateMetrics === "function") { try { window.updateMetrics(); } catch (e) {} }
        if (typeof window.updateTankAndLoads === "function") { try { window.updateTankAndLoads(); } catch (e) {} }
        if (typeof window.updateHarvestTile === "function") { try { window.updateHarvestTile(); } catch (e) {} }

        // Resume live GPS tracking by reusing the app's Start button only if
        // not already running. We DO NOT auto-start to avoid wiping totals
        // (startSession resets to zero). Instead we just re-enable tracking
        // state and let the user keep driving; the next onPos accumulates.
        showToast("Session resumed \u2014 totals restored. Tap Start only if GPS isn\u2019t tracking.",
                  { kind: "ok", duration: 5000 });
        try { speak("Session resumed"); } catch (e) {}
      } catch (e) {
        try { console.warn("[ux] resume failed:", e); } catch (_) {}
      }
    }

    // On a clean stop, drop the snapshot so we don't offer to resume it.
    var stopBtn = byId("btnStop");
    if (stopBtn) {
      // stopSession disables the Stop button; watch for that as "stopped".
      try {
        var mo = new MutationObserver(function () {
          if (stopBtn.disabled) clearSnapshot();
        });
        mo.observe(stopBtn, { attributes: true, attributeFilter: ["disabled"] });
      } catch (e) {}
    }

    // Periodic snapshot while running.
    setInterval(takeSnapshot, SNAP_EVERY_MS);
    // Also snapshot right before the page is hidden/closed.
    window.addEventListener("visibilitychange", function () {
      if (D.visibilityState === "hidden") takeSnapshot();
    });
    window.addEventListener("pagehide", takeSnapshot);

    // On load: if a fresh unfinished snapshot exists and we are NOT already
    // running, offer to resume.
    var snap = readSnapshot();
    if (snap && !st.running) {
      // small delay so the app shell + tiles exist first
      setTimeout(function () { showResumeBanner(snap); }, 800);
    }
  }

  // ----------------------------------------------------------
  // 13. FIELD ALERTS — GPS-lost + low-battery warnings
  //     Loud, glanceable, and spoken (if voice is on) so problems are
  //     caught even when your eyes are on the field. Active only while
  //     a session is running. Debounced so they never spam.
  // ----------------------------------------------------------
  function wireFieldAlerts() {
    var st = window.state;

    function sessionRunning() {
      try { if (st && typeof st.running === "boolean") return st.running; } catch (e) {}
      var stop = byId("btnStop");
      return !!(stop && stop.disabled === false);
    }

    // ---- GPS-lost / poor-signal alert ----
    var pill = byId("gpsPill");
    if (pill) {
      var lastBad = false;
      var lastAlertTs = 0;
      var GPS_COOLDOWN = 20000;   // at most one GPS alert per 20s

      function checkGps() {
        if (!sessionRunning()) { lastBad = false; return; }
        var c = pill.className || "";
        var isBad = c.indexOf("pill-bad") !== -1;
        // Fire only on the GOOD/usable -> BAD transition.
        if (isBad && !lastBad) {
          var now = Date.now();
          if (now - lastAlertTs > GPS_COOLDOWN) {
            lastAlertTs = now;
            haptic("warn");
            showToast("\u26a0\ufe0f GPS signal lost or weak \u2014 coverage may be inaccurate",
                      { kind: "warn", duration: 6000 });
            try { speak("Warning. GPS signal lost."); } catch (e) {}
          }
        }
        lastBad = isBad;
      }
      checkGps();
      try {
        var mo = new MutationObserver(checkGps);
        mo.observe(pill, { attributes: true, attributeFilter: ["class"] });
      } catch (e) {}
    }

    // ---- Low-battery alert (Battery Status API; unsupported on iOS) ----
    // Warns once at <=20% and again at <=10% while a session runs.
    function setupBattery(bat) {
      var warned20 = false, warned10 = false;
      function level() { return Math.round((bat.level || 0) * 100); }
      function check() {
        if (bat.charging) { warned20 = warned10 = false; return; }  // plugged in: reset
        if (!sessionRunning()) return;
        var pct = level();
        if (pct <= 10 && !warned10) {
          warned10 = true; warned20 = true;
          haptic("warn");
          showToast("\ud83d\udd0b Battery critical (" + pct + "%) \u2014 plug in to avoid losing your session",
                    { kind: "warn", duration: 8000 });
          try { speak("Battery critical. " + pct + " percent."); } catch (e) {}
        } else if (pct <= 20 && !warned20) {
          warned20 = true;
          haptic("warn");
          showToast("\ud83d\udd0b Battery low (" + pct + "%) \u2014 consider charging soon",
                    { kind: "warn", duration: 6000 });
          try { speak("Battery low. " + pct + " percent."); } catch (e) {}
        }
        if (pct > 25) { warned20 = false; }   // re-arm 20% warning after recovery
        if (pct > 12) { warned10 = false; }
      }
      bat.addEventListener("levelchange", check);
      bat.addEventListener("chargingchange", check);
      check();
    }
    try {
      if (navigator.getBattery) {
        navigator.getBattery().then(setupBattery).catch(function () {});
      }
    } catch (e) { /* unsupported (e.g. iOS Safari) - silently skip */ }
  }

  // ----------------------------------------------------------
  // 14. CONNECTIVITY + SYNC STATUS PILL (offline banner + last-synced)
  //     A glanceable pill in the header status row. Reads the SAME data
  //     the app's own sync system uses (navigator.onLine, the
  //     dof_last_synced timestamp, and GoogleSync.isSignedIn) so it can
  //     never disagree with the Settings sync panel. Tapping it jumps to
  //     the Tools tab where sync lives.
  // ----------------------------------------------------------
  function wireConnectivityBar() {
    var LS_LAST_SYNCED = "dof_last_synced";   // must match app.js

    // Inject the pill into the header status row (next to GPS/IDLE).
    var host = D.querySelector(".status-pills");
    var pill = byId("connPill");
    if (!pill) {
      pill = D.createElement("button");
      pill.id = "connPill";
      pill.className = "pill conn-pill";
      pill.type = "button";
      pill.setAttribute("aria-label", "Connection and sync status");
      if (host) host.insertBefore(pill, host.firstChild);
      else D.body.appendChild(pill);
    }

    function signedIn() {
      try { return !!(window.GoogleSync && window.GoogleSync.isSignedIn && window.GoogleSync.isSignedIn()); }
      catch (e) { return false; }
    }

    function ago(iso) {
      if (!iso) return null;
      var then = new Date(iso).getTime();
      if (!isFinite(then)) return null;
      var s = Math.max(0, Math.round((Date.now() - then) / 1000));
      if (s < 60) return "just now";
      var m = Math.round(s / 60);
      if (m < 60) return m + "m ago";
      var h = Math.round(m / 60);
      if (h < 24) return h + "h ago";
      var d = Math.round(h / 24);
      return d + "d ago";
    }

    var wasOffline = false;

    function render() {
      var online = (typeof navigator.onLine === "boolean") ? navigator.onLine : true;
      pill.classList.remove("conn-offline", "conn-ok", "conn-warn", "conn-idle");

      if (!online) {
        pill.classList.add("conn-offline");
        pill.textContent = "\ud83d\udcf4 Offline \u2014 saved locally";
        pill.title = "You're offline. Work is saved on this device and will sync when you're back online.";
        // Announce the transition into offline once.
        if (!wasOffline) {
          wasOffline = true;
          haptic("warn");
          showToast("\ud83d\udcf4 You\u2019re offline \u2014 data is saved locally and will sync later",
                    { kind: "warn", duration: 5000 });
        }
        return;
      }

      // Back online: announce recovery if we were offline.
      if (wasOffline) {
        wasOffline = false;
        showToast("\u2705 Back online", { kind: "ok", duration: 3000 });
      }

      if (!signedIn()) {
        pill.classList.add("conn-idle");
        pill.textContent = "\u2601\ufe0f Sync off";
        pill.title = "Online. Sign in under Tools \u203a Cloud Sync to back up across devices.";
        return;
      }

      var iso = null;
      try { iso = localStorage.getItem(LS_LAST_SYNCED); } catch (e) {}
      var rel = ago(iso);
      if (rel) {
        pill.classList.add("conn-ok");
        pill.textContent = "\u2601\ufe0f Synced " + rel;
        pill.title = "Last synced: " + new Date(iso).toLocaleString();
      } else {
        pill.classList.add("conn-warn");
        pill.textContent = "\u2601\ufe0f Not synced yet";
        pill.title = "Signed in, but no sync has completed on this device yet.";
      }
    }

    // Tap the pill -> jump to the Tools tab (where Cloud Sync lives).
    pill.addEventListener("click", function () {
      haptic("tap");
      var toolsTab = D.querySelector('.tab[data-tab="tools"]');
      if (toolsTab) toolsTab.click();
      var box = byId("syncSignedIn") || byId("syncSignedOut");
      if (box && box.scrollIntoView) {
        setTimeout(function () { box.scrollIntoView({ behavior: "smooth", block: "center" }); }, 120);
      }
    });

    window.addEventListener("online", render);
    window.addEventListener("offline", render);
    setInterval(render, 30000);   // refresh "x min ago" + catch sync updates
    // Also expose so app.js could call it after a sync if desired.
    window._opioRefreshConnPill = render;
    render();
  }

  // ----------------------------------------------------------
  // 15. FIRST-RUN ONBOARDING TOUR
  //     A lightweight spotlight tour shown once on first launch (and
  //     re-runnable from Settings). Each step highlights a real element
  //     with a cutout + tooltip. Skippable at any time.
  // ----------------------------------------------------------
  function wireOnboardingTour() {
    var SEEN_KEY = "opioTourSeen";

    // Steps reference live elements by a resolver so missing ones are skipped.
    function steps() {
      return [
        { sel: null, title: "\ud83d\udc4b Welcome to O\u03c0O Farming",
          body: "Quick 6-step tour so you can start tracking in under a minute. Tap Next \u2014 or Skip anytime." },
        { sel: '.tab[data-tab="setup"]', title: "1\ufe0f\u20e3 Set up your gear",
          body: "Start here. Pick your equipment type and field so the app knows what you\u2019re running." },
        { sel: "#btnStart", title: "2\ufe0f\u20e3 Start a session",
          body: "Back on Operate, tap Start to begin tracking your coverage, speed, and acres live." },
        { sel: "#connPill", title: "3\ufe0f\u20e3 Stay synced",
          body: "This pill shows if you\u2019re online and how fresh your last cloud backup is. Tap it to manage sync." },
        { sel: "#btnSave", title: "4\ufe0f\u20e3 Save your report",
          body: "When the job\u2019s done, save a report \u2014 acres, bushels, time and more, ready to review or export." },
        { sel: "#btnToggleMore", title: "5\ufe0f\u20e3 More controls",
          body: "Tap here for extra tools when you need them. That\u2019s it \u2014 you\u2019re ready to roll!" }
      ];
    }

    var idx = 0, list = [], overlay = null;

    function cleanup() {
      if (overlay) { overlay.remove(); overlay = null; }
      window.removeEventListener("resize", reposition);
      window.removeEventListener("scroll", reposition, true);
    }

    function finish() {
      try { localStorage.setItem(SEEN_KEY, "1"); } catch (e) {}
      cleanup();
    }

    function buildOverlay() {
      overlay = D.createElement("div");
      overlay.id = "tourOverlay";
      overlay.innerHTML =
        '<div class="tour-cutout"></div>' +
        '<div class="tour-pop">' +
        '  <div class="tour-title"></div>' +
        '  <div class="tour-body"></div>' +
        '  <div class="tour-actions">' +
        '    <button class="btn btn-ghost tour-skip">Skip</button>' +
        '    <span class="tour-spacer"></span>' +
        '    <button class="btn btn-ghost tour-back">Back</button>' +
        '    <button class="btn btn-primary tour-next">Next</button>' +
        '  </div>' +
        '</div>';
      D.body.appendChild(overlay);
      overlay.querySelector(".tour-skip").addEventListener("click", function () { haptic("tap"); finish(); });
      overlay.querySelector(".tour-back").addEventListener("click", function () { haptic("tap"); if (idx > 0) { idx--; renderStep(); } });
      overlay.querySelector(".tour-next").addEventListener("click", function () {
        haptic("tap");
        if (idx < list.length - 1) { idx++; renderStep(); } else { finish(); }
      });
    }

    function reposition() {
      if (!overlay) return;
      var step = list[idx];
      var cut = overlay.querySelector(".tour-cutout");
      var pop = overlay.querySelector(".tour-pop");
      var el = step.sel ? D.querySelector(step.sel) : null;

      if (el && el.getBoundingClientRect) {
        var r = el.getBoundingClientRect();
        var pad = 8;
        cut.style.display = "block";
        cut.style.top = (r.top - pad) + "px";
        cut.style.left = (r.left - pad) + "px";
        cut.style.width = (r.width + pad * 2) + "px";
        cut.style.height = (r.height + pad * 2) + "px";
        // Place the popover below the target if room, else above.
        var below = r.bottom + 12;
        var popH = pop.offsetHeight || 160;
        if (below + popH > window.innerHeight - 8) {
          pop.style.top = Math.max(8, r.top - popH - 12) + "px";
        } else {
          pop.style.top = below + "px";
        }
        var left = Math.min(Math.max(8, r.left), window.innerWidth - (pop.offsetWidth || 300) - 8);
        pop.style.left = left + "px";
        pop.style.transform = "";
      } else {
        // Centered (welcome / missing element)
        cut.style.display = "none";
        pop.style.top = "50%";
        pop.style.left = "50%";
        pop.style.transform = "translate(-50%, -50%)";
      }
    }

    function renderStep() {
      var step = list[idx];
      // If a step targets a missing element, skip forward/back past it.
      if (step.sel && !D.querySelector(step.sel)) {
        if (idx < list.length - 1) { idx++; return renderStep(); }
        else { return finish(); }
      }
      overlay.querySelector(".tour-title").textContent = step.title;
      overlay.querySelector(".tour-body").textContent = step.body;
      overlay.querySelector(".tour-back").style.visibility = idx === 0 ? "hidden" : "visible";
      overlay.querySelector(".tour-next").textContent = (idx === list.length - 1) ? "Done" : "Next";
      reposition();
    }

    function start() {
      list = steps();
      idx = 0;
      if (!overlay) buildOverlay();
      window.addEventListener("resize", reposition);
      window.addEventListener("scroll", reposition, true);
      renderStep();
    }

    // Expose so a Settings button can replay the tour.
    window._opioStartTour = start;

    // Auto-run once, after the shell settles.
    var seen = false;
    try { seen = localStorage.getItem(SEEN_KEY) === "1"; } catch (e) {}
    if (!seen) setTimeout(start, 1200);
  }

  // ----------------------------------------------------------
  // BOOTSTRAP
  function init() {
    // Each wiring step is isolated so one failure can never prevent the
    // others from running (e.g. a missing API must not disable the More toggle).
    var steps = [
      ["haptics", wireHaptics],
      ["undoableActions", wireUndoableActions],
      ["voiceDictation", wireVoiceDictation],
      ["ariaObserver", wireAriaObserver],
      ["gpsBorder", wireGpsBorder],
      ["moreToggle", wireMoreToggle],
      ["settings", wireSettings],
      ["successToasts", wireSuccessToasts],
      ["holdToStop", wireHoldToStop],
      ["autoResume", wireAutoResume],
      ["fieldAlerts", wireFieldAlerts],
      ["connectivityBar", wireConnectivityBar],
      ["onboardingTour", wireOnboardingTour]
    ];
    steps.forEach(function (s) {
      try { s[1](); }
      catch (e) { try { console.warn("[ux] " + s[0] + " failed:", e); } catch (_) {} }
    });
  }
  if (D.readyState === "loading") D.addEventListener("DOMContentLoaded", init);
  else init();
})();
