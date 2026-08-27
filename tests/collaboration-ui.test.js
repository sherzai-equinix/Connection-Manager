const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const repoRoot = path.resolve(__dirname, "..");
const collaborationSource = fs.readFileSync(
  path.join(repoRoot, "frontend", "collaboration.js"),
  "utf8",
);
const stylesSource = fs.readFileSync(
  path.join(repoRoot, "frontend", "styles.css"),
  "utf8",
);

test("presence indicator is docked in the bottom navigation", () => {
  assert.match(collaborationSource, /querySelector\("\.bottom-dock"\)/);
  assert.match(collaborationSource, /bottomDock\.append\(presence\)/);
  assert.match(collaborationSource, /classList\.add\("live-presence-docked"\)/);
  assert.match(
    stylesSource,
    /\.live-presence\.live-presence-docked\s*\{[^}]*position:\s*static;/s,
  );
});

test("presence indicator keeps a body fallback for pages without a dock", () => {
  assert.match(
    collaborationSource,
    /if \(bottomDock\)[\s\S]*else \{\s*document\.body\.append\(presence\);/,
  );
});
