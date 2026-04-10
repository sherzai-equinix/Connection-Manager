// connection.js — FIXED Step4 Patchpanel Listing via /zside/racks/{rack_id}/patchpanels
// config.js setzt window.API_* globals

// ✅ base url normalize (trailing slashes + auto "/zside" suffix)
const API_BASE = String(window.API_RACKVIEW || "").replace(/\/+$/, "");
const _Z = String(window.API_ZSIDE || "").replace(/\/+$/, "");
const ZSIDE_BASE = _Z.endsWith("/zside") ? _Z : (_Z + "/zside");
const CROSS_BASE = String(window.API_CROSSCONNECTS || "").replace(/\/+$/, ""); // ✅ NEW

const letters = ["A", "B", "C", "D"];
const positions = [1, 2, 3, 4, 5, 6];


function normalizeRoom(room) {
  if (!room) return "";
  let s = String(room).trim().toUpperCase().replace(/\s+/g, "");
  // strip leading 'M' for normalization, keep both variants
  if (s.startsWith("M") && s.length > 1) s = s.slice(1);
  // normalize 5.04S6 -> 5.4S6 (strip leading zeros in minor)
  const m = s.match(/^(\d+)\.(\d+)(S\d+)?$/i);
  if (m) {
    const major = m[1];
    const minor = String(parseInt(m[2], 10));
    const cage = m[3] || "";
    return `${major}.${minor}${cage}`;
  }
  return s;
}

const portsCache = new Map();
const roomsCache = { value: null };
const instancesByRoomCache = new Map();

let precabled = null;            // Step1
let precabledExisting = null;    // manual patch existiert schon?
let selectedTarget = null;       // Step2 geklickter Port
let currentTargetMeta = null;    // meta Step2 Panel
let step3Peer = null;            // Peer-Info vom Step2 Port (anderer Raum)
let uiLocked = false;            // wenn schon dokumentiert -> Step2 sperren

// ✅ NEW: Cross-Connect Master ID (verhindert doppelte Inserts)
let createdCrossConnectId = null;

// Step4 state
let step4Room = null;
let step4CustomerId = null;
let step4LocationId = null;

// ✅ FIX: use rack_id (robust), not rack_label filtering
let step4RackId = null;
let step4RackLabel = null;

let step4CustomerPPId = null;
let step4CustomerPortLabel = null;

// caches
let locationsById = new Map();   // id -> location object (cage_no etc.)
let racksById = new Map();       // id -> rack_label

// --------------------
// helpers
// --------------------
function $(id) { return document.getElementById(id); }

async function fetchJsonSafe(url, opts) {
  const res = await fetch(url, opts);
  const txt = await res.text();
  let data = null;
  try { data = JSON.parse(txt); } catch { data = null; }
  return { res, data, txt };
}

function setSelection(obj) {
  const el = $("selectionBox");
  if (el) el.textContent = JSON.stringify(obj, null, 2);
}

function fillSelect(selectEl, items, placeholder, getValue, getLabel) {
  if (!selectEl) return;
  selectEl.innerHTML = "";

  const ph = document.createElement("option");
  ph.value = "";
  ph.textContent = placeholder;
  selectEl.appendChild(ph);

  (items || []).forEach((it) => {
    const opt = document.createElement("option");
    opt.value = getValue(it);
    opt.textContent = getLabel(it);
    selectEl.appendChild(opt);
  });
}

function ensureSelectOption(selectEl, value, labelText) {
  if (!selectEl || !value) return;
  const hasOpt = Array.from(selectEl.options).some(o => o.value === value);
  if (!hasOpt) {
    const opt = document.createElement("option");
    opt.value = value;
    opt.textContent = labelText || value;
    selectEl.appendChild(opt);
  }
}

function clearHighlights(gridId) {
  const root = $(gridId);
  if (!root) return;
  root.querySelectorAll(".port-btn").forEach((b) => b.classList.remove("port-selected"));
}

function highlight(gridId, label) {
  const root = $(gridId);
  if (!root) return;
  const btn = root.querySelector(`.port-btn[data-label="${label}"]`);
  if (btn) btn.classList.add("port-selected");
}

// macht port definitiv "occupied-look" (grün + disabled)
function forceOccupiedStyle(gridId, label, titleText = "Belegt (aktive Leitung)") {
  const root = $(gridId);
  if (!root) return;

  const btn = root.querySelector(`.port-btn[data-label="${label}"]`);
  if (!btn) return;

  btn.classList.remove("port-selected");
  btn.classList.remove("port-available");
  btn.classList.add("port-connected");
  btn.disabled = true;
  btn.title = titleText;
}

// ✅ NEW: Create Cross-Connect Master Record in DB (pending_serial)
async function createCrossConnectFromCurrentState(extra = {}) {
  // prevent double create
  if (createdCrossConnectId) {
    return { ok: true, skipped: true, id: createdCrossConnectId };
  }

  if (!precabled || !selectedTarget || !step3Peer || !step4CustomerPPId || !step4CustomerPortLabel) {
    return { ok: false, error: "State incomplete (missing fields)" };
  }

  const payload = {
    // Step1
    switch_name: precabled.switch_name,
    switch_port: precabled.switch_port,
    a_patchpanel_id: precabled.patchpanel_id,
    a_port_label: precabled.patchpanel_port,

    // Step2
    backbone_out_instance_id: selectedTarget.instance_id,
    backbone_out_port_label: selectedTarget.port_label,

    // Step3
    backbone_in_instance_id: step3Peer.peer_instance_id,
    backbone_in_port_label: step3Peer.peer_port_label,

    // Step4
    customer_patchpanel_id: Number(step4CustomerPPId),
    customer_port_label: step4CustomerPortLabel,

    // optional refs
    manual_patch_id: extra.manual_patch_id ?? null,
    pp_connection_id: extra.pp_connection_id ?? null,

    // pending serial workflow
    status: "pending_serial",
    serial: null
  };

  const { res, data, txt } = await fetchJsonSafe(CROSS_BASE + "/create", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!res.ok || !data?.success) {
    const msg = data?.detail || data?.error || txt || ("HTTP " + res.status);
    return { ok: false, error: msg };
  }

  createdCrossConnectId = data.id;
  return { ok: true, id: data.id, status: data.status, serial: data.serial };
}

// --------------------
// ✅ NEW: Enable Cassette/Trunk (ZSide Step4)
// --------------------
async function zEnableCassettes(patchpanelId, slotCodes) {
  const url = ZSIDE_BASE + "/patchpanels/enable-cassettes";
  const { res, data, txt } = await fetchJsonSafe(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      patchpanel_id: Number(patchpanelId),
      slot_codes: slotCodes
    })
  });
  if (!res.ok) {
    const msg = data?.detail || data?.error || txt || ("HTTP " + res.status);
    throw new Error(msg);
  }
  return data;
}

function getDisabledCassettes(ports) {
  // disabled = alle Ports in Slot sind unavailable (nicht freigegeben)
  const bySlot = new Map(); // slot -> [statuses]
  (ports || []).forEach(p => {
    const label = p?.label || p?.port_label;
    const m = String(label || "").match(/^(\d+[A-D])\d+$/); // "1C1" -> "1C"
    if (!m) return;
    const slot = m[1];
    const st = String(p?.status || "").toLowerCase(); // free/unavailable/occupied/""
    if (!bySlot.has(slot)) bySlot.set(slot, []);
    bySlot.get(slot).push(st);
  });

  const disabled = [];
  for (const [slot, arr] of bySlot.entries()) {
    if (arr.length && arr.every(s => s === "unavailable" || s === "")) {
      disabled.push(slot);
    }
  }
  return disabled.sort();
}
// ============================
// ✅ Enable Cassette / Trunk (Customer PP)
// ============================
async function zEnableCassettes(patchpanelId, slotCodes) {
  const url = ZSIDE_BASE + "/patchpanels/enable-cassettes";
  const { res, data, txt } = await fetchJsonSafe(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      patchpanel_id: Number(patchpanelId),
      slot_codes: slotCodes
    })
  });

  if (!res.ok) {
    throw new Error(data?.detail || data?.error || txt || ("HTTP " + res.status));
  }
  return data;
}

function resetEnableCassetteUI() {
  const sel = $("enableCassetteSelect");
  const btn = $("enableCassetteBtn");
  const msg = $("enableCassetteMsg");

  if (sel) {
    sel.innerHTML = `<option value="">— erst Patchpanel wählen —</option>`;
    sel.disabled = true;
  }
  if (btn) btn.disabled = true;
  if (msg) msg.textContent = "";
}

// disabled = Slot wo ALLE Ports unavailable sind
function getDisabledCassettes(ports) {
  const bySlot = new Map(); // "1C" -> ["unavailable", ...]
  (ports || []).forEach(p => {
    const label = p?.label || p?.port_label;
    const m = String(label || "").match(/^(\d+[A-D])\d+$/); // "1C1" -> "1C"
    if (!m) return;

    const slot = m[1];
    const st = String(p?.status || "").toLowerCase(); // free/unavailable/occupied/""

    if (!bySlot.has(slot)) bySlot.set(slot, []);
    bySlot.get(slot).push(st);
  });

  const disabled = [];
  for (const [slot, arr] of bySlot.entries()) {
    if (arr.length && arr.every(s => s === "unavailable" || s === "")) {
      disabled.push(slot);
    }
  }
  return disabled.sort();
}

function setEnableCassetteUI(ports) {
  const sel = $("enableCassetteSelect");
  const btn = $("enableCassetteBtn");
  const msg = $("enableCassetteMsg");
  if (!sel || !btn || !msg) return; // falls HTML noch nicht drin ist -> kein crash

  if (!step4CustomerPPId) {
    resetEnableCassetteUI();
    return;
  }

  const disabledSlots = getDisabledCassettes(ports);
  sel.innerHTML =
    `<option value="">— Kassette wählen —</option>` +
    disabledSlots.map(s => `<option value="${s}">${s}</option>`).join("");

  const ok = disabledSlots.length > 0;
  sel.disabled = !ok;
  btn.disabled = !ok;
  msg.textContent = ok ? "Wähle Kassette (z.B. 1C) und klick Freigeben." : "✅ Alles ist schon freigegeben.";
}


function setEnableCassetteUI(ports) {
  const sel = $("enableCassetteSelect");
  const btn = $("enableCassetteBtn");
  const msg = $("enableCassetteMsg");
  if (!sel || !btn || !msg) return;

  if (!step4CustomerPPId) {
    sel.innerHTML = `<option value="">— erst Patchpanel wählen —</option>`;
    sel.disabled = true;
    btn.disabled = true;
    msg.textContent = "";
    return;
  }

  const disabledSlots = getDisabledCassettes(ports);

  sel.innerHTML =
    `<option value="">— Kassette wählen —</option>` +
    disabledSlots.map(s => `<option value="${s}">${s}</option>`).join("");

  const hasOptions = disabledSlots.length > 0;
  sel.disabled = !hasOptions;
  btn.disabled = !hasOptions;

  msg.textContent = hasOptions
    ? "Wähle eine Kassette (z.B. 1C) und klick Freigeben."
    : "✅ Alle Kassetten sind bereits freigegeben.";
}

function resetEnableCassetteUI() {
  const sel = $("enableCassetteSelect");
  const btn = $("enableCassetteBtn");
  const msg = $("enableCassetteMsg");
  if (sel) {
    sel.innerHTML = `<option value="">— erst Patchpanel wählen —</option>`;
    sel.disabled = true;
  }
  if (btn) btn.disabled = true;
  if (msg) msg.textContent = "";
}

// --------------------
// Step4 UI helpers
// --------------------
function resetStep4UIOnly() {
  step4CustomerId = null;
  step4LocationId = null;
  step4RackId = null;
  step4RackLabel = null;
  step4CustomerPPId = null;
  step4CustomerPortLabel = null;

  locationsById = new Map();
  racksById = new Map();

  if ($("custBox")) $("custBox").textContent = "Noch nichts gewählt…";

  fillSelect($("custSelect"), [], "Customer…", x => x, x => x);
  fillSelect($("locSelect"), [], "Location…", x => x, x => x);
  fillSelect($("rackSelect"), [], "Rack…", x => x, x => x);
  fillSelect($("custPanelSelect"), [], "Patchpanel…", x => x, x => x);

  if ($("custMeta")) $("custMeta").innerHTML = "";
  if ($("custGrid")) $("custGrid").innerHTML = "";

  if ($("custSelect")) $("custSelect").disabled = true;
  if ($("locSelect")) $("locSelect").disabled = true;
  if ($("rackSelect")) $("rackSelect").disabled = true;
  if ($("custPanelSelect")) $("custPanelSelect").disabled = true;

  resetEnableCassetteUI();
  updateStep4SaveButton();
}

function updateStep4SaveButton() {
  const btn = $("saveStep4Btn");
  if (!btn) return;

  // Step4 Save möglich wenn:
  // - Peer existiert (Step3)
  // - Customer PP + Port gewählt
  btn.disabled = !(
    step3Peer?.peer_instance_id &&
    step3Peer?.peer_port_label &&
    step4CustomerPPId &&
    step4CustomerPortLabel
  );
}

// --------------------
// API calls (Rackview)
// --------------------
async function fetchRooms() {
  if (roomsCache.value) return roomsCache.value;
  const { res, data } = await fetchJsonSafe(API_BASE + "/patchpanel-rooms");
  if (!res.ok || !data || !data.success) throw new Error(data?.detail || data?.error || "Rooms load failed");
  roomsCache.value = data.rooms || [];
  return roomsCache.value;
}

async function fetchInstancesByRoom(room) {
  if (instancesByRoomCache.has(room)) return instancesByRoomCache.get(room);
  const { res, data } = await fetchJsonSafe(API_BASE + "/patchpanel-instances?room=" + encodeURIComponent(normalizeRoom(room)));
  if (!res.ok || !data || !data.success) throw new Error(data?.detail || data?.error || "Patchpanels load failed");
  const instances = data.instances || [];
  instancesByRoomCache.set(room, instances);
  return instances;
}

async function fetchBackboneOutPanels(room) {
  const { res, data } = await fetchJsonSafe(API_BASE + "/patchpanel-backbone-out?room=" + encodeURIComponent(normalizeRoom(room)));
  if (res.ok && data && data.success) return data.instances || [];
  return [];
}

async function fetchPatchpanel(instanceId) {
  if (portsCache.has(instanceId)) return portsCache.get(instanceId);

  const { res, data } = await fetchJsonSafe(
    API_BASE + "/patchpanel-ports?instance_id=" + encodeURIComponent(instanceId)
  );
  if (!res.ok || !data || !data.success) throw new Error(data?.detail || data?.error || "Load failed");

  const raw = (data.ports?.data || data.ports || []);

  const ports = raw.map(p => {
    if (p && !p.label && p.port_label) p.label = p.port_label;

    // peer connection soll klickbar bleiben
    const peer = !!(p && p.connected === true);

    const occ =
      (p?.occupied === true) ||
      (p?.status === "occupied") ||
      (!!p?.connected_to && !peer);

    return {
      ...p,
      label: p.label,
      occupied: occ,
      connected_to: p.connected_to || p.switch_connection || null
    };
  });

  const payload = { meta: data.patchpanel, ports };
  portsCache.set(instanceId, payload);
  return payload;
}

async function fetchPeer(instanceId, portLabel) {
  const url =
    API_BASE + "/patchpanel-peer?instance_id=" + encodeURIComponent(instanceId) +
    "&port_label=" + encodeURIComponent(portLabel);

  const { res, data } = await fetchJsonSafe(url);
  if (!res.ok || !data || !data.success) return null;
  return data;
}

// --------------------
// ZSide tolerant parsing (supports raw arrays or wrapped objects)
// --------------------
function unwrapZSideList(data, keyGuess) {
  if (!data) return [];
  if (Array.isArray(data)) return data;

  if (keyGuess && Array.isArray(data[keyGuess])) return data[keyGuess];

  const keys = ["rooms","customers","locations","racks","patchpanels","ports","data","items","results"];
  for (const k of keys) {
    if (Array.isArray(data[k])) return data[k];
  }
  return [];
}

// --------------------
// API calls (ZSide Step4)
// --------------------
async function zFetchCustomers(room) {
  const url = ZSIDE_BASE + "/customers?room=" + encodeURIComponent(room);
  const { res, data, txt } = await fetchJsonSafe(url);
  if (!res.ok) {
    console.error("zFetchCustomers HTTP failed:", res.status, url, txt);
    return [];
  }
  return unwrapZSideList(data, "customers");
}

async function zFetchLocations(room, customerId) {
  const url =
    ZSIDE_BASE + "/locations?room=" + encodeURIComponent(room) +
    "&customer_id=" + encodeURIComponent(customerId);

  const { res, data, txt } = await fetchJsonSafe(url);
  if (!res.ok) {
    console.error("zFetchLocations HTTP failed:", res.status, url, txt);
    return [];
  }
  return unwrapZSideList(data, "locations");
}

async function zFetchRacks(locationId) {
  const url = ZSIDE_BASE + "/racks?location_id=" + encodeURIComponent(locationId);
  const { res, data, txt } = await fetchJsonSafe(url);
  if (!res.ok) {
    console.error("zFetchRacks HTTP failed:", res.status, url, txt);
    return [];
  }
  return unwrapZSideList(data, "racks");
}

// ✅ FIX: robust patchpanel list by rack_id (no cage/rack_label filter problems)
async function zFetchPatchpanelsByRackId(rackId, customerId) {
  const url =
    ZSIDE_BASE + "/racks/" + encodeURIComponent(rackId) +
    "/patchpanels?customer_id=" + encodeURIComponent(customerId);

  const { res, data, txt } = await fetchJsonSafe(url);
  if (!res.ok) {
    console.error("zFetchPatchpanelsByRackId HTTP failed:", res.status, url, txt);
    return [];
  }
  return unwrapZSideList(data, "patchpanels");
}

/**
 * (optional fallback — bleibt drin)
 * ✅ KRITISCHER FIX:
 * - Wenn No-Cage => cage_no darf NICHT in der URL sein
 */
async function zFetchPatchpanels(room, customerId, rackLabel, cageNo) {
  const isNoCage = cageNo === null || cageNo === undefined || String(cageNo).trim() === "";

  let url =
    ZSIDE_BASE + "/patchpanels?room=" + encodeURIComponent(room) +
    "&customer_id=" + encodeURIComponent(customerId) +
    "&rack_label=" + encodeURIComponent(rackLabel);

  if (!isNoCage) {
    url += "&cage_no=" + encodeURIComponent(String(cageNo));
  }

  const { res, data, txt } = await fetchJsonSafe(url);
  if (!res.ok) {
    console.error("zFetchPatchpanels HTTP failed:", res.status, url, txt);
    return [];
  }
  return unwrapZSideList(data, "patchpanels");
}

async function zFetchPatchpanelPorts(patchpanelId) {
  const url = ZSIDE_BASE + "/patchpanel-ports?patchpanel_id=" + encodeURIComponent(patchpanelId);
  const { res, data, txt } = await fetchJsonSafe(url);

  if (!res.ok) {
    console.error("zFetchPatchpanelPorts HTTP failed:", res.status, url, txt);
    return { meta: { instance_id: String(patchpanelId), room: "?" }, ports: [] };
  }

  const rawPorts = unwrapZSideList(data, "ports");

  const norm = (rawPorts || []).map(p => {
    const label = p.port_label || p.label;
    const occupied = (String(p.status || "").toLowerCase() === "occupied") || !!p.connected_to || (p.occupied === true);
    return {
      label,
      status: p.status || null,   // ✅ add this
      occupied,
      connected: false,
      connected_to: p.connected_to || null,
      switch_connection: p.connected_to || null
    };
  });

  const patchpanelMeta =
    (data && !Array.isArray(data) && (data.patchpanel || data.meta)) || null;

  const meta = patchpanelMeta || { instance_id: String(patchpanelId), room: data?.room || "?" };
  return { meta, ports: norm };
}

// --------------------
// UI meta
// --------------------
function setMeta(meta, metaElId) {
  const el = $(metaElId);
  if (!el || !meta) return;

  el.innerHTML =
    "<div><b>Instance:</b> " + (meta.instance_id ?? meta.id ?? "?") + "</div>" +
    "<div><b>Room:</b> " + (meta.room ?? "?") +
    " | <b>RU:</b> " + (meta.rack_unit ?? "?") +
    " | <b>Type:</b> " + (meta.panel_type ?? "?") +
    " | <b>Ports:</b> " + (meta.total_ports ?? "?") + "</div>";
}

function updatePrecabledBox(extraLine) {
  const box = $("precabledBox");
  if (!box) return;

  if (!precabled) {
    box.textContent = "Noch nichts geladen…";
    return;
  }

  const line1 =
    `${precabled.switch_name} ${precabled.switch_port} -> ${precabled.patchpanel_id} / ${precabled.patchpanel_port} (Room ${precabled.room})`;

  box.textContent = extraLine ? (line1 + "\n" + extraLine) : line1;
}

function updateTargetBox() {
  const box = $("targetBox");
  if (!box) return;

  if (!precabled) {
    box.textContent = "Erst Step 1 machen (Pre-Cabled finden)…";
    return;
  }

  const step1 =
    `Switch: ${precabled.switch_name} ${precabled.switch_port} -> PP ${precabled.patchpanel_id} / ${precabled.patchpanel_port} (Room ${precabled.room || "?"})`;

  if (!selectedTarget || !currentTargetMeta) {
    box.textContent = step1 + "\nStep 2: Backbone-OUT Panel wählen + Port klicken…";
    return;
  }

  const step2 =
    `Step 2 (Backbone-OUT): ${selectedTarget.instance_id} / ${selectedTarget.port_label} (Room ${currentTargetMeta.room || "?"})`;

  box.textContent = [step1, step2].join("\n");
}

function updatePeerBox() {
  const box = $("peerBox");
  const btn = $("loadPeerPanelBtn");
  if (!box) return;

  if (!step3Peer || !step3Peer.peer_instance_id) {
    box.textContent = "Noch kein Peer geladen…";
    if (btn) btn.disabled = true;
    return;
  }

  box.textContent =
    `Peer Room: ${step3Peer.peer_room || "?"}\n` +
    `Peer Panel: ${step3Peer.peer_instance_id}\n` +
    `Peer Port: ${step3Peer.peer_port_label || "?"}`;

  if (btn) btn.disabled = false;
}

function updateSaveButton() {
  const btn = $("savePatchBtn");
  const panelSelect = $("panelSelect");

  if (panelSelect) panelSelect.disabled = !precabled || uiLocked;
  if (!btn) return;

  const already = !!precabledExisting;
  btn.disabled = !(precabled && selectedTarget) || already;
  btn.title = already ? "Schon dokumentiert – keine Doppelbuchung" : "";
}

// --------------------
// render grid
// --------------------
function renderCassetteGrid(gridElId, ports, onPortClick, opts = {}) {
  const grid = $(gridElId);
  if (!grid) return;
  grid.innerHTML = "";

  const disableAll = !!opts.disableAll;
  const lockedLabels = opts.lockedLabels instanceof Set ? opts.lockedLabels : new Set();
  const allowWhenLocked = !!opts.allowWhenLocked;

  // ---- helper: status normalisieren ----
  function normStatus(p) {
    const s = String(p?.status || "").toLowerCase();
    if (s === "free") return "free";
    if (s === "occupied" || s === "linked") return "occupied";
    if (s === "unavailable") return "unavailable";
    return ""; // unknown
  }

  // Ports map: "1A1" -> port
  const map = new Map();
  (ports || []).forEach((p) => {
    const label = p?.label || p?.port_label;
    if (!label) return;
    map.set(label, { ...p, label });
  });

  // Auto-activate cassettes: if any port in a cassette is occupied,
  // all unavailable siblings become free
  const occCassettes = new Set();
  for (const [label, p] of map.entries()) {
    const st = String(p?.status || "").toLowerCase();
    if (st === "occupied" || p?.occupied === true || !!p?.connected_to) {
      const cm = String(label).match(/^(\d+[A-D])\d+$/);
      if (cm) occCassettes.add(cm[1]);
    }
  }
  if (occCassettes.size) {
    for (const [label, p] of map.entries()) {
      if (String(p?.status || "").toLowerCase() === "unavailable") {
        const cm = String(label).match(/^(\d+[A-D])\d+$/);
        if (cm && occCassettes.has(cm[1])) { p.status = "free"; }
      }
    }
  }

  // Welche Blöcke (1..N) existieren?
  let maxRowNum = 0;
  for (const key of map.keys()) {
    const m = String(key).match(/^(\d+)[A-D]\d+$/);
    if (m) maxRowNum = Math.max(maxRowNum, Number(m[1]));
  }
  if (!maxRowNum) maxRowNum = 4; // fallback

  const root = document.createElement("div");
  root.className = "cassette-grid-new";

  // inject minimal CSS once (safe)
  if (!document.getElementById("cassette-grid-new-style")) {
    const style = document.createElement("style");
    style.id = "cassette-grid-new-style";
    style.textContent = `
      .cassette-grid-new { display:flex; flex-direction:column; gap:14px; }
      .cassette-row-new { display:grid; grid-template-columns: repeat(4, minmax(220px, 1fr)); gap:14px; }
      .cassette-card-new { border:1px solid #e5e7eb; border-radius:12px; padding:12px; background:#f8fafc; }
      .cassette-title-new { font-weight:800; margin-bottom:10px; }
      .cassette-ports-new { display:grid; grid-template-columns: repeat(6, 1fr); gap:8px; }
      .port-btn { border:1px solid #cbd5e1; border-radius:10px; padding:10px 0; font-weight:700; cursor:pointer; }
      .port-available { background:#d9f7d9; border-color:#65c765; }
      .port-unavailable { background:#ffd6d6; border-color:#ff7b7b; cursor:not-allowed; opacity:0.85; }
      .port-connected { background:#e5e7eb; border-color:#cbd5e1; cursor:not-allowed; opacity:0.9; }
      .port-selected { outline: 3px solid rgba(37,99,235,0.35); }
    `;
    document.head.appendChild(style);
  }

  for (let rowNum = 1; rowNum <= maxRowNum; rowNum++) {
    const row = document.createElement("div");
    row.className = "cassette-row-new";

    for (const letter of letters) {
      const cassKey = `${rowNum}${letter}`;
      const card = document.createElement("div");
      card.className = "cassette-card-new";

      const title = document.createElement("div");
      title.className = "cassette-title-new";
      title.textContent = `Kassette ${cassKey}`;
      card.appendChild(title);

      const portsWrap = document.createElement("div");
      portsWrap.className = "cassette-ports-new";

      for (const pos of positions) {
        const label = `${rowNum}${letter}${pos}`;
        const port = map.get(label);

        if (!port) {
          const btn = document.createElement("button");
          btn.className = "port-btn port-unavailable";
          btn.disabled = true;
          btn.title = "Nicht vorhanden";
          btn.dataset.label = label;
          btn.textContent = label;
          portsWrap.appendChild(btn);
          continue;
        }

        // peer connection soll klickbar bleiben (bei RackView data)
        const peer = !!(port && port.connected === true);

        const occupiedBackend =
          !!(port && port.occupied === true) ||
          (port && String(port.status).toLowerCase() === "occupied") ||
          (!!(port && port.connected_to) && !peer);

        const occupiedForced = lockedLabels.has(label);
        const occupied = occupiedBackend || occupiedForced;

        const st = normStatus(port);
        const isUnavailable = st === "unavailable";
        const isFree = st === "free";

        const btn = document.createElement("button");
        btn.className = "port-btn";
        btn.dataset.label = label;
        btn.textContent = label;

        if (disableAll) {
          btn.classList.add(occupied ? "port-connected" : (isFree ? "port-available" : "port-unavailable"));
          btn.disabled = true;
          btn.title = occupied ? "Belegt (aktive Leitung)" : "Info";
          portsWrap.appendChild(btn);
          continue;
        }

        // 1) Occupied immer blocken
        if (occupied) {
          btn.classList.add("port-connected");
          btn.disabled = true;
          const info = port?.connected_to || port?.switch_connection;
          btn.title = info ? ("Belegt: " + info) : "Belegt";
          portsWrap.appendChild(btn);
          continue;
        }

        // 2) Wenn Status vorhanden (ZSide), dann NUR free klickbar
        if (st) {
          if (isFree) {
            btn.classList.add("port-available");
            btn.title = "frei";
            if ((allowWhenLocked || !uiLocked) && typeof onPortClick === "function") {
              btn.addEventListener("click", () => onPortClick(label, port || null));
            } else {
              btn.disabled = true;
              btn.title = "Gesperrt (schon dokumentiert)";
            }
          } else {
            btn.classList.add("port-unavailable");
            btn.disabled = true;
            btn.title = isUnavailable ? "Nicht freigegeben" : "Belegt";
          }
          portsWrap.appendChild(btn);
          continue;
        }

        // 3) Fallback (RackView ohne status): frei wenn nicht occupied
        btn.classList.add("port-available");
        btn.title = peer && port?.peer
          ? `Peer: ${port.peer.instance_id} / ${port.peer.port_label}`
          : "frei";

        if ((allowWhenLocked || !uiLocked) && typeof onPortClick === "function") {
          btn.addEventListener("click", () => onPortClick(label, port || null));
        } else {
          btn.disabled = true;
          btn.title = "Gesperrt (schon dokumentiert)";
        }

        portsWrap.appendChild(btn);
      }

      card.appendChild(portsWrap);
      row.appendChild(card);
    }

    root.appendChild(row);
  }

  grid.appendChild(root);
}

// --------------------
// Step3 Peer panel
// --------------------
async function loadPeerPanelToStep3(peerInstanceId, peerPortLabel) {
  if (!peerInstanceId) return;

  const payload = await fetchPatchpanel(peerInstanceId);
  setMeta(payload.meta, "zMeta3");

  const lockSet = new Set();
  if (peerPortLabel) lockSet.add(peerPortLabel);

  renderCassetteGrid("zGrid3", payload.ports, null, {
    disableAll: true,
    lockedLabels: lockSet
  });

  if (peerPortLabel) forceOccupiedStyle("zGrid3", peerPortLabel);
}

function clearStep3Grid() {
  if ($("zMeta3")) $("zMeta3").innerHTML = "";
  if ($("zGrid3")) $("zGrid3").innerHTML = "";
}

// --------------------
// Step4 init from peer room
// --------------------
async function initStep4FromPeerRoom(peerRoom) {
  step4Room = String(peerRoom || "").trim();
  if ($("custRoom")) $("custRoom").value = step4Room;

  resetStep4UIOnly();

  if (!step4Room) {
    if ($("custBox")) $("custBox").textContent = "❌ Peer Room fehlt";
    return;
  }

  if ($("custBox")) $("custBox").textContent = "Customer lädt…";

  const customers = await zFetchCustomers(step4Room);

  fillSelect(
    $("custSelect"),
    customers,
    "Customer…",
    c => String(c.id),
    c => c.name ? `${c.name} (#${c.id})` : `Customer #${c.id}`
  );

  $("custSelect").disabled = false;

  if (!customers.length) {
    if ($("custBox")) $("custBox").textContent =
      "⚠️ Keine Customers gefunden (Backend Response leer)";
  } else {
    if ($("custBox")) $("custBox").textContent = "Bitte Customer auswählen…";
  }

  updateStep4SaveButton();
}

// --------------------
// Existing manual patch check
// --------------------
async function checkExistingManualPatch() {
  precabledExisting = null;
  uiLocked = false;

  if (!precabled) return;

  const url =
    API_BASE + "/manual-patch?a_patchpanel_id=" + encodeURIComponent(precabled.patchpanel_id) +
    "&a_port=" + encodeURIComponent(precabled.patchpanel_port);

  try {
    const { res, data } = await fetchJsonSafe(url);
    if (res.ok && data && data.success && data.patch) {
      precabledExisting = data.patch;
      uiLocked = true;
      updatePrecabledBox(`⚠️ Schon dokumentiert: ${data.patch.b_instance_id} / ${data.patch.b_port_label}`);
    } else {
      updatePrecabledBox(null);
    }
  } catch (e) {
    console.warn("checkExistingManualPatch failed:", e);
    precabledExisting = null;
    uiLocked = false;
    updatePrecabledBox(null);
  }

  updateSaveButton();
  updateStep4SaveButton();
}

// --------------------
// Step2 load panels for room
// --------------------
async function lockRoomToPrecabledRoomAndLoadPanels() {
  const roomSelect = $("roomSelect");
  const panelSelect = $("panelSelect");
  if (!roomSelect || !panelSelect) return;

  panelSelect.disabled = true;
  fillSelect(panelSelect, [], "Patchpanel…", (x) => x, (x) => x);

  if ($("zMeta")) $("zMeta").innerHTML = "";
  if ($("zGrid")) $("zGrid").innerHTML = "";
  clearStep3Grid();
  resetStep4UIOnly();
  if ($("custRoom")) $("custRoom").value = "";

  selectedTarget = null;
  currentTargetMeta = null;
  step3Peer = null;

  updateTargetBox();
  updatePeerBox();
  updateSaveButton();

  if (!precabled || !precabled.room) {
    roomSelect.disabled = false;
    return;
  }

  const room = String(precabled.room).trim();

  const hasOption = Array.from(roomSelect.options).some(o => o.value === room);
  if (!hasOption) {
    const opt = document.createElement("option");
    opt.value = room;
    opt.textContent = room;
    roomSelect.appendChild(opt);
  }

  roomSelect.value = room;
  roomSelect.disabled = true;

  let panels = [];
  try { panels = await fetchBackboneOutPanels(room); } catch {}
  if (!panels.length) panels = await fetchInstancesByRoom(room);

  fillSelect(
    panelSelect,
    panels,
    "Patchpanel…",
    (p) => p.instance_id,
    (p) => `${p.instance_id} (RU ${p.rack_unit ?? "?"}, ${p.panel_type ?? "?"})`
  );

  if (precabledExisting?.b_instance_id) {
    ensureSelectOption(panelSelect, precabledExisting.b_instance_id, `${precabledExisting.b_instance_id} (Dokumentiert)`);
    panelSelect.value = precabledExisting.b_instance_id;
    panelSelect.disabled = true;
  } else {
    panelSelect.disabled = false;
  }
}

// --------------------
// Step1 load precabled by switch
// --------------------
async function loadPrecabled() {
  const swName = $("swName")?.value?.trim() || "";
  const swPort = $("swPort")?.value?.trim() || "";
  if (!swName || !swPort) {
    alert("Bitte Switch Name + Port eingeben");
    return;
  }

  try {
    const { res, data } = await fetchJsonSafe(
      API_BASE + "/precabled-by-switch?switch_name=" + encodeURIComponent(swName) +
      "&switch_port=" + encodeURIComponent(swPort)
    );

    if (!res.ok || !data || !data.success) {
      alert(data?.detail || data?.error || "Pre-Cabled nicht gefunden");
      return;
    }

    precabled = data.link;

    selectedTarget = null;
    currentTargetMeta = null;
    step3Peer = null;
    precabledExisting = null;
    uiLocked = false;

    // ✅ NEW: reset CC master for new flow
    createdCrossConnectId = null;

    updatePrecabledBox(null);
    updateTargetBox();
    updatePeerBox();
    updateSaveButton();
    resetStep4UIOnly();
    if ($("custRoom")) $("custRoom").value = "";

    await checkExistingManualPatch();
    await lockRoomToPrecabledRoomAndLoadPanels();

    // wenn schon dokumentiert -> direkt Step2 laden + Step3 + Step4
    if (precabledExisting?.b_instance_id && precabledExisting?.b_port_label) {
      await loadTargetPanel(precabledExisting.b_instance_id, {
        preselectPort: precabledExisting.b_port_label,
        lockMode: true
      });
    }

    setSelection({ precabled, existing_patch: precabledExisting, target: selectedTarget, step3_peer: step3Peer });
  } catch (e) {
    console.error("loadPrecabled failed:", e);
    alert("Fehler beim Laden (siehe Console)");
  }
}

// --------------------
// Step2 load target panel + port click -> Step3 + Step4 auto
// --------------------
async function loadTargetPanel(instanceId, opts = {}) {
  try {
    const payload = await fetchPatchpanel(instanceId);

    currentTargetMeta = payload.meta;
    setMeta(payload.meta, "zMeta");

    const lockMode = !!opts.lockMode || uiLocked;

    renderCassetteGrid(
      "zGrid",
      payload.ports,
      async (label) => {
        if (lockMode) return;

        // ✅ NEW: new selection -> reset CC master id
        createdCrossConnectId = null;

        selectedTarget = { instance_id: instanceId, port_label: label };

        step3Peer = await fetchPeer(instanceId, label);
        // ✅ Step3 Peer occupied? -> Step4 blocken + Hinweis
        if (step3Peer?.occupied === true) {
          resetStep4UIOnly();
          if ($("custRoom")) $("custRoom").value = step3Peer.peer_room || "";
          if ($("custBox")) $("custBox").textContent =
            `❌ Peer-Port ${step3Peer.peer_instance_id}:${step3Peer.peer_port_label} ist schon belegt (${step3Peer.connected_to || "siehe DB"})`;
        }
        if (step3Peer?.peer_room && step3Peer?.occupied !== true) {
          await initStep4FromPeerRoom(step3Peer.peer_room);
        }

        clearHighlights("zGrid");
        highlight("zGrid", label);

        if (step3Peer && step3Peer.peer_instance_id) {
          await loadPeerPanelToStep3(step3Peer.peer_instance_id, step3Peer.peer_port_label);

          if (step3Peer.peer_room) {
            await initStep4FromPeerRoom(step3Peer.peer_room);
          } else {
            resetStep4UIOnly();
            if ($("custRoom")) $("custRoom").value = "";
          }
        } else {
          clearStep3Grid();
          resetStep4UIOnly();
          if ($("custRoom")) $("custRoom").value = "";
        }

        updateTargetBox();
        updatePeerBox();
        updateSaveButton();
        updateStep4SaveButton();

        setSelection({ precabled, existing_patch: precabledExisting, target: selectedTarget, step3_peer: step3Peer });
      },
      { disableAll: lockMode }
    );

    // preselect Port (bei dokumentiert)
    if (opts.preselectPort) {
      // ✅ NEW: reset CC master id
      createdCrossConnectId = null;

      selectedTarget = { instance_id: instanceId, port_label: opts.preselectPort };
      clearHighlights("zGrid");
      forceOccupiedStyle("zGrid", opts.preselectPort, "Belegt (aktive Leitung)");

      step3Peer = await fetchPeer(instanceId, opts.preselectPort);
      if (step3Peer && step3Peer.peer_instance_id) {
        await loadPeerPanelToStep3(step3Peer.peer_instance_id, step3Peer.peer_port_label);

        if (step3Peer.peer_room) {
          await initStep4FromPeerRoom(step3Peer.peer_room);
        } else {
          resetStep4UIOnly();
          if ($("custRoom")) $("custRoom").value = "";
        }
      } else {
        clearStep3Grid();
        resetStep4UIOnly();
        if ($("custRoom")) $("custRoom").value = "";
      }
    }

    updateTargetBox();
    updatePeerBox();
    updateSaveButton();
    updateStep4SaveButton();
  } catch (e) {
    console.error("loadTargetPanel failed:", e);
    alert("Panel konnte nicht geladen werden (siehe Console)");
  }
}

// --------------------
// Step2 manual patch save (A-port + Backbone OUT)
// --------------------
async function savePatch() {
  if (!(window.isAdminRole && window.isAdminRole())) {
    alert("Nur Admin darf speichern.");
    return;
  }
  if (!(precabled && selectedTarget)) return;

  if (precabledExisting) {
    alert("Dieser Pre-Cabled Port ist schon dokumentiert. Keine Doppelbuchung erlaubt.");
    return;
  }

  const payload = {
    a_patchpanel_id: precabled.patchpanel_id,
    a_port: precabled.patchpanel_port,
    b_instance_id: selectedTarget.instance_id,
    b_port_label: selectedTarget.port_label,
    cable_type: "LC",
    note: ""
  };

  try {
    const { res, data } = await fetchJsonSafe(API_BASE + "/manual-patch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (!res.ok || !data || !data.success) {
      alert(data?.detail || data?.error || "Save Patch fehlgeschlagen");
      return;
    }

    alert("✅ Patch gespeichert! Port ist jetzt belegt.");

    portsCache.delete(selectedTarget.instance_id);
    await loadTargetPanel(selectedTarget.instance_id);

    await checkExistingManualPatch();
    updateSaveButton();
    updateStep4SaveButton();

    forceOccupiedStyle("zGrid", selectedTarget.port_label);

    if (step3Peer?.peer_instance_id && step3Peer?.peer_port_label) {
      forceOccupiedStyle("zGrid3", step3Peer.peer_port_label);
    }

    setSelection({ precabled, existing_patch: precabledExisting, target: selectedTarget, step3_peer: step3Peer });
  } catch (e) {
    console.error("savePatch failed:", e);
    alert("Save Patch fehlgeschlagen (siehe Console)");
  }
}

// --------------------
// Step4 Save = CROSS-CONNECT
// --------------------
async function saveStep4() {
  if (!(window.isAdminRole && window.isAdminRole())) {
    alert("Nur Admin darf Step4 speichern.");
    return;
  }
  if (!selectedTarget?.instance_id || !selectedTarget?.port_label) {
    alert("Bitte erst Step 2 Port klicken (Backbone OUT).");
    return;
  }

  if (!step3Peer?.peer_instance_id || !step3Peer?.peer_port_label) {
    alert("Kein Peer vorhanden (Step3).");
    return;
  }

  if (!step4CustomerPPId || !step4CustomerPortLabel) {
    alert("Bitte Customer Patchpanel + Port wählen.");
    return;
  }

  try {
    // ✅ Auto Step2 Save if needed
    if (!precabledExisting) {
      const patchPayload = {
        a_patchpanel_id: precabled.patchpanel_id,
        a_port: precabled.patchpanel_port,
        b_instance_id: selectedTarget.instance_id,
        b_port_label: selectedTarget.port_label,
        cable_type: "LC",
        note: "auto from Step4 (cross-connect)"
      };

      const { res, data } = await fetchJsonSafe(API_BASE + "/manual-patch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patchPayload),
      });

      if (!res.ok || !data || !data.success) {
        alert("Step2 Auto-Save fehlgeschlagen: " + (data?.detail || data?.error || res.status));
        return;
      }

      await checkExistingManualPatch();
      forceOccupiedStyle("zGrid", selectedTarget.port_label, "Belegt (Step2 Cross-Connect)");
    }

    // ✅ Step4 link peer<->customer
    const postPayload = {
      peer_instance_id: step3Peer.peer_instance_id,
      peer_port_label: step3Peer.peer_port_label,
      customer_patchpanel_id: Number(step4CustomerPPId),
      customer_port_label: step4CustomerPortLabel
    };

    const { res: r2, data: d2 } = await fetchJsonSafe(ZSIDE_BASE + "/link-peer-customer", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(postPayload),
    });

    const ok = (r2.ok || r2.status === 409);
    if (!ok) {
      alert("Step4 Save fehlgeschlagen: " + (d2?.detail || d2?.error || r2.status));
      return;
    }

    // ✅ NEW: Create Cross-Connect master record (pending_serial)
    const manualPatchId =
      precabledExisting?.id ??
      precabledExisting?.manual_patch_id ??
      precabledExisting?.patch_id ??
      null;

    const ppConnId =
      d2?.pp_connection_id ??
      d2?.connection_id ??
      d2?.id ??
      null;

    const ccRes = await createCrossConnectFromCurrentState({
      manual_patch_id: manualPatchId,
      pp_connection_id: ppConnId
    });

    if (!ccRes.ok) {
      console.warn("Cross-Connect master create failed:", ccRes.error);
      alert(
        "✅ Cross-Connect (Ports) gespeichert!\n" +
        "⚠️ ABER cross_connects Master konnte nicht erstellt werden:\n" +
        ccRes.error +
        "\n\n(Die Leitung ist trotzdem da – wir können Master später nachtragen.)"
      );
    } else {
      alert(
        "✅ Cross-Connect gespeichert!\n" +
        `✅ Master in cross_connects erstellt: #${ccRes.id} (status: pending_serial)\n` +
        "➡️ Serial später in Cross-Connects Seite eintragen."
      );
    }

    // UI sofort blocken
    forceOccupiedStyle("zGrid3", step3Peer.peer_port_label, "Belegt (Step4 Cross-Connect)");
    forceOccupiedStyle("custGrid", step4CustomerPortLabel, "Belegt (Step4 Cross-Connect)");

    // reload customer ports (shows occupied)
    const p = await zFetchPatchpanelPorts(step4CustomerPPId);
    setMeta(p.meta, "custMeta");

    renderCassetteGrid(
      "custGrid",
      p.ports,
      async (label) => {
        step4CustomerPortLabel = label;
        if ($("custBox")) $("custBox").textContent = `Customer PP: ${step4CustomerPPId} / ${label}`;
        clearHighlights("custGrid");
        highlight("custGrid", label);
        updateStep4SaveButton();
      },
      { disableAll: false, allowWhenLocked: true }
    );

    setEnableCassetteUI(p.ports);
    updateStep4SaveButton();

    setSelection({
      precabled,
      existing_patch: precabledExisting,
      target: selectedTarget,
      step3_peer: step3Peer,
      cross_connect: { id: createdCrossConnectId },
      step4: {
        room: step4Room,
        customer_id: step4CustomerId,
        location_id: step4LocationId,
        rack_id: step4RackId,
        rack_label: step4RackLabel,
        customer_pp_id: step4CustomerPPId,
        customer_port: step4CustomerPortLabel
      }
    });
  } catch (e) {
    console.error(e);
    alert("Cross-Connect Save fehlgeschlagen (Console)");
  }
}

// --------------------
// Boot
// --------------------
document.addEventListener("DOMContentLoaded", async () => {
  $("loadPrecabledBtn")?.addEventListener("click", loadPrecabled);
  $("savePatchBtn")?.addEventListener("click", savePatch);
  $("saveStep4Btn")?.addEventListener("click", saveStep4);

  // ✅ NEW: Enable Cassette button
  $("enableCassetteBtn")?.addEventListener("click", async () => {
    try {
      const sel = $("enableCassetteSelect");
      const msg = $("enableCassetteMsg");
      if (!sel || !msg) return;

      const slot = sel.value;
      if (!step4CustomerPPId) return alert("Erst Customer Patchpanel auswählen.");
      if (!slot) return alert("Bitte Kassette wählen (z.B. 1C).");

      msg.textContent = "Freigeben läuft…";

      await zEnableCassettes(step4CustomerPPId, [slot]);

      // reload ports + re-render (zeigt jetzt grün)
      const payload = await zFetchPatchpanelPorts(step4CustomerPPId);
      setMeta(payload.meta, "custMeta");

      renderCassetteGrid(
        "custGrid",
        payload.ports,
        async (label) => {
          createdCrossConnectId = null;
          step4CustomerPortLabel = label;
          if ($("custBox")) $("custBox").textContent = `Customer PP: ${step4CustomerPPId} / ${label}`;
          clearHighlights("custGrid");
          highlight("custGrid", label);
          updateStep4SaveButton();
        },
        { disableAll: false, allowWhenLocked: true }
      );

      setEnableCassetteUI(payload.ports);
      msg.textContent = `✅ Kassette ${slot} freigegeben.`;

    } catch (e) {
      console.error(e);
      alert("Freigeben fehlgeschlagen: " + e.message);
    }
  });

  const roomSelect = $("roomSelect");
  const panelSelect = $("panelSelect");

  if (roomSelect) roomSelect.disabled = true;
  if (panelSelect) panelSelect.disabled = true;

  $("loadPeerPanelBtn")?.addEventListener("click", async () => {
    if (!step3Peer || !step3Peer.peer_instance_id) return;
    await loadPeerPanelToStep3(step3Peer.peer_instance_id, step3Peer.peer_port_label);
    if (step3Peer.peer_room) await initStep4FromPeerRoom(step3Peer.peer_room);
  });

  // Step4 dropdown events
  $("custSelect")?.addEventListener("change", async () => {
    try {
      createdCrossConnectId = null;

      step4CustomerId = $("custSelect").value || null;

      step4LocationId = null;
      step4RackId = null;
      step4RackLabel = null;
      step4CustomerPPId = null;
      step4CustomerPortLabel = null;

      locationsById = new Map();
      racksById = new Map();

      fillSelect($("locSelect"), [], "Location…", x => x, x => x);
      fillSelect($("rackSelect"), [], "Rack…", x => x, x => x);
      fillSelect($("custPanelSelect"), [], "Patchpanel…", x => x, x => x);

      if ($("custMeta")) $("custMeta").innerHTML = "";
      if ($("custGrid")) $("custGrid").innerHTML = "";
      if ($("custBox")) $("custBox").textContent = "Noch nichts gewählt…";

      resetEnableCassetteUI();

      if (!step4Room || !step4CustomerId) return;

      const locs = await zFetchLocations(step4Room, step4CustomerId);
      locs.forEach(l => locationsById.set(String(l.id), l));

      fillSelect(
        $("locSelect"),
        locs,
        "Location…",
        l => String(l.id),
        l => {
          const cage = (l.cage_no ?? "").toString().trim();
          return cage ? `Cage ${cage}` : `No Cage`;
        }
      );

      $("locSelect").disabled = false;
      $("rackSelect").disabled = true;
      $("custPanelSelect").disabled = true;

      updateStep4SaveButton();
    } catch (e) {
      console.error(e);
      alert("Locations konnten nicht geladen werden");
    }
  });

  $("locSelect")?.addEventListener("change", async () => {
    try {
      createdCrossConnectId = null;

      step4LocationId = $("locSelect").value || null;

      step4RackId = null;
      step4RackLabel = null;
      step4CustomerPPId = null;
      step4CustomerPortLabel = null;

      fillSelect($("rackSelect"), [], "Rack…", x => x, x => x);
      fillSelect($("custPanelSelect"), [], "Patchpanel…", x => x, x => x);

      if ($("custMeta")) $("custMeta").innerHTML = "";
      if ($("custGrid")) $("custGrid").innerHTML = "";
      if ($("custBox")) $("custBox").textContent = "Noch nichts gewählt…";

      resetEnableCassetteUI();

      if (!step4LocationId) return;

      const racks = await zFetchRacks(step4LocationId);
      racksById = new Map();
      racks.forEach(r => racksById.set(String(r.id), String(r.rack_label)));

      // ✅ FIX: value = rack_id (not rack_label)
      fillSelect(
        $("rackSelect"),
        racks,
        "Rack…",
        r => String(r.id),
        r => String(r.rack_label)
      );

      $("rackSelect").disabled = false;
      $("custPanelSelect").disabled = true;

      updateStep4SaveButton();
    } catch (e) {
      console.error(e);
      alert("Racks konnten nicht geladen werden");
    }
  });

  $("rackSelect")?.addEventListener("change", async () => {
    try {
      createdCrossConnectId = null;

      step4RackId = $("rackSelect").value || null;
      step4RackLabel = step4RackId ? (racksById.get(String(step4RackId)) || null) : null;

      step4CustomerPPId = null;
      step4CustomerPortLabel = null;

      fillSelect($("custPanelSelect"), [], "Patchpanel…", x => x, x => x);

      if ($("custMeta")) $("custMeta").innerHTML = "";
      if ($("custGrid")) $("custGrid").innerHTML = "";
      if ($("custBox")) $("custBox").textContent = "Noch nichts gewählt…";

      resetEnableCassetteUI();

      if (!step4CustomerId || !step4RackId) {
        $("custPanelSelect").disabled = true;
        return;
      }

      // ✅ FIX: robust list by rack_id
      const pps = await zFetchPatchpanelsByRackId(step4RackId, step4CustomerId);

      fillSelect(
        $("custPanelSelect"),
        pps,
        "Patchpanel…",
        pp => String(pp.id),
        pp => `${pp.instance_id || ("PP#" + pp.id)} (RU ${pp.rack_unit ?? "?"})`
      );

      $("custPanelSelect").disabled = false;
      updateStep4SaveButton();
    } catch (e) {
      console.error(e);
      alert("Customer Patchpanels konnten nicht geladen werden");
    }
  });

  $("custPanelSelect")?.addEventListener("change", async () => {
    try {
      createdCrossConnectId = null;

      step4CustomerPPId = $("custPanelSelect").value || null;
      step4CustomerPortLabel = null;

      if ($("custMeta")) $("custMeta").innerHTML = "";
      if ($("custGrid")) $("custGrid").innerHTML = "";
      if ($("custBox")) $("custBox").textContent = "Noch nichts gewählt…";

      resetEnableCassetteUI();

      if (!step4CustomerPPId) return;

      const payload = await zFetchPatchpanelPorts(step4CustomerPPId);
      setMeta(payload.meta, "custMeta");

      renderCassetteGrid(
        "custGrid",
        payload.ports,
        async (label) => {
          createdCrossConnectId = null;
          step4CustomerPortLabel = label;
          if ($("custBox")) $("custBox").textContent = `Customer PP: ${step4CustomerPPId} / ${label}`;
          clearHighlights("custGrid");
          highlight("custGrid", label);
          updateStep4SaveButton();
        },
        { disableAll: false, allowWhenLocked: true }
      );

      setEnableCassetteUI(payload.ports);
      updateStep4SaveButton();
    } catch (e) {
      console.error(e);
      alert("Customer Ports konnten nicht geladen werden");
    }
  });

  // rooms initial
  try {
    const rooms = await fetchRooms();
    fillSelect(roomSelect, rooms, "Room…", (r) => r, (r) => r);
  } catch (e) {
    console.error(e);
    alert("Rooms konnten nicht geladen werden: " + e.message);
    return;
  }

  panelSelect?.addEventListener("change", async () => {
    const iid = panelSelect.value;
    if (!iid) return;
    await loadTargetPanel(iid);
  });

  // init UI
  updatePrecabledBox(null);
  updateTargetBox();
  updatePeerBox();
  updateSaveButton();
  updateStep4SaveButton();
  resetEnableCassetteUI();
  setSelection({});
});
