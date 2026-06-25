[README (4).md](https://github.com/user-attachments/files/29358454/README.4.md)
# 🚜 Diamond O Farms — Data Systems Pro

A precision agriculture web app built for Diamond O Farms LLC. Turn any iPhone, iPad, or browser into a full-featured field computer for spraying, planting, harvesting, tillage, and spreading — with live GPS, swath painting, multi-equipment management, complete record-keeping, and cloud sync across all your devices.

**No cab monitor required. No monthly subscription. No proprietary hardware.**

---

> **🆕 Version v2026.06.25 · 01** — added field-ready UX upgrades: haptic feedback, on-screen toast confirmations with **Undo**, hands-free **voice dictation** for notes, optional **spoken confirmations**, a peripheral **GPS-quality border**, bigger Start/Stop + live-metric text, a decluttered Operate screen (**⋯ More controls**), and a new **⚙️ Settings** panel (Tools tab) to toggle haptics and voice. See the [Changelog](#-changelog) at the bottom.

## 📸 What it does

Live GPS-driven precision ag display that runs entirely in your browser. Drive any equipment in your field, see real-time coverage painted onto a satellite map, get live metrics, save reports for every job, import field boundaries straight from Google Earth, and sync your entire setup across devices through your own Google account.

---

## ✨ Features

### 🎛️ Field-Ready UX (v2026.06.25)
- **Haptic feedback** — a short buzz confirms key taps (start session, save report, refill, etc.) so you don't have to look down. Toggle in ⚙️ Settings.
- **On-screen toasts with Undo** — quick confirmations slide up from the bottom; destructive actions (**Reset Painted Area**, **Clear Trail**) show a 6-second **UNDO**.
- **Voice dictation for notes** — tap the 🎤 in *Add Field Note* and speak; no typing in the cab.
- **Spoken confirmations** *(optional, off by default)* — hear "Session started" / "Report saved" read aloud. Toggle in ⚙️ Settings.
- **Peripheral GPS-quality border** — the screen edge glows amber/red when your fix degrades, visible from the corner of your eye.
- **Bigger primary controls** — larger, bolder **Start/Stop** and live-metric numbers for at-a-glance reading.
- **Decluttered Operate screen** — secondary map/boundary/guidance tools tuck behind a **⋯ More controls** button (your choice is remembered).
- **⚙️ Settings panel** *(Tools tab)* — turn haptics and spoken confirmations on/off.
- **Accessibility** — dynamically-created icon buttons now carry ARIA labels for VoiceOver.


### 🗺️ Live Operating Display
- **Real-time satellite map** with auto-following machine arrow
- **Swath painting** — green where you've covered, red where you've overlapped
- **Color-coded breadcrumb trail** (slow / target / fast)
- **Auto-zoom** that adjusts with your speed
- **Heading-up or North-up** map orientation
- **Auto-center toggle** — pan around freely without the map snapping back
- **Section control** — Left ½ / Full / Right ½ for partial-width passes
- **A-B straight-line guidance**

### 📊 Live Metrics (11 tiles)
- Current speed, average speed, max speed
- Acres covered, acres remaining, ETA to completion
- Acres per hour, efficiency %
- Bushels (combine) or Total GPM + Per-Nozzle GPM (sprayer)
- Live GPS accuracy in meters with color-coded quality

### 🏞️ Field Management
- **Save unlimited fields** with crop, variety, and boundary
- **Walk or drive the perimeter** to record boundary → auto-calculates acres
- **Import from Google Earth** — draw boundaries in Google Earth, save as KML or KMZ, and import them directly (auto-calculates acreage)
- **Load saved fields** instantly with full boundary recall

### 🌍 Google Earth Import (KML / KMZ)
- Draw field boundaries in **Google Earth** — far easier than tracing on a phone
- Export as **KML** or **KMZ** and import directly into the app
- **KMZ files are automatically unzipped** in the browser (no external tools)
- **Multiple fields per file** — each polygon becomes its own saved field
- **Field names pulled from your Google Earth placemarks**
- **Acreage auto-calculated** from each polygon
- **Preview before importing** — pick exactly which fields to bring in, with duplicate-overwrite warnings
- **Pins and paths are ignored** — only polygons import as fields

### 🚜 Equipment Library
Six fully-supported equipment types with type-specific parameters:

| Type | Tracked Parameters |
|---|---|
| 🚿 Sprayer | GPA, nozzle spacing, target speed, tank capacity, current product |
| 🌾 Combine | Expected yield, grain tank capacity, current moisture |
| 🚜 Planter | Row spacing, rows in use, population, variety, downforce |
| 🍂 Tillage | Working depth, pass type, implement notes |
| 🟫 Spreader | Product type, rate, bin capacity, product name |
| ❓ Other | Free-text notes for any unsupported implement |

- **Smart modal interface** auto-opens with type-specific fields when you change equipment
- **Save unlimited machines** — switch between sprayers, combines, planters in one tap
- **Live planter width calculation** — auto-suggests working width from rows × spacing
- **Sprayer GPM math** — Total GPM and per-nozzle GPM update live with speed

### 📄 Reports Library
- **Auto-save** every session with full field, equipment, and performance details
- **Searchable** — match across name, field, crop, equipment, ID
- **Filterable** by date (Today / Last 7 days / Last 30 days / This year)
- **Sortable** by date, name, or acres
- **Renameable** — give every job a meaningful name
- **Printable as PDF** with mobile-friendly back-to-app button
- **Live count display** — "Showing 3 of 47" when filters are active

### ☁️ Cloud Sync (Google Drive)
Sync your equipment, fields, and reports across every device through your own Google account — no servers, no subscriptions, no third-party storage.

- **Sign in with Google** — uses Google Identity Services (secure OAuth, no passwords stored)
- **One-tap Sync Now** — merges equipment, fields, and reports both ways
- **Private app storage** — data lives in your Drive's hidden `appDataFolder`; the app **cannot see your other Drive files**
- **Smart conflict resolution** — if the same item differs on two devices, a dialog shows you exactly what's different (field by field) and lets you choose **Keep Mine** or **Keep Cloud** per item, with "Keep all" shortcuts
- **Newest-edit-wins** by default for non-conflicting changes
- **Deletes sync correctly** — uses tombstones so a deleted machine/field/report stays deleted everywhere (and a newer re-add still wins). Tombstones auto-expire after 90 days.
- **"Last synced" timestamp** persists on each device
- **Offline-aware** — clear messaging when there's no connection; your data stays safe locally
- **Manual by design** — nothing syncs until *you* tap Sync Now
- **Photos stay local** — note photos remain on each device (they still travel inside any PDF you share)

### 💾 Backup & Sync (Manual / Offline)
- **Export all data** to a single `.json` file (includes photos)
- **Import on any device** — merge with existing or replace entirely
- **Auto-rollback** in case of accidental replace
- **Computer ⇄ phone transfer** via email or AirDrop
- **Doubles as disaster recovery** — phone dies? Restore from backup.
- Great as a belt-and-suspenders backup alongside cloud sync

### 📤 Trail Export
- Export your machine path as **KML** (Google Earth, ag software) or **GPX** (most ag software, fitness apps)
- Includes boundary polygon and timestamped track points with speed

### 📱 iPhone-Optimized PWA
- **Add to Home Screen** — launches like a native app
- **Works fully offline** — the app shell is cached by a service worker, so it loads and runs with no signal
- **Automatic update banner** — when a new version ships, a banner prompts you to refresh
- **Custom Diamond O Farms logo** as app icon
- **Wake lock** — screen stays on during active sessions
- **iOS-safe inputs** — no auto-zoom on form focus
- **Full-screen modal dialogs** for distraction-free editing
- **Touch-optimized buttons** sized for gloves

### 🛰️ GPS Quality Management
- **Accuracy filtering** — rejects fixes worse than 15 meters
- **Speed smoothing** via exponential moving average
- **Jitter rejection** — ignores micro-movements under 0.5 meters
- **Impossible-jump filter** — rejects fixes implying >60 mph delta
- **Live quality pill** shows current GPS accuracy in real-time

---

## 🚀 Getting Started

### Run it locally or host it

This is a **static web app** — no server required. You can:

1. **Host on GitHub Pages** (recommended — free)
2. **Host on Netlify, Vercel, Cloudflare Pages** (free)
3. **Open `index.html` directly** in a browser for local testing
   - *Note: cloud sync and "Add to Home Screen" require HTTPS hosting; they won't work from a local `file://` open.*

### Setup steps

1. **Clone or download** this repository
2. **Get a Google Maps API key**
   - Go to [Google Cloud Console](https://console.cloud.google.com/)
   - Enable **Maps JavaScript API** + **Geometry library**
   - Restrict the key to your domain(s)
3. **(For cloud sync) Set up Google sign-in**
   - In the same Google Cloud project, enable the **Google Drive API**
   - Create an **OAuth 2.0 Client ID** (type: Web application)
   - Add your hosting origin (e.g. `https://yourname.github.io`) to **Authorized JavaScript origins**
   - While the app is in "Testing" mode, add each user's Google address under **Test users**
4. **Create `config.js`** in the root with:
   ```javascript
   window.GOOGLE_MAPS_API_KEY = "your_maps_api_key_here";
   window.GOOGLE_OAUTH_CLIENT_ID = "your_oauth_client_id.apps.googleusercontent.com"; // optional — only needed for cloud sync
   ```
   > The OAuth Client ID is a public identifier and is safe to include. **Never** put a client *secret* here — the app doesn't use one.
5. **Commit and deploy** to your hosting platform
6. **Open the app** on any device, allow location, and you're running

### Add to iPhone home screen

1. Open the app in **Safari** on iPhone
2. Tap the **Share** button → **Add to Home Screen**
3. The Diamond O Farms logo will appear on your home screen
4. Tap it to launch full-screen, no Safari chrome

---

## 🌾 Real-world workflow

### Start of season — one-time setup
1. **Field & Equipment tab** → add each field with crop type
2. Draw field boundaries in **Google Earth** and import them (KML/KMZ), **or** walk/drive each perimeter to capture the boundary
3. Add each machine with type-specific parameters
4. **Sign in with Google** on each device and tap **Sync Now** so everything matches
5. *(Optional)* **Backup & Sync** → Export → save the file as your "season start" snapshot

### Daily use
1. Open app from home screen
2. **Field & Equipment** → load field, load equipment
3. **Operate** → tap Start Session
4. Drive — watch live coverage paint, monitor metrics
5. End of pass → tap Stop → tap Save Report
6. Repeat for next field
7. End of day → **Sync Now** to push the day's reports to your other devices

### End of day
1. **Reports tab** → review the day's jobs
2. Rename any reports for clarity
3. Print PDFs for records if needed
4. **Sync Now** (and/or **Export** for a manual snapshot)

### Adding equipment on the computer
1. On computer browser: set up the new machine in Equipment Library
2. Tap **Sync Now**
3. On your phone: tap **Sync Now** → the new machine appears
   - *(No-Google fallback: Export the `.json`, send it to your phone, and Import → Merge.)*

---

## 🛠️ Tech Stack

- **Pure HTML, CSS, JavaScript** — no frameworks, no build step
- **Google Maps JavaScript API** — satellite imagery, geometry calculations
- **HTML5 Geolocation API** — high-accuracy GPS with watchPosition
- **Google Identity Services + Google Drive API** — cloud sync via your own account (private `appDataFolder`)
- **Service Worker** — offline app-shell caching + automatic update prompts
- **localStorage** — all data persists locally on each device
- **DecompressionStream API** — in-browser KMZ (ZIP) extraction for Google Earth import
- **Wake Lock API** — keeps screen on during sessions (iOS 16.4+)

**File structure:**
```
/
├── index.html          # Main app structure
├── styles.css          # All styling
├── app.js              # Application logic
├── ux-enhancements.js  # Field-ready UX layer (haptics, toasts, voice, settings)
├── sw.js               # Service worker (offline cache + update prompts)
├── config.js           # Your API key + OAuth client ID (gitignored)
├── manifest.json       # PWA manifest
├── icon-180.png        # iPhone home-screen icon
├── icon-192.png        # Android PWA icon
├── icon-512.png        # Android splash icon
├── icon-32.png         # Browser favicon
├── icon-16.png         # Small favicon
├── favicon.ico         # Multi-size browser favicon
└── README.md           # This file
```

> **Versioning note:** Each release bumps a matching version stamp in three places — the `APP_VERSION` string in `app.js`, the `?v=` query strings in `index.html`, and the `CACHE_NAME` in `sw.js`. This trio is what forces browsers/PWAs to fetch the new files instead of serving stale cached copies, and it triggers the in-app update banner. Always deploy all three together.

---

## ⚙️ Configuration

### GPS tuning (in `app.js`)

Three constants control GPS behavior — tweak if you find the defaults too aggressive or too loose:

| Constant | Default | Effect |
|---|---|---|
| `GPS_MAX_ACCURACY_M` | 15 | Reject fixes worse than this (meters) |
| `GPS_MIN_MOVE_M` | 0.5 | Ignore micro-jitter below this (meters) |
| `SPEED_EMA_ALPHA` | 0.25 | Speed smoothing — lower = smoother, higher = more responsive |

### Coverage cell size

`CELL_SIZE_DEG` controls how finely overlap is detected. Default is ~5 meters — finer detection at higher CPU cost.

### Sync tuning (in `app.js`)

| Constant | Default | Effect |
|---|---|---|
| `TOMB_MAX_AGE_DAYS` | 90 | How long deletion records (tombstones) are kept before expiring |

---

## 🔒 Privacy

- **All data stored locally** in your browser's localStorage by default
- **Cloud sync is optional and account-private** — data goes only to *your* Google Drive's hidden app folder, which the app alone can access; it cannot read your other Drive files
- **Nothing sent to any server** except Google Maps tile requests and (if you enable sync) your own Google Drive
- **No analytics, no tracking, no ads**
- **Your reports, fields, and equipment never leave your device** unless you explicitly export or sync them
- **Photos stay on-device** and are never uploaded by cloud sync

---

## 🐛 Known limitations

- **Single-machine view only** — can't see other tractors in real-time (would require a live backend)
- **Manual sync** — sync runs when you tap **Sync Now** (by design); there's no automatic background sync
- **KMZ on older iOS** — KMZ unzipping needs the `DecompressionStream` API (iOS Safari 16.4+ / modern desktop browsers). On older devices, export from Google Earth as **KML** instead — KML works everywhere.
- **Photos don't cloud-sync** — by design, to keep the sync file small; use Export/Import or share a PDF to move photos between devices
- **GPS quality depends on phone hardware** — modern iPhones (X+) give 3-5m accuracy; older devices may be 10-15m
- **Battery drain** — continuous GPS + screen-on is hard on batteries; a 12V cab charger is recommended for full-day use
- **Google API quotas** — Maps free tier covers ~28,000 map loads per month per key; Drive API free quotas are far more than personal sync use will ever reach

---

---

## 📋 Changelog

### v2026.06.25 · 01
- **NEW:** Haptic feedback on key actions (toggle in ⚙️ Settings)
- **NEW:** Toast confirmations with **Undo** for Reset Painted Area & Clear Trail
- **NEW:** Voice dictation (🎤) for field notes
- **NEW:** Optional spoken confirmations (toggle in ⚙️ Settings)
- **NEW:** Peripheral GPS-quality border (amber/red screen edge)
- **NEW:** ⚙️ Settings panel on the Tools tab
- **IMPROVED:** Larger Start/Stop buttons and live-metric text
- **IMPROVED:** Operate screen decluttered behind a **⋯ More controls** toggle
- **IMPROVED:** ARIA labels added to dynamically-generated icon buttons
- **FIXED:** Removed leftover debug `console.log` calls
- **FIXED:** Repaired several emoji/character encodings (🎯 🌾 🔄, em-dashes, curly quotes)
- **INTERNAL:** New `ux-enhancements.js` module loads after `app.js`; each enhancement is isolated so one failure can't disable the others.

> **Deploying this release:** upload the new `ux-enhancements.js` **and** replace `index.html`, `styles.css`, `app.js`, and `sw.js`. The version trio (`APP_VERSION`, the `?v=` stamps, and `CACHE_NAME`) is already bumped to `2026.06.25-1` to trigger the in-app update banner.

---

## 📜 License

Built for Diamond O Farms LLC. All rights reserved.

---

## 🚜 Built with grit, code, and a whole lot of acres

*A precision ag platform that does what the $1000/year commercial systems do — without the subscription, without the lock-in, without the cab monitor.*
