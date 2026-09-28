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
// Storage (localStorage, syncs like every other library in this app):
//   dof_ym_runs        — calibration run records, keyed by id
//   dof_ym_lockedK     — locked calibration factors per crop
//   dof_tomb_ym_runs   — tombstones for Drive sync of deleted runs
//
// Web Serial:
//   • Android Chrome supports Web Serial API natively — no laptop needed.
//   • iOS Safari does NOT support Web Serial — the tab still works for
//     browsing calibration history but the "Connect" button will explain
//     that live capture requires a Chromium browser.
//   • Connection is persisted via getPorts() so re-plugging the ESP32
//     reconnects automatically.
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
  function runsSet(o) { localStorage.setItem(LS_RUNS, JSON.stringify(o)); }
  function lockedGet() { try { return JSON.parse(localStorage.getItem(LS_LOCKED_K) || "{}"); } catch (e) { return {}; } }
  function lockedSet(o) { localStorage.setItem(LS_LOCKED_K, JSON.stringify(o)); }
  function tombGet() { try { return JSON.parse(localStorage.getItem(LS_TOMB_RUNS) || "{}"); } catch (e) { return {}; } }
  function tombSet(o) { localStorage.setItem(LS_TOMB_RUNS, JSON.stringify(o)); }

  function saveRun(run) {
    var runs = runsGet();
    run._modified = nowIso();
    if (!run.savedAt) run.savedAt = nowIso();
    if (!run.id) run.id = newId();
    runs[run.id] = run;
    runsSet(runs);
    recomputeLockedK(run.crop);
    renderHistory();
    renderCalibration();
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
    _recordStartExcess: 0
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

  async function connectSensor(promptUser) {
    if (!webSerialSupported()) {
      appAlert(
        "Web Serial isn't available in this browser.\n\n" +
        "Yield Monitor live capture requires Chrome or Edge on Android, macOS, Windows, or Linux. " +
        "iPad/iPhone Safari does not support USB serial devices.\n\n" +
        "You can still browse calibration history and manually enter passes.",
        "Browser not supported"
      );
      return;
    }
    try {
      var port;
      if (promptUser) {
        port = await navigator.serial.requestPort({});
      } else {
        // Try to reconnect to an already-granted port
        var granted = await navigator.serial.getPorts();
        if (!granted.length) { statusText("No previously-connected sensor"); return; }
        port = granted[0];
      }
      await port.open({ baudRate: 115200 });
      _port = port;
      _readAbort = false;
      _lineBuf = "";
      setConnected(true);
      statusText("Connected");
      readLoop();  // fire-and-forget
    } catch (e) {
      statusText("Connect failed: " + (e && e.message || e));
      setConnected(false);
    }
  }
  async function disconnectSensor() {
    _readAbort = true;
    try { if (_reader) { await _reader.cancel(); _reader.releaseLock(); } } catch (e) {}
    _reader = null;
    try { if (_port) { await _port.close(); } } catch (e) {}
    _port = null;
    setConnected(false);
    statusText("Disconnected");
  }

  async function readLoop() {
    if (!_port) return;
    var decoder = new TextDecoder();
    try {
      _reader = _port.readable.getReader();
      while (!_readAbort) {
        var chunk = await _reader.read();
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
      statusText("Read error: " + (e && e.message || e));
    } finally {
      try { if (_reader) _reader.releaseLock(); } catch (e) {}
      _reader = null;
      if (!_readAbort) setConnected(false);
    }
  }

  function handleSerialLine(line) {
    // Try EVT lines first (they're the common case)
    var m = EVT_RE_V12.exec(line);
    if (m) {
      var evtNum = +m[1], t_us = +m[2], w_us = +m[3], flag = +m[4];
      if (_live.firstEvtNum == null) _live.firstEvtNum = evtNum;
      _live.lastEvtNum = evtNum;
      if (_live.recording) {
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
    '        <b>How to connect:</b> plug the ESP32 into the tablet via USB-C, tap ' +
    '        <b>Connect Sensor</b>, and pick the ESP32 (usually shown as ' +
    '        "CP210x" or "USB Serial") from the browser prompt.<br/><br/>' +
    '        <b>Not seeing the ESP32?</b> Make sure Arduino IDE is fully closed on ' +
    '        any other device connected to this ESP32 — only one program can hold the ' +
    '        port at a time.' +
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
  function startRecording() {
    if (!_live.connected) {
      appAlert("Connect the sensor first (Setup tab -> Connect Sensor).", "Not connected");
      return;
    }
    var crop = byId("ymCalCrop").value;
    var field = byId("ymCalField").value;
    if (!crop) { appAlert("Pick a crop first."); return; }
    _live.recording = true;
    _live._recordCrop = crop;
    _live._recordField = field;
    _live._recordNotes = byId("ymCalNotes").value || "";
    _live._recordStartTime = new Date();
    _recordedEvents = [];
    _live.validEvents = 0;
    _live.totalExcessUs = 0;
    byId("ymRecStartBtn").classList.add("hidden");
    byId("ymRecStopBtn").classList.remove("hidden");
    byId("ymRecStatus").textContent = "Recording…";
    byId("ymRecSummary").classList.add("hidden");
  }
  function stopRecording() {
    if (!_live.recording) return;
    _live.recording = false;
    var duration = (new Date() - _live._recordStartTime) / 1000;
    byId("ymRecStartBtn").classList.remove("hidden");
    byId("ymRecStopBtn").classList.add("hidden");
    byId("ymRecStatus").textContent = "Stopped.";
    // Show summary + prompt for weigh ticket
    var summary = byId("ymRecSummary");
    summary.classList.remove("hidden");
    summary.innerHTML =
      '<div class="ym-summary-row">Duration: <b>' + fmtNum(duration, 0) + ' s</b></div>' +
      '<div class="ym-summary-row">Valid events: <b>' + fmtNum(_live.validEvents, 0) + '</b></div>' +
      '<div class="ym-summary-row">Total excess: <b>' + fmtNum(_live.totalExcessUs, 0) + ' µs</b></div>' +
      '<div class="ym-summary-row">' +
      '  <label>Weigh ticket amount' +
      '    <input id="ymWTAmount" type="number" step="0.01" placeholder="0.00"/>' +
      '  </label>' +
      '  <label>Units' +
      '    <select id="ymWTUnits">' +
      '      <option value="bu">Bushels</option>' +
      '      <option value="lbs">Pounds</option>' +
      '    </select>' +
      '  </label>' +
      '  <label>Source (optional)' +
      '    <input id="ymWTSource" type="text" placeholder="Elevator, on-farm scale, etc."/>' +
      '  </label>' +
      '</div>' +
      '<div class="ym-summary-row">' +
      '  <button id="ymSaveRun" class="btn btn-primary">Save Pass</button>' +
      '  <button id="ymDiscardRun" class="btn">Discard</button>' +
      '</div>';
    byId("ymSaveRun").addEventListener("click", saveRecordedRun);
    byId("ymDiscardRun").addEventListener("click", function () {
      _recordedEvents = [];
      summary.classList.add("hidden");
      byId("ymRecStatus").textContent = "Not recording";
    });
  }
  function saveRecordedRun() {
    var amount = parseFloat(byId("ymWTAmount").value);
    if (!(amount > 0)) { appAlert("Enter a weigh ticket amount."); return; }
    var units = byId("ymWTUnits").value;
    var source = byId("ymWTSource").value || "";
    var crop = _live._recordCrop;
    var lbsPerBu = BU_WEIGHTS[crop] || 60;
    var bushels = units === "bu" ? amount : amount / lbsPerBu;
    var run = {
      id: newId(),
      crop: crop,
      fieldName: _live._recordField || "",
      notes: _live._recordNotes,
      startTime: _live._recordStartTime.toISOString(),
      endTime: nowIso(),
      totalExcessUs: _live.totalExcessUs,
      validEvents: _live.validEvents,
      totalEvents: _recordedEvents.length,
      weighTicketAmount: amount,
      weighTicketUnits: units,
      weighTicketBushels: bushels,
      weighTicketSource: source,
      excludedFromAverage: false,
      // Store the events for later re-analysis. If the array is huge (thousands
      // of events), we still keep them — they compress well and the sync system
      // can handle it. If it becomes an issue we can move them to IndexedDB later.
      events: _recordedEvents.slice()
    };
    run.computedK = computeK(run);
    saveRun(run);
    _recordedEvents = [];
    byId("ymRecSummary").classList.add("hidden");
    byId("ymRecStatus").textContent = "Saved. K = " + (run.computedK == null ? "—" : run.computedK.toExponential(3));
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
      connectSensor(false).catch(function () {});
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
