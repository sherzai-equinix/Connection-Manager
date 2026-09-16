const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "..", "frontend", "patchpanels.js"), "utf8");

function loadActions({ status = 200, detail, networkError = false, confirmed = true } = {}) {
  const buttons = {};
  const toasts = [];
  const reloads = [];
  const closes = [];
  const calls = [];
  const S = { slotA: { id: 12, panel: { name: "Test panel" } }, slotB: { id: 13 } };
  const context = vm.createContext({
    S, API: "/api/v1/patchpanels",
    wrap: {
      querySelectorAll(selector) {
        const button = {
          dataset: { cass: "1A", slot: "A" }, disabled: false, textContent: "",
          addEventListener(event, handler) { this[event] = handler; },
        };
        buttons[selector] = button;
        return [button];
      },
    },
    confirm: () => confirmed,
    toast: (message, type) => toasts.push({ message, type }),
    loadSlot: async (...args) => reloads.push(args),
    loadAll: async () => reloads.push(["all"]),
    closeSlot: slot => { closes.push(slot); S.slotA.id = null; },
    fetch: async (url, init) => {
      calls.push({ url, init });
      if (networkError) throw new TypeError("Network unavailable");
      return detail === undefined
        ? new Response(status === 204 ? null : "<html>Service unavailable</html>", { status })
        : Response.json({ detail }, { status });
    },
  });
  const helper = source.match(/^async function api\(.*$/m);
  const postHelper = source.match(/^async function apiPost\(.*$/m);
  const handlers = Array.from(source.matchAll(
    /wrap\.querySelectorAll\("\.pp-cass-(?:release|lock)-btn"\)\.forEach\(b=>\{[\s\S]*?^  \}\);/gm,
  ), match => match[0]);
  const deleteHandler = source.match(/^async function doDeinstallPp\(\)\{[\s\S]*?^\}/m);
  assert.ok(helper && postHelper && deleteHandler, "execute the real API and delete functions");
  assert.equal(handlers.length, 2, "execute both real cassette event-handler registrations");
  vm.runInContext([helper[0], postHelper[0], ...handlers, deleteHandler[0]].join("\n"), context);
  return { context, buttons, toasts, reloads, closes, calls, S };
}

for (const action of ["release", "lock"]) {
  for (const status of [403, 409, 500, 503]) {
    test(`${action} HTTP ${status} shows an error, preserves state and restores the button`, async () => {
      const app = loadActions({ status, detail: status === 503 ? undefined : "Cannot change cassette" });
      const button = app.buttons[`.pp-cass-${action}-btn`];
      await button.click();
      assert.equal(app.calls[0].url, `/api/v1/patchpanels/12/cassette/1A/${action}`);
      assert.equal(app.calls[0].init.method, "PUT");
      assert.equal(app.toasts.length, 1);
      assert.equal(app.toasts[0].type, "error");
      assert.match(app.toasts[0].message, status === 503 ? /HTTP 503/ : /Cannot change cassette/);
      assert.equal(app.reloads.length, 0);
      assert.equal(app.S.slotA.id, 12);
      assert.equal(button.disabled, false);
      assert.equal(button.textContent, action === "release" ? "\uD83D\uDD13 Freigeben" : "\uD83D\uDD12");
    });
  }

  for (const status of [200, 204]) {
    test(`${action} HTTP ${status} confirms success and refreshes the correct slot`, async () => {
      const app = loadActions({ status, detail: status === 200 ? "Updated" : undefined });
      const button = app.buttons[`.pp-cass-${action}-btn`];
      button.dataset.slot = "B";
      await button.click();
      assert.equal(app.calls[0].url, `/api/v1/patchpanels/13/cassette/1A/${action}`);
      assert.equal(app.toasts[0].type, "success");
      assert.deepEqual(app.reloads, [["B", 13]]);
    });
  }

  test(`${action} network errors are visible and cancellation does not send requests`, async () => {
    const failed = loadActions({ networkError: true });
    await failed.buttons[`.pp-cass-${action}-btn`].click();
    assert.equal(failed.toasts[0].type, "error");
    assert.equal(failed.reloads.length, 0);
    assert.equal(failed.buttons[`.pp-cass-${action}-btn`].disabled, false);
    const cancelled = loadActions({ confirmed: false });
    await cancelled.buttons[`.pp-cass-${action}-btn`].click();
    assert.equal(cancelled.calls.length, 0);
    assert.equal(cancelled.toasts.length, 0);
  });
}

test("existing delete failure behavior preserves the selected patchpanel", async () => {
  const app = loadActions({ status: 409, detail: "Panel has active connections" });
  await app.context.doDeinstallPp();
  assert.equal(app.calls[0].init.method, "DELETE");
  assert.equal(app.S.slotA.id, 12);
  assert.equal(app.toasts[0].type, "error");
  assert.match(app.toasts[0].message, /Panel has active connections/);
  assert.equal(app.closes.length, 0);
  assert.equal(app.reloads.length, 0);
});

test("existing successful delete closes the slot and refreshes the list", async () => {
  const app = loadActions({ status: 200, detail: "Deleted" });
  await app.context.doDeinstallPp();
  assert.equal(app.toasts[0].type, "success");
  assert.deepEqual(app.closes, ["A"]);
  assert.deepEqual(app.reloads, [["all"]]);
});

test("the shared POST helper preserves JSON payloads and propagates API errors", async () => {
  const app = loadActions({ status: 422, detail: "Invalid panel" });
  await assert.rejects(app.context.apiPost("/api/v1/patchpanels", { name: "panel" }), /Invalid panel/);
  assert.equal(app.calls[0].init.method, "POST");
  assert.equal(app.calls[0].init.headers["Content-Type"], "application/json");
  assert.equal(app.calls[0].init.body, '{"name":"panel"}');
});
