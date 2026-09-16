const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const frontend = path.join(__dirname, "..", "frontend");
const configSource = fs.readFileSync(path.join(frontend, "config.js"), "utf8");
const loginSource = fs.readFileSync(path.join(frontend, "login.html"), "utf8");
const loginScript = Array.from(loginSource.matchAll(/<script>([\s\S]*?)<\/script>/g),
  match => match[1]).find(script => script.includes("/* \u2500\u2500 Login Logic"));

function storage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem(key) { return values.get(key) ?? null; },
    setItem(key, value) { values.set(key, String(value)); },
    removeItem(key) { values.delete(key); },
  };
}

function loadApp({
  url = "https://test.example/frontend/login.html",
  origin,
  local = {},
  session = {},
  respond = async () => Response.json({}),
} = {}) {
  const calls = [];
  const events = new Map();
  const elements = new Map();
  const timers = [];
  function element(id) {
    if (id === "particles") return null;
    if (!elements.has(id)) elements.set(id, {
      value: "", checked: false, style: {}, disabled: false, textContent: "",
      addEventListener(event, handler) { this[event] = handler; },
    });
    return elements.get(id);
  }
  let currentUrl = new URL(url);
  const location = {
    get href() { return currentUrl.href; },
    set href(value) { currentUrl = new URL(value, currentUrl); },
    get origin() { return currentUrl.origin; },
    get hostname() { return currentUrl.hostname; },
    get port() { return currentUrl.port; },
    get protocol() { return currentUrl.protocol; },
    get pathname() { return currentUrl.pathname; },
  };
  const window = {
    location,
    API_ORIGIN: origin,
    addEventListener(event, handler) { events.set(event, handler); },
    fetch: async (input, init) => {
      calls.push({ input, init });
      return respond(input, init);
    },
  };
  const context = vm.createContext({
    window, URL, Headers, Request, TypeError, console,
    localStorage: storage(local), sessionStorage: storage(session),
    document: { getElementById: element },
    setTimeout(fn) { timers.push(fn); },
  });
  vm.runInContext(configSource, context);
  context.fetch = window.fetch;
  return { context, window, calls, events, element, timers };
}

for (const [url, expected] of [
  ["https://test.example:8443/frontend/login.html", "https://test.example:8443"],
  ["http://localhost:8082/frontend/login.html", "http://localhost:8082"],
  ["http://localhost:5500/frontend/login.html", "http://127.0.0.1:8000"],
  ["http://127.0.0.1:5501/frontend/login.html", "http://127.0.0.1:8000"],
  ["file:///C:/app/frontend/login.html", "http://127.0.0.1:8000"],
]) {
  test(`API origin follows the deployment for ${url}`, () => {
    const { window } = loadApp({ url });
    assert.equal(window.API_ORIGIN, expected);
    assert.equal(window.API_ROOT, `${expected}/api/v1`);
  });
}

test("an explicit backend origin overrides automatic detection", () => {
  assert.equal(loadApp({ origin: "https://backend.example/" }).window.API_ORIGIN,
    "https://backend.example");
});

test("saving a session clears old credentials but preserves user preferences", () => {
  const app = loadApp({
    local: { authToken: "old-admin", userRole: "admin", theme: "light", filter: "active" },
    session: { authToken: "old-session", userPermissions: '["users.manage"]', draft: "keep" },
  });
  app.window.saveAuthSession({ token: "new-viewer", username: "viewer", remember: false });
  const { localStorage, sessionStorage } = app.context;
  assert.equal(localStorage.getItem("authToken"), null);
  assert.equal(localStorage.getItem("userRole"), null);
  assert.equal(sessionStorage.getItem("authToken"), "new-viewer");
  assert.equal(sessionStorage.getItem("userRole"), "viewer");
  assert.equal(sessionStorage.getItem("userPermissions"), "[]");
  assert.equal(localStorage.getItem("theme"), "light");
  assert.equal(localStorage.getItem("filter"), "active");
  assert.equal(sessionStorage.getItem("draft"), "keep");
  assert.ok(sessionStorage.getItem("loginAt"));
  app.window.saveAuthSession({ token: "remembered", username: "admin", role: "admin", remember: true });
  assert.equal(sessionStorage.getItem("authToken"), null);
  assert.equal(localStorage.getItem("authToken"), "remembered");
  assert.equal(localStorage.getItem("rememberLogin"), "true");
  app.window.clearAuthSession();
  assert.equal(localStorage.getItem("authToken"), null);
  assert.equal(localStorage.getItem("rememberLogin"), null);
  assert.equal(localStorage.getItem("theme"), "light");
});

test("fetch preserves Request headers and adds credentials without mutating init", async () => {
  const app = loadApp({ local: { authToken: "token", userRole: "admin" } });
  const request = new Request("https://test.example/api/v1/patchpanels", {
    method: "PUT", headers: { "Content-Type": "application/json", "X-Trace": "request" },
    body: '{"name":"panel"}',
  });
  const init = Object.freeze({ cache: "no-store" });
  await app.window.fetch(request, init);
  assert.equal(app.calls[0].input, request);
  assert.equal(app.calls[0].init.headers.get("Content-Type"), "application/json");
  assert.equal(app.calls[0].init.headers.get("X-Trace"), "request");
  assert.equal(app.calls[0].init.headers.get("Authorization"), "Bearer token");
  assert.equal(app.calls[0].init.cache, "no-store");
  assert.equal(init.headers, undefined);
});

test("viewer writes are blocked for Request objects and auth text in query strings", async () => {
  const app = loadApp({ local: { authToken: "viewer-token", userRole: "viewer" } });
  await assert.rejects(app.window.fetch(new Request("https://test.example/api/v1/patchpanels", {
    method: "DELETE",
  })), /read-only/);
  await assert.rejects(app.window.fetch("/api/v1/patchpanels?q=/auth/", {
    method: "DELETE",
  }), /read-only/);
  assert.equal(app.calls.length, 0);
  await app.window.fetch("/auth/change-password", { method: "POST" });
  assert.equal(app.calls.length, 1);
});

test("legacy tech roles can still write", async () => {
  const app = loadApp({ local: { authToken: "token", userRole: " Tech " } });
  await app.window.fetch("/api/v1/patchpanels", { method: "POST" });
  assert.equal(app.calls.length, 1);
});

test("third-party and non-API requests are not given app credentials or write guards", async () => {
  const app = loadApp({ local: { authToken: "secret", userRole: "viewer" } });
  const init = { method: "POST", headers: { "X-Trace": "external" } };
  for (const url of ["https://external.example/auth/login", "/frontend/example", "/api/v10/example"]) {
    await app.window.fetch(url, init);
  }
  for (const call of app.calls) {
    assert.equal(call.init, init);
    assert.equal(new Headers(call.init.headers).has("Authorization"), false);
  }
});

test("expired API sessions are cleared and redirected without deleting preferences", async () => {
  const app = loadApp({
    url: "https://test.example/frontend/dashboard.html",
    local: { authToken: "expired", userRole: "admin", theme: "light" },
    respond: async () => new Response(null, { status: 401 }),
  });
  const response = await app.window.fetch("/api/v1/dashboard/stats");
  assert.equal(response.status, 401);
  assert.equal(app.context.localStorage.getItem("authToken"), null);
  assert.equal(app.context.localStorage.getItem("theme"), "light");
  assert.equal(app.window.location.href, "https://test.example/frontend/login.html");
});

test("login failures and explicit other credentials do not clear an existing session", async () => {
  const app = loadApp({
    local: { authToken: "existing", userRole: "admin" },
    respond: async () => new Response(null, { status: 401 }),
  });
  await app.window.fetch("/auth/login", { method: "POST" });
  assert.equal(app.calls[0].init.headers.has("Authorization"), false);
  await app.window.fetch("/auth/me", { headers: { Authorization: "Bearer other" } });
  assert.equal(app.calls[1].init.headers.get("Authorization"), "Bearer other");
  assert.equal(app.context.localStorage.getItem("authToken"), "existing");
});

test("a late unauthorized response cannot log out a newer session", async () => {
  let finish;
  const app = loadApp({
    local: { authToken: "old", userRole: "admin" },
    respond: () => new Promise(resolve => { finish = resolve; }),
  });
  const pending = app.window.fetch("/auth/me");
  app.window.saveAuthSession({ token: "new", username: "new-user" });
  finish(new Response(null, { status: 401 }));
  await pending;
  assert.equal(app.context.sessionStorage.getItem("authToken"), "new");
});

function loadLogin(options) {
  const app = loadApp(options);
  assert.ok(loginScript, "the actual login script must be executed");
  vm.runInContext(loginScript, app.context);
  app.element("username").value = "new-user";
  app.element("password").value = "test-password";
  return app;
}

test("login without remember removes a previously remembered user's token", async () => {
  const app = loadLogin({
    local: { authToken: "old-admin", username: "admin", userRole: "admin", rememberLogin: "true" },
    respond: async () => Response.json({ access_token: "new-token", role: "viewer" }),
  });
  await app.element("loginForm").submit({ preventDefault() {} });
  assert.equal(app.context.localStorage.getItem("authToken"), null);
  assert.equal(app.context.sessionStorage.getItem("authToken"), "new-token");
  assert.equal(app.context.sessionStorage.getItem("username"), "new-user");
  assert.equal(app.context.sessionStorage.getItem("userRole"), "viewer");
});

for (const [status, message] of [[401, /Falscher Benutzername/], [503, /HTTP 503/]]) {
  test(`login displays the actual failure category for HTTP ${status}`, async () => {
    const app = loadLogin({ respond: async () => new Response(null, { status }) });
    await app.element("loginForm").submit({ preventDefault() {} });
    assert.match(app.element("errorText").textContent, message);
    assert.equal(app.element("loginBtn").disabled, false);
  });
}

test("network failures are not reported as incorrect passwords", async () => {
  const app = loadLogin({ respond: async () => { throw new TypeError("Failed to fetch"); } });
  await app.element("loginForm").submit({ preventDefault() {} });
  assert.match(app.element("errorText").textContent, /Server nicht erreichbar/);
});

test("an expired stored token stays on login rather than looping to the dashboard", async () => {
  const app = loadLogin({
    local: { authToken: "expired" },
    respond: async () => new Response(null, { status: 401 }),
  });
  await app.events.get("DOMContentLoaded")();
  assert.equal(app.window.location.pathname, "/frontend/login.html");
  assert.equal(app.context.localStorage.getItem("authToken"), null);
  assert.equal(app.element("loginBtn").disabled, false);
});

test("session validation blocks duplicate logins and cannot overwrite a newer session", async () => {
  let finish;
  const app = loadLogin({
    local: { authToken: "old", username: "old-user" },
    respond: () => new Promise(resolve => { finish = resolve; }),
  });
  const checking = app.events.get("DOMContentLoaded")();
  await app.element("loginForm").submit({ preventDefault() {} });
  assert.equal(app.calls.length, 1);
  app.window.saveAuthSession({ token: "new", username: "new-user" });
  finish(Response.json({ username: "old-user", role: "viewer" }));
  await checking;
  assert.equal(app.context.sessionStorage.getItem("authToken"), "new");
  assert.equal(app.context.sessionStorage.getItem("username"), "new-user");
});

test("forced password change survives reloading login and clears after successful change", async () => {
  const app = loadLogin({
    session: { authToken: "temporary", username: "new-user", userRole: "viewer" },
    respond: async input => String(input).endsWith("/auth/me")
      ? Response.json({ username: "new-user", role: "viewer", permissions: [], force_password_change: true })
      : Response.json({ access_token: "permanent", role: "viewer", permissions: [] }),
  });
  await app.events.get("DOMContentLoaded")();
  assert.equal(app.window.location.pathname, "/frontend/login.html");
  assert.equal(app.context.sessionStorage.getItem("forcePasswordChange"), "true");
  assert.match(app.element("loginCard").innerHTML, /pwChangeForm/);
  app.element("currentPw").value = "temporary-password";
  app.element("newPw").value = "new-password";
  app.element("confirmPw").value = "new-password";
  await app.element("pwChangeForm").submit({ preventDefault() {} });
  assert.equal(app.context.sessionStorage.getItem("authToken"), "permanent");
  assert.equal(app.context.sessionStorage.getItem("forcePasswordChange"), "false");
  assert.equal(app.context.localStorage.getItem("authToken"), null);
});

function loadNavigation(options) {
  const app = loadApp({ url: "https://test.example/frontend/dashboard.html", ...options });
  const handlers = new Map();
  const userBox = {
    innerHTML: "",
    querySelector(selector) { return app.element(selector); },
  };
  const logout = app.element("logoutBtn");
  const loginAt = app.element("loginAt");
  app.context.document = {
    body: { classList: { add() {}, remove() {} }, dataset: {} },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    getElementById(id) {
      return { userBox, logoutBtn: logout, loginAt }[id] || null;
    },
    addEventListener(event, handler) { handlers.set(event, handler); },
  };
  vm.runInContext(fs.readFileSync(path.join(frontend, "nav-auth.js"), "utf8"), app.context);
  handlers.get("DOMContentLoaded")();
  return { ...app, userBox, logout, loginAt };
}

test("navigation renders names as text and displays session-only login times", () => {
  const username = '<img src=x onerror="unexpected()">';
  const app = loadNavigation({
    session: { authToken: "token", username, userRole: "viewer", loginAt: "2026-09-16T10:00:00Z" },
  });
  assert.equal(app.element(".ub-name").textContent, username);
  assert.doesNotMatch(app.userBox.innerHTML, /<img/);
  assert.match(app.loginAt.textContent, /16\.09\.2026/);
});

test("logout removes authentication only, preserving saved filters and theme", () => {
  const app = loadNavigation({
    local: { authToken: "token", userRole: "admin", theme: "light", filter: "FR2" },
    session: { draft: "keep" },
  });
  app.logout.click({ preventDefault() {} });
  assert.equal(app.context.localStorage.getItem("authToken"), null);
  assert.equal(app.context.localStorage.getItem("theme"), "light");
  assert.equal(app.context.localStorage.getItem("filter"), "FR2");
  assert.equal(app.context.sessionStorage.getItem("draft"), "keep");
  assert.equal(app.window.location.pathname, "/frontend/login.html");
});

test("protected pages return unfinished password changes to login", () => {
  const app = loadNavigation({
    session: { authToken: "temporary", forcePasswordChange: "true", userRole: "viewer" },
  });
  assert.equal(app.window.location.pathname, "/frontend/login.html");
  assert.equal(app.context.sessionStorage.getItem("authToken"), "temporary");
});
