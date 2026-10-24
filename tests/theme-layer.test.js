const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..", "frontend");
const css = fs.readFileSync(path.join(root, "theme.css"), "utf8");
const js = fs.readFileSync(path.join(root, "theme.js"), "utf8");

test("theme layer remaps the legacy design tokens instead of replacing styles.css", () => {
  for (const token of ["--border: var(--cm-line)", "--muted: var(--cm-muted)", "--heading: var(--cm-text)"]) {
    assert.ok(css.includes(token), `token mapping missing: ${token}`);
  }
  assert.match(css, /body\.light-mode\s*\{/);
  assert.match(css, /prefers-reduced-motion/);
});

test("navigation renders as a patch panel with LEDs and a backend status light", () => {
  assert.match(css, /\.bottom-dock \.dock-item::before/);
  assert.match(css, /\.dock-item\.is-active::before/);
  assert.match(css, /\.cm-health\[data-state="ok"\]/);
  assert.match(css, /\.cm-health\[data-state="down"\]/);
  assert.match(js, /\/health\/ready/);
  assert.match(js, /classList\.add\("is-active"\)/);
});

test("keyboard shortcut jumps to the page search field without touching page logic", () => {
  assert.match(js, /toLowerCase\(\) === "k"/);
  assert.match(js, /findSearchInput/);
  assert.doesNotMatch(js, /window\.fetch\s*=/, "theme.js must not monkey-patch fetch");
});

test("every frontend page except login.html loads the theme layer after styles.css", () => {
  const pages = fs
    .readdirSync(root)
    .filter((f) => f.endsWith(".html") && f !== "login.html")
    .sort();
  assert.ok(pages.length > 0, "no frontend pages found");
  for (const page of pages) {
    const html = fs.readFileSync(path.join(root, page), "utf8");
    const stylesAt = html.search(/href=["']styles\.css["']/);
    const themeAt = html.search(/href=["']theme\.css["']/);
    assert.ok(themeAt > -1, `${page}: theme.css not linked (run: python scripts/apply_theme.py)`);
    assert.ok(stylesAt > -1 && themeAt > stylesAt, `${page}: theme.css must come after styles.css`);
    assert.match(html, /<script src=["']theme\.js["']><\/script>/, `${page}: theme.js not loaded`);
  }
});
