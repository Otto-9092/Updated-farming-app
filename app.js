// ============================================================
// APP VERSION — bump this string whenever you ship an update.
// Also update the ?v= query in index.html so devices fetch fresh files.
// ============================================================
window.APP_VERSION = "2026.06.03 · 17:05";
try { console.log("Diamond O Farms — Data Systems Pro v" + window.APP_VERSION); } catch (e) {}

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
  harvest:  { expectedYield: "", startMoisture: "", log: [] },  // per-session harvest readings
  harvestTimer: null,
  // Tank + load tracking (reset per session)
  tankGallonsAtRefill: 0,   // state.gallons value at the last refill (sprayer)
  loads: 0,                 // sprayer refills OR combine unloads this session
  loadLog: [],              // timestamped load events
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
    if (t.dataset.tab === "setup") { seedMixCalcFromState(); seedCostAcresFromState(); }   // ← refresh calc inputs
    if (t.dataset.tab === "season") renderSeason();   // ← refresh season dashboard
  });
});

// ============================================================
// PRODUCT / CHEMICAL MIX CALCULATOR (sprayer) — added feature
// Computes per-tank and whole-field product amounts.
// ============================================================
// Conversions to a base "fluid ounces" for liquids; lb handled separately.
const MIX_TO_OZ = { oz: 1, pt: 16, qt: 32, gal: 128 };

// Pull live tank size, GPA, and field acres into the calc inputs (only if
// the user hasn't already typed something there).
function seedMixCalcFromState() {
  var tankEl = $("mixTank"), gpaEl = $("mixGPA"), acEl = $("mixAcres");
  if (tankEl && !tankEl.value) {
    var t = parseFloat(state.sprayer && state.sprayer.tank);
    if (t > 0) tankEl.value = t;
  }
  if (gpaEl && !gpaEl.value) {
    var g = parseFloat(state.sprayer && state.sprayer.gpa);
    if (g > 0) gpaEl.value = g;
  }
  if (acEl && !acEl.value) {
    var a = (state.boundary && state.boundary.acres > 0) ? state.boundary.acres : 0;
    if (a > 0) acEl.value = +a.toFixed(2);
  }
}

function readMixProducts() {
  var out = [];
  for (var i = 1; i <= 6; i++) {
    var name = ($("mixName" + i) && $("mixName" + i).value || "").trim();
    var rate = parseFloat($("mixRate" + i) && $("mixRate" + i).value) || 0;
    var unit = ($("mixUnit" + i) && $("mixUnit" + i).value) || "oz";
    if (rate > 0) out.push({ name: name || ("Product " + i), rate: rate, unit: unit });
  }
  return out;
}

// Format a fluid-ounce amount into the friendliest unit (oz / pt / qt / gal)
function prettyFluid(oz) {
  if (oz >= 128) return (oz / 128).toFixed(2) + " gal";
  if (oz >= 32)  return (oz / 32).toFixed(2) + " qt";
  if (oz >= 16)  return (oz / 16).toFixed(2) + " pt";
  return oz.toFixed(1) + " oz";
}

function calcMix() {
  var tank  = parseFloat($("mixTank").value)  || 0;
  var gpa   = parseFloat($("mixGPA").value)   || 0;
  var acres = parseFloat($("mixAcres").value) || 0;
  var products = readMixProducts();
  var resEl = $("mixResults");
  if (!resEl) return;

  if (!products.length) {
    resEl.innerHTML = '<div class="hint">Enter at least one product rate, then tap Calculate.</div>';
    return;
  }
  if (gpa <= 0 || tank <= 0) {
    resEl.innerHTML = '<div class="hint">Enter a Tank Size and Carrier Rate (GPA) to calculate per-tank amounts.</div>';
    return;
  }

  // Acres one full tank can cover at this carrier rate
  var acresPerTank = tank / gpa;

  var rows = products.map(function (p) {
    var perTank, perField, isDry = (p.unit === "lb");
    if (isDry) {
      // lb/ac → per tank = rate * acresPerTank ; field = rate * acres
      perTank  = p.rate * acresPerTank;
      perField = acres > 0 ? p.rate * acres : null;
      var perTankStr  = perTank.toFixed(2) + " lb";
      var perFieldStr = perField != null ? perField.toFixed(2) + " lb" : "\u2014";
    } else {
      var ozPerAc = p.rate * (MIX_TO_OZ[p.unit] || 1);
      perTank  = ozPerAc * acresPerTank;          // in oz
      perField = acres > 0 ? ozPerAc * acres : null;
      var perTankStr  = prettyFluid(perTank);
      var perFieldStr = perField != null ? prettyFluid(perField) : "\u2014";
    }
    return '<tr><td>' + escHtml(p.name) + '</td><td>' + p.rate + " " + p.unit + '/ac</td>' +
           '<td class="num">' + perTankStr + '</td>' +
           '<td class="num">' + perFieldStr + '</td></tr>';
  }).join("");

  // Tanks needed for the whole field
  var tanksNeeded = (acres > 0) ? acres / acresPerTank : null;

  var meta = '<div class="hint" style="margin-bottom:8px;">' +
    'One tank (' + tank + ' gal @ ' + gpa + ' GPA) covers <b>' + acresPerTank.toFixed(1) + ' ac</b>' +
    (tanksNeeded != null ? ' \u2022 Field needs <b>' + tanksNeeded.toFixed(1) + ' tank' + (tanksNeeded >= 1.05 ? 's' : '') + '</b>' : '') +
    '</div>';

  resEl.innerHTML = meta +
    '<table><tr><th>Product</th><th>Rate</th><th class="num">Per Tank</th><th class="num">Whole Field</th></tr>' +
    rows + '</table>';
}

function resetMix() {
  for (var i = 1; i <= 6; i++) {
    if ($("mixName" + i)) $("mixName" + i).value = "";
    if ($("mixRate" + i)) $("mixRate" + i).value = "";
    if ($("mixUnit" + i)) $("mixUnit" + i).value = "oz";
  }
  if ($("mixResults")) $("mixResults").innerHTML = "";
}

if ($("btnMixCalc"))  $("btnMixCalc").addEventListener("click", calcMix);
if ($("btnMixReset")) $("btnMixReset").addEventListener("click", resetMix);

// ============================================================
// COST & PROFIT (per field) — added feature
// ============================================================
const COST_FIELDS = ["costSeed","costChem","costFert","costFuel","costOther","costYield","costPrice"];

function readCostInputs() {
  return {
    seed:  parseFloat($("costSeed").value)  || 0,
    chem:  parseFloat($("costChem").value)  || 0,
    fert:  parseFloat($("costFert").value)  || 0,
    fuel:  parseFloat($("costFuel").value)  || 0,
    other: parseFloat($("costOther").value) || 0,
    yield: parseFloat($("costYield").value) || 0,
    price: parseFloat($("costPrice").value) || 0,
    acres: parseFloat($("costAcres").value) || 0,
  };
}

function writeCostInputs(c) {
  c = c || {};
  if ($("costSeed"))  $("costSeed").value  = c.seed  ? c.seed  : "";
  if ($("costChem"))  $("costChem").value  = c.chem  ? c.chem  : "";
  if ($("costFert"))  $("costFert").value  = c.fert  ? c.fert  : "";
  if ($("costFuel"))  $("costFuel").value  = c.fuel  ? c.fuel  : "";
  if ($("costOther")) $("costOther").value = c.other ? c.other : "";
  if ($("costYield")) $("costYield").value = c.yield ? c.yield : "";
  if ($("costPrice")) $("costPrice").value = c.price ? c.price : "";
}

function seedCostAcresFromState() {
  var acEl = $("costAcres");
  if (acEl && !acEl.value) {
    var a = (state.boundary && state.boundary.acres > 0) ? state.boundary.acres : 0;
    if (a > 0) acEl.value = +a.toFixed(2);
  }
}

function computeCostSummary(c) {
  var perAcCost = (c.seed||0)+(c.chem||0)+(c.fert||0)+(c.fuel||0)+(c.other||0);
  var revPerAc  = (c.yield||0) * (c.price||0);
  var profitPerAc = revPerAc - perAcCost;
  var acres = c.acres || 0;
  return {
    perAcCost: perAcCost,
    revPerAc: revPerAc,
    profitPerAc: profitPerAc,
    acres: acres,
    totalCost: acres > 0 ? perAcCost * acres : null,
    totalRev:  acres > 0 ? revPerAc  * acres : null,
    totalProfit: acres > 0 ? profitPerAc * acres : null,
    breakeven: (c.yield||0) > 0 ? perAcCost / c.yield : null,
  };
}

function fmtMoney(n) {
  if (n == null || isNaN(n)) return "\u2014";
  var neg = n < 0;
  var s = "$" + Math.abs(n).toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2});
  return neg ? "-" + s : s;
}

function calcCost() {
  var c = readCostInputs();
  var s = computeCostSummary(c);
  var resEl = $("costResults");
  if (!resEl) return;
  var pc = function(v){ return v >= 0 ? "profit-pos" : "profit-neg"; };
  resEl.innerHTML =
    '<table>' +
    '<tr><th>Per Acre</th><th class="num">Amount</th></tr>' +
    '<tr><td>Total Cost</td><td class="num">' + fmtMoney(s.perAcCost) + '</td></tr>' +
    '<tr><td>Revenue (' + (c.yield||0) + ' bu \u00D7 ' + fmtMoney(c.price) + ')</td><td class="num">' + fmtMoney(s.revPerAc) + '</td></tr>' +
    '<tr class="mix-total"><td>Profit / Acre</td><td class="num ' + pc(s.profitPerAc) + '">' + fmtMoney(s.profitPerAc) + '</td></tr>' +
    '</table>' +
    (s.acres > 0 ?
      '<table style="margin-top:8px;">' +
      '<tr><th>Whole Field (' + s.acres.toFixed(1) + ' ac)</th><th class="num">Amount</th></tr>' +
      '<tr><td>Total Cost</td><td class="num">' + fmtMoney(s.totalCost) + '</td></tr>' +
      '<tr><td>Total Revenue</td><td class="num">' + fmtMoney(s.totalRev) + '</td></tr>' +
      '<tr class="mix-total"><td>Total Profit</td><td class="num ' + pc(s.totalProfit) + '">' + fmtMoney(s.totalProfit) + '</td></tr>' +
      '</table>' : '<div class="hint" style="margin-top:6px;">Enter Acres for whole-field totals.</div>') +
    (s.breakeven != null ? '<div class="hint" style="margin-top:6px;">Break-even price: <b>' + fmtMoney(s.breakeven) + '/bu</b></div>' : '');
}

function resetCost() {
  COST_FIELDS.forEach(function(id){ if ($(id)) $(id).value = ""; });
  if ($("costAcres")) $("costAcres").value = "";
  if ($("costResults")) $("costResults").innerHTML = "";
}

if ($("btnCostCalc"))  $("btnCostCalc").addEventListener("click", calcCost);
if ($("btnCostReset")) $("btnCostReset").addEventListener("click", resetCost);

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
// HARVEST DIALOGS (combine only) — added feature
//  - Harvest Setup at session start: expected yield + start moisture
//  - Harvest Update every 5 min: timestamped yield/moisture/quality log
// ============================================================
const HARVEST_UPDATE_MS = 5 * 60 * 1000;   // 5 minutes
const HARVEST_AUTODISMISS_MS = 60 * 1000;  // auto-close after 60s

// Setup dialog. Resolves true once handled (always proceeds; Skip just
// leaves the baseline blank). Cancel-by-backdrop is treated as Skip.
function showHarvestStartDialog() {
  return new Promise(function (resolve) {
    var h = state.harvest || {};
    if ($id("hsExpYield")) $id("hsExpYield").value = h.expectedYield || "";
    if ($id("hsMoisture")) $id("hsMoisture").value = h.startMoisture || "";
    openDlg("harvestStartDlg", "hsExpYield");

    function cleanup() {
      $id("harvestStartGo").removeEventListener("click", onGo);
      $id("harvestStartSkip").removeEventListener("click", onSkip);
      $id("harvestStartDlg").removeEventListener("click", onBackdrop);
    }
    function commit(save) {
      if (save) {
        state.harvest.expectedYield = ($id("hsExpYield").value || "").trim();
        state.harvest.startMoisture = ($id("hsMoisture").value || "").trim();
      }
      closeDlg("harvestStartDlg"); cleanup(); resolve(true);
    }
    function onGo()   { commit(true); }
    function onSkip() { commit(false); }
    function onBackdrop(ev) { if (ev.target === $id("harvestStartDlg")) onSkip(); }

    $id("harvestStartGo").addEventListener("click", onGo);
    $id("harvestStartSkip").addEventListener("click", onSkip);
    $id("harvestStartDlg").addEventListener("click", onBackdrop);
  });
}

// Recurring update dialog. Logs a timestamped reading on Save; Skip/auto
// just dismisses. Never blocks the session.
function showHarvestUpdateDialog() {
  // Don't stack dialogs if one is already open
  if ($id("harvestUpdateDlg") && !$id("harvestUpdateDlg").classList.contains("hidden")) return;

  var meta = $id("harvestUpdateMeta");
  if (meta) {
    var mins = state.sessionStart ? Math.round((Date.now() - state.sessionStart) / 60000) : 0;
    var n = (state.harvest && state.harvest.log) ? state.harvest.log.length : 0;
    meta.textContent = "Session " + mins + " min in \u2022 " + n + " reading" + (n === 1 ? "" : "s") + " logged so far";
  }
  // Pre-fill with last reading (or baseline) for quick edits
  var last = (state.harvest && state.harvest.log && state.harvest.log.length)
    ? state.harvest.log[state.harvest.log.length - 1] : null;
  if ($id("huYield"))   $id("huYield").value   = last ? last.yield   : (state.harvest.expectedYield || "");
  if ($id("huMoisture"))$id("huMoisture").value= last ? last.moisture: (state.harvest.startMoisture || "");
  if ($id("huQuality")) $id("huQuality").value = "";

  openDlg("harvestUpdateDlg", "huYield");

  var autoTimer = setTimeout(function () { onSkip(); }, HARVEST_AUTODISMISS_MS);

  function cleanup() {
    clearTimeout(autoTimer);
    $id("harvestUpdateSave").removeEventListener("click", onSave);
    $id("harvestUpdateSkip").removeEventListener("click", onSkip);
    $id("harvestUpdateDlg").removeEventListener("click", onBackdrop);
  }
  function onSave() {
    var reading = {
      t: new Date().toISOString(),
      minsIn: state.sessionStart ? Math.round((Date.now() - state.sessionStart) / 60000) : 0,
      yield:    ($id("huYield").value    || "").trim(),
      moisture: ($id("huMoisture").value || "").trim(),
      quality:  ($id("huQuality").value  || "").trim()
    };
    // Only log if at least one value entered
    if (reading.yield || reading.moisture || reading.quality) {
      state.harvest.log = state.harvest.log || [];
      state.harvest.log.push(reading);
      updateHarvestTile();   // ← refresh live tile
    }
    closeDlg("harvestUpdateDlg"); cleanup();
  }
  function onSkip() { closeDlg("harvestUpdateDlg"); cleanup(); }
  function onBackdrop(ev) { if (ev.target === $id("harvestUpdateDlg")) onSkip(); }

  $id("harvestUpdateSave").addEventListener("click", onSave);
  $id("harvestUpdateSkip").addEventListener("click", onSkip);
  $id("harvestUpdateDlg").addEventListener("click", onBackdrop);
}

function startHarvestTimer() {
  stopHarvestTimer();
  state.harvestTimer = setInterval(function () {
    if (state.running && state.equipment.type === "combine") {
      showHarvestUpdateDialog();
    }
  }, HARVEST_UPDATE_MS);
}
function stopHarvestTimer() {
  if (state.harvestTimer != null) { clearInterval(state.harvestTimer); state.harvestTimer = null; }
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

    // Weather is only relevant for spraying — show those fields for
    // sprayers only; hide them for every other equipment type.
    var isSprayer = (e.type === "sprayer");
    var weatherWrap = $id("startDlgWeatherWrap");
    if (weatherWrap) weatherWrap.classList.toggle("hidden", !isSprayer);

    if (isSprayer) {
      // Pre-fill weather with last-used values
      if ($id("dlgWindSpeed")) $id("dlgWindSpeed").value = w.windSpeed || "";
      if ($id("dlgWindDir"))   $id("dlgWindDir").value   = w.windDir   || "";
      if ($id("dlgTemp"))      $id("dlgTemp").value      = w.temp      || "";
      if ($id("dlgSky"))       $id("dlgSky").value       = w.sky       || "";
    }

    openDlg("startDlg", isSprayer ? "dlgWindSpeed" : "startDlgGo");

    function cleanup() {
      $id("startDlgGo").removeEventListener("click", onGo);
      $id("startDlgCancel").removeEventListener("click", onCancel);
      $id("startDlg").removeEventListener("click", onBackdrop);
    }
    function onGo() {
      // Save weather only for sprayers; clear it for other equipment so
      // non-spray reports don't carry weather data that doesn't apply.
      if (isSprayer) {
        state.weather = {
          windSpeed: ($id("dlgWindSpeed").value || "").trim(),
          windDir:   ($id("dlgWindDir").value   || "").trim(),
          temp:      ($id("dlgTemp").value      || "").trim(),
          sky:       ($id("dlgSky").value       || "").trim(),
          capturedAt: new Date().toISOString()
        };
      } else {
        state.weather = { windSpeed: "", windDir: "", temp: "", sky: "", capturedAt: "" };
      }
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

  // ← NEW: harvest setup (combine only) — expected yield + start moisture
  state.harvest = { expectedYield: "", startMoisture: "", log: [] };
  if (state.equipment.type === "combine") {
    await showHarvestStartDialog();
  }
  updateHarvestTile();   // ← seed live tile with baseline
  updateTankAndLoads();  // ← seed tank/load tiles

  state.running = true;
  state.sessionStart = Date.now();
  state.acres = 0; state.bushels = 0; state.gallons = 0;
  // Reset tank + load tracking for the new session
  state.tankGallonsAtRefill = 0;
  state.loads = 0;
  state.loadLog = [];
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

  // ← NEW: kick off recurring harvest update prompts for combines
  if (state.equipment.type === "combine") startHarvestTimer();
}

function stopSession() {
  state.running = false;
  stopHarvestTimer();   // ← NEW: end recurring harvest prompts
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

  // keep tank-remaining / countdown / loads tiles live
  updateTankAndLoads();

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

  // Live harvest tiles (latest yield/moisture) — combines only.
  const isCombine = state.equipment.type === "combine";
  const yBox = $("mYieldBox"), mBox = $("mMoistBox");
  if (yBox) yBox.classList.toggle("hidden", !isCombine);
  if (mBox) mBox.classList.toggle("hidden", !isCombine);
  updateHarvestTile();

  // Section Control is a sprayer-only feature — hide it otherwise.
  const secCard = $("sectionControlCard");
  if (secCard) secCard.classList.toggle("hidden", !isSprayer);

  // Tank Remaining + Refill countdown tiles — sprayer only
  ["mTankLeftBox","mAcToEmptyBox","mMinToEmptyBox"].forEach(function(id){
    var el = $(id); if (el) el.classList.toggle("hidden", !isSprayer);
  });
  // Loads tile — sprayer (refills) or combine (unloads)
  var loadsBox = $("mLoadsBox");
  if (loadsBox) loadsBox.classList.toggle("hidden", !(isSprayer || isCombine));

  // Tank & Loads card + its two buttons
  var tlCard = $("tankLoadsCard");
  if (tlCard) tlCard.classList.toggle("hidden", !(isSprayer || isCombine));
  var refillBtn = $("btnRefill"), unloadBtn = $("btnUnload");
  if (refillBtn) refillBtn.classList.toggle("hidden", !isSprayer);
  if (unloadBtn) unloadBtn.classList.toggle("hidden", !isCombine);
  var tlTitle = $("tankLoadsTitle");
  if (tlTitle) tlTitle.textContent = isCombine ? "Grain Loads" : "Tank & Loads";

  updateTankAndLoads();
}

// ============================================================
// TANK REMAINING + REFILL COUNTDOWN (sprayer) + LOAD COUNTER
// ============================================================
const LOW_TANK_FRAC = 0.15;   // warn at 15% remaining

function updateTankAndLoads() {
  const isSprayer = state.equipment.type === "sprayer";
  const isCombine = state.equipment.type === "combine";

  const loadsEl = $("mLoads");
  if (loadsEl) loadsEl.textContent = state.loads || 0;

  if (!isSprayer) return;

  const cap = parseFloat(state.sprayer.tank) || 0;
  const usedSinceRefill = Math.max(0, state.gallons - (state.tankGallonsAtRefill || 0));
  const remaining = cap > 0 ? Math.max(0, cap - usedSinceRefill) : 0;

  const tankEl = $("mTankLeft");
  if (tankEl) tankEl.textContent = cap > 0 ? remaining.toFixed(0) : "\u2014";

  const gpa = parseFloat(state.sprayer.gpa) || 0;
  const acToEmpty = (cap > 0 && gpa > 0) ? remaining / gpa : null;
  const acEl = $("mAcToEmpty");
  if (acEl) acEl.textContent = acToEmpty != null ? acToEmpty.toFixed(1) : "\u2014";

  const gpm = state.liveGPM || 0;
  const minEl = $("mMinToEmpty");
  if (minEl) {
    if (cap > 0 && gpm > 0.05) minEl.textContent = Math.round(remaining / gpm);
    else minEl.textContent = "\u2014";
  }

  const low = cap > 0 && remaining <= cap * LOW_TANK_FRAC;
  ["mTankLeftBox","mAcToEmptyBox","mMinToEmptyBox"].forEach(function(id){
    var box = $(id); if (box) box.classList.toggle("low-tank", low);
  });
}

function doRefill() {
  if (state.equipment.type !== "sprayer") return;
  state.tankGallonsAtRefill = state.gallons;
  state.loads = (state.loads || 0) + 1;
  state.loadLog = state.loadLog || [];
  state.loadLog.push({
    t: new Date().toISOString(),
    minsIn: state.sessionStart ? Math.round((Date.now() - state.sessionStart) / 60000) : 0,
    type: "refill",
    n: state.loads,
    acresAt: +state.acres.toFixed(2),
    gallonsAt: +state.gallons.toFixed(1)
  });
  updateTankAndLoads();
  appAlert("Tank refilled \u2014 load #" + state.loads + " started.", "\uD83D\uDEB0 Refill logged");
}

function doUnload() {
  if (state.equipment.type !== "combine") return;
  state.loads = (state.loads || 0) + 1;
  state.loadLog = state.loadLog || [];
  state.loadLog.push({
    t: new Date().toISOString(),
    minsIn: state.sessionStart ? Math.round((Date.now() - state.sessionStart) / 60000) : 0,
    type: "unload",
    n: state.loads,
    acresAt: +state.acres.toFixed(2),
    bushelsAt: Math.round(state.bushels)
  });
  updateTankAndLoads();
  appAlert("Grain unloaded \u2014 load #" + state.loads + " recorded.", "\uD83D\uDCE4 Unload logged");
}

// Refresh the live Yield/Moisture tiles from the latest harvest reading
// (falls back to the harvest baseline if no readings logged yet).
function updateHarvestTile() {
  const h = state.harvest || {};
  const log = h.log || [];
  const last = log.length ? log[log.length - 1] : null;
  const yieldVal = last && last.yield     ? last.yield     : (h.expectedYield || "");
  const moistVal = last && last.moisture  ? last.moisture  : (h.startMoisture || "");
  const yEl = $("mYield"), mEl = $("mMoist");
  if (yEl) yEl.textContent = yieldVal !== "" ? yieldVal : "\u2014";
  if (mEl) mEl.textContent = moistVal !== "" ? moistVal : "\u2014";
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
    fields: ["cmTank"],
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
  state.equipment.type = type;               // ← ensure type is current
  // Pull values from the visible sub-menu into state
  const values = readEqParams(type).values;
  applyEqParamsToState(type, values);
  applyEquipmentUI();                        // ← refresh which metric tiles show
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
    state.combine.tankCapacity  = parseFloat(values.cmTank) || 0;
    // expectedYield + moisture now come from the Harvest Setup dialog at start
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
    text = `Combine: ${c.tankCapacity || "?"} bu grain tank (yield & moisture set at harvest start)`;
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
    cost: readCostInputs(),   // ← per-field cost/profit inputs
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
  writeCostInputs(f.cost);   // ← restore per-field cost inputs
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

// Tank refill (sprayer) + grain unload (combine)
if ($("btnRefill")) $("btnRefill").addEventListener("click", doRefill);
if ($("btnUnload")) $("btnUnload").addEventListener("click", doUnload);

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
    harvest: (state.equipment.type === "combine")
      ? { expectedYield: state.harvest.expectedYield,
          startMoisture: state.harvest.startMoisture,
          log: (state.harvest.log || []).slice() }
      : null,                                 // ← NEW: harvest readings log
    loads: state.loads || 0,                  // ← NEW: refill/unload count
    loadLog: (state.loadLog || []).slice(),   // ← NEW: timestamped load events
    cost: (function(){                        // ← NEW: cost/profit snapshot
      var ci = readCostInputs();
      if (!ci.acres) ci.acres = +state.acres.toFixed(2) || +state.boundary.acres.toFixed(2) || 0;
      return { inputs: ci, summary: computeCostSummary(ci) };
    })(),
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

    ${r.harvest ? `
    <h2>🌾 Harvest Record</h2><table>
      <tr><td>Expected Yield</td><td>${r.harvest.expectedYield ? r.harvest.expectedYield + " bu/ac" : "—"}</td></tr>
      <tr><td>Start Moisture</td><td>${r.harvest.startMoisture ? r.harvest.startMoisture + " %" : "—"}</td></tr>
    </table>
    ${(r.harvest.log && r.harvest.log.length) ? `
    <h3>Readings (${r.harvest.log.length})</h3>
    <table>
      <tr><th>#</th><th>Time</th><th>Yield (bu/ac)</th><th>Moisture (%)</th><th>Quality / notes</th></tr>
      ${r.harvest.log.map((x, i) => `<tr>
        <td>${i + 1}</td>
        <td>${x.minsIn != null ? x.minsIn + " min" : new Date(x.t).toLocaleTimeString()}</td>
        <td>${x.yield || "—"}</td>
        <td>${x.moisture || "—"}</td>
        <td>${x.quality || "—"}</td>
      </tr>`).join("")}
    </table>` : `<p>No readings logged.</p>`}
    ` : ""}

    ${(r.loadLog && r.loadLog.length) ? `
    <h2>${r.equipment && r.equipment.type === "combine" ? "📤 Grain Unloads" : "🚰 Tank Refills"} (${r.loads || r.loadLog.length})</h2>
    <table>
      <tr><th>#</th><th>Time</th><th>Acres</th><th>${r.equipment && r.equipment.type === "combine" ? "Bushels" : "Gallons"}</th></tr>
      ${r.loadLog.map((x) => `<tr>
        <td>${x.n}</td>
        <td>${x.minsIn != null ? x.minsIn + " min" : new Date(x.t).toLocaleTimeString()}</td>
        <td>${x.acresAt != null ? x.acresAt : "—"}</td>
        <td>${x.bushelsAt != null ? x.bushelsAt : (x.gallonsAt != null ? x.gallonsAt : "—")}</td>
      </tr>`).join("")}
    </table>` : (r.loads ? `<h2>Loads</h2><table><tr><td>Total</td><td>${r.loads}</td></tr></table>` : "")}

    ${(r.cost && r.cost.summary) ? `
    <h2>💰 Cost &amp; Profit</h2>
    <table>
      <tr><td>Cost / Acre</td><td>${pdfMoney(r.cost.summary.perAcCost)}</td></tr>
      <tr><td>Revenue / Acre</td><td>${pdfMoney(r.cost.summary.revPerAc)} (${r.cost.inputs.yield||0} bu @ ${pdfMoney(r.cost.inputs.price)})</td></tr>
      <tr><td><b>Profit / Acre</b></td><td><b>${pdfMoney(r.cost.summary.profitPerAc)}</b></td></tr>
      ${r.cost.summary.acres > 0 ? `
      <tr><td>Acres</td><td>${r.cost.summary.acres.toFixed(1)}</td></tr>
      <tr><td>Total Cost</td><td>${pdfMoney(r.cost.summary.totalCost)}</td></tr>
      <tr><td>Total Revenue</td><td>${pdfMoney(r.cost.summary.totalRev)}</td></tr>
      <tr><td><b>Total Profit</b></td><td><b>${pdfMoney(r.cost.summary.totalProfit)}</b></td></tr>` : ""}
      ${r.cost.summary.breakeven != null ? `<tr><td>Break-even Price</td><td>${pdfMoney(r.cost.summary.breakeven)}/bu</td></tr>` : ""}
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
  ].concat(formatHarvestLines(r)).concat(formatLoadLines(r)).concat(formatCostLines(r)).join("\n");
}

// Small money formatter for the PDF template
function pdfMoney(n) {
  if (n == null || isNaN(n)) return "\u2014";
  return (n < 0 ? "-$" : "$") + Math.abs(n).toFixed(2);
}

// Build cost/profit lines for a report
function formatCostLines(r) {
  if (!r.cost || !r.cost.summary) return [];
  const c = r.cost.inputs || {}, s = r.cost.summary;
  const lines = [``, `--- Cost & Profit ---`];
  const dollar = (n) => (n == null || isNaN(n)) ? "\u2014" :
    (n < 0 ? "-$" : "$") + Math.abs(n).toFixed(2);
  if (c.seed)  lines.push(`Seed:      $${(+c.seed).toFixed(2)}/ac`);
  if (c.chem)  lines.push(`Chemical:  $${(+c.chem).toFixed(2)}/ac`);
  if (c.fert)  lines.push(`Fertilizer:$${(+c.fert).toFixed(2)}/ac`);
  if (c.fuel)  lines.push(`Fuel:      $${(+c.fuel).toFixed(2)}/ac`);
  if (c.other) lines.push(`Other:     $${(+c.other).toFixed(2)}/ac`);
  lines.push(`Cost/Acre: ${dollar(s.perAcCost)}`);
  lines.push(`Yield:     ${c.yield || 0} bu/ac @ ${dollar(c.price)}/bu`);
  lines.push(`Rev/Acre:  ${dollar(s.revPerAc)}`);
  lines.push(`Profit/Ac: ${dollar(s.profitPerAc)}`);
  if (s.acres > 0) {
    lines.push(`Acres:     ${s.acres.toFixed(1)}`);
    lines.push(`Total Cost:   ${dollar(s.totalCost)}`);
    lines.push(`Total Rev:    ${dollar(s.totalRev)}`);
    lines.push(`Total Profit: ${dollar(s.totalProfit)}`);
  }
  if (s.breakeven != null) lines.push(`Break-even: ${dollar(s.breakeven)}/bu`);
  return lines;
}

// Build load-counter lines for a report (refills for sprayer / unloads for combine)
function formatLoadLines(r) {
  if (!r.loadLog || !r.loadLog.length) {
    if (r.loads) return [``, `Loads:     ${r.loads}`];
    return [];
  }
  const isUnload = r.equipment && r.equipment.type === "combine";
  const lines = [``, `--- ${isUnload ? "Grain unloads" : "Tank refills"} (${r.loads || r.loadLog.length}) ---`];
  r.loadLog.forEach((x) => {
    const when = (x.minsIn != null ? x.minsIn + " min" : new Date(x.t).toLocaleTimeString());
    const extra = isUnload
      ? (x.bushelsAt != null ? `${x.bushelsAt} bu total` : "")
      : (x.gallonsAt != null ? `${x.gallonsAt} gal total` : "");
    lines.push(`  #${x.n}  [${when}]  ${x.acresAt != null ? x.acresAt + " ac" : ""}${extra ? "  \u2022  " + extra : ""}`);
  });
  return lines;
}

// Build the harvest section lines for a report (empty if not a combine session)
function formatHarvestLines(r) {
  if (!r.harvest) return [];
  const h = r.harvest;
  const lines = [
    ``,
    `--- Harvest record ---`,
    `Expected Yield: ${h.expectedYield ? h.expectedYield + " bu/ac" : "\u2014"}`,
    `Start Moisture: ${h.startMoisture ? h.startMoisture + " %" : "\u2014"}`,
  ];
  const log = h.log || [];
  if (!log.length) {
    lines.push(`Readings:       (none logged)`);
  } else {
    lines.push(`Readings (${log.length}):`);
    log.forEach((x, i) => {
      const parts = [];
      if (x.yield)    parts.push(x.yield + " bu/ac");
      if (x.moisture) parts.push(x.moisture + "% moist");
      if (x.quality)  parts.push(x.quality);
      const when = (x.minsIn != null ? x.minsIn + " min" : new Date(x.t).toLocaleTimeString());
      lines.push(`  ${String(i + 1).padStart(2)}. [${when}] ${parts.join(" \u2022 ") || "\u2014"}`);
    });
  }
  return lines;
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
    "Wind Speed (mph)", "Wind Dir", "Temp (F)", "Sky", "Weather Time",
    "Exp Yield (bu/ac)", "Start Moisture (%)", "Harvest Readings",
    "Last Yield (bu/ac)", "Last Moisture (%)", "Last Quality",
    "Loads", "Load Events",
    "Cost/Acre ($)", "Revenue/Acre ($)", "Profit/Acre ($)",
    "Total Cost ($)", "Total Revenue ($)", "Total Profit ($)", "Break-even ($/bu)",
    "Report ID"
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
      (r.harvest && r.harvest.expectedYield) || "",
      (r.harvest && r.harvest.startMoisture) || "",
      (r.harvest && r.harvest.log) ? r.harvest.log.length : "",
      (r.harvest && r.harvest.log && r.harvest.log.length) ? r.harvest.log[r.harvest.log.length-1].yield : "",
      (r.harvest && r.harvest.log && r.harvest.log.length) ? r.harvest.log[r.harvest.log.length-1].moisture : "",
      (r.harvest && r.harvest.log && r.harvest.log.length) ? r.harvest.log[r.harvest.log.length-1].quality : "",
      r.loads || 0,
      (r.loadLog && r.loadLog.length) ? r.loadLog.map(function(x){ return "#"+x.n+"@"+(x.minsIn!=null?x.minsIn+"min":"")+(x.acresAt!=null?" "+x.acresAt+"ac":""); }).join("; ") : "",
      (r.cost && r.cost.summary) ? r.cost.summary.perAcCost.toFixed(2) : "",
      (r.cost && r.cost.summary) ? r.cost.summary.revPerAc.toFixed(2) : "",
      (r.cost && r.cost.summary) ? r.cost.summary.profitPerAc.toFixed(2) : "",
      (r.cost && r.cost.summary && r.cost.summary.totalCost != null) ? r.cost.summary.totalCost.toFixed(2) : "",
      (r.cost && r.cost.summary && r.cost.summary.totalRev != null) ? r.cost.summary.totalRev.toFixed(2) : "",
      (r.cost && r.cost.summary && r.cost.summary.totalProfit != null) ? r.cost.summary.totalProfit.toFixed(2) : "",
      (r.cost && r.cost.summary && r.cost.summary.breakeven != null) ? r.cost.summary.breakeven.toFixed(2) : "",
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
// ============================================================
// SEASON SUMMARY DASHBOARD — added feature
// Aggregates all saved reports by crop and field, with a year filter.
// ============================================================
function seasonAllReports() {
  return Object.values(JSON.parse(localStorage.getItem(LS_REPS) || "{}"));
}

function seasonYearsAvailable(reps) {
  var years = {};
  reps.forEach(function (r) {
    if (r.date) years[new Date(r.date).getFullYear()] = true;
  });
  return Object.keys(years).map(Number).sort(function (a, b) { return b - a; });
}

function populateSeasonYears() {
  var sel = $("seasonYear");
  if (!sel) return;
  var prev = sel.value;
  var years = seasonYearsAvailable(seasonAllReports());
  sel.innerHTML = '<option value="all">All Years</option>' +
    years.map(function (y) { return '<option value="' + y + '">' + y + '</option>'; }).join("");
  // keep prior selection if still valid
  if (prev && (prev === "all" || years.indexOf(Number(prev)) >= 0)) sel.value = prev;
}

function seasonFiltered() {
  var sel = $("seasonYear");
  var yr = sel ? sel.value : "all";
  var reps = seasonAllReports();
  if (yr && yr !== "all") {
    reps = reps.filter(function (r) { return r.date && String(new Date(r.date).getFullYear()) === String(yr); });
  }
  return reps;
}

// Sum helper that pulls numeric metrics safely
function sNum(v) { return (typeof v === "number" && !isNaN(v)) ? v : 0; }

function aggregateBy(reps, keyFn) {
  var groups = {};
  reps.forEach(function (r) {
    var k = keyFn(r) || "(unspecified)";
    if (!groups[k]) groups[k] = { key: k, reports: 0, acres: 0, bushels: 0, gallons: 0, loads: 0, profit: 0, hasProfit: false };
    var g = groups[k];
    g.reports += 1;
    g.acres   += sNum(r.acres);
    g.bushels += sNum(r.bushels);
    g.gallons += sNum(r.gallons);
    g.loads   += sNum(r.loads);
    if (r.cost && r.cost.summary && r.cost.summary.totalProfit != null) {
      g.profit += sNum(r.cost.summary.totalProfit);
      g.hasProfit = true;
    }
  });
  return Object.values(groups).sort(function (a, b) { return b.acres - a.acres; });
}

function renderSeason() {
  populateSeasonYears();
  var reps = seasonFiltered();

  // ---- Totals ----
  var tot = { reports: reps.length, acres: 0, bushels: 0, gallons: 0, loads: 0, profit: 0, hasProfit: false };
  reps.forEach(function (r) {
    tot.acres += sNum(r.acres); tot.bushels += sNum(r.bushels);
    tot.gallons += sNum(r.gallons); tot.loads += sNum(r.loads);
    if (r.cost && r.cost.summary && r.cost.summary.totalProfit != null) { tot.profit += sNum(r.cost.summary.totalProfit); tot.hasProfit = true; }
  });

  var totalsEl = $("seasonTotals");
  if (totalsEl) {
    if (!reps.length) {
      totalsEl.innerHTML = '<div class="hint">No reports yet for this period. Save some sessions to see your season summary.</div>';
      if ($("seasonCropChart")) $("seasonCropChart").innerHTML = "";
      if ($("seasonCropTable")) $("seasonCropTable").innerHTML = "";
      if ($("seasonFieldTable")) $("seasonFieldTable").innerHTML = "";
      return;
    }
    var stat = function (val, lab) { return '<div class="season-stat"><div class="s-val">' + val + '</div><div class="s-lab">' + lab + '</div></div>'; };
    totalsEl.innerHTML =
      stat(tot.reports, "Reports") +
      stat(tot.acres.toFixed(1), "Acres") +
      stat(Math.round(tot.bushels).toLocaleString(), "Bushels") +
      stat(tot.gallons.toFixed(0), "Gallons") +
      stat(tot.loads, "Loads") +
      (tot.hasProfit ? stat('<span class="' + (tot.profit >= 0 ? "profit-pos" : "profit-neg") + '">' + fmtMoney(tot.profit) + '</span>', "Profit") : "");
  }

  // ---- By Crop: bar chart (acres) + table ----
  var byCrop = aggregateBy(reps, function (r) { return r.field && r.field.crop; });
  var chartEl = $("seasonCropChart");
  if (chartEl) {
    var maxAcres = Math.max.apply(null, byCrop.map(function (g) { return g.acres; }).concat([1]));
    chartEl.innerHTML = byCrop.map(function (g) {
      var pct = Math.round((g.acres / maxAcres) * 100);
      return '<div class="sbar-row"><span>' + escHtml(g.key) + '</span>' +
             '<span class="sbar-track"><span class="sbar-fill" style="width:' + pct + '%"></span></span>' +
             '<span class="num">' + g.acres.toFixed(1) + ' ac</span></div>';
    }).join("");
  }
  if ($("seasonCropTable")) $("seasonCropTable").innerHTML = seasonTable(byCrop, "Crop", tot);
  if ($("seasonFieldTable")) {
    var byField = aggregateBy(reps, function (r) { return r.field && r.field.name; });
    $("seasonFieldTable").innerHTML = seasonTable(byField, "Field", tot);
  }
}

function seasonTable(groups, label, tot) {
  var anyProfit = groups.some(function (g) { return g.hasProfit; });
  var head = '<table class="season-table"><thead><tr>' +
    '<th>' + label + '</th><th class="num">Reports</th><th class="num">Acres</th>' +
    '<th class="num">Bushels</th><th class="num">Gallons</th><th class="num">Loads</th>' +
    (anyProfit ? '<th class="num">Profit</th>' : '') + '</tr></thead><tbody>';
  var body = groups.map(function (g) {
    return '<tr><td>' + escHtml(g.key) + '</td>' +
      '<td class="num">' + g.reports + '</td>' +
      '<td class="num">' + g.acres.toFixed(1) + '</td>' +
      '<td class="num">' + Math.round(g.bushels).toLocaleString() + '</td>' +
      '<td class="num">' + g.gallons.toFixed(0) + '</td>' +
      '<td class="num">' + g.loads + '</td>' +
      (anyProfit ? '<td class="num ' + (g.hasProfit ? (g.profit >= 0 ? "profit-pos" : "profit-neg") : "") + '">' + (g.hasProfit ? fmtMoney(g.profit) : "\u2014") + '</td>' : '') +
      '</tr>';
  }).join("");
  var foot = '<tfoot><tr><td>Total</td>' +
    '<td class="num">' + tot.reports + '</td>' +
    '<td class="num">' + tot.acres.toFixed(1) + '</td>' +
    '<td class="num">' + Math.round(tot.bushels).toLocaleString() + '</td>' +
    '<td class="num">' + tot.gallons.toFixed(0) + '</td>' +
    '<td class="num">' + tot.loads + '</td>' +
    (anyProfit ? '<td class="num ' + (tot.profit >= 0 ? "profit-pos" : "profit-neg") + '">' + (tot.hasProfit ? fmtMoney(tot.profit) : "\u2014") + '</td>' : '') +
    '</tr></tfoot>';
  return head + body + '</tbody>' + foot + '</table>';
}

if ($("seasonYear")) $("seasonYear").addEventListener("change", renderSeason);
if ($("btnSeasonRefresh")) $("btnSeasonRefresh").addEventListener("click", renderSeason);

window.addEventListener("DOMContentLoaded", () => {
  loadEquipmentList();
  loadReportsList();
  loadFieldsList();
  var _vEl = document.getElementById("appVersion");
  if (_vEl && window.APP_VERSION) _vEl.textContent = "v" + window.APP_VERSION;
  applyEquipmentUI();
  renderSectionButtons();
  startLocationFollow();
  showEqSubmenu($("eqType").value);
  updateEqSummary();
  updatePlanterCalcWidth();
  updateDataStats();                    // ← initialize backup card summary
  populateSeasonYears();                // ← seed season year filter
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
