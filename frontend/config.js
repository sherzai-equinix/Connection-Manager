// config.js
// Zentrale Frontend-Konfiguration (ohne Build-Setup).
//
// Du kannst optional in der Console setzen:
//   window.API_ORIGIN = "http://127.0.0.1:8000";
// bevor du die Seite lädst.
//
// Default bleibt kompatibel mit deinem bisherigen Setup.

(function () {
  // API ist immer auf Port 8000. Egal ob die Seite via Live Server (5500),
  // file://, oder direkt über den FastAPI-Server (8000) geöffnet wird.
  const DEFAULT_ORIGIN = "https://tocry.corp.equinix.com";
  const origin = (window.API_ORIGIN || DEFAULT_ORIGIN).replace(/\/$/, "");

  window.API_ORIGIN = origin;
  window.API_ROOT = origin + "/api/v1";

  // Convenience
  window.API_RACKVIEW = window.API_ROOT + "/rackview";
  window.API_PRECABLING = window.API_ROOT + "/precabling";
  window.API_CROSSCONNECTS = window.API_ROOT + "/cross-connects";
  window.API_KW_PLANS = window.API_ROOT + "/kw-plans";
  window.API_KW_TASKS = window.API_ROOT + "/kw-tasks";
  window.API_KW_PLANS_V2 = window.API_ROOT + "/kw_plans";
  window.API_KW_CHANGES = window.API_ROOT + "/kw_changes";
  window.API_CROSSCONNECTS_MIN = window.API_ROOT + "/cross_connects";
  window.API_LINES = window.API_ROOT + "/lines";
  window.API_PATCHPANELS = window.API_ROOT + "/patchpanels";
  window.API_RFRA_PORTS = window.API_ROOT + "/rfra/ports";
  window.API_BB_MIRROR = window.API_ROOT + "/bb/mirror";
  window.API_DASHBOARD = window.API_ROOT + "/dashboard";
  window.API_ZSIDE = origin + "/zside";
  window.API_IMPORT = origin;
  window.API_HISTORICAL = window.API_ROOT + "/historical-lines";
  window.API_TROUBLESHOOTING = window.API_ROOT + "/troubleshooting";

  // Inject Authorization header into all fetch() calls if token exists.
  const _origFetch = window.fetch.bind(window);
  window.fetch = function (input, init) {
    const token =
      localStorage.getItem("authToken") || sessionStorage.getItem("authToken");
    const role =
      localStorage.getItem("userRole") || sessionStorage.getItem("userRole");

    init = init || {};
    const method = (init.method || "GET").toUpperCase();

    // Block write calls for viewer role only (client-side guard).
    // Alle /auth/ Endpunkte sind immer erlaubt (Login, Passwort ändern, usw.)
    const isWriteAllowed = role === "admin" || role === "superadmin" || role === "techniker";
    if (role && !isWriteAllowed && !['GET', 'HEAD', 'OPTIONS'].includes(method)) {
      const url = typeof input === "string" ? input : (input && input.url) || "";
      if (!url.includes("/auth/")) {
        return Promise.reject(new Error("Forbidden: read-only role"));
      }
    }

    if (token) {
      const headers = new Headers(init.headers || {});
      if (!headers.has("Authorization")) {
        headers.set("Authorization", `Bearer ${token}`);
      }
      init.headers = headers;
    }

    return _origFetch(input, init);
  };

  // Expose role helpers for other pages
  window.getCurrentRole = function () {
    return String(
      localStorage.getItem("userRole") || sessionStorage.getItem("userRole") || "viewer"
    ).toLowerCase();
  };
  window.isAdminRole = function () {
    const r = window.getCurrentRole();
    return r === "admin" || r === "superadmin";
  };
})();
