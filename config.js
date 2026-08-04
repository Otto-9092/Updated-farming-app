// ============================================================
// Diamond O Farms — Configuration
// ============================================================
// Replace the value below with your own Google Maps JavaScript API key.
// Get one at: https://console.cloud.google.com/google/maps-apis
// Required APIs: Maps JavaScript API, (Geometry library is auto-loaded).
//
// IMPORTANT: For production, restrict your key by HTTP referrer
// (e.g. https://YOUR-GITHUB-USERNAME.github.io/*)
window.GOOGLE_MAPS_API_KEY = "AIzaSyCkhKfboH2vsdIF4p1zb6ObrWWD3Z8gqZ8";
window.GOOGLE_OAUTH_CLIENT_ID = "1097127772986-0r37oebfdo07mhsij1d1hq2oe0o7qf9h.apps.googleusercontent.com";

// ============================================================
// SINGLE SOURCE OF TRUTH FOR THE APP VERSION.
// Bump this ONE value every time you ship a change, then update the
// matching ?v= query strings (see README "Releasing a new build").
// app.js stamps this into the header label at load and warns in the
// console if index.html's hard-coded label disagrees, so a half-deploy
// can never silently show the wrong version again.
// ============================================================
window.APP_BUILD = "2026.08.02-15";        // machine form: YYYY.MM.DD-N
window.APP_VERSION_LABEL = "v2026.08.02 · 15";  // human label shown in header
