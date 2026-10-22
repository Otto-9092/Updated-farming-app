// ============================================================
// OπO Farming — RTK SOURCE MODULE (self-contained)
// Build 2026.10.22-30
// ------------------------------------------------------------
// Makes a DFRobot / Quectel LC29H RTK rover (read through the ESP32
// serial bridge, rtk_bridge.ino) the app's GPS source.
//
// HOW IT WORKS
//   - Wraps navigator.geolocation.watchPosition / getCurrentPosition /
//     clearWatch. app.js is NOT modified: it keeps calling the normal
//     browser API and simply receives RTK fixes in the same shape.
//   - Once valid NMEA is flowing, the browser's own (Wi-Fi / IP) location
//     is suppressed so a coarse fix can never jump the machine marker or
//     paint a fake swath.
//   - Disconnected = the app behaves exactly as before.
//
// WHAT IT READS (NMEA 0183 over Web Serial, 115200 baud)
//   - GGA -> lat / lon / fix quality / satellites / HDOP / altitude /
//            correction age. One position event per GGA (1 Hz).
//   - RMC -> ground speed + course (heading only while moving).
//   Fix quality -> accuracy (m) handed to the app's GPS filter:
//     4 RTK FIXED 0.03   5 RTK FLOAT 0.40   2 DGPS ~1.5   1 GPS 2.5+
//   These are NOMINAL mappings, not values reported by the receiver.
//   With the app's "RTK (<=0.1m)" filter, only RTK FIXED passes.
//
// BROWSER SUPPORT
//   - Web Serial = DESKTOP Chrome / Edge only. Not on Chrome for Android
//     or iOS Safari (same limit as yieldmonitor.js). There the pill reads
//     "RTK: N/A" and the app uses the device GPS as usual.
//
// UI
//   - "RTK" pill left of the GPS pill in the header. Tap to connect or
//     disconnect. No silent auto-reconnect, so it can never grab the
//     yield-monitor port.
//
// Public API: window.RtkSource { connect, disconnect, status, stats }
// ============================================================
(function () {
  "use strict";

  // ----------------------------------------------------------
  // SETTINGS
  // ----------------------------------------------------------
  var BAUD           = 115200;  // ESP32 USB side of rtk_bridge.ino
  var ALLOW_FALLBACK = false;   // true  = use browser GPS whenever RTK goes stale
                                // false = RTK only while connected (painting pauses
                                //         if the rover loses its fix)
  var FRESH_MS       = 3000;    // a GGA newer than this counts as live
  var RMC_FRESH_MS   = 1500;    // max age of RMC data merged into a GGA fix
  var MOVING_KNOTS   = 0.8;     // below this, heading is reported as null
  var KNOTS_TO_MPS   = 0.514444;
  var DIAG_DELAY_MS  = 6000;    // wait before calling it NO DATA / BAD DATA

  // ----------------------------------------------------------
  // STATE
  // ----------------------------------------------------------
  var realGeo   = (typeof navigator !== "undefined") ? navigator.geolocation : null;
  var realWatch = (realGeo && typeof realGeo.watchPosition === "function") ? realGeo.watchPosition.bind(realGeo) : null;
  var realClear = (realGeo && typeof realGeo.clearWatch === "function") ? realGeo.clearWatch.bind(realGeo) : null;
  var realGet   = (realGeo && typeof realGeo.getCurrentPosition === "function") ? realGeo.getCurrentPosition.bind(realGeo) : null;

  var _port = null, _reader = null, _loop = null;
  var _abort = false, _connected = false;
  var _buf = "";
  var _openedAt = 0;
  var _bytes = 0, _lines = 0, _bad = 0;

  var _last = null;          // last RTK position object
  var _lastFixAt = 0;        // when a usable fix last arrived
  var _lastGgaAt = 0;        // when any GGA last arrived (even no-fix)
  var _quality = 0, _sats = 0, _hdop = null, _age = null;
  var _rmc = null;           // { at, knots, course }

  var _watchers = {};        // id -> { ok }
  var _fakeId = 900000;
  var _pill = null;
  var _patched = false;

  // ----------------------------------------------------------
  // SMALL HELPERS
  // ----------------------------------------------------------
  function supported() {
    return typeof navigator !== "undefined" && !!navigator.serial &&
           typeof navigator.serial.requestPort === "function";
  }
  function safe(fn, arg) {
    try { fn(arg); } catch (e) { if (typeof console !== "undefined") console.error("[rtk] callback error:", e); }
  }
  function notify(msg, title) {
    if (typeof appAlert === "function") appAlert(msg, title);
    else if (typeof alert === "function") alert((title ? title + "\n\n" : "") + msg);
  }
  function rtkFresh() {
    return !!_last && (Date.now() - _lastFixAt) < FRESH_MS;
  }
  // True when RTK should own the location feed (browser fixes are dropped).
  function suppressReal() {
    if (!_connected || _lines === 0) return false;   // never blackhole GPS on a wrong port
    return ALLOW_FALLBACK ? rtkFresh() : true;
  }

  // ----------------------------------------------------------
  // NMEA PARSING
  // ----------------------------------------------------------
  function checksumOk(s) {               // s starts with "$"
    var star = s.indexOf("*");
    if (star < 0 || star + 3 > s.length) return false;
    var cs = 0;
    for (var i = 1; i < star; i++) cs ^= s.charCodeAt(i);
    var given = parseInt(s.substr(star + 1, 2), 16);
    return !isNaN(given) && cs === given;
  }

  // NMEA ddmm.mmmm / dddmm.mmmm -> signed decimal degrees
  function toDeg(v, hemi) {
    if (!v) return null;
    var n = parseFloat(v);
    if (!isFinite(n)) return null;
    var d = Math.floor(n / 100);
    var dec = d + (n - d * 100) / 60;
    if (hemi === "S" || hemi === "W") dec = -dec;
    return dec;
  }

  function accuracyFor(q, hdop) {
    var h = (hdop && isFinite(hdop)) ? hdop : 1;
    if (q === 4) return 0.03;
    if (q === 5) return 0.40;
    if (q === 2) return Math.max(1.0, h * 1.5);
    if (q === 1) return Math.max(2.5, h * 2.5);
    return 5;
  }

  function onGGA(f) {
    // $GNGGA,time,lat,N,lon,E,quality,sats,hdop,alt,M,sep,M,age,station
    var q = parseInt(f[6], 10);
    if (isNaN(q)) q = 0;
    _quality = q;
    _sats    = parseInt(f[7], 10) || 0;
    var hd   = parseFloat(f[8]);
    _hdop    = isFinite(hd) ? hd : null;
    var ag   = (f[13] !== undefined && f[13] !== "") ? parseFloat(f[13]) : NaN;
    _age     = isFinite(ag) ? ag : null;
    _lastGgaAt = Date.now();

    if (q === 0) return;                          // no fix: nothing to emit
    var lat = toDeg(f[2], f[3]);
    var lon = toDeg(f[4], f[5]);
    if (lat == null || lon == null) return;
    if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return;

    var alt = parseFloat(f[9]);
    var now = Date.now();
    var speed = null, heading = null;
    if (_rmc && (now - _rmc.at) < RMC_FRESH_MS) {
      speed = _rmc.knots * KNOTS_TO_MPS;
      if (_rmc.knots > MOVING_KNOTS && _rmc.course != null) heading = _rmc.course;
    }

    var pos = {
      coords: {
        latitude: lat,
        longitude: lon,
        accuracy: accuracyFor(q, _hdop),
        altitude: isFinite(alt) ? alt : null,
        altitudeAccuracy: null,
        heading: heading,
        speed: speed
      },
      timestamp: now
    };
    _last = pos;
    _lastFixAt = now;
    emit(pos);
  }

  function onRMC(f) {
    // $GNRMC,time,status,lat,N,lon,E,speed(kn),course,date,...
    if (f[2] !== "A") { _rmc = null; return; }
    var kn = parseFloat(f[7]);
    var co = parseFloat(f[8]);
    if (!isFinite(kn)) { _rmc = null; return; }
    _rmc = { at: Date.now(), knots: kn, course: isFinite(co) ? co : null };
  }

  function handleLine(raw) {
    var i = raw.indexOf("$");
    if (i < 0) return;                            // "# status" lines from the ESP32 etc.
    var s = raw.slice(i).replace(/\s+$/, "");
    if (!checksumOk(s)) { _bad++; return; }
    _lines++;
    var body = s.slice(1, s.indexOf("*"));
    var f = body.split(",");
    var type = f[0].slice(-3);
    if (type === "GGA") onGGA(f);
    else if (type === "RMC") onRMC(f);
  }

  function feed(text) {
    _buf += text;
    var idx;
    while ((idx = _buf.indexOf("\n")) !== -1) {
      var line = _buf.slice(0, idx);
      _buf = _buf.slice(idx + 1);
      handleLine(line);
    }
    if (_buf.length > 4096) _buf = "";            // runaway guard
  }

  // ----------------------------------------------------------
  // GEOLOCATION WRAPPER
  // ----------------------------------------------------------
  function emit(pos) {
    for (var id in _watchers) {
      if (Object.prototype.hasOwnProperty.call(_watchers, id)) safe(_watchers[id].ok, pos);
    }
  }

  function patchedWatch(ok, err, opts) {
    var id = null;
    if (realWatch) {
      try {
        id = realWatch(
          function (pos) { if (!suppressReal() && typeof ok === "function") safe(ok, pos); },
          function (e)   { if (!suppressReal() && typeof err === "function") safe(err, e); },
          opts
        );
      } catch (e) { id = null; }
    }
    if (id == null) id = ++_fakeId;
    if (typeof ok === "function") _watchers[id] = { ok: ok };
    return id;
  }

  function patchedClear(id) {
    delete _watchers[id];
    if (realClear) { try { realClear(id); } catch (e) {} }
  }

  function geoError(msg) {
    return { code: 2, message: msg, PERMISSION_DENIED: 1, POSITION_UNAVAILABLE: 2, TIMEOUT: 3 };
  }

  function patchedGet(ok, err, opts) {
    if (suppressReal()) {
      if (rtkFresh()) {
        setTimeout(function () { if (typeof ok === "function") safe(ok, _last); }, 0);
      } else {
        setTimeout(function () {
          if (typeof err === "function") safe(err, geoError("RTK connected but no fix yet"));
        }, 0);
      }
      return;
    }
    if (realGet) realGet(ok, err, opts);
    else if (typeof err === "function") safe(err, geoError("Geolocation unavailable"));
  }

  function installPatch() {
    if (!realGeo) return false;
    var defs = { watchPosition: patchedWatch, clearWatch: patchedClear, getCurrentPosition: patchedGet };
    for (var name in defs) {
      if (!Object.prototype.hasOwnProperty.call(defs, name)) continue;
      try {
        Object.defineProperty(realGeo, name, { value: defs[name], configurable: true, writable: true });
      } catch (e) {
        try { realGeo[name] = defs[name]; } catch (e2) {}
      }
    }
    return realGeo.watchPosition === patchedWatch;
  }

  // ----------------------------------------------------------
  // STATUS + PILL
  // ----------------------------------------------------------
  function status() {
    if (!supported()) {
      return { text: "RTK: N/A", cls: "pill",
               title: "RTK needs desktop Chrome or Edge (Web Serial). Using device GPS." };
    }
    if (!_connected) {
      return { text: "RTK: TAP TO CONNECT", cls: "pill",
               title: "Tap to pick the GPS ESP32 serial port." };
    }
    var now = Date.now();
    if (_lines === 0) {
      if ((now - _openedAt) < DIAG_DELAY_MS) {
        return { text: "RTK: CONNECTING...", cls: "pill pill-warn", title: "Waiting for NMEA." };
      }
      if (_bytes > 0) {
        return { text: "RTK: BAD DATA", cls: "pill pill-bad",
                 title: "Bytes arriving but no valid NMEA. Wrong port (yield monitor?) or wrong baud." };
      }
      return { text: "RTK: NO DATA", cls: "pill pill-bad",
               title: "Port is open but silent. Check the ESP32 is running rtk_bridge and the rover is wired." };
    }
    var detail = "HDOP " + (_hdop != null ? _hdop.toFixed(1) : "?") +
                 " | corr age " + (_age != null ? _age.toFixed(1) + " s" : "n/a") +
                 " | " + _lines + " ok / " + _bad + " bad lines";
    if ((now - _lastGgaAt) > FRESH_MS) {
      return { text: "RTK: LOST", cls: "pill pill-bad",
               title: "No position data for over " + (FRESH_MS / 1000) + " s. " + detail };
    }
    var sat = " \u00B7 " + _sats + " sat";
    if (_quality === 0) {
      return { text: "RTK: NO FIX" + sat, cls: "pill pill-bad",
               title: "Rover has no fix; painting is paused. " + detail };
    }
    if (_quality === 4) return { text: "RTK FIXED" + sat, cls: "pill pill-good", title: detail };
    if (_quality === 5) return { text: "RTK FLOAT" + sat, cls: "pill pill-warn", title: detail };
    if (_quality === 2) return { text: "DGPS" + sat,      cls: "pill pill-warn",
                                 title: "Differential only, no RTK corrections. " + detail };
    return { text: "GPS ONLY" + sat, cls: "pill pill-warn",
             title: "No RTK corrections (is the base station on?). " + detail };
  }

  function render() {
    if (!_pill) return;
    var st = status();
    _pill.textContent = st.text;
    _pill.className = st.cls;
    _pill.title = st.title;
  }

  function onPillClick(ev) {
    if (ev && ev.stopPropagation) ev.stopPropagation();
    if (!supported()) {
      notify("RTK input uses Web Serial, which only exists in desktop Chrome or Edge " +
             "(Windows, macOS, Linux, ChromeOS).\n\nChrome for Android and iPad/iPhone " +
             "Safari don't have it. Open the app on the laptop, or use the tablet's own GPS.",
             "RTK needs a desktop browser");
      return;
    }
    if (_connected) {
      if (typeof appConfirm === "function") {
        appConfirm("Disconnect the RTK receiver? The app will go back to the device GPS.",
                   { title: "RTK", okLabel: "Disconnect" })
          .then(function (yes) { if (yes) disconnect(); });
      } else if (typeof confirm === "function" && confirm("Disconnect the RTK receiver?")) {
        disconnect();
      }
    } else {
      connect();
    }
  }

  function injectPill() {
    if (_pill || typeof document === "undefined") return;
    var host = document.querySelector(".status-pills");
    if (!host) return;
    var p = document.createElement("span");
    p.id = "rtkPill";
    p.className = "pill";
    p.textContent = "RTK";
    p.style.cursor = "pointer";
    p.setAttribute("role", "button");
    p.setAttribute("tabindex", "0");
    p.addEventListener("click", onPillClick);
    p.addEventListener("keydown", function (ev) {
      if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); onPillClick(ev); }
    });
    var gps = document.getElementById("gpsPill");
    if (gps && gps.parentNode === host) host.insertBefore(p, gps);
    else host.appendChild(p);
    _pill = p;
  }

  // ----------------------------------------------------------
  // SERIAL CONNECTION
  // ----------------------------------------------------------
  async function connect() {
    if (!supported()) { onPillClick(); return; }
    if (_connected) return;
    var port;
    try {
      port = await navigator.serial.requestPort({});
    } catch (e) {
      return;                                     // user closed the picker
    }
    try {
      await port.open({ baudRate: BAUD, bufferSize: 4096 });
    } catch (e) {
      notify("Could not open that port: " + (e && e.message || e) +
             "\n\nIf it says the port is already open, you picked the yield monitor's " +
             "ESP32. Pick the other one (the GPS ESP32).", "RTK connect failed");
      render();
      return;
    }
    _port = port;
    _abort = false;
    _buf = "";
    _bytes = 0; _lines = 0; _bad = 0;
    _last = null; _lastFixAt = 0; _lastGgaAt = 0; _rmc = null;
    _quality = 0; _sats = 0; _hdop = null; _age = null;
    _openedAt = Date.now();
    _connected = true;
    _loop = readLoop(port);
    render();
  }

  async function readLoop(port) {
    var decoder = new TextDecoder();
    try {
      _reader = port.readable.getReader();
      while (!_abort) {
        var chunk = await _reader.read();
        if (chunk.done) break;
        if (chunk.value) {
          _bytes += chunk.value.length;
          feed(decoder.decode(chunk.value, { stream: true }));
        }
      }
    } catch (e) {
      if (typeof console !== "undefined") console.warn("[rtk] read error:", e);
    } finally {
      try { if (_reader) _reader.releaseLock(); } catch (e) {}
      _reader = null;
      if (!_abort) {                              // unplugged / dropped
        try { await port.close(); } catch (e) {}
        _port = null;
        _connected = false;
      }
      render();
    }
  }

  async function disconnect() {
    _abort = true;
    try { if (_reader) await _reader.cancel(); } catch (e) {}
    try { if (_loop) await _loop; } catch (e) {}
    try { if (_port) await _port.close(); } catch (e) {}
    _port = null;
    _reader = null;
    _connected = false;
    render();
  }

  function stats() {
    return { connected: _connected, bytes: _bytes, goodLines: _lines, badLines: _bad,
             quality: _quality, sats: _sats, hdop: _hdop, corrAge: _age,
             fresh: rtkFresh(), patched: _patched, fallback: ALLOW_FALLBACK };
  }

  // ----------------------------------------------------------
  // BOOTSTRAP
  // ----------------------------------------------------------
  _patched = installPatch();
  if (!_patched && typeof console !== "undefined") {
    console.warn("[rtk] could not wrap navigator.geolocation; RTK positions will not reach the app.");
  }

  function ready(fn) {
    if (typeof document === "undefined") return;
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", fn);
    else fn();
  }
  ready(function () {
    injectPill();
    render();
    setInterval(render, 1000);
  });

  window.RtkSource = {
    connect: connect,
    disconnect: disconnect,
    status: status,
    stats: stats,
    _feed: feed                                   // test hook
  };
})();
