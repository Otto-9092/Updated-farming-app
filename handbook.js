// ============================================================
// OπO Farming — HANDBOOK TAB (opio-field-guide integration)
// ------------------------------------------------------------
// Fetches markdown sections from the opio-field-guide GitHub repo
// and renders them into the Handbook tab. Fully additive: no changes
// to app.js, no changes to state, no changes to existing tabs.
//
// Depends on:
//   • marked.js (loaded from CDN inside this module, on demand)
//   • sessionStorage for in-session caching
//   • the service worker for offline caching (see sw.js)
//
// Section list matches the file structure in:
//   https://github.com/Otto-9092/opio-field-guide/tree/main/sections
// ============================================================
(function () {
  "use strict";

  // ----------------------------------------------------------
  // CONFIG
  // ----------------------------------------------------------
  var HANDBOOK_BASE = "https://raw.githubusercontent.com/Otto-9092/opio-field-guide/main/sections/";
  var MARKED_CDN = "https://cdn.jsdelivr.net/npm/marked@12.0.0/marked.min.js";

  // Section list. Order matches the field-workflow organization in the repo.
  var SECTIONS = [
    { id: "01", title: "Operation Overview",               file: "01-operation-overview.md",  group: "Foundation" },
    { id: "02", title: "Tillage Strategy",                 file: "02-tillage-strategy.md",    group: "Tillage" },
    { id: "03", title: "Tandem Disc Buyer's Guide",        file: "03-tandem-disc.md",         group: "Tillage" },
    { id: "04", title: "Field Cultivator & Finishing",     file: "04-field-cultivator.md",    group: "Tillage" },
    { id: "05", title: "JD 7000 Planter",                  file: "05-jd-7000-planter.md",     group: "Planting" },
    { id: "06", title: "JD 8300 Drill",                    file: "06-jd-8300-drill.md",       group: "Planting" },
    { id: "07", title: "Sprayer",                          file: "07-sprayer.md",             group: "In-Season" },
    { id: "08", title: "Corn Production",                  file: "08-corn-production.md",     group: "In-Season" },
    { id: "09", title: "Winter Wheat Production",          file: "09-winter-wheat.md",        group: "In-Season" },
    { id: "10", title: "IH 1480 Combine",                  file: "10-ih-1480.md",             group: "Harvest" },
    { id: "11", title: "Headers (IH 1010 & IH 963)",       file: "11-headers.md",             group: "Harvest" },
    { id: "12", title: "Grain Handling & Storage",         file: "12-grain-handling.md",      group: "Harvest" },
    { id: "13", title: "Hay Equipment",                    file: "13-hay-equipment.md",       group: "Post-Harvest" },
    { id: "14", title: "Farm Business, Budgets & ROI",     file: "14-farm-business.md",       group: "Post-Harvest" },
    { id: "15", title: "Farm Calendar",                    file: "15-calendar.md",            group: "Post-Harvest" },
    { id: "16", title: "Lubrication & Maintenance",        file: "16-lube-maintenance.md",    group: "Post-Harvest" },
    { id: "17", title: "Auction Strategy",                 file: "17-auctions.md",            group: "Post-Harvest" },
    { id: "18", title: "Parts to Keep on the Shelf",       file: "18-parts-shelf.md",         group: "Post-Harvest" },
    { id: "19", title: "Field Records & 5-Year Trends",    file: "19-field-records.md",       group: "Post-Harvest" },
    { id: "20", title: "Buy-It-Once Equipment",            file: "20-buy-it-once.md",         group: "Post-Harvest" }
  ];

  var GROUP_ORDER = ["Foundation", "Tillage", "Planting", "In-Season", "Harvest", "Post-Harvest"];

  // ----------------------------------------------------------
  // STATE (module-local, does NOT touch app.js state object)
  // ----------------------------------------------------------
  var hbState = {
    markedReady: false,
    currentSectionId: null,
    memCache: {}   // { fileId: htmlString }
  };

  // ----------------------------------------------------------
  // UTILITIES
  // ----------------------------------------------------------
  function byId(id) { return document.getElementById(id); }

  function loadMarkedIfNeeded(cb) {
    if (hbState.markedReady && window.marked) return cb();
    if (window.marked) { hbState.markedReady = true; return cb(); }
    var s = document.createElement("script");
    s.src = MARKED_CDN;
    s.async = true;
    s.onload = function () {
      hbState.markedReady = true;
      // Configure marked once loaded
      if (window.marked && window.marked.setOptions) {
        window.marked.setOptions({
          breaks: false,
          gfm: true
        });
      }
      cb();
    };
    s.onerror = function () {
      cb(new Error("Could not load markdown renderer. Check your network."));
    };
    document.head.appendChild(s);
  }

  function sessionKey(sectionId) { return "handbook_" + sectionId; }

  function getCached(sectionId) {
    if (hbState.memCache[sectionId]) return hbState.memCache[sectionId];
    try {
      var stored = sessionStorage.getItem(sessionKey(sectionId));
      if (stored) {
        hbState.memCache[sectionId] = stored;
        return stored;
      }
    } catch (e) { /* sessionStorage disabled, ignore */ }
    return null;
  }

  function setCached(sectionId, html) {
    hbState.memCache[sectionId] = html;
    try {
      sessionStorage.setItem(sessionKey(sectionId), html);
    } catch (e) { /* quota exceeded or disabled, ignore */ }
  }

  // Rewrite internal cross-references. In the source markdown, files link
  // to each other like [Section 6](06-jd-8300-drill.md) — we intercept
  // those clicks and switch sections in the app instead of navigating.
  function rewriteInternalLinks(container) {
    var links = container.querySelectorAll("a");
    for (var i = 0; i < links.length; i++) {
      var a = links[i];
      var href = a.getAttribute("href") || "";

      // Handle references to other sections/*.md files or plain NN-slug.md links
      var m = href.match(/^(?:sections\/)?(\d{2})-[^/]+\.md(#.*)?$/);
      if (m) {
        var targetId = m[1];
        a.setAttribute("href", "#");
        a.setAttribute("data-handbook-jump", targetId);
        a.addEventListener("click", function (ev) {
          ev.preventDefault();
          var target = this.getAttribute("data-handbook-jump");
          showSection(target);
        });
        continue;
      }

      // Handle relative README references — bounce to TOC
      if (href === "../README.md" || href === "README.md") {
        a.setAttribute("href", "#");
        a.addEventListener("click", function (ev) {
          ev.preventDefault();
          showTOC();
        });
        continue;
      }

      // External links (http/https) — open in new tab for safety
      if (/^https?:\/\//i.test(href)) {
        a.setAttribute("target", "_blank");
        a.setAttribute("rel", "noopener noreferrer");
      }
    }
  }

  // ----------------------------------------------------------
  // FETCH + RENDER
  // ----------------------------------------------------------
  function fetchSection(section, cb) {
    var url = HANDBOOK_BASE + section.file;
    fetch(url, { cache: "default" })
      .then(function (res) {
        if (!res.ok) throw new Error("HTTP " + res.status);
        return res.text();
      })
      .then(function (md) {
        loadMarkedIfNeeded(function (err) {
          if (err) return cb(err);
          try {
            var html = window.marked.parse(md);
            cb(null, html);
          } catch (e) {
            cb(e);
          }
        });
      })
      .catch(function (err) {
        cb(err);
      });
  }

  function showSection(sectionId) {
    hbState.currentSectionId = sectionId;
    var section = SECTIONS.find(function (s) { return s.id === sectionId; });
    if (!section) return showTOC();

    var reader = byId("hbReader");
    var toc = byId("hbTOC");
    if (!reader || !toc) return;

    toc.style.display = "none";
    reader.style.display = "block";

    var content = byId("hbContent");
    var titleEl = byId("hbCurrentTitle");
    titleEl.textContent = "Section " + section.id + ": " + section.title;

    var cached = getCached(section.id);
    if (cached) {
      content.innerHTML = cached;
      rewriteInternalLinks(content);
      reader.scrollTop = 0;
      updatePrevNext(section.id);
      return;
    }

    content.innerHTML = '<div class="hb-loading">Loading section ' + section.id + "&hellip;</div>";

    fetchSection(section, function (err, html) {
      if (hbState.currentSectionId !== section.id) return; // user switched sections mid-load
      if (err) {
        content.innerHTML = '<div class="hb-error">' +
          '<h3>Could not load this section</h3>' +
          '<p>The app tried to fetch:</p>' +
          '<p><code>' + HANDBOOK_BASE + section.file + '</code></p>' +
          '<p><strong>Reason:</strong> ' + (err.message || String(err)) + '</p>' +
          '<p>This usually means one of:</p>' +
          '<ul>' +
            '<li>No internet connection (and this section hasn\'t been viewed before)</li>' +
            '<li>The <code>opio-field-guide</code> repo is private or moved</li>' +
            '<li>Your network is blocking <code>raw.githubusercontent.com</code></li>' +
          '</ul>' +
          '<p>Once you view a section over the network, it stays cached and works offline.</p>' +
          '</div>';
        return;
      }
      setCached(section.id, html);
      content.innerHTML = html;
      rewriteInternalLinks(content);
      reader.scrollTop = 0;
      updatePrevNext(section.id);
    });
  }

  function updatePrevNext(sectionId) {
    var idx = SECTIONS.findIndex(function (s) { return s.id === sectionId; });
    var prevBtn = byId("hbPrev");
    var nextBtn = byId("hbNext");
    if (prevBtn) {
      if (idx > 0) {
        prevBtn.style.visibility = "visible";
        var prev = SECTIONS[idx - 1];
        prevBtn.textContent = "← " + prev.id + ". " + prev.title;
        prevBtn.onclick = function () { showSection(prev.id); };
      } else {
        prevBtn.style.visibility = "hidden";
      }
    }
    if (nextBtn) {
      if (idx < SECTIONS.length - 1) {
        nextBtn.style.visibility = "visible";
        var next = SECTIONS[idx + 1];
        nextBtn.textContent = next.id + ". " + next.title + " →";
        nextBtn.onclick = function () { showSection(next.id); };
      } else {
        nextBtn.style.visibility = "hidden";
      }
    }
  }

  function showTOC() {
    hbState.currentSectionId = null;
    var reader = byId("hbReader");
    var toc = byId("hbTOC");
    if (!reader || !toc) return;
    reader.style.display = "none";
    toc.style.display = "block";
  }

  // ----------------------------------------------------------
  // TOC RENDERING
  // ----------------------------------------------------------
  function renderTOC() {
    var host = byId("hbTOC");
    if (!host) return;

    var html = '<div class="hb-intro">' +
      '<h2>Field Guide</h2>' +
      '<p>Practical reference handbook for the operation. Sections load on demand and cache offline.</p>' +
      '<p class="hb-source">Source: <a href="https://github.com/Otto-9092/opio-field-guide" target="_blank" rel="noopener">opio-field-guide</a> on GitHub</p>' +
      '</div>';

    GROUP_ORDER.forEach(function (group) {
      var groupSections = SECTIONS.filter(function (s) { return s.group === group; });
      if (groupSections.length === 0) return;
      html += '<div class="hb-group">';
      html += '<h3 class="hb-group-title">' + group + '</h3>';
      html += '<div class="hb-cards">';
      groupSections.forEach(function (s) {
        html += '<button class="hb-card" data-section="' + s.id + '">' +
          '<span class="hb-card-id">' + s.id + '</span>' +
          '<span class="hb-card-title">' + s.title + '</span>' +
          '</button>';
      });
      html += '</div></div>';
    });

    host.innerHTML = html;

    // Wire up card clicks
    host.querySelectorAll(".hb-card").forEach(function (card) {
      card.addEventListener("click", function () {
        showSection(this.getAttribute("data-section"));
      });
    });
  }

  // ----------------------------------------------------------
  // INIT — wire up on tab click
  // ----------------------------------------------------------
  function initHandbookTab() {
    var tabBtn = document.querySelector('[data-tab="handbook"]');
    if (!tabBtn) return; // Tab not in DOM

    tabBtn.addEventListener("click", function () {
      // Only render TOC once (first time this tab opens)
      var toc = byId("hbTOC");
      if (toc && !toc.dataset.rendered) {
        renderTOC();
        toc.dataset.rendered = "1";
      }
    });

    // Wire back-to-TOC and reader buttons
    var backBtn = byId("hbBackToTOC");
    if (backBtn) {
      backBtn.addEventListener("click", showTOC);
    }
  }

  // Wait for DOM
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initHandbookTab);
  } else {
    initHandbookTab();
  }
})();
