const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const repoRoot = path.resolve(__dirname, "..");
const htmlSource = fs.readFileSync(
  path.join(repoRoot, "frontend", "cross-connects.html"),
  "utf8",
);
const frontendSource = fs.readFileSync(
  path.join(repoRoot, "frontend", "cross-connects.js"),
  "utf8",
);
const backendSource = fs.readFileSync(
  path.join(repoRoot, "routers", "kw_flow.py"),
  "utf8",
);

const browserContext = {
  window: { API_ROOT: "/api/v1" },
  document: {
    getElementById() { return null; },
    addEventListener() {},
  },
  URL,
  URLSearchParams,
  setTimeout,
};
vm.createContext(browserContext);
vm.runInContext(
  `${frontendSource}\nthis.__crossConnectUi = { aSideCell, zSideCell, detailHtml, customerText, formatCustomerDisplay, badge };`,
  browserContext,
);

test("cross-connect preview only shows serial, customer, A-side, Z-side and status", () => {
  const tableHead = htmlSource.slice(
    htmlSource.indexOf('<table class="table-list-table'),
    htmlSource.indexOf("</thead>"),
  );
  for (const heading of ["Serial", "Kunde", "A-Seite", "Z-Seite", "Status"]) {
    assert.match(tableHead, new RegExp(`>${heading}<`));
  }
  assert.doesNotMatch(tableHead, />RFRA Switch</);
  assert.doesNotMatch(tableHead, />BB IN</);
  assert.doesNotMatch(tableHead, />BB OUT</);
  assert.match(frontendSource, /<td colspan="6">\$\{detailHtml\(item\)\}<\/td>/);
});

test("expanded cross-connect shows only the RFRA to backbone path", () => {
  const detailStart = frontendSource.indexOf("function detailHtml(item)");
  const renderStart = frontendSource.indexOf("function renderRows()", detailStart);
  const detailBlock = frontendSource.slice(detailStart, renderStart);

  assert.match(detailBlock, /pathNode\("RFRA Switch \/ Port"/);
  assert.match(detailBlock, /pathNode\("BB IN \/ Port"/);
  assert.match(detailBlock, /pathNode\("BB OUT \/ Port"/);
  assert.doesNotMatch(detailBlock, /A-Patchpanel|Z-Patchpanel|Deinstalliert|Urspr\. angelegt/);
  assert.match(detailBlock, /connection-path/);
});

test("preview and path render the expected endpoint values", () => {
  const item = {
    a_side: { pp: "PP:0102:1071240", port: "5A2" },
    z_side: { room: "4.5", rack: "0104", pp: "PP:0104:1405593", port: "1A2" },
    switch_name: "RFRA3233",
    switch_port: "ETH1/2",
    bb_in: { pp: "5.4S6/RU36", port: "2B4" },
    bb_out: { pp: "4.5/RU42", port: "2B4" },
  };

  const aSide = browserContext.__crossConnectUi.aSideCell(item);
  const zSide = browserContext.__crossConnectUi.zSideCell(item);
  const pathView = browserContext.__crossConnectUi.detailHtml(item);

  assert.match(aSide, /PP:0102:1071240/);
  assert.match(aSide, /Port 5A2/);
  assert.match(zSide, /PP:0104:1405593/);
  assert.match(zSide, /4\.5 \/ 0104 · Port 1A2/);
  assert.match(pathView, /RFRA3233/);
  assert.match(pathView, /ETH1\/2/);
  assert.match(pathView, /5\.4S6\/RU36/);
  assert.match(pathView, /4\.5\/RU42/);
  assert.match(pathView, /path-node-rfra/);
  assert.match(pathView, /path-node-bb-in/);
  assert.match(pathView, /path-node-bb-out/);
});

test("active and archived lines expose the same BB IN and BB OUT orientation", () => {
  const activeStart = backendSource.indexOf("def list_cross_connects_minimal(");
  const archiveStart = backendSource.indexOf("def list_archived_cross_connects(");
  const nextRoute = backendSource.indexOf("@router.get", archiveStart + 20);
  const activeBlock = backendSource.slice(activeStart, archiveStart);
  const archiveBlock = backendSource.slice(archiveStart, nextRoute);

  assert.match(activeBlock, /_swap_backbone_fields\(line\)/);
  assert.match(archiveBlock, /r = _swap_backbone_fields\(r\) or r/);
});

test("customer preview removes only a duplicated site and location prefix", () => {
  const { formatCustomerDisplay } = browserContext.__crossConnectUi;

  assert.equal(
    formatCustomerDisplay("FR2:M5.12:FR2:EG-M5.12:S1:SUSQUEHANNA"),
    "FR2:EG-M5.12:S1:SUSQUEHANNA",
  );
  assert.equal(
    formatCustomerDisplay("FR2:M1A2:FR2:OG-M1A2:OC:DRW HOLDINGS"),
    "FR2:OG-M1A2:OC:DRW HOLDINGS",
  );
  assert.equal(
    formatCustomerDisplay("FR2:OG-M4.5:S1:TOWER RESEARCH CAPITAL"),
    "FR2:OG-M4.5:S1:TOWER RESEARCH CAPITAL",
  );
});

test("cross-connect header groups title, metrics, search and actions", () => {
  assert.match(htmlSource, /class="card cc-hero"/);
  assert.match(htmlSource, /class="cc-hero-stats" id="statStrip"/);
  assert.match(htmlSource, /class="cc-search-box"/);
  assert.match(htmlSource, /class="cc-controls"/);
});

test("active status is localized and uses the dedicated status design", () => {
  const activeBadge = browserContext.__crossConnectUi.badge("active");

  assert.match(activeBadge, />Aktiv</);
  assert.doesNotMatch(activeBadge, />active</);
  assert.match(activeBadge, /cc-status-badge/);
  assert.match(htmlSource, /\.cc-status-badge\.badge-success/);
});

test("light mode and expanded path use the blue-teal logo palette", () => {
  assert.match(htmlSource, /<body class="cross-connects-page">/);
  assert.match(htmlSource, /body\.light-mode\.cross-connects-page/);
  assert.match(htmlSource, /path-node-rfra/);
  assert.match(htmlSource, /path-node-bb-in/);
  assert.match(htmlSource, /path-node-bb-out/);
  assert.match(htmlSource, /#2563eb/);
  assert.match(htmlSource, /#0ea5a4/);
});

test("status filter is rendered as one select box without an outer box", () => {
  assert.match(htmlSource, /\.cc-filter\{[^}]*background:transparent;/);
  assert.match(htmlSource, /\.cc-filter \.select\{[^}]*border:1px solid/);
  assert.doesNotMatch(htmlSource, /\.cc-filter\{[^}]*border:1px solid/);
});
