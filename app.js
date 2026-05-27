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
  sprayer: { gpa: 15, nozzle: 20, target: 12 },
  sessionStart: null,
  // Map view options
  headingUp: false,
  autoZoom: true,
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
const SMOOTH_N = 5;
const CELL_SIZE_DEG = 0.00005;
const MPS_TO_MPH = 2.23694;

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
    center: { lat: 41.5868, lng: -93.625 },
    zoom: 17,
    mapTypeId: "satellite",
    tilt: 0,
    disableDefaultUI: true,
    zoomControl: true,
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
  if (navigator.geolocation) {
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const here = { lat: pos.coords.latitude, lng: pos.coords.longitude };
        state.map.setCenter(here);
        state.map.setZoom(19);
        state.machineMarker.setPosition(here);
        setGpsPill(true);
      },
      (err) => console.warn("Initial GPS:", err),
      { enableHighAccuracy: true, timeout: 10000 }
    );
  }
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

function startSession() {
  if (!navigator.geolocation) { alert("Geolocation not supported on this device."); return; }
  readFormsIntoState();

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
function startLocationFollow() {
  if (!navigator.geolocation) return;
  navigator.geolocation.watchPosition(
    (pos) => {
      const lat = pos.coords.latitude;
      const lng = pos.coords.longitude;
      setGpsPill(true);
      if (state.machineMarker) state.machineMarker.setPosition({ lat, lng });
      if (state.map) state.map.panTo({ lat, lng });
      if (!state.running) state.lastPos = { lat, lng, ts: pos.timestamp || Date.now() };
      const mph = pos.coords.speed != null ? pos.coords.speed * MPS_TO_MPH : 0;
      if (pos.coords.heading != null && !isNaN(pos.coords.heading)) state.currentHeading = pos.coords.heading;
      applyMapView(mph);
    },
    (err) => { console.warn(err); setGpsPill(false); },
    { enableHighAccuracy: true, maximumAge: 1000, timeout: 10000 }
  );
}

// ============================================================
// GPS POSITION HANDLER (during a session)
// ============================================================
function onPos(pos) {
  setGpsPill(true);
  const lat = pos.coords.latitude;
  const lng = pos.coords.longitude;
  const ts  = pos.timestamp || Date.now();
  const heading = pos.coords.heading;
  const speedMps = pos.coords.speed;

  let mph = 0;
  if (speedMps != null && !isNaN(speedMps)) {
    mph = speedMps * MPS_TO_MPH;
  } else if (state.lastPos) {
    const dMeters = haversine(state.lastPos.lat, state.lastPos.lng, lat, lng);
    const dt = (ts - state.lastPos.ts) / 1000;
    if (dt > 0) mph = (dMeters / dt) * MPS_TO_MPH;
  }
  state.speedBuf.push(mph);
  if (state.speedBuf.length > SMOOTH_N) state.speedBuf.shift();
  const smoothMph = avg(state.speedBuf);

  state.machineMarker.setPosition({ lat, lng });
  if (heading != null && !isNaN(heading)) {
    state.currentHeading = heading;
    const icon = state.machineMarker.getIcon();
    icon.rotation = state.headingUp ? 0 : heading;
    state.machineMarker.setIcon(icon);
  }
  state.map.panTo({ lat, lng });

  applyMapView(smoothMph);
  updateMarkerColor(smoothMph);

  if (state.boundary.active) {
    state.boundary.points.push({ lat, lng });
    drawBoundaryPreview();
    state.lastPos = { lat, lng, ts };
    updateMetrics(smoothMph);
    return;
  }

  if (state.lastPos) {
    paintSwath(state.lastPos, { lat, lng }, heading);
    addTrailSegment({ lat: state.lastPos.lat, lng: state.lastPos.lng }, { lat, lng }, smoothMph);
  }
  state.trailPoints.push({ lat, lng, ts, speed: smoothMph });

  state.lastPos = { lat, lng, ts };
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
    $("spLiveGpm").textContent = gpm.toFixed(1);
    const nozzlesPerSide = Math.max(1, Math.round((state.equipment.width * 12) / state.sprayer.nozzle));
    $("spNozGpm").textContent = (gpm / nozzlesPerSide).toFixed(2);
  }
}

function applyEquipmentUI() {
  const isSprayer = state.equipment.type === "sprayer";
  $("mGalBox").classList.toggle("hidden", !isSprayer);
  $("mGpmBox").classList.toggle("hidden", !isSprayer);
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
  if (!state.lastPos) return alert("Need GPS fix first.");
  state.abLine.a = { lat: state.lastPos.lat, lng: state.lastPos.lng };
  renderAB();
});
$("btnSetB").addEventListener("click", () => {
  if (!state.lastPos) return alert("Need GPS fix first.");
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
  state.sprayer.gpa    = parseFloat($("spGPA").value) || 15;
  state.sprayer.nozzle = parseFloat($("spNoz").value) || 20;
  state.sprayer.target = parseFloat($("spTgt").value) || 12;
  applyEquipmentUI();
}
$("eqType").addEventListener("change", () => { state.equipment.type = $("eqType").value; applyEquipmentUI(); });

// ============================================================
// EQUIPMENT LIBRARY
// ============================================================
function loadEquipmentList() {
  const lib = JSON.parse(localStorage.getItem(LS_EQ) || "{}");
  const sel = $("eqLoad");
  sel.innerHTML = "";
  Object.keys(lib).forEach(k => {
    const o = document.createElement("option");
    o.value = k; o.textContent = k;
    sel.appendChild(o);
  });
}
$("btnSaveEq").addEventListener("click", () => {
  readFormsIntoState();
  const lib = JSON.parse(localStorage.getItem(LS_EQ) || "{}");
  lib[state.equipment.name] = { ...state.equipment };
  localStorage.setItem(LS_EQ, JSON.stringify(lib));
  loadEquipmentList();
  alert("Saved: " + state.equipment.name);
});
$("btnLoadEq").addEventListener("click", () => {
  const lib = JSON.parse(localStorage.getItem(LS_EQ) || "{}");
  const k = $("eqLoad").value;
  if (!k || !lib[k]) return;
  $("eqName").value = lib[k].name;
  $("eqType").value = lib[k].type;
  $("eqWidth").value = lib[k].width;
  state.equipment = { ...lib[k] };
  applyEquipmentUI();
});
$("btnDeleteEq").addEventListener("click", () => {
  const lib = JSON.parse(localStorage.getItem(LS_EQ) || "{}");
  const k = $("eqLoad").value;
  if (!k) return;
  delete lib[k];
  localStorage.setItem(LS_EQ, JSON.stringify(lib));
  loadEquipmentList();
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
  if (!name) return alert("Please enter a field name first.");
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
if ($("btnDeleteField")) $("btnDeleteField").addEventListener("click", () => {
  const lib = JSON.parse(localStorage.getItem(LS_FIELDS) || "{}");
  const k = $("fldLoad").value;
  if (!k) return;
  if (!confirm(`Delete field "${k}"?`)) return;
  delete lib[k];
  localStorage.setItem(LS_FIELDS, JSON.stringify(lib));
  loadFieldsList();
  if ($("fldStatus")) $("fldStatus").textContent = `Deleted: ${k}`;
});

// ============================================================
// RECENTER / RESET PAINTED / VIEW TOGGLES
// ============================================================
if ($("btnRecenter")) $("btnRecenter").addEventListener("click", () => {
  if (state.lastPos && state.map) {
    state.map.panTo({ lat: state.lastPos.lat, lng: state.lastPos.lng });
    state.map.setZoom(19);
  }
});

if ($("btnResetPaint")) $("btnResetPaint").addEventListener("click", () => {
  if (!confirm("Clear all painted coverage and reset acres? Boundary and trail will be kept.")) return;
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
  if (state.trailPoints.length < 2) return alert("No trail to export yet.");
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
  if (state.trailPoints.length < 2) return alert("No trail to export yet.");
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
// REPORTS
// ============================================================
$("btnSave").addEventListener("click", () => {
  const id = "REP-" + Date.now();
  const rep = {
    id, date: new Date().toISOString(),
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
  };
  const all = JSON.parse(localStorage.getItem(LS_REPS) || "{}");
  all[id] = rep;
  localStorage.setItem(LS_REPS, JSON.stringify(all));
  loadReportsList();
  alert("Report saved: " + id);
});
function loadReportsList() {
  const all = JSON.parse(localStorage.getItem(LS_REPS) || "{}");
  const sel = $("repSelect"); sel.innerHTML = "";
  Object.values(all).sort((a,b) => b.date.localeCompare(a.date)).forEach(r => {
    const o = document.createElement("option");
    o.value = r.id; o.textContent = `${r.id} — ${r.field.name} (${r.acres} ac)`;
    sel.appendChild(o);
  });
}
$("btnViewRep").addEventListener("click", () => {
  const all = JSON.parse(localStorage.getItem(LS_REPS) || "{}");
  const r = all[$("repSelect").value];
  if (!r) return;
  $("repBody").textContent = formatReport(r);
});
$("btnDeleteRep").addEventListener("click", () => {
  const all = JSON.parse(localStorage.getItem(LS_REPS) || "{}");
  delete all[$("repSelect").value];
  localStorage.setItem(LS_REPS, JSON.stringify(all));
  loadReportsList();
  $("repBody").textContent = "Select a report…";
});
$("btnPdfRep").addEventListener("click", () => {
  const all = JSON.parse(localStorage.getItem(LS_REPS) || "{}");
  const r = all[$("repSelect").value];
  if (!r) return alert("Select a report first.");
  const html = `
    <html><head><title>${r.id}</title>
    <style>body{font-family:Arial;padding:30px;color:#111}h1{margin:0 0 8px}
    h2{margin:20px 0 6px;border-bottom:1px solid #ccc;padding-bottom:4px}
    table{width:100%;border-collapse:collapse;margin-top:6px}
    td{padding:6px 8px;border-bottom:1px solid #eee}td:first-child{color:#555;width:40%}
    </style></head><body>
    <h1>🚜 Diamond O Farms — Field Report</h1>
    <div>${new Date(r.date).toLocaleString()}</div>
    <h2>Field</h2><table>
      <tr><td>Name</td><td>${r.field.name}</td></tr>
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
    <script>window.onload=()=>window.print();<\/script>
    </body></html>`;
  const w = window.open("", "_blank");
  w.document.write(html); w.document.close();
});
function formatReport(r) {
  return [
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
  ].join("\n");
}

// ============================================================
// UTILITIES
// ============================================================
function setGpsPill(ok) {
  const p = $("gpsPill");
  p.textContent = ok ? "GPS: OK" : "GPS: OFF";
  p.className = "pill " + (ok ? "pill-good" : "pill-bad");
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
// INIT
// ============================================================
window.addEventListener("DOMContentLoaded", () => {
  loadEquipmentList();
  loadReportsList();
  loadFieldsList();
  applyEquipmentUI();
  renderSectionButtons();
  startLocationFollow();
});
