const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");

const repoRoot = path.resolve(__dirname, "..");
const frontendSource = fs.readFileSync(
  path.join(repoRoot, "frontend", "kw-planning.js"),
  "utf8",
);

function loadFrontendHelpers() {
  const context = {
    console,
    window: {
      API_ROOT: "/api/v1",
      addEventListener() {},
    },
    document: {
      addEventListener() {},
      getElementById() { return null; },
      querySelectorAll() { return []; },
      visibilityState: "visible",
    },
    localStorage: { getItem() { return null; } },
    sessionStorage: { getItem() { return null; } },
    setTimeout() { return 0; },
    clearTimeout() {},
    fetch: async () => ({ ok: true, json: async () => ({}) }),
  };
  vm.createContext(context);
  vm.runInContext(
    frontendSource +
      "\nglobalThis.__accessTest = { state, buildRestrictionIndexes, restrictionBadges, restrictionTypeMeta, customerMatchScore, formatCustomerDisplay, resolveAffectedRestrictedCustomers };",
    context,
  );
  return context.__accessTest;
}

test("indexes restrictions by exact KW change ID and request status", () => {
  const helpers = loadFrontendHelpers();
  const restricted = [
    {
      id: 11,
      name: "Customer A",
      restriction_type: "access_approval",
      affected_targets: [
        { change_id: 101, change_type: "NEW_INSTALL" },
        { change_id: 103, change_type: "PATH_MOVE", target_role: "line_a" },
      ],
    },
    {
      id: 12,
      name: "Customer B",
      restriction_type: "specific_time",
      affected_targets: [
        { change_id: 102, change_type: "LINE_MOVE" },
        { change_id: 103, change_type: "PATH_MOVE", target_role: "line_b" },
        { change_id: 103, change_type: "PATH_MOVE", target_role: "line_b" },
      ],
    },
  ];

  const result = helpers.buildRestrictionIndexes(restricted, [{ customer_id: 11 }]);

  assert.equal(result.customerMap.get(11).approved, true);
  assert.equal(result.customerMap.get(12).approved, false);
  assert.deepEqual(Array.from(result.changeMap.keys()), [101, 103, 102]);
  assert.equal(result.changeMap.get(101)[0].name, "Customer A");
  assert.equal(result.changeMap.get(102)[0].type, "specific_time");
  assert.deepEqual(
    Array.from(result.changeMap.get(103), item => item.id),
    [11, 12],
    "a Path Move can show both restricted customers without duplicates",
  );
});

test("renders red pending and green requested icons beside a change", () => {
  const helpers = loadFrontendHelpers();
  const result = helpers.buildRestrictionIndexes([
    {
      id: 21,
      name: "Needs Approval",
      restriction_type: "access_approval",
      affected_targets: [{ change_id: 500, change_type: "PATH_MOVE" }],
    },
    {
      id: 22,
      name: "Timed Access",
      restriction_type: "specific_time",
      affected_targets: [{ change_id: 500, change_type: "PATH_MOVE" }],
    },
  ], [{ customer_id: 21 }]);
  helpers.state.restrictionsByChange = result.changeMap;

  const html = helpers.restrictionBadges({ id: 500, type: "PATH_MOVE" });

  assert.match(html, /restricted-badge approved/);
  assert.match(html, /restricted-badge pending/);
  assert.match(html, /Needs Approval/);
  assert.match(html, /Bestimmte Uhrzeit/);
  assert.equal((html.match(/data-customer-id=/g) || []).length, 2);
});

test("backend query covers install, line move, and both path-move lines", () => {
  const backendSource = fs.readFileSync(
    path.join(repoRoot, "routers", "access_restrictions.py"),
    "utf8",
  );

  assert.match(backendSource, /kc\.type IN \('NEW_INSTALL', 'LINE_MOVE'\)/);
  assert.match(backendSource, /kc\.type = 'PATH_MOVE'/);
  assert.match(backendSource, /'line_a'::TEXT/);
  assert.match(backendSource, /'line_b'::TEXT/);
  assert.match(backendSource, /'change_id', change_id/);
  assert.match(backendSource, /c\.id = pi\.customer_id/);
});

test("legacy patchpanels without customer_id fall back to a bounded system-name match", () => {
  const backendSource = fs.readFileSync(
    path.join(repoRoot, "routers", "access_restrictions.py"),
    "utf8",
  );

  assert.match(backendSource, /AS customer_hint/);
  assert.match(backendSource, /pi\.customer_id IS NULL/);
  assert.match(backendSource, /RIGHT\(/);
  assert.match(backendSource, /'customer_match_source', customer_match_source/);
});

test("visible KW customer name detects a restriction despite duplicated location prefixes", () => {
  const helpers = loadFrontendHelpers();
  const lineCustomer = "FR2:M5.12:FR2:EG-M5.12:S1:SUSQUEHANNA";

  assert.ok(helpers.customerMatchScore(lineCustomer, "FR2:EG-M5.12:S1:SUSQUEHANNA") > 0);
  assert.ok(helpers.customerMatchScore(lineCustomer, "FR2:01:005090:SUSQUEHANNA") > 0);
  assert.ok(helpers.customerMatchScore(
    lineCustomer,
    "FR2:OG:0512S1:Susquehanna International Securities Ltd",
  ) > 0);
  assert.equal(helpers.customerMatchScore(lineCustomer, "Aardvark Trading LLC"), 0);
});

test("customer display removes a duplicated site/location prefix", () => {
  const helpers = loadFrontendHelpers();
  assert.equal(
    helpers.formatCustomerDisplay("FR2:M5.12:FR2:EG-M5.12:S1:SUSQUEHANNA"),
    "FR2:EG-M5.12:S1:SUSQUEHANNA",
  );
  assert.equal(
    helpers.formatCustomerDisplay("FR2:EG-M5.12:S1:SUSQUEHANNA"),
    "FR2:EG-M5.12:S1:SUSQUEHANNA",
  );
});

test("client fallback attaches the restricted customer to the exact install row", () => {
  const helpers = loadFrontendHelpers();
  const affected = helpers.resolveAffectedRestrictedCustomers([
    { id: 77, name: "FR2:OG:0512S1:Susquehanna International Securities Ltd", restriction_type: "access_approval" },
    { id: 88, name: "Aardvark Trading LLC", restriction_type: "announcement" },
  ], [], [{
    id: 9001,
    type: "NEW_INSTALL",
    status: "planned",
    payload_json: {
      new_line: {
        system_name: "FR2:M5.12:FR2:EG-M5.12:S1:SUSQUEHANNA",
        customer_patchpanel_id: 42,
        customer_patchpanel_instance_id: "PP:0607:1370187",
      },
    },
  }]);

  assert.equal(affected.length, 1);
  assert.equal(affected[0].id, 77);
  assert.equal(affected[0].affected_targets[0].change_id, 9001);
  assert.equal(affected[0].affected_targets[0].customer_match_source, "change_customer_name");
});

test("access API errors are visible instead of silently hiding the panel", () => {
  assert.match(frontendSource, /Zugangsbeschränkungen konnten nicht geladen werden/);
  assert.match(frontendSource, /class="access-load-error"/);
});

test("placeholder access URL cannot falsely mark a request as sent", () => {
  assert.match(frontendSource, /!\/PLACEHOLDER\|example\\\.com\/i\.test\(ACCESS_APP_URL\)/);
  assert.match(frontendSource, /if \(hasConfiguredAccessApp\)/);
});
