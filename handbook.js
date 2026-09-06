// ============================================================
// OπO Farming — Handbook Tab (ALL-IN-ONE)
// ------------------------------------------------------------
// 100% SELF-CONTAINED. Follows the asapplied.js / uxenhancements.js
// pattern: no edits to app.js required. Just add ONE line to
// index.html AFTER the app.js script tag:
//
//     <script src="app.js?v=..."></script>
//     <script src="handbook.js?v=20260905-17"></script>
//
// What this does:
//   • Injects a "Handbook" nav tab into the existing <nav class="tabs">
//   • Injects a matching <section id="tab-handbook" class="tab-panel">
//   • Loads sections from the opio-field-guide GitHub repo at runtime
//   • Renders markdown to HTML (marked.js via CDN, with a tiny fallback
//     renderer if the CDN is blocked so at least headings and paragraphs
//     work even offline / on locked-down networks)
//   • Handles cross-section links (Section 6 links to Section 10 etc.)
//   • Caches fetched sections in memory during the session
//   • Playsy nice with day/night mode (uses CSS vars from styles.css)
//
// Data source (public repo, no auth required):
//   https://raw.githubusercontent.com/Otto-9092/opio-field-guide/main/sections/
//
// Note on offline behavior:
//   The service worker precaches the app shell, not the handbook content.
//   Handbook sections are network-fetched on first click and cached in-memory
//   for the session. If you want persistent offline handbook access, we can
//   add IndexedDB caching in a later revision.
// ============================================================
(function () {
  "use strict";

  // ----------------------------------------------------------
  // CONFIG
  // ----------------------------------------------------------
  var REPO_BASE = "https://raw.githubusercontent.com/Otto-9092/opio-field-guide/main/sections/";
  var GITHUB_REPO_URL = "https://github.com/Otto-9092/opio-field-guide";
  var MARKED_CDN = "https://cdn.jsdelivr.net/npm/marked/marked.min.js";

  // Master list of sections — matches the field guide repo file names.
  var SECTIONS = [
    { id: "01", title: "Operation Overview",           file: "01-operation-overview.md" },
    { id: "02", title: "Tillage Strategy",             file: "02-tillage-strategy.md" },
    { id: "03", title: "Tandem Disc",                  file: "03-tandem-disc.md" },
    { id: "04", title: "Field Cultivator",             file: "04-field-cultivator.md" },
    { id: "05", title: "JD 7000 Planter",              file: "05-jd-7000-planter.md" },
    { id: "06", title: "JD 8300 Drill",                file: "06-jd-8300-drill.md" },
    { id: "07", title: "Sprayer",                      file: "07-sprayer.md" },
    { id: "08", title: "Corn Production",              file: "08-corn-production.md" },
    { id: "09", title: "Winter Wheat",                 file: "09-winter-wheat.md" },
    { id: "10", title: "IH 1480 Combine",              file: "10-ih-1480.md" },
    { id: "11", title: "Headers (IH 1010 & 963)",      file: "11-headers.md" },
    { id: "12", title: "Grain Handling & Storage",     file: "12-grain-handling.md" },
    { id: "13", title: "Hay Equipment",                file: "13-hay-equipment.md" },
    { id: "14", title: "Farm Business & ROI",          file: "14-farm-business.md" },
    { id: "15", title: "Farm Calendar",                file: "15-calendar.md" },
    { id: "16", title: "Lubrication & Maintenance",    file: "16-lube-maintenance.md" },
    { id: "17", title: "Auction Strategy",             file: "17-auctions.md" },
    { id: "18", title: "Parts Shelf",                  file: "18-parts-shelf.md" },
    { id: "19", title: "Field Records",                file: "19-field-records.md" },
    { id: "20", title: "Buy-It-Once",                  file: "20-buy-it-once.md" }
  ];

  // In-memory cache of fetched sections (session-scoped).
  var contentCache = {};

  // ----------------------------------------------------------
  // UTILITIES
  // ----------------------------------------------------------
  function byId(id) { return document.getElementById(id); }
  function ready(fn) {
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", fn);
    else fn();
  }

  // Lookup a section by its file name (used by cross-section links).
  function findSectionByFile(filename) {
    for (var i = 0; i < SECTIONS.length; i++) {
      if (SECTIONS[i].file === filename) return SECTIONS[i];
    }
    return null;
  }

  // ----------------------------------------------------------
  // MARKDOWN RENDERING
  // ----------------------------------------------------------
  // Try to load marked.js from CDN. If it fails (blocked network, CDN
  // outage), fall back to a minimal renderer so at least the content
  // is readable — just less pretty.
  var markedReady = null;
  function loadMarked() {
    if (markedReady) return markedReady;
    markedReady = new Promise(function (resolve) {
      if (window.marked) { resolve(true); return; }
      var s = document.createElement("script");
      s.src = MARKED_CDN;
      s.onload = function () { resolve(true); };
      s.onerror = function () {
        console.warn("[Handbook] marked.js CDN unreachable, using fallback renderer");
        resolve(false);
      };
      document.head.appendChild(s);
    });
    return markedReady;
  }

  // Minimal markdown-to-HTML fallback. Handles headings, bold, italic,
  // inline code, lists, tables, and paragraphs. Not perfect but readable.
  function fallbackRender(md) {
    var lines = md.split(/\r?\n/);
    var html = [];
    var i = 0;
    while (i < lines.length) {
      var line = lines[i];

      // Heading
      var h = line.match(/^(#{1,6})\s+(.*)$/);
      if (h) {
        var level = h[1].length;
        html.push("<h" + level + ">" + inlineMd(h[2]) + "</h" + level + ">");
        i++; continue;
      }

      // Horizontal rule
      if (/^---+\s*$/.test(line)) {
        html.push("<hr>");
        i++; continue;
      }

      // Table (very simple detection)
      if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|[-:\s|]+\|\s*$/.test(lines[i + 1])) {
        var tblStart = i;
        var headerCells = line.split("|").slice(1, -1).map(function (c) { return c.trim(); });
        i += 2;
        var rows = [];
        while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) {
          rows.push(lines[i].split("|").slice(1, -1).map(function (c) { return c.trim(); }));
          i++;
        }
        var t = "<table><thead><tr>";
        headerCells.forEach(function (c) { t += "<th>" + inlineMd(c) + "</th>"; });
        t += "</tr></thead><tbody>";
        rows.forEach(function (r) {
          t += "<tr>";
          r.forEach(function (c) { t += "<td>" + inlineMd(c) + "</td>"; });
          t += "</tr>";
        });
        t += "</tbody></table>";
        html.push(t);
        continue;
      }

      // Unordered list
      if (/^\s*[-*+]\s+/.test(line)) {
        var ul = "<ul>";
        while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) {
          ul += "<li>" + inlineMd(lines[i].replace(/^\s*[-*+]\s+/, "")) + "</li>";
          i++;
        }
        ul += "</ul>";
        html.push(ul);
        continue;
      }

      // Ordered list
      if (/^\s*\d+\.\s+/.test(line)) {
        var ol = "<ol>";
        while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
          ol += "<li>" + inlineMd(lines[i].replace(/^\s*\d+\.\s+/, "")) + "</li>";
          i++;
        }
        ol += "</ol>";
        html.push(ol);
        continue;
      }

      // Blank line
      if (/^\s*$/.test(line)) { i++; continue; }

      // Paragraph — accumulate until blank line
      var para = [line];
      i++;
      while (i < lines.length && !/^\s*$/.test(lines[i]) && !/^(#{1,6})\s/.test(lines[i]) && !/^\s*[-*+]\s/.test(lines[i]) && !/^\s*\d+\.\s/.test(lines[i]) && !/^---+\s*$/.test(lines[i]) && !/^\s*\|.*\|\s*$/.test(lines[i])) {
        para.push(lines[i]);
        i++;
      }
      html.push("<p>" + inlineMd(para.join(" ")) + "</p>");
    }
    return html.join("\n");
  }

  // Handle inline markdown: bold, italic, code, links.
  function inlineMd(s) {
    // Escape HTML first
    s = s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    // Bold
    s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    // Italic
    s = s.replace(/(^|[^*])\*([^*]+)\*/g, "$1<em>$2</em>");
    // Inline code
    s = s.replace(/`([^`]+)`/g, "<code>$1</code>");
    // Links [text](url)
    s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, function (_, text, url) {
      return '<a href="' + url + '" target="_blank" rel="noopener">' + text + "</a>";
    });
    return s;
  }

  function renderMarkdown(md) {
    return loadMarked().then(function (usingMarked) {
      if (usingMarked && window.marked) {
        try {
          if (typeof window.marked.parse === "function") return window.marked.parse(md);
          return window.marked(md);
        } catch (e) {
          console.warn("[Handbook] marked.js render failed, using fallback", e);
          return fallbackRender(md);
        }
      }
      return fallbackRender(md);
    });
  }

  // ----------------------------------------------------------
  // DOM INJECTION — nav tab + tab panel
  // ----------------------------------------------------------
  function injectDOM() {
    // Add the nav button
    var nav = document.querySelector("nav.tabs");
    if (nav && !document.querySelector('[data-tab="handbook"]')) {
      var btn = document.createElement("button");
      btn.className = "tab";
      btn.setAttribute("data-tab", "handbook");
      btn.textContent = "Handbook";
      nav.appendChild(btn);

      // Wire the tab-switching manually so we don't depend on app.js
      // having attached its listener yet. Match app.js's logic exactly.
      btn.addEventListener("click", function () {
        document.querySelectorAll(".tab").forEach(function (x) { x.classList.remove("active"); });
        document.querySelectorAll(".tab-panel").forEach(function (x) { x.classList.remove("active"); });
        btn.classList.add("active");
        var panel = byId("tab-handbook");
        if (panel) panel.classList.add("active");
        renderTOC();
      });
    }

    // Add the tab panel
    if (!byId("tab-handbook")) {
      var main = document.querySelector("main");
      if (main) {
        var section = document.createElement("section");
        section.id = "tab-handbook";
        section.className = "tab-panel";
        section.innerHTML = [
          '<div id="handbookRoot" class="handbook-root">',
          '  <div id="handbookNav" class="handbook-nav"></div>',
          '  <div id="handbookContent" class="handbook-content"></div>',
          '</div>'
        ].join("");
        main.appendChild(section);
      }
    }

    // Add stylesheet
    injectStyles();
  }

  function injectStyles() {
    if (byId("handbookStyles")) return;
    var css = [
      '.handbook-root {',
      '  display: flex;',
      '  gap: 12px;',
      '  min-height: 60vh;',
      '  align-items: flex-start;',
      '}',
      '.handbook-nav {',
      '  flex: 0 0 200px;',
      '  background: var(--panel-2);',
      '  border: 1px solid var(--border);',
      '  border-radius: 10px;',
      '  padding: 8px;',
      '  max-height: 75vh;',
      '  overflow-y: auto;',
      '  position: sticky;',
      '  top: calc(102px + var(--safe-top));',
      '}',
      '.handbook-nav-header {',
      '  font-size: 13px;',
      '  font-weight: 700;',
      '  color: var(--muted);',
      '  padding: 6px 8px;',
      '  border-bottom: 1px solid var(--border);',
      '  margin-bottom: 6px;',
      '  text-transform: uppercase;',
      '  letter-spacing: 0.5px;',
      '}',
      '.handbook-nav-list { list-style: none; padding: 0; margin: 0; }',
      '.handbook-nav-item {',
      '  padding: 8px 10px;',
      '  cursor: pointer;',
      '  border-radius: 6px;',
      '  font-size: 13px;',
      '  color: var(--text);',
      '  display: flex;',
      '  gap: 6px;',
      '  align-items: baseline;',
      '  border: 1px solid transparent;',
      '  margin-bottom: 2px;',
      '}',
      '.handbook-nav-item:hover { background: var(--panel); }',
      '.handbook-nav-item.active {',
      '  background: var(--panel);',
      '  border-color: var(--accent);',
      '  font-weight: 600;',
      '}',
      '.handbook-nav-num {',
      '  color: var(--muted);',
      '  font-family: ui-monospace, "SF Mono", Menlo, monospace;',
      '  font-size: 11px;',
      '  flex: 0 0 auto;',
      '}',
      '.handbook-content {',
      '  flex: 1;',
      '  min-width: 0;',
      '  background: var(--panel);',
      '  border: 1px solid var(--border);',
      '  border-radius: 10px;',
      '  padding: 20px;',
      '  overflow-x: auto;',
      '}',
      '.handbook-toc-intro { color: var(--muted); font-size: 14px; margin-bottom: 16px; }',
      '.handbook-toc-repo-link {',
      '  display: inline-block;',
      '  margin-top: 8px;',
      '  color: var(--accent);',
      '  text-decoration: none;',
      '  font-size: 13px;',
      '}',
      '.handbook-back-btn {',
      '  background: var(--panel-2);',
      '  border: 1px solid var(--border);',
      '  color: var(--text);',
      '  padding: 6px 12px;',
      '  border-radius: 6px;',
      '  cursor: pointer;',
      '  font-size: 13px;',
      '  margin-bottom: 12px;',
      '  min-height: 32px;',
      '}',
      '.handbook-back-btn:hover { background: var(--border); }',
      '.handbook-loading { color: var(--muted); font-style: italic; padding: 20px; }',
      '.handbook-error { color: var(--red); padding: 12px; background: var(--panel-2); border-radius: 8px; }',
      '',
      '/* Style the rendered markdown */',
      '.handbook-content h1, .handbook-content h2, .handbook-content h3, .handbook-content h4 {',
      '  color: var(--text);',
      '  margin-top: 1.5em;',
      '  margin-bottom: 0.5em;',
      '  line-height: 1.3;',
      '}',
      '.handbook-content h1 { font-size: 24px; margin-top: 0; border-bottom: 2px solid var(--border); padding-bottom: 8px; }',
      '.handbook-content h2 { font-size: 20px; border-bottom: 1px solid var(--border); padding-bottom: 4px; }',
      '.handbook-content h3 { font-size: 17px; }',
      '.handbook-content h4 { font-size: 15px; }',
      '.handbook-content p, .handbook-content li { color: var(--text); line-height: 1.6; font-size: 15px; }',
      '.handbook-content a { color: var(--accent); }',
      '.handbook-content ul, .handbook-content ol { padding-left: 24px; }',
      '.handbook-content li { margin: 4px 0; }',
      '.handbook-content code {',
      '  background: var(--panel-2);',
      '  padding: 2px 5px;',
      '  border-radius: 3px;',
      '  font-family: ui-monospace, "SF Mono", Menlo, monospace;',
      '  font-size: 13px;',
      '}',
      '.handbook-content pre {',
      '  background: var(--panel-2);',
      '  padding: 12px;',
      '  border-radius: 8px;',
      '  overflow-x: auto;',
      '  font-size: 13px;',
      '  line-height: 1.5;',
      '}',
      '.handbook-content pre code { background: none; padding: 0; }',
      '.handbook-content table {',
      '  border-collapse: collapse;',
      '  width: 100%;',
      '  margin: 1em 0;',
      '  font-size: 14px;',
      '}',
      '.handbook-content th, .handbook-content td {',
      '  border: 1px solid var(--border);',
      '  padding: 8px 10px;',
      '  text-align: left;',
      '  vertical-align: top;',
      '}',
      '.handbook-content th { background: var(--panel-2); font-weight: 600; }',
      '.handbook-content strong { color: var(--text); }',
      '.handbook-content hr { border: 0; border-top: 1px solid var(--border); margin: 1.5em 0; }',
      '.handbook-content blockquote {',
      '  border-left: 3px solid var(--accent);',
      '  margin: 1em 0;',
      '  padding: 4px 12px;',
      '  color: var(--muted);',
      '  background: var(--panel-2);',
      '}',
      '.handbook-content input[type="checkbox"] { margin-right: 6px; }',
      '',
      '/* Mobile: stack nav on top of content */',
      '@media (max-width: 760px) {',
      '  .handbook-root { flex-direction: column; }',
      '  .handbook-nav {',
      '    flex: 0 0 auto;',
      '    max-height: 200px;',
      '    width: 100%;',
      '    position: static;',
      '  }',
      '  .handbook-content { padding: 14px; }',
      '  .handbook-content h1 { font-size: 20px; }',
      '  .handbook-content h2 { font-size: 17px; }',
      '  .handbook-content h3 { font-size: 15px; }',
      '  .handbook-content p, .handbook-content li { font-size: 14px; }',
      '}'
    ].join("\n");
    var style = document.createElement("style");
    style.id = "handbookStyles";
    style.textContent = css;
    document.head.appendChild(style);
  }

  // ----------------------------------------------------------
  // RENDERING — TOC and section views
  // ----------------------------------------------------------
  function renderTOC() {
    var navEl = byId("handbookNav");
    var contentEl = byId("handbookContent");
    if (!navEl || !contentEl) return;

    // Left nav — list of sections (always visible)
    var navHtml = ['<div class="handbook-nav-header">Sections</div>', '<ul class="handbook-nav-list">'];
    SECTIONS.forEach(function (s) {
      navHtml.push(
        '<li class="handbook-nav-item" data-section-id="' + s.id + '">' +
        '<span class="handbook-nav-num">' + s.id + '</span>' +
        '<span>' + s.title + '</span>' +
        '</li>'
      );
    });
    navHtml.push('</ul>');
    navEl.innerHTML = navHtml.join("");

    // Wire nav clicks
    navEl.querySelectorAll(".handbook-nav-item").forEach(function (item) {
      item.addEventListener("click", function () {
        var id = item.getAttribute("data-section-id");
        var sec = SECTIONS.find(function (s) { return s.id === id; });
        if (sec) loadSection(sec);
      });
    });

    // Content — landing page with intro
    contentEl.innerHTML = [
      '<h1>OπO Field Guide</h1>',
      '<div class="handbook-toc-intro">',
      '  Practical farm equipment buyer\'s guide and crop production handbook for the operation. ',
      '  Pick a section from the list to read. Content is fetched from the ',
      '  <a href="' + GITHUB_REPO_URL + '" target="_blank" rel="noopener">opio-field-guide</a> repo.',
      '</div>',
      '<h2>How to use</h2>',
      '<ul>',
      '  <li><strong>Reference before decisions.</strong> Before a purchase, before a field operation, before a repair — check the relevant section first.</li>',
      '  <li><strong>Section 1 is the source of truth</strong> — every other section references its facts about the operation.</li>',
      '  <li><strong>Cross-section links</strong> work — click any Section reference and you\'ll jump there.</li>',
      '  <li><strong>Living document</strong> — updates on the GitHub repo appear here as soon as you refresh.</li>',
      '</ul>',
      '<p><a class="handbook-toc-repo-link" href="' + GITHUB_REPO_URL + '" target="_blank" rel="noopener">View repo on GitHub →</a></p>'
    ].join("\n");
  }

  function loadSection(section) {
    var navEl = byId("handbookNav");
    var contentEl = byId("handbookContent");
    if (!contentEl) return;

    // Mark nav item as active
    if (navEl) {
      navEl.querySelectorAll(".handbook-nav-item").forEach(function (el) {
        el.classList.toggle("active", el.getAttribute("data-section-id") === section.id);
      });
    }

    // Show a loading state
    contentEl.innerHTML = [
      '<button class="handbook-back-btn" id="handbookBackBtn">← Back to Table of Contents</button>',
      '<div class="handbook-loading">Loading Section ' + section.id + ': ' + section.title + '…</div>'
    ].join("");

    // Wire back button
    var back = byId("handbookBackBtn");
    if (back) back.addEventListener("click", renderTOC);

    // Fetch (or use cache)
    var fetcher;
    if (contentCache[section.file]) {
      fetcher = Promise.resolve(contentCache[section.file]);
    } else {
      fetcher = fetch(REPO_BASE + section.file)
        .then(function (resp) {
          if (!resp.ok) throw new Error("HTTP " + resp.status);
          return resp.text();
        })
        .then(function (md) {
          contentCache[section.file] = md;
          return md;
        });
    }

    fetcher
      .then(function (md) {
        return renderMarkdown(md);
      })
      .then(function (html) {
        contentEl.innerHTML = [
          '<button class="handbook-back-btn" id="handbookBackBtn">← Back to Table of Contents</button>',
          html
        ].join("");
        // Re-wire back button (innerHTML rewrite)
        var back2 = byId("handbookBackBtn");
        if (back2) back2.addEventListener("click", renderTOC);
        // Rewrite cross-section links to work in-app instead of jumping to raw
        rewriteInternalLinks(contentEl);
        // Scroll to top
        contentEl.scrollTop = 0;
      })
      .catch(function (err) {
        console.warn("[Handbook] fetch failed", err);
        contentEl.innerHTML = [
          '<button class="handbook-back-btn" id="handbookBackBtn">← Back to Table of Contents</button>',
          '<div class="handbook-error">',
          '  <strong>Could not load Section ' + section.id + '.</strong><br>',
          '  Error: ' + (err.message || String(err)) + '<br><br>',
          '  If you\'re on a corporate network, GitHub raw content may be blocked. ',
          '  Try again on your personal device, or ',
          '  <a href="' + REPO_BASE + section.file + '" target="_blank" rel="noopener">',
          '    open on GitHub directly',
          '  </a>.',
          '</div>'
        ].join("");
        var back3 = byId("handbookBackBtn");
        if (back3) back3.addEventListener("click", renderTOC);
      });
  }

  // ----------------------------------------------------------
  // CROSS-SECTION LINKS
  // ----------------------------------------------------------
  // Handbook sections link to each other with relative paths like
  // "[Section 6](06-jd-8300-drill.md)". We rewrite these to open the
  // target section in-app rather than fetching the raw file in a new tab.
  function rewriteInternalLinks(root) {
    var links = root.querySelectorAll("a[href]");
    links.forEach(function (a) {
      var href = a.getAttribute("href");
      // Match filenames like "06-jd-8300-drill.md" or "sections/06-jd-8300-drill.md"
      var m = href.match(/(?:^|\/)(\d{2}-[a-z0-9-]+\.md)(?:#.*)?$/i);
      if (m) {
        var filename = m[1];
        var target = findSectionByFile(filename);
        if (target) {
          a.addEventListener("click", function (ev) {
            ev.preventDefault();
            loadSection(target);
          });
          a.style.cursor = "pointer";
        }
      }
    });
  }

  // ----------------------------------------------------------
  // BOOT
  // ----------------------------------------------------------
  ready(function () {
    // Defer slightly to let app.js finish attaching its tab listeners
    // (so the tab pattern is already set up when we inject ours).
    setTimeout(function () {
      injectDOM();
    }, 100);
  });

})();
