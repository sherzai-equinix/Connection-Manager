/* ==========================================================================
   Connection Manager – theme.js
   --------------------------------------------------------------------------
   Kleine, abhängigkeitsfreie Ergänzungen zur gemeinsamen Oberfläche.
   Läuft nach config.js / nav-auth.js und greift nirgends in deren Logik ein.

   1. Aktive Seite in der Navigation markieren (LED leuchtet)
   2. Backend-Status-LED: fragt /health/ready (ohne Login) alle 30s ab
   3. Strg+K bzw. "/" springt in das Suchfeld der aktuellen Seite
   4. Einmaliger "LEDs gehen an"-Moment nach dem Laden
   Jeder Schritt ist in try/catch gekapselt – ein Fehler hier darf die
   eigentliche Seite nie beeinträchtigen.
   ========================================================================== */
(function () {
  "use strict";

  var HEALTH_INTERVAL_MS = 30000;
  var HEALTH_TIMEOUT_MS = 6000;

  function apiOrigin() {
    var o = typeof window.API_ORIGIN === "string" && window.API_ORIGIN ? window.API_ORIGIN : window.location.origin;
    return String(o).replace(/\/$/, "");
  }

  function currentPage() {
    var path = window.location.pathname || "";
    var file = path.substring(path.lastIndexOf("/") + 1);
    return (file || "index.html").toLowerCase();
  }

  /* 1. Aktive Seite ------------------------------------------------------- */
  function markActiveNav() {
    var page = currentPage();
    var items = document.querySelectorAll(".bottom-dock .dock-item[href]");
    var index = 0;
    for (var i = 0; i < items.length; i++) {
      var a = items[i];
      var href = (a.getAttribute("href") || "").split("?")[0].split("#")[0].toLowerCase();
      a.style.setProperty("--i", String(index++));
      if (href && href === page) {
        a.classList.add("is-active");
        if (!a.hasAttribute("aria-current")) a.setAttribute("aria-current", "page");
      }
    }
  }

  /* 2. Backend-Status ----------------------------------------------------- */
  var healthLed = null;
  var healthLabel = null;

  function ensureHealthLed() {
    if (healthLed) return healthLed;
    var brand = document.querySelector(".bottom-dock .dock-brand");
    if (!brand) return null;
    healthLed = document.createElement("span");
    healthLed.className = "cm-health";
    healthLed.setAttribute("data-state", "checking");
    healthLed.setAttribute("role", "status");
    healthLed.setAttribute("title", "Backend-Status wird geprüft …");
    healthLabel = document.createElement("span");
    healthLabel.className = "cm-visually-hidden";
    healthLabel.textContent = "Backend-Status: wird geprüft";
    healthLed.appendChild(healthLabel);
    brand.appendChild(healthLed);
    return healthLed;
  }

  function setHealth(state, text) {
    var led = ensureHealthLed();
    if (!led) return;
    led.setAttribute("data-state", state);
    led.setAttribute("title", text);
    if (healthLabel) healthLabel.textContent = "Backend-Status: " + text;
  }

  function fetchWithTimeout(url, ms) {
    var controller = typeof AbortController === "function" ? new AbortController() : null;
    var timer = null;
    var options = { cache: "no-store", credentials: "omit" };
    if (controller) options.signal = controller.signal;
    var timeout = new Promise(function (_, reject) {
      timer = setTimeout(function () {
        if (controller) controller.abort();
        reject(new Error("timeout"));
      }, ms);
    });
    return Promise.race([fetch(url, options), timeout]).finally(function () {
      if (timer !== null) clearTimeout(timer);
    });
  }

  function checkHealth() {
    if (document.hidden) return; // kein Polling im Hintergrund-Tab
    var url = apiOrigin() + "/health/ready";
    fetchWithTimeout(url, HEALTH_TIMEOUT_MS)
      .then(function (res) {
        return res
          .json()
          .catch(function () {
            return {};
          })
          .then(function (data) {
            var version = data && data.version ? " · Version " + data.version : "";
            if (res.ok) {
              setHealth("ok", "Backend und Datenbank erreichbar" + version);
            } else if (res.status === 503) {
              setHealth("degraded", "Backend läuft, Datenbank antwortet nicht" + version);
            } else {
              setHealth("degraded", "Backend antwortet mit Status " + res.status);
            }
          });
      })
      .catch(function () {
        setHealth("down", "Backend nicht erreichbar – Netzwerk oder Container prüfen");
      });
  }

  /* 3. Tastatur: in die Suche springen ----------------------------------- */
  function findSearchInput() {
    var candidates = document.querySelectorAll(
      'input[type="search"], input[id*="search" i], input[id*="Search"], input[placeholder*="such" i], input[placeholder*="search" i]'
    );
    for (var i = 0; i < candidates.length; i++) {
      var el = candidates[i];
      if (el.disabled || el.offsetParent === null) continue;
      return el;
    }
    return null;
  }

  function isTypingContext(target) {
    if (!target) return false;
    var tag = (target.tagName || "").toLowerCase();
    return tag === "input" || tag === "textarea" || tag === "select" || target.isContentEditable;
  }

  function bindKeyboard() {
    var search = findSearchInput();
    if (search) {
      var inner = document.querySelector(".topbar-inner");
      if (inner && !inner.querySelector(".cm-kbd-hint")) {
        var hint = document.createElement("span");
        hint.className = "cm-kbd-hint";
        hint.setAttribute("aria-hidden", "true");
        hint.innerHTML = "Suche <kbd>Strg</kbd><kbd>K</kbd>";
        inner.appendChild(hint);
      }
    }
    document.addEventListener("keydown", function (e) {
      var ctrlK = (e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && String(e.key).toLowerCase() === "k";
      var slash = e.key === "/" && !e.ctrlKey && !e.metaKey && !e.altKey && !isTypingContext(e.target);
      if (!ctrlK && !slash) return;
      var el = findSearchInput();
      if (!el) return;
      e.preventDefault();
      el.focus();
      if (typeof el.select === "function") el.select();
    });
  }

  /* 4. Start --------------------------------------------------------------- */
  function init() {
    try { markActiveNav(); } catch (err) { /* nie die Seite blockieren */ }
    try { bindKeyboard(); } catch (err) { /* s.o. */ }
    try {
      ensureHealthLed();
      checkHealth();
      setInterval(checkHealth, HEALTH_INTERVAL_MS);
      document.addEventListener("visibilitychange", function () {
        if (!document.hidden) checkHealth();
      });
    } catch (err) { /* s.o. */ }
    try {
      // erst nach dem ersten Frame, damit die Animation sichtbar startet
      requestAnimationFrame(function () {
        document.body.classList.add("cm-ready");
      });
    } catch (err) { /* s.o. */ }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
