/* ============================================================
   Diamond O Farms — Data Systems Pro
   Complete single-file precision ag display logic.
   ============================================================ */

// ===== State =====
const state = {
  map: null,
  machineMarker: null,
  watchId: null,
  running: false,
  lastPos: null,
  speedBuf: [],
  smoothMph: null, 
  acHrBuf: [],
  acres: 0,
  bushels: 0,
  gallons: 0,
  liveGPM: 0,
  efficiencyHits: 0,
  efficiencyAttempts: 0,
  coverageCells: new Set(),
  sections: { left: false, full: true, right: false },
  abLine: { a: null, b: null, poly: null },
  boundary: { active: false, points: [], poly: null, acres: 0 },
  coveragePolys: [],
  field: { name: "", crop: "Corn", variety: "" },
  equipment: { name: "", type: "sprayer", width: 90 },
  sprayer:  { gpa: 15, nozzle: 20, target: 12, tank: 1200, product: "" },
  combine:  { expectedYield: 180, tankCapacity: 350, moisture: 15.0 },
  planter:  { rowSpacing: 30, rows: 16, population: 34000, variety: "", downforce: 150 },
  tillage:  { depth: 6, passType: "primary", notes: "" },
  spreader: { productType: "dry_fert", rate: 200, bin: 8000, productName: "" },
  other:    { notes: "" },
  weather:  { windSpeed: "", windDir: "", temp: "", sky: "", capturedAt: "" },
  sessionStart: null,
  // Map view options
  headingUp: false,
  autoZoom: true,
  autoCenter: true,
  currentHeading: 0,
  lastZoom: 19,
  // Trail + speed coloring
  trailEnabled: true,
  trailSegments: [],
  lastSpeedTier: null,
  // Speed stats
  speedSum: 0,
  speedCount: 0,
  speedMax: 0,
  // Raw trail points for export
  trailPoints: [],
  // Multi-field
  loadedFieldKey: null,
};

// ===== Constants =====
const FT_PER_METER = 3.28084;
const SQFT_PER_ACRE = 43560;
const SMOOTH_N = 10;                // bigger buffer for smoother speed
const CELL_SIZE_DEG = 0.00005;
const MPS_TO_MPH = 2.23694;

// ===== GPS quality thresholds =====
const GPS_MAX_ACCURACY_M    = 15;   // reject fixes worse than this (meters)
const GPS_MIN_MOVE_M        = 0.5;  // ignore micro-jitter below this (meters)
const GPS_MAX_REALISTIC_MPH = 60;   // reject impossible speed jumps
const SPEED_EMA_ALPHA       = 0.25; // exponential smoothing: lower = smoother, higher = more responsive
// ===== localStorage keys =====
const LS_EQ     = "dof_equipment_library";
const LS_REPS   = "dof_reports";
const LS_FIELDS = "dof_fields_library";

// ===== DOM helper =====
const $ = (id) => document.getElementById(id);

// ===== Format helper =====
function formatETA(hours) {
  if (!isFinite(hours) || hours <= 0) return "—";
  const totalMin = Math.round(hours * 60);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h === 0) return `${m}m`;
  return `${h}h ${m}m`;
}

// ===== iOS Wake Lock =====
let wakeLockRef = null;
async function requestWakeLock() {
  try {
    if ("wakeLock" in navigator) wakeLockRef = await navigator.wakeLock.request("screen");
  } catch (e) { console.warn("Wake lock failed:", e); }
}
function releaseWakeLock() {
  if (wakeLockRef) { wakeLockRef.release().catch(()=>{}); wakeLockRef = null; }
}
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && state.running) requestWakeLock();
});

// ============================================================
// TAB SWITCHING
// ============================================================
document.querySelectorAll(".tab").forEach((t) => {
  t.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach(x => x.classList.remove("active"));
    document.querySelectorAll(".tab-panel").forEach(x => x.classList.remove("active"));
    t.classList.add("active");
    $("tab-" + t.dataset.tab).classList.add("active");
    if (state.map) setTimeout(() => google.maps.event.trigger(state.map, "resize"), 100);
  });
});

// ============================================================
// MAP INIT
// ============================================================
function initMap() {
  state.map = new google.maps.Map($("map"), {
    center: getStartCenter(),       // last known location, or Iowa fallback
    zoom: 17,
    mapTypeId: getStartMapType(),   // remembers your last choice; defaults to hybrid
    tilt: 0,
    // --- Native Google Maps controls (replaces disableDefaultUI: true) ---
    disableDefaultUI: false,
    zoomControl: true,              // + / - zoom buttons
    mapTypeControl: true,          // Satellite / Hybrid / Roadmap / Terrain toggle
    mapTypeControlOptions: {
      mapTypeIds: ["hybrid", "satellite", "roadmap", "terrain"],
      style: google.maps.MapTypeControlStyle.DROPDOWN_MENU,
    },
    fullscreenControl: true,       // fullscreen button
    streetViewControl: false,      // pegman off (not useful in a field)
    rotateControl: false,
    gestureHandling: "cooperative", // page scrolls on wheel; Ctrl+wheel zooms map
  });

  // Remember the map type whenever you change it, so it persists next launch.
  state.map.addListener("maptypeid_changed", () => {
    try {
      localStorage.setItem("lastMapType", state.map.getMapTypeId());
    } catch (e) { /* storage blocked/full; ignore */ }
  });

  state.machineMarker = new google.maps.Marker({
    map: state.map,
    icon: {
      path: google.maps.SymbolPath.FORWARD_CLOSED_ARROW,
      scale: 6, fillColor: "#ffb703", fillOpacity: 1,
      strokeColor: "#1a1a1a", strokeWeight: 2,
    },
  });

  // Snap to user location ASAP
  snapToCurrentLocation();
}

// Centers the map on the user's current location. Saves it for next launch.
// Shows a clear message if the browser blocks or can't determine location
// (common on desktops with no GPS — they guess from Wi-Fi/IP and can be way off).
function snapToCurrentLocation() {
  if (!navigator.geolocation) {
    setGpsPill(false);
    console.warn("Geolocation not supported by this browser.");
    return;
  }
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      const here = { lat: pos.coords.latitude, lng: pos.coords.longitude };
      state.map.setCenter(here);
      state.map.setZoom(19);
      state.machineMarker.setPosition(here);
      setGpsPill(true, pos.coords.accuracy);
      // Remember this location so the next launch starts here, not the Iowa fallback.
      try {
        localStorage.setItem("lastKnownCenter", JSON.stringify(here));
      } catch (e) { /* storage might be full or blocked; ignore */ }
    },
    (err) => {
      setGpsPill(false);
      console.warn("Initial GPS:", err);
      // Surface the most common desktop problem in plain language.
      if (err && err.code === err.PERMISSION_DENIED) {
        console.warn("Location permission denied. Click the lock/location icon " +
                     "in the address bar and allow location, then tap Recenter.");
      } else if (err && err.code === err.POSITION_UNAVAILABLE) {
        console.warn("Location unavailable. Desktop browsers estimate location " +
                     "from Wi-Fi/IP and may be inaccurate.");
      }
    },
    { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
  );
}

// Returns the saved last-known center if we have one, else the Iowa fallback.
function getStartCenter() {
  try {
    const saved = localStorage.getItem("lastKnownCenter");
    if (saved) {
      const c = JSON.parse(saved);
      if (c && typeof c.lat === "number" && typeof c.lng === "number") return c;
    }
  } catch (e) { /* ignore parse/storage errors */ }
  return { lat: 41.5868, lng: -93.625 }; // Des Moines, Iowa fallback
}

// Returns the saved map type ("hybrid"/"satellite"/"roadmap"/"terrain"),
// or "hybrid" by default (satellite imagery WITH road names + labels).
function getStartMapType() {
  try {
    const saved = localStorage.getItem("lastMapType");
    const allowed = ["hybrid", "satellite", "roadmap", "terrain"];
    if (saved && allowed.indexOf(saved) !== -1) return saved;
  } catch (e) { /* ignore */ }
  return "hybrid";
}
// Make initMap visible to the Google Maps callback loader
window.initMap = initMap;

// ============================================================
// SECTION CONTROL — LEFT ½ / FULL / RIGHT ½
// ============================================================
function toggleSection(which) {
  if (which === "full") {
    state.sections.full = !state.sections.full;
    if (state.sections.full) {
      state.sections.left = false;
      state.sections.right = false;
    }
  } else {
    state.sections[which] = !state.sections[which];
    if (state.sections.left || state.sections.right) state.sections.full = false;
    if (!state.sections.left && !state.sections.right && !state.sections.full) state.sections.full = true;
  }
  renderSectionButtons();
}
function renderSectionButtons() {
  $("secLeft").classList.toggle("active",  state.sections.left);
  $("secFull").classList.toggle("active",  state.sections.full);
  $("secRight").classList.toggle("active", state.sections.right);
}
$("secLeft").addEventListener("click",  () => toggleSection("left"));
$("secFull").addEventListener("click",  () => toggleSection("full"));
$("secRight").addEventListener("click", () => toggleSection("right"));

// ============================================================
// SESSION — start / stop
// ============================================================
$("btnStart").addEventListener("click", startSession);
$("btnStop").addEventListener("click", stopSession);

// ============================================================
// WEATHER CAPTURE (spray records) — added feature
// Prompts once at session start. Fully skippable; never blocks.
// ============================================================
function $id(id){ return document.getElementById(id); }

// Open a themed dialog overlay and trap focus on its first input.
function openDlg(overlayId, firstFieldId) {
  var ov = $id(overlayId);
  if (!ov) return;
  ov.classList.remove("hidden");
  setTimeout(function(){
    var el = firstFieldId ? $id(firstFieldId) : null;
    if (el && el.focus) { try { el.focus(); } catch(e){} }
  }, 50);
}
function closeDlg(overlayId) {
  var ov = $id(overlayId);
  if (ov) ov.classList.add("hidden");
}

// ============================================================
// START-SESSION DIALOG (themed) — field check + weather in one popup.
// Returns a Promise that resolves true (start) or false (cancel).
// ============================================================
function showStartDialog() {
  return new Promise(function (resolve) {
    var f = state.field || {};
    var e = state.equipment || {};
    var w = state.weather || {};
    var hasField = !!(f.name && f.name.trim() !== "");

    // Build the summary / warning block
    var summary = $id("startDlgSummary");
    if (summary) {
      if (hasField) {
        var bAcres = (state.boundary && state.boundary.acres > 0)
          ? state.boundary.acres.toFixed(2) + " ac" : "no boundary set";
        var machine = e.name ? e.name : "\u2014";
        if (e.type)  machine += " \u2013 " + e.type;
        if (e.width) machine += "  " + e.width + " ft";
        summary.innerHTML =
          '<div class="dlg-summary">' +
            '<div class="row"><span class="lab">\uD83D\uDCCD Field</span><span class="val">' + escHtml(f.name) + '</span></div>' +
            '<div class="row"><span class="lab">\uD83C\uDF3D Crop</span><span class="val">' + escHtml(f.crop || "\u2014") + (f.variety ? " (" + escHtml(f.variety) + ")" : "") + '</span></div>' +
            '<div class="row"><span class="lab">\uD83D\uDCD0 Boundary</span><span class="val">' + bAcres + '</span></div>' +
            '<div class="row"><span class="lab">\uD83D\uDE9C Machine</span><span class="val">' + escHtml(machine) + '</span></div>' +
          '</div>' +
          '<div class="hint">Not the right field? Tap Cancel, then load it on the \u201CField & Equipment\u201D tab.</div>';
      } else {
        summary.innerHTML =
          '<div class="dlg-warn">\u26A0\uFE0F <b>No field is loaded.</b><br>' +
          'Go to \u201CField & Equipment\u201D to set up or load a field first, ' +
          'or press Start to record an <b>untitled</b> session anyway.</div>';
      }
    }

    // Pre-fill weather with last-used values
    if ($id("dlgWindSpeed")) $id("dlgWindSpeed").value = w.windSpeed || "";
    if ($id("dlgWindDir"))   $id("dlgWindDir").value   = w.windDir   || "";
    if ($id("dlgTemp"))      $id("dlgTemp").value      = w.temp      || "";
    if ($id("dlgSky"))       $id("dlgSky").value       = w.sky       || "";

    openDlg("startDlg", "dlgWindSpeed");

    function cleanup() {
      $id("startDlgGo").removeEventListener("click", onGo);
      $id("startDlgCancel").removeEventListener("click", onCancel);
      $id("startDlg").removeEventListener("click", onBackdrop);
    }
    function onGo() {
      // Save weather from the fields
      state.weather = {
        windSpeed: ($id("dlgWindSpeed").value || "").trim(),
        windDir:   ($id("dlgWindDir").value   || "").trim(),
        temp:      ($id("dlgTemp").value      || "").trim(),
        sky:       ($id("dlgSky").value       || "").trim(),
        capturedAt: new Date().toISOString()
      };
      closeDlg("startDlg"); cleanup(); resolve(true);
    }
    function onCancel() { closeDlg("startDlg"); cleanup(); resolve(false); }
    function onBackdrop(ev) { if (ev.target === $id("startDlg")) onCancel(); }

    $id("startDlgGo").addEventListener("click", onGo);
    $id("startDlgCancel").addEventListener("click", onCancel);
    $id("startDlg").addEventListener("click", onBackdrop);
  });
}

// ============================================================
// REPORT TITLE DIALOG (themed). Resolves to a string title, or
// null if the operator cancels.
// ============================================================
function showTitleDialog(suggested) {
  return new Promise(function (resolve) {
    var input = $id("dlgReportTitle");
    if (input) input.value = suggested || "";
    openDlg("titleDlg", "dlgReportTitle");
    if (input) { try { input.select(); } catch(e){} }

    function cleanup() {
      $id("titleDlgSave").removeEventListener("click", onSave);
      $id("titleDlgCancel").removeEventListener("click", onCancel);
      $id("titleDlg").removeEventListener("click", onBackdrop);
      if (input) input.removeEventListener("keydown", onKey);
    }
    function onSave() {
      var val = (input && input.value ? input.value : "").trim();
      closeDlg("titleDlg"); cleanup();
      resolve(val || (suggested || "Untitled"));
    }
    function onCancel() { closeDlg("titleDlg"); cleanup(); resolve(null); }
    function onBackdrop(ev) { if (ev.target === $id("titleDlg")) onCancel(); }
    function onKey(ev) { if (ev.key === "Enter") { ev.preventDefault(); onSave(); } }

    $id("titleDlgSave").addEventListener("click", onSave);
    $id("titleDlgCancel").addEventListener("click", onCancel);
    $id("titleDlg").addEventListener("click", onBackdrop);
    if (input) input.addEventListener("keydown", onKey);
  });
}

// ============================================================
// RENAME REPORT DIALOG (themed). Resolves to the new name string,
// or null if cancelled.
// ============================================================
function showRenameDialog(current) {
  return new Promise(function (resolve) {
    var input = $id("dlgRenameInput");
    if (input) input.value = current || "";
    openDlg("renameDlg", "dlgRenameInput");
    if (input) { try { input.select(); } catch (e) {} }

    function cleanup() {
      $id("renameDlgSave").removeEventListener("click", onSave);
      $id("renameDlgCancel").removeEventListener("click", onCancel);
      $id("renameDlg").removeEventListener("click", onBackdrop);
      if (input) input.removeEventListener("keydown", onKey);
    }
    function onSave() {
      var val = (input && input.value ? input.value : "").trim();
      closeDlg("renameDlg"); cleanup();
      resolve(val);   // may be "" -> caller treats empty as invalid
    }
    function onCancel() { closeDlg("renameDlg"); cleanup(); resolve(null); }
    function onBackdrop(ev) { if (ev.target === $id("renameDlg")) onCancel(); }
    function onKey(ev) { if (ev.key === "Enter") { ev.preventDefault(); onSave(); } }

    $id("renameDlgSave").addEventListener("click", onSave);
    $id("renameDlgCancel").addEventListener("click", onCancel);
    $id("renameDlg").addEventListener("click", onBackdrop);
    if (input) input.addEventListener("keydown", onKey);
  });
}

// Tiny HTML-escaper for values injected into dialog markup
function escHtml(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ============================================================
// GENERIC THEMED ALERT + CONFIRM (replace native browser boxes)
// appAlert(message[, title])  -> Promise<void>
// appConfirm(message[, opts]) -> Promise<boolean>
//   opts: { title, okLabel, cancelLabel, danger }
// ============================================================
function appAlert(message, title) {
  return new Promise(function (resolve) {
    var msgEl = $id("noticeDlgMsg");
    var titleEl = $id("noticeDlgTitle");
    if (titleEl) titleEl.textContent = title || "Notice";
    if (msgEl) msgEl.textContent = (message == null ? "" : String(message));
    openDlg("noticeDlg", "noticeDlgOk");
    function cleanup() {
      $id("noticeDlgOk").removeEventListener("click", onOk);
      $id("noticeDlg").removeEventListener("click", onBackdrop);
    }
    function onOk() { closeDlg("noticeDlg"); cleanup(); resolve(); }
    function onBackdrop(ev) { if (ev.target === $id("noticeDlg")) onOk(); }
    $id("noticeDlgOk").addEventListener("click", onOk);
    $id("noticeDlg").addEventListener("click", onBackdrop);
  });
}

function appConfirm(message, opts) {
  opts = opts || {};
  return new Promise(function (resolve) {
    var msgEl = $id("confirmDlgMsg");
    var titleEl = $id("confirmDlgTitle");
    var okBtn = $id("confirmDlgOk");
    var cancelBtn = $id("confirmDlgCancel");
    if (titleEl) titleEl.textContent = opts.title || "Please confirm";
    if (msgEl) msgEl.textContent = (message == null ? "" : String(message));
    if (okBtn) {
      okBtn.textContent = opts.okLabel || "OK";
      okBtn.className = "btn " + (opts.danger ? "btn-danger" : "btn-primary");
    }
    if (cancelBtn) cancelBtn.textContent = opts.cancelLabel || "Cancel";
    openDlg("confirmDlg", "confirmDlgCancel");
    function cleanup() {
      okBtn.removeEventListener("click", onOk);
      cancelBtn.removeEventListener("click", onCancel);
      $id("confirmDlg").removeEventListener("click", onBackdrop);
    }
    function onOk() { closeDlg("confirmDlg"); cleanup(); resolve(true); }
    function onCancel() { closeDlg("confirmDlg"); cleanup(); resolve(false); }
    function onBackdrop(ev) { if (ev.target === $id("confirmDlg")) onCancel(); }
    okBtn.addEventListener("click", onOk);
    cancelBtn.addEventListener("click", onCancel);
    $id("confirmDlg").addEventListener("click", onBackdrop);
  });
}

async function startSession() {
  if (!navigator.geolocation) { appAlert("Geolocation not supported on this device.", "GPS unavailable"); return; }
  readFormsIntoState();

  // ← NEW: themed field-check + weather dialog before starting
  const proceed = await showStartDialog();
  if (!proceed) { return; }

  state.running = true;
  state.sessionStart = Date.now();
  state.acres = 0; state.bushels = 0; state.gallons = 0;
  state.coverageCells.clear();
  state.efficiencyHits = 0; state.efficiencyAttempts = 0;
  state.coveragePolys.forEach(p => p.setMap(null));
  state.coveragePolys = [];
  state.lastPos = null;
  state.speedBuf = []; state.acHrBuf = [];

  clearTrail();
  state.lastSpeedTier = null;

  state.speedSum = 0;
  state.speedCount = 0;
  state.speedMax = 0;
  state.trailPoints = [];

  // Reset UI metrics
  $("mAvgSpeed") && ($("mAvgSpeed").textContent = "0.0");
  $("mMaxSpeed") && ($("mMaxSpeed").textContent = "0.0");
  $("mAcresLeft") && ($("mAcresLeft").textContent = state.boundary.acres > 0 ? state.boundary.acres.toFixed(2) : "—");
  $("mETA") && ($("mETA").textContent = "—");

  $("btnStart").disabled = true;
  $("btnStop").disabled  = false;
  setMode("RUNNING");

  state.watchId = navigator.geolocation.watchPosition(
    onPos,
    (err) => { console.warn(err); setGpsPill(false); },
    { enableHighAccuracy: true, maximumAge: 500, timeout: 10000 }
  );

  requestWakeLock();
}

function stopSession() {
  state.running = false;
  if (state.watchId != null) navigator.geolocation.clearWatch(state.watchId);
  state.watchId = null;
  $("btnStart").disabled = false;
  $("btnStop").disabled  = true;
  setMode("IDLE");
  releaseWakeLock();
}

// ============================================================
// BACKGROUND LOCATION FOLLOW (runs even outside a session)
// ============================================================
// ============================================================
// BACKGROUND LOCATION FOLLOW (runs even outside a session)
// ============================================================
function startLocationFollow() {
  if (!navigator.geolocation) return;
  navigator.geolocation.watchPosition(
    (pos) => {
      const lat = pos.coords.latitude;
      const lng = pos.coords.longitude;
      const acc = pos.coords.accuracy != null ? pos.coords.accuracy : 999;
      setGpsPill(true, acc);

      // Reject low-quality fixes for display too
      if (acc > GPS_MAX_ACCURACY_M) return;

      if (state.machineMarker) state.machineMarker.setPosition({ lat, lng });
      if (state.map && state.autoCenter) state.map.panTo({ lat, lng });
      if (!state.running) state.lastPos = { lat, lng, ts: pos.timestamp || Date.now() };

      const rawMph = pos.coords.speed != null && pos.coords.speed >= 0
        ? pos.coords.speed * MPS_TO_MPH : 0;
      if (state.smoothMph == null) state.smoothMph = rawMph;
      else state.smoothMph = (SPEED_EMA_ALPHA * rawMph) + ((1 - SPEED_EMA_ALPHA) * state.smoothMph);

      if (pos.coords.heading != null && !isNaN(pos.coords.heading)) {
        state.currentHeading = pos.coords.heading;
      }
      applyMapView(state.smoothMph);
    },
    (err) => { console.warn(err); setGpsPill(false); },
    { enableHighAccuracy: true, maximumAge: 1000, timeout: 10000 }
  );
}

// ============================================================
// GPS POSITION HANDLER (during a session)
// ============================================================
// ============================================================
// GPS POSITION HANDLER (during a session)
// ============================================================
function onPos(pos) {
  const lat = pos.coords.latitude;
  const lng = pos.coords.longitude;
  const ts  = pos.timestamp || Date.now();
  const acc = pos.coords.accuracy != null ? pos.coords.accuracy : 999;
  const heading = pos.coords.heading;
  const speedMps = pos.coords.speed;

  // --- Update GPS quality pill regardless of whether we accept the fix ---
  setGpsPill(true, acc);

  // --- Reject low-quality fixes outright ---
  if (acc > GPS_MAX_ACCURACY_M) {
    // Bad fix: skip painting, skip metrics update, but keep listening
    return;
  }

  // --- Compute raw speed (prefer device-provided, fall back to derived) ---
  let rawMph = 0;
  if (speedMps != null && !isNaN(speedMps) && speedMps >= 0) {
    rawMph = speedMps * MPS_TO_MPH;
  } else if (state.lastPos) {
    const dMeters = haversine(state.lastPos.lat, state.lastPos.lng, lat, lng);
    const dt = (ts - state.lastPos.ts) / 1000;
    if (dt > 0) rawMph = (dMeters / dt) * MPS_TO_MPH;
  }

  // --- Reject physically impossible speed jumps ---
  if (rawMph > GPS_MAX_REALISTIC_MPH) {
    return;
  }

  // --- Exponential moving average for silky speed display ---
  if (state.smoothMph == null) {
    state.smoothMph = rawMph;
  } else {
    state.smoothMph = (SPEED_EMA_ALPHA * rawMph) + ((1 - SPEED_EMA_ALPHA) * state.smoothMph);
  }
  const smoothMph = state.smoothMph;

  // Keep the legacy buffer for any downstream code that uses it
  state.speedBuf.push(rawMph);
  if (state.speedBuf.length > SMOOTH_N) state.speedBuf.shift();

  // --- Update marker position & heading ---
  state.machineMarker.setPosition({ lat, lng });
  if (heading != null && !isNaN(heading)) {
    state.currentHeading = heading;
    const icon = state.machineMarker.getIcon();
    icon.rotation = state.headingUp ? 0 : heading;
    state.machineMarker.setIcon(icon);
  }
  if (state.autoCenter) state.map.panTo({ lat, lng });

  applyMapView(smoothMph);
  updateMarkerColor(smoothMph);

  // --- Boundary recording mode ---
  if (state.boundary.active) {
    state.boundary.points.push({ lat, lng });
    drawBoundaryPreview();
    state.lastPos = { lat, lng, ts };
    updateMetrics(smoothMph);
    return;
  }

  // --- Paint swath only if we actually moved enough ---
  if (state.lastPos) {
    const moved = haversine(state.lastPos.lat, state.lastPos.lng, lat, lng);
    if (moved >= GPS_MIN_MOVE_M) {
      paintSwath(state.lastPos, { lat, lng }, heading);
      addTrailSegment({ lat: state.lastPos.lat, lng: state.lastPos.lng }, { lat, lng }, smoothMph);
      state.trailPoints.push({ lat, lng, ts, speed: smoothMph });
      state.lastPos = { lat, lng, ts };
    }
    // If we didn't move enough, KEEP the old lastPos so the next fix
    // can still compare against the last "real" position
  } else {
    state.lastPos = { lat, lng, ts };
    state.trailPoints.push({ lat, lng, ts, speed: smoothMph });
  }

  updateMetrics(smoothMph);
}

// ============================================================
// MAP VIEW — auto-zoom + heading-up
// ============================================================
function zoomForSpeed(mph) {
  if (mph < 1)   return 20;
  if (mph < 4)   return 19;
  if (mph < 8)   return 18;
  if (mph < 14)  return 17;
  if (mph < 20)  return 16;
  return 15;
}
function applyMapView(mph) {
  if (!state.map) return;
  if (state.autoZoom) {
    const target = zoomForSpeed(mph);
    if (target !== state.lastZoom) {
      state.map.setZoom(target);
      state.lastZoom = target;
    }
  }
  if (state.headingUp && state.currentHeading != null && !isNaN(state.currentHeading)) {
    state.map.setHeading(state.currentHeading);
  }
}

// ============================================================
// SPEED COLORING + TRAIL
// ============================================================
function speedTier(mph) {
  const target = state.sprayer.target || 12;
  if (mph < target - 2) return "slow";
  if (mph > target + 2) return "fast";
  return "ok";
}
function colorForTier(tier) {
  if (tier === "slow") return "#f1c40f";
  if (tier === "fast") return "#e74c3c";
  return "#2ecc71";
}
function updateMarkerColor(mph) {
  const tier = speedTier(mph);
  if (tier === state.lastSpeedTier) return;
  state.lastSpeedTier = tier;
  if (!state.machineMarker) return;
  const icon = state.machineMarker.getIcon();
  icon.fillColor = colorForTier(tier);
  state.machineMarker.setIcon(icon);
}
function addTrailSegment(p1, p2, mph) {
  if (!state.trailEnabled || !state.map) return;
  if (!p1 || !p2) return;
  const seg = new google.maps.Polyline({
    path: [p1, p2],
    strokeColor: colorForTier(speedTier(mph)),
    strokeOpacity: 0.95,
    strokeWeight: 3,
    map: state.map,
    zIndex: 2,
  });
  state.trailSegments.push(seg);
}
function clearTrail() {
  state.trailSegments.forEach(s => s.setMap(null));
  state.trailSegments = [];
  state.trailPoints = [];
}

// ============================================================
// SWATH PAINTING
// ============================================================
function paintSwath(p1, p2, headingDeg) {
  const widthFt = state.equipment.width;
  const widthM  = widthFt / FT_PER_METER;
  const bearing = (headingDeg != null && !isNaN(headingDeg))
    ? headingDeg : bearingDeg(p1.lat, p1.lng, p2.lat, p2.lng);
  const left  = (bearing - 90 + 360) % 360;
  const right = (bearing + 90) % 360;
  const halfFull = widthM / 2;
  let painted = false;

  if (state.sections.full) {
    drawCoveragePolygon(stripPolygon(p1, p2, left, right, halfFull, halfFull), p1, p2, widthM);
    painted = true;
  } else {
    if (state.sections.left)  { drawCoveragePolygon(stripPolygon(p1, p2, left, right, halfFull, 0), p1, p2, halfFull); painted = true; }
    if (state.sections.right) { drawCoveragePolygon(stripPolygon(p1, p2, left, right, 0, halfFull), p1, p2, halfFull); painted = true; }
  }
  if (painted) state.efficiencyAttempts++;
}
function stripPolygon(p1, p2, leftBearing, rightBearing, leftMeters, rightMeters) {
  return [
    offsetMeters(p1.lat, p1.lng, leftBearing,  leftMeters),
    offsetMeters(p2.lat, p2.lng, leftBearing,  leftMeters),
    offsetMeters(p2.lat, p2.lng, rightBearing, rightMeters),
    offsetMeters(p1.lat, p1.lng, rightBearing, rightMeters),
  ];
}
function drawCoveragePolygon(path, p1, p2, swathWidthM) {
  const key = cellKey((p1.lat + p2.lat)/2, (p1.lng + p2.lng)/2);
  const isOverlap = state.coverageCells.has(key);
  if (!isOverlap) { state.coverageCells.add(key); state.efficiencyHits++; }
  const poly = new google.maps.Polygon({
    paths: path, strokeWeight: 0,
    fillColor: isOverlap ? "#e74c3c" : "#2ecc71",
    fillOpacity: 0.55, map: state.map, zIndex: 1,
  });
  state.coveragePolys.push(poly);

  const segMeters = haversine(p1.lat, p1.lng, p2.lat, p2.lng);
  const areaSqFt = (segMeters * FT_PER_METER) * (swathWidthM * FT_PER_METER);
  const acresDelta = areaSqFt / SQFT_PER_ACRE;
  if (!isOverlap) {
    state.acres += acresDelta;
    if (state.equipment.type === "sprayer") {
      state.gallons += acresDelta * state.sprayer.gpa;
    } else if (state.equipment.type === "combine") {
      const baseYield = state.field.crop === "Soybeans" ? 55
                     : state.field.crop === "Wheat"    ? 70 : 180;
      state.bushels += acresDelta * baseYield;
    }
  }
}

// ============================================================
// METRICS
// ============================================================
function updateMetrics(mph) {
  $("mSpeed").textContent = mph.toFixed(1);
  $("mAcres").textContent = state.acres.toFixed(2);

  if (mph > 0.5) {
    state.speedSum += mph;
    state.speedCount += 1;
    if (mph > state.speedMax) state.speedMax = mph;
  }
  const avgSpeed = state.speedCount > 0 ? state.speedSum / state.speedCount : 0;
  $("mAvgSpeed") && ($("mAvgSpeed").textContent = avgSpeed.toFixed(1));
  $("mMaxSpeed") && ($("mMaxSpeed").textContent = state.speedMax.toFixed(1));

  let acresLeft = null;
  if (state.boundary.acres > 0) {
    acresLeft = Math.max(0, state.boundary.acres - state.acres);
    $("mAcresLeft") && ($("mAcresLeft").textContent = acresLeft.toFixed(2));
  } else if ($("mAcresLeft")) {
    $("mAcresLeft").textContent = "—";
  }

  const elapsedHr = (Date.now() - state.sessionStart) / 3600000;
  const ahr = elapsedHr > 0 ? state.acres / elapsedHr : 0;
  state.acHrBuf.push(ahr);
  if (state.acHrBuf.length > SMOOTH_N) state.acHrBuf.shift();
  const smoothedAcHr = avg(state.acHrBuf);
  $("mAcHr").textContent = smoothedAcHr.toFixed(1);

  if ($("mETA")) {
    if (acresLeft != null && smoothedAcHr > 0.1) {
      $("mETA").textContent = formatETA(acresLeft / smoothedAcHr);
    } else {
      $("mETA").textContent = "—";
    }
  }

  const eff = state.efficiencyAttempts > 0
    ? Math.round((state.efficiencyHits / state.efficiencyAttempts) * 100) : 0;
  $("mEff").textContent = eff;
  $("mBu").textContent  = Math.round(state.bushels);
  $("mGal").textContent = state.gallons.toFixed(1);

  if (state.equipment.type === "sprayer") {
  const gpm = (state.sprayer.gpa * mph * state.equipment.width) / 495;
  state.liveGPM = gpm;
  $("mGpm").textContent = gpm.toFixed(1);

  // Per-nozzle GPM = total GPM ÷ total number of nozzles across full boom
  const totalNozzles = Math.max(1, Math.round((state.equipment.width * 12) / state.sprayer.nozzle));
  const perNozzle = gpm / totalNozzles;
  const nozEl = $("mNozGpm");
  if (nozEl) nozEl.textContent = perNozzle.toFixed(2);
}
}

function applyEquipmentUI() {
  const isSprayer = state.equipment.type === "sprayer";

  // Sprayer-only metrics: Efficiency, Gallons, Total GPM, Nozzle GPM.
  // Hidden for every other equipment type since they don't apply.
  const effBox = $("mEffBox");
  if (effBox) effBox.classList.toggle("hidden", !isSprayer);
  $("mGalBox").classList.toggle("hidden", !isSprayer);
  $("mGpmBox").classList.toggle("hidden", !isSprayer);
  const nozBox = $("mNozGpmBox");
  if (nozBox) nozBox.classList.toggle("hidden", !isSprayer);

  // Bushels is the combine/harvest metric — shown for non-sprayers.
  $("mBuBox").classList.toggle("hidden",   isSprayer);
}

// ============================================================
// BOUNDARY
// ============================================================
$("btnBoundStart").addEventListener("click", () => {
  state.boundary.active = true;
  state.boundary.points = [];
  if (state.boundary.poly) { state.boundary.poly.setMap(null); state.boundary.poly = null; }
  $("btnBoundStart").disabled = true;
  $("btnBoundFinish").disabled = false;
  setMode("BOUNDARY");
});
$("btnBoundFinish").addEventListener("click", () => {
  state.boundary.active = false;
  $("btnBoundStart").disabled = false;
  $("btnBoundFinish").disabled = true;
  drawBoundaryFinal();
  setMode(state.running ? "RUNNING" : "IDLE");
});
$("btnBoundClear").addEventListener("click", () => {
  state.boundary.points = [];
  if (state.boundary.poly) { state.boundary.poly.setMap(null); state.boundary.poly = null; }
  state.boundary.acres = 0;
  $("boundAcres").textContent = "0.00";
});
function drawBoundaryPreview() {
  if (state.boundary.poly) state.boundary.poly.setMap(null);
  state.boundary.poly = new google.maps.Polyline({
    path: state.boundary.points,
    strokeColor: "#ffb703", strokeWeight: 3, map: state.map,
  });
}
function drawBoundaryFinal() {
  if (state.boundary.points.length < 3) return;
  if (state.boundary.poly) state.boundary.poly.setMap(null);
  state.boundary.poly = new google.maps.Polygon({
    paths: state.boundary.points,
    strokeColor: "#ffb703", strokeWeight: 3,
    fillColor: "#ffb703", fillOpacity: 0.08, map: state.map,
  });
  const areaM2 = google.maps.geometry.spherical.computeArea(state.boundary.poly.getPath());
  state.boundary.acres = (areaM2 * 10.7639) / SQFT_PER_ACRE;
  $("boundAcres").textContent = state.boundary.acres.toFixed(2);
}

// ============================================================
// A-B GUIDANCE
// ============================================================
$("btnSetA").addEventListener("click", () => {
  if (!state.lastPos) { appAlert("Need GPS fix first."); return; }
  state.abLine.a = { lat: state.lastPos.lat, lng: state.lastPos.lng };
  renderAB();
});
$("btnSetB").addEventListener("click", () => {
  if (!state.lastPos) { appAlert("Need GPS fix first."); return; }
  state.abLine.b = { lat: state.lastPos.lat, lng: state.lastPos.lng };
  renderAB();
});
$("btnClearAB").addEventListener("click", () => {
  state.abLine.a = state.abLine.b = null;
  if (state.abLine.poly) { state.abLine.poly.setMap(null); state.abLine.poly = null; }
});
function renderAB() {
  if (state.abLine.poly) state.abLine.poly.setMap(null);
  if (state.abLine.a && state.abLine.b) {
    const ext = extendLine(state.abLine.a, state.abLine.b, 2000);
    state.abLine.poly = new google.maps.Polyline({
      path: ext, strokeColor: "#ffffff", strokeWeight: 2,
      strokeOpacity: 0.9, map: state.map,
    });
  }
}

// ============================================================
// FORMS — read into state
// ============================================================
function readFormsIntoState() {
  state.field.name    = $("fldName").value || "Untitled Field";
  state.field.crop    = $("fldCrop").value;
  state.field.variety = $("fldVariety").value;
  state.equipment.name  = $("eqName").value || "Machine";
  state.equipment.type  = $("eqType").value;
  state.equipment.width = Math.max(1, parseFloat($("eqWidth").value) || 90);
  // Pull whatever sub-menu is currently active into state
  const current = readEqParams(state.equipment.type);
  applyEqParamsToState(current.type, current.values);
  applyEquipmentUI();
}
$("eqType").addEventListener("change", () => { state.equipment.type = $("eqType").value; applyEquipmentUI(); });
// ============================================================
// EQUIPMENT TYPE CONFIG — defines per-type parameters
// ============================================================
const EQ_TYPES = {
  sprayer: {
    label: "Sprayer",
    emoji: "🚿",
    subId: "subSprayer",
    fields: ["spGPA", "spNoz", "spTgt", "spTank", "spProduct"],
  },
  combine: {
    label: "Combine",
    emoji: "🌾",
    subId: "subCombine",
    fields: ["cmYield", "cmTank", "cmMoisture"],
  },
  planter: {
    label: "Planter",
    emoji: "🚜",
    subId: "subPlanter",
    fields: ["plRowSpacing", "plRows", "plPopulation", "plVariety", "plDownforce"],
  },
  tillage: {
    label: "Tillage",
    emoji: "🍂",
    subId: "subTillage",
    fields: ["tlDepth", "tlPassType", "tlNotes"],
  },
  spreader: {
    label: "Spreader",
    emoji: "🟫",
    subId: "subSpreader",
    fields: ["sdProductType", "sdRate", "sdBin", "sdProductName"],
  },
  other: {
    label: "Other",
    emoji: "❓",
    subId: "subOther",
    fields: ["otNotes"],
  },
};

// Snapshot of param values when modal opens — for Cancel support
let eqModalSnapshot = null;

// ============================================================
// EQUIPMENT MODAL — open / close / show right sub-menu
// ============================================================
function showEqSubmenu(type) {
  // Hide all sub-menus
  document.querySelectorAll(".eq-submenu").forEach(el => el.classList.add("hidden"));
  // Show the one for the selected type
  const cfg = EQ_TYPES[type];
  if (!cfg) return;
  const sub = $(cfg.subId);
  if (sub) sub.classList.remove("hidden");
  // Update modal title
  const title = $("eqModalTitle");
  if (title) title.textContent = `${cfg.emoji} ${cfg.label} Settings`;
}

function openEqModal() {
  const type = $("eqType").value;
  showEqSubmenu(type);
  // Snapshot current values so Cancel can restore
  eqModalSnapshot = readEqParams(type);
  $("eqModal").classList.remove("hidden");
}

function closeEqModal() {
  $("eqModal").classList.add("hidden");
  eqModalSnapshot = null;
}

function cancelEqModal() {
  // Restore original values from snapshot
  if (eqModalSnapshot) {
    writeEqParams(eqModalSnapshot.type, eqModalSnapshot.values);
  }
  closeEqModal();
}

function saveEqModal() {
  const type = $("eqType").value;
  // Pull values from the visible sub-menu into state
  const values = readEqParams(type).values;
  applyEqParamsToState(type, values);
  updateEqSummary();
  closeEqModal();
}

// Read DOM values for a given equipment type → { type, values: {...} }
function readEqParams(type) {
  const cfg = EQ_TYPES[type];
  const values = {};
  if (!cfg) return { type, values };
  cfg.fields.forEach(id => {
    const el = $(id);
    if (el) values[id] = el.value;
  });
  return { type, values };
}

// Write values back into DOM inputs
function writeEqParams(type, values) {
  const cfg = EQ_TYPES[type];
  if (!cfg) return;
  cfg.fields.forEach(id => {
    const el = $(id);
    if (el && values[id] != null) el.value = values[id];
  });
}

// Push DOM values into state object (so live metrics use them)
function applyEqParamsToState(type, values) {
  if (type === "sprayer") {
    state.sprayer.gpa     = parseFloat(values.spGPA)    || 15;
    state.sprayer.nozzle  = parseFloat(values.spNoz)    || 20;
    state.sprayer.target  = parseFloat(values.spTgt)    || 12;
    state.sprayer.tank    = parseFloat(values.spTank)   || 0;
    state.sprayer.product = values.spProduct || "";
  } else if (type === "combine") {
    state.combine = state.combine || {};
    state.combine.expectedYield = parseFloat(values.cmYield)    || 0;
    state.combine.tankCapacity  = parseFloat(values.cmTank)     || 0;
    state.combine.moisture      = parseFloat(values.cmMoisture) || 0;
  } else if (type === "planter") {
    state.planter = state.planter || {};
    state.planter.rowSpacing = parseFloat(values.plRowSpacing) || 30;
    state.planter.rows       = parseFloat(values.plRows)       || 16;
    state.planter.population = parseFloat(values.plPopulation) || 0;
    state.planter.variety    = values.plVariety || "";
    state.planter.downforce  = parseFloat(values.plDownforce)  || 0;
  } else if (type === "tillage") {
    state.tillage = state.tillage || {};
    state.tillage.depth    = parseFloat(values.tlDepth) || 0;
    state.tillage.passType = values.tlPassType || "primary";
    state.tillage.notes    = values.tlNotes || "";
  } else if (type === "spreader") {
    state.spreader = state.spreader || {};
    state.spreader.productType = values.sdProductType || "dry_fert";
    state.spreader.rate        = parseFloat(values.sdRate) || 0;
    state.spreader.bin         = parseFloat(values.sdBin)  || 0;
    state.spreader.productName = values.sdProductName || "";
  } else if (type === "other") {
    state.other = state.other || {};
    state.other.notes = values.otNotes || "";
  }
}

// Update the summary hint under the Edit button
function updateEqSummary() {
  const type = $("eqType").value;
  const cfg = EQ_TYPES[type];
  const label = $("btnEditEqLabel");
  const summary = $("eqParamSummary");
  if (label && cfg) label.textContent = cfg.label;
  if (!summary || !cfg) return;

  let text = "";
  if (type === "sprayer") {
    text = `Sprayer: ${state.sprayer.gpa} GPA, ${state.sprayer.nozzle}" nozzles, target ${state.sprayer.target} mph${state.sprayer.tank ? `, ${state.sprayer.tank} gal tank` : ""}${state.sprayer.product ? ` — ${state.sprayer.product}` : ""}`;
  } else if (type === "combine") {
    const c = state.combine || {};
    text = `Combine: ${c.expectedYield || "?"} bu/ac expected, ${c.tankCapacity || "?"} bu tank, ${c.moisture || "?"}% moisture`;
  } else if (type === "planter") {
    const p = state.planter || {};
    const suggestedWidth = (p.rows && p.rowSpacing) ? (p.rows * p.rowSpacing / 12).toFixed(1) : "?";
    text = `Planter: ${p.rows || "?"} rows × ${p.rowSpacing || "?"}" (${suggestedWidth} ft) — ${p.population || "?"} seeds/ac${p.variety ? ` — ${p.variety}` : ""}`;
  } else if (type === "tillage") {
    const t = state.tillage || {};
    text = `Tillage: ${t.depth || "?"}" deep, ${t.passType || "primary"} pass${t.notes ? ` — ${t.notes}` : ""}`;
  } else if (type === "spreader") {
    const s = state.spreader || {};
    text = `Spreader: ${s.rate || "?"} lbs/ac of ${s.productName || s.productType || "product"}, ${s.bin || "?"} lb bin`;
  } else if (type === "other") {
    const o = state.other || {};
    text = o.notes ? `Other: ${o.notes.slice(0, 60)}${o.notes.length > 60 ? "…" : ""}` : "Other: (no notes)";
  }
  summary.textContent = text;
}

// Live update for planter width suggestion (inside the modal)
function updatePlanterCalcWidth() {
  const rows = parseFloat($("plRows")?.value) || 0;
  const spacing = parseFloat($("plRowSpacing")?.value) || 0;
  const el = $("plCalcWidth");
  if (el) el.textContent = (rows * spacing / 12).toFixed(1);
}

// ============================================================
// EQUIPMENT MODAL — wire up event listeners
// ============================================================
$("btnEditEqParams")?.addEventListener("click", openEqModal);
$("btnEqModalClose")?.addEventListener("click", cancelEqModal);
$("btnEqModalCancel")?.addEventListener("click", cancelEqModal);
$("btnEqModalSave")?.addEventListener("click", saveEqModal);

// Tap outside the card to cancel
$("eqModal")?.addEventListener("click", (e) => {
  if (e.target.id === "eqModal") cancelEqModal();
});

// Type dropdown: when changed, auto-open the modal so user can set new params
$("eqType")?.addEventListener("change", () => {
  state.equipment.type = $("eqType").value;
  applyEquipmentUI();
  updateEqSummary();
  openEqModal();
});

// Planter calc: live update inside modal
["plRows", "plRowSpacing"].forEach(id => {
  const el = $(id);
  if (el) el.addEventListener("input", updatePlanterCalcWidth);
});

// ============================================================
// EQUIPMENT LIBRARY
// ============================================================
function loadEquipmentList() {
  const lib = JSON.parse(localStorage.getItem(LS_EQ) || "{}");
  const sel = $("eqLoad");
  if (!sel) return;
  sel.innerHTML = "";
  Object.keys(lib).forEach(k => {
    const o = document.createElement("option");
    o.value = k;
    const cfg = EQ_TYPES[lib[k].type];
    o.textContent = `${cfg ? cfg.emoji + " " : ""}${k}`;
    sel.appendChild(o);
  });
}

$("btnSaveEq").addEventListener("click", () => {
  readFormsIntoState();
  const lib = JSON.parse(localStorage.getItem(LS_EQ) || "{}");
  const type = state.equipment.type;
  lib[state.equipment.name] = {
    name:  state.equipment.name,
    type:  type,
    width: state.equipment.width,
    params: readEqParams(type).values,
  };
  localStorage.setItem(LS_EQ, JSON.stringify(lib));
  loadEquipmentList();
  appAlert(`Saved: ${state.equipment.name}`, "Saved");
  if (typeof updateDataStats === "function") updateDataStats();   // ← NEW LINE
});

$("btnLoadEq").addEventListener("click", () => {
  const lib = JSON.parse(localStorage.getItem(LS_EQ) || "{}");
  const k = $("eqLoad").value;
  if (!k || !lib[k]) return;
  const rec = lib[k];
  $("eqName").value  = rec.name;
  $("eqType").value  = rec.type;
  $("eqWidth").value = rec.width;
  state.equipment = { name: rec.name, type: rec.type, width: rec.width };
  // Restore the per-type params into the DOM, then push into state
  if (rec.params) {
    writeEqParams(rec.type, rec.params);
    applyEqParamsToState(rec.type, rec.params);
  }
  // Switch which sub-menu is "active" (for next modal open) + refresh summary
  showEqSubmenu(rec.type);
  applyEquipmentUI();
  updateEqSummary();
  if (rec.type === "planter") updatePlanterCalcWidth();
});

$("btnDeleteEq").addEventListener("click", async () => {
  const lib = JSON.parse(localStorage.getItem(LS_EQ) || "{}");
  const k = $("eqLoad").value;
  if (!k) return;
  if (!(await appConfirm(`Delete machine "${k}"?`, { title: "Delete machine", okLabel: "Delete", danger: true }))) return;
  delete lib[k];
  localStorage.setItem(LS_EQ, JSON.stringify(lib));
  loadEquipmentList();
  if (typeof updateDataStats === "function") updateDataStats();   // ← NEW LINE
});

// ============================================================
// MULTI-FIELD LIBRARY
// ============================================================
function loadFieldsList() {
  const lib = JSON.parse(localStorage.getItem(LS_FIELDS) || "{}");
  const sel = $("fldLoad");
  if (!sel) return;
  sel.innerHTML = "";
  Object.keys(lib).forEach(k => {
    const o = document.createElement("option");
    o.value = k; o.textContent = k;
    sel.appendChild(o);
  });
}
if ($("btnSaveField")) $("btnSaveField").addEventListener("click", () => {
  const name = $("fldName").value.trim();
  if (!name) { appAlert("Please enter a field name first."); return; }
  const lib = JSON.parse(localStorage.getItem(LS_FIELDS) || "{}");
  lib[name] = {
    name,
    crop: $("fldCrop").value,
    variety: $("fldVariety").value,
    boundary: { points: state.boundary.points.slice(), acres: state.boundary.acres },
    savedAt: new Date().toISOString(),
  };
  localStorage.setItem(LS_FIELDS, JSON.stringify(lib));
  state.loadedFieldKey = name;
  if ($("fldStatus")) $("fldStatus").textContent = `Saved field: ${name} (${lib[name].boundary.acres.toFixed(2)} ac)`;
  loadFieldsList();
  if (typeof updateDataStats === "function") updateDataStats();   // ← NEW LINE
});
if ($("btnLoadField")) $("btnLoadField").addEventListener("click", () => {
  const lib = JSON.parse(localStorage.getItem(LS_FIELDS) || "{}");
  const k = $("fldLoad").value;
  if (!k || !lib[k]) return;
  const f = lib[k];
  $("fldName").value = f.name;
  $("fldCrop").value = f.crop || "Corn";
  $("fldVariety").value = f.variety || "";
  state.field = { name: f.name, crop: f.crop, variety: f.variety };
  if (state.boundary.poly) { state.boundary.poly.setMap(null); state.boundary.poly = null; }
  state.boundary.points = (f.boundary && f.boundary.points) || [];
  state.boundary.acres  = (f.boundary && f.boundary.acres)  || 0;
  if (state.boundary.points.length >= 3 && state.map) {
    drawBoundaryFinal();
    const bounds = new google.maps.LatLngBounds();
    state.boundary.points.forEach(p => bounds.extend(p));
    state.map.fitBounds(bounds);
  }
  $("boundAcres").textContent = state.boundary.acres.toFixed(2);
  if ($("fldStatus")) $("fldStatus").textContent = `Loaded: ${f.name} (${state.boundary.acres.toFixed(2)} ac)`;
  state.loadedFieldKey = k;
});
if ($("btnDeleteField")) $("btnDeleteField").addEventListener("click", async () => {
  const lib = JSON.parse(localStorage.getItem(LS_FIELDS) || "{}");
  const k = $("fldLoad").value;
  if (!k) return;
  if (!(await appConfirm(`Delete field "${k}"?`, { title: "Delete field", okLabel: "Delete", danger: true }))) return;
  delete lib[k];
  localStorage.setItem(LS_FIELDS, JSON.stringify(lib));
  loadFieldsList();
  if ($("fldStatus")) $("fldStatus").textContent = `Deleted: ${k}`;
  if (typeof updateDataStats === "function") updateDataStats();   // ← NEW LINE
});

// ============================================================
// RECENTER / RESET PAINTED / VIEW TOGGLES
// ============================================================
if ($("btnRecenter")) $("btnRecenter").addEventListener("click", () => {
  // If we don't yet have a live position, re-request it (helps desktop after
  // the user grants location permission).
  if (!state.lastPos) { snapToCurrentLocation(); return; }
  if (state.lastPos && state.map) {
    state.map.panTo({ lat: state.lastPos.lat, lng: state.lastPos.lng });
    state.map.setZoom(19);
  }
});

if ($("btnResetPaint")) $("btnResetPaint").addEventListener("click", async () => {
  if (!(await appConfirm("Clear all painted coverage and reset acres? Boundary and trail will be kept.", { title: "Reset painted area", okLabel: "Reset", danger: true }))) return;
  state.coveragePolys.forEach(p => p.setMap(null));
  state.coveragePolys = [];
  state.coverageCells.clear();
  state.acres = 0;
  state.bushels = 0;
  state.gallons = 0;
  state.efficiencyHits = 0;
  state.efficiencyAttempts = 0;
  $("mAcres").textContent = "0.00";
  $("mBu").textContent = "0";
  $("mGal").textContent = "0.0";
  $("mEff").textContent = "0";
  if ($("mAcresLeft")) $("mAcresLeft").textContent = state.boundary.acres > 0 ? state.boundary.acres.toFixed(2) : "—";
  if ($("mETA")) $("mETA").textContent = "—";
});

if ($("btnOrient")) $("btnOrient").addEventListener("click", () => {
  state.headingUp = !state.headingUp;
  const btn = $("btnOrient");
  if (state.headingUp) {
    btn.textContent = "🧭 Heading-Up";
    btn.classList.add("active-toggle");
  } else {
    btn.textContent = "🧭 North-Up";
    btn.classList.remove("active-toggle");
    if (state.map) state.map.setHeading(0);
  }
});
if ($("btnAutoZoom")) $("btnAutoZoom").addEventListener("click", () => {
  state.autoZoom = !state.autoZoom;
  const btn = $("btnAutoZoom");
  btn.textContent = state.autoZoom ? "🔍 Auto-Zoom: ON" : "🔍 Auto-Zoom: OFF";
  btn.classList.toggle("active-toggle", state.autoZoom);
});
if ($("btnAutoCenter")) $("btnAutoCenter").addEventListener("click", () => {
  state.autoCenter = !state.autoCenter;
  const btn = $("btnAutoCenter");
  btn.textContent = state.autoCenter ? "🎯 Auto-Center: ON" : "🎯 Auto-Center: OFF";
  btn.classList.toggle("active-toggle", state.autoCenter);
  // When re-enabling, snap back to the machine immediately
  if (state.autoCenter && state.lastPos && state.map) {
    state.map.panTo({ lat: state.lastPos.lat, lng: state.lastPos.lng });
  }
});
if ($("btnTrail")) $("btnTrail").addEventListener("click", () => {
  state.trailEnabled = !state.trailEnabled;
  const btn = $("btnTrail");
  btn.textContent = state.trailEnabled ? "📍 Trail: ON" : "📍 Trail: OFF";
  btn.classList.toggle("active-toggle", state.trailEnabled);
  state.trailSegments.forEach(s => s.setMap(state.trailEnabled ? state.map : null));
});
if ($("btnClearTrail")) $("btnClearTrail").addEventListener("click", clearTrail);

// ============================================================
// EXPORT — KML / GPX
// ============================================================
if ($("btnExportKML")) $("btnExportKML").addEventListener("click", () => {
  if (state.trailPoints.length < 2) { appAlert("No trail to export yet."); return; }
  const fieldName = (state.field.name || "field").replace(/[^a-z0-9]+/gi, "_");
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const coords = state.trailPoints.map(p => `${p.lng.toFixed(7)},${p.lat.toFixed(7)},0`).join(" ");
  const kml = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
    <name>Diamond O Farms — ${state.field.name || "Trail"}</name>
    <Style id="trail"><LineStyle><color>ff00b7ff</color><width>3</width></LineStyle></Style>
    <Placemark><name>Machine Path</name><styleUrl>#trail</styleUrl>
      <LineString><tessellate>1</tessellate><coordinates>${coords}</coordinates></LineString>
    </Placemark>${boundaryKML()}
  </Document>
</kml>`;
  downloadFile(`DiamondO_${fieldName}_${ts}.kml`, kml, "application/vnd.google-earth.kml+xml");
});
if ($("btnExportGPX")) $("btnExportGPX").addEventListener("click", () => {
  if (state.trailPoints.length < 2) { appAlert("No trail to export yet."); return; }
  const fieldName = (state.field.name || "field").replace(/[^a-z0-9]+/gi, "_");
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const points = state.trailPoints.map(p => {
    const t = new Date(p.ts).toISOString();
    const mps = (p.speed / MPS_TO_MPH).toFixed(2);
    return `      <trkpt lat="${p.lat.toFixed(7)}" lon="${p.lng.toFixed(7)}"><time>${t}</time><speed>${mps}</speed></trkpt>`;
  }).join("\n");
  const gpx = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Diamond O Farms" xmlns="http://www.topografix.com/GPX/1/1">
  <metadata><name>${state.field.name || "Trail"}</name><time>${new Date().toISOString()}</time></metadata>
  <trk><name>${state.equipment.name || "Machine"} — ${state.field.name || "Field"}</name>
    <trkseg>
${points}
    </trkseg>
  </trk>
</gpx>`;
  downloadFile(`DiamondO_${fieldName}_${ts}.gpx`, gpx, "application/gpx+xml");
});
function boundaryKML() {
  if (!state.boundary.points || state.boundary.points.length < 3) return "";
  const ring = state.boundary.points.concat([state.boundary.points[0]])
    .map(p => `${p.lng.toFixed(7)},${p.lat.toFixed(7)},0`).join(" ");
  return `
    <Placemark><name>Field Boundary</name>
      <Style><LineStyle><color>ff03b7ff</color><width>3</width></LineStyle>
        <PolyStyle><color>3303b7ff</color></PolyStyle></Style>
      <Polygon><outerBoundaryIs><LinearRing>
        <coordinates>${ring}</coordinates>
      </LinearRing></outerBoundaryIs></Polygon>
    </Placemark>`;
}
function downloadFile(filename, content, mime) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ============================================================
// REPORTS — with rename, search, filter, sort
// ============================================================

// Build a sensible default report title: "Field - Crop - M/D" (added feature)
function buildSuggestedReportName() {
  var f = state.field || {};
  var base = (f.name && f.name.trim()) ? f.name.trim() : "Untitled Field";
  var crop = (f.crop && f.crop.trim()) ? f.crop.trim() : "";
  var d = new Date();
  var dateStr = (d.getMonth() + 1) + "/" + d.getDate();
  return base + (crop ? " \u2013 " + crop : "") + " \u2013 " + dateStr;
}

// Save current session as a new report
$("btnSave").addEventListener("click", async () => {
  const id = "REP-" + Date.now();

  // ← NEW: themed dialog to title the report (with a smart default)
  const suggested = buildSuggestedReportName();
  const titled = await showTitleDialog(suggested);
  if (titled === null) { return; }            // Cancel = don't save
  const defaultName = (titled.trim() || suggested);

  const rep = {
    id,
    name: defaultName,
    date: new Date().toISOString(),
    field: { ...state.field },
    equipment: { ...state.equipment },
    sprayer: { ...state.sprayer },
    acres: +state.acres.toFixed(2),
    bushels: Math.round(state.bushels),
    gallons: +state.gallons.toFixed(1),
    boundaryAcres: +state.boundary.acres.toFixed(2),
    coverage: state.boundary.acres > 0
      ? +((state.acres / state.boundary.acres) * 100).toFixed(1) : null,
    avgSpeed: state.speedCount > 0 ? +(state.speedSum / state.speedCount).toFixed(1) : 0,
    maxSpeed: +state.speedMax.toFixed(1),
    weather: { ...(state.weather || {}) },   // ← NEW: spray-record weather
  };
  const all = JSON.parse(localStorage.getItem(LS_REPS) || "{}");
  all[id] = rep;
  localStorage.setItem(LS_REPS, JSON.stringify(all));
  loadReportsList();
  appAlert("Report saved: " + defaultName, "Saved");
  if (typeof updateDataStats === "function") updateDataStats();   // ← NEW LINE
});

// Get all reports as an array, applying search + filter + sort
function getFilteredReports() {
  const all = JSON.parse(localStorage.getItem(LS_REPS) || "{}");
  let list = Object.values(all);

  // Backfill name for old reports that don't have one
  list.forEach(r => { if (!r.name) r.name = (r.field && r.field.name) || r.id; });

  // --- Search ---
  const searchEl = $("repSearch");
  const q = (searchEl && searchEl.value ? searchEl.value : "").trim().toLowerCase();
  if (q) {
    list = list.filter(r => {
      const hay = [
        r.name, r.id,
        r.field && r.field.name, r.field && r.field.crop, r.field && r.field.variety,
        r.equipment && r.equipment.name, r.equipment && r.equipment.type,
      ].filter(Boolean).join(" ").toLowerCase();
      return hay.includes(q);
    });
  }

  // --- Date filter ---
  const dfEl = $("repDateFilter");
  const df = dfEl ? dfEl.value : "all";
  if (df !== "all") {
    const now = Date.now();
    const day = 86400000;
    const cutoffs = {
      today: now - day,
      "7d":  now - 7 * day,
      "30d": now - 30 * day,
      year:  new Date(new Date().getFullYear(), 0, 1).getTime(),
    };
    const cutoff = cutoffs[df];
    if (cutoff != null) list = list.filter(r => new Date(r.date).getTime() >= cutoff);
  }

  // --- Sort ---
  const sortEl = $("repSort");
  const sort = sortEl ? sortEl.value : "date_desc";
  list.sort((a, b) => {
    switch (sort) {
      case "date_asc":   return a.date.localeCompare(b.date);
      case "name_asc":   return (a.name || "").localeCompare(b.name || "");
      case "acres_desc": return (b.acres || 0) - (a.acres || 0);
      case "date_desc":
      default:           return b.date.localeCompare(a.date);
    }
  });

  return list;
}

// Render the filtered list into the <select>
function loadReportsList() {
  const sel = $("repSelect");
  if (!sel) return;
  const prevSelected = sel.value;
  const list = getFilteredReports();
  sel.innerHTML = "";

  list.forEach(r => {
    const o = document.createElement("option");
    o.value = r.id;
    const dateStr = new Date(r.date).toLocaleDateString();
    const acresStr = (r.acres || 0).toFixed(1).padStart(6);
    o.textContent = `${dateStr}  ${acresStr} ac  ${r.name}`;
    sel.appendChild(o);
  });

  // Restore selection if still present
  if (prevSelected && list.some(r => r.id === prevSelected)) sel.value = prevSelected;

  // Update count display
  const total = Object.keys(JSON.parse(localStorage.getItem(LS_REPS) || "{}")).length;
  const countEl = $("repCount");
  if (countEl) {
    countEl.textContent = list.length === total
      ? `${total} report${total !== 1 ? "s" : ""}`
      : `Showing ${list.length} of ${total}`;
  }
}

// Wire up search + filter + sort to re-render live
["repSearch", "repDateFilter", "repSort"].forEach(id => {
  const el = $(id);
  if (!el) return;
  el.addEventListener("input", loadReportsList);
  el.addEventListener("change", loadReportsList);
});

// View
$("btnViewRep").addEventListener("click", () => {
  const all = JSON.parse(localStorage.getItem(LS_REPS) || "{}");
  const r = all[$("repSelect").value];
  if (!r) { appAlert("Select a report first."); return; }
  $("repBody").textContent = formatReport(r);
});

// Rename — NEW
if ($("btnRenameRep")) $("btnRenameRep").addEventListener("click", async () => {
  const all = JSON.parse(localStorage.getItem(LS_REPS) || "{}");
  const id = $("repSelect").value;
  const r = all[id];
  if (!r) { appAlert("Select a report to rename."); return; }
  const current = r.name || (r.field && r.field.name) || id;
  const next = await showRenameDialog(current);   // themed dialog
  if (next == null) return;                       // user hit cancel
  const trimmed = next.trim();
  if (!trimmed) { appAlert("Name cannot be empty."); return; }
  r.name = trimmed;
  all[id] = r;
  localStorage.setItem(LS_REPS, JSON.stringify(all));
  loadReportsList();
  $("repSelect").value = id;                      // keep selection
  $("repBody").textContent = formatReport(r);     // refresh detail
});

// Delete
$("btnDeleteRep").addEventListener("click", async () => {
  const all = JSON.parse(localStorage.getItem(LS_REPS) || "{}");
  const id = $("repSelect").value;
  if (!id || !all[id]) { appAlert("Select a report to delete."); return; }
  if (!(await appConfirm(`Delete report "${all[id].name || id}"? This cannot be undone.`, { title: "Delete report", okLabel: "Delete", danger: true }))) return;
  delete all[id];
  localStorage.setItem(LS_REPS, JSON.stringify(all));
  loadReportsList();
  $("repBody").textContent = "Select a report…";
  if (typeof updateDataStats === "function") updateDataStats();   // ← NEW LINE
});

// Print to PDF — with mobile-friendly back button
$("btnPdfRep").addEventListener("click", () => {
  const all = JSON.parse(localStorage.getItem(LS_REPS) || "{}");
  const r = all[$("repSelect").value];
  if (!r) { appAlert("Select a report first."); return; }
  const html = `
    <html><head><title>${r.name || r.id}</title>
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <style>
      body { font-family: Arial; padding: 20px; color: #111; margin: 0; }
      h1 { margin: 0 0 8px }
      h2 { margin: 20px 0 6px; border-bottom: 1px solid #ccc; padding-bottom: 4px }
      table { width: 100%; border-collapse: collapse; margin-top: 6px }
      td { padding: 6px 8px; border-bottom: 1px solid #eee }
      td:first-child { color: #555; width: 40% }

      /* Action bar — sticky at top, hidden when printing */
      .action-bar {
        position: sticky; top: 0; z-index: 100;
        background: #1a1d23; color: #fff;
        padding: 12px 16px;
        display: flex; gap: 10px; justify-content: space-between;
        box-shadow: 0 2px 8px rgba(0,0,0,0.3);
        margin: -20px -20px 20px -20px;
      }
      .action-bar button {
        flex: 1; padding: 12px 16px; font-size: 16px;
        border: none; border-radius: 6px; cursor: pointer;
        font-weight: bold;
      }
      .btn-back  { background: #555; color: #fff; }
      .btn-print { background: #ffb703; color: #1a1a1a; }
      .btn-back:active  { background: #333; }
      .btn-print:active { background: #d99700; }

      /* Hide action bar when printing */
      @media print {
        .action-bar { display: none !important; }
        body { padding: 30px; }
      }
    </style>
    </head><body>

    <div class="action-bar">
      <button class="btn-back"  onclick="window.close(); setTimeout(()=>history.back(),100);">← Back to App</button>
      <button class="btn-print" onclick="window.print()">🖨️ Print / Save PDF</button>
    </div>

    <h1>🚜 Diamond O Farms — ${r.name || "Field Report"}</h1>
    <div>${new Date(r.date).toLocaleString()} &nbsp;·&nbsp; ${r.id}</div>

    <h2>Field</h2><table>
      <tr><td>Field</td><td>${r.field.name}</td></tr>
      <tr><td>Crop</td><td>${r.field.crop}</td></tr>
      <tr><td>Variety</td><td>${r.field.variety || "—"}</td></tr>
      <tr><td>Boundary Acres</td><td>${r.boundaryAcres}</td></tr>
    </table>

    <h2>Equipment</h2><table>
      <tr><td>Machine</td><td>${r.equipment.name}</td></tr>
      <tr><td>Type</td><td>${r.equipment.type}</td></tr>
      <tr><td>Width</td><td>${r.equipment.width} ft</td></tr>
    </table>

    <h2>Results</h2><table>
      <tr><td>Acres Covered</td><td>${r.acres}</td></tr>
      <tr><td>Coverage %</td><td>${r.coverage != null ? r.coverage + "%" : "—"}</td></tr>
      <tr><td>Avg Speed</td><td>${r.avgSpeed} mph</td></tr>
      <tr><td>Max Speed</td><td>${r.maxSpeed} mph</td></tr>
      <tr><td>Bushels</td><td>${r.bushels}</td></tr>
      <tr><td>Gallons</td><td>${r.gallons}</td></tr>
    </table>

    ${r.equipment.type === "sprayer" ? `
    <h2>Sprayer</h2><table>
      <tr><td>GPA</td><td>${r.sprayer.gpa}</td></tr>
      <tr><td>Nozzle Spacing</td><td>${r.sprayer.nozzle} in</td></tr>
      <tr><td>Target Speed</td><td>${r.sprayer.target} mph</td></tr>
    </table>` : ""}

    </body></html>`;
  const w = window.open("", "_blank");
  w.document.write(html);
  w.document.close();
});

function formatReport(r) {
  return [
    `Name:      ${r.name || "(unnamed)"}`,
    `ID:        ${r.id}`,
    `Date:      ${new Date(r.date).toLocaleString()}`,
    `Field:     ${r.field.name} (${r.field.crop}${r.field.variety ? " / " + r.field.variety : ""})`,
    `Machine:   ${r.equipment.name} — ${r.equipment.type} ${r.equipment.width} ft`,
    `Acres:     ${r.acres}`,
    `Coverage:  ${r.coverage != null ? r.coverage + "%" : "—"} of ${r.boundaryAcres} ac boundary`,
    `Avg Speed: ${r.avgSpeed} mph`,
    `Max Speed: ${r.maxSpeed} mph`,
    `Bushels:   ${r.bushels}`,
    `Gallons:   ${r.gallons}`,
    ``,
    `--- Weather (spray record) ---`,
    `Wind:      ${(r.weather && (r.weather.windSpeed || r.weather.windDir)) ? ((r.weather.windSpeed ? r.weather.windSpeed + " mph " : "") + (r.weather.windDir || "")).trim() : "\u2014"}`,
    `Temp:      ${(r.weather && r.weather.temp) ? r.weather.temp + " \u00B0F" : "\u2014"}`,
    `Sky:       ${(r.weather && r.weather.sky) ? r.weather.sky : "\u2014"}`,
  ].join("\n");
}

// ============================================================
// EXPORT ALL REPORTS AS CSV (spreadsheet-ready) — added feature
// ============================================================
function csvEscape(val) {
  if (val === null || val === undefined) return "";
  var s = String(val);
  if (/[",\n\r]/.test(s)) { s = '"' + s.replace(/"/g, '""') + '"'; }
  return s;
}

function reportsToCSV() {
  var all = JSON.parse(localStorage.getItem(LS_REPS) || "{}");
  var list = Object.values(all);
  list.sort(function (a, b) { return (b.date || "").localeCompare(a.date || ""); });

  var headers = [
    "Date", "Name", "Field", "Crop", "Variety",
    "Machine", "Type", "Width (ft)",
    "Acres", "Boundary Acres", "Coverage %",
    "Avg Speed (mph)", "Max Speed (mph)", "Bushels", "Gallons",
    "Wind Speed (mph)", "Wind Dir", "Temp (F)", "Sky", "Weather Time", "Report ID"
  ];
  var rows = [headers.map(csvEscape).join(",")];

  list.forEach(function (r) {
    var f = r.field || {}, e = r.equipment || {}, w = r.weather || {};
    var row = [
      r.date ? new Date(r.date).toLocaleString() : "",
      r.name || "",
      f.name || "", f.crop || "", f.variety || "",
      e.name || "", e.type || "", (e.width != null ? e.width : ""),
      (r.acres != null ? r.acres : ""),
      (r.boundaryAcres != null ? r.boundaryAcres : ""),
      (r.coverage != null ? r.coverage : ""),
      (r.avgSpeed != null ? r.avgSpeed : ""),
      (r.maxSpeed != null ? r.maxSpeed : ""),
      (r.bushels != null ? r.bushels : ""),
      (r.gallons != null ? r.gallons : ""),
      w.windSpeed || "", w.windDir || "", w.temp || "", w.sky || "",
      w.capturedAt ? new Date(w.capturedAt).toLocaleString() : "",
      r.id || ""
    ];
    rows.push(row.map(csvEscape).join(","));
  });
  return rows.join("\r\n");
}

if ($("btnExportReportsCSV")) {
  $("btnExportReportsCSV").addEventListener("click", function () {
    var all = JSON.parse(localStorage.getItem(LS_REPS) || "{}");
    if (!Object.keys(all).length) { appAlert("No reports to export yet."); return; }
    var csv = reportsToCSV();
    var ts = new Date().toISOString().slice(0, 10);
    downloadFile("DiamondO_Reports_" + ts + ".csv", "\ufeff" + csv, "text/csv;charset=utf-8");
  });
}

// ============================================================
// UTILITIES
// ============================================================
function setGpsPill(ok, accuracyM) {
  const p = $("gpsPill");
  if (!p) return;
  if (!ok) {
    p.textContent = "GPS: OFF";
    p.className = "pill pill-bad";
    return;
  }
  if (accuracyM == null || !isFinite(accuracyM)) {
    p.textContent = "GPS: …";
    p.className = "pill pill-warn";
    return;
  }
  const m = Math.round(accuracyM);
  p.textContent = `GPS: ${m}m`;
  // Color-code by quality
  if (accuracyM <= 5)        p.className = "pill pill-good";   // excellent
  else if (accuracyM <= 15)  p.className = "pill pill-warn";   // usable
  else                       p.className = "pill pill-bad";    // rejected
}
function setMode(m) { $("modePill").textContent = m; }
function avg(a) { return a.length ? a.reduce((x,y)=>x+y,0)/a.length : 0; }
function cellKey(lat, lng) {
  return Math.round(lat/CELL_SIZE_DEG) + "_" + Math.round(lng/CELL_SIZE_DEG);
}
function haversine(lat1, lng1, lat2, lng2) {
  const R = 6371000, toRad = (d) => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1), dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat/2)**2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng/2)**2;
  return 2 * R * Math.asin(Math.sqrt(a));
}
function bearingDeg(lat1, lng1, lat2, lng2) {
  const toRad = (d) => d * Math.PI / 180, toDeg = (r) => r * 180 / Math.PI;
  const y = Math.sin(toRad(lng2-lng1)) * Math.cos(toRad(lat2));
  const x = Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) -
            Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(toRad(lng2-lng1));
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}
function offsetMeters(lat, lng, bearing, meters) {
  const R = 6371000, br = bearing * Math.PI/180;
  const latR = lat * Math.PI/180, lngR = lng * Math.PI/180, dR = meters / R;
  const lat2 = Math.asin(Math.sin(latR)*Math.cos(dR) + Math.cos(latR)*Math.sin(dR)*Math.cos(br));
  const lng2 = lngR + Math.atan2(Math.sin(br)*Math.sin(dR)*Math.cos(latR), Math.cos(dR)-Math.sin(latR)*Math.sin(lat2));
  return { lat: lat2 * 180/Math.PI, lng: lng2 * 180/Math.PI };
}
function extendLine(a, b, meters) {
  const brg = bearingDeg(a.lat, a.lng, b.lat, b.lng);
  const back = (brg + 180) % 360;
  return [ offsetMeters(a.lat, a.lng, back, meters), offsetMeters(b.lat, b.lng, brg, meters) ];
}
// ============================================================
// DATA EXPORT / IMPORT — sync between devices
// ============================================================
const BACKUP_VERSION = 1;
const LS_BACKUP_ROLLBACK = "dof_last_rollback";

// Summary text for the Backup card
function updateDataStats() {
  const el = $("dataStats");
  if (!el) return;
  const fields = Object.keys(JSON.parse(localStorage.getItem(LS_FIELDS) || "{}")).length;
  const equip  = Object.keys(JSON.parse(localStorage.getItem(LS_EQ)     || "{}")).length;
  const reps   = Object.keys(JSON.parse(localStorage.getItem(LS_REPS)   || "{}")).length;
  el.innerHTML = `Currently stored on this device:<br>
    <b>${fields}</b> field${fields !== 1 ? "s" : ""} ·
    <b>${equip}</b> machine${equip !== 1 ? "s" : ""} ·
    <b>${reps}</b> report${reps !== 1 ? "s" : ""}`;
}

// Build the full backup object
function buildBackup() {
  return {
    app: "Diamond O Farms — Data Systems Pro",
    version: BACKUP_VERSION,
    exportedAt: new Date().toISOString(),
    fields:    JSON.parse(localStorage.getItem(LS_FIELDS) || "{}"),
    equipment: JSON.parse(localStorage.getItem(LS_EQ)     || "{}"),
    reports:   JSON.parse(localStorage.getItem(LS_REPS)   || "{}"),
  };
}

// ===== Export =====
$("btnExportAll")?.addEventListener("click", async () => {
  const backup = buildBackup();
  const ts = new Date().toISOString().slice(0, 10);   // YYYY-MM-DD
  const filename = `diamond-o-backup-${ts}.json`;
  const json = JSON.stringify(backup, null, 2);
  downloadFile(filename, json, "application/json");

  const totals = {
    fields:    Object.keys(backup.fields).length,
    equipment: Object.keys(backup.equipment).length,
    reports:   Object.keys(backup.reports).length,
  };
  appAlert(`✅ Exported successfully!\n\n` +
        `${totals.fields} fields\n` +
        `${totals.equipment} machines\n` +
        `${totals.reports} reports\n\n` +
        `File: ${filename}`, "Backup exported");
});

// ===== Import =====
$("btnImportAll")?.addEventListener("click", () => {
  $("importFileInput").click();   // proxy click to hidden file input
});

$("importFileInput")?.addEventListener("change", (e) => {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (ev) => {
    try {
      const data = JSON.parse(ev.target.result);
      handleImport(data);
    } catch (err) {
      appAlert("❌ That doesn't look like a valid backup file.\n\nError: " + err.message, "Import failed");
    } finally {
      // Reset the input so the same file can be picked again later
      e.target.value = "";
    }
  };
  reader.readAsText(file);
});

// Validate + ask user → merge or replace
async function handleImport(data) {
  // Basic validation
  if (!data || typeof data !== "object") {
    return appAlert("❌ Invalid backup file: not a JSON object.", "Import failed");
  }
  if (data.app !== "Diamond O Farms — Data Systems Pro") {
    return appAlert("❌ This file isn't a Diamond O Farms backup.", "Import failed");
  }
  if (typeof data.version !== "number") {
    return appAlert("❌ Backup file is missing version info.", "Import failed");
  }
  if (data.version > BACKUP_VERSION) {
    return appAlert(`❌ This backup was created by a newer version of the app (v${data.version}).\nUpdate the app and try again.`, "Import failed");
  }

  const incoming = {
    fields:    Object.keys(data.fields    || {}).length,
    equipment: Object.keys(data.equipment || {}).length,
    reports:   Object.keys(data.reports   || {}).length,
  };
  const current = {
    fields:    Object.keys(JSON.parse(localStorage.getItem(LS_FIELDS) || "{}")).length,
    equipment: Object.keys(JSON.parse(localStorage.getItem(LS_EQ)     || "{}")).length,
    reports:   Object.keys(JSON.parse(localStorage.getItem(LS_REPS)   || "{}")).length,
  };

  const summary =
    `📥 Backup file contents:\n` +
    `  • ${incoming.fields} fields\n` +
    `  • ${incoming.equipment} machines\n` +
    `  • ${incoming.reports} reports\n\n` +
    `Currently on this device:\n` +
    `  • ${current.fields} fields\n` +
    `  • ${current.equipment} machines\n` +
    `  • ${current.reports} reports\n\n` +
    `MERGE adds the backup's data and keeps yours.\n` +
    `REPLACE deletes everything here first, then loads the backup.`;

  // OK = Merge (safe default), Cancel = go to Replace path
  const mergeChoice = await appConfirm(summary, {
    title: "Import backup",
    okLabel: "Merge (safe)",
    cancelLabel: "Replace…"
  });

  if (mergeChoice) {
    performImport(data, "merge");
  } else {
    const replaceConfirmed = await appConfirm(
      "⚠️ REPLACE will DELETE all existing fields, machines, and reports on this device, " +
      "then load the backup file's data.\n\n" +
      "Your current data will be saved as a one-time rollback you can restore via the console.\n\n" +
      "Are you sure you want to REPLACE?",
      { title: "Replace all data?", okLabel: "Replace everything", cancelLabel: "Cancel", danger: true }
    );
    if (replaceConfirmed) performImport(data, "replace");
  }
}

// Actually do the import
function performImport(data, mode) {
  // 1. Snapshot current state as rollback
  const rollback = buildBackup();
  localStorage.setItem(LS_BACKUP_ROLLBACK, JSON.stringify(rollback));

  // 2. Merge or replace each library
  if (mode === "replace") {
    localStorage.setItem(LS_FIELDS, JSON.stringify(data.fields    || {}));
    localStorage.setItem(LS_EQ,     JSON.stringify(data.equipment || {}));
    localStorage.setItem(LS_REPS,   JSON.stringify(data.reports   || {}));
  } else {
    // merge: incoming keys win on conflict
    const mergeLib = (lsKey, incoming) => {
      const existing = JSON.parse(localStorage.getItem(lsKey) || "{}");
      const merged = { ...existing, ...(incoming || {}) };
      localStorage.setItem(lsKey, JSON.stringify(merged));
    };
    mergeLib(LS_FIELDS, data.fields);
    mergeLib(LS_EQ,     data.equipment);
    mergeLib(LS_REPS,   data.reports);
  }

  // 3. Reload all UI
  loadFieldsList();
  loadEquipmentList();
  loadReportsList();
  updateDataStats();

  appAlert(`✅ Import complete (${mode === "replace" ? "REPLACED" : "MERGED"})!\n\n` +
        `Your previous data is saved as a rollback in case you need it.\n` +
        `To restore, open the browser console and run:\n\n` +
        `  restoreRollback()`, "Import complete");
}

// Console-accessible rollback (in case the user regrets a replace)
window.restoreRollback = async function () {
  const raw = localStorage.getItem(LS_BACKUP_ROLLBACK);
  if (!raw) return appAlert("No rollback available.");
  try {
    const data = JSON.parse(raw);
    if (!(await appConfirm("Restore previous data? This will OVERWRITE current fields/equipment/reports.", { title: "Restore rollback", okLabel: "Restore", danger: true }))) return;
    localStorage.setItem(LS_FIELDS, JSON.stringify(data.fields    || {}));
    localStorage.setItem(LS_EQ,     JSON.stringify(data.equipment || {}));
    localStorage.setItem(LS_REPS,   JSON.stringify(data.reports   || {}));
    loadFieldsList();
    loadEquipmentList();
    loadReportsList();
    updateDataStats();
    appAlert("✅ Rollback restored.", "Restored");
  } catch (e) {
    appAlert("Rollback file is corrupted: " + e.message, "Error");
  }
};
window.addEventListener("DOMContentLoaded", () => {
  loadEquipmentList();
  loadReportsList();
  loadFieldsList();
  applyEquipmentUI();
  renderSectionButtons();
  startLocationFollow();
  showEqSubmenu($("eqType").value);
  updateEqSummary();
  updatePlanterCalcWidth();
  updateDataStats();                    // ← initialize backup card summary
});

// ============================================================
// METRICS PANEL TOGGLE + iOS-FRIENDLY "EXPAND MAP" (CSS fullscreen)
// Added feature — does not modify existing logic.
// ============================================================
(function setupMapToggles() {
  function ready(fn) {
    if (document.readyState !== "loading") fn();
    else document.addEventListener("DOMContentLoaded", fn);
  }
  ready(function () {
    const layout = document.querySelector(".operate-layout");
    const mapCol = document.querySelector(".map-col");
    const btnMetrics = document.getElementById("btnToggleMetrics");
    const btnExpand = document.getElementById("btnExpandMap");

    // Nudge Google Maps to redraw after the container size changes.
    function resizeMap() {
      if (state.map && window.google && google.maps) {
        setTimeout(() => google.maps.event.trigger(state.map, "resize"), 60);
      }
    }

    // --- Show / Hide the metrics side panel ---
    if (btnMetrics && layout) {
      // Restore last choice
      try {
        if (localStorage.getItem("metricsCollapsed") === "1") {
          layout.classList.add("metrics-collapsed");
          btnMetrics.textContent = "📊 Show Metrics";
        }
      } catch (e) {}
      btnMetrics.addEventListener("click", function () {
        const collapsed = layout.classList.toggle("metrics-collapsed");
        btnMetrics.textContent = collapsed ? "📊 Show Metrics" : "📊 Hide Metrics";
        try { localStorage.setItem("metricsCollapsed", collapsed ? "1" : "0"); } catch (e) {}
        resizeMap();
      });
    }

    // --- Expand map to full screen (CSS-based, works on iOS) ---
    if (btnExpand && mapCol) {
      btnExpand.addEventListener("click", function () {
        const expanded = mapCol.classList.toggle("map-expanded");
        btnExpand.textContent = expanded ? "🗗 Exit Full Map" : "⛶ Expand Map";
        // Prevent body scroll while the map is fullscreen
        document.body.style.overflow = expanded ? "hidden" : "";
        resizeMap();
      });
    }
  });
})();

// ============================================================
// DAY / NIGHT THEME TOGGLE
// ☀️ Day = cream (default), 🌙 Night = dark. Remembers your choice.
// Added feature — does not modify existing logic.
// ============================================================
(function setupThemeToggle() {
  function ready(fn) {
    if (document.readyState !== "loading") fn();
    else document.addEventListener("DOMContentLoaded", fn);
  }
  ready(function () {
    try {
      var btn = document.getElementById("btnThemeToggle");
      var body = document.body;

      function applyTheme(night) {
        if (night) {
          body.classList.add("night-mode");
          if (btn) btn.textContent = "☀️ Day";
        } else {
          body.classList.remove("night-mode");
          if (btn) btn.textContent = "🌙 Night";
        }
        // Redraw the Google map ONLY if it actually exists. Guarded so a
        // missing/failed Google Maps load can never break the toggle.
        try {
          if (typeof state !== "undefined" && state.map && window.google && google.maps) {
            setTimeout(function () {
              google.maps.event.trigger(state.map, "resize");
            }, 60);
          }
        } catch (e) { /* map not ready - ignore */ }
      }

      // Restore saved preference (default = day/cream)
      var night = false;
      try { night = localStorage.getItem("theme") === "night"; } catch (e) {}
      applyTheme(night);

      if (btn) {
        btn.addEventListener("click", function () {
          var isNight = !body.classList.contains("night-mode");
          applyTheme(isNight);
          try { localStorage.setItem("theme", isNight ? "night" : "day"); } catch (e) {}
        });
      }
    } catch (err) {
      try { console.error("Theme toggle setup failed:", err); } catch (e) {}
    }
  });
})();
