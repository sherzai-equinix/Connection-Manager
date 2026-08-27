const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const repoRoot = path.resolve(__dirname, "..");
const navSource = fs.readFileSync(path.join(repoRoot, "frontend", "nav-auth.js"), "utf8");
const stylesSource = fs.readFileSync(path.join(repoRoot, "frontend", "styles.css"), "utf8");
const crossConnectSource = fs.readFileSync(
  path.join(repoRoot, "frontend", "cross-connects.html"),
  "utf8",
);

const decoratedPages = [
  "dashboard.html",
  "kw-planning.html",
  "troubleshooting.html",
  "patchpanels.html",
  "historical-archive.html",
  "migration-audit.html",
  "admin.html",
];

test("every primary page has a configured branded heading", () => {
  for (const page of decoratedPages) {
    assert.match(navSource, new RegExp(`'${page.replace(".", "\\.")}'\\s*:`));
    const pageSource = fs.readFileSync(path.join(repoRoot, "frontend", page), "utf8");
    assert.match(pageSource, /<script src="nav-auth\.js"><\/script>/);
  }
  assert.match(crossConnectSource, /class="cc-title-icon"/);
  assert.match(navSource, /enhancePageHero\(\);/);
  assert.match(navSource, /<h1 class="page-hero-title">/);
});

test("shared heading system uses the blue-teal icon palette", () => {
  assert.match(stylesSource, /\.page-hero-card\s*\{/);
  assert.match(stylesSource, /\.page-hero-brand\s*\{/);
  assert.match(stylesSource, /\.page-hero-icon\s*\{/);
  assert.match(stylesSource, /linear-gradient\(145deg, #2563eb, #0ea5a4\)/);
  assert.match(stylesSource, /body\.light-mode \.page-hero-card/);
});

test("each page heading has its own icon and section label", () => {
  for (const label of [
    "Operations",
    "Einsatzplanung",
    "Leitungskorrektur",
    "Infrastruktur",
    "Historie",
    "Datenqualität",
    "Systemverwaltung",
  ]) {
    assert.match(navSource, new RegExp(`kicker: '${label}'`));
  }
  assert.match(navSource, /config\.icon/);
});
