const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const html = fs.readFileSync(path.join(__dirname, "..", "frontend", "migration-audit.html"), "utf8");
const source = fs.readFileSync(path.join(__dirname, "..", "frontend", "migration-audit.js"), "utf8");

test("migration audit uses compact line lists for every conflict category", () => {
  assert.equal((html.match(/class="audit-line-list"/g) || []).length, 3);
  assert.match(html, /\.audit-line-summary/);
  assert.match(html, /\.audit-line-path/);
  assert.match(source, /_auditProblemNote/);
  assert.doesNotMatch(source, /data-action="toggle-line"/);
});

test("audit line cards show the complete RFRA to customer path", () => {
  assert.match(source, /_auditNode\("RFRA \/ A-PP"/);
  assert.match(source, /_auditNode\("BB IN"/);
  assert.match(source, /_auditNode\("BB OUT"/);
  assert.match(source, /_auditNode\("Kunde \/ PP"/);
  assert.match(source, /audit-problem-note/);
});

test("audit card output escapes user-controlled connection fields", () => {
  assert.match(source, /esc\(it\.serial_number/);
  assert.match(source, /esc\(_auditCustomer\(it\)\)/);
  assert.match(source, /esc\(value \|\| "Nicht erfasst"\)/);
  assert.match(source, /_auditProblemNote\(it\)/);
});

test("audit cards include location and customer patchpanel context", () => {
  assert.match(source, /audit-line-customer/);
  assert.doesNotMatch(source, /_auditLocation\(it\)/);
  assert.match(source, /return systemName \|\| it\.customer_name/);
});
