// ============================================================
// OπO Farming — YIELD MONITOR MODULE (self-contained)
// ------------------------------------------------------------
// Adds a "Yield Monitor" top-level tab with three sub-sections:
//   • Setup       — Web Serial connection to the ESP32
//   • Calibration — pass workflow, K computation, calibration history
//   • History     — full run list and locked K values per crop
//
// Fully additive: does NOT modify app.js state or existing tabs.
// The new tab button and panel are INJECTED into the DOM after DOMContentLoaded.
//
// Depends only on globals app.js already defines:
//   $, $id, openDlg, closeDlg, appAlert, appConfirm, state
//
// Web Serial:
//   • REQUIRES A DESKTOP BROWSER (Chrome or Edge on Windows, macOS,
//     Linux, or ChromeOS). Web Serial is NOT implemented in Chrome for
//     Android — this was confirmed on-device 30/09/2026 on a Galaxy Tab
//     S9 FE (SM-X518U, Chrome 154, Android 16). navigator.serial simply
//     does not exist on mobile Chromium. The Wi-Fi/WebSocket transport
//     (planned for v1.3+ firmware) is the mobile path — see the roadmap.
//   • iOS Safari also does not support Web Serial.
//   • On unsupported browsers the tab still works for browsing
//     calibration history and manually entering pass data.
//     browsing calibration history but the "Connect" button will explain
//     that live capture requires a Chromium browser.
//   • Connection is persisted via getPorts() so re-plugging the ESP32
//     reconnects automatically.
//
// BUILD 2026.10.22-31 (field-hardening patch)
//   - Board identity check: auto-reconnect no longer grabs "the first port".
//     It opens candidates one at a time, listens for yield-sensor lines
//     (EVT / [t=..]) and drops any port streaming NMEA (the GPS board).
//     Ports already open elsewhere (e.g. the RTK pill) are skipped.
//   - Recording guard: live elapsed time / paddle count, warnings if the
//     sensor link drops or event numbers skip, auto-reconnect while
//     recording, screen wake lock, unload warning, unsaved-pass confirm,
//     confirm before Stop.
//   - Safe save: storage-full is caught (nothing is lost, the pass stays on
//     screen). Raw events are stored compactly, or skipped on long passes
//     (K only needs the excess total). Raw events CSV download button.
//   - Truck-scale entry: NET pounds + moisture % -> bushels at standard
//     moisture (corn 15.5%). Passes with dropouts save as EXCLUDED.
//   - Excess total is recomputed at Stop so the last second is counted.
//
// Firmware expected: yield_monitor_combine v1.2+ with CSV_STREAM enabled.
//   Status line format:
//     [t=Ns] paddles=N rate=N Hz beam=... short=N wide=N
//       baseline_us=N last_valid_us=N excess_us=N
//   Event line format:
//     EVT,<count>,<t_us>,<width_us>,<filter_flag>
//       filter_flag: 0=valid, 1=short anomaly, 2=marker paddle
// ============================================================
(function () {
  "use strict";

  // ----------------------------------------------------------
  // CONSTANTS
  // ----------------------------------------------------------
  var LS_RUNS       = "dof_ym_runs";
  var LS_LOCKED_K   = "dof_ym_lockedK";
  var LS_TOMB_RUNS  = "dof_tomb_ym_runs";
  var LS_LAST_PORT  = "dof_ym_last_port_id"; // saved after user permission grant

  // Bushel weight per crop (lbs/bu). Used to convert weigh tickets in lbs.
  var BU_WEIGHTS = {
    "Corn":       56,
    "Soybean":    60,
    "Soybeans":   60,
    "Wheat":      60,
    "Sorghum":    56,
    "Sunflower":  32,
    "Alfalfa":    60,
    "Barley":     48,
    "Oats":       32,
    "Other":      60
  };

  // Standard moisture (%) used to convert wet weigh-ticket pounds to bushels.
  // Corn 15.5 is the one you calibrate on; the others are the usual market
  // standards and have NOT been field-checked in this app.
  var STD_MOISTURE = {
    "Corn": 15.5, "Soybean": 13, "Soybeans": 13, "Wheat": 13.5,
    "Sorghum": 14, "Sunflower": 10, "Barley": 14.5, "Oats": 14
  };
  // Raw events are only stored with a pass when the pass is short enough.
  var EVENT_STORE_MAX = 15000;

  // Regex patterns for parsing serial output
  var EVT_RE_V12   = /^EVT,(\d+),(\d+),(\d+),(\d+)\s*$/;   // v1.2 5-column
  var EVT_RE_OLD   = /^EVT,(\d+),(\d+),(\d+)\s*$/;         // v0.5 4-column
  var STATUS_RE    = /^\[t=(\d+)s\]\s+paddles=(\d+)\s+rate=([\d.]+)\s*Hz\s+beam=(\S+)\s+(?:short=(\d+)\s+wide=(\d+)\s+)?(?:filtered=(\d+)\s+)?baseline_us=(\d+)\s+last_(?:valid|width)_us=(\d+)\s+excess_us=(\d+)/;

  // ----------------------------------------------------------
  // HELPERS
  // ----------------------------------------------------------
  function byId(id) { return document.getElementById(id); }
  function ready(fn) {
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", fn);
    else fn();
  }
  function nowIso() { return new Date().toISOString(); }
  function newId() { return "ym-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8); }
  function esc(s) { return String(s == null ? "" : s).replace(/[<>&"']/g, function (c) {
    return {"<":"&lt;",">":"&gt;","&":"&amp;",'"':"&quot;","'":"&#39;"}[c];
  }); }
  function fmtNum(n, digits) {
    if (n == null || !isFinite(n)) return "—";
    return Number(n).toLocaleString(undefined, { maximumFractionDigits: (digits == null ? 2 : digits) });
  }
  function fmtDate(d) {
    if (!d) return "—";
    try { return new Date(d).toLocaleDateString(); } catch (e) { return String(d); }
  }

  // ----------------------------------------------------------
  // STORAGE
  // ----------------------------------------------------------
  function runsGet() { try { return JSON.parse(localStorage.getItem(LS_RUNS) || "{}"); } catch (e) { return {}; } }
  function runsSet(o) { try { localStorage.setItem(LS_RUNS, JSON.stringify(o)); return true; } catch (e) { return false; } }
  function lockedGet() { try { return JSON.parse(localStorage.getItem(LS_LOCKED_K) || "{}"); } catch (e) { return {}; } }
  function lockedSet(o) { try { localStorage.setItem(LS_LOCKED_K, JSON.stringify(o)); return true; } catch (e) { return false; } }
  function tombGet() { try { return JSON.parse(localStorage.getItem(LS_TOMB_RUNS) || "{}"); } catch (e) { return {}; } }
  function tombSet(o) { localStorage.setItem(LS_TOMB_RUNS, JSON.stringify(o)); }

  function saveRun(run) {
    var runs = runsGet();
    run._modified = nowIso();
    if (!run.savedAt) run.savedAt = nowIso();
    if (!run.id) run.id = newId();
    runs[run.id] = run;
    if (!runsSet(runs)) return false;     // storage full: nothing written
    recomputeLockedK(run.crop);
    renderHistory();
    renderCalibration();
    return true;
  }
  function deleteRun(id) {
    var runs = runsGet();
    var run = runs[id];
    if (!run) return;
    delete runs[id];
    runsSet(runs);
    var tombs = tombGet();
    tombs[id] = nowIso();
    tombSet(tombs);
    if (run.crop) recomputeLockedK(run.crop);
    renderHistory();
    renderCalibration();
  }

  // ----------------------------------------------------------
  // K COMPUTATION
  // ----------------------------------------------------------
  // K = bushels / total_excess_us  (units: bushels per microsecond)
  function computeK(run) {
    var bu = Number(run.weighTicketBushels || 0);
    var ex = Number(run.totalExcessUs || 0);
    if (bu <= 0 || ex <= 0) return null;
    return bu / ex;
  }
  function recomputeLockedK(crop) {
    if (!crop) return;
    var runs = runsGet();
    var list = Object.values(runs).filter(function (r) {
      return r.crop === crop && !r.excludedFromAverage && computeK(r) != null;
    });
    var locked = lockedGet();
    if (list.length < 3) {
      // Not enough passes yet — reflect that in the locked record
      locked[crop] = {
        value: list.length ? list.reduce(function (a, r) { return a + computeK(r); }, 0) / list.length : null,
        nPasses: list.length,
        stdevPct: null,
        status: "pending",
        lastUpdated: nowIso()
      };
    } else {
      var ks = list.map(computeK);
      var mean = ks.reduce(function (a, b) { return a + b; }, 0) / ks.length;
      var variance = ks.reduce(function (a, b) { return a + (b - mean) * (b - mean); }, 0) / ks.length;
      var stdev = Math.sqrt(variance);
      var stdevPct = (stdev / mean) * 100;
      locked[crop] = {
        value: mean,
        nPasses: list.length,
        stdevPct: stdevPct,
        status: stdevPct <= 2 ? "locked" : "needs-review",
        lastUpdated: nowIso()
      };
    }
    lockedSet(locked);
  }

  // ----------------------------------------------------------
  // WEB SERIAL — connection state (module-scoped)
  // ----------------------------------------------------------
  var _port = null;
  var _reader = null;
  var _readAbort = false;
  var _lineBuf = "";
  // Live state extracted from the serial stream
  var _live = {
    connected: false,
    paddles: 0,       rate: 0,        beam: "—",
    baseline_us: 0,   last_width_us: 0, excess_us: 0,
    short: 0,         wide: 0,
    firstEvtNum: null, lastEvtNum: null,
    validEvents: 0,   totalExcessUs: 0,
    recording: false,
    _recordStartCount: 0,
    _recordStartExcess: 0,
    // build 31
    identity: null,   foreignLines: 0,  lastEvtAt: 0,
    dropouts: 0,      missedEvents: 0,  counterResets: 0,
    _recLastEvt: null
  };
  // Buffered events for full CSV export at end of pass
  var _recordedEvents = [];

  function webSerialSupported() {
    return "serial" in navigator && typeof navigator.serial.requestPort === "function";
  }

  function statusText(s) {
    var el = byId("ymConnStatus");
    if (el) el.textContent = s;
  }
  function setConnected(on) {
    _live.connected = on;
    var btn = byId("ymConnectBtn");
    if (btn) {
      btn.textContent = on ? "Disconnect" : "Connect Sensor";
      btn.classList.toggle("btn-primary", !on);
      btn.classList.toggle("btn-danger", on);
    }
    var dot = byId("ymConnDot");
    if (dot) dot.classList.toggle("connected", on);
    renderLive();
  }

  // ----------------------------------------------------------
  // CONNECTION  (build 31: identity check, no blind port grabbing)
  // ----------------------------------------------------------
  var _connecting = false;
  var _wakeLock = null;
  var _pendingUnsaved = false;
  var _recTimer = null;
  var _reconnTimer = null;

  function portInfoOf(p) {
    try { return (p && p.getInfo) ? (p.getInfo() || {}) : {}; } catch (e) { return {}; }
  }
  function rememberPort(p) {
    var i = portInfoOf(p);
    if (i.usbVendorId == null) return;
    try { localStorage.setItem(LS_LAST_PORT, JSON.stringify({ v: i.usbVendorId, p: i.usbProductId })); } catch (e) {}
  }
  function savedPortInfo() {
    try { return JSON.parse(localStorage.getItem(LS_LAST_PORT) || "null"); } catch (e) { return null; }
  }
  function matchScore(p, saved) {
    if (!saved || typeof saved !== "object") return 0;
    var i = portInfoOf(p);
    return (i.usbVendorId === saved.v && i.usbProductId === saved.p) ? 1 : 0;
  }

  async function openPort(port) {
    await port.open({ baudRate: 115200 });
    _port = port;
    _readAbort = false;
    _lineBuf = "";
    _live.identity = null;
    _live.foreignLines = 0;
    setConnected(true);
    readLoop(port);   // fire-and-forget
  }

  // Resolves "yield" | "foreign" | "silent" | "lost"
  function waitIdentity(ms) {
    return new Promise(function (resolve) {
      var t0 = Date.now();
      (function poll() {
        if (_live.identity) return resolve(_live.identity);
        if (!_live.connected) return resolve("lost");
        if (Date.now() - t0 >= ms) return resolve("silent");
        setTimeout(poll, 100);
      })();
    });
  }

  // Reconnect without prompting. Tries each already-permitted port that is
  // not open elsewhere; keeps the one that speaks the yield-sensor protocol.
  async function autoConnect() {
    if (_connecting || _live.connected) return;
    _connecting = true;
    try {
      var granted = await navigator.serial.getPorts();
      if (!granted.length) { statusText("No previously-connected sensor"); return; }
      var saved = savedPortInfo();
      var cands = granted.filter(function (p) { return !p.readable; });
      cands.sort(function (a, b) { return matchScore(b, saved) - matchScore(a, saved); });
      if (!cands.length) { statusText("Serial ports are in use by another tool"); return; }
      for (var i = 0; i < cands.length; i++) {
        try { await openPort(cands[i]); } catch (e) { continue; }
        var id = await waitIdentity(5000);
        if (id === "yield") { rememberPort(cands[i]); statusText("Connected"); return; }
        if (id === "silent" && cands.length === 1) { statusText("Connected - no data yet"); return; }
        await disconnectSensor(true);   // GPS board, silent among several, or lost
      }
      statusText(granted.length > 1
        ? "Yield sensor not found - tap Connect Sensor and pick its board"
        : "No previously-connected sensor");
    } finally {
      _connecting = false;
    }
  }

  async function connectSensor(promptUser) {
    if (!webSerialSupported()) {
      appAlert(
        "Web Serial live capture requires a DESKTOP browser " +
        "(Chrome or Edge on Windows, macOS, Linux, or ChromeOS).\n\n" +
        "Chrome for Android does NOT support Web Serial \u2014 plugging an " +
        "ESP32 into the tablet via USB will not work, no matter the cable " +
        "or OTG adapter. iPad/iPhone Safari is also unsupported.\n\n" +
        "Mobile support is coming via Wi-Fi (planned firmware v1.3). " +
        "Until then, run live capture from a laptop, or use this tab on " +
        "the tablet to browse history and enter pass data manually.",
        "Live capture needs a desktop browser"
      );
      return;
    }
    if (_live.connected) return;
    if (_connecting) { statusText("Still checking ports - try again in a few seconds"); return; }
    try {
      if (!promptUser) { await autoConnect(); return; }
      var port = await navigator.serial.requestPort({});
      if (port.readable) {
        appAlert("That serial port is already open in another part of the app " +
                 "(probably the RTK pill). Pick the other board \u2014 the yield sensor.",
                 "Port already in use");
        return;
      }
      _connecting = true;
      try {
        await openPort(port);
        statusText("Connected - checking board...");
        var id = await waitIdentity(8000);
        if (id === "foreign") {
          await disconnectSensor(true);
          statusText("That is the GPS board, not the yield sensor");
          appAlert("That port is the GPS / RTK board (it is sending NMEA position data), " +
                   "not the yield sensor. Tap Connect Sensor again and pick the other board " +
                   "\u2014 the yield sensor is the one that was on COM4.",
                   "Wrong board");
          return;
        }
        if (id === "yield") { rememberPort(port); statusText("Connected"); }
        else if (id === "silent") statusText("Connected - no data yet");
      } finally {
        _connecting = false;
      }
    } catch (e) {
      if (e && e.name === "NotFoundError") { statusText("No port selected"); return; }
      statusText("Connect failed: " + (e && e.message || e));
      setConnected(false);
    }
  }

  async function disconnectSensor(silent) {
    var wasRecording = _live.recording;
    _readAbort = true;
    try { if (_reader) { await _reader.cancel(); } } catch (e) {}
    try { if (_reader) _reader.releaseLock(); } catch (e) {}
    _reader = null;
    try { if (_port) { await _port.close(); } } catch (e) {}
    _port = null;
    setConnected(false);
    statusText("Disconnected");
    if (wasRecording && silent !== true) markDropout("sensor disconnected by user");
  }

  async function readLoop(port) {
    var decoder = new TextDecoder();
    var reader = null;
    try {
      reader = port.readable.getReader();
      _reader = reader;
      while (!_readAbort) {
        var chunk = await reader.read();
        if (chunk.done) break;
        _lineBuf += decoder.decode(chunk.value, { stream: true });
        var idx;
        while ((idx = _lineBuf.indexOf("\n")) !== -1) {
          var line = _lineBuf.slice(0, idx).replace(/\r$/, "");
          _lineBuf = _lineBuf.slice(idx + 1);
          handleSerialLine(line);
        }
      }
    } catch (e) {
      if (!_readAbort) statusText("Read error: " + (e && e.message || e));
    } finally {
      try { if (reader) reader.releaseLock(); } catch (e) {}
      if (_reader === reader) _reader = null;
      if (!_readAbort && _port === port) {      // unplugged / dropped
        try { await port.close(); } catch (e) {}
        _port = null;
        setConnected(false);
        statusText("Sensor disconnected");
        if (_live.recording) markDropout("USB link dropped");
      }
    }
  }

  // Identity: yield lines mark the board as the sensor; NMEA marks it foreign.
  function classifyLine(line) {
    if (line.indexOf("EVT,") === 0) _live.lastEvtAt = Date.now();
    if (_live.identity === "yield") return;
    if (EVT_RE_V12.test(line) || EVT_RE_OLD.test(line) || STATUS_RE.test(line)) {
      _live.identity = "yield";
      _live.foreignLines = 0;
      return;
    }
    if (/^\$G[A-Z]{3,4},/.test(line)) {
      _live.foreignLines++;
      if (_live.foreignLines >= 2) _live.identity = "foreign";
    }
  }

  function scheduleReconnect() {
    if (_reconnTimer) return;
    _reconnTimer = setInterval(function () {
      if (_live.connected || !_live.recording) { clearInterval(_reconnTimer); _reconnTimer = null; return; }
      autoConnect().catch(function () {});
    }, 3000);
  }

  function markDropout(reason) {
    _live.dropouts++;
    updateRecStatus();
    scheduleReconnect();
    if (typeof appAlert === "function") {
      appAlert("Sensor connection lost while recording (" + reason + ").\n\n" +
               "Grain counted during the gap is missing, so this pass is now flagged and " +
               "will be saved EXCLUDED from the K average. The app will try to reconnect " +
               "on its own; you can keep recording or stop and discard this pass.",
               "Recording interrupted");
    }
  }

  // Event numbers should climb by 1. A jump = missed events; a drop = sensor reboot.
  function trackGap(n) {
    var last = _live._recLastEvt;
    if (last != null) {
      if (n > last + 1) _live.missedEvents += (n - last - 1);
      else if (n <= last) _live.counterResets++;
    }
    _live._recLastEvt = n;
  }

  function ymRequestWakeLock() {
    try {
      if (navigator.wakeLock && navigator.wakeLock.request) {
        navigator.wakeLock.request("screen").then(function (l) { _wakeLock = l; }).catch(function () { _wakeLock = null; });
      }
    } catch (e) { _wakeLock = null; }
  }
  function ymReleaseWakeLock() {
    try { if (_wakeLock) _wakeLock.release(); } catch (e) {}
    _wakeLock = null;
  }

  function installGuards() {
    window.addEventListener("beforeunload", function (e) {
      if (_live.recording || _pendingUnsaved) {
        e.preventDefault();
        e.returnValue = "";
        return "";
      }
    });
    document.addEventListener("visibilitychange", function () {
      if (document.visibilityState === "visible" && _live.recording) ymRequestWakeLock();
    });
  }

  function handleSerialLine(line) {
    classifyLine(line);
    // Try EVT lines first (they're the common case)
    var m = EVT_RE_V12.exec(line);
    if (m) {
      var evtNum = +m[1], t_us = +m[2], w_us = +m[3], flag = +m[4];
      if (_live.firstEvtNum == null) _live.firstEvtNum = evtNum;
      _live.lastEvtNum = evtNum;
      if (_live.recording) {
        trackGap(evtNum);
        _recordedEvents.push({ n: evtNum, t: t_us, w: w_us, f: flag });
        if (flag === 0) {
          _live.validEvents++;
          // We don't have baseline here — that comes from the status line.
          // We'll accumulate excess at the moment we see status snapshots.
        }
      }
      return;
    }
    // Old 4-column format fallback
    m = EVT_RE_OLD.exec(line);
    if (m) {
      var evtNum2 = +m[1], t_us2 = +m[2], w_us2 = +m[3];
      if (_live.firstEvtNum == null) _live.firstEvtNum = evtNum2;
      _live.lastEvtNum = evtNum2;
      if (_live.recording) {
        trackGap(evtNum2);
        _recordedEvents.push({ n: evtNum2, t: t_us2, w: w_us2, f: 0 });
        _live.validEvents++;
      }
      return;
    }
    // Status line
    m = STATUS_RE.exec(line);
    if (m) {
      _live.paddles       = +m[2];
      _live.rate          = +m[3];
      _live.beam          = m[4];
      _live.short         = +(m[5] || m[7] || 0);
      _live.wide          = +(m[6] || 0);
      _live.baseline_us   = +m[8];
      _live.last_width_us = +m[9];
      _live.excess_us     = +m[10];
      renderLive();
      // Accumulate excess for a recording — use per-event excess from the
      // running buffer, applying the CURRENT baseline snapshot.
      if (_live.recording && _live.baseline_us > 0) {
        // Recompute total excess from recorded events using latest baseline
        var total = 0, valid = 0;
        for (var i = 0; i < _recordedEvents.length; i++) {
          var ev = _recordedEvents[i];
          if (ev.f !== 0) continue;
          valid++;
          var d = ev.w - _live.baseline_us;
          if (d > 0) total += d;
        }
        _live.validEvents = valid;
        _live.totalExcessUs = total;
      }
      return;
    }
  }

  // ----------------------------------------------------------
  // TAB INJECTION
  // ----------------------------------------------------------
  function injectTab() {
    var nav = document.querySelector("nav.tabs");
    if (!nav || byId("tab-yield")) return;
    // Add tab button
    var btn = document.createElement("button");
    btn.className = "tab";
    btn.setAttribute("data-tab", "yield");
    btn.textContent = "Yield Monitor";
    nav.appendChild(btn);
    // Add panel
    var main = document.querySelector("main");
    if (!main) return;
    var panel = document.createElement("section");
    panel.id = "tab-yield";
    panel.className = "tab-panel";
    panel.innerHTML = panelHTML();
    main.appendChild(panel);
    // Wire up the tab-switch hook (app.js already installs a click listener
    // on all .tab buttons at load — but our button was added AFTER that, so
    // we install our own that mirrors the same behavior).
    btn.addEventListener("click", function () {
      document.querySelectorAll(".tab").forEach(function (x) { x.classList.remove("active"); });
      document.querySelectorAll(".tab-panel").forEach(function (x) { x.classList.remove("active"); });
      btn.classList.add("active");
      panel.classList.add("active");
      renderAll();
    });
    // Wire up all the buttons inside the panel
    wirePanel();
  }

  function panelHTML() {
    return '' +
    '<div class="ym-container">' +
    '  <div class="ym-subtabs" role="tablist">' +
    '    <button class="ym-subtab active" data-sub="setup">Setup</button>' +
    '    <button class="ym-subtab" data-sub="calibration">Calibration</button>' +
    '    <button class="ym-subtab" data-sub="history">History</button>' +
    '  </div>' +

    // ---- SETUP ----
    '  <div id="ym-sub-setup" class="ym-sub active">' +
    '    <div class="card">' +
    '      <div class="card-title">Sensor Connection</div>' +
    '      <div class="ym-conn-row">' +
    '        <div id="ymConnDot" class="ym-dot"></div>' +
    '        <div id="ymConnStatus" class="ym-conn-status">Not connected</div>' +
    '        <button id="ymConnectBtn" class="btn btn-primary">Connect Sensor</button>' +
    '      </div>' +
    '      <div class="ym-help">' +
    '        <b>How to connect (desktop only):</b> on a Windows, Mac, ' +
    '        Linux, or ChromeOS laptop running Chrome or Edge, plug the ' +
    '        ESP32 in via USB, tap <b>Connect Sensor</b>, and pick the ' +
    '        ESP32 (usually shown as "CP210x" or "USB Serial") from the ' +
    '        browser prompt.<br/><br/>' +
    '        <b>On a tablet or phone?</b> Chrome for Android and Safari ' +
    '        on iOS do not support Web Serial — no cable or OTG adapter ' +
    '        will change that. Mobile live capture is coming via Wi-Fi ' +
    '        (firmware v1.3+). For now, use a laptop for live capture, ' +
    '        or browse history and enter passes manually here.<br/><br/>' +
    '        <b>Not seeing the ESP32 on a laptop?</b> Make sure Arduino ' +
    '        IDE is fully closed and no other program is holding the ' +
    '        serial port — only one can hold it at a time.' +
    '      </div>' +
    '    </div>' +

    '    <div class="card">' +
    '      <div class="card-title">Live Sensor Readout</div>' +
    '      <div id="ymLiveGrid" class="ym-live-grid"></div>' +
    '      <div class="ym-help">These update once per second when the ESP32 is streaming.</div>' +
    '    </div>' +
    '  </div>' +

    // ---- CALIBRATION ----
    '  <div id="ym-sub-calibration" class="ym-sub">' +
    '    <div class="card">' +
    '      <div class="card-title">Locked calibration factors (K)</div>' +
    '      <div id="ymLockedList" class="ym-locked-list"></div>' +
    '      <div class="ym-help">K is <i>bushels per microsecond</i> of excess paddle width. ' +
    '      Locks after 3 passes agree within 2%.</div>' +
    '    </div>' +

    '    <div class="card">' +
    '      <div class="card-title">Record a calibration pass</div>' +
    '      <div class="ym-cal-controls">' +
    '        <label>Crop' +
    '          <select id="ymCalCrop"></select>' +
    '        </label>' +
    '        <label>Field' +
    '          <select id="ymCalField"></select>' +
    '        </label>' +
    '        <label>Notes' +
    '          <input id="ymCalNotes" type="text" placeholder="Optional"/>' +
    '        </label>' +
    '      </div>' +
    '      <div class="ym-cal-record">' +
    '        <button id="ymRecStartBtn" class="btn btn-primary">Start recording</button>' +
    '        <button id="ymRecStopBtn" class="btn btn-danger hidden">Stop recording</button>' +
    '        <span id="ymRecStatus" class="ym-rec-status">Not recording</span>' +
    '      </div>' +
    '      <div id="ymRecSummary" class="ym-rec-summary hidden"></div>' +
    '    </div>' +
    '  </div>' +

    // ---- HISTORY ----
    '  <div id="ym-sub-history" class="ym-sub">' +
    '    <div class="card">' +
    '      <div class="card-title">Calibration history</div>' +
    '      <div id="ymHistoryList" class="ym-history-list"></div>' +
    '    </div>' +
    '  </div>' +

    '</div>';
  }

  function wirePanel() {
    // Subtab switching
    document.querySelectorAll(".ym-subtab").forEach(function (b) {
      b.addEventListener("click", function () {
        document.querySelectorAll(".ym-subtab").forEach(function (x) { x.classList.remove("active"); });
        document.querySelectorAll(".ym-sub").forEach(function (x) { x.classList.remove("active"); });
        b.classList.add("active");
        byId("ym-sub-" + b.dataset.sub).classList.add("active");
        renderAll();
      });
    });
    // Connect
    byId("ymConnectBtn").addEventListener("click", function () {
      if (_live.connected) disconnectSensor();
      else connectSensor(true);
    });
    // Record
    byId("ymRecStartBtn").addEventListener("click", startRecording);
    byId("ymRecStopBtn").addEventListener("click", stopRecording);
  }

  // ----------------------------------------------------------
  // RECORDING
  // ----------------------------------------------------------
  // ----------------------------------------------------------
  // RECORDING  (build 31: guarded, truck-scale friendly)
  // ----------------------------------------------------------
  function confirmAsync(msg, title, okLabel) {
    if (typeof appConfirm === "function") return appConfirm(msg, { title: title || "Please confirm", okLabel: okLabel || "OK" });
    return Promise.resolve(typeof confirm === "function" ? confirm(msg) : true);
  }
  function fmtDur(sec) {
    sec = Math.max(0, Math.round(sec));
    var h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), x = sec % 60;
    return (h ? h + ":" + (m < 10 ? "0" : "") : "") + m + ":" + (x < 10 ? "0" : "") + x;
  }
  function recomputeExcess() {
    if (!(_live.baseline_us > 0)) return;
    var total = 0, valid = 0;
    for (var i = 0; i < _recordedEvents.length; i++) {
      var ev = _recordedEvents[i];
      if (ev.f !== 0) continue;
      valid++;
      var d = ev.w - _live.baseline_us;
      if (d > 0) total += d;
    }
    _live.validEvents = valid;
    _live.totalExcessUs = total;
  }
  function updateRecStatus() {
    var el = byId("ymRecStatus");
    if (!el || !_live.recording) return;
    var sec = (Date.now() - _live._recordStartTime.getTime()) / 1000;
    var txt = "Recording " + fmtDur(sec) + " \u00B7 " + fmtNum(_live.validEvents, 0) + " paddles";
    if (!_live.connected) txt += " \u00B7 SENSOR OFFLINE, reconnecting";
    else if (_live.lastEvtAt) txt += " \u00B7 last paddle " + Math.round((Date.now() - _live.lastEvtAt) / 1000) + " s ago";
    if (_live.missedEvents) txt += " \u00B7 missed " + _live.missedEvents;
    if (_live.counterResets) txt += " \u00B7 sensor reset " + _live.counterResets + "x";
    if (_live.dropouts) txt += " \u00B7 DROPOUTS " + _live.dropouts;
    el.textContent = txt;
    el.style.color = (!_live.connected || _live.dropouts || _live.counterResets) ? "#c0392b" : "";
  }
  function stopRecTimers() {
    if (_recTimer) { clearInterval(_recTimer); _recTimer = null; }
  }

  async function startRecording() {
    if (!_live.connected || _live.identity !== "yield") {
      appAlert("Connect the yield sensor first (Setup tab -> Connect Sensor). " +
               "Recording needs live paddle data from the sensor board.", "Sensor not ready");
      return;
    }
    var crop = byId("ymCalCrop").value;
    var field = byId("ymCalField").value;
    if (!crop) { appAlert("Pick a crop first."); return; }
    if (_pendingUnsaved) {
      var ok = await confirmAsync("A finished pass has not been saved yet. Starting a new recording throws it away. Continue?",
                                  "Unsaved pass", "Discard and start");
      if (!ok) return;
      _recordedEvents = [];
      _pendingUnsaved = false;
    }
    _live.recording = true;
    _live._recordCrop = crop;
    _live._recordField = field;
    _live._recordNotes = byId("ymCalNotes").value || "";
    _live._recordStartTime = new Date();
    _recordedEvents = [];
    _live.validEvents = 0;
    _live.totalExcessUs = 0;
    _live.dropouts = 0;
    _live.missedEvents = 0;
    _live.counterResets = 0;
    _live._recLastEvt = null;
    byId("ymRecStartBtn").classList.add("hidden");
    byId("ymRecStopBtn").classList.remove("hidden");
    byId("ymRecSummary").classList.add("hidden");
    stopRecTimers();
    _recTimer = setInterval(updateRecStatus, 1000);
    ymRequestWakeLock();
    updateRecStatus();
  }

  async function stopRecording() {
    if (!_live.recording) return;
    var go = await confirmAsync("Stop recording? Only stop after the LAST tank of this truckload is completely unloaded into the truck.",
                                "Stop recording", "Stop");
    if (!go || !_live.recording) return;
    recomputeExcess();
    _live.recording = false;
    stopRecTimers();
    ymReleaseWakeLock();
    _pendingUnsaved = true;
    var duration = (Date.now() - _live._recordStartTime.getTime()) / 1000;
    _live._recordDuration = duration;
    byId("ymRecStartBtn").classList.remove("hidden");
    byId("ymRecStopBtn").classList.add("hidden");
    byId("ymRecStatus").textContent = "Stopped.";
    byId("ymRecStatus").style.color = "";

    var warn = [];
    if (_live.dropouts) warn.push("The sensor link dropped " + _live.dropouts + " time(s). Grain during the gap was not counted, so this pass will be saved EXCLUDED.");
    if (_live.counterResets) warn.push("The sensor restarted " + _live.counterResets + " time(s) mid-pass. This pass will be saved EXCLUDED.");
    if (_live.missedEvents) warn.push(fmtNum(_live.missedEvents, 0) + " paddle event(s) were missed in the serial stream.");
    if (_live.validEvents < 50) warn.push("Only " + _live.validEvents + " valid paddles were counted. Is this the right pass?");
    var warnHtml = warn.length
      ? '<div class="ym-summary-row" style="color:#c0392b"><b>Check:</b> ' + warn.map(esc).join(" ") + '</div>'
      : '';

    var summary = byId("ymRecSummary");
    summary.classList.remove("hidden");
    summary.innerHTML =
      '<div class="ym-summary-row">Duration: <b>' + fmtDur(duration) + '</b></div>' +
      '<div class="ym-summary-row">Valid events: <b>' + fmtNum(_live.validEvents, 0) + '</b></div>' +
      '<div class="ym-summary-row">Total excess: <b>' + fmtNum(_live.totalExcessUs, 0) + ' \u00B5s</b></div>' +
      warnHtml +
      '<div class="ym-summary-row"><i>Truck scale: enter the NET weight (gross minus tare) of everything in this recording, with the elevator moisture.</i></div>' +
      '<div class="ym-summary-row">' +
      '  <label>Net weight' +
      '    <input id="ymWTAmount" type="number" step="0.01" placeholder="0"/>' +
      '  </label>' +
      '  <label>Units' +
      '    <select id="ymWTUnits">' +
      '      <option value="lbs">Pounds (net)</option>' +
      '      <option value="bu">Bushels (already corrected)</option>' +
      '    </select>' +
      '  </label>' +
      '  <label>Moisture % (pounds only)' +
      '    <input id="ymWTMoist" type="number" step="0.1" placeholder="e.g. 18.0"/>' +
      '  </label>' +
      '  <label>Source (optional)' +
      '    <input id="ymWTSource" type="text" placeholder="Elevator, ticket #, etc."/>' +
      '  </label>' +
      '</div>' +
      '<div class="ym-summary-row" id="ymWTPreview"></div>' +
      '<div class="ym-summary-row">' +
      '  <button id="ymSaveRun" class="btn btn-primary">Save Pass</button>' +
      '  <button id="ymDownloadEvents" class="btn">Download raw events (CSV)</button>' +
      '  <button id="ymDiscardRun" class="btn">Discard</button>' +
      '</div>';
    byId("ymSaveRun").addEventListener("click", saveRecordedRun);
    byId("ymDownloadEvents").addEventListener("click", downloadEventsCsv);
    ["ymWTAmount", "ymWTUnits", "ymWTMoist"].forEach(function (id) {
      var el = byId(id);
      el.addEventListener("input", updateTicketPreview);
      el.addEventListener("change", updateTicketPreview);
    });
    byId("ymDiscardRun").addEventListener("click", async function () {
      var ok = await confirmAsync("Discard this pass? The recorded data cannot be recovered.", "Discard pass", "Discard");
      if (!ok) return;
      _recordedEvents = [];
      _pendingUnsaved = false;
      summary.classList.add("hidden");
      byId("ymRecStatus").textContent = "Not recording";
    });
  }

  // Wet pounds -> bushels at standard moisture. Bushels pass through as entered.
  function ticketBushels(crop, amount, units, moist) {
    var lbsPerBu = BU_WEIGHTS[crop] || 60;
    if (units === "bu") return { bu: amount, note: "as entered", needMoisture: false };
    var base = amount / lbsPerBu;
    var std = STD_MOISTURE[crop];
    var m = Number(moist);
    if (std == null) return { bu: base, note: "no moisture standard for " + crop, needMoisture: false };
    if (!(m > 0 && m < 50)) return { bu: base, note: "moisture missing", needMoisture: true };
    return { bu: base * (100 - m) / (100 - std), note: m + "% shrunk to " + std + "%", needMoisture: false, moist: m, std: std };
  }
  function updateTicketPreview() {
    var el = byId("ymWTPreview");
    if (!el) return;
    var amount = parseFloat(byId("ymWTAmount").value);
    if (!(amount > 0)) { el.textContent = ""; return; }
    var r = ticketBushels(_live._recordCrop, amount, byId("ymWTUnits").value, byId("ymWTMoist").value);
    el.textContent = r.needMoisture
      ? "Enter the moisture % to convert pounds to bushels."
      : "= " + fmtNum(r.bu, 1) + " bu (" + r.note + ")";
  }

  function downloadEventsCsv() {
    var rows = ["n,t_us,width_us,flag"];
    for (var i = 0; i < _recordedEvents.length; i++) {
      var ev = _recordedEvents[i];
      rows.push(ev.n + "," + ev.t + "," + ev.w + "," + ev.f);
    }
    var d = _live._recordStartTime || new Date();
    var p2 = function (x) { return (x < 10 ? "0" : "") + x; };
    var name = "yield_pass_" + p2(d.getDate()) + "-" + p2(d.getMonth() + 1) + "-" + d.getFullYear() +
               "_" + p2(d.getHours()) + p2(d.getMinutes()) + ".csv";
    var blob = new Blob([rows.join("\n")], { type: "text/csv" });
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { try { URL.revokeObjectURL(a.href); document.body.removeChild(a); } catch (e) {} }, 1000);
  }

  function saveRecordedRun() {
    var amount = parseFloat(byId("ymWTAmount").value);
    if (!(amount > 0)) { appAlert("Enter the net weight from the scale ticket."); return; }
    var units = byId("ymWTUnits").value;
    var source = byId("ymWTSource").value || "";
    var crop = _live._recordCrop;
    var t = ticketBushels(crop, amount, units, byId("ymWTMoist").value);
    if (t.needMoisture) {
      appAlert("Enter the moisture % from the ticket. Pounds are converted to bushels at " +
               STD_MOISTURE[crop] + "% moisture, and the answer depends on it.", "Moisture needed");
      return;
    }
    if (!(t.bu > 0)) { appAlert("That weight works out to zero bushels. Check the number."); return; }

    var n = _recordedEvents.length;
    var flags = [];
    if (_live.dropouts) flags.push("dropout x" + _live.dropouts);
    if (_live.counterResets) flags.push("sensor reset x" + _live.counterResets);
    if (n > 0 && _live.missedEvents > n * 0.005) flags.push("missed " + _live.missedEvents + " events");
    var excluded = flags.length > 0;

    var keepEvents = n <= EVENT_STORE_MAX;
    var run = {
      id: newId(),
      crop: crop,
      fieldName: _live._recordField || "",
      notes: _live._recordNotes,
      startTime: _live._recordStartTime.toISOString(),
      endTime: nowIso(),
      durationSec: Math.round(_live._recordDuration || 0),
      totalExcessUs: _live.totalExcessUs,
      validEvents: _live.validEvents,
      totalEvents: n,
      weighTicketAmount: amount,
      weighTicketUnits: units,
      weighTicketBushels: t.bu,
      weighTicketMoisture: t.moist != null ? t.moist : null,
      weighTicketStdMoisture: t.std != null ? t.std : null,
      weighTicketSource: source,
      excludedFromAverage: excluded,
      flags: flags.join("; "),
      dropouts: _live.dropouts,
      missedEvents: _live.missedEvents,
      counterResets: _live.counterResets,
      // Compact [n, t_us, width_us, flag] rows. Omitted on very long passes:
      // K only needs totalExcessUs, and localStorage is small (about 5 MB).
      eventsFormat: "ntwf",
      events: keepEvents ? _recordedEvents.map(function (e) { return [e.n, e.t, e.w, e.f]; }) : null,
      eventsOmitted: !keepEvents
    };
    run.computedK = computeK(run);

    var saved = saveRun(run);
    if (!saved && run.events) {            // retry without the raw events
      run.events = null;
      run.eventsOmitted = true;
      saved = saveRun(run);
    }
    if (!saved) {
      appAlert("Browser storage is full, so this pass was NOT saved. It is still on screen: " +
               "tap Download raw events (CSV) and write down the weigh ticket numbers, then free space " +
               "(delete old calibration runs or old reports) and tap Save Pass again.", "Storage full");
      return;
    }
    _recordedEvents = [];
    _pendingUnsaved = false;
    byId("ymRecSummary").classList.add("hidden");
    byId("ymRecStatus").textContent = "Saved. K = " + (run.computedK == null ? "\u2014" : run.computedK.toExponential(3)) +
      (excluded ? " (EXCLUDED: " + run.flags + ")" : "") +
      (run.eventsOmitted ? " \u00B7 raw events not stored" : "");
  }

  // ----------------------------------------------------------
  // RENDERING
  // ----------------------------------------------------------
  function renderAll() {
    renderLive();
    renderCropAndFieldDropdowns();
    renderCalibration();
    renderHistory();
  }
  function renderLive() {
    var g = byId("ymLiveGrid");
    if (!g) return;
    var conn = _live.connected;
    var tiles = [
      ["Paddle rate",    conn ? fmtNum(_live.rate, 1) + " Hz" : "—"],
      ["Beam",           conn ? _live.beam : "—"],
      ["Baseline",       conn && _live.baseline_us ? fmtNum(_live.baseline_us, 0) + " µs" : "—"],
      ["Last width",     conn && _live.last_width_us ? fmtNum(_live.last_width_us, 0) + " µs" : "—"],
      ["Excess (last)",  conn ? fmtNum(_live.excess_us, 0) + " µs" : "—"],
      ["Paddles seen",   conn ? fmtNum(_live.paddles, 0) : "—"],
      ["Short anomalies",conn ? fmtNum(_live.short, 0) : "—"],
      ["Marker events",  conn ? fmtNum(_live.wide, 0) : "—"]
    ];
    g.innerHTML = tiles.map(function (t) {
      return '<div class="ym-tile"><div class="ym-tile-label">' + esc(t[0]) +
             '</div><div class="ym-tile-value">' + esc(t[1]) + '</div></div>';
    }).join("");
  }
  function renderCropAndFieldDropdowns() {
    var sel = byId("ymCalCrop");
    var fldSel = byId("ymCalField");
    if (!sel || !fldSel) return;
    // Crops from the seed inventory / field library; fall back to defaults.
    var crops = Object.keys(BU_WEIGHTS).filter(function (c) { return c !== "Soybeans"; });
    sel.innerHTML = '<option value="">— pick crop —</option>' +
      crops.map(function (c) { return '<option>' + esc(c) + '</option>'; }).join("");
    // Fields from the field library
    var fields = {};
    try { fields = JSON.parse(localStorage.getItem("dof_fields_library") || "{}"); } catch (e) {}
    var names = Object.keys(fields).sort();
    fldSel.innerHTML = '<option value="">— pick field —</option>' +
      names.map(function (n) { return '<option>' + esc(n) + '</option>'; }).join("");
  }
  function renderCalibration() {
    var el = byId("ymLockedList");
    if (!el) return;
    var locked = lockedGet();
    var keys = Object.keys(locked).sort();
    if (!keys.length) {
      el.innerHTML = '<div class="ym-empty">No calibration data yet. Record a pass to get started.</div>';
      return;
    }
    el.innerHTML = keys.map(function (crop) {
      var L = locked[crop];
      var badgeClass = L.status === "locked" ? "locked" : (L.status === "needs-review" ? "review" : "pending");
      var badgeText = L.status === "locked" ? "LOCKED" : (L.status === "needs-review" ? "NEEDS REVIEW" : "PENDING");
      return '<div class="ym-locked-row">' +
        '<div class="ym-locked-crop">' + esc(crop) + '</div>' +
        '<div class="ym-locked-k">K = ' + (L.value == null ? "—" : L.value.toExponential(3)) + ' bu/µs</div>' +
        '<div class="ym-locked-meta">' + L.nPasses + ' pass' + (L.nPasses === 1 ? "" : "es") +
          (L.stdevPct != null ? ' · σ = ' + fmtNum(L.stdevPct, 1) + '%' : '') +
        '</div>' +
        '<div class="ym-badge ' + badgeClass + '">' + badgeText + '</div>' +
      '</div>';
    }).join("");
  }
  function renderHistory() {
    var el = byId("ymHistoryList");
    if (!el) return;
    var runs = runsGet();
    var list = Object.values(runs).sort(function (a, b) {
      return (b.savedAt || "").localeCompare(a.savedAt || "");
    });
    if (!list.length) {
      el.innerHTML = '<div class="ym-empty">No calibration runs yet.</div>';
      return;
    }
    el.innerHTML = list.map(function (r) {
      var K = r.computedK != null ? r.computedK.toExponential(3) : "—";
      return '<div class="ym-history-row" data-id="' + esc(r.id) + '">' +
        '<div class="ym-history-header">' +
          '<div><b>' + esc(r.crop) + '</b>' + (r.fieldName ? ' · ' + esc(r.fieldName) : '') + '</div>' +
          '<div class="ym-history-date">' + fmtDate(r.savedAt) + '</div>' +
        '</div>' +
        '<div class="ym-history-body">' +
          '<span>K = ' + K + '</span>' +
          '<span>' + fmtNum(r.weighTicketBushels, 1) + ' bu</span>' +
          '<span>' + fmtNum(r.validEvents, 0) + ' events</span>' +
          (r.weighTicketMoisture != null ? '<span>' + fmtNum(r.weighTicketMoisture, 1) + '% moist</span>' : '') +
          (r.excludedFromAverage && r.flags ? '<span style="color:#c0392b">EXCLUDED: ' + esc(r.flags) + '</span>' : '') +
          '<span>' + fmtNum(r.totalExcessUs, 0) + ' µs total</span>' +
        '</div>' +
        '<div class="ym-history-actions">' +
          '<button class="btn ym-run-toggle" data-id="' + esc(r.id) + '">' +
            (r.excludedFromAverage ? "Include in avg" : "Exclude from avg") + '</button>' +
          '<button class="btn btn-danger ym-run-delete" data-id="' + esc(r.id) + '">Delete</button>' +
        '</div>' +
      '</div>';
    }).join("");
    // Wire buttons
    document.querySelectorAll(".ym-run-toggle").forEach(function (b) {
      b.addEventListener("click", function () {
        var runs = runsGet();
        var r = runs[b.dataset.id];
        if (!r) return;
        r.excludedFromAverage = !r.excludedFromAverage;
        saveRun(r);
      });
    });
    document.querySelectorAll(".ym-run-delete").forEach(function (b) {
      b.addEventListener("click", function () {
        if (typeof appConfirm === "function") {
          appConfirm("Delete this calibration pass?").then(function (ok) { if (ok) deleteRun(b.dataset.id); });
        } else {
          if (confirm("Delete this calibration pass?")) deleteRun(b.dataset.id);
        }
      });
    });
  }

  // ----------------------------------------------------------
  // CSS INJECTION
  // ----------------------------------------------------------
  function injectCSS() {
    if (byId("ym-styles")) return;
    var css = document.createElement("style");
    css.id = "ym-styles";
    css.textContent =
    '.ym-container { padding: 12px; max-width: 900px; margin: 0 auto; }' +
    '.ym-subtabs { display: flex; gap: 6px; margin-bottom: 12px; border-bottom: 1px solid var(--border); }' +
    '.ym-subtab { background: transparent; border: none; padding: 8px 14px; font-weight: 600; color: var(--muted); cursor: pointer; border-bottom: 2px solid transparent; }' +
    '.ym-subtab.active { color: var(--green); border-bottom-color: var(--green); }' +
    '.ym-sub { display: none; }' +
    '.ym-sub.active { display: block; }' +

    '.ym-conn-row { display: flex; align-items: center; gap: 12px; margin-bottom: 8px; }' +
    '.ym-dot { width: 12px; height: 12px; border-radius: 50%; background: var(--muted); }' +
    '.ym-dot.connected { background: var(--green); box-shadow: 0 0 6px rgba(46,158,87,0.5); }' +
    '.ym-conn-status { flex: 1; color: var(--muted); font-size: 0.9rem; }' +
    '.ym-help { color: var(--muted); font-size: 0.85rem; margin-top: 8px; line-height: 1.4; }' +

    '.ym-live-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); gap: 8px; margin-top: 8px; }' +
    '.ym-tile { background: var(--panel-2); border: 1px solid var(--border); border-radius: 8px; padding: 10px; }' +
    '.ym-tile-label { font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.04em; color: var(--muted); margin-bottom: 4px; }' +
    '.ym-tile-value { font-size: 1.15rem; font-weight: 700; color: var(--text); }' +

    '.ym-cal-controls { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 10px; margin-bottom: 12px; }' +
    '.ym-cal-controls label { display: flex; flex-direction: column; gap: 4px; font-size: 0.85rem; color: var(--muted); }' +
    '.ym-cal-controls input, .ym-cal-controls select { padding: 8px 10px; border: 1px solid var(--border); border-radius: 6px; background: var(--panel); color: var(--text); font-size: 1rem; }' +
    '.ym-cal-record { display: flex; align-items: center; gap: 12px; margin-top: 8px; }' +
    '.ym-rec-status { color: var(--muted); font-size: 0.9rem; }' +
    '.ym-rec-summary { margin-top: 16px; padding: 12px; background: var(--panel-2); border: 1px solid var(--border); border-radius: 8px; }' +
    '.ym-summary-row { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; margin: 8px 0; }' +
    '.ym-summary-row label { display: flex; flex-direction: column; gap: 4px; font-size: 0.85rem; color: var(--muted); flex: 1; min-width: 140px; }' +
    '.ym-summary-row input, .ym-summary-row select { padding: 8px 10px; border: 1px solid var(--border); border-radius: 6px; background: var(--panel); color: var(--text); font-size: 1rem; }' +

    '.ym-locked-list { display: flex; flex-direction: column; gap: 8px; }' +
    '.ym-locked-row { display: grid; grid-template-columns: 1fr auto auto auto; gap: 12px; align-items: center; padding: 10px; background: var(--panel-2); border: 1px solid var(--border); border-radius: 8px; }' +
    '.ym-locked-crop { font-weight: 700; }' +
    '.ym-locked-k { font-family: monospace; color: var(--text); }' +
    '.ym-locked-meta { font-size: 0.85rem; color: var(--muted); }' +
    '.ym-badge { padding: 2px 8px; border-radius: 4px; font-size: 0.7rem; font-weight: 700; letter-spacing: 0.04em; }' +
    '.ym-badge.locked { background: var(--green); color: white; }' +
    '.ym-badge.review { background: var(--accent); color: white; }' +
    '.ym-badge.pending { background: var(--muted); color: white; }' +

    '.ym-history-list { display: flex; flex-direction: column; gap: 8px; }' +
    '.ym-history-row { padding: 10px; background: var(--panel-2); border: 1px solid var(--border); border-radius: 8px; }' +
    '.ym-history-header { display: flex; justify-content: space-between; margin-bottom: 6px; }' +
    '.ym-history-date { color: var(--muted); font-size: 0.85rem; }' +
    '.ym-history-body { display: flex; flex-wrap: wrap; gap: 12px; font-size: 0.9rem; color: var(--muted); }' +
    '.ym-history-actions { display: flex; gap: 8px; margin-top: 8px; }' +

    '.ym-empty { padding: 20px; text-align: center; color: var(--muted); font-style: italic; }' +
    '.hidden { display: none !important; }';
    document.head.appendChild(css);
  }

  // ----------------------------------------------------------
  // BOOTSTRAP
  // ----------------------------------------------------------
  ready(function () {
    injectCSS();
    injectTab();
    renderAll();
    // Attempt silent reconnect to a previously-granted port
    if (webSerialSupported()) {
      autoConnect().catch(function () {});
      installGuards();
    } else {
      statusText("Web Serial not supported in this browser");
    }
  });

  // Expose a tiny API for other modules or debugging
  window.YieldMonitor = {
    getRuns: runsGet,
    getLockedK: lockedGet,
    connect: function () { return connectSensor(true); },
    disconnect: disconnectSensor,
    live: function () { return Object.assign({}, _live); }
  };
})();
