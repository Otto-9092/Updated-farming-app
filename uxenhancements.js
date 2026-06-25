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
    function sync() {
      var c = pill.className || "";
      frame.classList.remove("gps-good", "gps-warn", "gps-bad");
      if (c.indexOf("pill-good") !== -1) frame.classList.add("gps-good");
      else if (c.indexOf("pill-warn") !== -1) frame.classList.add("gps-warn");
      else if (c.indexOf("pill-bad") !== -1) frame.classList.add("gps-bad");
    }
    sync();
    try {
      var mo = new MutationObserver(sync);
      mo.observe(pill, { attributes: true, attributeFilter: ["class"] });
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
    // Stop session: announce only (no toast spam over the Stop visuals).
    var stop = byId("btnStop");
    if (stop) stop.addEventListener("click", function () { speak("Session stopped"); });
  }

  // ----------------------------------------------------------
  // BOOTSTRAP
  // ----------------------------------------------------------
  function init() {
    wireHaptics();
    wireUndoableActions();
    wireVoiceDictation();
    wireAriaObserver();
    wireGpsBorder();
    wireMoreToggle();
    wireSettings();
    wireSuccessToasts();
  }
  if (D.readyState === "loading") D.addEventListener("DOMContentLoaded", init);
  else init();
})();
