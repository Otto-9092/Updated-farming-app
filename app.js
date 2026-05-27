/* ============================================================
   Diamond O Farms — Data Systems Pro
   Single-file precision ag display logic.
   ============================================================ */

// ===== State =====
const state = {
  map: null,
  machineMarker: null,
  watchId: null,
  running: false,
  lastPos: null,         // {lat,lng,ts}
  speedBuf: [],          // mph buffer
  acHrBuf: [],
  acres: 0,
  bushels: 0,
  gallons: 0,
  liveGPM: 0,
  efficiencyHits: 0,
  efficiencyAttempts: 0,
  coverageCells: new Set(),   // for overlap/efficiency
  sections: { left: false, full: true, right: false },
  abLine: { a: null, b: null, poly: null },
  boundary: { active: false, points: [], poly: null, acres: 0 },
  coveragePolys: [],          // painted polygons
    field: { name: "", crop: "Corn", variety: "" },
  equipment: { name: "", type: "sprayer", width: 90 }, // width in ft
  sprayer: { gpa: 15, nozzle: 20, target: 12 },
  sessionStart: null,
  // 🆕 Map view options
  headingUp: false,       // true = rotate map to travel direction
  autoZoom: true,         // true = zoom changes based on speed
  currentHeading: 0,      // last known heading
  lastZoom: 19,           // remembered zoom so we don't fight the user
  // 🆕 Trail + speed coloring
  // 🆕 Trail + speed coloring
  trailEnabled: true,
  trailSegments: [],      // array of google.maps.Polyline objects
  lastSpeedTier: null,    // "slow" | "ok" | "fast"
  // 🆕 Speed stats
  speedSum: 0,
  speedCount: 0,
  speedMax: 0,
    // 🆕 Raw trail points for KML/GPX export
  trailPoints: [],        // [{ lat, lng, ts, speed }, ...]
  // 🆕 Currently loaded field key (for multi-field support)
  loadedFieldKey: null,
};
// 🆕 Speed tier vs target (target comes from Sprayer tab)
function speedTier(mph) {
  const target = state.sprayer.target || 12;
  if (mph < target - 2) return "slow";
  if (mph > target + 2) return "fast";
  return "ok";
}

// 🆕 Color for marker + trail based on tier
function colorForTier(tier) {
  if (tier === "slow") return "#f1c40f"; // yellow
  if (tier === "fast") return "#e74c3c"; // red
  return "#2ecc71";                      // green = on target
}

// 🆕 Update the machine marker color to match current speed tier
function updateMarkerColor(mph) {
  const tier = speedTier(mph);
  if (tier === state.lastSpeedTier) return; // no change → skip
  state.lastSpeedTier = tier;
  if (!state.machineMarker) return;
  const icon = state.machineMarker.getIcon();
  icon.fillColor = colorForTier(tier);
  state.machineMarker.setIcon(icon);
}

// 🆕 Draw a single segment of the breadcrumb trail
function addTrailSegment(p1, p2, mph) {
  if (!state.trailEnabled || !state.map) return;
  if (!p1 || !p2) return;
  const color = colorForTier(speedTier(mph));
  const seg = new google.maps.Polyline({
    path: [p1, p2],
    strokeColor: color,
    strokeOpacity: 0.95,
    strokeWeight: 3,
    map: state.map,
    zIndex: 2,
  });
  state.trailSegments.push(seg);
}

// 🆕 Wipe the breadcrumb trail off the map
function clearTrail() {
  state.trailSegments.forEach(s => s.setMap(null));
  state.trailSegments = [];
  // 🆕 Also clear raw points
  state.trailPoints = [];
}
// ===== Constants =====
const FT_PER_METER = 3.28084;
const SQFT_PER_ACRE = 43560;
const SMOOTH_N = 5;
const CELL_SIZE_DEG = 0.00005; // ~5.5m grid for efficiency
const MPS_TO_MPH = 2.23694;

// 🆕 Format hours as "1h 23m" or "12m"
function formatETA(hours) {
  if (!isFinite(hours) || hours <= 0) return "—";
  const totalMin = Math.round(hours * 60);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h === 0) return `${m}m`;
  return `${h}h ${m}m`;
}

// 🆕 iOS Screen Wake Lock — keep display on during a session
let wakeLockRef = null;
async function requestWakeLock() {
  try {
    if ("wakeLock" in navigator) {
      wakeLockRef = await navigator.wakeLock.request("screen");
    }
  } catch (e) { console.warn("Wake lock failed:", e); }
}
function releaseWakeLock() {
  if (wakeLockRef) { wakeLockRef.release().catch(()=>{}); wakeLockRef = null; }
}
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && state.running) requestWakeLock();
});

// ===== DOM helpers =====
const $ = (id) => document.getElementById(id);

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
// MAP INIT (called by Google Maps loader)
// ============================================================
function initMap() {
  state.map = new google.maps.Map($("map"), {
    center: { lat: 41.5868, lng: -93.625 }, // temporary default
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

  // 🆕 Snap to user's current location ASAP
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

// ============================================================
// SECTION CONTROL — LEFT ½ / FULL / RIGHT ½
// Mutual exclusivity:
//   - FULL overrides halves
//   - LEFT/RIGHT disable FULL
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
    if (state.sections.left || state.sections.right) {
      state.sections.full = false;
    }
    // If both halves off and full off → default to full on
    if (!state.sections.left && !state.sections.right && !state.sections.full) {
      state.sections.full = true;
    }
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
// GPS — start/stop session
// ============================================================
$("btnStart").addEventListener("click", startSession);
$("btnStop").addEventListener("click", stopSession);
$("btnRecenter").addEventListener("click", () => {
  if (state.lastPos && state.map) {
    state.map.panTo({ lat: state.lastPos.lat, lng: state.lastPos.lng });
    state.map.setZoom(19);
  }
});
// 🆕 Reset painted area (clears coverage but keeps GPS/trail/boundary)
$("btnResetPaint").addEventListener("click", () => {
  if (!confirm("Clear all painted coverage and reset acres? Boundary and trail will be kept.")) return;
  state.coveragePolys.forEach(p => p.setMap(null));
  state.coveragePolys = [];
  state.coverageCells.clear();
  state.acres = 0;
  state.bushels = 0;
  state.gallons = 0;
  state.efficiencyHits = 0;
  state.efficiencyAttempts = 0;
  // Refresh metrics
  $
// 🆕 North-Up / Heading-Up toggle
$("btnOrient").addEventListener("click", () => {
  state.headingUp = !state.headingUp;
  const btn = $("btnOrient");
  if (state.headingUp) {
    btn.textContent = "🧭 Heading-Up";
    btn.classList.add("active-toggle");
  } else {
    btn.textContent = "🧭 North-Up";
    btn.classList.remove("active-toggle");
    // Reset rotation to north
    if (state.map) state.map.setHeading(0);
  }
});

// 🆕 Auto-Zoom toggle
$("btnAutoZoom").addEventListener("click", () => {
  state.autoZoom = !state.autoZoom;
  const btn = $("btnAutoZoom");
  btn.textContent = state.autoZoom ? "🔍 Auto-Zoom: ON" : "🔍 Auto-Zoom: OFF";
  btn.classList.toggle("active-toggle", state.autoZoom);
});
// 🆕 Trail on/off
$("btnTrail").addEventListener("click", () => {
  state.trailEnabled = !state.trailEnabled;
  const btn = $("btnTrail");
  btn.textContent = state.trailEnabled ? "📍 Trail: ON" : "📍 Trail: OFF";
  btn.classList.toggle("active-toggle", state.trailEnabled);
  // If turning off, optionally hide existing segments (keep them in memory)
  state.trailSegments.forEach(s => s.setMap(state.trailEnabled ? state.map : null));
});

// 🆕 Clear trail button
$("btnClearTrail").addEventListener("click", clearTrail);
// 🆕 Export KML (Google Earth)
$("btnExportKML").addEventListener("click", () => {
  if (state.trailPoints.length < 2) return alert("No trail to export yet.");
  const fieldName = (state.field.name || "field").replace(/[^a-z0-9]+/gi, "_");
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const coords = state.trailPoints
    .map(p => `${p.lng.toFixed(7)},${p.lat.toFixed(7)},0`)
    .join(" ");
  const kml = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
    <name>Diamond O Farms — ${state.field.name || "Trail"}</name>
    <description>Exported ${new Date().toLocaleString()}</description>
    <Style id="trail">
      <LineStyle><color>ff00b7ff</color><width>3</width></LineStyle>
    </Style>
    <Placemark>
      <name>Machine Path</name>
      <styleUrl>#trail</styleUrl>
      <LineString>
        <tessellate>1</tessellate>
        <coordinates>${coords}</coordinates>
      </LineString>
    </Placemark>${boundaryKML()}
  </Document>
</kml>`;
  downloadFile(`DiamondO_${fieldName}_${ts}.kml`, kml, "application/vnd.google-earth.kml+xml");
});

// 🆕 Export GPX (standard GPS track format)
$("btnExportGPX").addEventListener("click", () => {
  if (state.trailPoints.length < 2) return alert("No trail to export yet.");
  const fieldName = (state.field.name || "field").replace(/[^a-z0-9]+/gi, "_");
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const points = state.trailPoints.map(p => {
    const t = new Date(p.ts).toISOString();
    // GPX speed is in m/s
    const mps = (p.speed / MPS_TO_MPH).toFixed(2);
    return `      <trkpt lat="${p.lat.toFixed(7)}" lon="${p.lng.toFixed(7)}">
        <time>${t}</time>
        <speed>${mps}</speed>
      </trkpt>`;
  }).join("\n");
  const gpx = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Diamond O Farms Data Systems Pro"
     xmlns="http://www.topografix.com/GPX/1/1">
  <metadata>
    <name>${state.field.name || "Trail"}</name>
    <time>${new Date().toISOString()}</time>
  </metadata>
  <trk>
    <name>${state.equipment.name || "Machine"} — ${state.field.name || "Field"}</name>
    <trkseg>
${points}
    </trkseg>
  </trk>
</gpx>`;
  downloadFile(`DiamondO_${fieldName}_${ts}.gpx`, gpx, "application/gpx+xml");
});

// 🆕 Include boundary polygon in KML if it exists
function boundaryKML() {
  if (!state.boundary.points || state.boundary.points.length < 3) return "";
  const ring = state.boundary.points
    .concat([state.boundary.points[0]]) // close ring
    .map(p => `${p.lng.toFixed(7)},${p.lat.toFixed(7)},0`)
    .join(" ");
  return `
    <Placemark>
      <name>Field Boundary</name>
      <Style>
        <LineStyle><color>ff03b7ff</color><width>3</width></LineStyle>
        <PolyStyle><color>3303b7ff</color></PolyStyle>
      </Style>
      <Polygon><outerBoundaryIs><LinearRing>
        <coordinates>${ring}</coordinates>
      </LinearRing></outerBoundaryIs></Polygon>
    </Placemark>`;
}

// 🆕 Generic browser file download helper
function downloadFile(filename, content, mime) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
// 🆕 Calculate ideal zoom based on speed (mph)
// Slow/stopped → close in. Fast → zoom out to see ahead.
function zoomForSpeed(mph) {
  if (mph < 1)   return 20;   // stopped
  if (mph < 4)   return 19;   // crawl / turning
  if (mph < 8)   return 18;   // working speed
  if (mph < 14)  return 17;   // typical spray speed
  if (mph < 20)  return 16;   // road / fast transit
  return 15;                  // highway
}

// 🆕 Apply zoom + rotation based on current speed/heading
function applyMapView(mph) {
  if (!state.map) return;

  // Auto-zoom
  if (state.autoZoom) {
    const target = zoomForSpeed(mph);
    if (target !== state.lastZoom) {
      state.map.setZoom(target);
      state.lastZoom = target;
    }
  }

  // Heading-up rotation
  if (state.headingUp && state.currentHeading != null && !isNaN(state.currentHeading)) {
    // Map rotation is "what's at the top" — to put heading at top, negate it
    state.map.setHeading(state.currentHeading);
  }
}

function startSession() {
  if (!navigator.geolocation) { alert("Geolocation not supported on this device."); return; }
  // Pull current field/equipment/sprayer settings
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

  // 🆕 Fresh trail per session
  clearTrail();
  state.lastSpeedTier = null;

  // 🆕 Reset speed stats + trail points
  state.speedSum = 0;
  state.speedCount = 0;
  state.speedMax = 0;
  state.trailPoints = [];
  $("mAvgSpeed").textContent = "0.0";
  $("mMaxSpeed").textContent = "0.0";
  $("mAcresLeft").textContent = "—";
  $("btnStart").disabled = true;
  $("btnStop").disabled  = false;
  setMode("RUNNING");

    state.watchId = navigator.geolocation.watchPosition(
    onPos,
    (err) => { console.warn(err); setGpsPill(false); },
    { enableHighAccuracy: true, maximumAge: 500, timeout: 10000 }
  );

  requestWakeLock(); // 🆕 keep iPhone/iPad screen on during session
}

function stopSession() {
  state.running = false;
  if (state.watchId != null) navigator.geolocation.clearWatch(state.watchId);
  state.watchId = null;
  $("btnStart").disabled = false;
  $("btnStop").disabled  = true;
  setMode("IDLE");
  releaseWakeLock();  // 🆕 release iOS screen lock
}

// ============================================================
// GPS — position handler
// ============================================================
function onPos(pos) {
  setGpsPill(true);
  const lat = pos.coords.latitude;
  const lng = pos.coords.longitude;
  const ts  = pos.timestamp || Date.now();
  const heading = pos.coords.heading; // may be null
  const speedMps = pos.coords.speed;  // may be null

  // Smooth speed
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

  // Update marker
  state.machineMarker.setPosition({ lat, lng });
  if (heading != null && !isNaN(heading)) {
    state.currentHeading = heading;
    const icon = state.machineMarker.getIcon();
    // In heading-up mode the map rotates, so the arrow icon stays "up"
    icon.rotation = state.headingUp ? 0 : heading;
    state.machineMarker.setIcon(icon);
  }
  state.map.panTo({ lat, lng });

  // 🆕 Apply auto-zoom + heading-up
  applyMapView(smoothMph);

  // 🆕 Speed-based marker color
  updateMarkerColor(smoothMph);

  // 🆕 Draw breadcrumb trail segment (skip while in boundary mode)
  // 🆕 Draw breadcrumb trail segment (skip while in boundary mode)
  if (!state.boundary.active && state.lastPos) {
    addTrailSegment(
      { lat: state.lastPos.lat, lng: state.lastPos.lng },
      { lat, lng },
      smoothMph
    );
  }

  // 🆕 Record raw point for KML/GPX export
  if (!state.boundary.active) {
    state.trailPoints.push({ lat, lng, ts, speed: smoothMph });
  }
  // Boundary mode → store only, no painting
  if (state.boundary.active) {
    state.boundary.points.push({ lat, lng });
    drawBoundaryPreview();
    state.lastPos = { lat, lng, ts };
    updateMetrics(smoothMph);
    return;
  }

  // Paint coverage between last and current
  if (state.lastPos) {
    paintSwath(state.lastPos, { lat, lng }, heading);
  }

  state.lastPos = { lat, lng, ts };
  updateMetrics(smoothMph);
}

// ============================================================
// SWATH PAINTING — polygon strips (not circles)
// Handles FULL, LEFT ½, RIGHT ½ independently
// ============================================================
function paintSwath(p1, p2, headingDeg) {
  const widthFt = state.equipment.width;
  const widthM  = widthFt / FT_PER_METER;

  // Bearing from p1 -> p2 if heading missing
  const bearing = (headingDeg != null && !isNaN(headingDeg))
    ? headingDeg
    : bearingDeg(p1.lat, p1.lng, p2.lat, p2.lng);

  // Perpendicular bearings
  const left  = (bearing - 90 + 360) % 360;
  const right = (bearing + 90) % 360;

  const halfFull = widthM / 2;
  const halfHalf = widthM / 4; // each "half" boom covers half the full width

  let painted = false;

  if (state.sections.full) {
    const poly = stripPolygon(p1, p2, left, right, halfFull, halfFull);
    drawCoveragePolygon(poly, p1, p2, widthM);
    painted = true;
  } else {
    if (state.sections.left) {
      // Left half: from centerline out to left by full half-width
      const poly = stripPolygon(p1, p2, left, right, halfFull, 0);
      drawCoveragePolygon(poly, p1, p2, halfFull); // half acreage
      painted = true;
    }
    if (state.sections.right) {
      const poly = stripPolygon(p1, p2, left, right, 0, halfFull);
      drawCoveragePolygon(poly, p1, p2, halfFull);
      painted = true;
    }
  }

  if (painted) {
    state.efficiencyAttempts++;
  }
}

// Build a 4-corner polygon for a swath segment
function stripPolygon(p1, p2, leftBearing, rightBearing, leftMeters, rightMeters) {
  const a = offsetMeters(p1.lat, p1.lng, leftBearing,  leftMeters);
  const b = offsetMeters(p2.lat, p2.lng, leftBearing,  leftMeters);
  const c = offsetMeters(p2.lat, p2.lng, rightBearing, rightMeters);
  const d = offsetMeters(p1.lat, p1.lng, rightBearing, rightMeters);
  return [a, b, c, d];
}

function drawCoveragePolygon(path, p1, p2, swathWidthM) {
  // Determine overlap via grid cells
  const key = cellKey((p1.lat + p2.lat)/2, (p1.lng + p2.lng)/2);
  const isOverlap = state.coverageCells.has(key);
  if (!isOverlap) {
    state.coverageCells.add(key);
    state.efficiencyHits++;
  }
  const color = isOverlap ? "#e74c3c" : "#2ecc71";

  const poly = new google.maps.Polygon({
    paths: path,
    strokeWeight: 0,
    fillColor: color,
    fillOpacity: 0.55,
    map: state.map,
    zIndex: 1,
  });
  state.coveragePolys.push(poly);

  // Accumulate acres + product
  const segMeters = haversine(p1.lat, p1.lng, p2.lat, p2.lng);
  const areaSqFt = (segMeters * FT_PER_METER) * (swathWidthM * FT_PER_METER);
  const acresDelta = areaSqFt / SQFT_PER_ACRE;
  if (!isOverlap) {
    state.acres += acresDelta;
    if (state.equipment.type === "sprayer") {
      state.gallons += acresDelta * state.sprayer.gpa;
    } else if (state.equipment.type === "combine") {
      // simple yield placeholder: 180 bu/ac corn baseline
      const baseYield = state.field.crop === "Soybeans" ? 55
                     : state.field.crop === "Wheat"    ? 70
                     : 180;
      state.bushels += acresDelta * baseYield;
    }
  }
}

// ============================================================
// METRICS UPDATE
// ============================================================
function updateMetrics(mph) {
  $("mSpeed").textContent = mph.toFixed(1);
  $("mAcres").textContent = state.acres.toFixed(2);

  // 🆕 Speed average / max (only count meaningful movement: > 0.5 mph)
  if (mph > 0.5) {
    state.speedSum += mph;
    state.speedCount += 1;
    if (mph > state.speedMax) state.speedMax = mph;
  }
  const avgSpeed = state.speedCount > 0 ? state.speedSum / state.speedCount : 0;
  $("mAvgSpeed").textContent = avgSpeed.toFixed(1);
  $("mMaxSpeed").textContent = state.speedMax.toFixed(1);

   // 🆕 Acres remaining = boundary acres − covered acres
  let acresLeft = null;
  if (state.boundary.acres > 0) {
    acresLeft = Math.max(0, state.boundary.acres - state.acres);
    $("mAcresLeft").textContent = acresLeft.toFixed(2);
  } else {
    $("mAcresLeft").textContent = "—";
  }

  // 🆕 ETA = Acres Left / Acres per Hour
  const smoothedAcHr = avg(state.acHrBuf);
  if (acresLeft != null && smoothedAcHr > 0.1) {
    const etaHours = acresLeft / smoothedAcHr;
    $("mETA").textContent = formatETA(etaHours);
  } else {
    $("mETA").textContent = "—";
  }

  const elapsedHr = (Date.now() - state.sessionStart) / 3600000;
  const ahr = elapsedHr > 0 ? state.acres / elapsedHr : 0;
  state.acHrBuf.push(ahr);
  if (state.acHrBuf.length > SMOOTH_N) state.acHrBuf.shift();
  $("mAcHr").textContent = avg(state.acHrBuf).toFixed(1);

  const eff = state.efficiencyAttempts > 0
    ? Math.round((state.efficiencyHits / state.efficiencyAttempts) * 100)
    : 0;
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
// ============================================================
// EQUIPMENT MODE — show/hide bushel vs gallon
// ============================================================
function applyEquipmentUI() {
  const isSprayer = state.equipment.type === "sprayer";
  $("mGalBox").classList.toggle("hidden", !isSprayer);
  $("mGpmBox").classList.toggle("hidden", !isSprayer);
  $("mBuBox").classList.toggle("hidden",   isSprayer);
}

// ============================================================
// BOUNDARY MODE
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
    strokeColor: "#ffb703",
    strokeWeight: 3,
    map: state.map,
  });
}
function drawBoundaryFinal() {
  if (state.boundary.points.length < 3) return;
  if (state.boundary.poly) state.boundary.poly.setMap(null);
  state.boundary.poly = new google.maps.Polygon({
    paths: state.boundary.points,
    strokeColor: "#ffb703", strokeWeight: 3,
    fillColor: "#ffb703", fillOpacity: 0.08,
    map: state.map,
  });
  // Acres via google.maps.geometry
  const areaM2 = google.maps.geometry.spherical.computeArea(state.boundary.poly.getPath());
  const acres = (areaM2 * 10.7639) / SQFT_PER_ACRE;
  state.boundary.acres = acres;
  $("boundAcres").textContent = acres.toFixed(2);
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
    // Extend the line well past A and B
    const ext = extendLine(state.abLine.a, state.abLine.b, 2000);
    state.abLine.poly = new google.maps.Polyline({
      path: ext, strokeColor: "#ffffff", strokeWeight: 2,
      strokeOpacity: 0.9, map: state.map,
    });
  }
}

// ============================================================
// FORMS — Field / Equipment / Sprayer
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

// Equipment library (localStorage)
const LS_EQ   = "dof_equipment_library";
const LS_REPS = "dof_reports";

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
// REPORTS
// ============================================================
$("btnSave").addEventListener("click", () => {
  const id = "REP-" + Date.now();
  const rep = {
    id,
    date: new Date().toISOString(),
    field: { ...state.field },
    equipment: { ...state.equipment },
    sprayer: { ...state.sprayer },
    acres: +state.acres.toFixed(2),
    bushels: Math.round(state.bushels),
    gallons: +state.gallons.toFixed(1),
    boundaryAcres: +state.boundary.acres.toFixed(2),
    coverage: state.boundary.acres > 0
      ? +((state.acres / state.boundary.acres) * 100).toFixed(1)
      : null,
  };
  const all = JSON.parse(localStorage.getItem(LS_REPS) || "{}");
  all[id] = rep;
  localStorage.setItem(LS_REPS, JSON.stringify(all));
  loadReportsList();
  alert("Report saved: " + id);
});

function loadReportsList() {
  const all = JSON.parse(localStorage.getItem(LS_REPS) || "{}");
  const sel = $("repSelect");
  sel.innerHTML = "";
  Object.values(all)
    .sort((a,b) => b.date.localeCompare(a.date))
    .forEach(r => {
      const o = document.createElement("option");
      o.value = r.id;
      o.textContent = `${r.id} — ${r.field.name} (${r.acres} ac)`;
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
    <style>
      body{font-family:Arial,sans-serif;padding:30px;color:#111}
      h1{margin:0 0 8px}
      h2{margin:20px 0 6px;border-bottom:1px solid #ccc;padding-bottom:4px}
      table{width:100%;border-collapse:collapse;margin-top:6px}
      td{padding:6px 8px;border-bottom:1px solid #eee}
      td:first-child{color:#555;width:40%}
    </style></head><body>
    <h1>🚜 Diamond O Farms — Field Report</h1>
    <div>${new Date(r.date).toLocaleString()}</div>

    <h2>Field</h2>
    <table>
      <tr><td>Name</td><td>${r.field.name}</td></tr>
      <tr><td>Crop</td><td>${r.field.crop}</td></tr>
      <tr><td>Variety</td><td>${r.field.variety || "—"}</td></tr>
      <tr><td>Boundary Acres</td><td>${r.boundaryAcres}</td></tr>
    </table>

    <h2>Equipment</h2>
    <table>
      <tr><td>Machine</td><td>${r.equipment.name}</td></tr>
      <tr><td>Type</td><td>${r.equipment.type}</td></tr>
      <tr><td>Width</td><td>${r.equipment.width} ft</td></tr>
    </table>

    <h2>Results</h2>
    <table>
      <tr><td>Acres Covered</td><td>${r.acres}</td></tr>
      <tr><td>Coverage %</td><td>${r.coverage != null ? r.coverage + "%" : "—"}</td></tr>
      <tr><td>Bushels</td><td>${r.bushels}</td></tr>
      <tr><td>Gallons</td><td>${r.gallons}</td></tr>
    </table>

    ${r.equipment.type === "sprayer" ? `
    <h2>Sprayer</h2>
    <table>
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
    `Bushels:   ${r.bushels}`,
    `Gallons:   ${r.gallons}`,
  ].join("\n");
}

// ============================================================
// UTILITY — geo math + UI helpers
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
  const R = 6371000;
  const toRad = (d) => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1), dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat/2)**2 +
            Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
            Math.sin(dLng/2)**2;
  return 2 * R * Math.asin(Math.sqrt(a));
}
function bearingDeg(lat1, lng1, lat2, lng2) {
  const toRad = (d) => d * Math.PI / 180;
  const toDeg = (r) => r * 180 / Math.PI;
  const y = Math.sin(toRad(lng2-lng1)) * Math.cos(toRad(lat2));
  const x = Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) -
            Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(toRad(lng2-lng1));
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}
// Offset a lat/lng by distance (meters) in a bearing
function offsetMeters(lat, lng, bearing, meters) {
  const R = 6371000;
  const br = bearing * Math.PI/180;
  const latR = lat * Math.PI/180, lngR = lng * Math.PI/180;
  const dR = meters / R;
  const lat2 = Math.asin(Math.sin(latR)*Math.cos(dR) +
                Math.cos(latR)*Math.sin(dR)*Math.cos(br));
  const lng2 = lngR + Math.atan2(Math.sin(br)*Math.sin(dR)*Math.cos(latR),
                Math.cos(dR)-Math.sin(latR)*Math.sin(lat2));
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
  applyEquipmentUI();
  renderSectionButtons();
  startLocationFollow();   // 🆕 start following GPS right away
});

// 🆕 Follow user location even when not in a session
function startLocationFollow() {
  if (!navigator.geolocation) return;
  navigator.geolocation.watchPosition(
    (pos) => {
      const lat = pos.coords.latitude;
      const lng = pos.coords.longitude;
      setGpsPill(true);
           // Always move marker + recenter map on user
      if (state.machineMarker) {
        state.machineMarker.setPosition({ lat, lng });
      }
      if (state.map) {
        state.map.panTo({ lat, lng });
      }
      // 🆕 Apply zoom/rotation even when not in a session
      const mph = pos.coords.speed != null ? pos.coords.speed * MPS_TO_MPH : 0;
      if (pos.coords.heading != null && !isNaN(pos.coords.heading)) {
        state.currentHeading = pos.coords.heading;
      }
      applyMapView(mph);
      // If a session isn't running, still update lastPos so A-B works
      if (!state.running) {
        state.lastPos = { lat, lng, ts: pos.timestamp || Date.now() };
      }
    },
    (err) => { console.warn(err); setGpsPill(false); },
    { enableHighAccuracy: true, maximumAge: 1000, timeout: 10000 }
  );
}
