# 🚜 Diamond O Farms — Data Systems Pro

A browser-based **precision agriculture display** built as a single-page web app.
Runs on any modern phone, tablet, or in-cab laptop. No backend required.

> Comparable feature categories to: John Deere Operations Center, Trimble, Raven, Case IH AFS.

## ✨ Features

| Category | Capability |
|---|---|
| **GPS** | Real-time tracking via `watchPosition`, satellite map, auto-centering |
| **Section Control** | LEFT ½ / FULL / RIGHT ½ with mutual exclusivity |
| **Swath Painting** | Polygon strips (not dots), green=new, red=overlap, partial-boom support |
| **Sprayer Mode** | GPA, nozzle spacing, target speed → live GPM = (GPA × MPH × W) / 495 |
| **Combine Mode** | Bushel tracking based on crop yield baselines |
| **A-B Guidance** | Set A, Set B, extended white reference line |
| **Field Boundary** | Drive perimeter → polygon → boundary acres |
| **Reports** | Save sessions, view, delete, **PDF export** |
| **Efficiency** | Coverage cells / total attempts, smoothed speed & acres/hr |
| **Equipment Library** | Save / load / delete machines (localStorage) |

## 📂 Project Structure

```text
diamond-o-farms/
├─ index.html
├─ styles.css
├─ app.js
├─ config.js          ← put your Google Maps API key here
└─ README.md
```

## 🚀 Quick Start

### 1. Clone & configure

```bash
git clone https://github.com/YOUR-USERNAME/diamond-o-farms.git
cd diamond-o-farms
```

Open `config.js` and replace `YOUR_GOOGLE_MAPS_API_KEY_HERE` with your key.
Get one at <https://console.cloud.google.com/google/maps-apis> — enable **Maps JavaScript API**.

### 2. Run locally

Just open `index.html` in a browser, **or** serve it (recommended for GPS, since HTTPS is required by most browsers):

```bash
# Python 3
python3 -m http.server 8080
# then visit http://localhost:8080
```

> ⚠️ Browsers only grant GPS over **HTTPS** or `localhost`. GitHub Pages gives you HTTPS for free.

### 3. Deploy to GitHub Pages

```bash
git init
git add .
git commit -m "Initial commit — Diamond O Farms Data Systems Pro"
git branch -M main
git remote add origin https://github.com/YOUR-USERNAME/diamond-o-farms.git
git push -u origin main
```

Then on GitHub:

1. **Settings → Pages**
2. **Source:** `Deploy from a branch`
3. **Branch:** `main` / `(root)` → Save
4. Visit `https://YOUR-USERNAME.github.io/diamond-o-farms/`

🔐 **Lock your API key down** under Google Cloud → Credentials → HTTP referrer restriction:
`https://YOUR-USERNAME.github.io/*`

## 🧭 Workflow

1. **Field & Equipment tab** — enter field info, pick machine type, set width
2. **Operate tab → Start Session** — grants GPS, begins tracking
3. **Start Boundary** → drive perimeter → **Finish Boundary**
4. Tap section buttons (LEFT ½ / FULL / RIGHT ½) for boom state
5. Drive — coverage paints in green, overlaps in red
6. **Save Report** → **Reports tab → Export PDF**

## 🛠 Tech

* Vanilla HTML / CSS / JS — zero build step
* Google Maps JavaScript API (`geometry` library for area calc)
* `localStorage` for equipment library + reports
* Polygon-based painting via `google.maps.Polygon`

## 🗺 Roadmap (Not Yet Built)

- [ ] Auto section shutoff using boundary + overlap detection
- [ ] Coverage % vs. boundary acres (real-time, not just at save)
- [ ] Guidance lock — snap path to A-B line
- [ ] Cloud sync / multi-device reports
- [ ] CSV export

## 📄 License

MIT — see `LICENSE`.
