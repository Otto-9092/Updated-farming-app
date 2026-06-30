// ============================================================
// APP VERSION — bump this string whenever you ship an update.
// Also update the ?v= query in index.html so devices fetch fresh files.
// ============================================================
window.APP_VERSION = "2026.06.30 · 05";
// (startup version log removed for production)

/* ============================================================
   OπO Farming (Diamond O Farms LLC) — Data Systems Pro
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
  abLine: { a: null, b: null, poly: null, swaths: [], swathInfo: "", swathsOn: false },
  boundary: { active: false, points: [], poly: null, acres: 0, drivenPoints: [], offsetSide: "center", drivenPoly: null },
  coveragePolys: [],
  field: { name: "", crop: "Corn", variety: "" },
  equipment: { name: "", type: "none", width: 90 },   // ← default: nothing selected (clean home screen)
  sprayer:  { gpa: 15, nozzle: 20, target: 12, tank: 1200, product: "" },
  combine:  { expectedYield: 180, tankCapacity: 350, moisture: 15.0 },
  harvest:  { expectedYield: "", startMoisture: "", log: [] },  // per-session harvest readings
  harvestTimer: null,
  // Tank + load tracking (reset per session)
  tankGallonsAtRefill: 0,   // state.gallons value at the last refill (sprayer)
  loads: 0,                 // sprayer refills OR combine unloads this session
  loadLog: [],              // timestamped load events
  bales: 0,                 // baler: bale count this session
  baleLog: [],              // baler: timestamped bale events
  notes: [],                // field notes (text + optional photo, GPS-tagged)
  _stagedPhoto: null,       // compressed dataURL staged in the Add Note dialog
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
const LS_SEED   = "dof_seed_presets";

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
    if (t.dataset.tab === "tools") { seedMixCalcFromState(); seedCostAcresFromState(); }   // ← refresh calc inputs
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
// SEED CALCULATOR — Tools tab
// Saves per-crop bag size (seeds/bag OR lbs/bag) + cost/bag as presets,
// then computes bags & total cost for the acres + rate you enter.
// ============================================================
function seedMoney(n) {
  if (n == null || isNaN(n)) return "$0.00";
  return (n < 0 ? "-$" : "$") + Math.abs(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// Tracks which preset is currently loaded (so Save can update/rename it)
// and the most recent cost-per-acre result (for "Use in Cost & Profit").
var seedLoadedPreset = null;
var seedLastCostPerAcre = null;

// Switch the size/rate labels + placeholders based on the sizing mode.
function syncSeedMode() {
  var mode = $("seedMode") ? $("seedMode").value : "seeds";
  var sizeLbl = $("seedSizeLbl"), rateLbl = $("seedRateLbl");
  var sizeIn = $("seedSize"), rateIn = $("seedRate");
  if (mode === "lbs") {
    if (sizeLbl) sizeLbl.childNodes[0].nodeValue = "Lbs / Bag ";
    if (sizeIn) sizeIn.placeholder = "e.g. 50";
    if (rateLbl) rateLbl.childNodes[0].nodeValue = "Rate (lbs/ac) ";
    if (rateIn) rateIn.placeholder = "e.g. 90";
  } else {
    if (sizeLbl) sizeLbl.childNodes[0].nodeValue = "Seeds / Bag ";
    if (sizeIn) sizeIn.placeholder = "e.g. 80000";
    if (rateLbl) rateLbl.childNodes[0].nodeValue = "Population (seeds/ac) ";
    if (rateIn) rateIn.placeholder = "e.g. 34000";
  }
}

function loadSeedPresetList() {
  var lib = JSON.parse(localStorage.getItem(LS_SEED) || "{}");
  var sel = $("seedPresetSel");
  if (!sel) return;
  var prev = sel.value;
  sel.innerHTML = '<option value="">— None —</option>';
  Object.keys(lib).sort().forEach(function (k) {
    var o = document.createElement("option");
    o.value = k;
    var p = lib[k];
    var unit = p.mode === "lbs" ? " lb/bag" : " seeds/bag";
    o.textContent = k + " (" + (p.size != null ? Number(p.size).toLocaleString() : "?") + unit + ")";
    sel.appendChild(o);
  });
  if (prev && lib[prev]) sel.value = prev;
}

function applySeedPreset(name) {
  var lib = JSON.parse(localStorage.getItem(LS_SEED) || "{}");
  var p = lib[name];
  if (!p) return;
  if ($("seedName")) $("seedName").value = p.name || name;
  if ($("seedMode")) $("seedMode").value = p.mode || "seeds";
  syncSeedMode();
  if ($("seedSize")) $("seedSize").value = (p.size != null ? p.size : "");
  if ($("seedBagCost")) $("seedBagCost").value = (p.bagCost != null ? p.bagCost : "");
  seedLoadedPreset = name;   // remember what we're editing
}

function saveSeedPreset() {
  var name = ($("seedName") && $("seedName").value || "").trim();
  if (!name) { appAlert("Enter a Crop / Seed Name first, then save."); return; }
  var lib = JSON.parse(localStorage.getItem(LS_SEED) || "{}");

  var record = {
    _modified: new Date().toISOString(),
    name: name,
    mode: $("seedMode") ? $("seedMode").value : "seeds",
    size: parseFloat($("seedSize") && $("seedSize").value) || 0,
    bagCost: parseFloat($("seedBagCost") && $("seedBagCost").value) || 0
  };

  // If we loaded a preset and the name was changed in the field, treat it as a rename.
  if (seedLoadedPreset && seedLoadedPreset !== name) {
    delete lib[seedLoadedPreset];
    if (typeof recordTombstone === "function") recordTombstone(LS_TOMB_SEED, seedLoadedPreset);
  }
  // Warn before clobbering a different existing preset (not the one we're editing).
  var willOverwrite = lib[name] && name !== seedLoadedPreset;

  var commit = function () {
    lib[name] = record;
    localStorage.setItem(LS_SEED, JSON.stringify(lib));
    seedLoadedPreset = name;
    loadSeedPresetList();
    if ($("seedPresetSel")) $("seedPresetSel").value = name;
    appAlert('Saved seed preset "' + name + '".', "🌱 Preset saved");
  };

  if (willOverwrite) {
    appConfirm('A preset named "' + name + '" already exists. Overwrite it?', { title: "Overwrite preset", okLabel: "Overwrite" }).then(function (ok) { if (ok) commit(); });
  } else {
    commit();
  }
}

// Rename the currently-selected preset via the themed dialog.
function renameSeedPreset() {
  var sel = $("seedPresetSel");
  var name = sel ? sel.value : "";
  if (!name) { appAlert("Pick a saved preset to rename."); return; }
  if (typeof showRenameDialog !== "function") {
    // Fallback: rename by editing the name field then Save.
    appAlert("Load the preset, edit the name field, then tap Save / Update.");
    return;
  }
  showRenameDialog(name).then(function (next) {
    if (next == null) return;
    var trimmed = next.trim();
    if (!trimmed) { appAlert("Name cannot be empty."); return; }
    var lib = JSON.parse(localStorage.getItem(LS_SEED) || "{}");
    if (trimmed === name) return;
    if (lib[trimmed]) { appAlert('A preset named "' + trimmed + '" already exists.'); return; }
    var rec = lib[name];
    if (!rec) return;
    rec.name = trimmed;
    rec._modified = new Date().toISOString();
    lib[trimmed] = rec;
    delete lib[name];
    localStorage.setItem(LS_SEED, JSON.stringify(lib));
    if (typeof recordTombstone === "function") recordTombstone(LS_TOMB_SEED, name);  // old name is gone — propagate via sync
    if (seedLoadedPreset === name) { seedLoadedPreset = trimmed; if ($("seedName")) $("seedName").value = trimmed; }
    loadSeedPresetList();
    if ($("seedPresetSel")) $("seedPresetSel").value = trimmed;
    appAlert('Renamed to "' + trimmed + '".', "✏️ Preset renamed");
  });
}

function deleteSeedPreset() {
  var sel = $("seedPresetSel");
  var name = sel ? sel.value : "";
  if (!name) { appAlert("Pick a saved preset to delete."); return; }
  appConfirm('Delete seed preset "' + name + '"?', { title: "Delete preset", okLabel: "Delete", danger: true }).then(function (ok) {
    if (!ok) return;
    var lib = JSON.parse(localStorage.getItem(LS_SEED) || "{}");
    delete lib[name];
    localStorage.setItem(LS_SEED, JSON.stringify(lib));
    if (typeof recordTombstone === "function") recordTombstone(LS_TOMB_SEED, name);  // propagate delete via sync
    if (seedLoadedPreset === name) seedLoadedPreset = null;
    loadSeedPresetList();
  });
}

function calcSeed() {
  var mode = $("seedMode") ? $("seedMode").value : "seeds";
  var size = parseFloat($("seedSize") && $("seedSize").value) || 0;       // seeds or lbs per bag
  var bagCost = parseFloat($("seedBagCost") && $("seedBagCost").value) || 0;
  var acres = parseFloat($("seedAcres") && $("seedAcres").value) || 0;
  var rate = parseFloat($("seedRate") && $("seedRate").value) || 0;       // per-acre
  var out = $("seedResults");
  if (!out) return;

  if (acres <= 0 || rate <= 0 || size <= 0) {
    out.innerHTML = '<div class="hint">Enter bag size, acres, and a per-acre rate to calculate.</div>';
    return;
  }

  var unitWord = mode === "lbs" ? "lbs" : "seeds";
  var totalNeeded = acres * rate;            // total seeds or total lbs
  var bagsExact = totalNeeded / size;        // fractional bags
  var bagsWhole = Math.ceil(bagsExact);      // bags you actually buy
  var costExact = bagsExact * bagCost;       // cost using exact bags
  var costWhole = bagsWhole * bagCost;       // cost rounding up to whole bags
  var costPerAcre = acres > 0 ? costWhole / acres : 0;
  seedLastCostPerAcre = (bagCost > 0) ? costPerAcre : null;   // for "Use in Cost & Profit"

  var rows = [
    ["Total " + unitWord + " needed", Math.round(totalNeeded).toLocaleString() + " " + unitWord],
    ["Bags needed (exact)", bagsExact.toFixed(2)],
    ["<b>Bags to buy (rounded up)</b>", "<b>" + bagsWhole.toLocaleString() + "</b>"]
  ];
  if (bagCost > 0) {
    rows.push(["Total cost (exact bags)", seedMoney(costExact)]);
    rows.push(["<b>Total cost (whole bags)</b>", "<b>" + seedMoney(costWhole) + "</b>"]);
    rows.push(["Cost per acre", seedMoney(costPerAcre)]);
  }

  out.innerHTML = '<table><tbody>' + rows.map(function (r) {
    return '<tr><td>' + r[0] + '</td><td class="num" style="text-align:right">' + r[1] + '</td></tr>';
  }).join("") + '</tbody></table>';
}

function seedPresetsToCSV() {
  var lib = JSON.parse(localStorage.getItem(LS_SEED) || "{}");
  var names = Object.keys(lib).sort();
  var headers = ["Crop / Seed Name", "Bag Sizing", "Size per Bag", "Cost per Bag ($)", "Cost per Unit ($)", "Last Modified"];
  var rows = [headers.map(csvEscape).join(",")];
  names.forEach(function (k) {
    var p = lib[k] || {};
    var mode = p.mode === "lbs" ? "Lbs per bag" : "Seeds per bag";
    var size = (p.size != null ? p.size : "");
    var bagCost = (p.bagCost != null ? p.bagCost : "");
    var perUnit = (p.size && p.bagCost) ? (p.bagCost / p.size) : "";
    // Per-unit: seeds are tiny, so show more precision; lbs to cents.
    if (perUnit !== "") perUnit = p.mode === "lbs" ? perUnit.toFixed(4) : perUnit.toFixed(6);
    rows.push([
      p.name || k, mode, size, bagCost, perUnit,
      p._modified ? new Date(p._modified).toLocaleString() : ""
    ].map(csvEscape).join(","));
  });
  return rows.join("\r\n");
}

function exportSeedPresetsCSV() {
  var lib = JSON.parse(localStorage.getItem(LS_SEED) || "{}");
  if (!Object.keys(lib).length) { appAlert("No seed presets saved yet to export."); return; }
  var ts = new Date().toISOString().slice(0, 10);
  downloadFile("DiamondO_SeedPresets_" + ts + ".csv", "\ufeff" + seedPresetsToCSV(), "text/csv;charset=utf-8");
}

// ---- Generic CSV parser: handles quoted fields, commas, escaped quotes, CRLF/LF ----
function parseCSV(text) {
  if (text == null) return [];
  // Strip a leading UTF-8 BOM if present.
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  var rows = [], row = [], field = "", i = 0, inQuotes = false;
  while (i < text.length) {
    var ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i++; continue;
      }
      field += ch; i++; continue;
    }
    if (ch === '"') { inQuotes = true; i++; continue; }
    if (ch === ',') { row.push(field); field = ""; i++; continue; }
    if (ch === '\r') { i++; continue; }
    if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ""; i++; continue; }
    field += ch; i++;
  }
  // flush last field/row (if any content)
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
  return rows;
}

// Import seed presets from a CSV. Accepts the columns we export, matched by header
// (case-insensitive). Minimum required: a name column. Merges into existing presets.
function importSeedPresetsCSV(text) {
  var rows = parseCSV(text).filter(function (r) {
    return r.length && r.some(function (c) { return String(c).trim() !== ""; });
  });
  if (!rows.length) { appAlert("That CSV looks empty."); return; }

  var header = rows[0].map(function (h) { return String(h).trim().toLowerCase(); });
  function col(names) {
    for (var n = 0; n < names.length; n++) {
      var idx = header.indexOf(names[n]);
      if (idx !== -1) return idx;
    }
    return -1;
  }
  var iName = col(["crop / seed name", "crop/seed name", "name", "crop", "seed"]);
  var iMode = col(["bag sizing", "sizing", "mode"]);
  var iSize = col(["size per bag", "size", "seeds per bag", "lbs per bag", "seeds/bag", "lbs/bag"]);
  var iCost = col(["cost per bag ($)", "cost per bag", "bag cost", "cost/bag", "cost"]);

  if (iName === -1) {
    appAlert('Could not find a name column. The CSV needs a header row with at least "Crop / Seed Name".', "Import failed");
    return;
  }

  var lib = JSON.parse(localStorage.getItem(LS_SEED) || "{}");
  var added = 0, updated = 0, skipped = 0;
  for (var r = 1; r < rows.length; r++) {
    var cells = rows[r];
    var name = (cells[iName] != null ? String(cells[iName]).trim() : "");
    if (!name) { skipped++; continue; }

    // Mode: detect "lb" anywhere → lbs, else seeds.
    var modeRaw = (iMode !== -1 && cells[iMode] != null) ? String(cells[iMode]).toLowerCase() : "";
    var mode = modeRaw.indexOf("lb") !== -1 ? "lbs" : "seeds";

    var size = (iSize !== -1) ? parseFloat(String(cells[iSize]).replace(/[^0-9.\-]/g, "")) : NaN;
    var bagCost = (iCost !== -1) ? parseFloat(String(cells[iCost]).replace(/[^0-9.\-]/g, "")) : NaN;

    var existed = !!lib[name];
    lib[name] = {
      _modified: new Date().toISOString(),
      name: name,
      mode: mode,
      size: isNaN(size) ? 0 : size,
      bagCost: isNaN(bagCost) ? 0 : bagCost
    };
    if (existed) updated++; else added++;
  }

  localStorage.setItem(LS_SEED, JSON.stringify(lib));
  if (typeof loadSeedPresetList === "function") loadSeedPresetList();
  if (typeof updateDataStats === "function") updateDataStats();
  appAlert("✅ Import complete.\n\n" + added + " added\n" + updated + " updated" +
    (skipped ? "\n" + skipped + " row(s) skipped (no name)" : ""), "🌱 Presets imported");
}

// ---- Bulk import FIELDS from a CSV (merges by name; preserves existing boundary/cost) ----
function importFieldsCSV(text) {
  var rows = parseCSV(text).filter(function (r) { return r.length && r.some(function (c) { return String(c).trim() !== ""; }); });
  if (!rows.length) { appAlert("That CSV looks empty."); return; }
  var header = rows[0].map(function (h) { return String(h).trim().toLowerCase(); });
  function col(names) { for (var n = 0; n < names.length; n++) { var idx = header.indexOf(names[n]); if (idx !== -1) return idx; } return -1; }
  var iName = col(["name", "field name", "field", "crop / seed name"]);
  var iCrop = col(["crop"]);
  var iVar  = col(["variety", "hybrid"]);
  var iAcres = col(["acres", "boundary acres", "area"]);
  if (iName === -1) { appAlert('The CSV needs a header row with at least a "Name" column.', "Import failed"); return; }

  var lib = JSON.parse(localStorage.getItem(LS_FIELDS) || "{}");
  var added = 0, updated = 0, skipped = 0;
  for (var r = 1; r < rows.length; r++) {
    var cells = rows[r];
    var name = (cells[iName] != null ? String(cells[iName]).trim() : "");
    if (!name) { skipped++; continue; }
    var existing = lib[name] || {};
    var existed = !!lib[name];
    var acres = (iAcres !== -1) ? parseFloat(String(cells[iAcres]).replace(/[^0-9.\-]/g, "")) : NaN;
    // Preserve any existing boundary; only set acres if provided.
    var boundary = existing.boundary || { points: [], acres: 0 };
    if (!isNaN(acres)) boundary = { points: (existing.boundary && existing.boundary.points) || [], acres: acres };
    lib[name] = {
      _modified: new Date().toISOString(),
      savedAt: new Date().toISOString(),
      name: name,
      crop: (iCrop !== -1 && cells[iCrop] != null) ? String(cells[iCrop]).trim() : (existing.crop || ""),
      variety: (iVar !== -1 && cells[iVar] != null) ? String(cells[iVar]).trim() : (existing.variety || ""),
      boundary: boundary,
      cost: existing.cost || {}
    };
    if (existed) updated++; else added++;
  }
  localStorage.setItem(LS_FIELDS, JSON.stringify(lib));
  if (typeof loadFieldsList === "function") loadFieldsList();
  if (typeof updateDataStats === "function") updateDataStats();
  appAlert("✅ Fields import complete.\n\n" + added + " added\n" + updated + " updated" +
    (skipped ? "\n" + skipped + " row(s) skipped (no name)" : ""), "🌾 Fields imported");
}

// ---- Bulk import EQUIPMENT from a CSV (merges by name; preserves existing params) ----
function importEquipmentCSV(text) {
  var rows = parseCSV(text).filter(function (r) { return r.length && r.some(function (c) { return String(c).trim() !== ""; }); });
  if (!rows.length) { appAlert("That CSV looks empty."); return; }
  var header = rows[0].map(function (h) { return String(h).trim().toLowerCase(); });
  function col(names) { for (var n = 0; n < names.length; n++) { var idx = header.indexOf(names[n]); if (idx !== -1) return idx; } return -1; }
  var iName = col(["name", "machine", "equipment", "equipment name"]);
  var iType = col(["type", "machine type", "category"]);
  var iWidth = col(["width (ft)", "width", "implement width"]);
  if (iName === -1) { appAlert('The CSV needs a header row with at least a "Name" column.', "Import failed"); return; }

  // Map free-text type to a known EQ_TYPES key (else "other").
  var validTypes = (typeof EQ_TYPES !== "undefined") ? Object.keys(EQ_TYPES) : [];
  function normType(raw) {
    var t = String(raw || "").trim().toLowerCase();
    if (!t) return "other";
    for (var i = 0; i < validTypes.length; i++) { if (t.indexOf(validTypes[i]) !== -1) return validTypes[i]; }
    return "other";
  }

  var lib = JSON.parse(localStorage.getItem(LS_EQ) || "{}");
  var added = 0, updated = 0, skipped = 0;
  for (var r = 1; r < rows.length; r++) {
    var cells = rows[r];
    var name = (cells[iName] != null ? String(cells[iName]).trim() : "");
    if (!name) { skipped++; continue; }
    var existing = lib[name] || {};
    var existed = !!lib[name];
    var width = (iWidth !== -1) ? parseFloat(String(cells[iWidth]).replace(/[^0-9.\-]/g, "")) : NaN;
    lib[name] = {
      _modified: new Date().toISOString(),
      name: name,
      type: (iType !== -1) ? normType(cells[iType]) : (existing.type || "other"),
      width: isNaN(width) ? (existing.width != null ? existing.width : 0) : width,
      params: existing.params || {}
    };
    if (existed) updated++; else added++;
  }
  localStorage.setItem(LS_EQ, JSON.stringify(lib));
  if (typeof loadEquipmentList === "function") loadEquipmentList();
  if (typeof updateDataStats === "function") updateDataStats();
  appAlert("✅ Equipment import complete.\n\n" + added + " added\n" + updated + " updated" +
    (skipped ? "\n" + skipped + " row(s) skipped (no name)" : ""), "🚜 Equipment imported");
}

// ---- Combined multi-section CSV of every library (fields, equipment, reports, seed presets) ----
function buildAllDataCSV() {
  var blocks = [];

  // Section 1: Fields
  var fields = JSON.parse(localStorage.getItem(LS_FIELDS) || "{}");
  var fHead = ["Name", "Crop", "Variety", "Acres", "Boundary Acres", "Last Modified"];
  var fRows = ["# FIELDS", fHead.map(csvEscape).join(",")];
  Object.keys(fields).sort().forEach(function (k) {
    var f = fields[k] || {};
    fRows.push([f.name || k, f.crop || "", f.variety || "",
      (f.acres != null ? f.acres : ""), (f.boundaryAcres != null ? f.boundaryAcres : ""),
      f._modified ? new Date(f._modified).toLocaleString() : ""].map(csvEscape).join(","));
  });
  blocks.push(fRows.join("\r\n"));

  // Section 2: Equipment
  var eq = JSON.parse(localStorage.getItem(LS_EQ) || "{}");
  var eHead = ["Name", "Type", "Width (ft)", "Last Modified"];
  var eRows = ["# EQUIPMENT", eHead.map(csvEscape).join(",")];
  Object.keys(eq).sort().forEach(function (k) {
    var e = eq[k] || {};
    eRows.push([e.name || k, e.type || "", (e.width != null ? e.width : ""),
      e._modified ? new Date(e._modified).toLocaleString() : ""].map(csvEscape).join(","));
  });
  blocks.push(eRows.join("\r\n"));

  // Section 3: Reports (reuse the rich reports CSV — but ALL reports, not the filtered view)
  var reps = JSON.parse(localStorage.getItem(LS_REPS) || "{}");
  var rList = Object.values(reps).sort(function (a, b) { return (b.date || "").localeCompare(a.date || ""); });
  var rHead = ["Date", "Name", "Field", "Crop", "Machine", "Type", "Acres", "Bushels", "Gallons", "Loads", "Bales", "Total Profit ($)", "Report ID"];
  var rRows = ["# REPORTS", rHead.map(csvEscape).join(",")];
  rList.forEach(function (r) {
    var f = r.field || {}, e = r.equipment || {};
    var profit = (r.cost && r.cost.summary && r.cost.summary.totalProfit != null) ? r.cost.summary.totalProfit.toFixed(2) : "";
    rRows.push([
      r.date ? new Date(r.date).toLocaleString() : "", r.name || "",
      f.name || "", f.crop || "", e.name || "", e.type || "",
      (r.acres != null ? r.acres : ""), (r.bushels != null ? r.bushels : ""),
      (r.gallons != null ? r.gallons : ""), (r.loads != null ? r.loads : ""),
      (r.bales != null ? r.bales : ""), profit, r.id || ""
    ].map(csvEscape).join(","));
  });
  blocks.push(rRows.join("\r\n"));

  // Section 4: Seed presets
  blocks.push("# SEED PRESETS\r\n" + seedPresetsToCSV());

  // Join sections with a blank line between each.
  return blocks.join("\r\n\r\n");
}

function exportAllDataCSV() {
  var csv = buildAllDataCSV();
  var ts = new Date().toISOString().slice(0, 10);
  downloadFile("DiamondO_AllData_" + ts + ".csv", "\ufeff" + csv, "text/csv;charset=utf-8");
}

function resetSeed() {
  ["seedName", "seedSize", "seedBagCost", "seedAcres", "seedRate"].forEach(function (id) {
    if ($(id)) $(id).value = "";
  });
  if ($("seedPresetSel")) $("seedPresetSel").value = "";
  if ($("seedResults")) $("seedResults").innerHTML = "";
  seedLoadedPreset = null;
  seedLastCostPerAcre = null;
}

// Push the computed seed cost-per-acre into the Cost & Profit "Seed ($/ac)" field.
function useSeedInCost() {
  if (seedLastCostPerAcre == null) {
    calcSeed();   // try to compute on the fly
  }
  if (seedLastCostPerAcre == null || isNaN(seedLastCostPerAcre)) {
    appAlert("Calculate a seed cost first (you need a bag cost, acres, and rate).");
    return;
  }
  var costEl = $("costSeed");
  if (!costEl) { appAlert("The Cost & Profit Seed field was not found."); return; }
  var val = (Math.round(seedLastCostPerAcre * 100) / 100);
  costEl.value = val;
  var seedAcres = parseFloat($("seedAcres") && $("seedAcres").value) || 0;
  if (seedAcres > 0 && $("costAcres") && !($("costAcres").value)) $("costAcres").value = seedAcres;
  if (typeof calcCost === "function") { try { calcCost(); } catch (e) {} }
  var card = $("costProfitCard");
  if (card && card.scrollIntoView) card.scrollIntoView({ behavior: "smooth", block: "start" });
  appAlert("Set Seed ($/ac) to " + seedMoney(val) + " in Cost & Profit.", "➡️ Sent to Cost & Profit");
}

// Wire up seed calculator
if ($("seedMode")) $("seedMode").addEventListener("change", syncSeedMode);
if ($("seedPresetSel")) $("seedPresetSel").addEventListener("change", function () {
  if (this.value) applySeedPreset(this.value);
});
if ($("btnSeedLoad")) $("btnSeedLoad").addEventListener("click", function () {
  var sel = $("seedPresetSel");
  if (sel && sel.value) applySeedPreset(sel.value);
  else appAlert("Pick a saved preset to load.");
});
if ($("btnSeedRename")) $("btnSeedRename").addEventListener("click", renameSeedPreset);
if ($("btnSeedUseCost")) $("btnSeedUseCost").addEventListener("click", useSeedInCost);
if ($("btnSeedDelete")) $("btnSeedDelete").addEventListener("click", deleteSeedPreset);
if ($("btnSeedSavePreset")) $("btnSeedSavePreset").addEventListener("click", saveSeedPreset);
if ($("btnSeedExportCSV")) $("btnSeedExportCSV").addEventListener("click", exportSeedPresetsCSV);
if ($("btnSeedImportCSV")) $("btnSeedImportCSV").addEventListener("click", function () {
  var inp = $("seedImportInput");
  if (inp) inp.click();
});
if ($("seedImportInput")) $("seedImportInput").addEventListener("change", function (e) {
  var file = e.target.files && e.target.files[0];
  if (!file) return;
  var reader = new FileReader();
  reader.onload = function (ev) {
    try { importSeedPresetsCSV(String(ev.target.result || "")); }
    catch (err) { appAlert("Could not read that CSV: " + err.message, "Import failed"); }
  };
  reader.onerror = function () { appAlert("Could not read the file.", "Import failed"); };
  reader.readAsText(file);
  e.target.value = "";   // allow re-importing the same file
});
if ($("btnSeedCalc")) $("btnSeedCalc").addEventListener("click", calcSeed);
if ($("btnSeedReset")) $("btnSeedReset").addEventListener("click", resetSeed);
syncSeedMode();
loadSeedPresetList();

// ============================================================
// PHOTO STORE (IndexedDB) — Stage 2
// Photos are large; localStorage caps ~5MB. We keep notes/reports in
// localStorage but store photo dataURLs in IndexedDB keyed by photoId.
// ============================================================
const IDB_NAME = "opio_photos_db";
const IDB_STORE = "photos";
let _idbPromise = null;

function idbOpen() {
  if (_idbPromise) return _idbPromise;
  _idbPromise = new Promise(function (resolve, reject) {
    if (!("indexedDB" in window)) { reject(new Error("IndexedDB unavailable")); return; }
    var req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = function () {
      var db = req.result;
      if (!db.objectStoreNames.contains(IDB_STORE)) db.createObjectStore(IDB_STORE);
    };
    req.onsuccess = function () { resolve(req.result); };
    req.onerror = function () { reject(req.error); };
  });
  return _idbPromise;
}

function idbTx(mode) {
  return idbOpen().then(function (db) {
    return db.transaction(IDB_STORE, mode).objectStore(IDB_STORE);
  });
}

// Generate a unique photo id
function newPhotoId() {
  return "ph_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8);
}

// Store a dataURL; resolves with the id used.
function photoPut(id, dataUrl) {
  return idbTx("readwrite").then(function (store) {
    return new Promise(function (resolve, reject) {
      var r = store.put(dataUrl, id);
      r.onsuccess = function () { resolve(id); };
      r.onerror = function () { reject(r.error); };
    });
  });
}

// Retrieve a dataURL (or null).
function photoGet(id) {
  if (!id) return Promise.resolve(null);
  return idbTx("readonly").then(function (store) {
    return new Promise(function (resolve, reject) {
      var r = store.get(id);
      r.onsuccess = function () { resolve(r.result || null); };
      r.onerror = function () { reject(r.error); };
    });
  }).catch(function () { return null; });
}

// Delete a photo by id.
function photoDelete(id) {
  if (!id) return Promise.resolve();
  return idbTx("readwrite").then(function (store) {
    return new Promise(function (resolve) {
      var r = store.delete(id);
      r.onsuccess = function () { resolve(); };
      r.onerror = function () { resolve(); };
    });
  }).catch(function () {});
}

// Export ALL photos as a { id: dataUrl } map (for backups).
function photoExportAll() {
  return idbTx("readonly").then(function (store) {
    return new Promise(function (resolve) {
      var out = {};
      var req = store.openCursor();
      req.onsuccess = function () {
        var cur = req.result;
        if (cur) { out[cur.key] = cur.value; cur.continue(); }
        else resolve(out);
      };
      req.onerror = function () { resolve(out); };
    });
  }).catch(function () { return {}; });
}

// Import a { id: dataUrl } map (merge into the store).
function photoImportAll(map) {
  if (!map || typeof map !== "object") return Promise.resolve();
  var ids = Object.keys(map);
  if (!ids.length) return Promise.resolve();
  return idbTx("readwrite").then(function (store) {
    return new Promise(function (resolve) {
      var i = 0;
      function next() {
        if (i >= ids.length) { resolve(); return; }
        var id = ids[i++];
        var r = store.put(map[id], id);
        r.onsuccess = next; r.onerror = next;
      }
      next();
    });
  }).catch(function () {});
}

// ============================================================
// FIELD NOTES (text + optional photo, GPS-tagged) — added feature
// ============================================================
// Compress/resize an image File into a small JPEG dataURL for localStorage.
function compressImage(file, maxDim, quality) {
  maxDim = maxDim || 800; quality = quality || 0.6;
  return new Promise(function (resolve, reject) {
    var reader = new FileReader();
    reader.onload = function (e) {
      var img = new Image();
      img.onload = function () {
        var w = img.width, h = img.height;
        if (w > h && w > maxDim) { h = Math.round(h * maxDim / w); w = maxDim; }
        else if (h >= w && h > maxDim) { w = Math.round(w * maxDim / h); h = maxDim; }
        var canvas = document.createElement("canvas");
        canvas.width = w; canvas.height = h;
        canvas.getContext("2d").drawImage(img, 0, 0, w, h);
        try { resolve(canvas.toDataURL("image/jpeg", quality)); }
        catch (err) { reject(err); }
      };
      img.onerror = reject;
      img.src = e.target.result;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// Format a GPS coordinate for display
function fmtGps(loc) {
  if (!loc || loc.lat == null) return "no GPS fix";
  return loc.lat.toFixed(5) + ", " + loc.lng.toFixed(5);
}

// Open the Add Note dialog
function openNoteDialog() {
  state._stagedPhoto = null;
  if ($("noteText")) $("noteText").value = "";
  if ($("notePhoto")) $("notePhoto").value = "";
  if ($("notePreview")) $("notePreview").innerHTML = "";
  var hint = $("noteGpsHint");
  if (hint) {
    hint.textContent = state.lastPos
      ? "\uD83D\uDCCD Will tag: " + fmtGps(state.lastPos)
      : "\u26A0\uFE0F No GPS fix yet \u2014 note will save without a location.";
  }
  openDlg("noteDlg", "noteText");
}

// Photo chosen → compress + preview
if ($("notePhoto")) $("notePhoto").addEventListener("change", function (e) {
  var file = e.target.files && e.target.files[0];
  if (!file) { state._stagedPhoto = null; if ($("notePreview")) $("notePreview").innerHTML = ""; return; }
  if ($("notePreview")) $("notePreview").innerHTML = '<div class="hint">Processing photo\u2026</div>';
  compressImage(file, 800, 0.6).then(function (dataUrl) {
    state._stagedPhoto = dataUrl;
    if ($("notePreview")) $("notePreview").innerHTML = '<img src="' + dataUrl + '" alt="preview" />';
  }).catch(function () {
    state._stagedPhoto = null;
    if ($("notePreview")) $("notePreview").innerHTML = '<div class="hint">Could not process that image.</div>';
  });
});

// Save the staged note (photo goes to IndexedDB; note keeps a photoId)
function saveNote() {
  var text = ($("noteText") && $("noteText").value || "").trim();
  if (!text && !state._stagedPhoto) {
    appAlert("Add some text or a photo first.", "Empty note");
    return;
  }
  var loc = state.lastPos ? { lat: state.lastPos.lat, lng: state.lastPos.lng } : null;
  var note = {
    t: new Date().toISOString(),
    minsIn: state.sessionStart ? Math.round((Date.now() - state.sessionStart) / 60000) : null,
    text: text,
    photoId: null,
    loc: loc
  };

  var staged = state._stagedPhoto;
  state._stagedPhoto = null;
  closeDlg("noteDlg");

  function finish() {
    state.notes = state.notes || [];
    state.notes.push(note);
    renderNotes();
  }

  if (staged) {
    var id = newPhotoId();
    photoPut(id, staged).then(function () {
      note.photoId = id;
      finish();
    }).catch(function () {
      // IndexedDB failed — fall back to inline photo so nothing is lost
      note.photo = staged;
      finish();
    });
  } else {
    finish();
  }
}

// Render the notes list under the card. Thumbnails load async from IndexedDB.
function renderNotes() {
  var list = $("notesList");
  if (!list) return;
  var notes = state.notes || [];
  if (!notes.length) {
    list.innerHTML = '<div class="note-empty">No notes yet this session.</div>';
    return;
  }
  list.innerHTML = notes.map(function (n, i) {
    var when = new Date(n.t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    var hasPhoto = !!(n.photoId || n.photo);
    // Placeholder thumb; filled in async below via data-thumb index.
    var thumb = hasPhoto ? '<img alt="note photo" data-noteimg="' + i + '" data-thumb="' + i + '" />' : "";
    var gps = n.loc ? "\uD83D\uDCCD " + fmtGps(n.loc) : "no GPS";
    return '<div class="note-item">' + thumb +
      '<div class="note-body">' +
        '<div class="note-text">' + escHtml(n.text || "(photo only)") + '</div>' +
        '<div class="note-meta">' + when + " \u2022 " + gps + '</div>' +
      '</div>' +
      '<button class="note-del" data-notedel="' + i + '" title="Delete">\u2715</button>' +
    '</div>';
  }).join("");

  // Fill thumbnails asynchronously
  notes.forEach(function (n, i) {
    if (n.photo) {
      var el = list.querySelector('img[data-thumb="' + i + '"]');
      if (el) el.src = n.photo;
    } else if (n.photoId) {
      photoGet(n.photoId).then(function (dataUrl) {
        var el = list.querySelector('img[data-thumb="' + i + '"]');
        if (el && dataUrl) el.src = dataUrl;
      });
    }
  });
}

// Delegated clicks: delete note / open photo full-size
if ($("notesList")) $("notesList").addEventListener("click", async function (e) {
  var del = e.target.getAttribute && e.target.getAttribute("data-notedel");
  if (del != null) {
    var idx = parseInt(del, 10);
    if (await appConfirm("Delete this note?", { title: "Delete note", okLabel: "Delete", danger: true })) {
      var removed = state.notes.splice(idx, 1)[0];
      if (removed && removed.photoId) photoDelete(removed.photoId);
      renderNotes();
    }
    return;
  }
  var img = e.target.getAttribute && e.target.getAttribute("data-noteimg");
  if (img != null) {
    var n = state.notes[parseInt(img, 10)];
    if (n && n.photo) {
      var w = window.open();
      if (w) w.document.write('<img src="' + n.photo + '" style="max-width:100%" />');
    } else if (n && n.photoId) {
      photoGet(n.photoId).then(function (dataUrl) {
        if (!dataUrl) return;
        var w = window.open();
        if (w) w.document.write('<img src="' + dataUrl + '" style="max-width:100%" />');
      });
    }
  }
});

if ($("btnAddNote")) $("btnAddNote").addEventListener("click", openNoteDialog);
if ($("noteSave"))   $("noteSave").addEventListener("click", saveNote);
if ($("noteCancel")) $("noteCancel").addEventListener("click", function () { state._stagedPhoto = null; closeDlg("noteDlg"); });

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
  state.bales = 0;
  state.baleLog = [];
  state.notes = [];            // ← reset field notes for the new session
  renderNotes();
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

  // Bushels is the combine/harvest metric — shown for non-sprayers,
  // but hidden when no equipment is selected (clean home screen).
  const isNone = state.equipment.type === "none";
  $("mBuBox").classList.toggle("hidden",   isSprayer || isNone);

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
  var isBaler = state.equipment.type === "baler";

  // Loads tile — sprayer (refills) or combine (unloads)
  var loadsBox = $("mLoadsBox");
  if (loadsBox) loadsBox.classList.toggle("hidden", !(isSprayer || isCombine));

  // Bales tile — baler only
  var balesBox = $("mBalesBox");
  if (balesBox) balesBox.classList.toggle("hidden", !isBaler);

  // Tank & Loads / Bales card + its buttons
  var tlCard = $("tankLoadsCard");
  if (tlCard) tlCard.classList.toggle("hidden", !(isSprayer || isCombine || isBaler));
  var refillBtn = $("btnRefill"), unloadBtn = $("btnUnload"), baleBtn = $("btnBale");
  if (refillBtn) refillBtn.classList.toggle("hidden", !isSprayer);
  if (unloadBtn) unloadBtn.classList.toggle("hidden", !isCombine);
  if (baleBtn)   baleBtn.classList.toggle("hidden", !isBaler);
  var tlTitle = $("tankLoadsTitle");
  if (tlTitle) tlTitle.textContent = isCombine ? "Grain Loads" : (isBaler ? "Bale Count" : "Tank & Loads");

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

  const balesEl = $("mBales");
  if (balesEl) balesEl.textContent = state.bales || 0;

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

// Baler: count one bale (independent of combine grain loads)
function doBale() {
  if (state.equipment.type !== "baler") return;
  state.bales = (state.bales || 0) + 1;
  state.baleLog = state.baleLog || [];
  state.baleLog.push({
    t: new Date().toISOString(),
    minsIn: state.sessionStart ? Math.round((Date.now() - state.sessionStart) / 60000) : 0,
    type: "bale",
    n: state.bales,
    acresAt: +state.acres.toFixed(2)
  });
  updateTankAndLoads();
  appAlert("Bale #" + state.bales + " counted.", "\uD83C\uDF3E Bale logged");
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
  // Remember the raw driven path, then offset by the chosen side before saving.
  state.boundary.drivenPoints = state.boundary.points.slice();
  var sideSel = $("boundOffsetSide");
  state.boundary.offsetSide = sideSel ? sideSel.value : "center";
  state.boundary.points = offsetBoundaryByWidth(state.boundary.drivenPoints, state.boundary.offsetSide);
  drawBoundaryFinal();
  drawDrivenPreview();             // show the driven path alongside the offset boundary
  refreshSwathsIfOn();             // boundary ready -> tile swaths if they were on
  setMode(state.running ? "RUNNING" : "IDLE");
});
var _boundOffsetSelEl = $("boundOffsetSide");
if (_boundOffsetSelEl) _boundOffsetSelEl.addEventListener("change", function () {
  state.boundary.offsetSide = _boundOffsetSelEl.value;
  previewBoundaryOffset();   // live preview when side changes
  refreshSwathsIfOn();       // boundary moved -> re-tile swaths
});

// Live: changing the Working Width re-tiles swaths (and re-previews offset).
var _eqWidthEl = $("eqWidth");
if (_eqWidthEl) _eqWidthEl.addEventListener("input", function () {
  state.equipment.width = Math.max(1, parseFloat(_eqWidthEl.value) || 90);
  refreshSwathsIfOn();
  previewBoundaryOffset();
});
$("btnBoundClear").addEventListener("click", () => {
  state.boundary.points = [];
  state.boundary.drivenPoints = [];
  if (state.boundary.poly) { state.boundary.poly.setMap(null); state.boundary.poly = null; }
  clearDrivenPreview();
  clearSwaths();
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
// BOUNDARY OFFSET PREVIEW — show the raw driven path (dashed grey)
// alongside the offset boundary so the chosen side can be confirmed.
// ============================================================
function clearDrivenPreview() {
  if (state.boundary.drivenPoly) { state.boundary.drivenPoly.setMap(null); state.boundary.drivenPoly = null; }
}

function drawDrivenPreview() {
  clearDrivenPreview();
  var dp = state.boundary.drivenPoints;
  if (!dp || dp.length < 2) return;
  // Dashed grey outline of exactly where the machine was driven.
  state.boundary.drivenPoly = new google.maps.Polygon({
    paths: dp,
    strokeColor: "#9aa0a6", strokeWeight: 2, strokeOpacity: 0.9,
    fillOpacity: 0, clickable: false, zIndex: 3,
    map: state.map,
  });
}

// Recompute + redraw the offset boundary from the driven path using the
// currently-selected side & working width, and refresh the acres readout.
function previewBoundaryOffset() {
  var dp = state.boundary.drivenPoints;
  if (!dp || dp.length < 3) return;   // nothing recorded yet
  var sideSel = document.getElementById("boundOffsetSide");
  var side = sideSel ? sideSel.value : "center";
  state.boundary.offsetSide = side;
  state.boundary.points = offsetBoundaryByWidth(dp, side);
  drawBoundaryFinal();      // redraw filled offset polygon + acres
  drawDrivenPreview();      // overlay the driven path so both are visible
  var info = document.getElementById("swathInfo");   // reuse line for a hint
  // (acres already updated in drawBoundaryFinal)
}

// ============================================================
// A-B GUIDANCE
// ============================================================
$("btnSetA").addEventListener("click", () => {
  if (!state.lastPos) { appAlert("Need GPS fix first."); return; }
  state.abLine.a = { lat: state.lastPos.lat, lng: state.lastPos.lng };
  renderAB();
  refreshSwathsIfOn();
});
$("btnSetB").addEventListener("click", () => {
  if (!state.lastPos) { appAlert("Need GPS fix first."); return; }
  state.abLine.b = { lat: state.lastPos.lat, lng: state.lastPos.lng };
  renderAB();
  refreshSwathsIfOn();
});
$("btnClearAB").addEventListener("click", () => {
  state.abLine.a = state.abLine.b = null;
  if (state.abLine.poly) { state.abLine.poly.setMap(null); state.abLine.poly = null; }
  clearSwaths();
});
$("btnShowSwaths").addEventListener("click", () => { showSwaths(); });
$("btnHideSwaths").addEventListener("click", () => { clearSwaths(); persistSwathsOn(false); });

// Persist the swaths on/off preference so it survives reloads.
var LS_SWATHS_ON = "dof_swaths_on";
function persistSwathsOn(on) {
  state.abLine.swathsOn = !!on;
  try { if (on) localStorage.setItem(LS_SWATHS_ON, "1"); else localStorage.removeItem(LS_SWATHS_ON); } catch (e) {}
}
function swathsWereOn() { try { return localStorage.getItem(LS_SWATHS_ON) === "1"; } catch (e) { return false; } }
// Re-draw swaths whenever the inputs change (A/B, width, boundary) IF they're on.
// Restore the persisted "swaths on" preference at startup.
(function () {
  function go() { if (typeof swathsWereOn === "function" && swathsWereOn()) state.abLine.swathsOn = true; }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", go);
  else go();
})();
function refreshSwathsIfOn() {
  if (!state.abLine.swathsOn) return;
  if (!state.abLine.a || !state.abLine.b) return;
  if (!state.boundary.points || state.boundary.points.length < 3) return;
  showSwaths(true);   // silent re-render
}
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
// A-B SWATH GUIDANCE — fill the boundary with parallel passes
// spaced to the machine working width, clipped to the boundary.
// ============================================================
function clearSwaths() {
  if (state.abLine.swaths && state.abLine.swaths.length) {
    state.abLine.swaths.forEach(function (p) { p.setMap(null); });
  }
  state.abLine.swaths = [];
  var info = document.getElementById("swathInfo");
  if (info) info.textContent = "";
}

// Signed perpendicular distance (m) of P from the A->B line. +ve = right of travel.
function signedPerpDist(P, a, theta) {
  var d = haversine(a.lat, a.lng, P.lat, P.lng);
  if (d === 0) return 0;
  var b = bearingDeg(a.lat, a.lng, P.lat, P.lng);
  return d * Math.sin((b - theta) * Math.PI / 180);
}

function showSwaths(silent) {
  clearSwaths();
  var a = state.abLine.a, b = state.abLine.b;
  if (!a || !b) { if (!silent) appAlert("Set point A and point B first to define your line.", "Need A-B line"); return; }
  var pts = state.boundary.points;
  if (!pts || pts.length < 3) { if (!silent) appAlert("Record a field boundary first so swaths can fill it.", "Need boundary"); return; }
  state.abLine.swathsOn = true;
  if (typeof persistSwathsOn === "function") persistSwathsOn(true);

  var widthM = Math.max(1, (state.equipment.width || 90)) * 0.3048; // ft -> m
  var theta = bearingDeg(a.lat, a.lng, b.lat, b.lng);
  var perpR = (theta + 90) % 360;   // to the right of travel

  // Boundary polygon for containment + extent of needed offsets.
  var poly = new google.maps.Polygon({ paths: pts });
  var dists = pts.map(function (p) { return signedPerpDist(p, a, theta); });
  var dmin = Math.min.apply(null, dists), dmax = Math.max.apply(null, dists);
  var kmin = Math.floor(dmin / widthM), kmax = Math.ceil(dmax / widthM);

  // Diagonal length of field -> how far to extend each swath line before clipping.
  var span = 0;
  for (var i = 0; i < pts.length; i++) {
    for (var j = i + 1; j < pts.length; j++) {
      var dd = haversine(pts[i].lat, pts[i].lng, pts[j].lat, pts[j].lng);
      if (dd > span) span = dd;
    }
  }
  var reach = span / 2 + widthM * 2;
  var step = Math.max(3, widthM / 4);   // sampling resolution along the line

  var drawn = 0;
  var contains = (google.maps.geometry && google.maps.geometry.poly)
    ? function (latlng) { return google.maps.geometry.poly.containsLocation(latlng, poly); }
    : function () { return true; };

  for (var k = kmin; k <= kmax; k++) {
    // Center point of this swath: A offset perpendicular by k*width.
    var cp = offsetMeters(a.lat, a.lng, perpR, k * widthM);
    // Walk the line, collecting in-boundary segments.
    var seg = [];
    for (var d = -reach; d <= reach; d += step) {
      var p = offsetMeters(cp.lat, cp.lng, theta, d);
      var ll = new google.maps.LatLng(p.lat, p.lng);
      if (contains(ll)) {
        seg.push({ lat: p.lat, lng: p.lng });
      } else if (seg.length >= 2) {
        drawSwathSeg(seg); drawn++; seg = [];
      } else { seg = []; }
    }
    if (seg.length >= 2) { drawSwathSeg(seg); drawn++; }
  }

  var info = document.getElementById("swathInfo");
  if (info) {
    info.textContent = drawn
      ? (drawn + " passes \u00b7 " + (state.equipment.width || 90) + " ft spacing")
      : "No passes fell inside the boundary \u2014 check your A-B line direction.";
  }
}

function drawSwathSeg(seg) {
  var line = new google.maps.Polyline({
    path: seg, strokeColor: "#00e5ff", strokeWeight: 1.5,
    strokeOpacity: 0.85, map: state.map, zIndex: 5,
  });
  state.abLine.swaths.push(line);
}

// ============================================================
// BOUNDARY OFFSET — shift the driven path perpendicular by half
// the working width so the SAVED boundary marks the worked edge.
//   "center" -> no shift (drive line = machine center)
//   "left"   -> driven line is the machine's LEFT edge,  field is to the right
//   "right"  -> driven line is the machine's RIGHT edge, field is to the left
// ============================================================
function offsetBoundaryByWidth(points, side) {
  if (!points || points.length < 3) return points ? points.slice() : [];
  if (side === "center" || !side) return points.slice();
  var halfW = Math.max(1, (state.equipment.width || 90)) * 0.3048 / 2; // m

  // Determine polygon winding so "interior" is consistent.
  var ringClockwise = isClockwise(points);
  // For each vertex, offset along the inward normal of the path by halfW.
  var n = points.length, out = [];
  for (var i = 0; i < n; i++) {
    var prev = points[(i - 1 + n) % n], cur = points[i], next = points[(i + 1) % n];
    // Heading of travel through this vertex (avg of in/out segment bearings).
    var bIn = bearingDeg(prev.lat, prev.lng, cur.lat, cur.lng);
    var bOut = bearingDeg(cur.lat, cur.lng, next.lat, next.lng);
    var heading = averageAngle(bIn, bOut);
    // Right of travel = heading+90. Left = heading-90.
    var dir = (side === "left") ? (heading + 90) : (heading - 90);
    var moved = offsetMeters(cur.lat, cur.lng, dir, halfW);
    out.push({ lat: moved.lat, lng: moved.lng });
  }
  return out;
}

function isClockwise(pts) {
  var sum = 0;
  for (var i = 0; i < pts.length; i++) {
    var a = pts[i], b = pts[(i + 1) % pts.length];
    sum += (b.lng - a.lng) * (b.lat + a.lat);
  }
  return sum > 0;
}

function averageAngle(a, b) {
  var ar = a * Math.PI / 180, br = b * Math.PI / 180;
  var x = Math.cos(ar) + Math.cos(br), y = Math.sin(ar) + Math.sin(br);
  if (x === 0 && y === 0) return a;
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
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
  swather: {
    label: "Swather",
    emoji: "🌿",
    subId: "subSwather",
    fields: ["swWidth", "swCrop", "swConditioner"],
  },
  baler: {
    label: "Baler",
    emoji: "🟡",
    subId: "subBaler",
    fields: ["blType", "blCrop", "blWeight", "blWidth"],
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
  // Convenience: seed the main "Working Width" from a swather/baler width
  // when it hasn't been set yet, so acreage tracking works out of the box.
  if (type === "swather" || type === "baler") {
    var wEl = $("eqWidth");
    var subW = parseFloat(type === "swather" ? values.swWidth : values.blWidth) || 0;
    if (wEl && subW > 0 && (!parseFloat(wEl.value) || parseFloat(wEl.value) <= 0)) {
      wEl.value = subW;
      state.equipment.width = Math.max(1, subW);
    }
  }
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
  } else if (type === "swather") {
    state.swather = state.swather || {};
    state.swather.width       = parseFloat(values.swWidth) || 0;
    state.swather.crop        = values.swCrop || "";
    state.swather.conditioner = values.swConditioner || "none";
  } else if (type === "baler") {
    state.baler = state.baler || {};
    state.baler.baleType = values.blType || "round";
    state.baler.crop     = values.blCrop || "";
    state.baler.weight   = parseFloat(values.blWeight) || 0;
    state.baler.width    = parseFloat(values.blWidth)  || 0;
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
  if (type === "none" || !cfg) {                       // ← no equipment selected
    if (label) label.textContent = "Equipment";
    if (summary) summary.textContent = "No equipment selected. Pick a type to enable its tools.";
    return;
  }
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
  if (state.equipment.type !== "none") openEqModal();   // ← skip modal for "None"
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
    _modified: new Date().toISOString(),   // ← for sync conflict resolution
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
  recordTombstone(LS_TOMB_EQ, k);   // ← remember the deletion for sync
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
    _modified: new Date().toISOString(),   // ← for sync conflict resolution
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
function _median(arr) {
  var a = arr.slice().sort(function (x, y) { return x - y; });
  var m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}
// Clean a set of boundary points: strip invalid/0,0, auto-correct a fully
// swapped lat/lng dataset, then drop outliers that sit absurdly far from the
// median (a single corrupt vertex that would otherwise blow up the zoom).
function cleanBoundaryPoints(points) {
  if (!points || !points.length) return [];
  var valid = points.filter(function (p) {
    return p && isFinite(p.lat) && isFinite(p.lng) &&
           p.lat >= -90 && p.lat <= 90 && p.lng >= -180 && p.lng <= 180 &&
           !(p.lat === 0 && p.lng === 0);
  });
  if (valid.length < 3) return valid;

  // Detect a fully swapped dataset: latitudes should be within +/-90.
  // If many "lat" values exceed 90 in magnitude but the "lng" values are all
  // valid latitudes, the columns are swapped — flip them.
  var badLat = valid.filter(function (p) { return Math.abs(p.lat) > 90; }).length;
  if (badLat > 0) {
    var swapped = valid.map(function (p) { return { lat: p.lng, lng: p.lat }; })
      .filter(function (p) {
        return isFinite(p.lat) && isFinite(p.lng) &&
               p.lat >= -90 && p.lat <= 90 && p.lng >= -180 && p.lng <= 180;
      });
    if (swapped.length >= valid.length - badLat) valid = swapped;
  }

  // Drop outliers: keep points within ~0.25 deg (~27 km) of the median center.
  var mLat = _median(valid.map(function (p) { return p.lat; }));
  var mLng = _median(valid.map(function (p) { return p.lng; }));
  var kept = valid.filter(function (p) {
    return Math.abs(p.lat - mLat) <= 0.25 && Math.abs(p.lng - mLng) <= 0.25;
  });
  return kept.length >= 3 ? kept : valid;
}
function fitMapToBoundary(points) {
  if (!state.map || !points || !points.length) return;
  var valid = cleanBoundaryPoints(points);
  // [fitMapToBoundary] debug logging removed for production
  if (valid.length < 3) { if (valid.length) { state.map.setCenter(valid[0]); state.map.setZoom(16); } return; }
  var lats = valid.map(function (p) { return p.lat; });
  var lngs = valid.map(function (p) { return p.lng; });
  var cLat = lats.reduce(function (a, b) { return a + b; }, 0) / lats.length;
  var cLng = lngs.reduce(function (a, b) { return a + b; }, 0) / lngs.length;
  var dLat = Math.max.apply(null, lats) - Math.min.apply(null, lats);
  var dLng = Math.max.apply(null, lngs) - Math.min.apply(null, lngs);
  // After cleaning, a span still > ~0.5 deg means genuinely huge/odd data:
  // just center at a sane field zoom rather than zooming out to the planet.
  if (dLat > 0.5 || dLng > 0.5 || dLat === 0 || dLng === 0) {
    state.map.setCenter({ lat: cLat, lng: cLng });
    state.map.setZoom(16);
    return;
  }
  var bounds = new google.maps.LatLngBounds();
  valid.forEach(function (p) { bounds.extend(p); });
  state.map.fitBounds(bounds);
  // Safety clamp: never allow fitBounds to leave us zoomed way out.
  google.maps.event.addListenerOnce(state.map, "idle", function () {
    if (state.map.getZoom() < 13) state.map.setZoom(16);
  });
}
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
    fitMapToBoundary(state.boundary.points);
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
  recordTombstone(LS_TOMB_FIELDS, k);   // ← remember the deletion for sync
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
if ($("btnBale"))   $("btnBale").addEventListener("click", doBale);

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
    <name>OπO Farming — ${state.field.name || "Trail"}</name>
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
<gpx version="1.1" creator="OπO Farming" xmlns="http://www.topografix.com/GPX/1/1">
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
// SHAPEFILE EXPORT — write valid ESRI .shp/.shx/.dbf/.prj and zip
// them (STORED method). Validated byte-for-byte against pyshp.
// ============================================================
function _shpRingArea(pts) {
  var s = 0;
  for (var i = 0; i < pts.length; i++) {
    var a = pts[i], b = pts[(i + 1) % pts.length];
    s += (b.lng - a.lng) * (b.lat + a.lat);
  }
  return s;
}
function _shpClockwise(pts) {
  return _shpRingArea(pts) > 0 ? pts.slice() : pts.slice().reverse();
}
function _shpBuildShpShx(polys) {
  var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  polys.forEach(function (poly) {
    poly.forEach(function (p) {
      if (p.lng < minX) minX = p.lng; if (p.lng > maxX) maxX = p.lng;
      if (p.lat < minY) minY = p.lat; if (p.lat > maxY) maxY = p.lat;
    });
  });
  var recs = [];
  polys.forEach(function (poly) {
    var ring = _shpClockwise(poly); ring = ring.concat([ring[0]]);
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
    dv.setInt32(o, 1, true); o += 4; dv.setInt32(o, n, true); o += 4; dv.setInt32(o, 0, true); o += 4;
    ring.forEach(function (p) { dv.setFloat64(o, p.lng, true); o += 8; dv.setFloat64(o, p.lat, true); o += 8; });
    recs.push(new Uint8Array(buf));
  });
  var shpWords = 50; recs.forEach(function (c) { shpWords += 4 + c.length / 2; });
  var shxWords = 50 + recs.length * 4;
  function header(dv, lenWords) {
    dv.setInt32(0, 9994, false); dv.setInt32(24, lenWords, false);
    dv.setInt32(28, 1000, true); dv.setInt32(32, 5, true);
    dv.setFloat64(36, minX, true); dv.setFloat64(44, minY, true);
    dv.setFloat64(52, maxX, true); dv.setFloat64(60, maxY, true);
  }
  var shp = new Uint8Array(shpWords * 2), shpDv = new DataView(shp.buffer); header(shpDv, shpWords);
  var shx = new Uint8Array(shxWords * 2), shxDv = new DataView(shx.buffer); header(shxDv, shxWords);
  var pos = 100, off = 50, sp = 100;
  recs.forEach(function (c, i) {
    var cw = c.length / 2;
    shpDv.setInt32(pos, i + 1, false); pos += 4; shpDv.setInt32(pos, cw, false); pos += 4;
    shp.set(c, pos); pos += c.length;
    shxDv.setInt32(sp, off, false); sp += 4; shxDv.setInt32(sp, cw, false); sp += 4;
    off += 4 + cw;
  });
  return { shp: shp, shx: shx };
}
function _shpBuildDbf(names) {
  var nrec = names.length, headerLen = 65, recLen = 51;
  var u = new Uint8Array(headerLen + nrec * recLen + 1), dv = new DataView(u.buffer);
  u[0] = 3; u[1] = 125; u[2] = 1; u[3] = 1;
  dv.setInt32(4, nrec, true); dv.setInt16(8, headerLen, true); dv.setInt16(10, recLen, true);
  var nm = "NAME"; for (var i = 0; i < nm.length; i++) u[32 + i] = nm.charCodeAt(i);
  u[32 + 11] = 67; u[32 + 16] = 50; u[64] = 0x0D;
  var p = headerLen;
  names.forEach(function (name) {
    u[p++] = 0x20;
    var s = String(name).replace(/[^\x00-\x7F]/g, "?").slice(0, 50);
    for (var j = 0; j < 50; j++) u[p + j] = j < s.length ? s.charCodeAt(j) : 0x20;
    p += 50;
  });
  u[p] = 0x1A;
  return u;
}
var _SHP_PRJ = 'GEOGCS["GCS_WGS_1984",DATUM["D_WGS_1984",SPHEROID["WGS_1984",6378137,298.257223563]],PRIMEM["Greenwich",0],UNIT["Degree",0.0174532925199433],AUTHORITY["EPSG",4326]]';
var _SHP_CPG = "UTF-8";
var _SHP_CRC = (function () {
  var t = [];
  for (var n = 0; n < 256; n++) { var c = n; for (var k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1); t[n] = c >>> 0; }
  return t;
})();
function _shpCrc32(bytes) {
  var c = 0xFFFFFFFF;
  for (var i = 0; i < bytes.length; i++) c = _SHP_CRC[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}
function _shpZip(files) {
  function sb(s) { var a = new Uint8Array(s.length); for (var i = 0; i < s.length; i++) a[i] = s.charCodeAt(i); return a; }
  var parts = [], central = [], offset = 0;
  files.forEach(function (f) {
    var nameB = sb(f.name), crc = _shpCrc32(f.data);
    var local = new Uint8Array(30 + nameB.length), dv = new DataView(local.buffer);
    dv.setUint32(0, 0x04034b50, true); dv.setUint16(4, 10, true);
    dv.setUint32(14, crc, true); dv.setUint32(18, f.data.length, true); dv.setUint32(22, f.data.length, true);
    dv.setUint16(26, nameB.length, true); local.set(nameB, 30);
    parts.push(local, f.data);
    var cen = new Uint8Array(46 + nameB.length), cdv = new DataView(cen.buffer);
    cdv.setUint32(0, 0x02014b50, true); cdv.setUint16(4, 10, true); cdv.setUint16(6, 10, true);
    cdv.setUint32(16, crc, true); cdv.setUint32(20, f.data.length, true); cdv.setUint32(24, f.data.length, true);
    cdv.setUint16(28, nameB.length, true); cdv.setUint32(42, offset, true); cen.set(nameB, 46);
    central.push(cen); offset += local.length + f.data.length;
  });
  var cs = central.reduce(function (a, c) { return a + c.length; }, 0);
  var end = new Uint8Array(22), edv = new DataView(end.buffer);
  edv.setUint32(0, 0x06054b50, true); edv.setUint16(8, files.length, true); edv.setUint16(10, files.length, true);
  edv.setUint32(12, cs, true); edv.setUint32(16, offset, true);
  var out = new Uint8Array(offset + cs + 22), pp = 0;
  parts.forEach(function (a) { out.set(a, pp); pp += a.length; });
  central.forEach(function (a) { out.set(a, pp); pp += a.length; });
  out.set(end, pp);
  return out;
}
function exportBoundariesShapefile() {
  var lib = JSON.parse(localStorage.getItem(LS_FIELDS) || "{}");
  var fields = [];
  var diag = [];   // per-field diagnostics so we can see WHY a field is missing/misplaced
  Object.keys(lib).forEach(function (k) {
    var f = lib[k];
    var nm = (f && f.name) || k;
    var pts = (f && f.boundary && f.boundary.points) || [];
    var raw = pts.length;
    var valid = (typeof cleanBoundaryPoints === "function")
      ? cleanBoundaryPoints(pts)
      : pts.filter(function (p) {
          return p && isFinite(p.lat) && isFinite(p.lng) &&
                 p.lat >= -90 && p.lat <= 90 && p.lng >= -180 && p.lng <= 180 &&
                 !(p.lat === 0 && p.lng === 0);
        });
    if (valid.length >= 3) {
      var cLat = valid.reduce(function (a, p) { return a + p.lat; }, 0) / valid.length;
      var cLng = valid.reduce(function (a, p) { return a + p.lng; }, 0) / valid.length;
      diag.push(nm + ": " + valid.length + "/" + raw + " pts, center " +
                cLat.toFixed(4) + ", " + cLng.toFixed(4));
      fields.push({ name: nm, points: valid });
    } else {
      diag.push(nm + ": SKIPPED (" + valid.length + " valid of " + raw + " pts" +
                (raw && !valid.length ? " — coords out of range, possible lat/lng swap" : "") + ")");
    }
  });
  // [ShapefileExport] debug logging removed for production
  if (!fields.length) {
    appAlert("No exportable boundaries.\n\n" + diag.join("\n"), "Nothing to export");
    return;
  }
  var ss = _shpBuildShpShx(fields.map(function (f) { return f.points; }));
  var dbf = _shpBuildDbf(fields.map(function (f) { return f.name; }));
  var prj = new Uint8Array(_SHP_PRJ.length);
  for (var i = 0; i < _SHP_PRJ.length; i++) prj[i] = _SHP_PRJ.charCodeAt(i);
  var base = "field_boundaries";
  var cpg = new Uint8Array(_SHP_CPG.length);
  for (var ci = 0; ci < _SHP_CPG.length; ci++) cpg[ci] = _SHP_CPG.charCodeAt(ci);
  var zip = _shpZip([
    { name: base + ".shp", data: ss.shp },
    { name: base + ".shx", data: ss.shx },
    { name: base + ".dbf", data: dbf },
    { name: base + ".prj", data: prj },
    { name: base + ".cpg", data: cpg },
  ]);
  var stamp = new Date().toISOString().slice(0, 10);
  downloadFile("field_boundaries_" + stamp + ".zip", zip, "application/zip");
  var hint = document.getElementById("shpExportHint");
  if (hint) {
    hint.textContent = "Exported " + fields.length + " field boundary(ies). " +
      "First field center: " +
      (fields[0].points.reduce(function (a, p) { return a + p.lat; }, 0) / fields[0].points.length).toFixed(4) +
      ", " +
      (fields[0].points.reduce(function (a, p) { return a + p.lng; }, 0) / fields[0].points.length).toFixed(4) +
      ". If ArcGIS shows nothing, use 'Zoom to layer' — check this matches your farm location.";
  }
}
if (document.getElementById("btnExportShp")) {
  document.getElementById("btnExportShp").addEventListener("click", exportBoundariesShapefile);
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
    bales: state.bales || 0,                  // ← NEW: baler bale count
    baleLog: (state.baleLog || []).slice(),   // ← NEW: timestamped bale events
    cost: (function(){                        // ← NEW: cost/profit snapshot
      var ci = readCostInputs();
      if (!ci.acres) ci.acres = +state.acres.toFixed(2) || +state.boundary.acres.toFixed(2) || 0;
      return { inputs: ci, summary: computeCostSummary(ci) };
    })(),
    notes: (state.notes || []).slice(),       // ← NEW: field notes (GPS-tagged)
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
  if (df === "custom") {
    // Custom start/end range (inclusive). Either bound is optional.
    const fromEl = $("repFrom"), toEl = $("repTo");
    const fromV = fromEl && fromEl.value ? new Date(fromEl.value + "T00:00:00").getTime() : null;
    const toV   = toEl && toEl.value ? new Date(toEl.value + "T23:59:59.999").getTime() : null;
    list = list.filter(r => {
      const t = new Date(r.date).getTime();
      if (fromV != null && t < fromV) return false;
      if (toV   != null && t > toV)   return false;
      return true;
    });
  } else if (df !== "all") {
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

  // --- Equipment filter ---
  const eqEl = $("repEquip");
  const eqFilter = eqEl ? eqEl.value : "all";
  if (eqFilter && eqFilter !== "all") {
    list = list.filter(r => r.equipment && r.equipment.type === eqFilter);
  }

  // --- Sort ---
  const sortEl = $("repSort");
  const sort = sortEl ? sortEl.value : "date_desc";
  const profitOf = r => (r.cost && r.cost.summary && r.cost.summary.totalProfit != null) ? r.cost.summary.totalProfit : -Infinity;
  list.sort((a, b) => {
    switch (sort) {
      case "date_asc":     return a.date.localeCompare(b.date);
      case "name_asc":     return (a.name || "").localeCompare(b.name || "");
      case "acres_desc":   return (b.acres || 0) - (a.acres || 0);
      case "bushels_desc": return (b.bushels || 0) - (a.bushels || 0);
      case "gallons_desc": return (b.gallons || 0) - (a.gallons || 0);
      case "bales_desc":   return (b.bales || 0) - (a.bales || 0);
      case "profit_desc":  return profitOf(b) - profitOf(a);
      case "date_desc":
      default:             return b.date.localeCompare(a.date);
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
function syncRepRangeVisibility() {
  const row = $("repRangeRow");
  const df = $("repDateFilter");
  if (row && df) row.classList.toggle("hidden", df.value !== "custom");
}
syncRepRangeVisibility();

["repSearch", "repDateFilter", "repEquip", "repSort", "repFrom", "repTo"].forEach(id => {
  const el = $(id);
  if (!el) return;
  el.addEventListener("input", loadReportsList);
  el.addEventListener("change", loadReportsList);
});
if ($("repDateFilter")) $("repDateFilter").addEventListener("change", syncRepRangeVisibility);

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
  recordTombstone(LS_TOMB_REPS, id);   // ← remember the deletion for sync
  loadReportsList();
  $("repBody").textContent = "Select a report…";
  if (typeof updateDataStats === "function") updateDataStats();   // ← NEW LINE
});

// Print to PDF — popup-safe (works on phone + computer) with photos.
$("btnPdfRep").addEventListener("click", async () => {
  const all = JSON.parse(localStorage.getItem(LS_REPS) || "{}");
  const r = all[$("repSelect").value];
  if (!r) { appAlert("Select a report first."); return; }

  // Open the tab SYNCHRONOUSLY inside the click (so it isn't popup-blocked).
  // We fill it after photos resolve. If the browser still blocks it, win = null
  // and we fall back to same-tab navigation via a Blob URL.
  let win = null;
  try { win = window.open("", "_blank"); } catch (e) { win = null; }
  if (win) {
    try {
      win.document.write('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><body style="font-family:Arial;padding:24px;color:#111">Building report\u2026</body>');
      win.document.close();
    } catch (e) {}
  }

  // Resolve any IndexedDB-stored note photos to dataURLs before building HTML
  if (r.notes && r.notes.length) {
    await Promise.all(r.notes.map(function (n) {
      if (n.photo) { n._photoData = n.photo; return Promise.resolve(); }
      if (n.photoId) return photoGet(n.photoId).then(function (d) { n._photoData = d || null; });
      n._photoData = null; return Promise.resolve();
    }));
  }
  const html = `
    <html><head><meta charset="utf-8" /><title>${r.name || r.id}</title>
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
      <button class="btn-back"  onclick="if(window.opener){window.close();}else{history.back();}">← Back to App</button>
      <button class="btn-print" onclick="window.print()">🖨️ Print / Save PDF</button>
    </div>

    <h1>🚜 OπO Farming — ${r.name || "Field Report"}</h1>
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

    ${(r.baleLog && r.baleLog.length) ? `
    <h2>🌾 Bales (${r.bales || r.baleLog.length})</h2>
    <table>
      <tr><th>#</th><th>Time</th><th>Acres</th></tr>
      ${r.baleLog.map((x) => `<tr>
        <td>${x.n}</td>
        <td>${x.minsIn != null ? x.minsIn + " min" : new Date(x.t).toLocaleTimeString()}</td>
        <td>${x.acresAt != null ? x.acresAt : "—"}</td>
      </tr>`).join("")}
    </table>` : (r.bales ? `<h2>🌾 Bales</h2><table><tr><td>Total</td><td>${r.bales}</td></tr></table>` : "")}

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

    ${(r.notes && r.notes.length) ? `
    <h2>📝 Field Notes (${r.notes.length})</h2>
    ${r.notes.map((n, i) => `
      <div style="margin-bottom:14px; padding-bottom:10px; border-bottom:1px solid #ccc;">
        <div style="font-size:12px; color:#666;">
          #${i + 1} &bull; ${n.minsIn != null ? n.minsIn + " min" : new Date(n.t).toLocaleTimeString()}
          ${n.loc ? "&bull; 📍 " + n.loc.lat.toFixed(5) + ", " + n.loc.lng.toFixed(5) : "&bull; no GPS"}
        </div>
        ${n.text ? `<div style="margin:4px 0;">${escHtml(n.text)}</div>` : ""}
        ${(n._photoData || n.photo) ? `<img src="${n._photoData || n.photo}" style="max-width:320px; max-height:240px; border-radius:6px; margin-top:4px;" />` : ""}
      </div>`).join("")}
    ` : ""}

    </body></html>`;

  // Deliver via a Blob URL — reliable for large HTML + embedded photos,
  // and works on iOS/standalone PWAs where document.write of big content fails.
  let url = null;
  try {
    url = URL.createObjectURL(new Blob([html], { type: "text/html;charset=utf-8" }));
  } catch (e) { url = null; }

  if (win && url) {
    // Point the already-opened tab at the report.
    try { win.location.href = url; }
    catch (e) {
      // Last resort: write directly into the opened tab.
      try { win.document.open(); win.document.write(html); win.document.close(); } catch (e2) {}
    }
    setTimeout(() => { try { URL.revokeObjectURL(url); } catch (e) {} }, 60000);
  } else if (url) {
    // Popup was blocked — navigate the current tab (a Back button is built in).
    window.location.href = url;
    setTimeout(() => { try { URL.revokeObjectURL(url); } catch (e) {} }, 60000);
  } else if (win) {
    // Blob unsupported but we have a window — fall back to document.write.
    try { win.document.open(); win.document.write(html); win.document.close(); } catch (e) {}
  } else {
    appAlert("Could not open the report view. Please allow pop-ups for this site and try again.", "PDF");
  }
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
  ].concat(formatHarvestLines(r)).concat(formatLoadLines(r)).concat(formatCostLines(r)).concat(formatNoteLines(r)).join("\n");
}

// Build field-note lines for a report (text + GPS; photos shown only in PDF)
function formatNoteLines(r) {
  if (!r.notes || !r.notes.length) return [];
  var lines = ["", "--- Field Notes (" + r.notes.length + ") ---"];
  r.notes.forEach(function (n, i) {
    var when = n.minsIn != null ? (n.minsIn + " min") : new Date(n.t).toLocaleTimeString();
    var gps = n.loc ? (n.loc.lat.toFixed(5) + ", " + n.loc.lng.toFixed(5)) : "no GPS";
    var photo = (n.photo || n.photoId) ? " [photo]" : "";
    lines.push("  #" + (i + 1) + "  [" + when + "]  \uD83D\uDCCD " + gps + photo);
    if (n.text) lines.push("     " + n.text);
  });
  return lines;
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
  // Export the CURRENT filtered + sorted view (search / date / equipment / sort).
  var list = (typeof getFilteredReports === "function")
    ? getFilteredReports()
    : Object.values(JSON.parse(localStorage.getItem(LS_REPS) || "{}"));

  var headers = [
    "Date", "Name", "Field", "Crop", "Variety",
    "Machine", "Type", "Width (ft)",
    "Acres", "Boundary Acres", "Coverage %",
    "Avg Speed (mph)", "Max Speed (mph)", "Bushels", "Gallons",
    "Wind Speed (mph)", "Wind Dir", "Temp (F)", "Sky", "Weather Time",
    "Exp Yield (bu/ac)", "Start Moisture (%)", "Harvest Readings",
    "Last Yield (bu/ac)", "Last Moisture (%)", "Last Quality",
    "Loads", "Bales", "Load Events",
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
      r.bales || 0,
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
    var list = getFilteredReports();
    if (!list.length) { appAlert("No reports match the current filters to export."); return; }
    var csv = reportsToCSV();
    var ts = new Date().toISOString().slice(0, 10);
    downloadFile("DiamondO_Reports_view_" + ts + ".csv", "\ufeff" + csv, "text/csv;charset=utf-8");
  });
}

// ============================================================
// REPORTS — export the current filtered/sorted LIST as one PDF
// (mirrors the Season export: opens a printable page in a new tab)
// ============================================================
function reportsListToHTML(list) {
  var eqLabelOf = function (t) {
    var cfg = (typeof EQ_TYPES !== "undefined" && t) ? EQ_TYPES[t] : null;
    return cfg ? (cfg.emoji + " " + cfg.label) : (t || "\u2014");
  };
  var anyProfit = list.some(function (r) { return r.cost && r.cost.summary && r.cost.summary.totalProfit != null; });

  // Filter description
  var srch = ($("repSearch") && $("repSearch").value || "").trim();
  var dfMap = { all: "All dates", today: "Today", "7d": "Last 7 days", "30d": "Last 30 days", year: "This year", custom: "Custom range" };
  var dfVal = $("repDateFilter") ? $("repDateFilter").value : "all";
  var df = dfMap[dfVal] || dfVal;
  if (dfVal === "custom") {
    var rf = $("repFrom") && $("repFrom").value, rt = $("repTo") && $("repTo").value;
    df = "Custom range (" + (rf || "any") + " \u2192 " + (rt || "any") + ")";
  }
  var eq = $("repEquip") ? $("repEquip").value : "all";
  var eqDesc = (eq === "all") ? "All equipment" : eqLabelOf(eq);
  var sortMap = { date_desc: "Newest first", date_asc: "Oldest first", name_asc: "Name A\u2013Z",
                  acres_desc: "Most acres", bushels_desc: "Most bushels", gallons_desc: "Most gallons",
                  bales_desc: "Most bales", profit_desc: "Most profit" };
  var sort = $("repSort") ? (sortMap[$("repSort").value] || $("repSort").value) : "Newest first";

  // Totals across the filtered list
  var tot = { acres: 0, bushels: 0, gallons: 0, loads: 0, bales: 0, profit: 0, hasProfit: false };
  list.forEach(function (r) {
    tot.acres += sNum(r.acres); tot.bushels += sNum(r.bushels); tot.gallons += sNum(r.gallons);
    tot.loads += sNum(r.loads); tot.bales += sNum(r.bales);
    if (r.cost && r.cost.summary && r.cost.summary.totalProfit != null) { tot.profit += sNum(r.cost.summary.totalProfit); tot.hasProfit = true; }
  });

  var rows = list.map(function (r) {
    var f = r.field || {}, e = r.equipment || {};
    var profit = (r.cost && r.cost.summary && r.cost.summary.totalProfit != null) ? r.cost.summary.totalProfit : null;
    return "<tr>" +
      "<td>" + escHtml(r.date ? new Date(r.date).toLocaleDateString() : "") + "</td>" +
      "<td>" + escHtml(r.name || "") + "</td>" +
      "<td>" + escHtml(f.name || "") + "</td>" +
      "<td>" + escHtml(f.crop || "") + "</td>" +
      "<td>" + escHtml(eqLabelOf(e.type)) + "</td>" +
      '<td class="n">' + sNum(r.acres).toFixed(1) + "</td>" +
      '<td class="n">' + Math.round(sNum(r.bushels)).toLocaleString() + "</td>" +
      '<td class="n">' + sNum(r.gallons).toFixed(0) + "</td>" +
      '<td class="n">' + sNum(r.loads) + "</td>" +
      '<td class="n">' + sNum(r.bales) + "</td>" +
      (anyProfit ? '<td class="n">' + (profit != null ? fmtMoney(profit) : "\u2014") + "</td>" : "") +
      "</tr>";
  }).join("");

  return '<!doctype html><html><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>Reports</title><style>' +
    'body{font-family:Arial,Helvetica,sans-serif;color:#111;padding:24px;}' +
    'h1{margin:0 0 4px;font-size:22px;}' +
    '.meta{color:#555;font-size:13px;margin-bottom:6px;}.meta b{color:#111;}' +
    'table{border-collapse:collapse;width:100%;font-size:13px;margin-top:10px;}' +
    'th,td{border:1px solid #ccc;padding:6px 8px;text-align:left;}' +
    'th{background:#f3efe0;}td.n,th.n{text-align:right;}' +
    'tr.tot td{font-weight:bold;background:#faf7ec;}' +
    '.action-bar{margin-bottom:16px;display:flex;gap:10px;}' +
    '.action-bar button{padding:10px 14px;border:none;border-radius:6px;font-size:14px;font-weight:600;cursor:pointer;}' +
    '.btn-back{background:#444;color:#fff;}.btn-print{background:#ffb703;color:#1a1a1a;}' +
    '@media print{.action-bar{display:none!important;}body{padding:30px;}}' +
    '</style></head><body>' +
    '<div class="action-bar">' +
    '<button class="btn-back" onclick="if(window.opener){window.close();}else{history.back();}">\u2190 Back to App</button>' +
    '<button class="btn-print" onclick="window.print()">\uD83D\uDDA8\uFE0F Print / Save PDF</button>' +
    '</div>' +
    '<h1>\uD83D\uDCC4 Reports</h1>' +
    '<div class="meta"><b>Search:</b> ' + escHtml(srch || "(none)") +
    ' &nbsp; <b>Dates:</b> ' + escHtml(df) +
    ' &nbsp; <b>Equipment:</b> ' + escHtml(eqDesc) +
    ' &nbsp; <b>Sorted by:</b> ' + escHtml(sort) + '</div>' +
    '<div class="meta">Generated ' + escHtml(new Date().toLocaleString()) +
    ' \u00B7 ' + list.length + ' report' + (list.length !== 1 ? "s" : "") + '</div>' +
    '<table><thead><tr><th>Date</th><th>Name</th><th>Field</th><th>Crop</th><th>Equipment</th>' +
    '<th class="n">Acres</th><th class="n">Bushels</th><th class="n">Gallons</th>' +
    '<th class="n">Loads</th><th class="n">Bales</th>' +
    (anyProfit ? '<th class="n">Profit</th>' : "") + '</tr></thead><tbody>' +
    rows +
    '<tr class="tot"><td>TOTAL</td><td></td><td></td><td></td><td></td>' +
    '<td class="n">' + tot.acres.toFixed(1) + "</td>" +
    '<td class="n">' + Math.round(tot.bushels).toLocaleString() + "</td>" +
    '<td class="n">' + tot.gallons.toFixed(0) + "</td>" +
    '<td class="n">' + tot.loads + "</td>" +
    '<td class="n">' + tot.bales + "</td>" +
    (anyProfit ? '<td class="n">' + (tot.hasProfit ? fmtMoney(tot.profit) : "\u2014") + "</td>" : "") +
    '</tr></tbody></table></body></html>';
}

if ($("btnExportReportsPDF")) {
  $("btnExportReportsPDF").addEventListener("click", function () {
    var list = getFilteredReports();
    if (!list.length) { appAlert("No reports match the current filters to export."); return; }
    var html = reportsListToHTML(list);

    var win = null;
    try { win = window.open("", "_blank"); } catch (e) { win = null; }
    var url = null;
    try { url = URL.createObjectURL(new Blob([html], { type: "text/html" })); } catch (e) { url = null; }

    if (win && url) {
      try { win.location.href = url; }
      catch (e) { try { win.document.open(); win.document.write(html); win.document.close(); } catch (e2) {} }
      setTimeout(function () { try { URL.revokeObjectURL(url); } catch (e) {} }, 60000);
    } else if (url) {
      window.location.href = url;
      setTimeout(function () { try { URL.revokeObjectURL(url); } catch (e) {} }, 60000);
    } else if (win) {
      try { win.document.open(); win.document.write(html); win.document.close(); } catch (e) {}
    } else {
      appAlert("Could not open the export view. Please allow pop-ups for this site and try again.", "PDF");
    }
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
const BACKUP_VERSION = 2;   // v2: includes IndexedDB note photos
const LS_BACKUP_ROLLBACK = "dof_last_rollback";
const LS_LAST_SYNCED = "dof_last_synced";   // ISO timestamp of last successful sync
// Tombstones: record deletions so sync can propagate them (newest-action-wins).
const LS_TOMB_FIELDS = "dof_tomb_fields";
const LS_TOMB_EQ     = "dof_tomb_equipment";
const LS_TOMB_REPS   = "dof_tomb_reports";
const LS_TOMB_SEED   = "dof_tomb_seed";
const TOMB_MAX_AGE_DAYS = 90;   // expire old tombstones so they don't pile up

function recordTombstone(lsKey, itemKey) {
  try {
    var t = JSON.parse(localStorage.getItem(lsKey) || "{}");
    t[itemKey] = new Date().toISOString();
    localStorage.setItem(lsKey, JSON.stringify(t));
  } catch (e) {}
}
function pruneTombstones(t) {
  var cutoff = Date.now() - TOMB_MAX_AGE_DAYS * 86400000;
  var out = {};
  Object.keys(t || {}).forEach(function (k) {
    var when = Date.parse(t[k]);
    if (isFinite(when) && when >= cutoff) out[k] = t[k];
  });
  return out;
}

// Summary text for the Backup card
function updateDataStats() {
  const el = $("dataStats");
  if (!el) return;
  const fields = Object.keys(JSON.parse(localStorage.getItem(LS_FIELDS) || "{}")).length;
  const equip  = Object.keys(JSON.parse(localStorage.getItem(LS_EQ)     || "{}")).length;
  const reps   = Object.keys(JSON.parse(localStorage.getItem(LS_REPS)   || "{}")).length;
  const seeds  = Object.keys(JSON.parse(localStorage.getItem(LS_SEED)   || "{}")).length;
  el.innerHTML = `Currently stored on this device:<br>
    <b>${fields}</b> field${fields !== 1 ? "s" : ""} ·
    <b>${equip}</b> machine${equip !== 1 ? "s" : ""} ·
    <b>${reps}</b> report${reps !== 1 ? "s" : ""} ·
    <b>${seeds}</b> seed preset${seeds !== 1 ? "s" : ""}`;
}

// Build the full backup object. includePhotos=true embeds IndexedDB photos
// (async); false returns immediately without them (used for rollback snapshot).
function buildBackup(includePhotos) {
  var base = {
    app: "OπO Farming — Data Systems Pro",
    version: BACKUP_VERSION,
    exportedAt: new Date().toISOString(),
    fields:    JSON.parse(localStorage.getItem(LS_FIELDS) || "{}"),
    equipment: JSON.parse(localStorage.getItem(LS_EQ)     || "{}"),
    reports:   JSON.parse(localStorage.getItem(LS_REPS)   || "{}"),
    seedPresets: JSON.parse(localStorage.getItem(LS_SEED) || "{}"),
  };
  if (!includePhotos) return base;
  return photoExportAll().then(function (photos) {
    base.photos = photos;   // { photoId: dataUrl }
    return base;
  });
}

// ===== Export =====
$("btnExportAll")?.addEventListener("click", async () => {
  const backup = await buildBackup(true);             // include photos
  const photoCount = backup.photos ? Object.keys(backup.photos).length : 0;
  const ts = new Date().toISOString().slice(0, 10);   // YYYY-MM-DD
  const filename = `diamond-o-backup-${ts}.json`;
  const json = JSON.stringify(backup, null, 2);
  downloadFile(filename, json, "application/json");

  const totals = {
    fields:    Object.keys(backup.fields).length,
    equipment: Object.keys(backup.equipment).length,
    reports:   Object.keys(backup.reports).length,
    seedPresets: Object.keys(backup.seedPresets || {}).length,
  };
  appAlert(`✅ Exported successfully!\n\n` +
        `${totals.fields} fields\n` +
        `${totals.equipment} machines\n` +
        `${totals.reports} reports\n` +
        `${totals.seedPresets} seed preset${totals.seedPresets !== 1 ? "s" : ""}\n` +
        `${photoCount} photo${photoCount !== 1 ? "s" : ""}\n\n` +
        `File: ${filename}`, "Backup exported");
});

// ===== Import =====
$("btnImportAll")?.addEventListener("click", () => {
  $("importFileInput").click();   // proxy click to hidden file input
});

$("btnExportAllCSV")?.addEventListener("click", () => {
  exportAllDataCSV();
});

function wireCsvImport(btnId, inputId, importFn) {
  if ($(btnId)) $(btnId).addEventListener("click", function () { var inp = $(inputId); if (inp) inp.click(); });
  if ($(inputId)) $(inputId).addEventListener("change", function (e) {
    var file = e.target.files && e.target.files[0];
    if (!file) return;
    var reader = new FileReader();
    reader.onload = function (ev) {
      try { importFn(String(ev.target.result || "")); }
      catch (err) { appAlert("Could not read that CSV: " + err.message, "Import failed"); }
    };
    reader.onerror = function () { appAlert("Could not read the file.", "Import failed"); };
    reader.readAsText(file);
    e.target.value = "";
  });
}
wireCsvImport("btnImportFieldsCSV", "fieldsImportInput", importFieldsCSV);
wireCsvImport("btnImportEquipCSV", "equipImportInput", importEquipmentCSV);

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
  var VALID_BACKUP_APPS = ["OπO Farming — Data Systems Pro", "Diamond O Farms — Data Systems Pro"];
  if (VALID_BACKUP_APPS.indexOf(data.app) === -1) {
    return appAlert("❌ This file isn't an OπO Farming backup.", "Import failed");
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
    seedPresets: Object.keys(data.seedPresets || {}).length,
  };
  const current = {
    fields:    Object.keys(JSON.parse(localStorage.getItem(LS_FIELDS) || "{}")).length,
    equipment: Object.keys(JSON.parse(localStorage.getItem(LS_EQ)     || "{}")).length,
    reports:   Object.keys(JSON.parse(localStorage.getItem(LS_REPS)   || "{}")).length,
    seedPresets: Object.keys(JSON.parse(localStorage.getItem(LS_SEED) || "{}")).length,
  };

  const summary =
    `📥 Backup file contents:\n` +
    `  • ${incoming.fields} fields\n` +
    `  • ${incoming.equipment} machines\n` +
    `  • ${incoming.reports} reports\n` +
    `  • ${incoming.seedPresets} seed presets\n\n` +
    `Currently on this device:\n` +
    `  • ${current.fields} fields\n` +
    `  • ${current.equipment} machines\n` +
    `  • ${current.reports} reports\n` +
    `  • ${current.seedPresets} seed presets\n\n` +
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
  // 1. Snapshot current state as rollback (no photos — keep it light)
  const rollback = buildBackup(false);
  localStorage.setItem(LS_BACKUP_ROLLBACK, JSON.stringify(rollback));

  // 1b. Restore any photos from the backup into IndexedDB
  if (data.photos) { photoImportAll(data.photos); }

  // 2. Merge or replace each library
  if (mode === "replace") {
    localStorage.setItem(LS_FIELDS, JSON.stringify(data.fields    || {}));
    localStorage.setItem(LS_EQ,     JSON.stringify(data.equipment || {}));
    localStorage.setItem(LS_REPS,   JSON.stringify(data.reports   || {}));
    localStorage.setItem(LS_SEED,   JSON.stringify(data.seedPresets || {}));
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
    mergeLib(LS_SEED,   data.seedPresets);
  }

  // 3. Reload all UI
  loadFieldsList();
  loadEquipmentList();
  loadReportsList();
  if (typeof loadSeedPresetList === "function") loadSeedPresetList();
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
    localStorage.setItem(LS_SEED,   JSON.stringify(data.seedPresets || {}));
    loadFieldsList();
    loadEquipmentList();
    loadReportsList();
    if (typeof loadSeedPresetList === "function") loadSeedPresetList();
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
    years.map(function (y) { return '<option value="' + y + '">' + y + '</option>'; }).join("") +
    '<option value="custom">Custom range\u2026</option>';
  // keep prior selection if still valid
  if (prev && (prev === "all" || prev === "custom" || years.indexOf(Number(prev)) >= 0)) sel.value = prev;
  syncSeasonRangeVisibility();
}

// Show/hide the From/To date inputs when "Custom range" is chosen.
function syncSeasonRangeVisibility() {
  var custom = $("seasonYear") && $("seasonYear").value === "custom";
  var fl = $("seasonFromLabel"), tl = $("seasonToLabel");
  if (fl) fl.classList.toggle("hidden", !custom);
  if (tl) tl.classList.toggle("hidden", !custom);
}

function seasonFiltered() {
  var yr = $("seasonYear") ? $("seasonYear").value : "all";
  var eq = $("seasonEquip") ? $("seasonEquip").value : "all";
  var reps = seasonAllReports();
  if (yr === "custom") {
    var fromEl = $("seasonFrom"), toEl = $("seasonTo");
    var fromV = fromEl && fromEl.value ? new Date(fromEl.value + "T00:00:00").getTime() : null;
    var toV   = toEl && toEl.value ? new Date(toEl.value + "T23:59:59.999").getTime() : null;
    reps = reps.filter(function (r) {
      if (!r.date) return false;
      var t = new Date(r.date).getTime();
      if (fromV != null && t < fromV) return false;
      if (toV   != null && t > toV)   return false;
      return true;
    });
  } else if (yr && yr !== "all") {
    reps = reps.filter(function (r) { return r.date && String(new Date(r.date).getFullYear()) === String(yr); });
  }
  if (eq && eq !== "all") {
    reps = reps.filter(function (r) { return r.equipment && r.equipment.type === eq; });
  }
  return reps;
}

// Sum helper that pulls numeric metrics safely
function sNum(v) { return (typeof v === "number" && !isNaN(v)) ? v : 0; }

// Month names for "Group By: Month"
var SEASON_MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

// Returns the grouping key function for the current "Group By" selection.
function seasonKeyFn(groupBy) {
  if (groupBy === "field") return function (r) { return r.field && r.field.name; };
  if (groupBy === "equipment") return function (r) {
    var t = r.equipment && r.equipment.type;
    var cfg = (typeof EQ_TYPES !== "undefined" && t) ? EQ_TYPES[t] : null;
    return cfg ? (cfg.emoji + " " + cfg.label) : (t || "(none)");
  };
  if (groupBy === "month") return function (r) {
    if (!r.date) return "(no date)";
    var d = new Date(r.date);
    return d.getFullYear() + " " + SEASON_MONTHS[d.getMonth()];
  };
  // default: crop
  return function (r) { return r.field && r.field.crop; };
}

// Sort comparator for the current "Sort By" selection.
function seasonSortFn(sortBy) {
  if (sortBy === "reports") return function (a, b) { return b.reports - a.reports; };
  if (sortBy === "bushels") return function (a, b) { return b.bushels - a.bushels; };
  if (sortBy === "gallons") return function (a, b) { return b.gallons - a.gallons; };
  if (sortBy === "bales")   return function (a, b) { return b.bales - a.bales; };
  if (sortBy === "profit")  return function (a, b) { return b.profit - a.profit; };
  return function (a, b) { return b.acres - a.acres; };  // default: acres
}

function aggregateBy(reps, keyFn, sortFn) {
  var groups = {};
  reps.forEach(function (r) {
    var k = keyFn(r) || "(unspecified)";
    if (!groups[k]) groups[k] = { key: k, reports: 0, acres: 0, bushels: 0, gallons: 0, loads: 0, bales: 0, profit: 0, hasProfit: false };
    var g = groups[k];
    g.reports += 1;
    g.acres   += sNum(r.acres);
    g.bushels += sNum(r.bushels);
    g.gallons += sNum(r.gallons);
    g.loads   += sNum(r.loads);
    g.bales   += sNum(r.bales);
    if (r.cost && r.cost.summary && r.cost.summary.totalProfit != null) {
      g.profit += sNum(r.cost.summary.totalProfit);
      g.hasProfit = true;
    }
  });
  return Object.values(groups).sort(sortFn || function (a, b) { return b.acres - a.acres; });
}

function renderSeason() {
  populateSeasonYears();
  var reps = seasonFiltered();

  var groupBy = $("seasonGroup") ? $("seasonGroup").value : "crop";
  var sortBy  = $("seasonSort")  ? $("seasonSort").value  : "acres";
  var sortFn  = seasonSortFn(sortBy);

  // ---- Totals ----
  var tot = { reports: reps.length, acres: 0, bushels: 0, gallons: 0, loads: 0, bales: 0, profit: 0, hasProfit: false };
  reps.forEach(function (r) {
    tot.acres += sNum(r.acres); tot.bushels += sNum(r.bushels);
    tot.gallons += sNum(r.gallons); tot.loads += sNum(r.loads); tot.bales += sNum(r.bales);
    if (r.cost && r.cost.summary && r.cost.summary.totalProfit != null) { tot.profit += sNum(r.cost.summary.totalProfit); tot.hasProfit = true; }
  });

  var totalsEl = $("seasonTotals");
  if (totalsEl) {
    if (!reps.length) {
      totalsEl.innerHTML = '<div class="hint">No reports match these filters. Try “All Years” / “All Equipment”, or save some sessions first.</div>';
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
      stat(tot.bales, "Bales") +
      (tot.hasProfit ? stat('<span class="' + (tot.profit >= 0 ? "profit-pos" : "profit-neg") + '">' + fmtMoney(tot.profit) + '</span>', "Profit") : "");
  }

  // ---- Primary grouping (chart + table), driven by "Group By" ----
  var groupLabels = { crop: "Crop", field: "Field", equipment: "Equipment", month: "Month" };
  var primaryLabel = groupLabels[groupBy] || "Crop";
  var titleEl = $("seasonGroupTitle");
  if (titleEl) titleEl.textContent = "By " + primaryLabel + "  ·  sorted by " + (sortBy.charAt(0).toUpperCase() + sortBy.slice(1));

  var primary = aggregateBy(reps, seasonKeyFn(groupBy), sortFn);

  // Bar chart shows the metric you're sorting by (falls back to acres).
  var metricOf = function (g) {
    if (sortBy === "reports") return g.reports;
    if (sortBy === "bushels") return g.bushels;
    if (sortBy === "gallons") return g.gallons;
    if (sortBy === "bales")   return g.bales;
    if (sortBy === "profit")  return g.profit;
    return g.acres;
  };
  var metricUnit = { acres: " ac", bushels: " bu", gallons: " gal", bales: "", reports: "", profit: "" }[sortBy] || "";
  var chartEl = $("seasonCropChart");
  if (chartEl) {
    var maxVal = Math.max.apply(null, primary.map(metricOf).concat([1]));
    chartEl.innerHTML = primary.map(function (g) {
      var v = metricOf(g);
      var pct = Math.max(0, Math.round((v / maxVal) * 100));
      var disp = (sortBy === "profit") ? fmtMoney(v) : (sortBy === "acres" || sortBy === "gallons") ? v.toFixed(1) + metricUnit : Math.round(v).toLocaleString() + metricUnit;
      return '<div class="sbar-row"><span>' + escHtml(g.key) + '</span>' +
             '<span class="sbar-track"><span class="sbar-fill" style="width:' + pct + '%"></span></span>' +
             '<span class="num">' + disp + '</span></div>';
    }).join("");
  }
  if ($("seasonCropTable")) $("seasonCropTable").innerHTML = seasonTable(primary, primaryLabel, tot);

  // ---- Secondary table: always show "By Field" unless you're already grouping by field,
  //      in which case show "By Crop" so you still get a second perspective. ----
  if ($("seasonFieldTable")) {
    var secKey = (groupBy === "field") ? "crop" : "field";
    var secLabel = (groupBy === "field") ? "Crop" : "Field";
    var secondary = aggregateBy(reps, seasonKeyFn(secKey), sortFn);
    $("seasonFieldTable").innerHTML = '<div class="card-title" style="margin-top:0">By ' + secLabel + '</div>' + seasonTable(secondary, secLabel, tot);
  }
}

function seasonTable(groups, label, tot) {
  var anyProfit = groups.some(function (g) { return g.hasProfit; });
  var head = '<table class="season-table"><thead><tr>' +
    '<th>' + label + '</th><th class="num">Reports</th><th class="num">Acres</th>' +
    '<th class="num">Bushels</th><th class="num">Gallons</th><th class="num">Loads</th><th class="num">Bales</th>' +
    (anyProfit ? '<th class="num">Profit</th>' : '') + '</tr></thead><tbody>';
  var body = groups.map(function (g) {
    return '<tr><td>' + escHtml(g.key) + '</td>' +
      '<td class="num">' + g.reports + '</td>' +
      '<td class="num">' + g.acres.toFixed(1) + '</td>' +
      '<td class="num">' + Math.round(g.bushels).toLocaleString() + '</td>' +
      '<td class="num">' + g.gallons.toFixed(0) + '</td>' +
      '<td class="num">' + g.loads + '</td>' +
      '<td class="num">' + g.bales + '</td>' +
      (anyProfit ? '<td class="num ' + (g.hasProfit ? (g.profit >= 0 ? "profit-pos" : "profit-neg") : "") + '">' + (g.hasProfit ? fmtMoney(g.profit) : "\u2014") + '</td>' : '') +
      '</tr>';
  }).join("");
  var foot = '<tfoot><tr><td>Total</td>' +
    '<td class="num">' + tot.reports + '</td>' +
    '<td class="num">' + tot.acres.toFixed(1) + '</td>' +
    '<td class="num">' + Math.round(tot.bushels).toLocaleString() + '</td>' +
    '<td class="num">' + tot.gallons.toFixed(0) + '</td>' +
    '<td class="num">' + tot.loads + '</td>' +
    '<td class="num">' + tot.bales + '</td>' +
    (anyProfit ? '<td class="num ' + (tot.profit >= 0 ? "profit-pos" : "profit-neg") + '">' + (tot.hasProfit ? fmtMoney(tot.profit) : "\u2014") + '</td>' : '') +
    '</tr></tfoot>';
  return head + body + '</tbody>' + foot + '</table>';
}

// ============================================================
// SEASON SUMMARY — export current view (CSV / PDF)
// Rebuilds the exact filtered + grouped + sorted data that is
// currently shown, so exports always match the dashboard.
// ============================================================
function seasonCurrentView() {
  var reps    = seasonFiltered();
  var groupBy = $("seasonGroup") ? $("seasonGroup").value : "crop";
  var sortBy  = $("seasonSort")  ? $("seasonSort").value  : "acres";
  var yr      = $("seasonYear")  ? $("seasonYear").value  : "all";
  var eq      = $("seasonEquip") ? $("seasonEquip").value : "all";
  var sortFn  = seasonSortFn(sortBy);

  var groupLabels = { crop: "Crop", field: "Field", equipment: "Equipment", month: "Month" };
  var primaryLabel = groupLabels[groupBy] || "Crop";
  var primary = aggregateBy(reps, seasonKeyFn(groupBy), sortFn);

  var secKey   = (groupBy === "field") ? "crop" : "field";
  var secLabel = (groupBy === "field") ? "Crop" : "Field";
  var secondary = aggregateBy(reps, seasonKeyFn(secKey), sortFn);

  var tot = { reports: reps.length, acres: 0, bushels: 0, gallons: 0, loads: 0, bales: 0, profit: 0, hasProfit: false };
  reps.forEach(function (r) {
    tot.acres += sNum(r.acres); tot.bushels += sNum(r.bushels);
    tot.gallons += sNum(r.gallons); tot.loads += sNum(r.loads); tot.bales += sNum(r.bales);
    if (r.cost && r.cost.summary && r.cost.summary.totalProfit != null) { tot.profit += sNum(r.cost.summary.totalProfit); tot.hasProfit = true; }
  });

  var eqLabel = "All Equipment";
  if (eq !== "all") {
    var cfg = (typeof EQ_TYPES !== "undefined") ? EQ_TYPES[eq] : null;
    eqLabel = cfg ? (cfg.emoji + " " + cfg.label) : eq;
  }

  return {
    reps: reps, primary: primary, primaryLabel: primaryLabel,
    secondary: secondary, secLabel: secLabel, tot: tot,
    filters: { year: (yr === "all" ? "All Years"
                : (yr === "custom"
                   ? ("Custom range (" + (($("seasonFrom") && $("seasonFrom").value) || "any") + " \u2192 " + (($("seasonTo") && $("seasonTo").value) || "any") + ")")
                   : yr)), equip: eqLabel,
               groupBy: primaryLabel, sortBy: (sortBy.charAt(0).toUpperCase() + sortBy.slice(1)) }
  };
}

function csvCell(v) {
  var s = (v == null) ? "" : String(v);
  if (/[",\n]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
  return s;
}

function seasonViewToCSV(view) {
  var lines = [];
  lines.push(["Season Summary Export"].map(csvCell).join(","));
  lines.push(["Year", view.filters.year].map(csvCell).join(","));
  lines.push(["Equipment", view.filters.equip].map(csvCell).join(","));
  lines.push(["Grouped By", view.filters.groupBy].map(csvCell).join(","));
  lines.push(["Sorted By", view.filters.sortBy].map(csvCell).join(","));
  lines.push(["Generated", new Date().toLocaleString()].map(csvCell).join(","));
  lines.push("");

  function tableBlock(title, label, groups) {
    lines.push([title].map(csvCell).join(","));
    lines.push([label, "Reports", "Acres", "Bushels", "Gallons", "Loads", "Bales", "Profit ($)"].map(csvCell).join(","));
    groups.forEach(function (g) {
      lines.push([
        g.key, g.reports, g.acres.toFixed(1), Math.round(g.bushels),
        g.gallons.toFixed(0), g.loads, g.bales,
        g.hasProfit ? g.profit.toFixed(2) : ""
      ].map(csvCell).join(","));
    });
    var t = view.tot;
    lines.push([
      "TOTAL", t.reports, t.acres.toFixed(1), Math.round(t.bushels),
      t.gallons.toFixed(0), t.loads, t.bales, t.hasProfit ? t.profit.toFixed(2) : ""
    ].map(csvCell).join(","));
    lines.push("");
  }

  tableBlock("By " + view.primaryLabel, view.primaryLabel, view.primary);
  tableBlock("By " + view.secLabel, view.secLabel, view.secondary);
  return lines.join("\n");
}

function exportSeasonCSV() {
  var view = seasonCurrentView();
  if (!view.reps.length) { appAlert("No data in the current view to export. Adjust the filters and try again."); return; }
  var ts = new Date().toISOString().slice(0, 10);
  var tag = view.filters.groupBy.toLowerCase();
  downloadFile("DiamondO_Season_" + tag + "_" + ts + ".csv", "\ufeff" + seasonViewToCSV(view), "text/csv;charset=utf-8");
}

function seasonViewToHTML(view) {
  var t = view.tot;
  var moneyCell = function (g) {
    if (!g.hasProfit) return "\u2014";
    return '<span class="' + (g.profit >= 0 ? "pos" : "neg") + '">' + fmtMoney(g.profit) + '</span>';
  };
  var tableHTML = function (title, label, groups) {
    var rows = groups.map(function (g) {
      return '<tr><td>' + escHtml(g.key) + '</td><td class="n">' + g.reports + '</td>' +
        '<td class="n">' + g.acres.toFixed(1) + '</td><td class="n">' + Math.round(g.bushels).toLocaleString() + '</td>' +
        '<td class="n">' + g.gallons.toFixed(0) + '</td><td class="n">' + g.loads + '</td><td class="n">' + g.bales + '</td>' +
        '<td class="n">' + moneyCell(g) + '</td></tr>';
    }).join("");
    return '<h2>' + escHtml(title) + '</h2><table><thead><tr>' +
      '<th>' + escHtml(label) + '</th><th class="n">Reports</th><th class="n">Acres</th><th class="n">Bushels</th>' +
      '<th class="n">Gallons</th><th class="n">Loads</th><th class="n">Bales</th><th class="n">Profit</th></tr></thead><tbody>' +
      rows +
      '<tr class="tot"><td>TOTAL</td><td class="n">' + t.reports + '</td><td class="n">' + t.acres.toFixed(1) + '</td>' +
      '<td class="n">' + Math.round(t.bushels).toLocaleString() + '</td><td class="n">' + t.gallons.toFixed(0) + '</td>' +
      '<td class="n">' + t.loads + '</td><td class="n">' + t.bales + '</td><td class="n">' +
      (t.hasProfit ? fmtMoney(t.profit) : "\u2014") + '</td></tr></tbody></table>';
  };

  return '<!doctype html><html><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>Season Summary</title><style>' +
    'body{font-family:Arial,Helvetica,sans-serif;color:#111;padding:24px;}' +
    'h1{margin:0 0 4px;font-size:22px;}h2{margin:22px 0 8px;font-size:16px;}' +
    '.meta{color:#555;font-size:13px;margin-bottom:6px;}' +
    '.meta b{color:#111;}' +
    'table{border-collapse:collapse;width:100%;font-size:13px;margin-bottom:8px;}' +
    'th,td{border:1px solid #ccc;padding:6px 8px;text-align:left;}' +
    'th{background:#f3efe0;}td.n,th.n{text-align:right;}' +
    'tr.tot td{font-weight:bold;background:#faf7ec;}' +
    '.pos{color:#1c7c3c;}.neg{color:#c0301f;}' +
    '.action-bar{margin-bottom:16px;display:flex;gap:10px;}' +
    '.action-bar button{padding:10px 14px;border:none;border-radius:6px;font-size:14px;font-weight:600;cursor:pointer;}' +
    '.btn-back{background:#444;color:#fff;}.btn-print{background:#ffb703;color:#1a1a1a;}' +
    '@media print{.action-bar{display:none!important;}body{padding:30px;}}' +
    '</style></head><body>' +
    '<div class="action-bar">' +
    '<button class="btn-back" onclick="if(window.opener){window.close();}else{history.back();}">\u2190 Back to App</button>' +
    '<button class="btn-print" onclick="window.print()">\uD83D\uDDA8\uFE0F Print / Save PDF</button>' +
    '</div>' +
    '<h1>\uD83D\uDCCA Season Summary</h1>' +
    '<div class="meta"><b>Year:</b> ' + escHtml(view.filters.year) +
    ' &nbsp; <b>Equipment:</b> ' + escHtml(view.filters.equip) +
    ' &nbsp; <b>Grouped by:</b> ' + escHtml(view.filters.groupBy) +
    ' &nbsp; <b>Sorted by:</b> ' + escHtml(view.filters.sortBy) + '</div>' +
    '<div class="meta">Generated ' + escHtml(new Date().toLocaleString()) +
    ' \u00B7 ' + view.tot.reports + ' report' + (view.tot.reports !== 1 ? "s" : "") + '</div>' +
    tableHTML("By " + view.primaryLabel, view.primaryLabel, view.primary) +
    tableHTML("By " + view.secLabel, view.secLabel, view.secondary) +
    '</body></html>';
}

function exportSeasonPDF() {
  var view = seasonCurrentView();
  if (!view.reps.length) { appAlert("No data in the current view to export. Adjust the filters and try again."); return; }
  var html = seasonViewToHTML(view);

  var win = null;
  try { win = window.open("", "_blank"); } catch (e) { win = null; }
  var url = null;
  try { url = URL.createObjectURL(new Blob([html], { type: "text/html" })); } catch (e) { url = null; }

  if (win && url) {
    try { win.location.href = url; }
    catch (e) { try { win.document.open(); win.document.write(html); win.document.close(); } catch (e2) {} }
    setTimeout(function () { try { URL.revokeObjectURL(url); } catch (e) {} }, 60000);
  } else if (url) {
    window.location.href = url;
    setTimeout(function () { try { URL.revokeObjectURL(url); } catch (e) {} }, 60000);
  } else if (win) {
    try { win.document.open(); win.document.write(html); win.document.close(); } catch (e) {}
  } else {
    appAlert("Could not open the export view. Please allow pop-ups for this site and try again.", "PDF");
  }
}

if ($("btnSeasonCSV")) $("btnSeasonCSV").addEventListener("click", exportSeasonCSV);
if ($("btnSeasonPDF")) $("btnSeasonPDF").addEventListener("click", exportSeasonPDF);

if ($("seasonYear")) $("seasonYear").addEventListener("change", function () { syncSeasonRangeVisibility(); renderSeason(); });
if ($("seasonFrom")) $("seasonFrom").addEventListener("change", renderSeason);
if ($("seasonTo")) $("seasonTo").addEventListener("change", renderSeason);
if ($("seasonEquip")) $("seasonEquip").addEventListener("change", renderSeason);
if ($("seasonGroup")) $("seasonGroup").addEventListener("change", renderSeason);
if ($("seasonSort")) $("seasonSort").addEventListener("change", renderSeason);
if ($("btnSeasonRefresh")) $("btnSeasonRefresh").addEventListener("click", renderSeason);

window.addEventListener("DOMContentLoaded", () => {
  loadEquipmentList();
  loadReportsList();
  loadFieldsList();
  var _vEl = document.getElementById("appVersion");
  if (_vEl && window.APP_VERSION) _vEl.textContent = "v" + window.APP_VERSION;
  applyEquipmentUI();
  renderSectionButtons();
  if (typeof refreshSyncUI === "function") refreshSyncUI();   // ← Stage 1: sync UI
  startLocationFollow();
  showEqSubmenu($("eqType").value);
  updateEqSummary();
  updatePlanterCalcWidth();
  updateDataStats();                    // ← initialize backup card summary
  populateSeasonYears();                // ← seed season year filter
  renderNotes();                        // ← seed empty notes list
  migrateLegacyPhotos();                // ← one-time: inline photos -> IndexedDB
});

// One-time migration: any note with an inline `photo` dataURL (Stage 1) is
// moved into IndexedDB and replaced with a photoId. Safe to run every load —
// it only acts on notes that still carry an inline photo.
function migrateLegacyPhotos() {
  try {
    var all = JSON.parse(localStorage.getItem(LS_REPS) || "{}");
    var keys = Object.keys(all);
    var pending = [];
    keys.forEach(function (k) {
      var rep = all[k];
      if (!rep || !rep.notes) return;
      rep.notes.forEach(function (n) {
        if (n.photo && !n.photoId) {
          var id = newPhotoId();
          pending.push(photoPut(id, n.photo).then(function () {
            n.photoId = id;
            delete n.photo;
          }).catch(function () {/* leave inline if IDB fails */}));
        }
      });
    });
    if (pending.length) {
      Promise.all(pending).then(function () {
        localStorage.setItem(LS_REPS, JSON.stringify(all));
        // [migrate] inline-photo migration log removed for production
      });
    }
  } catch (e) { console.warn("[migrate] skipped:", e); }
}

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

// ============================================================
// PWA — SERVICE WORKER REGISTRATION (offline support)
// ============================================================
// ============================================================
// GOOGLE SYNC — Stage 1: Sign in with Google (auth only)
// Uses Google Identity Services token flow (no client secret).
// Scope: drive.appdata (private app folder) + email (to show who's in).
// ============================================================
var GoogleSync = (function () {
  var SCOPES = "https://www.googleapis.com/auth/drive.appdata https://www.googleapis.com/auth/userinfo.email";
  var tokenClient = null;
  var accessToken = null;
  var userEmail = null;

  function clientId() { return window.GOOGLE_OAUTH_CLIENT_ID || ""; }

  function isConfigured() {
    return !!clientId() && clientId().indexOf("apps.googleusercontent.com") !== -1;
  }

  function gisReady() {
    return typeof google !== "undefined" && google.accounts && google.accounts.oauth2;
  }

  function getToken() { return accessToken; }
  function getEmail() { return userEmail; }
  function isSignedIn() { return !!accessToken; }

  function ensureClient() {
    if (tokenClient) return tokenClient;
    if (!gisReady() || !isConfigured()) return null;
    tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: clientId(),
      scope: SCOPES,
      callback: function () {}
    });
    return tokenClient;
  }

  function fetchEmail() {
    return fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
      headers: { Authorization: "Bearer " + accessToken }
    }).then(function (r) { return r.ok ? r.json() : null; })
      .then(function (info) { userEmail = info && info.email ? info.email : "(signed in)"; return userEmail; })
      .catch(function () { userEmail = "(signed in)"; return userEmail; });
  }

  function signIn() {
    return new Promise(function (resolve, reject) {
      if (!isConfigured()) { reject(new Error("not-configured")); return; }
      if (!gisReady())     { reject(new Error("gis-not-loaded")); return; }
      var tc = ensureClient();
      if (!tc) { reject(new Error("no-client")); return; }
      tc.callback = function (resp) {
        if (resp && resp.access_token) {
          accessToken = resp.access_token;
          fetchEmail().then(function () { resolve(userEmail); });
        } else {
          reject(new Error(resp && resp.error ? resp.error : "no-token"));
        }
      };
      try {
        tc.requestAccessToken({ prompt: "consent" });
      } catch (e) { reject(e); }
    });
  }

  // Silent sign-in: reuse the existing Google session WITHOUT showing a popup.
  // Uses prompt: "" — if Google needs user interaction (e.g. consent expired or
  // not previously granted), it rejects with "interaction-required" so the caller
  // can fall back to the visible signIn().
  function signInSilent() {
    return new Promise(function (resolve, reject) {
      if (!isConfigured()) { reject(new Error("not-configured")); return; }
      if (!gisReady())     { reject(new Error("gis-not-loaded")); return; }
      var tc = ensureClient();
      if (!tc) { reject(new Error("no-client")); return; }
      var settled = false;
      tc.callback = function (resp) {
        if (settled) return; settled = true;
        if (resp && resp.access_token) {
          accessToken = resp.access_token;
          fetchEmail().then(function () { resolve(userEmail); });
        } else {
          reject(new Error(resp && resp.error ? resp.error : "no-token"));
        }
      };
      // error_callback fires when a popup would be required but prompt is "".
      try {
        tc.requestAccessToken({
          prompt: "",
          error_callback: function (err) {
            if (settled) return; settled = true;
            reject(new Error((err && err.type) ? err.type : "interaction-required"));
          }
        });
      } catch (e) { if (!settled) { settled = true; reject(e); } }
    });
  }

  function signOut() {
    var tok = accessToken;
    accessToken = null; userEmail = null;
    if (tok && gisReady() && google.accounts.oauth2.revoke) {
      try { google.accounts.oauth2.revoke(tok, function () {}); } catch (e) {}
    }
  }

  return {
    isConfigured: isConfigured, gisReady: gisReady,
    isSignedIn: isSignedIn, getToken: getToken, getEmail: getEmail,
    signIn: signIn, signInSilent: signInSilent, signOut: signOut
  };
})();

// ---- "Stay logged in" preference (drives silent re-login on app open) ----
var LS_STAY_LOGGED_IN = "dof_stay_logged_in";
function markStayLoggedIn() { try { localStorage.setItem(LS_STAY_LOGGED_IN, "1"); } catch (e) {} }
function clearStayLoggedIn() { try { localStorage.removeItem(LS_STAY_LOGGED_IN); } catch (e) {} }
function wantsStayLoggedIn() { try { return localStorage.getItem(LS_STAY_LOGGED_IN) === "1"; } catch (e) { return false; } }

// ============================================================
// GOOGLE EARTH IMPORT — parse KML / KMZ field boundaries
// Self-contained: DOMParser for KML, DecompressionStream for KMZ.
// ============================================================
var KmlImport = (function () {

  // ---- Spherical polygon area (matches Google computeArea), returns acres ----
  function acresFromPoints(pts) {
    if (!pts || pts.length < 3) return 0;
    var R = 6378137; // WGS84 radius (m)
    function rad(d) { return d * Math.PI / 180; }
    var area = 0, n = pts.length;
    for (var i = 0; i < n; i++) {
      var p1 = pts[i], p2 = pts[(i + 1) % n];
      area += rad(p2.lng - p1.lng) * (2 + Math.sin(rad(p1.lat)) + Math.sin(rad(p2.lat)));
    }
    area = Math.abs(area * R * R / 2);          // m^2
    return (area * 10.7639) / SQFT_PER_ACRE;     // -> acres
  }

  // ---- Parse a coordinates string "lng,lat,alt lng,lat,alt ..." ----
  function validLatLng(p) {
    return isFinite(p.lat) && isFinite(p.lng) &&
           p.lat >= -90 && p.lat <= 90 && p.lng >= -180 && p.lng <= 180 &&
           !(p.lat === 0 && p.lng === 0);   // drop stray null-island (0,0) points
  }
  function parseCoords(s) {
    if (!s) return [];
    var raw = s.trim().split(/\s+/).map(function (tok) {
      var parts = tok.split(",");
      var lng = parseFloat(parts[0]), lat = parseFloat(parts[1]);  // KML order: lng,lat,alt
      return { lat: lat, lng: lng };
    });
    var pts = raw.filter(validLatLng);
    // Auto-detect a fully lat,lng-swapped file: if almost everything fails but
    // swapping fixes it, swap them all.
    if (pts.length < 3 && raw.length >= 3) {
      var swapped = raw.map(function (p) { return { lat: p.lng, lng: p.lat }; }).filter(validLatLng);
      if (swapped.length > pts.length) pts = swapped;
    }
    return pts;
  }

  // ---- Parse KML text -> [{ name, points, acres }] (polygons only) ----
  function parseKmlText(kmlText) {
    var doc = new DOMParser().parseFromString(kmlText, "text/xml");
    if (doc.getElementsByTagName("parsererror").length) throw new Error("bad-kml");
    var placemarks = doc.getElementsByTagName("Placemark");
    var out = [];
    for (var i = 0; i < placemarks.length; i++) {
      var pm = placemarks[i];
      var nameEl = pm.getElementsByTagName("name")[0];
      var baseName = nameEl ? (nameEl.textContent || "").trim() : "";
      // A placemark may contain one or more polygons (MultiGeometry)
      var polys = pm.getElementsByTagName("Polygon");
      for (var j = 0; j < polys.length; j++) {
        // Use the outer boundary ring
        var ring = polys[j].getElementsByTagName("coordinates")[0];
        if (!ring) continue;
        var pts = parseCoords(ring.textContent);
        // Drop a duplicate closing point if present
        if (pts.length > 1) {
          var a = pts[0], b = pts[pts.length - 1];
          if (a.lat === b.lat && a.lng === b.lng) pts = pts.slice(0, -1);
        }
        if (pts.length < 3) continue;
        var nm = baseName || ("Field " + (out.length + 1));
        if (polys.length > 1) nm = baseName ? (baseName + " #" + (j + 1)) : nm;
        out.push({ name: nm, points: pts, acres: acresFromPoints(pts) });
      }
    }
    return out;
  }

  // ---- KMZ (ZIP) -> KML text, via central directory + DecompressionStream ----
  function readUInt32LE(b, o) { return (b[o] | (b[o+1]<<8) | (b[o+2]<<16) | (b[o+3]<<24)) >>> 0; }
  function readUInt16LE(b, o) { return (b[o] | (b[o+1]<<8)) >>> 0; }

  function inflateRaw(bytes) {
    // DecompressionStream('deflate-raw') — supported in modern browsers + iOS 16.4+
    if (typeof DecompressionStream === "undefined") {
      return Promise.reject(new Error("no-inflate"));
    }
    var ds = new DecompressionStream("deflate-raw");
    var stream = new Response(bytes).body.pipeThrough(ds);
    return new Response(stream).arrayBuffer().then(function (ab) { return new Uint8Array(ab); });
  }

  function extractKmlFromKmz(arrayBuffer) {
    var buf = new Uint8Array(arrayBuffer);
    // find End Of Central Directory record
    var p = buf.length - 22;
    while (p >= 0 && readUInt32LE(buf, p) !== 0x06054b50) p--;
    if (p < 0) throw new Error("not-kmz");
    var cdCount = readUInt16LE(buf, p + 10);
    var cdOff = readUInt32LE(buf, p + 16);
    var entries = [];
    for (var i = 0; i < cdCount; i++) {
      if (readUInt32LE(buf, cdOff) !== 0x02014b50) break;
      var method   = readUInt16LE(buf, cdOff + 10);
      var compSize = readUInt32LE(buf, cdOff + 20);
      var nameLen  = readUInt16LE(buf, cdOff + 28);
      var extraLen = readUInt16LE(buf, cdOff + 30);
      var cmtLen   = readUInt16LE(buf, cdOff + 32);
      var localOff = readUInt32LE(buf, cdOff + 42);
      var name = new TextDecoder().decode(buf.slice(cdOff + 46, cdOff + 46 + nameLen));
      entries.push({ name: name, method: method, compSize: compSize, localOff: localOff });
      cdOff += 46 + nameLen + extraLen + cmtLen;
    }
    var entry = null, k;
    for (k = 0; k < entries.length; k++) if (/doc\.kml$/i.test(entries[k].name)) { entry = entries[k]; break; }
    if (!entry) for (k = 0; k < entries.length; k++) if (/\.kml$/i.test(entries[k].name)) { entry = entries[k]; break; }
    if (!entry) throw new Error("no-kml-in-kmz");
    var lh = entry.localOff;
    var lNameLen  = readUInt16LE(buf, lh + 26);
    var lExtraLen = readUInt16LE(buf, lh + 28);
    var dataStart = lh + 30 + lNameLen + lExtraLen;
    var compData = buf.slice(dataStart, dataStart + entry.compSize);
    if (entry.method === 0) return Promise.resolve(new TextDecoder().decode(compData)); // stored
    return inflateRaw(compData).then(function (out) { return new TextDecoder().decode(out); });
  }

  // ---- Public: parse a File object (.kml or .kmz) -> Promise<[{name,points,acres}]> ----
  function parseFile(file) {
    var isKmz = /\.kmz$/i.test(file.name) || file.type === "application/vnd.google-earth.kmz";
    if (isKmz) {
      return file.arrayBuffer()
        .then(extractKmlFromKmz)
        .then(parseKmlText);
    }
    return file.text().then(parseKmlText);
  }

  return { parseFile: parseFile, parseKmlText: parseKmlText, acresFromPoints: acresFromPoints };
})();

// ----- KML import preview dialog + save logic -----
function showKmlImportDialog(found) {
  return new Promise(function (resolve) {
    var existing = JSON.parse(localStorage.getItem(LS_FIELDS) || "{}");
    var overlay = document.createElement("div");
    overlay.className = "conflict-overlay";

    var rows = found.map(function (f, i) {
      var dup = Object.prototype.hasOwnProperty.call(existing, f.name);
      return '<label class="kml-item">' +
        '<input type="checkbox" data-idx="' + i + '" checked>' +
        '<span><span class="kml-name">' + escHtml(f.name) + '</span>' +
          (dup ? '<br><span class="kml-warn">\u26A0\uFE0F A field named "' + escHtml(f.name) + '" exists \u2014 importing overwrites it</span>' : '') +
        '</span>' +
        '<span class="kml-meta">' + f.acres.toFixed(2) + ' ac<br>' + f.points.length + ' pts</span>' +
      '</label>';
    }).join("");

    overlay.innerHTML =
      '<div class="conflict-box">' +
        '<div class="conflict-title">\uD83C\uDF0D Import from Google Earth</div>' +
        '<div class="conflict-sub">Found ' + found.length + ' field' + (found.length !== 1 ? 's' : '') +
          '. Choose which to import:</div>' +
        '<div class="conflict-list">' + rows + '</div>' +
        '<div class="conflict-actions">' +
          '<button class="btn" id="kmlAll">Select all</button>' +
          '<button class="btn" id="kmlNone">Select none</button>' +
          '<button class="btn btn-primary" id="kmlImport">Import selected</button>' +
          '<button class="btn" id="kmlCancel">Cancel</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(overlay);

    function setAll(v) {
      overlay.querySelectorAll('input[type=checkbox]').forEach(function (cb) { cb.checked = v; });
    }
    function cleanup() { try { document.body.removeChild(overlay); } catch (e) {} }

    overlay.querySelector("#kmlAll").onclick  = function () { setAll(true); };
    overlay.querySelector("#kmlNone").onclick = function () { setAll(false); };
    overlay.querySelector("#kmlCancel").onclick = function () { cleanup(); resolve(null); };
    overlay.querySelector("#kmlImport").onclick = function () {
      var picked = [];
      overlay.querySelectorAll('input[type=checkbox]:checked').forEach(function (cb) {
        picked.push(found[parseInt(cb.getAttribute("data-idx"), 10)]);
      });
      cleanup(); resolve(picked);
    };
  });
}

// Save imported fields into the field library (same shape as Save Field).
function importFieldsToLibrary(fields) {
  var lib = JSON.parse(localStorage.getItem(LS_FIELDS) || "{}");
  var now = new Date().toISOString();
  fields.forEach(function (f) {
    var prev = lib[f.name] || {};
    lib[f.name] = {
      _modified: now,
      name: f.name,
      crop: prev.crop || "Corn",
      variety: prev.variety || "",
      boundary: { points: f.points.slice(), acres: f.acres },
      cost: prev.cost || {},
      savedAt: now
    };
  });
  localStorage.setItem(LS_FIELDS, JSON.stringify(lib));
}

// Load one imported field onto the map (mirrors the Load Field flow).
function showImportedFieldOnMap(f) {
  if (!state.map || !window.google || !google.maps) return;
  if (state.boundary.poly) { state.boundary.poly.setMap(null); state.boundary.poly = null; }
  state.boundary.points = f.points.slice();
  state.boundary.acres = f.acres;
  state.field = { name: f.name, crop: "Corn", variety: "" };
  if (state.boundary.points.length >= 3) {
    drawBoundaryFinal();
    fitMapToBoundary(state.boundary.points);
  }
  if ($("boundAcres")) $("boundAcres").textContent = f.acres.toFixed(2);
  if ($("fldName")) $("fldName").value = f.name;
  state.loadedFieldKey = f.name;
}

// Main entry: handle a chosen file.
function handleKmlFile(file) {
  if (!file) return;
  if (typeof DecompressionStream === "undefined" && /\.kmz$/i.test(file.name)) {
    appAlert("This device's browser can't open KMZ files. In Google Earth, choose \"Save as KML\" instead and import that.", "KMZ not supported here");
    return;
  }
  KmlImport.parseFile(file).then(function (found) {
    if (!found || !found.length) {
      appAlert("No field polygons were found in that file. Make sure your shapes are saved as polygons (not just pins or paths).", "Nothing to import");
      return;
    }
    return showKmlImportDialog(found).then(function (picked) {
      if (!picked || !picked.length) return;
      importFieldsToLibrary(picked);
      loadFieldsList();
      if (typeof updateDataStats === "function") updateDataStats();
      var total = picked.reduce(function (s, f) { return s + f.acres; }, 0);
      if ($("fldStatus")) {
        $("fldStatus").textContent = "Imported " + picked.length + " field" +
          (picked.length !== 1 ? "s" : "") + " (" + total.toFixed(1) + " ac total).";
      }
      // Offer to show the first on the map
      appConfirm("Imported " + picked.length + " field" + (picked.length !== 1 ? "s" : "") +
        ". Show \"" + picked[0].name + "\" on the map now?",
        { title: "Import complete", okLabel: "Show on map", cancelLabel: "Not now" })
        .then(function (ok) { if (ok) showImportedFieldOnMap(picked[0]); });
    });
  }).catch(function (err) {
    var m = (err && err.message) || "error";
    var msg = "Could not read that file.";
    if (m === "bad-kml") msg = "That file isn't valid KML/KMZ, or it's corrupted.";
    else if (m === "no-kml-in-kmz") msg = "That KMZ doesn't contain a KML file.";
    else if (m === "no-inflate") msg = "This browser can't unzip KMZ. Try saving as KML in Google Earth.";
    else if (m === "not-kmz") msg = "That file isn't a valid KMZ archive.";
    appAlert(msg, "Import failed");
  });
}

// Wire up the button + hidden file input.
(function wireKmlImport() {
  var btn = document.getElementById("btnImportKml");
  var input = document.getElementById("kmlFileInput");
  if (btn && input) {
    btn.addEventListener("click", function () { input.value = ""; input.click(); });
    input.addEventListener("change", function () {
      if (input.files && input.files[0]) handleKmlFile(input.files[0]);
    });
  }
})();


// ============================================================
// GOOGLE DRIVE SYNC ENGINE — Stage 2
// One JSON file in the private appdata folder holds the shared
// equipment / fields / reports. Photos stay local (by design).
// ============================================================
var DriveSync = (function () {
  var SYNC_FILENAME = "opio-farming-sync.json";
  var fileId = null;   // cached Drive file id once found/created

  function authHeader() {
    return { Authorization: "Bearer " + GoogleSync.getToken() };
  }

  // Find the existing sync file in appDataFolder (or null).
  function findFile() {
    var url = "https://www.googleapis.com/drive/v3/files"
      + "?spaces=appDataFolder"
      + "&fields=files(id,name,modifiedTime)"
      + "&q=" + encodeURIComponent("name='" + SYNC_FILENAME + "'");
    return fetch(url, { headers: authHeader() })
      .then(function (r) {
        if (r.status === 401) throw new Error("auth-expired");
        return r.json();
      })
      .then(function (data) {
        if (data.files && data.files.length) { fileId = data.files[0].id; return fileId; }
        return null;
      });
  }

  // Download + parse the sync file contents (or null if no file).
  function download() {
    function fetchContent(id) {
      return fetch("https://www.googleapis.com/drive/v3/files/" + id + "?alt=media",
        { headers: authHeader() })
        .then(function (r) {
          if (r.status === 401) throw new Error("auth-expired");
          if (!r.ok) throw new Error("download-failed");
          return r.text();
        })
        .then(function (txt) { try { return JSON.parse(txt); } catch (e) { return null; } });
    }
    if (fileId) return fetchContent(fileId);
    return findFile().then(function (id) { return id ? fetchContent(id) : null; });
  }

  // Upload (create or update) the sync file with the given object.
  function upload(obj) {
    var body = JSON.stringify(obj);
    if (fileId) {
      // Update existing file content (media upload)
      return fetch("https://www.googleapis.com/upload/drive/v3/files/" + fileId + "?uploadType=media",
        { method: "PATCH",
          headers: Object.assign({ "Content-Type": "application/json" }, authHeader()),
          body: body })
        .then(function (r) { if (!r.ok) throw new Error("upload-failed"); return r.json(); });
    }
    // Create new file in appDataFolder (multipart: metadata + content)
    var boundary = "-------opio" + Date.now();
    var meta = { name: SYNC_FILENAME, parents: ["appDataFolder"] };
    var multipart =
      "--" + boundary + "\r\n" +
      "Content-Type: application/json; charset=UTF-8\r\n\r\n" +
      JSON.stringify(meta) + "\r\n" +
      "--" + boundary + "\r\n" +
      "Content-Type: application/json\r\n\r\n" +
      body + "\r\n" +
      "--" + boundary + "--";
    return fetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id",
      { method: "POST",
        headers: Object.assign({ "Content-Type": "multipart/related; boundary=" + boundary }, authHeader()),
        body: multipart })
      .then(function (r) { if (!r.ok) throw new Error("create-failed"); return r.json(); })
      .then(function (data) { fileId = data.id; return data; });
  }

  return { download: download, upload: upload, FILENAME: SYNC_FILENAME };
})();

// ----- Merge engine -----
// Returns { merged, conflicts } for one library.
// keyName: how items are keyed; tsField: timestamp field for newest-wins.
function mergeLibrary(localObj, cloudObj, tsField, localTomb, cloudTomb) {
  localObj = localObj || {}; cloudObj = cloudObj || {};
  localTomb = localTomb || {}; cloudTomb = cloudTomb || {};
  var merged = {};
  var conflicts = [];
  var mergedTomb = {};
  var keys = {};
  Object.keys(localObj).forEach(function (k) { keys[k] = true; });
  Object.keys(cloudObj).forEach(function (k) { keys[k] = true; });
  Object.keys(localTomb).forEach(function (k) { keys[k] = true; });
  Object.keys(cloudTomb).forEach(function (k) { keys[k] = true; });

  function tparse(v) { return v ? Date.parse(v) : 0; }

  Object.keys(keys).forEach(function (k) {
    var L = localObj[k], C = cloudObj[k];
    // "alive" timestamp: newest edit on either side (items without a stamp count as ts=1)
    var aliveTs = Math.max(
      L ? (tparse(L[tsField]) || 1) : 0,
      C ? (tparse(C[tsField]) || 1) : 0
    );
    var delTs = Math.max(tparse(localTomb[k]), tparse(cloudTomb[k]));

    if (delTs && delTs >= aliveTs) {
      // Deletion wins → omit item, carry tombstone forward
      mergedTomb[k] = new Date(delTs).toISOString();
      return;
    }
    // Item is alive → normal add/update/conflict
    if (L && !C) { merged[k] = L; return; }
    if (C && !L) { merged[k] = C; return; }
    if (JSON.stringify(L) === JSON.stringify(C)) { merged[k] = L; return; }
    var lt = L[tsField] ? Date.parse(L[tsField]) : 0;
    var ct = C[tsField] ? Date.parse(C[tsField]) : 0;
    conflicts.push({ key: k, local: L, cloud: C, localTs: lt, cloudTs: ct });
    merged[k] = L;   // placeholder until dialog resolves
  });
  return { merged: merged, conflicts: conflicts, tombstones: mergedTomb };
}

// Build the merged dataset + list of all conflicts across libraries.
function buildMerge(cloud) {
  var localFields = JSON.parse(localStorage.getItem(LS_FIELDS) || "{}");
  var localEq     = JSON.parse(localStorage.getItem(LS_EQ)     || "{}");
  var localReps   = JSON.parse(localStorage.getItem(LS_REPS)   || "{}");
  var localSeed   = JSON.parse(localStorage.getItem(LS_SEED)   || "{}");

  var cFields = (cloud && cloud.fields)    || {};
  var cEq     = (cloud && cloud.equipment) || {};
  var cReps   = (cloud && cloud.reports)   || {};
  var cSeed   = (cloud && cloud.seedPresets) || {};

  // Local + cloud tombstones (pruned of anything too old)
  var ltFields = pruneTombstones(JSON.parse(localStorage.getItem(LS_TOMB_FIELDS) || "{}"));
  var ltEq     = pruneTombstones(JSON.parse(localStorage.getItem(LS_TOMB_EQ)     || "{}"));
  var ltReps   = pruneTombstones(JSON.parse(localStorage.getItem(LS_TOMB_REPS)   || "{}"));
  var ltSeed   = pruneTombstones(JSON.parse(localStorage.getItem(LS_TOMB_SEED)   || "{}"));
  var ctTomb   = (cloud && cloud.tombstones) || {};
  var ctFields = pruneTombstones(ctTomb.fields || {});
  var ctEq     = pruneTombstones(ctTomb.equipment || {});
  var ctReps   = pruneTombstones(ctTomb.reports || {});
  var ctSeed   = pruneTombstones(ctTomb.seedPresets || {});

  var f = mergeLibrary(localFields, cFields, "_modified", ltFields, ctFields);
  var e = mergeLibrary(localEq,     cEq,     "_modified", ltEq,     ctEq);
  var r = mergeLibrary(localReps,   cReps,   "savedAt",   ltReps,   ctReps);
  var s = mergeLibrary(localSeed,   cSeed,   "_modified", ltSeed,   ctSeed);

  var conflicts = []
    .concat(f.conflicts.map(function (c) { c.lib = "fields";    c.label = "Field";   return c; }))
    .concat(e.conflicts.map(function (c) { c.lib = "equipment"; c.label = "Machine"; return c; }))
    .concat(r.conflicts.map(function (c) { c.lib = "reports";   c.label = "Report";  return c; }))
    .concat(s.conflicts.map(function (c) { c.lib = "seedPresets"; c.label = "Seed preset"; return c; }));

  return {
    merged: { fields: f.merged, equipment: e.merged, reports: r.merged, seedPresets: s.merged },
    tombstones: { fields: f.tombstones, equipment: e.tombstones, reports: r.tombstones, seedPresets: s.tombstones },
    conflicts: conflicts
  };
}

// Apply the user's conflict choices into the merged set.
// choices: { "fields::North 40": "cloud" | "local", ... }
function applyConflictChoices(mergeResult, choices) {
  mergeResult.conflicts.forEach(function (c) {
    var id = c.lib + "::" + c.key;
    var pick = choices[id] || "local";   // default safe = keep mine
    mergeResult.merged[c.lib][c.key] = (pick === "cloud") ? c.cloud : c.local;
  });
  return mergeResult.merged;
}

// Persist a merged dataset locally.
function saveMergedLocal(merged) {
  localStorage.setItem(LS_FIELDS, JSON.stringify(merged.fields || {}));
  localStorage.setItem(LS_EQ,     JSON.stringify(merged.equipment || {}));
  localStorage.setItem(LS_REPS,   JSON.stringify(merged.reports || {}));
  localStorage.setItem(LS_SEED,   JSON.stringify(merged.seedPresets || {}));
}

// Persist merged tombstones locally so future syncs keep propagating deletes.
function saveMergedTombstones(tomb) {
  tomb = tomb || {};
  localStorage.setItem(LS_TOMB_FIELDS, JSON.stringify(tomb.fields || {}));
  localStorage.setItem(LS_TOMB_EQ,     JSON.stringify(tomb.equipment || {}));
  localStorage.setItem(LS_TOMB_REPS,   JSON.stringify(tomb.reports || {}));
  localStorage.setItem(LS_TOMB_SEED,   JSON.stringify(tomb.seedPresets || {}));
}

// Produce a small human-readable summary of how two versions differ.
function describeConflict(c) {
  var L = c.local || {}, C = c.cloud || {};
  // pick meaningful fields per library type
  var fieldsByLib = {
    fields:    ["crop", "variety", "boundary", "cost"],
    equipment: ["type", "width"],
    reports:   ["name", "acres", "bushels", "gallons", "date"]
  };
  var list = fieldsByLib[c.lib] || [];
  var rowsOut = [];
  function fmt(v) {
    if (v == null) return "—";
    if (typeof v === "object") {
      if (v && typeof v.acres === "number") return v.acres.toFixed(2) + " ac"; // boundary
      return "(set)";
    }
    return String(v);
  }
  list.forEach(function (k) {
    var lv = fmt(L[k]), cv = fmt(C[k]);
    if (lv !== cv) {
      rowsOut.push('<div class="cf-diff-row"><span class="cf-diff-k">' + escHtml(k) +
        '</span><span class="cf-diff-mine">' + escHtml(lv) +
        '</span><span class="cf-diff-cloud">' + escHtml(cv) + '</span></div>');
    }
  });
  if (!rowsOut.length) return "";
  return '<div class="cf-diff-head"><span class="cf-diff-k"></span>' +
         '<span class="cf-diff-mine">Mine</span><span class="cf-diff-cloud">Cloud</span></div>' +
         rowsOut.join("");
}

// ----- Conflict resolution dialog (built dynamically) -----
// Resolves to a choices map { "lib::key": "local"|"cloud" }, or null if cancelled.
function showConflictDialog(conflicts) {
  return new Promise(function (resolve) {
    var overlay = document.createElement("div");
    overlay.className = "conflict-overlay";

    var rows = conflicts.map(function (c, i) {
      var localWhen = c.localTs ? new Date(c.localTs).toLocaleString() : "no date";
      var cloudWhen = c.cloudTs ? new Date(c.cloudTs).toLocaleString() : "no date";
      var newer = c.cloudTs > c.localTs ? "cloud" : "local";
      var id = c.lib + "::" + c.key;
      var diffHtml = describeConflict(c);   // human-readable field differences
      return '<div class="conflict-item" data-cid="' + escHtml(id) + '">' +
        '<div class="conflict-name">' + escHtml(c.label) + ': <b>' + escHtml(c.key) + '</b></div>' +
        (diffHtml ? '<div class="conflict-diff">' + diffHtml + '</div>' : '') +
        '<div class="conflict-choices">' +
          '<label class="cf-choice cf-mine ' + (newer === "local" ? "newer" : "") + '" data-val="local">' +
            '<input type="radio" name="r' + i + '" value="local" checked>' +
            '<span class="cf-pick">Keep Mine</span>' +
            '<span class="ts">' + localWhen + (newer === "local" ? " · newest" : "") + '</span>' +
          '</label>' +
          '<label class="cf-choice cf-cloud ' + (newer === "cloud" ? "newer" : "") + '" data-val="cloud">' +
            '<input type="radio" name="r' + i + '" value="cloud">' +
            '<span class="cf-pick">Keep Cloud</span>' +
            '<span class="ts">' + cloudWhen + (newer === "cloud" ? " · newest" : "") + '</span>' +
          '</label>' +
        '</div>' +
      '</div>';
    }).join("");

    overlay.innerHTML =
      '<div class="conflict-box">' +
        '<div class="conflict-title">\u26A0\uFE0F Sync conflicts (' + conflicts.length + ')</div>' +
        '<div class="conflict-sub">These items differ on this device and in the cloud. Choose which to keep:</div>' +
        '<div class="conflict-list">' + rows + '</div>' +
        '<div class="conflict-actions">' +
          '<button class="btn" id="cfKeepAllMine">Keep all mine</button>' +
          '<button class="btn" id="cfKeepAllCloud">Keep all cloud</button>' +
          '<button class="btn btn-primary" id="cfApply">Apply &amp; Sync</button>' +
          '<button class="btn" id="cfCancel">Cancel</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(overlay);

    function syncSelectedClasses() {
      overlay.querySelectorAll(".conflict-item").forEach(function (item) {
        var picked = item.querySelector('input[type=radio]:checked');
        var val = picked ? picked.value : "local";
        item.querySelectorAll(".cf-choice").forEach(function (lab) {
          lab.classList.toggle("selected", lab.getAttribute("data-val") === val);
        });
      });
    }
    function pickAll(val) {
      overlay.querySelectorAll('input[type=radio][value="' + val + '"]').forEach(function (r) { r.checked = true; });
      syncSelectedClasses();
    }
    // Clicking anywhere on a choice selects its radio.
    overlay.querySelectorAll(".cf-choice").forEach(function (lab) {
      lab.addEventListener("click", function () {
        var radio = lab.querySelector('input[type=radio]');
        if (radio) { radio.checked = true; syncSelectedClasses(); }
      });
    });
    syncSelectedClasses();   // initialize highlight
    overlay.querySelector("#cfKeepAllMine").onclick = function () { pickAll("local"); };
    overlay.querySelector("#cfKeepAllCloud").onclick = function () { pickAll("cloud"); };

    function cleanup() { try { document.body.removeChild(overlay); } catch (e) {} }

    overlay.querySelector("#cfCancel").onclick = function () { cleanup(); resolve(null); };
    overlay.querySelector("#cfApply").onclick = function () {
      var choices = {};
      overlay.querySelectorAll(".conflict-item").forEach(function (item) {
        var id = item.getAttribute("data-cid");
        var sel = item.querySelector('input[type=radio]:checked');
        choices[id] = sel ? sel.value : "local";
      });
      cleanup(); resolve(choices);
    };
  });
}

// ----- Main Sync Now orchestration -----
function syncNow() {
  if (!GoogleSync.isSignedIn()) {
    return appAlert("Please sign in with Google first.", "Not signed in");
  }
  if (typeof navigator !== "undefined" && navigator.onLine === false) {
    setSyncStatus("\uD83D\uDCF6 You're offline — connect to the internet to sync.");
    return appAlert("You're offline. Connect to the internet and try Sync Now again. Your data is safe on this device.", "No connection");
  }
  setSyncStatus("Syncing\u2026 downloading from Drive");

  return DriveSync.download().then(function (cloud) {
    var result = buildMerge(cloud);

    function finishWith(mergedData) {
      // Safety: snapshot current device data before overwriting.
      try {
        localStorage.setItem(LS_BACKUP_ROLLBACK, JSON.stringify(buildBackup(false)));
      } catch (e) {}
      saveMergedLocal(mergedData);
      saveMergedTombstones(result.tombstones);
      setSyncStatus("Uploading merged data\u2026");
      var payload = {
        app: "O\u03C0O Farming — Data Systems Pro",
        version: BACKUP_VERSION,
        syncedAt: new Date().toISOString(),
        fields: mergedData.fields,
        equipment: mergedData.equipment,
        reports: mergedData.reports,
        seedPresets: mergedData.seedPresets,
        tombstones: result.tombstones || {}
      };
      return DriveSync.upload(payload).then(function () {
        // Refresh any visible lists
        if (typeof loadFieldsList === "function") loadFieldsList();
        if (typeof loadEquipmentList === "function") loadEquipmentList();
        if (typeof loadReportsList === "function") loadReportsList();
        if (typeof loadSeedPresetList === "function") loadSeedPresetList();
        if (typeof updateDataStats === "function") updateDataStats();
        var nowIso = new Date().toISOString();
        try { localStorage.setItem(LS_LAST_SYNCED, nowIso); } catch (e) {}
        renderLastSynced();
        var when = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
        setSyncStatus("\u2705 Synced at " + when);
      });
    }

    if (!result.conflicts.length) {
      return finishWith(result.merged);   // no conflicts → silent merge
    }
    // Conflicts → ask the user.
    setSyncStatus(result.conflicts.length + " conflict(s) need your choice\u2026");
    return showConflictDialog(result.conflicts).then(function (choices) {
      if (!choices) { setSyncStatus("Sync cancelled."); return; }
      var mergedData = applyConflictChoices(result, choices);
      return finishWith(mergedData);
    });
  }).catch(function (err) {
    var m = (err && err.message) || "error";
    if (m === "auth-expired") {
      GoogleSync.signOut(); refreshSyncUI();
      appAlert("Your Google session expired. Please sign in again.", "Session expired");
      setSyncStatus("");
    } else if (m.indexOf("Failed to fetch") !== -1 || m.indexOf("NetworkError") !== -1 || m.indexOf("Load failed") !== -1) {
      appAlert("Couldn't reach Google. Check your internet connection and try again. Your data is safe on this device.", "Connection problem");
      setSyncStatus("\uD83D\uDCF6 Sync failed — no connection.");
    } else {
      appAlert("Sync failed: " + m, "Sync error");
      setSyncStatus("\u274C Sync failed.");
    }
  });
}

// ----- Sync UI wiring (Stage 1) -----
function refreshSyncUI() {
  var outBox = document.getElementById("syncSignedOut");
  var inBox  = document.getElementById("syncSignedIn");
  var emailEl = document.getElementById("syncUserEmail");
  if (!outBox || !inBox) return;
  if (GoogleSync.isSignedIn()) {
    outBox.classList.add("hidden");
    inBox.classList.remove("hidden");
    if (emailEl) emailEl.textContent = GoogleSync.getEmail() || "(signed in)";
    var stayChk = document.getElementById("chkStaySignedIn");
    if (stayChk && typeof wantsStayLoggedIn === "function") stayChk.checked = wantsStayLoggedIn();
  } else {
    inBox.classList.add("hidden");
    outBox.classList.remove("hidden");
  }
  renderLastSynced();
}

function renderLastSynced() {
  var el = document.getElementById("syncLastSynced");
  if (!el) return;
  var iso = localStorage.getItem(LS_LAST_SYNCED);
  if (!iso) { el.textContent = "Not synced yet on this device."; return; }
  var d = new Date(iso);
  el.textContent = "Last synced: " + d.toLocaleString();
}

function setSyncStatus(msg) {
  var el = document.getElementById("syncStatus");
  if (el) el.textContent = msg || "";
}

(function wireSyncUI() {
  var signInBtn = document.getElementById("btnGoogleSignIn");
  var signOutBtn = document.getElementById("btnGoogleSignOut");

  if (signInBtn) signInBtn.addEventListener("click", function () {
    if (!GoogleSync.isConfigured()) {
      appAlert("Google sync isn't set up yet. Add your OAuth Client ID to config.js.", "Sync not configured");
      return;
    }
    if (!GoogleSync.gisReady()) {
      appAlert("Google sign-in is still loading. Check your connection and try again in a moment.", "Please wait");
      return;
    }
    signInBtn.disabled = true;
    signInBtn.textContent = "Signing in\u2026";
    GoogleSync.signIn().then(function (email) {
      markStayLoggedIn();   // remember so future opens reconnect silently
      refreshSyncUI();
      setSyncStatus("Signed in.");
    }).catch(function (err) {
      var m = (err && err.message) || "error";
      appAlert("Could not sign in: " + m, "Sign-in failed");
    }).finally(function () {
      signInBtn.disabled = false;
      signInBtn.textContent = "\uD83D\uDD11 Sign in with Google";
    });
  });

  if (signOutBtn) signOutBtn.addEventListener("click", function () {
    GoogleSync.signOut();
    clearStayLoggedIn();   // stop silent re-login until the user signs in again
    refreshSyncUI();
    setSyncStatus("Signed out.");
  });

  var stayChk = document.getElementById("chkStaySignedIn");
  if (stayChk) {
    // Initialize from saved preference.
    if (typeof wantsStayLoggedIn === "function") stayChk.checked = wantsStayLoggedIn();
    stayChk.addEventListener("change", function () {
      if (stayChk.checked) {
        if (typeof markStayLoggedIn === "function") markStayLoggedIn();
        setSyncStatus("Will reconnect automatically next time you open the app.");
      } else {
        if (typeof clearStayLoggedIn === "function") clearStayLoggedIn();
        setSyncStatus("Auto-reconnect off. You'll be asked to sign in next open.");
      }
    });
  }

  var syncBtn = document.getElementById("btnSyncNow");
  if (syncBtn) {
    syncBtn.disabled = false;
    syncBtn.title = "";
    syncBtn.addEventListener("click", function () {
      syncBtn.disabled = true;
      var orig = syncBtn.textContent;
      syncBtn.textContent = "Syncing\u2026";
      Promise.resolve(syncNow()).finally(function () {
        syncBtn.disabled = false;
        syncBtn.textContent = orig;
      });
    });
  }
})();

if ("serviceWorker" in navigator) {
  var _waitingSW = null;   // a SW that has installed and is waiting to activate

  // Show the "update available" banner and wire its button.
  function showUpdateBanner(worker) {
    _waitingSW = worker;
    var bar = document.getElementById("updateBanner");
    if (bar) bar.classList.remove("hidden");
  }

  function applyUpdate() {
    var bar = document.getElementById("updateBanner");
    if (bar) bar.textContent = "Updating\u2026";
    if (_waitingSW) {
      _waitingSW.postMessage("SKIP_WAITING");   // tell it to take over now
    } else {
      window.location.reload();                  // fallback
    }
  }
  window.applyUpdate = applyUpdate;   // referenced by the banner button

  window.addEventListener("load", function () {
    navigator.serviceWorker.register("sw.js").then(function (reg) {
      // [PWA] service-worker registration log removed for production

      // If one is already waiting (e.g. installed on a previous visit), prompt.
      if (reg.waiting && navigator.serviceWorker.controller) {
        showUpdateBanner(reg.waiting);
      }

      // When a new SW is found installing, watch it; prompt once installed.
      reg.addEventListener("updatefound", function () {
        var nw = reg.installing;
        if (!nw) return;
        nw.addEventListener("statechange", function () {
          if (nw.state === "installed" && navigator.serviceWorker.controller) {
            showUpdateBanner(nw);   // new version ready (not first install)
          }
        });
      });

      // Proactively check for updates each time the app is opened/focused.
      function checkForUpdate() { reg.update().catch(function(){}); }
      document.addEventListener("visibilitychange", function () {
        if (document.visibilityState === "visible") checkForUpdate();
      });
      // Also check shortly after load.
      setTimeout(checkForUpdate, 3000);

    }).catch(function (err) {
      console.warn("[PWA] Service worker registration failed:", err);
    });

    // When the new SW takes control, reload once into the fresh version.
    var refreshing = false;
    navigator.serviceWorker.addEventListener("controllerchange", function () {
      if (refreshing) return;
      refreshing = true;
      window.location.reload();
    });
  });
}


// ============================================================
// TOOLS TAB — Unit Converter, Acreage Calculator, GPS Lookup
// (Added 2026.06.06. Mix Calculator & Cost/Profit logic is
//  unchanged and lives elsewhere in this file.)
// ============================================================
(function () {
  function $id(id) { return document.getElementById(id); }
  function fmt(n, d) {
    if (!isFinite(n)) return "\u2014";
    d = (d == null) ? 4 : d;
    return parseFloat(n.toFixed(d)).toLocaleString(undefined, { maximumFractionDigits: d });
  }

  var UNITS = {
    length: { units: { "in": 1/12, "ft": 1, "yd": 3, "mi": 5280, "cm": 0.0328084, "m": 3.28084, "km": 3280.84 }},
    area:   { units: { "sqft": 1/43560, "sqyd": 9/43560, "ac": 1, "ha": 2.47105, "sqm": 0.000247105, "sqmi": 640 }},
    volume: { units: { "oz": 1/128, "pt": 1/8, "qt": 1/4, "gal": 1, "L": 0.264172, "mL": 0.000264172 }},
    weight: { units: { "oz": 1/16, "lb": 1, "ton": 2000, "g": 0.00220462, "kg": 2.20462, "tonne": 2204.62 }},
    rate:   { units: { "oz/ac": 1/128, "pt/ac": 1/8, "qt/ac": 1/4, "gal/ac": 1, "L/ha": 0.264172/2.47105 }}
  };
  var LABELS = {
    "in":"inches","ft":"feet","yd":"yards","mi":"miles","cm":"centimeters","m":"meters","km":"kilometers",
    "sqft":"sq feet","sqyd":"sq yards","ac":"acres","ha":"hectares","sqm":"sq meters","sqmi":"sq miles",
    "oz":"fluid oz","pt":"pints","qt":"quarts","gal":"gallons","L":"liters","mL":"milliliters",
    "lb":"pounds","ton":"tons (US)","g":"grams","kg":"kilograms","tonne":"metric tons",
    "oz/ac":"oz/acre","pt/ac":"pt/acre","qt/ac":"qt/acre","gal/ac":"gal/acre","L/ha":"L/hectare"
  };

  function fillUnitSelects() {
    var cat = $id("convCategory"); if (!cat) return;
    var group = UNITS[cat.value];
    var from = $id("convFrom"), to = $id("convTo");
    var keys = Object.keys(group.units);
    var opts = keys.map(function (k) {
      return '<option value="' + k + '">' + k + ' \u2014 ' + (LABELS[k] || k) + '</option>';
    }).join("");
    from.innerHTML = opts; to.innerHTML = opts;
    if (keys.length > 1) to.selectedIndex = 1;
  }
  function convert() {
    var cat = $id("convCategory").value;
    var group = UNITS[cat];
    var v = parseFloat($id("convValue").value);
    var f = $id("convFrom").value, t = $id("convTo").value;
    var out = $id("convResult");
    if (isNaN(v)) { out.innerHTML = '<div class="hint">Enter a value to convert.</div>'; return; }
    var result = (v * group.units[f]) / group.units[t];
    out.innerHTML =
      '<div class="mix-line"><b>' + fmt(v) + ' ' + f + '</b> = <b>' + fmt(result) + ' ' + t + '</b></div>' +
      '<div class="hint">' + (LABELS[f] || f) + ' \u2192 ' + (LABELS[t] || t) + '</div>';
  }
  if ($id("convCategory")) {
    fillUnitSelects();
    $id("convCategory").addEventListener("change", function () { fillUnitSelects(); $id("convResult").innerHTML = ""; });
    $id("btnConvCalc").addEventListener("click", convert);
    $id("convValue").addEventListener("input", convert);
    $id("convFrom").addEventListener("change", convert);
    $id("convTo").addEventListener("change", convert);
    $id("btnConvSwap").addEventListener("click", function () {
      var f = $id("convFrom"), t = $id("convTo");
      var tmp = f.value; f.value = t.value; t.value = tmp; convert();
    });
  }

  var SQFT_PER_ACRE = 43560;
  function toFeet(val, units) {
    if (units === "yd") return val * 3;
    if (units === "m")  return val * 3.28084;
    return val;
  }
  function acreLabels() {
    var shape = $id("acreShape").value;
    var la = $id("acreLblA"), lb = $id("acreLblB"), b = $id("acreB");
    var unitsSel = $id("acreUnits");
    function setUnitsVisible(vis) { unitsSel.parentElement.style.display = vis ? "" : "none"; }
    b.parentElement.style.display = "";
    setUnitsVisible(true);
    if (shape === "rect")          { la.childNodes[0].nodeValue = "Length "; lb.childNodes[0].nodeValue = "Width "; }
    else if (shape === "circle")   { la.childNodes[0].nodeValue = "Radius "; b.parentElement.style.display = "none"; }
    else if (shape === "triangle") { la.childNodes[0].nodeValue = "Base "; lb.childNodes[0].nodeValue = "Height "; }
    else if (shape === "sqft")     { la.childNodes[0].nodeValue = "Square feet "; b.parentElement.style.display = "none"; setUnitsVisible(false); }
    else if (shape === "sqm")      { la.childNodes[0].nodeValue = "Square meters "; b.parentElement.style.display = "none"; setUnitsVisible(false); }
  }
  function acreCalc() {
    var shape = $id("acreShape").value;
    var units = $id("acreUnits").value;
    var a = parseFloat($id("acreA").value);
    var b = parseFloat($id("acreB").value);
    var out = $id("acreResult");
    var sqft;
    if (shape === "sqft")      { sqft = a; }
    else if (shape === "sqm")  { sqft = a * 10.7639; }
    else {
      var af = toFeet(a, units), bf = toFeet(b, units);
      if (shape === "rect")          sqft = af * bf;
      else if (shape === "circle")   sqft = Math.PI * af * af;
      else if (shape === "triangle") sqft = 0.5 * af * bf;
    }
    if (isNaN(sqft)) { out.innerHTML = '<div class="hint">Enter the measurement(s).</div>'; return; }
    var acres = sqft / SQFT_PER_ACRE;
    out.innerHTML =
      '<div class="mix-line"><b>' + fmt(acres, 3) + ' acres</b></div>' +
      '<div class="hint">' + fmt(sqft, 0) + ' sq ft \u00B7 ' + fmt(sqft * 0.092903, 1) + ' sq m \u00B7 ' + fmt(acres * 0.404686, 3) + ' ha</div>';
  }
  if ($id("acreShape")) {
    acreLabels();
    $id("acreShape").addEventListener("change", function () { acreLabels(); $id("acreResult").innerHTML = ""; });
    $id("btnAcreCalc").addEventListener("click", acreCalc);
    $id("btnAcreReset").addEventListener("click", function () {
      $id("acreA").value = ""; $id("acreB").value = ""; $id("acreResult").innerHTML = "";
    });
  }

  function haversineMiles(lat1, lon1, lat2, lon2) {
    var R = 3958.7613, rad = Math.PI / 180;
    var dLat = (lat2 - lat1) * rad, dLon = (lon2 - lon1) * rad;
    var s = Math.sin(dLat/2)*Math.sin(dLat/2) +
            Math.cos(lat1*rad)*Math.cos(lat2*rad)*Math.sin(dLon/2)*Math.sin(dLon/2);
    return 2 * R * Math.asin(Math.sqrt(s));
  }
  if ($id("btnGpsHere")) {
    $id("btnGpsHere").addEventListener("click", function () {
      var out = $id("gpsHereResult");
      if (!navigator.geolocation) { out.innerHTML = '<div class="hint">Geolocation not supported on this device.</div>'; return; }
      out.innerHTML = '<div class="hint">Locating\u2026</div>';
      navigator.geolocation.getCurrentPosition(function (p) {
        var la = p.coords.latitude, ln = p.coords.longitude, ac = p.coords.accuracy;
        $id("gpsLatA").value = la.toFixed(6);
        $id("gpsLngA").value = ln.toFixed(6);
        out.innerHTML =
          '<div class="mix-line"><b>' + la.toFixed(6) + ', ' + ln.toFixed(6) + '</b></div>' +
          '<div class="hint">Accuracy \u00B1' + Math.round(ac) + ' m \u00B7 filled into Point A</div>';
      }, function (err) {
        out.innerHTML = '<div class="hint">Could not get location: ' + err.message + '</div>';
      }, { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 });
    });
  }
  if ($id("btnGpsDist")) {
    $id("btnGpsDist").addEventListener("click", function () {
      var laA = parseFloat($id("gpsLatA").value), lnA = parseFloat($id("gpsLngA").value);
      var laB = parseFloat($id("gpsLatB").value), lnB = parseFloat($id("gpsLngB").value);
      var out = $id("gpsDistResult");
      if ([laA,lnA,laB,lnB].some(isNaN)) { out.innerHTML = '<div class="hint">Enter both Point A and Point B coordinates.</div>'; return; }
      var mi = haversineMiles(laA, lnA, laB, lnB);
      out.innerHTML =
        '<div class="mix-line"><b>' + fmt(mi, 3) + ' miles</b> between A and B</div>' +
        '<div class="hint">' + fmt(mi * 5280, 0) + ' ft \u00B7 ' + fmt(mi * 1.60934, 3) + ' km</div>';
    });
  }
  if ($id("btnGpsMaps")) {
    $id("btnGpsMaps").addEventListener("click", function () {
      var la = parseFloat($id("gpsLatA").value), ln = parseFloat($id("gpsLngA").value);
      if (isNaN(la) || isNaN(ln)) { $id("gpsDistResult").innerHTML = '<div class="hint">Enter Point A coordinates first.</div>'; return; }
      window.open("https://www.google.com/maps/search/?api=1&query=" + la + "," + ln, "_blank");
    });
  }
  if ($id("btnGpsReset")) {
    $id("btnGpsReset").addEventListener("click", function () {
      ["gpsLatA","gpsLngA","gpsLatB","gpsLngB"].forEach(function (id) { $id(id).value = ""; });
      $id("gpsHereResult").innerHTML = ""; $id("gpsDistResult").innerHTML = "";
    });
  }
})();


// ============================================================
// CARD REORDERING — drag or ▲/▼ to rearrange cards within each tab.
// Order is saved per-tab in localStorage and re-applied on load.
// Pure UI preference (kept local; not part of cloud sync).
// ============================================================
(function () {
  var LS_CARD_ORDER = "dof_card_order";
  var PANELS = ["tab-operate", "tab-setup", "tab-tools", "tab-reports", "tab-season"];

  function loadOrders() {
    try { return JSON.parse(localStorage.getItem(LS_CARD_ORDER) || "{}"); }
    catch (e) { return {}; }
  }
  function saveOrders(o) {
    try { localStorage.setItem(LS_CARD_ORDER, JSON.stringify(o)); } catch (e) {}
  }

  // Give every card a stable id based on its panel + original index.
  function ensureCardIds(panel) {
    var cards = panelCards(panel);
    cards.forEach(function (card, i) {
      if (!card.id) card.id = panel.id + "-card-" + i;
      card.setAttribute("data-rc", "1");
      // Remember the original DOM order so "Reset" can restore it.
      if (card.getAttribute("data-rc-orig") == null) card.setAttribute("data-rc-orig", String(i));
    });
    return cards;
  }

  // Direct .card children of a panel (skip the toggle row).
  function panelCards(panel) {
    return Array.prototype.filter.call(panel.children, function (el) {
      return el.classList && el.classList.contains("card");
    });
  }

  function cardTitle(card) {
    return card.querySelector(".card-title");
  }

  // Build the ▲ ▼ ⠿ control cluster for a card.
  function buildControls(panel, card) {
    if (card.querySelector(".card-reorder-ctrls")) return;
    var title = cardTitle(card);
    if (!title) return;
    var wrap = document.createElement("span");
    wrap.className = "card-reorder-ctrls";

    var handle = document.createElement("span");
    handle.className = "rc-btn rc-handle";
    handle.title = "Drag to reorder";
    handle.textContent = "\u2630"; // ☰

    var up = document.createElement("button");
    up.type = "button"; up.className = "rc-btn rc-up"; up.title = "Move up"; up.textContent = "\u25B2";
    up.addEventListener("click", function (e) { e.stopPropagation(); moveCard(panel, card, -1); });

    var down = document.createElement("button");
    down.type = "button"; down.className = "rc-btn rc-down"; down.title = "Move down"; down.textContent = "\u25BC";
    down.addEventListener("click", function (e) { e.stopPropagation(); moveCard(panel, card, 1); });

    wrap.appendChild(handle);
    wrap.appendChild(up);
    wrap.appendChild(down);
    title.appendChild(wrap);

    // Drag & drop (desktop). The whole card is draggable only while reordering.
    card.setAttribute("draggable", "false");
    handle.addEventListener("mousedown", function () { card.setAttribute("draggable", "true"); });
    handle.addEventListener("mouseup", function () { card.setAttribute("draggable", "false"); });

    card.addEventListener("dragstart", function (e) {
      if (!document.body.classList.contains("reordering")) { e.preventDefault(); return; }
      card.classList.add("rc-dragging");
      try { e.dataTransfer.setData("text/plain", card.id); e.dataTransfer.effectAllowed = "move"; } catch (err) {}
    });
    card.addEventListener("dragend", function () {
      card.classList.remove("rc-dragging");
      card.setAttribute("draggable", "false");
      panelCards(panel).forEach(function (c) { c.classList.remove("rc-drop-target"); });
    });
    card.addEventListener("dragover", function (e) {
      if (!document.body.classList.contains("reordering")) return;
      e.preventDefault();
      card.classList.add("rc-drop-target");
    });
    card.addEventListener("dragleave", function () { card.classList.remove("rc-drop-target"); });
    card.addEventListener("drop", function (e) {
      if (!document.body.classList.contains("reordering")) return;
      e.preventDefault();
      card.classList.remove("rc-drop-target");
      var draggedId = "";
      try { draggedId = e.dataTransfer.getData("text/plain"); } catch (err) {}
      var dragged = draggedId && document.getElementById(draggedId);
      if (!dragged || dragged === card) return;
      // Insert dragged before or after target depending on pointer position.
      var rect = card.getBoundingClientRect();
      var after = (e.clientY - rect.top) > rect.height / 2;
      if (after) card.parentNode.insertBefore(dragged, card.nextSibling);
      else card.parentNode.insertBefore(dragged, card);
      persistOrder(panel);
    });
  }

  function moveCard(panel, card, dir) {
    var cards = panelCards(panel);
    var idx = cards.indexOf(card);
    var swapWith = cards[idx + dir];
    if (!swapWith) return; // already at edge
    if (dir < 0) panel.insertBefore(card, swapWith);
    else panel.insertBefore(swapWith, card);
    persistOrder(panel);
    card.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }

  function persistOrder(panel) {
    var orders = loadOrders();
    orders[panel.id] = panelCards(panel).map(function (c) { return c.id; });
    saveOrders(orders);
  }

  // Apply a saved order to a panel (cards not in the saved list keep relative order at end).
  function applyOrder(panel) {
    var orders = loadOrders();
    var saved = orders[panel.id];
    if (!saved || !saved.length) return;
    saved.forEach(function (id) {
      var el = document.getElementById(id);
      if (el && el.parentNode === panel) panel.appendChild(el);
    });
  }

  // Restore a panel's cards to their original (markup) order and clear the saved order.
  function resetOrder(panel) {
    var cards = panelCards(panel).slice();
    cards.sort(function (a, b) {
      return (parseInt(a.getAttribute("data-rc-orig"), 10) || 0) - (parseInt(b.getAttribute("data-rc-orig"), 10) || 0);
    });
    cards.forEach(function (c) { panel.appendChild(c); });   // re-append in original order
    var orders = loadOrders();
    delete orders[panel.id];
    saveOrders(orders);
  }

  // Inject the per-tab "Rearrange" toggle at the top of each panel.
  function injectToggle(panel) {
    if (panel.querySelector(".reorder-toggle-row")) return;
    var row = document.createElement("div");
    row.className = "reorder-toggle-row";
    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "btn reorder-toggle-btn";
    btn.textContent = "\u2195 Rearrange cards";
    btn.addEventListener("click", function () {
      var on = document.body.classList.toggle("reordering");
      // Update all toggle buttons' look + label.
      document.querySelectorAll(".reorder-toggle-btn").forEach(function (b) {
        b.classList.toggle("reorder-on", on);
        b.textContent = on ? "\u2713 Done rearranging" : "\u2195 Rearrange cards";
      });
    });

    // Reset-order button — only visible while rearranging (via CSS).
    var resetBtn = document.createElement("button");
    resetBtn.type = "button";
    resetBtn.className = "btn btn-ghost reorder-reset-btn";
    resetBtn.textContent = "\u21BA Reset order";
    resetBtn.addEventListener("click", function () {
      var doReset = function () {
        resetOrder(panel);
        if (panel.firstChild !== row) panel.insertBefore(row, panel.firstChild);  // keep toggle row on top
      };
      if (typeof appConfirm === "function") {
        appConfirm("Reset this tab's cards to their original order?", { title: "Reset card order", okLabel: "Reset" })
          .then(function (ok) { if (ok) doReset(); });
      } else { doReset(); }
    });

    row.appendChild(resetBtn);
    row.appendChild(btn);
    // Insert the toggle row just before the first reorderable card, so any
    // locked leading content (like the Operate map) stays pinned at the top.
    var firstCard = panelCards(panel)[0];
    if (firstCard) panel.insertBefore(row, firstCard);
    else panel.appendChild(row);
  }

  function initCardReordering() {
    PANELS.forEach(function (pid) {
      var panel = document.getElementById(pid);
      if (!panel) return;
      ensureCardIds(panel);   // assign ids BEFORE applying saved order
      applyOrder(panel);
      injectToggle(panel);
      panelCards(panel).forEach(function (card) { buildControls(panel, card); });
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initCardReordering);
  } else {
    initCardReordering();
  }
})();


// ============================================================
// STARTUP LOGIN PROMPT
// On app open, if Google sync is configured and the user is not
// signed in, offer to sign in right away — so it doesn't have to
// be hunted for on the Setup tab. Non-blocking: "Not now" lets the
// app run offline/in the field. "Don't ask again" is remembered.
// ============================================================
(function () {
  var LS_LOGIN_OPTOUT = "dof_login_prompt_optout";

  function alreadyOptedOut() {
    try { return localStorage.getItem(LS_LOGIN_OPTOUT) === "1"; } catch (e) { return false; }
  }
  function setOptOut(v) {
    try {
      if (v) localStorage.setItem(LS_LOGIN_OPTOUT, "1");
      else localStorage.removeItem(LS_LOGIN_OPTOUT);
    } catch (e) {}
  }
  // Expose so a Setup-tab control could reset it later if desired.
  window.resetLoginPrompt = function () { setOptOut(false); };

  // Wait for Google Identity Services to finish loading (async script),
  // up to ~6s, then run cb(ready:boolean).
  function whenGisReady(cb) {
    if (typeof GoogleSync === "undefined") { cb(false); return; }
    var tries = 0, max = 30;            // 30 x 200ms = 6s
    (function poll() {
      if (GoogleSync.gisReady()) { cb(true); return; }
      if (++tries >= max) { cb(false); return; }
      setTimeout(poll, 200);
    })();
  }

  function afterSignedIn(msg) {
    if (typeof markStayLoggedIn === "function") markStayLoggedIn();
    if (typeof refreshSyncUI === "function") refreshSyncUI();
    if (typeof setSyncStatus === "function") setSyncStatus(msg || "Signed in.");
    if (typeof syncNow === "function") { Promise.resolve(syncNow()).catch(function () {}); }
  }

  function showVisiblePrompt() {
    if (alreadyOptedOut()) return;              // user asked us not to nag
    appConfirm(
      "Sign in to your Google account to automatically sync your fields, equipment, seed presets and reports across all your devices?",
      { title: "\uD83D\uDD11 Sign in to sync", okLabel: "Sign in with Google", cancelLabel: "Not now" }
    ).then(function (ok) {
      if (!ok) return;                          // "Not now" — just close for this session
      GoogleSync.signIn().then(function () {
        afterSignedIn("Signed in.");
      }).catch(function (err) {
        var m = (err && err.message) || "error";
        if (m !== "popup_closed" && m !== "access_denied") {
          appAlert("Could not sign in: " + m + "\n\nYou can sign in anytime from the Setup tab.", "Sign-in failed");
        }
      });
    });
  }

  function maybePromptLogin() {
    if (typeof GoogleSync === "undefined") return;
    if (!GoogleSync.isConfigured()) return;     // no OAuth client id -> nothing to do
    if (GoogleSync.isSignedIn()) return;        // already signed in this session

    whenGisReady(function (ready) {
      if (!ready) return;                       // offline or GIS blocked — stay quiet
      if (GoogleSync.isSignedIn()) return;      // race: signed in meanwhile

      // If the user previously chose to stay logged in, try a SILENT re-login
      // first (no popup). Only fall back to the visible prompt if that fails.
      if (typeof wantsStayLoggedIn === "function" && wantsStayLoggedIn() &&
          typeof GoogleSync.signInSilent === "function") {
        GoogleSync.signInSilent().then(function () {
          afterSignedIn("Reconnected to Google.");
        }).catch(function () {
          // Silent failed (consent/interaction needed) — show the normal prompt.
          showVisiblePrompt();
        });
        return;
      }

      // No stay-logged-in preference yet → show the visible prompt.
      showVisiblePrompt();
    });
  }

  // Run a moment after load so the sync engine + GIS have a chance to init.
  function start() { setTimeout(maybePromptLogin, 1200); }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start);
  } else {
    start();
  }
})();
