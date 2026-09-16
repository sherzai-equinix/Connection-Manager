// config.js
// Zentrale Frontend-Konfiguration (ohne Build-Setup).
//
// Optional window.API_ORIGIN vor diesem Script setzen, wenn das Backend
// auf einem anderen Server liegt.

(function () {
  const location = window.location;
  const isLiveServer = ["localhost", "127.0.0.1"].includes(location.hostname) &&
    ["5500", "5501"].includes(location.port);
  const defaultOrigin = location.protocol === "file:" || isLiveServer
    ? "http://127.0.0.1:8000"
    : location.origin;
  const origin = (window.API_ORIGIN || defaultOrigin).replace(/\/$/, "");

  window.API_ORIGIN = origin;
  window.API_ROOT = origin + "/api/v1";

  // Convenience
  window.API_RACKVIEW = window.API_ROOT + "/rackview";
  window.API_CROSSCONNECTS = window.API_ROOT + "/cross-connects";
  window.API_KW_PLANS = window.API_ROOT + "/kw-plans";
  window.API_KW_PLANS_V2 = window.API_ROOT + "/kw_plans";
  window.API_KW_CHANGES = window.API_ROOT + "/kw_changes";
  window.API_CROSSCONNECTS_MIN = window.API_ROOT + "/cross_connects";
  window.API_PATCHPANELS = window.API_ROOT + "/patchpanels";
  window.API_DASHBOARD = window.API_ROOT + "/dashboard";
  window.API_HISTORICAL = window.API_ROOT + "/historical-lines";
  window.API_TROUBLESHOOTING = window.API_ROOT + "/troubleshooting";
  window.API_ACCESS_RESTRICTIONS = window.API_ROOT + "/access-restrictions";

  // URL der Kollegen-App für Access-Anmeldung (hier anpassen!)
  window.ACCESS_REQUEST_APP_URL = "https://PLACEHOLDER-KOLLEGEN-APP-URL.example.com";

  const authKeys = [
    "authToken", "username", "userRole", "userPermissions", "rememberLogin",
    "isLoggedIn", "loginAt", "forcePasswordChange",
  ];

  window.clearAuthSession = function () {
    for (const storage of [localStorage, sessionStorage]) {
      for (const key of authKeys) storage.removeItem(key);
    }
  };

  window.saveAuthSession = function ({
    token, username, role = "viewer", permissions = [],
    forcePasswordChange = false, remember = false, loginAt = new Date().toISOString(),
  }) {
    if (!token) throw new Error("Kein Token erhalten");
    window.clearAuthSession();
    const storage = remember ? localStorage : sessionStorage;
    storage.setItem("authToken", token);
    storage.setItem("username", username);
    storage.setItem("userRole", role);
    storage.setItem("userPermissions", JSON.stringify(permissions));
    storage.setItem("isLoggedIn", "true");
    storage.setItem("loginAt", loginAt);
    storage.setItem("forcePasswordChange", String(forcePasswordChange));
    if (remember) storage.setItem("rememberLogin", "true");
  };

  // Only attach application credentials to this backend, not third-party URLs.
  const _origFetch = window.fetch.bind(window);
  window.fetch = function (input, init) {
    const request = typeof Request !== "undefined" && input instanceof Request ? input : null;
    const url = new URL(request ? request.url : input, location.href);
    const apiUrl = new URL(window.API_ROOT);
    const isAuth = url.origin === apiUrl.origin && url.pathname.startsWith("/auth/");
    const isApi = url.origin === apiUrl.origin &&
      (url.pathname === apiUrl.pathname || url.pathname.startsWith(apiUrl.pathname + "/"));
    if (!isAuth && !isApi) return _origFetch(input, init);

    const token =
      localStorage.getItem("authToken") || sessionStorage.getItem("authToken");
    const role = window.getCurrentRole();

    init = init || {};
    const method = (init.method || (request && request.method) || "GET").toUpperCase();

    // Block write calls for viewer role only (client-side guard).
    // Alle /auth/ Endpunkte sind immer erlaubt (Login, Passwort ändern, usw.)
    const isWriteAllowed = role === "admin" || role === "superadmin" || role === "techniker";
    if (!isAuth && !isWriteAllowed && !['GET', 'HEAD', 'OPTIONS'].includes(method)) {
      return Promise.reject(new Error("Forbidden: read-only role"));
    }

    const headers = new Headers(init.headers || (request && request.headers) || {});
    if (token && url.pathname !== "/auth/login" && !headers.has("Authorization")) {
      headers.set("Authorization", `Bearer ${token}`);
    }

    return _origFetch(input, { ...init, headers }).then(response => {
      const currentToken = localStorage.getItem("authToken") || sessionStorage.getItem("authToken");
      if (response.status === 401 && token && currentToken === token &&
          url.pathname !== "/auth/login" && headers.get("Authorization") === `Bearer ${token}`) {
        window.clearAuthSession();
        if (!location.pathname.endsWith("login.html")) {
          location.href = "login.html";
        }
      }
      return response;
    });
  };

  // Expose role helpers for other pages
  window.getCurrentRole = function () {
    const role = String(
      localStorage.getItem("userRole") || sessionStorage.getItem("userRole") || "viewer"
    ).trim().toLowerCase();
    return role === "tech" ? "techniker" : role;
  };
  window.isAdminRole = function () {
    const r = window.getCurrentRole();
    return r === "admin" || r === "superadmin";
  };
})();
