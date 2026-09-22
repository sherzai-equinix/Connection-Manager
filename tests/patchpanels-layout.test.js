const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..", "frontend");
const html = fs.readFileSync(path.join(root, "patchpanels.html"), "utf8");
const source = fs.readFileSync(path.join(root, "patchpanels.js"), "utf8");
const styles = fs.readFileSync(path.join(root, "styles.css"), "utf8");

test("patchpanel explorer has a branded overview and live inventory metrics", () => {
  assert.match(html, /class="pp-title-icon"/);
  assert.match(html, /id="ppMetricTotal"/);
  assert.match(html, /id="ppMetricFree"/);
  assert.match(html, /id="ppMetricOccupied"/);
  assert.match(html, /id="ppMetricShown"/);
  assert.match(source, /function updateOverview\(\)/);
  assert.match(source, /updateOverview\(\);/);
});

test("patchpanel explorer keeps search and filter reset controls", () => {
  assert.match(html, /id="ppSearch"/);
  assert.match(html, /id="btnClearPpFilters"/);
  assert.match(source, /S\.sidebarFilter=null/);
  assert.match(source, /S\.searchQuery=""/);
});

test("patchpanel cards show category and utilization context", () => {
  assert.match(source, /class="pp-card-meta"/);
  assert.match(source, /class="pp-card-category"/);
  assert.match(source, /class="pp-card-util"/);
  assert.match(styles, /\.pp-card-meta/);
  assert.match(styles, /\.pp-metric-accent/);
});
