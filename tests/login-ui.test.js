const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const repoRoot = path.resolve(__dirname, "..");
const loginSource = fs.readFileSync(path.join(repoRoot, "frontend", "login.html"), "utf8");
const visualsSource = fs.readFileSync(
  path.join(repoRoot, "frontend", "login-visuals.js"),
  "utf8",
);

test("login keeps the existing authentication contract", () => {
  for (const id of ["loginForm", "username", "password", "remember", "loginBtn"]) {
    assert.match(loginSource, new RegExp(`id="${id}"`));
  }
  assert.match(loginSource, /fetch\(`\$\{API_ORIGIN\}\/auth\/login`/);
  assert.match(loginSource, /localStorage\.setItem\('authToken'/);
  assert.match(loginSource, /sessionStorage\.setItem\('authToken'/);
  assert.match(loginSource, /showPasswordChangeDialog/);
});

test("login presents the animated trading and connection scene", () => {
  assert.match(loginSource, /id="marketCanvas"/);
  assert.match(loginSource, /class="market-tape top"/);
  assert.match(loginSource, /Live Infrastructure Market/);
  assert.match(loginSource, /Live Connection Flow/);
  assert.match(loginSource, /RFRA3233/);
  assert.match(loginSource, /BB IN/);
  assert.match(loginSource, /BB OUT/);
  assert.match(loginSource, /src="login-visuals\.js"/);
});

test("background animation is local, theme-aware and reduced-motion safe", () => {
  assert.match(visualsSource, /requestAnimationFrame/);
  assert.match(visualsSource, /prefers-reduced-motion: reduce/);
  assert.match(visualsSource, /classList\.contains\("light-mode"\)/);
  assert.match(visualsSource, /drawCandles/);
  assert.match(visualsSource, /drawMarketLine/);
  assert.match(visualsSource, /drawNetwork/);
  assert.doesNotMatch(visualsSource, /fetch\s*\(/);
});

test("login scene collapses to the form on smaller screens", () => {
  assert.match(loginSource, /@media \(max-width: 960px\)/);
  assert.match(loginSource, /\.login-story \{ display:none; \}/);
  assert.match(loginSource, /@media \(prefers-reduced-motion: reduce\)/);
});
