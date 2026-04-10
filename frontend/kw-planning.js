/* ═══════════════════════════════════════════════════════════════
   kw-planning.js — Zentrale KW-Wochenplanung
   Manuelle Erfassung: Install, Deinstall, Line Move, Path Move
   ═══════════════════════════════════════════════════════════════ */

const API_KW_PLANS  = String(window.API_KW_PLANS_V2 || `${window.API_ROOT || ""}/kw_plans`).replace(/\/+$/, "");
const API_KW_CHANGES = String(window.API_KW_CHANGES || `${window.API_ROOT || ""}/kw_changes`).replace(/\/+$/, "");
const API_PP         = String(window.API_PATCHPANELS || `${window.API_ROOT || ""}/patchpanels`).replace(/\/+$/, "");
const API_CC_SERIAL  = String(window.API_CROSSCONNECTS || `${window.API_ROOT || ""}/cross-connects`).replace(/\/+$/, "");
const API_RACKVIEW   = String(window.API_RACKVIEW || `${window.API_ROOT || ""}/rackview`).replace(/\/+$/, "");

/* ── Constants ── */
const TYPE_META = {
  NEW_INSTALL: { label: "Install",   cls: "install",   icon: "+" },
  DEINSTALL:   { label: "Deinstall", cls: "deinstall", icon: "\u2212" },
  LINE_MOVE:   { label: "Line Move", cls: "linemove",  icon: "\u2194" },
  PATH_MOVE:   { label: "Path Move", cls: "pathmove",  icon: "\u21C4" },
};
const STATUS_LABELS = {
  planned: "Geplant", in_progress: "In Bearbeitung",
  done: "Erledigt", canceled: "Abgebrochen",
};
const LETTERS   = ["A", "B", "C", "D"];
const POSITIONS = [1, 2, 3, 4, 5, 6];

/* ── State ── */
const state = {
  plans: [], selectedKw: "", changes: [], filtered: [],
  editing: null, editingInstall: null, editingLineMove: null, typeFilter: "NEW_INSTALL", statusFilter: "open",
  kwNavYear: new Date().getFullYear(), kwNavMonth: new Date().getMonth(),
  // Caches
  _rooms: null, _ppByRoom: {},
  // ── Install form auto-fill state ──
  ni: {
    switchName: "", switchPort: "",
    aRoom: "", aPPInstanceId: "", aPPDbId: null, aPortLabel: "",
    zPPInstanceId: "", zPPDbId: null, zRoom: "", zCustomer: "", zPortLabel: "",
    bbInDbId: null, bbInInstanceId: "", bbInPortLabel: "",
    bbOutInstanceId: "", bbOutPortLabel: "",
    bbPanels: [],            // available BB IN panels for customer room
    selectedBbIdx: -1,       // which bb card is selected
  },
  // Deinstall / LineMove / PathMove
  diCC: null,
  lmCC: null,
  lm: {
    zPPInstanceId: "", zPPDbId: null, zRoom: "", zCustomer: "", zPortLabel: "",
    bbInDbId: null, bbInInstanceId: "", bbInPortLabel: "",
    bbOutInstanceId: "", bbOutPortLabel: "",
    bbPanels: [], selectedBbIdx: -1,
    aRoom: "",
  },
  pmA: null, pmB: null,
};

/* ── Helpers ── */
const $ = id => document.getElementById(id);
const esc = v => String(v ?? "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&#039;");

function toast(msg, type = "info") {
  const w = $("toastWrap"); if (!w) return;
  const el = document.createElement("div");
  el.className = `toast ${type}`; el.textContent = msg;
  w.appendChild(el); setTimeout(() => el.remove(), 3200);
}

async function apiJson(url, opts) {
  const res = await fetch(url, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.detail || `HTTP ${res.status}`);
  return data;
}

function currentIsoKwLabel() {
  const now = new Date();
  const tmp = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
  const day = tmp.getUTCDay() || 7;
  tmp.setUTCDate(tmp.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(tmp.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((tmp - yearStart) / 86400000) + 1) / 7);
  return `${tmp.getUTCFullYear()}-KW${String(week).padStart(2, "0")}`;
}

/* ── ISO Week helpers for KW Navigator ── */
const MONTH_NAMES_DE = ["Januar","Februar","M\u00e4rz","April","Mai","Juni","Juli","August","September","Oktober","November","Dezember"];

function getIsoWeek(date) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
  return { year: d.getUTCFullYear(), week: weekNo };
}

function getWeeksForMonth(year, month) {
  const weeks = [];
  const seen = new Set();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  for (let d = 1; d <= daysInMonth; d++) {
    const date = new Date(year, month, d);
    const iw = getIsoWeek(date);
    const key = `${iw.year}-KW${String(iw.week).padStart(2, "0")}`;
    if (!seen.has(key)) { seen.add(key); weeks.push({ label: key, year: iw.year, kw: iw.week }); }
  }
  return weeks;
}

function kwChipStatus(plan) {
  if (!plan) return "gray";
  const s = String(plan.status || "").toLowerCase();
  if (s === "completed") return "green";
  if (s === "locked" || s === "problem") return "red";
  const total = plan.changes_total || 0;
  if (total === 0) return "gray";
  return "blue";
}

function fmtDate(raw) {
  if (!raw) return "-";
  const d = new Date(raw);
  if (isNaN(d)) return String(raw).slice(0, 16);
  return d.toLocaleDateString("de-DE", { day:"2-digit", month:"2-digit", year:"numeric", hour:"2-digit", minute:"2-digit" });
}

/* ── Badges ── */
function statusBadge(status, changeId) {
  const s = String(status || "").toLowerCase();
  let cls = "badge-neutral";
  if (s === "done") cls = "badge-success";
  if (s === "canceled") cls = "badge-danger";
  if (s === "planned" || s === "in_progress") cls = "badge-warning";
  const clickable = (s === "planned" || s === "in_progress") && changeId;
  const extra = clickable ? ` data-status-toggle="${changeId}" style="cursor:pointer;" title="Klick: Status wechseln"` : "";
  return `<span class="badge ${cls}"${extra}>${esc(STATUS_LABELS[s] || status || "-")}</span>`;
}
function typePill(type) {
  const t = String(type || "").toUpperCase();
  const m = TYPE_META[t] || { label: type || "-", cls: "neutral", icon: "?" };
  return `<span class="type-pill ${m.cls}">${m.icon} ${esc(m.label)}</span>`;
}

function changeTarget(c) {
  const t = String(c.type || "").toUpperCase(), p = c.payload_json || {};
  if (t === "NEW_INSTALL") { const l = p.new_line || p; return l.serial || l.product_id || "-"; }
  if (t === "DEINSTALL") return (p.snapshot_before || {}).serial || String(c.target_cross_connect_id || "-");
  if (t === "LINE_MOVE") { const snap = p.snapshot || {}; return snap.serial || p.serial || String(c.target_cross_connect_id || "-"); }
  if (t === "PATH_MOVE") {
    const sa = p.line_a_serial || p.line_a_id || "-";
    const sb = p.line_b_serial || p.line_b_id || "-";
    return `${sa} \u21C4 ${sb}`;
  }
  return String(c.target_cross_connect_id || "-");
}

function changeLogicalName(c) {
  const t = String(c.type || "").toUpperCase(), p = c.payload_json || {};
  if (t === "NEW_INSTALL") { const l = p.new_line || p; return l.logical_name || "-"; }
  return "-";
}

function looptestBadge(c) {
  const s = String(c.status || "").toLowerCase();
  const t = String(c.type || "").toUpperCase();
  if (t === "NEW_INSTALL" && (s === "planned" || s === "in_progress")) {
    return '<span class="badge badge-warning">pending</span>';
  }
  if (t === "NEW_INSTALL" && s === "done") {
    return '<span class="badge badge-success">done</span>';
  }
  return '<span class="small muted">-</span>';
}

/* ══════════════════════════════════════
   PATCHPANEL / PORT helpers
   ══════════════════════════════════════ */
async function fetchRooms() {
  if (state._rooms) return state._rooms;
  const d = await apiJson(`${API_PP}/rooms`);
  state._rooms = d.rooms || [];
  return state._rooms;
}

async function fetchPPsByRoom(room) {
  const key = String(room).toLowerCase();
  if (state._ppByRoom[key]) return state._ppByRoom[key];
  const d = await apiJson(`${API_PP}?room=${encodeURIComponent(room)}`);
  state._ppByRoom[key] = d.items || [];
  return state._ppByRoom[key];
}

async function fetchPorts(ppId) {
  const d = await apiJson(`${API_PP}/${ppId}/ports`);
  return d.ports || [];
}

function populateRoomSelect(selectEl, rooms) {
  selectEl.innerHTML = '<option value="">-- Raum waehlen --</option>';
  for (const r of rooms) {
    const o = document.createElement("option");
    o.value = r; o.textContent = r;
    selectEl.appendChild(o);
  }
}

function populatePPSelect(selectEl, pps) {
  selectEl.innerHTML = '<option value="">-- Patchpanel waehlen --</option>';
  for (const pp of pps) {
    const o = document.createElement("option");
    o.value = pp.id; o.textContent = `${pp.name} (${pp.location || "?"})`;
    selectEl.appendChild(o);
  }
}

/* ── Port Grid Renderer (cassette-style) ── */
function renderPortGrid(container, ports, onPick, selectedLabel) {
  container.innerHTML = "";
  if (!ports || !ports.length) {
    container.innerHTML = '<div class="small muted">Keine Ports gefunden.</div>';
    return;
  }

  const map = new Map();
  ports.forEach(p => map.set(String(p.port_label || ""), p));

  // Auto-activate cassettes: if any port in a cassette is occupied,
  // all unavailable siblings become free
  const occCassettes = new Set();
  for (const [label, p] of map.entries()) {
    if (p.occupied || p.status === "occupied" || p.connected_to) {
      const cm = String(label).match(/^(\d+[A-D])\d+$/);
      if (cm) occCassettes.add(cm[1]);
    }
  }
  if (occCassettes.size) {
    for (const [label, p] of map.entries()) {
      if (String(p.status || "").toLowerCase() === "unavailable") {
        const cm = String(label).match(/^(\d+[A-D])\d+$/);
        if (cm && occCassettes.has(cm[1])) { p.status = "free"; }
      }
    }
  }

  // Detect max cassette number
  let maxRow = 0;
  for (const label of map.keys()) {
    const m = String(label).match(/^(\d+)[A-D]\d+$/);
    if (m) maxRow = Math.max(maxRow, Number(m[1]));
  }

  // If labels are purely numeric (1-48), use a flat grid
  if (!maxRow) {
    const wrap = document.createElement("div");
    wrap.className = "ports-grid";
    const sorted = [...map.entries()].sort((a, b) => {
      const na = parseInt(a[0]) || 0, nb = parseInt(b[0]) || 0;
      return na - nb || a[0].localeCompare(b[0]);
    });
    for (const [label, p] of sorted) {
      wrap.appendChild(_makePortBtn(label, p, onPick, selectedLabel));
    }
    container.appendChild(wrap);
    return;
  }

  // Cassette layout
  for (let row = 1; row <= maxRow; row++) {
    const rowDiv = document.createElement("div");
    rowDiv.className = "cassette-row";
    for (const letter of LETTERS) {
      const card = document.createElement("div");
      card.className = "cassette";
      const title = document.createElement("h4");
      title.textContent = `Kassette ${row}${letter}`;
      card.appendChild(title);
      const grid = document.createElement("div");
      grid.className = "ports-grid";
      for (const pos of POSITIONS) {
        const label = `${row}${letter}${pos}`;
        const p = map.get(label);
        grid.appendChild(_makePortBtn(label, p, onPick, selectedLabel));
      }
      card.appendChild(grid);
      rowDiv.appendChild(card);
    }
    container.appendChild(rowDiv);
  }
}

function _makePortBtn(label, port, onPick, selectedLabel) {
  const btn = document.createElement("button");
  btn.className = "pbtn";
  btn.textContent = label;
  btn.type = "button";

  if (!port) {
    btn.classList.add("na"); btn.disabled = true;
    return btn;
  }

  const isOcc = port.occupied || port.status === "occupied";
  const isSel = selectedLabel && label === selectedLabel;

  if (isOcc && !isSel) {
    btn.classList.add("occ");
    const occInfo = `${port.serial || ""} ${port.customer || ""}`.trim();
    btn.title = `Belegt: ${occInfo}`;
    // Make occupied ports clickable to show copyable serial popup
    btn.disabled = false;
    btn.style.cursor = "pointer";
    btn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      _showOccupiedPortPopup(btn, port);
    });
  } else if (port.status === "unavailable") {
    btn.classList.add("na"); btn.disabled = true;
  } else {
    btn.classList.add("free");
    btn.addEventListener("click", () => onPick(label));
  }

  if (isSel) {
    btn.classList.add("sel");
    if (isOcc) btn.classList.add("occ");
  }

  return btn;
}

/** Show a small popup near the port button with copyable serial info */
function _showOccupiedPortPopup(anchorBtn, port) {
  // Remove any existing popup
  document.querySelectorAll(".occ-port-popup").forEach(p => p.remove());

  const serial = port.serial || "-";
  const customer = port.customer || "-";

  const popup = document.createElement("div");
  popup.className = "occ-port-popup";
  popup.innerHTML = `
    <div style="font-size:.72rem;color:var(--text-muted,#999);margin-bottom:4px;">Port belegt</div>
    <div style="display:flex;align-items:center;gap:6px;margin-bottom:4px;">
      <span style="font-weight:700;font-size:.88rem;">${esc(serial)}</span>
      <button class="occ-copy-btn" data-copy="${esc(serial)}" title="Serial kopieren" style="padding:2px 8px;font-size:.72rem;border-radius:6px;border:1px solid var(--border,#444);background:var(--surface-3,#31343a);color:var(--text,#e0e0e0);cursor:pointer;">Kopieren</button>
    </div>
    <div style="font-size:.78rem;color:var(--text-muted,#bbb);">${esc(customer)}</div>
  `;

  // Position near the button
  const rect = anchorBtn.getBoundingClientRect();
  popup.style.position = "fixed";
  popup.style.left = rect.left + "px";
  popup.style.top = (rect.bottom + 4) + "px";
  popup.style.zIndex = "9999";
  popup.style.background = "var(--card-bg, #1e1e2e)";
  popup.style.border = "1px solid var(--border, #444)";
  popup.style.borderRadius = "10px";
  popup.style.padding = "10px 14px";
  popup.style.boxShadow = "0 8px 24px rgba(0,0,0,.5)";
  popup.style.minWidth = "180px";

  document.body.appendChild(popup);

  // Copy button handler
  popup.querySelector(".occ-copy-btn").addEventListener("click", (ev) => {
    ev.stopPropagation();
    navigator.clipboard.writeText(serial).then(() => {
      ev.target.textContent = "\u2713";
      setTimeout(() => { ev.target.textContent = "Kopieren"; }, 1200);
    });
  });

  // Close popup on click outside
  function closePopup(ev) {
    if (!popup.contains(ev.target) && ev.target !== anchorBtn) {
      popup.remove();
      document.removeEventListener("click", closePopup, true);
    }
  }
  setTimeout(() => document.addEventListener("click", closePopup, true), 10);
}

/* Reusable port grid binder with selection feedback */
function _bindPortGrid(gridEl, labelEl, ports, stateObj, ppName) {
  function pick(label) {
    stateObj.portLabel = label;
    labelEl.textContent = `Gewaehlt: ${ppName} / Port ${label}`;
    labelEl.style.display = "block";
    renderPortGrid(gridEl, ports, pick, label);
  }
  renderPortGrid(gridEl, ports, pick, stateObj.portLabel);
}

/* ── CC Preview Card HTML ── */
function ccPreviewHtml(cc) {
  if (!cc) return "";
  const g = (key) => esc(String(cc[key] ?? "-"));
  return `<div class="cc-preview"><div class="cc-grid">
    <div><div class="cc-label">Serial</div><div class="cc-val">${g("serial")}</div></div>
    <div><div class="cc-label">Kunde</div><div class="cc-val">${g("system_name")}</div></div>
    <div><div class="cc-label">Raum</div><div class="cc-val">${g("customer_room")}</div></div>
    <div><div class="cc-label">Switch</div><div class="cc-val">${g("switch_name")}:${g("switch_port")}</div></div>
    <div><div class="cc-label">A-Seite</div><div class="cc-val">${g("a_patchpanel_id")} / ${g("a_port_label")}</div></div>
    <div><div class="cc-label">Z-Seite</div><div class="cc-val">${g("customer_patchpanel_instance_id") !== "-" ? g("customer_patchpanel_instance_id") : g("customer_patchpanel_id")} / ${g("customer_port_label")}</div></div>
    <div><div class="cc-label">BB IN</div><div class="cc-val">${g("backbone_in_instance_id")} / ${g("backbone_in_port_label")}</div></div>
    <div><div class="cc-label">BB OUT</div><div class="cc-val">${g("backbone_out_instance_id")} / ${g("backbone_out_port_label")}</div></div>
    <div><div class="cc-label">Status</div><div class="cc-val">${g("status")}</div></div>
  </div></div>`;
}

/* ── Serial Lookup ── */
async function lookupSerial(serial) {
  const s = String(serial || "").trim();
  if (!s) throw new Error("Bitte Serial eingeben.");
  const d = await apiJson(`${API_CC_SERIAL}/by-serial?serial=${encodeURIComponent(s)}`);
  if (!d.success || !d.data) throw new Error("Leitung nicht gefunden.");
  return d.data;
}

/* ══════════════════════════════════════
   WEEK TABLE — Plans + Changes
   ══════════════════════════════════════ */
function computeCounts() {
  const all = state.changes;
  const byType = { NEW_INSTALL: 0, DEINSTALL: 0, LINE_MOVE: 0, PATH_MOVE: 0 };
  const byTypeFiltered = { NEW_INSTALL: 0, DEINSTALL: 0, LINE_MOVE: 0, PATH_MOVE: 0 };
  let openC = 0, doneC = 0;
  for (const c of all) {
    const t = String(c.type || "").toUpperCase();
    if (byType[t] !== undefined) byType[t]++;
    const s = String(c.status || "").toLowerCase();
    if (s === "done") doneC++; else if (s !== "canceled") openC++;
    // Count per type respecting current status filter
    const matchesStatus =
      state.statusFilter === "all" ? true :
      state.statusFilter === "done" ? s === "done" :
      (s !== "done" && s !== "canceled"); // "open"
    if (matchesStatus && byTypeFiltered[t] !== undefined) byTypeFiltered[t]++;
  }
  return { total: all.length, byType, byTypeFiltered, openC, doneC };
}

function renderCounts() {
  const c = computeCounts();
  const set = (id, v) => { const e = $(id); if (e) e.textContent = v; };
  set("countInstall", c.byTypeFiltered.NEW_INSTALL);
  set("countDeinstall", c.byTypeFiltered.DEINSTALL);
  set("countLineMove", c.byTypeFiltered.LINE_MOVE);
  set("countPathMove", c.byTypeFiltered.PATH_MOVE);
  set("countOpen", c.openC); set("countDone", c.doneC);
  set("countAllStatus", c.total);
  const strip = $("kwStats");
  if (strip) strip.innerHTML = `
    <div class="kw-stat-chip install">Install <span class="chip-count">${c.byType.NEW_INSTALL}</span></div>
    <div class="kw-stat-chip deinstall">Deinstall <span class="chip-count">${c.byType.DEINSTALL}</span></div>
    <div class="kw-stat-chip linemove">Line Move <span class="chip-count">${c.byType.LINE_MOVE}</span></div>
    <div class="kw-stat-chip pathmove">Path Move <span class="chip-count">${c.byType.PATH_MOVE}</span></div>
    <div class="kw-stat-chip done">Erledigt <span class="chip-count">${c.doneC}</span></div>
    <div class="kw-stat-chip open">Offen <span class="chip-count">${c.openC}</span></div>`;
}

function applyFilters() {
  let items = [...state.changes];
  if (state.typeFilter !== "all")
    items = items.filter(c => String(c.type || "").toUpperCase() === state.typeFilter);
  if (state.statusFilter === "open")
    items = items.filter(c => { const s = String(c.status||"").toLowerCase(); return s !== "done" && s !== "canceled"; });
  else if (state.statusFilter === "done")
    items = items.filter(c => String(c.status||"").toLowerCase() === "done");
  state.filtered = items;
}

function renderKwNavigator() {
  /* ── Year / Month selectors ── */
  const yearSel = $("kwYear"), monthSel = $("kwMonth");
  if (yearSel) {
    yearSel.innerHTML = "";
    for (let y = state.kwNavYear + 1; y >= state.kwNavYear - 2; y--) {
      const o = document.createElement("option"); o.value = y; o.textContent = y;
      if (y === state.kwNavYear) o.selected = true;
      yearSel.appendChild(o);
    }
  }
  if (monthSel) {
    monthSel.innerHTML = "";
    MONTH_NAMES_DE.forEach((name, i) => {
      const o = document.createElement("option"); o.value = i; o.textContent = name;
      if (i === state.kwNavMonth) o.selected = true;
      monthSel.appendChild(o);
    });
  }

  /* ── KW Chips ── */
  const bar = $("kwChipsBar"); if (!bar) return;
  bar.innerHTML = "";
  const weeks = getWeeksForMonth(state.kwNavYear, state.kwNavMonth);
  const curLabel = currentIsoKwLabel();
  const planMap = new Map();
  state.plans.forEach(p => planMap.set(p.kw, p));

  // Auto-select: keep current selection if valid, else pick current week or first existing
  if (!state.selectedKw || (!planMap.has(state.selectedKw) && !weeks.find(w => w.label === state.selectedKw))) {
    const curWeek = weeks.find(w => w.label === curLabel);
    const existingInRange = weeks.find(w => planMap.has(w.label));
    if (curWeek && planMap.has(curWeek.label)) state.selectedKw = curWeek.label;
    else if (curWeek) state.selectedKw = curWeek.label;
    else if (existingInRange) state.selectedKw = existingInRange.label;
    else if (weeks.length) state.selectedKw = weeks[0].label;
  }

  for (const w of weeks) {
    const plan = planMap.get(w.label);
    const chip = document.createElement("div");
    const statusCls = kwChipStatus(plan);
    chip.className = `kw-chip ${statusCls}`;
    if (w.label === state.selectedKw) chip.classList.add("active");
    if (w.label === curLabel) chip.classList.add("current-week");
    chip.textContent = `KW${String(w.kw).padStart(2, "0")}`;
    chip.dataset.kw = w.label;
    chip.dataset.year = w.year;
    chip.dataset.kwNum = w.kw;
    chip.addEventListener("click", () => selectKwChip(w.label, w.year, w.kw));
    chip.addEventListener("mouseenter", ev => showKwTooltip(ev, w, plan));
    chip.addEventListener("mouseleave", hideKwTooltip);
    bar.appendChild(chip);
  }
}

async function selectKwChip(label, year, kwNum) {
  let plan = state.plans.find(p => p.kw === label);
  if (!plan) {
    try {
      const d = await apiJson(API_KW_PLANS, {
        method: "POST", headers: {"Content-Type":"application/json"},
        body: JSON.stringify({ kw: label, status: "open" }),
      });
      if (d.plan) {
        const plansData = await apiJson(`${API_KW_PLANS}?limit=500`);
        state.plans = Array.isArray(plansData.items) ? plansData.items : [];
        toast(d.created ? "Kalenderwoche angelegt" : "Kalenderwoche geladen", "success");
      }
    } catch(e) {
      toast(`Fehler: ${e.message}`, "error"); return;
    }
  }
  state.selectedKw = label;
  renderKwNavigator();
  renderPlanInfo();
  try { await loadChanges(label); } catch(e) { toast(`Fehler: ${e.message}`, "error"); }
}

function showKwTooltip(ev, week, plan) {
  const tip = $("kwTooltip"); if (!tip) return;
  const statusMap = { open: "Offen", locked: "Gesperrt", completed: "Abgeschlossen" };
  if (plan) {
    const total = plan.changes_total || 0;
    const open = plan.open_changes || 0;
    const done = total - open;
    tip.innerHTML = `
      <div class="tt-label">${esc(plan.kw)}</div>
      <div class="tt-row"><span class="tt-muted">Status</span><span>${esc(statusMap[plan.status] || plan.status)}</span></div>
      <div class="tt-row"><span class="tt-muted">Erledigt</span><span>${done}/${total}</span></div>
      <div class="tt-row"><span class="tt-muted">Offen</span><span>${open}</span></div>
      ${plan.created_at ? `<div class="tt-row"><span class="tt-muted">Erstellt</span><span>${fmtDate(plan.created_at)}</span></div>` : ""}
    `;
  } else {
    tip.innerHTML = `
      <div class="tt-label">${esc(week.label)}</div>
      <div class="tt-muted" style="margin-top:2px;">Noch nicht angelegt</div>
      <div style="margin-top:4px; font-size:.78rem; color:#60a5fa;">Klicken zum Erstellen</div>
    `;
  }
  const rect = ev.target.getBoundingClientRect();
  tip.style.left = rect.left + "px";
  tip.style.top = (rect.bottom + 8) + "px";
  tip.classList.add("visible");
}

function hideKwTooltip() {
  const tip = $("kwTooltip"); if (!tip) return;
  tip.classList.remove("visible");
}

function renderPlanInfo() {
  const infoBar = $("kwInfoBar"), main = $("kwInfoMain");
  const prog = $("planProgress"), bar = $("planProgressBar");
  const btnFinish = $("btnFinishKw"), btnReport = $("btnDownloadReport");
  const actionCard = $("actionCard");
  const plan = state.plans.find(p => p.kw === state.selectedKw);
  if (!plan) {
    if (infoBar) infoBar.style.display = "none";
    if (btnFinish) btnFinish.style.display = "none";
    if (btnReport) btnReport.style.display = "none";
    return;
  }
  if (infoBar) infoBar.style.display = "";
  if (btnFinish) btnFinish.style.display = "inline-flex";
  if (btnReport) btnReport.style.display = "inline-flex";
  const total = plan.changes_total || 0, open = plan.open_changes || 0, done = total - open;
  const pct = total > 0 ? Math.round(done / total * 100) : 0;
  const isCompleted = plan.status === "completed";
  const sl = plan.status === "open" ? "Offen" : plan.status === "locked" ? "Gesperrt" : isCompleted ? "Abgeschlossen" : plan.status;
  if (main) main.innerHTML = `<b>${esc(plan.kw)}</b> &middot; Status: <b>${esc(sl)}</b> &middot; Fortschritt: ${done}/${total} erledigt (${pct}%)`;
  if (prog && bar) { prog.style.display = total ? "block" : "none"; bar.style.width = `${pct}%`; }
  if (btnFinish) btnFinish.style.display = isCompleted ? "none" : "inline-flex";
  if (btnReport) btnReport.style.display = "inline-flex";
  if (actionCard) actionCard.style.display = isCompleted ? "none" : "";
}

function renderChanges() {
  applyFilters(); renderCounts();
  const body = $("changesBody"), empty = $("changesEmpty");
  if (!body || !empty) return;
  body.innerHTML = "";
  if (!state.filtered.length) {
    empty.style.display = "block";
    empty.textContent = state.changes.length ? "Keine Massnahmen fuer den aktuellen Filter." : "Keine Massnahmen fuer diese KW vorhanden.";
    return;
  }
  empty.style.display = "none";
  const plan = state.plans.find(p => p.kw === state.selectedKw);
  const planCompleted = plan && plan.status === "completed";
  for (const ch of state.filtered) {
    const s = String(ch.status || "").toLowerCase();
    const locked = s === "done" || s === "canceled" || planCompleted;
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td><button class="btn" data-action="expand" data-id="${ch.id}" style="padding:2px 7px;font-size:.8rem;" title="Details">&#9660;</button></td>
      <td>${typePill(ch.type)}</td>
      <td class="mono">${esc(changeTarget(ch))}</td>
      <td>${esc(changeLogicalName(ch))}</td>
      <td>${statusBadge(ch.status, ch.id)}</td>
      <td class="small muted">${fmtDate(ch.created_at)}</td>
      <td style="white-space:nowrap; text-align:right;">
        <div class="row-actions">
        <button class="btn" data-action="edit" data-id="${ch.id}" ${locked?"disabled":""}>Bearbeiten</button>
        <button class="btn btn-secondary" data-action="apply" data-id="${ch.id}" ${locked?"disabled":""}>Done</button>
        <button class="btn btn-danger" data-action="delete" data-id="${ch.id}" ${locked?"disabled":""} style="padding:4px 8px;">&#128465;</button>
        </div>
      </td>`;
    body.appendChild(tr);
    const exp = document.createElement("tr");
    exp.className = "expand-row"; exp.id = `expand-${ch.id}`;
    exp.innerHTML = `<td colspan="7" class="expand-cell">${renderDetail(ch)}</td>`;
    body.appendChild(exp);
  }
}

function renderDetail(ch) {
  const t = String(ch.type||"").toUpperCase(), p = ch.payload_json || {};
  const f = (label, val) => `<div class="detail-item"><div class="detail-label">${esc(label)}</div><div class="detail-value">${esc(String(val??"-"))}</div></div>`;
  let h = '<div class="detail-grid">';

  if (t === "NEW_INSTALL") {
    const l = p.new_line || p;
    h += f("Serial", l.serial);
    h += f("Kunde", l.system_name);
    h += f("Status", ch.status);
    h += f("RFRA Switch", l.switch_name);
    h += f("RFRA Port", l.switch_port);
    h += f("A-Patchpanel", l.a_patchpanel_id);
    h += f("A-Port", l.a_port_label);
    h += f("Z-Patchpanel", l.customer_patchpanel_instance_id || l.customer_patchpanel_id);
    h += f("Z-Port", l.customer_port_label);
    h += f("BB IN", `${l.backbone_in_instance_id||"-"} / ${l.backbone_in_port_label||"-"}`);
    h += f("BB OUT", `${l.backbone_out_instance_id||"-"} / ${l.backbone_out_port_label||"-"}`);
    if (l.product_id) h += f("Product ID", l.product_id);
    if (l.logical_name) h += f("Logical Name", l.logical_name);
  } else if (t === "DEINSTALL") {
    const snap = p.snapshot_before || {};
    h += f("Serial", snap.serial || "-");
    h += f("Kunde", snap.system_name || "-");
    h += f("Status", ch.status);
    h += f("RFRA Switch", snap.switch_name);
    h += f("RFRA Port", snap.switch_port);
    h += f("A-Patchpanel", snap.a_patchpanel_id);
    h += f("A-Port", snap.a_port_label);
    h += f("Z-Patchpanel", snap.customer_patchpanel_instance_id || snap.customer_patchpanel_id);
    h += f("Z-Port", snap.customer_port_label);
    h += f("BB IN", `${snap.backbone_in_instance_id||"-"} / ${snap.backbone_in_port_label||"-"}`);
    h += f("BB OUT", `${snap.backbone_out_instance_id||"-"} / ${snap.backbone_out_port_label||"-"}`);
    if (p.reason) h += f("Grund", p.reason);
  } else if (t === "LINE_MOVE") {
    const oz = p.old_z||{}, nz = p.new_z||{}, snap = p.snapshot||{};
    h += f("Leitung ID", ch.target_cross_connect_id);
    h += f("Serial", snap.serial || p.serial || "-");
    h += f("Kunde", snap.customer || snap.system_name || "-");
    h += f("Status", ch.status);
    h += f("RFRA Switch", snap.switch_name);
    h += f("RFRA Port", snap.switch_port);
    h += f("A-Patchpanel", snap.a_patchpanel_id);
    h += f("A-Port", snap.a_port_label);
    h += f("Alter Z-PP", oz.customer_patchpanel_instance_id||oz.customer_patchpanel_id||"-");
    h += f("Alter Z-Port", oz.customer_port_label);
    h += f("Neuer Z-PP", nz.customer_patchpanel_instance_id||nz.customer_patchpanel_id||"-");
    h += f("Neuer Z-Port", nz.customer_port_label);
    const ob = p.old_bb||{};
    h += f("Alter BB IN", `${ob.backbone_in_instance_id||"-"} / ${ob.backbone_in_port_label||"-"}`);
    h += f("Alter BB OUT", `${ob.backbone_out_instance_id||"-"} / ${ob.backbone_out_port_label||"-"}`);
    const nb = nz;
    if (nb.backbone_in_instance_id) h += f("Neuer BB IN", `${nb.backbone_in_instance_id} / ${nb.backbone_in_port_label||"-"}`);
    if (nb.backbone_out_instance_id) h += f("Neuer BB OUT", `${nb.backbone_out_instance_id} / ${nb.backbone_out_port_label||"-"}`);
    if (nz.rack_code) h += f("Rack", nz.rack_code);
  } else if (t === "PATH_MOVE") {
    h += f("Leitung A", p.line_a_serial || p.line_a_id);
    h += f("Leitung B", p.line_b_serial || p.line_b_id);
    h += f("Status", ch.status);
    const a = p.line_a_old_bb||{}, b = p.line_b_old_bb||{};
    h += f("A BB IN (alt)", `${a.backbone_in_instance_id||"-"} / ${a.backbone_in_port_label||"-"}`);
    h += f("A BB OUT (alt)", `${a.backbone_out_instance_id||"-"} / ${a.backbone_out_port_label||"-"}`);
    h += f("B BB IN (alt)", `${b.backbone_in_instance_id||"-"} / ${b.backbone_in_port_label||"-"}`);
    h += f("B BB OUT (alt)", `${b.backbone_out_instance_id||"-"} / ${b.backbone_out_port_label||"-"}`);
  }
  return h + "</div>";
}

/* ── Data Loading ── */
async function loadPlans(preferredKw) {
  const d = await apiJson(`${API_KW_PLANS}?limit=500`);
  state.plans = Array.isArray(d.items) ? d.items : [];
  if (preferredKw) state.selectedKw = preferredKw;
  renderKwNavigator(); renderPlanInfo();
  if (state.selectedKw) await loadChanges(state.selectedKw);
}

async function loadChanges(kw) {
  if (!kw) { state.changes = []; renderChanges(); return; }
  const d = await apiJson(`${API_KW_CHANGES}?kw=${encodeURIComponent(kw)}`);
  state.changes = Array.isArray(d.items) ? d.items : [];
  renderChanges();
}

/* ══════════════════════════════════════
   EDIT existing change (kept)
   ══════════════════════════════════════ */
function openEdit(change) {
  const type = String(change.type||"").toUpperCase();

  /* ── NEW_INSTALL: reuse the full install modal ── */
  if (type === "NEW_INSTALL") {
    openEditInstall(change);
    return;
  }

  /* ── LINE_MOVE: reuse the full Line Move modal ── */
  if (type === "LINE_MOVE") {
    openEditLineMove(change).catch(e => toast(`Fehler: ${e.message}`, "error"));
    return;
  }

  /* ── Other types: generic edit modal (unchanged) ── */
  state.editing = change;
  const meta = TYPE_META[type] || {};
  $("editType").value = meta.label || String(change.type || "");
  $("editTarget").value = changeTarget(change);
  $("editStatus").value = String(change.status||"planned").toLowerCase();
  const payload = change.payload_json || {};
  const host = $("editDynamic"); if (!host) return;
  const inp = (id,lbl,val) => `<div><label class="small muted">${esc(lbl)}</label><input id="${id}" class="input" value="${esc(val||"")}" /></div>`;
  if (type === "LINE_MOVE") {
    const nz = payload.new_z || {};
    host.innerHTML = inp("edMovePP","Neue Z PP",nz.customer_patchpanel_instance_id||nz.customer_patchpanel_id)+inp("edMovePort","Neue Z Port",nz.customer_port_label)
      +inp("edMoveBbIn","BB IN PP",nz.backbone_in_instance_id)+inp("edMoveBbInPort","BB IN Port",nz.backbone_in_port_label)
      +inp("edMoveBbOut","BB OUT PP",nz.backbone_out_instance_id)+inp("edMoveBbOutPort","BB OUT Port",nz.backbone_out_port_label);
  } else if (type === "PATH_MOVE") {
    host.innerHTML = inp("edPathA","Leitung A (ID)",payload.line_a_id)+inp("edPathB","Leitung B (ID)",payload.line_b_id);
  } else if (type === "DEINSTALL") {
    host.innerHTML = `<div class="span-2"><label class="small muted">Grund</label><input id="edReason" class="input" value="${esc(payload.reason||"")}" /></div>`;
  } else {
    host.innerHTML = '<div class="small muted">Kein Editor fuer diesen Typ.</div>';
  }
  showModal("editBackdrop");
}

/* Open the install modal in EDIT mode, pre-filled with existing data */
async function openEditInstall(change) {
  state.editingInstall = change;
  resetNiState();

  const payload = change.payload_json || {};
  const l = payload.new_line || payload;

  // Pre-fill Grunddaten
  if ($("niSerial"))      $("niSerial").value      = l.serial || "";
  if ($("niSalesOrder"))  $("niSalesOrder").value  = l.sales_order || "";
  if ($("niProductId"))   $("niProductId").value   = l.product_id || "";
  if ($("niLogicalName")) $("niLogicalName").value = l.logical_name || "";

  // Pre-fill A-Seite
  if ($("niSwitchName")) $("niSwitchName").value = l.switch_name || "";
  if ($("niSwitchPort")) $("niSwitchPort").value = l.switch_port || "";
  state.ni.switchName = l.switch_name || "";
  state.ni.switchPort = l.switch_port || "";
  state.ni.aPPInstanceId = l.a_patchpanel_id || "";
  state.ni.aPortLabel = l.a_port_label || "";

  // Pre-fill Z-Seite
  if ($("niZPP")) $("niZPP").value = l.customer_patchpanel_instance_id || l.customer_patchpanel_id || "";
  state.ni.zPPInstanceId = l.customer_patchpanel_instance_id || "";
  state.ni.zPPDbId = l.customer_patchpanel_id || null;
  state.ni.zPortLabel = l.customer_port_label || "";
  state.ni.zCustomer = l.system_name || "";
  if ($("niZCustomer")) $("niZCustomer").value = l.system_name || "";

  // Pre-fill BB
  state.ni.bbInInstanceId = l.backbone_in_instance_id || "";
  state.ni.bbInPortLabel = l.backbone_in_port_label || "";
  state.ni.bbOutInstanceId = l.backbone_out_instance_id || "";
  state.ni.bbOutPortLabel = l.backbone_out_port_label || "";

  // Switch modal to edit mode
  const titleEl = $("niModalTitle");
  if (titleEl) titleEl.innerHTML = '<span class="type-pill install">&#9998; Install</span> Massnahme bearbeiten';
  const saveBtn = $("btnSaveInstall");
  if (saveBtn) saveBtn.textContent = "Speichern";
  const delBtn = $("btnDeleteInstall");
  if (delBtn) delBtn.style.display = "inline-block";

  // Hide autocomplete lists
  ["niSwitchNameList","niSwitchPortList","niZPPList"].forEach(id => {
    const e=$(id); if(e) e.classList.remove("show");
  });

  // Clear dynamic sections before re-triggering
  const aside = $("niASideResult"); if (aside) { aside.style.display="none"; aside.innerHTML=""; }
  const bbout = $("niBbOutResult"); if (bbout) { bbout.style.display="none"; bbout.innerHTML=""; }
  const bbCards = $("niBbInCards"); if (bbCards) bbCards.innerHTML = "";
  $("niZPortGrid").innerHTML = "";
  $("niBbInPortGrid").innerHTML = "";
  if ($("niZPortLabel")) { $("niZPortLabel").style.display = "none"; }
  if ($("niBbInPortLabel")) { $("niBbInPortLabel").style.display = "none"; }

  showModal("modalInstall");

  // Trigger A-side auto-resolve
  if (l.switch_name && l.switch_port) {
    await niTryResolveAside();
  }

  // Trigger Z-side lookup if PP is set
  const zppVal = (l.customer_patchpanel_instance_id || "").trim();
  if (zppVal) {
    try {
      const d = await apiJson(`${API_RACKVIEW}/customer-pp-lookup?instance_id=${encodeURIComponent(zppVal)}`);
      if (d.found) {
        await niApplyZSideLookup(d);
        // Re-select the Z port that was previously selected
        if (l.customer_port_label) {
          state.ni.zPortLabel = l.customer_port_label;
          const zPortLabel = $("niZPortLabel");
          if (zPortLabel) {
            zPortLabel.textContent = `Gewaehlt: ${d.instance_id} / Port ${l.customer_port_label}`;
            zPortLabel.style.display = "block";
          }
          // Re-render port grid with selection
          if (d.db_id) {
            try {
              const ports = await fetchPorts(d.db_id);
              _bindPortGrid($("niZPortGrid"), $("niZPortLabel"), ports,
                { get portLabel() { return state.ni.zPortLabel; }, set portLabel(v) { state.ni.zPortLabel = v; } },
                d.instance_id);
            } catch(e) { /* ignore */ }
          }
        }
      }
    } catch(e) { /* ignore */ }
  }

  // Pre-select BB IN panel and port if set
  if (l.backbone_in_instance_id && state.ni.bbPanels.length) {
    const bbIdx = state.ni.bbPanels.findIndex(p => p.bb_instance_id === l.backbone_in_instance_id);
    if (bbIdx >= 0) {
      await niSelectBBPanel(bbIdx);
      if (l.backbone_in_port_label) {
        state.ni.bbInPortLabel = l.backbone_in_port_label;
        const lbl = $("niBbInPortLabel");
        if (lbl) {
          lbl.textContent = `Gewaehlt: ${l.backbone_in_instance_id} / Port ${l.backbone_in_port_label}`;
          lbl.style.display = "block";
        }
        if (state.ni.bbPanels[bbIdx]?.bb_db_id) {
          try {
            const ports = await fetchPorts(state.ni.bbPanels[bbIdx].bb_db_id);
            function pickBbPort(label) {
              state.ni.bbInPortLabel = label;
              $("niBbInPortLabel").textContent = `Gewaehlt: ${l.backbone_in_instance_id} / Port ${label}`;
              $("niBbInPortLabel").style.display = "block";
              renderPortGrid($("niBbInPortGrid"), ports, pickBbPort, label);
              niResolveBBOut(l.backbone_in_instance_id, label);
            }
            renderPortGrid($("niBbInPortGrid"), ports, pickBbPort, l.backbone_in_port_label);
          } catch(e) { /* ignore */ }
        }
        // Show BB OUT and restore state (niLoadBBContext / niSelectBBPanel clear it)
        if (l.backbone_out_instance_id) {
          state.ni.bbOutInstanceId = l.backbone_out_instance_id;
          state.ni.bbOutPortLabel = l.backbone_out_port_label || "";
          const bboutEl = $("niBbOutResult");
          if (bboutEl) {
            bboutEl.style.display = "block";
            bboutEl.innerHTML = `<div class="af-grid">
              <div><div class="af-label">BB OUT Panel</div><div class="af-val">${esc(l.backbone_out_instance_id)}</div></div>
              <div><div class="af-label">BB OUT Port</div><div class="af-val">${esc(l.backbone_out_port_label || "-")}</div></div>
            </div>`;
          }
        }
      }
    }
  }
}

function collectEditedPayload(change) {
  const t = String(change.type||"").toUpperCase(), p = { ...(change.payload_json||{}) };
  const v = id => String($(id)?.value || "").trim();
  if (t === "LINE_MOVE") {
    const origNz = (p.new_z || {});
    const lmVal = v("edMovePP");
    const lmNum = Number(lmVal);
    const lmId = (lmNum && !isNaN(lmNum)) ? lmNum : (origNz.customer_patchpanel_id || 0);
    const lmInstanceId = (lmNum && !isNaN(lmNum)) ? (origNz.customer_patchpanel_instance_id || "") : lmVal;
    p.new_z = {
      customer_patchpanel_id: lmId,
      customer_patchpanel_instance_id: lmInstanceId,
      customer_port_label: v("edMovePort"),
      backbone_in_instance_id: v("edMoveBbIn") || null,
      backbone_in_port_label: v("edMoveBbInPort") || null,
      backbone_out_instance_id: v("edMoveBbOut") || null,
      backbone_out_port_label: v("edMoveBbOutPort") || null,
    };
  } else if (t === "PATH_MOVE") {
    p.line_a_id = Number(v("edPathA")||0); p.line_b_id = Number(v("edPathB")||0);
  } else if (t === "DEINSTALL") {
    p.reason = v("edReason");
  }
  return p;
}

async function saveEdit() {
  const ch = state.editing; if (!ch) return;
  const pj = collectEditedPayload(ch);
  const status = String($("editStatus").value || "planned").toLowerCase();
  await apiJson(`${API_KW_CHANGES}/${ch.id}`, {
    method: "PATCH", headers: {"Content-Type":"application/json"},
    body: JSON.stringify({ status, payload_json: pj }),
  });
  closeAllModals();
  await loadChanges(state.selectedKw); await loadPlans(state.selectedKw);
  toast("Massnahme aktualisiert", "success");
}

/* ── KW Finish / Report ── */
async function finishKw() {
  const plan = state.plans.find(p => p.kw === state.selectedKw);
  if (!plan) { toast("Keine KW ausgewaehlt", "error"); return; }
  if (plan.status === "completed") { toast("KW bereits abgeschlossen", "info"); return; }
  const open = plan.open_changes || 0;
  let msg = `KW ${plan.kw} wirklich abschliessen?\n\nDanach koennen keine Aenderungen mehr vorgenommen werden.`;
  if (open > 0) msg += `\n\n${open} offene Massnahme(n) werden automatisch abgebrochen.`;
  if (!confirm(msg)) return;
  const d = await apiJson(`${API_KW_PLANS}/${plan.id}/complete`, { method: "POST" });
  await loadPlans(state.selectedKw);
  await loadChanges(state.selectedKw);
  const canceled = d.canceled_open || 0;
  toast(`KW ${plan.kw} abgeschlossen!${canceled ? ` (${canceled} offene abgebrochen)` : ""} Report steht zum Download bereit.`, "success");
}

async function downloadReport() {
  const plan = state.plans.find(p => p.kw === state.selectedKw);
  if (!plan) { toast("Keine KW ausgewaehlt", "error"); return; }
  if (plan.status !== "completed") { toast("Report nur fuer abgeschlossene KW verfuegbar", "error"); return; }
  try {
    const res = await fetch(`${API_KW_PLANS}/${plan.id}/report.xlsx`);
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.detail || `HTTP ${res.status}`);
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `KW_Report_${plan.kw}.xlsx`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    toast("Report heruntergeladen", "success");
  } catch (e) {
    toast(`Fehler: ${e.message}`, "error");
  }
}

/* ── Table Actions ── */
async function createKw() {
  const val = prompt("Neue Kalenderwoche (YYYY-KWNN)", currentIsoKwLabel());
  const kw = String(val || "").trim().toUpperCase(); if (!kw) return;
  const d = await apiJson(API_KW_PLANS, { method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({kw, status:"open"}) });
  await loadPlans(d?.plan?.kw || kw);
  toast("Kalenderwoche angelegt", "success");
}

async function applyChange(ch) {
  const meta = TYPE_META[String(ch.type||"").toUpperCase()] || {};
  if (!confirm(`Massnahme #${ch.id} (${meta.label||ch.type}) wirklich ausfuehren?\nDies aendert die Live-Daten.`)) return;
  await apiJson(`${API_KW_CHANGES}/${ch.id}/apply`, { method:"POST" });
  await loadChanges(state.selectedKw); await loadPlans(state.selectedKw);
  toast("Massnahme ausgefuehrt", "success");
}

async function cancelChange(ch) {
  if (!confirm(`Massnahme #${ch.id} abbrechen?`)) return;
  await apiJson(`${API_KW_CHANGES}/${ch.id}`, { method:"PATCH", headers:{"Content-Type":"application/json"}, body:JSON.stringify({status:"canceled"}) });
  await loadChanges(state.selectedKw); await loadPlans(state.selectedKw);
  toast("Massnahme abgebrochen", "success");
}

/* ══════════════════════════════════════
   MODAL helpers
   ══════════════════════════════════════ */
function showModal(id) {
  const el = $(id);
  if (el) { el.classList.add("show"); el.style.display = "block"; }
  document.documentElement.classList.add("modal-open");
}
function hideModal(id) {
  const el = $(id);
  if (el) { el.classList.remove("show"); el.style.display = "none"; }
}
function closeAllModals() {
  ["editBackdrop","modalInstall","modalDeinstall","modalLineMove","modalPathMove"].forEach(hideModal);
  state.editing = null;
  resetInstallModalMode();
  resetLineMoveModalMode();
  document.documentElement.classList.remove("modal-open");
}

/* ══════════════════════════════════════
   FORM: NEW INSTALL  (text-input + auto-fill)
   ══════════════════════════════════════ */

function resetNiState() {
  state.ni = {
    switchName: "", switchPort: "",
    aRoom: "", aPPInstanceId: "", aPPDbId: null, aPortLabel: "",
    zPPInstanceId: "", zPPDbId: null, zRoom: "", zCustomer: "", zPortLabel: "",
    bbInDbId: null, bbInInstanceId: "", bbInPortLabel: "",
    bbOutInstanceId: "", bbOutPortLabel: "",
    bbPanels: [], selectedBbIdx: -1,
  };
}

/** Normalize room: "M5.04 S6" → "5.4S6", "M4.5" → "4.5" */
function normalizeRoom(room) {
  let r = (room || "").trim();
  if (/^M\d/i.test(r)) r = r.slice(1);           // strip leading M if followed by digit
  r = r.replace(/\s+/g, "");                      // remove spaces
  r = r.replace(/^(\d+)\.0+(\d)/, "$1.$2");       // strip leading zeros: 5.04S6 → 5.4S6
  return r;
}

async function openInstallForm() {
  if (!state.selectedKw) { toast("Bitte zuerst eine KW waehlen.", "error"); return; }
  resetInstallModalMode();
  resetNiState();
  // Clear all fields
  ["niSerial","niSalesOrder","niProductId","niLogicalName","niSwitchName","niSwitchPort","niARoom","niZPP","niZCustomer","niZRoom"]
    .forEach(id => { const e=$(id); if(e) e.value=""; });
  ["niZPortGrid","niBbInPortGrid"].forEach(id => { const e=$(id); if(e) e.innerHTML=""; });
  ["niZPortLabel","niBbInPortLabel"].forEach(id => { const e=$(id); if(e) { e.style.display="none"; e.textContent=""; } });
  const aside = $("niASideResult"); if (aside) { aside.style.display="none"; aside.innerHTML=""; }
  const bbout = $("niBbOutResult"); if (bbout) { bbout.style.display="none"; bbout.innerHTML=""; }
  const bbCards = $("niBbInCards"); if (bbCards) bbCards.innerHTML = "";
  const bbHint = $("niBbInHint"); if (bbHint) bbHint.textContent = "Z-Seite eingeben, um passende BB IN PPs zu sehen.";
  // Hide autocomplete lists
  ["niSwitchNameList","niSwitchPortList","niZPPList"].forEach(id => {
    const e=$(id); if(e) e.classList.remove("show");
  });
  showModal("modalInstall");
}

/* ── Autocomplete helper ── */
function showAutocomplete(listEl, items, onPick) {
  listEl.innerHTML = "";
  listEl._acItems = items;
  listEl._acPick = onPick;
  listEl._acIdx = -1;
  if (!items.length) { listEl.classList.remove("show"); return; }
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const div = document.createElement("div");
    div.className = "autocomplete-item";
    div.dataset.acIndex = i;
    if (typeof item === "string") {
      div.textContent = item;
      div.addEventListener("click", () => { onPick(item); listEl.classList.remove("show"); });
    } else {
      div.innerHTML = `${esc(item.label)}<span class="ac-sub">${esc(item.sub || "")}</span>`;
      div.addEventListener("click", () => { onPick(item); listEl.classList.remove("show"); });
    }
    listEl.appendChild(div);
  }
  listEl.classList.add("show");
}

/** Handle Enter/ArrowDown/ArrowUp on an autocomplete input */
function handleAutocompleteKey(ev, listEl) {
  if (!listEl || !listEl.classList.contains("show")) return false;
  const items = listEl._acItems || [];
  const pick = listEl._acPick;
  if (!items.length || !pick) return false;

  if (ev.key === "ArrowDown") {
    ev.preventDefault();
    listEl._acIdx = Math.min((listEl._acIdx ?? -1) + 1, items.length - 1);
    _highlightAcItem(listEl);
    return true;
  }
  if (ev.key === "ArrowUp") {
    ev.preventDefault();
    listEl._acIdx = Math.max((listEl._acIdx ?? 0) - 1, 0);
    _highlightAcItem(listEl);
    return true;
  }
  if (ev.key === "Enter") {
    ev.preventDefault();
    const idx = (listEl._acIdx >= 0) ? listEl._acIdx : 0;
    if (items[idx] !== undefined) {
      pick(items[idx]);
      listEl.classList.remove("show");
    }
    return true;
  }
  return false;
}

function _highlightAcItem(listEl) {
  const children = listEl.querySelectorAll(".autocomplete-item");
  children.forEach((c, i) => c.classList.toggle("active", i === listEl._acIdx));
}

/* ── Switch Name Autocomplete ── */
let _swNameTimer = null;
function niSwitchNameInput() {
  clearTimeout(_swNameTimer);
  let val = ($("niSwitchName")?.value || "").trim();
  if (val.length < 2) { $("niSwitchNameList")?.classList.remove("show"); return; }

  // Auto-prefix RFRA when user types only digits (e.g. "3211" → search "RFRA3211")
  let searchVal = val;
  if (/^\d+$/.test(val)) {
    searchVal = "RFRA" + val;
  }

  _swNameTimer = setTimeout(async () => {
    try {
      const d = await apiJson(`${API_RACKVIEW}/switch-names?q=${encodeURIComponent(searchVal)}`);
      const items = d.items || [];
      // If exactly one match and user typed only digits, auto-fill immediately
      if (items.length === 1 && /^\d+$/.test(val)) {
        $("niSwitchName").value = items[0];
        state.ni.switchName = items[0];
        $("niSwitchNameList")?.classList.remove("show");
        niTryResolveAside();
        return;
      }
      showAutocomplete($("niSwitchNameList"), items, name => {
        $("niSwitchName").value = name;
        state.ni.switchName = name;
        niTryResolveAside();
      });
    } catch(e) { /* ignore */ }
  }, 250);
}

/* ── Switch Port Autocomplete ── */
let _swPortTimer = null;
function niSwitchPortInput() {
  clearTimeout(_swPortTimer);
  const sw = ($("niSwitchName")?.value || "").trim();
  let val = ($("niSwitchPort")?.value || "").trim();
  if (!sw || val.length < 1) { $("niSwitchPortList")?.classList.remove("show"); return; }

  // Auto-prefix: "12" → "ETH1/12", "1/12" → "ETH1/12", "ETH1/12" stays as-is
  let searchVal = val;
  if (/^\d+$/.test(val)) {
    // Pure digits like "12" → search as "ETH1/12"
    searchVal = "ETH1/" + val;
  } else if (/^\d+\/\d+$/.test(val)) {
    // Digit/digit like "1/12" → "ETH1/12"
    searchVal = "ETH" + val;
  }

  _swPortTimer = setTimeout(async () => {
    try {
      const d = await apiJson(`${API_RACKVIEW}/switch-ports?switch_name=${encodeURIComponent(sw)}&q=${encodeURIComponent(searchVal)}`);
      const items = d.items || [];
      // If exactly one match and user typed shorthand, auto-fill immediately
      if (items.length === 1 && /^\d+(\/\d+)?$/.test(val)) {
        $("niSwitchPort").value = items[0];
        state.ni.switchPort = items[0];
        $("niSwitchPortList")?.classList.remove("show");
        niTryResolveAside();
        return;
      }
      showAutocomplete($("niSwitchPortList"), items, port => {
        $("niSwitchPort").value = port;
        state.ni.switchPort = port;
        niTryResolveAside();
      });
    } catch(e) { /* ignore */ }
  }, 250);
}

/* ── Resolve A-Side from Switch+Port ── */
async function niTryResolveAside() {
  const sw = ($("niSwitchName")?.value || "").trim();
  const sp = ($("niSwitchPort")?.value || "").trim();
  const box = $("niASideResult");
  if (!sw || !sp) { if (box) box.style.display = "none"; return; }
  try {
    const d = await apiJson(`${API_RACKVIEW}/resolve-switch-port?switch_name=${encodeURIComponent(sw)}&switch_port=${encodeURIComponent(sp)}`);
    if (!d.found) {
      if (box) { box.style.display = "block"; box.innerHTML = '<span style="color:#ef5350;">Kein Pre-Cabled Link gefunden.</span>'; }
      state.ni.aRoom = ""; state.ni.aPPInstanceId = ""; state.ni.aPPDbId = null; state.ni.aPortLabel = "";
      $("niARoom").value = "";
      return;
    }
    state.ni.aRoom = d.a_room || "";
    state.ni.aPPInstanceId = d.a_pp_instance_id || "";
    state.ni.aPPDbId = d.a_pp_db_id;
    state.ni.aPortLabel = d.a_port_label || "";
    $("niARoom").value = d.a_room || "";
    if (box) {
      box.style.display = "block";
      box.innerHTML = `<div class="af-grid">
        <div><div class="af-label">Raum</div><div class="af-val">${esc(d.a_room)}</div></div>
        <div><div class="af-label">Patchpanel</div><div class="af-val">${esc(d.a_pp_instance_id)}</div></div>
        <div><div class="af-label">Port</div><div class="af-val">${esc(d.a_port_label)}</div></div>
      </div>`;
    }
  } catch(e) {
    if (box) { box.style.display = "block"; box.innerHTML = `<span style="color:#ef5350;">${esc(e.message)}</span>`; }
  }
}

/* ── Z-Side: Customer PP Autocomplete + Lookup ── */
let _zPPTimer = null;
function niZPPInput() {
  clearTimeout(_zPPTimer);
  const val = ($("niZPP")?.value || "").trim();
  if (val.length < 2) { $("niZPPList")?.classList.remove("show"); return; }
  _zPPTimer = setTimeout(async () => {
    try {
      const d = await apiJson(`${API_RACKVIEW}/patchpanel-search?q=${encodeURIComponent(val)}`);
      const items = (d.items || []).map(pp => ({
        label: pp.instance_id,
        sub: pp.existing_system_name || `${pp.customer_name || "?"} – ${(pp.customer_rooms && pp.customer_rooms.length) ? pp.customer_rooms.join(", ") : pp.room || "?"}`,
        _data: pp,
      }));
      showAutocomplete($("niZPPList"), items, item => {
        $("niZPP").value = item._data.instance_id;
        niApplyZSideLookup(item._data);
      });
    } catch(e) { /* ignore */ }
  }, 300);
}

/* Apply Z-side lookup result */
async function niApplyZSideLookup(pp) {
  state.ni.zPPInstanceId = pp.instance_id;
  state.ni.zPPDbId = pp.db_id;

  // If existing system_name from cross_connects is available, use it directly
  const existingSN = pp.existing_system_name || "";
  let customerRoom = "";
  let composedSystemName = "";

  if (existingSN) {
    // Parse system_name: "FR2:EG-M5.12:S1:SUSQUEHANNA" → room = "5.12"
    // Split by ':' — the room lives in the segment containing 'M',
    // e.g. "EG-M5.12" → "5.12", "OG-M1A2" → "1A2", "OG-M4.5" → "4.5"
    // Everything after (S1, OC, etc.) is cage/section, NOT room.
    const snParts = existingSN.split(":");
    for (const part of snParts) {
      const m = part.match(/M([\dA-Za-z.]+)/i);
      if (m) {
        customerRoom = normalizeRoom(m[1]);
        break;
      }
    }
    composedSystemName = existingSN;
  }

  // Fallback: derive from customer_rooms if no existing system_name
  if (!customerRoom) {
    const rooms = (pp.customer_rooms && pp.customer_rooms.length) ? pp.customer_rooms : (pp.room ? [pp.room] : []);
    customerRoom = rooms.length ? normalizeRoom(rooms[0]) : "";
  }
  if (!composedSystemName) {
    const displayRoom = customerRoom ? ("M" + customerRoom.replace(/^M/i, "")) : (pp.room || "");
    const snParts = ["FR2", displayRoom, pp.customer_name || ""].filter(Boolean);
    composedSystemName = snParts.length > 1 ? snParts.join(":") : (pp.customer_name || "");
  }

  state.ni.zRoom = customerRoom;
  state.ni.zCustomer = composedSystemName;
  state.ni.zPortLabel = "";
  $("niZCustomer").value = composedSystemName;
  $("niZRoom").value = customerRoom;
  $("niZPortLabel").style.display = "none";
  // Load port grid for Z-side PP
  if (pp.db_id) {
    try {
      const ports = await fetchPorts(pp.db_id);
      _bindPortGrid($("niZPortGrid"), $("niZPortLabel"), ports,
        { get portLabel() { return state.ni.zPortLabel; }, set portLabel(v) { state.ni.zPortLabel = v; } },
        pp.instance_id);
    } catch(e) { $("niZPortGrid").innerHTML = `<div class="small" style="color:#ef5350;">${esc(e.message)}</div>`; }
  }
  // Load BB context based on first customer room
  if (customerRoom) await niLoadBBContext(customerRoom);
}

/* Also resolve on blur if user typed full instance_id without picking from autocomplete */
async function niZPPBlur() {
  $("niZPPList")?.classList.remove("show");
  const val = ($("niZPP")?.value || "").trim();

  // ✅ FIX: When PP field is cleared, reset customer + room + port
  if (!val) {
    state.ni.zPPInstanceId = "";
    state.ni.zPPDbId = null;
    state.ni.zRoom = "";
    state.ni.zCustomer = "";
    state.ni.zPortLabel = "";
    if ($("niZCustomer")) $("niZCustomer").value = "";
    if ($("niZRoom")) $("niZRoom").value = "";
    if ($("niZPortGrid")) $("niZPortGrid").innerHTML = "";
    if ($("niZPortLabel")) { $("niZPortLabel").style.display = "none"; $("niZPortLabel").textContent = ""; }
    return;
  }
  if (val === state.ni.zPPInstanceId) return; // already resolved
  try {
    const d = await apiJson(`${API_RACKVIEW}/customer-pp-lookup?instance_id=${encodeURIComponent(val)}`);
    if (d.found) {
      await niApplyZSideLookup(d);
    } else {
      state.ni.zPPDbId = null; state.ni.zRoom = ""; state.ni.zCustomer = "";
      $("niZCustomer").value = ""; $("niZRoom").value = "";
      $("niZPortGrid").innerHTML = '<div class="small" style="color:#ef5350;">Patchpanel nicht gefunden.</div>';
    }
  } catch(e) { /* ignore */ }
}

/* ── BB IN: Load panels from backbone rooms peering to customer room ── */
async function niLoadBBContext(customerRoom) {
  const cards = $("niBbInCards"), hint = $("niBbInHint");
  const pgrid = $("niBbInPortGrid"), plbl = $("niBbInPortLabel");
  const bbout = $("niBbOutResult");
  state.ni.bbPanels = []; state.ni.selectedBbIdx = -1;
  state.ni.bbInDbId = null; state.ni.bbInInstanceId = ""; state.ni.bbInPortLabel = "";
  state.ni.bbOutInstanceId = ""; state.ni.bbOutPortLabel = "";
  if (cards) cards.innerHTML = "";
  if (pgrid) pgrid.innerHTML = "";
  if (plbl) { plbl.style.display = "none"; plbl.textContent = ""; }
  if (bbout) { bbout.style.display = "none"; bbout.innerHTML = ""; }

  if (!customerRoom) {
    if (hint) hint.textContent = "Z-Seite eingeben, um passende BB IN PPs zu sehen.";
    return;
  }
  if (hint) hint.textContent = `BB IN PPs die Richtung Raum ${customerRoom} gehen:`;

  try {
    const d = await apiJson(`${API_RACKVIEW}/bb-panels-for-customer-room?customer_room=${encodeURIComponent(customerRoom)}`);
    let items = d.items || [];
    // Filter BB IN panels to match A-side room if known
    const aRoom = normalizeRoom(state.ni.aRoom || "");
    if (aRoom && items.length) {
      const filtered = items.filter(p => normalizeRoom(p.bb_room || "") === aRoom);
      if (filtered.length) items = filtered;
    }
    state.ni.bbPanels = items;
    if (!state.ni.bbPanels.length) {
      if (hint) hint.textContent = `Keine BB IN PPs gefunden die nach ${customerRoom} gehen.`;
      return;
    }
    renderBBCards();
  } catch(e) {
    if (hint) hint.textContent = `Fehler: ${e.message}`;
  }
}

function renderBBCards() {
  const cards = $("niBbInCards"); if (!cards) return;
  cards.innerHTML = "";
  for (let i = 0; i < state.ni.bbPanels.length; i++) {
    const p = state.ni.bbPanels[i];
    const card = document.createElement("div");
    card.className = "bb-card" + (i === state.ni.selectedBbIdx ? " selected" : "");
    card.innerHTML = `<div>${esc(p.bb_instance_id)}</div><div class="bb-label">${esc(p.bb_room)} → ${esc(p.peer_room)}</div>`;
    card.addEventListener("click", () => niSelectBBPanel(i));
    cards.appendChild(card);
  }
}

async function niSelectBBPanel(idx) {
  state.ni.selectedBbIdx = idx;
  state.ni.bbInPortLabel = "";
  state.ni.bbOutInstanceId = ""; state.ni.bbOutPortLabel = "";
  const panel = state.ni.bbPanels[idx];
  state.ni.bbInDbId = panel.bb_db_id;
  state.ni.bbInInstanceId = panel.bb_instance_id;
  renderBBCards(); // update visual selection
  // Clear BB OUT
  const bbout = $("niBbOutResult"); if (bbout) { bbout.style.display = "none"; bbout.innerHTML = ""; }
  $("niBbInPortLabel").style.display = "none";
  // Load port grid for BB IN
  try {
    const ports = await fetchPorts(panel.bb_db_id);
    const gridEl = $("niBbInPortGrid"), lblEl = $("niBbInPortLabel");
    function pickBbPort(label) {
      state.ni.bbInPortLabel = label;
      lblEl.textContent = `Gewaehlt: ${panel.bb_instance_id} / Port ${label}`;
      lblEl.style.display = "block";
      renderPortGrid(gridEl, ports, pickBbPort, label);
      // Auto-resolve BB OUT via peer
      niResolveBBOut(panel.bb_instance_id, label);
    }
    renderPortGrid(gridEl, ports, pickBbPort, null);
  } catch(e) {
    $("niBbInPortGrid").innerHTML = `<div class="small" style="color:#ef5350;">${esc(e.message)}</div>`;
  }
}

/* ── BB OUT auto-resolve via peer ── */
async function niResolveBBOut(bbInInstanceId, bbInPortLabel) {
  const box = $("niBbOutResult");
  state.ni.bbOutInstanceId = ""; state.ni.bbOutPortLabel = "";
  if (!bbInInstanceId || !bbInPortLabel) { if (box) box.style.display = "none"; return; }
  try {
    const d = await apiJson(`${API_RACKVIEW}/patchpanel-peer?instance_id=${encodeURIComponent(bbInInstanceId)}&port_label=${encodeURIComponent(bbInPortLabel)}`);
    if (d.peer_instance_id && d.peer_port_label) {
      state.ni.bbOutInstanceId = d.peer_instance_id;
      state.ni.bbOutPortLabel = d.peer_port_label;
      if (box) {
        box.style.display = "block";
        box.innerHTML = `<div class="af-grid">
          <div><div class="af-label">BB OUT Panel</div><div class="af-val">${esc(d.peer_instance_id)}</div></div>
          <div><div class="af-label">BB OUT Port</div><div class="af-val">${esc(d.peer_port_label)}</div></div>
          <div><div class="af-label">Raum</div><div class="af-val">${esc(d.peer_room || "-")}</div></div>
        </div>`;
      }
    } else {
      if (box) { box.style.display = "block"; box.innerHTML = '<span style="color:#ffb74d;">Kein Peer gefunden fuer diesen Port.</span>'; }
    }
  } catch(e) {
    if (box) { box.style.display = "block"; box.innerHTML = `<span style="color:#ef5350;">${esc(e.message)}</span>`; }
  }
}

/* ── Save Install (create or update) ── */
async function saveInstall() {
  const serial = ($('niSerial')?.value || '').trim();
  const productId = ($('niProductId')?.value || '').trim();
  if (!serial && !productId) { toast('Serial oder Product ID muss angegeben werden.', 'error'); return; }

  const payload = {
    new_line: {
      serial: serial || null,
      sales_order: ($("niSalesOrder")?.value || "").trim() || null,
      product_id: ($("niProductId")?.value || "").trim() || null,
      logical_name: ($("niLogicalName")?.value || "").trim() || null,
      switch_name: ($("niSwitchName")?.value || "").trim() || null,
      switch_port: ($("niSwitchPort")?.value || "").trim() || null,
      system_name: state.ni.zCustomer || null,
      a_patchpanel_id: state.ni.aPPInstanceId || null,
      a_port_label: state.ni.aPortLabel || null,
      customer_patchpanel_id: state.ni.zPPDbId || null,
      customer_patchpanel_instance_id: state.ni.zPPInstanceId || null,
      customer_port_label: state.ni.zPortLabel || null,
      backbone_in_instance_id: state.ni.bbInInstanceId || null,
      backbone_in_port_label: state.ni.bbInPortLabel || null,
      backbone_out_instance_id: state.ni.bbOutInstanceId || null,
      backbone_out_port_label: state.ni.bbOutPortLabel || null,
    }
  };

  /* ── EDIT mode: PATCH existing change ── */
  if (state.editingInstall) {
    const ch = state.editingInstall;
    await apiJson(`${API_KW_CHANGES}/${ch.id}`, {
      method: "PATCH", headers: {"Content-Type":"application/json"},
      body: JSON.stringify({ status: String(ch.status || "planned"), payload_json: payload }),
    });
    resetInstallModalMode();
    closeAllModals();
    await loadChanges(state.selectedKw); await loadPlans(state.selectedKw);
    toast("Massnahme aktualisiert", "success");
    return;
  }

  /* ── CREATE mode ── */
  await apiJson(API_KW_CHANGES, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      kw: state.selectedKw,
      type: "NEW_INSTALL",
      payload_json: payload,
    }),
  });

  closeAllModals();
  await loadChanges(state.selectedKw);
  await loadPlans(state.selectedKw);
  toast("Installation geplant", "success");
}

/* Reset install modal back to create mode */
function resetInstallModalMode() {
  state.editingInstall = null;
  const titleEl = $("niModalTitle");
  if (titleEl) titleEl.innerHTML = '<span class="type-pill install">+ Install</span> Neue Installation';
  const saveBtn = $("btnSaveInstall");
  if (saveBtn) saveBtn.textContent = "Massnahme anlegen";
  const delBtn = $("btnDeleteInstall");
  if (delBtn) delBtn.style.display = "none";
}

/* ── Delete a kw_change ── */
async function deleteChange(changeId) {
  if (!confirm("Massnahme wirklich loeschen? Dies kann nicht rueckgaengig gemacht werden.")) return;
  await apiJson(`${API_KW_CHANGES}/${changeId}`, { method: "DELETE" });
  resetInstallModalMode();
  resetLineMoveModalMode();
  closeAllModals();
  await loadChanges(state.selectedKw); await loadPlans(state.selectedKw);
  toast("Massnahme geloescht", "success");
}

/* ══════════════════════════════════════
   FORM: DEINSTALL
   ══════════════════════════════════════ */
function openDeinstallForm() {
  if (!state.selectedKw) { toast("Bitte zuerst eine KW waehlen.", "error"); return; }
  state.diCC = null;
  $("diSerial").value = "";
  $("diReason").value = "";
  $("diPreview").innerHTML = "";
  $("btnSaveDeinstall").disabled = true;
  showModal("modalDeinstall");
}

async function diLookup() {
  const serial = ($("diSerial")?.value || "").trim();
  try {
    const cc = await lookupSerial(serial);
    state.diCC = cc;
    $("diPreview").innerHTML = ccPreviewHtml(cc);
    $("btnSaveDeinstall").disabled = false;
  } catch(e) {
    $("diPreview").innerHTML = `<div class="small" style="color:#ef5350;">${esc(e.message)}</div>`;
    $("btnSaveDeinstall").disabled = true;
    state.diCC = null;
  }
}

async function saveDeinstall() {
  if (!state.diCC) { toast("Bitte zuerst eine Leitung suchen.", "error"); return; }
  const reason = ($("diReason")?.value || "").trim();
  await apiJson(API_KW_CHANGES, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      kw: state.selectedKw,
      type: "DEINSTALL",
      target_cross_connect_id: state.diCC.id,
      payload_json: { reason: reason || null },
    }),
  });
  closeAllModals();
  await loadChanges(state.selectedKw); await loadPlans(state.selectedKw);
  toast("Deinstallation geplant", "success");
}

/* ══════════════════════════════════════
   FORM: LINE MOVE  (Install-style layout)
   ══════════════════════════════════════ */
function resetLmState() {
  state.lmCC = null;
  state.lm = {
    zPPInstanceId: "", zPPDbId: null, zRoom: "", zCustomer: "", zPortLabel: "",
    bbInDbId: null, bbInInstanceId: "", bbInPortLabel: "",
    bbOutInstanceId: "", bbOutPortLabel: "",
    bbPanels: [], selectedBbIdx: -1,
    aRoom: "",
    _prefillBbIn: "", _prefillBbInPort: "",
  };
}

async function openLineMoveForm() {
  if (!state.selectedKw) { toast("Bitte zuerst eine KW waehlen.", "error"); return; }
  resetLmState();
  $("lmSerial").value = "";
  $("lmPreview").innerHTML = "";
  ["lmASideSection","lmZSection","lmBbInSection","lmBbOutSection"].forEach(id => { const e=$(id); if(e) e.style.display="none"; });
  ["lmASwitchName","lmASwitchPort","lmARoom","lmAPP","lmAPort","lmACustomer"].forEach(id => { const e=$(id); if(e) e.value=""; });
  const zpp = $("lmZPP"); if(zpp) zpp.value = "";
  const zc = $("lmZCustomer"); if(zc) zc.value = "";
  const zr = $("lmZRoom"); if(zr) zr.value = "";
  ["lmZPortGrid","lmBbInPortGrid"].forEach(id => { const e=$(id); if(e) e.innerHTML=""; });
  ["lmZPortLabel","lmBbInPortLabel"].forEach(id => { const e=$(id); if(e) { e.style.display="none"; e.textContent=""; } });
  const bbout = $("lmBbOutResult"); if(bbout) { bbout.style.display="none"; bbout.innerHTML=""; }
  const bbCards = $("lmBbInCards"); if(bbCards) bbCards.innerHTML = "";
  const bbHint = $("lmBbInHint"); if(bbHint) bbHint.textContent = "Z-Seite eingeben, um passende BB IN PPs zu sehen.";
  $("lmZPPList")?.classList.remove("show");
  $("btnSaveLineMove").disabled = true;
  showModal("modalLineMove");
}

/* Open Line Move modal in EDIT mode, pre-filled with existing change data */
async function openEditLineMove(change) {
  state.editingLineMove = change;
  resetLmState();
  $("lmSerial").value = "";
  $("lmPreview").innerHTML = "";
  ["lmASideSection","lmZSection","lmBbInSection","lmBbOutSection"].forEach(id => { const e=$(id); if(e) e.style.display="none"; });
  ["lmASwitchName","lmASwitchPort","lmARoom","lmAPP","lmAPort","lmACustomer"].forEach(id => { const e=$(id); if(e) e.value=""; });
  const zpp = $("lmZPP"); if(zpp) zpp.value = "";
  const zc = $("lmZCustomer"); if(zc) zc.value = "";
  const zr = $("lmZRoom"); if(zr) zr.value = "";
  ["lmZPortGrid","lmBbInPortGrid"].forEach(id => { const e=$(id); if(e) e.innerHTML=""; });
  ["lmZPortLabel","lmBbInPortLabel"].forEach(id => { const e=$(id); if(e) { e.style.display="none"; e.textContent=""; } });
  const bbout = $("lmBbOutResult"); if(bbout) { bbout.style.display="none"; bbout.innerHTML=""; }
  const bbCards = $("lmBbInCards"); if(bbCards) bbCards.innerHTML = "";
  const bbHint = $("lmBbInHint"); if(bbHint) bbHint.textContent = "Z-Seite eingeben, um passende BB IN PPs zu sehen.";
  $("lmZPPList")?.classList.remove("show");

  // Switch to edit mode UI
  const titleEl = $("lmModalTitle");
  if (titleEl) titleEl.innerHTML = '<span class="type-pill linemove">&#8596; Line Move</span> Massnahme bearbeiten';
  const saveBtn = $("btnSaveLineMove");
  if (saveBtn) { saveBtn.textContent = "Speichern"; saveBtn.disabled = false; }
  const delBtn = $("btnDeleteLineMove");
  if (delBtn) delBtn.style.display = "inline-block";

  showModal("modalLineMove");

  // Lookup the target line by ID from the DB to get current state
  const payload = change.payload_json || {};
  const snap = payload.snapshot || {};
  const targetId = change.target_cross_connect_id;

  // Try to load the live line from DB
  try {
    const serial = snap.serial || "";
    if (serial) {
      $("lmSerial").value = serial;
      const cc = await lookupSerial(serial);
      state.lmCC = cc;
      $("lmPreview").innerHTML = ccPreviewHtml(cc);

      const bbInRoom = (cc.backbone_in_instance_id || "").split("/")[0] || "";
      const aRoom = cc.a_side?.room || cc.a_room || bbInRoom || "-";
      $("lmASwitchName").value = cc.switch_name || "-";
      $("lmASwitchPort").value = cc.switch_port || "-";
      $("lmARoom").value = aRoom;
      state.lm.aRoom = normalizeRoom(aRoom);
      $("lmAPP").value = cc.a_side?.pp || cc.a_patchpanel_id || "-";
      $("lmAPort").value = cc.a_side?.port || cc.a_port_label || "-";
      $("lmACustomer").value = cc.system_name || cc.customer || "-";
      ["lmASideSection","lmZSection","lmBbInSection","lmBbOutSection"].forEach(id => { const e=$(id); if(e) e.style.display="block"; });

      // Pre-fill with new_z from the change (the planned values)
      const nz = payload.new_z || {};
      const zppVal = nz.customer_patchpanel_instance_id || "";
      const zPortVal = nz.customer_port_label || "";
      const bbInVal = nz.backbone_in_instance_id || "";
      const bbInPortVal = nz.backbone_in_port_label || "";
      state.lm._prefillBbIn = bbInVal;
      state.lm._prefillBbInPort = bbInPortVal;

      if (zppVal) {
        $("lmZPP").value = zppVal;
        try {
          const d = await apiJson(`${API_RACKVIEW}/customer-pp-lookup?instance_id=${encodeURIComponent(zppVal)}`);
          if (d.found) await lmApplyZSideLookup(d, zPortVal);
        } catch(e2) { /* user can type manually */ }
      }
    }
  } catch(e) {
    // Fallback: fill from snapshot + new_z
    const nz = payload.new_z || {};
    $("lmASwitchName").value = snap.switch_name || "-";
    $("lmASwitchPort").value = snap.switch_port || "-";
    $("lmARoom").value = "-";
    $("lmAPP").value = snap.a_patchpanel_id || "-";
    $("lmAPort").value = snap.a_port_label || "-";
    $("lmACustomer").value = snap.customer || snap.system_name || "-";
    ["lmASideSection","lmZSection","lmBbInSection","lmBbOutSection"].forEach(id => { const e2=$(id); if(e2) e2.style.display="block"; });
    $("lmZPP").value = nz.customer_patchpanel_instance_id || "";
    if (nz.backbone_in_instance_id) {
      state.lm.bbInInstanceId = nz.backbone_in_instance_id;
      state.lm.bbInPortLabel = nz.backbone_in_port_label || "";
    }
    if (nz.backbone_out_instance_id) {
      state.lm.bbOutInstanceId = nz.backbone_out_instance_id;
      state.lm.bbOutPortLabel = nz.backbone_out_port_label || "";
      const bboutEl = $("lmBbOutResult");
      if (bboutEl) {
        bboutEl.style.display = "block";
        bboutEl.innerHTML = `<div class="af-grid">
          <div><div class="af-label">BB OUT Panel</div><div class="af-val">${esc(nz.backbone_out_instance_id)}</div></div>
          <div><div class="af-label">BB OUT Port</div><div class="af-val">${esc(nz.backbone_out_port_label || "-")}</div></div>
        </div>`;
      }
    }
    $("btnSaveLineMove").disabled = false;
  }
}

function resetLineMoveModalMode() {
  state.editingLineMove = null;
  const titleEl = $("lmModalTitle");
  if (titleEl) titleEl.innerHTML = '<span class="type-pill linemove">&#8596; Line Move</span> Line Move';
  const saveBtn = $("btnSaveLineMove");
  if (saveBtn) saveBtn.textContent = "Massnahme anlegen";
  const delBtn = $("btnDeleteLineMove");
  if (delBtn) delBtn.style.display = "none";
}

async function lmLookup() {
  const serial = ($("lmSerial")?.value || "").trim();
  try {
    const cc = await lookupSerial(serial);
    state.lmCC = cc;
    $("lmPreview").innerHTML = ccPreviewHtml(cc);
    $("btnSaveLineMove").disabled = false;

    // Derive A-room: from API, or from BB IN instance (backbone room = A-room)
    const bbInRoom = (cc.backbone_in_instance_id || "").split("/")[0] || "";
    const aRoom = cc.a_side?.room || cc.a_room || bbInRoom || "-";

    // Fill A-side readonly fields
    $("lmASwitchName").value = cc.switch_name || "-";
    $("lmASwitchPort").value = cc.switch_port || "-";
    $("lmARoom").value = aRoom;
    state.lm.aRoom = normalizeRoom(aRoom);
    $("lmAPP").value = cc.a_side?.pp || cc.a_patchpanel_id || "-";
    $("lmAPort").value = cc.a_side?.port || cc.a_port_label || "-";
    $("lmACustomer").value = cc.system_name || cc.customer || "-";

    // Show all sections
    ["lmASideSection","lmZSection","lmBbInSection","lmBbOutSection"].forEach(id => { const e=$(id); if(e) e.style.display="block"; });

    // Pre-fill current Z-side + BB from existing cross-connect
    const curZPP = cc.customer_patchpanel_instance_id || cc.z_side?.pp || "";
    const curZPort = cc.customer_port_label || cc.z_side?.port || "";
    const curBbIn = cc.backbone_in_instance_id || cc.bb_in?.pp || "";
    const curBbInPort = cc.backbone_in_port_label || cc.bb_in?.port || "";
    state.lm._prefillBbIn = curBbIn;
    state.lm._prefillBbInPort = curBbInPort;

    if (curZPP) {
      $("lmZPP").value = curZPP;
      try {
        const d = await apiJson(`${API_RACKVIEW}/customer-pp-lookup?instance_id=${encodeURIComponent(curZPP)}`);
        if (d.found) await lmApplyZSideLookup(d, curZPort);
      } catch(e2) { /* user can type manually */ }
    }
  } catch(e) {
    $("lmPreview").innerHTML = `<div class="small" style="color:#ef5350;">${esc(e.message)}</div>`;
    ["lmASideSection","lmZSection","lmBbInSection","lmBbOutSection"].forEach(id => { const e2=$(id); if(e2) e2.style.display="none"; });
    $("btnSaveLineMove").disabled = true;
    state.lmCC = null;
  }
}

/* ── Z-Side: Customer PP Autocomplete for Line Move ── */
let _lmZPPTimer = null;
function lmZPPInput() {
  clearTimeout(_lmZPPTimer);
  const val = ($("lmZPP")?.value || "").trim();
  if (val.length < 2) { $("lmZPPList")?.classList.remove("show"); return; }
  _lmZPPTimer = setTimeout(async () => {
    try {
      const d = await apiJson(`${API_RACKVIEW}/patchpanel-search?q=${encodeURIComponent(val)}`);
      const items = (d.items || []).map(pp => ({
        label: pp.instance_id,
        sub: pp.existing_system_name || `${pp.customer_name || "?"} – ${(pp.customer_rooms && pp.customer_rooms.length) ? pp.customer_rooms.join(", ") : pp.room || "?"}`,
        _data: pp,
      }));
      showAutocomplete($("lmZPPList"), items, item => {
        $("lmZPP").value = item._data.instance_id;
        lmApplyZSideLookup(item._data);
      });
    } catch(e) { /* ignore */ }
  }, 300);
}

async function lmZPPBlur() {
  $("lmZPPList")?.classList.remove("show");
  const val = ($("lmZPP")?.value || "").trim();
  if (!val || val === state.lm.zPPInstanceId) return;
  try {
    const d = await apiJson(`${API_RACKVIEW}/customer-pp-lookup?instance_id=${encodeURIComponent(val)}`);
    if (d.found) {
      await lmApplyZSideLookup(d);
    } else {
      state.lm.zPPDbId = null; state.lm.zRoom = ""; state.lm.zCustomer = "";
      $("lmZCustomer").value = ""; $("lmZRoom").value = "";
      $("lmZPortGrid").innerHTML = '<div class="small" style="color:#ef5350;">Patchpanel nicht gefunden.</div>';
    }
  } catch(e) { /* ignore */ }
}

async function lmApplyZSideLookup(pp, preSelectPort) {
  state.lm.zPPInstanceId = pp.instance_id;
  state.lm.zPPDbId = pp.db_id;

  const existingSN = pp.existing_system_name || "";
  let customerRoom = "";
  let composedSystemName = "";

  if (existingSN) {
    const snParts = existingSN.split(":");
    for (const part of snParts) {
      const m = part.match(/M([\dA-Za-z.]+)/i);
      if (m) { customerRoom = normalizeRoom(m[1]); break; }
    }
    composedSystemName = existingSN;
  }

  if (!customerRoom) {
    const rooms = (pp.customer_rooms && pp.customer_rooms.length) ? pp.customer_rooms : (pp.room ? [pp.room] : []);
    customerRoom = rooms.length ? normalizeRoom(rooms[0]) : "";
  }
  if (!composedSystemName) {
    const displayRoom = customerRoom ? ("M" + customerRoom.replace(/^M/i, "")) : (pp.room || "");
    const snParts = ["FR2", displayRoom, pp.customer_name || ""].filter(Boolean);
    composedSystemName = snParts.length > 1 ? snParts.join(":") : (pp.customer_name || "");
  }

  state.lm.zRoom = customerRoom;
  state.lm.zCustomer = composedSystemName;
  state.lm.zPortLabel = "";
  $("lmZCustomer").value = composedSystemName;
  $("lmZRoom").value = customerRoom;
  $("lmZPortLabel").style.display = "none";

  // Load port grid for Z-side PP
  if (pp.db_id) {
    try {
      let ports = await fetchPorts(pp.db_id);
      ports = _lmFreeCurrentPorts(ports);
      const stateProxy = { get portLabel() { return state.lm.zPortLabel; }, set portLabel(v) { state.lm.zPortLabel = v; } };
      if (preSelectPort) {
        stateProxy.portLabel = preSelectPort;
        state.lm.zPortLabel = preSelectPort;
        $("lmZPortLabel").textContent = `Gewaehlt: ${pp.instance_id} / Port ${preSelectPort}`;
        $("lmZPortLabel").style.display = "block";
      }
      _bindPortGrid($("lmZPortGrid"), $("lmZPortLabel"), ports, stateProxy, pp.instance_id);
    } catch(e) { $("lmZPortGrid").innerHTML = `<div class="small" style="color:#ef5350;">${esc(e.message)}</div>`; }
  }

  // Load BB context based on customer room
  if (customerRoom) await lmLoadBBContext(customerRoom);
}

/** Mark ports occupied by the current line as free so user can re-select them */
function _lmFreeCurrentPorts(ports) {
  if (!state.lmCC) return ports;
  const serial = state.lmCC.serial;
  if (!serial) return ports;
  return ports.map(p => {
    if (p.serial === serial && (p.occupied || p.status === "occupied")) {
      return { ...p, occupied: false, status: "free" };
    }
    return p;
  });
}

/* ── BB IN for Line Move ── */
async function lmLoadBBContext(customerRoom) {
  const cards = $("lmBbInCards"), hint = $("lmBbInHint");
  const pgrid = $("lmBbInPortGrid"), plbl = $("lmBbInPortLabel");
  const bbout = $("lmBbOutResult");
  state.lm.bbPanels = []; state.lm.selectedBbIdx = -1;
  state.lm.bbInDbId = null; state.lm.bbInInstanceId = ""; state.lm.bbInPortLabel = "";
  state.lm.bbOutInstanceId = ""; state.lm.bbOutPortLabel = "";
  if (cards) cards.innerHTML = "";
  if (pgrid) pgrid.innerHTML = "";
  if (plbl) { plbl.style.display = "none"; plbl.textContent = ""; }
  if (bbout) { bbout.style.display = "none"; bbout.innerHTML = ""; }

  if (!customerRoom) {
    if (hint) hint.textContent = "Z-Seite eingeben, um passende BB IN PPs zu sehen.";
    return;
  }
  if (hint) hint.textContent = `BB IN PPs die Richtung Raum ${customerRoom} gehen:`;

  try {
    const d = await apiJson(`${API_RACKVIEW}/bb-panels-for-customer-room?customer_room=${encodeURIComponent(customerRoom)}`);
    let items = d.items || [];
    // Filter BB IN panels to match A-side room if known
    const aRoom = normalizeRoom(state.lm.aRoom || "");
    if (aRoom && items.length) {
      const filtered = items.filter(p => normalizeRoom(p.bb_room || "") === aRoom);
      if (filtered.length) items = filtered;
    }
    state.lm.bbPanels = items;
    if (!state.lm.bbPanels.length) {
      if (hint) hint.textContent = `Keine BB IN PPs gefunden die nach ${customerRoom} gehen.`;
      return;
    }
    lmRenderBBCards();

    // Auto-select the matching BB panel card if we have a prefill value
    const prefillBbIn = state.lm._prefillBbIn || "";
    if (prefillBbIn) {
      const matchIdx = state.lm.bbPanels.findIndex(p => p.bb_instance_id === prefillBbIn);
      if (matchIdx >= 0) {
        await lmSelectBBPanel(matchIdx, state.lm._prefillBbInPort || null);
      }
      // Clear prefill so subsequent Z-side changes don't re-trigger
      state.lm._prefillBbIn = "";
      state.lm._prefillBbInPort = "";
    }
  } catch(e) {
    if (hint) hint.textContent = `Fehler: ${e.message}`;
  }
}

function lmRenderBBCards() {
  const cards = $("lmBbInCards"); if (!cards) return;
  cards.innerHTML = "";
  for (let i = 0; i < state.lm.bbPanels.length; i++) {
    const p = state.lm.bbPanels[i];
    const card = document.createElement("div");
    card.className = "bb-card" + (i === state.lm.selectedBbIdx ? " selected" : "");
    card.innerHTML = `<div>${esc(p.bb_instance_id)}</div><div class="bb-label">${esc(p.bb_room)} → ${esc(p.peer_room)}</div>`;
    card.addEventListener("click", () => lmSelectBBPanel(i));
    cards.appendChild(card);
  }
}

async function lmSelectBBPanel(idx, preSelectPort) {
  state.lm.selectedBbIdx = idx;
  state.lm.bbInPortLabel = "";
  state.lm.bbOutInstanceId = ""; state.lm.bbOutPortLabel = "";
  const panel = state.lm.bbPanels[idx];
  state.lm.bbInDbId = panel.bb_db_id;
  state.lm.bbInInstanceId = panel.bb_instance_id;
  lmRenderBBCards();
  const bbout = $("lmBbOutResult"); if (bbout) { bbout.style.display = "none"; bbout.innerHTML = ""; }
  $("lmBbInPortLabel").style.display = "none";
  try {
    let ports = await fetchPorts(panel.bb_db_id);
    ports = _lmFreeCurrentPorts(ports);
    const gridEl = $("lmBbInPortGrid"), lblEl = $("lmBbInPortLabel");
    function pickBbPort(label) {
      state.lm.bbInPortLabel = label;
      lblEl.textContent = `Gewaehlt: ${panel.bb_instance_id} / Port ${label}`;
      lblEl.style.display = "block";
      renderPortGrid(gridEl, ports, pickBbPort, label);
      lmResolveBBOut(panel.bb_instance_id, label);
    }
    if (preSelectPort) {
      state.lm.bbInPortLabel = preSelectPort;
      lblEl.textContent = `Gewaehlt: ${panel.bb_instance_id} / Port ${preSelectPort}`;
      lblEl.style.display = "block";
      renderPortGrid(gridEl, ports, pickBbPort, preSelectPort);
      lmResolveBBOut(panel.bb_instance_id, preSelectPort);
    } else {
      renderPortGrid(gridEl, ports, pickBbPort, null);
    }
  } catch(e) {
    $("lmBbInPortGrid").innerHTML = `<div class="small" style="color:#ef5350;">${esc(e.message)}</div>`;
  }
}

async function lmResolveBBOut(bbInInstanceId, bbInPortLabel) {
  const box = $("lmBbOutResult");
  state.lm.bbOutInstanceId = ""; state.lm.bbOutPortLabel = "";
  if (!bbInInstanceId || !bbInPortLabel) { if (box) box.style.display = "none"; return; }
  try {
    const d = await apiJson(`${API_RACKVIEW}/patchpanel-peer?instance_id=${encodeURIComponent(bbInInstanceId)}&port_label=${encodeURIComponent(bbInPortLabel)}`);
    if (d.peer_instance_id && d.peer_port_label) {
      state.lm.bbOutInstanceId = d.peer_instance_id;
      state.lm.bbOutPortLabel = d.peer_port_label;
      if (box) {
        box.style.display = "block";
        box.innerHTML = `<div class="af-grid">
          <div><div class="af-label">BB OUT Panel</div><div class="af-val">${esc(d.peer_instance_id)}</div></div>
          <div><div class="af-label">BB OUT Port</div><div class="af-val">${esc(d.peer_port_label)}</div></div>
          <div><div class="af-label">Raum</div><div class="af-val">${esc(d.peer_room || "-")}</div></div>
        </div>`;
      }
    } else {
      if (box) { box.style.display = "block"; box.innerHTML = '<span style="color:#ffb74d;">Kein Peer gefunden fuer diesen Port.</span>'; }
    }
  } catch(e) {
    if (box) { box.style.display = "block"; box.innerHTML = `<span style="color:#ef5350;">${esc(e.message)}</span>`; }
  }
}

/* ── Save Line Move ── */
async function saveLineMove() {
  if (!state.lmCC) { toast("Bitte zuerst eine Leitung suchen.", "error"); return; }
  if (!state.lm.zPPDbId || !state.lm.zPortLabel) { toast("Bitte neue Z-Seite (PP + Port) waehlen.", "error"); return; }

  const payload = {
    new_z: {
      customer_patchpanel_id: state.lm.zPPDbId,
      customer_patchpanel_instance_id: state.lm.zPPInstanceId || null,
      customer_port_label: state.lm.zPortLabel,
      backbone_in_instance_id: state.lm.bbInInstanceId || null,
      backbone_in_port_label: state.lm.bbInPortLabel || null,
      backbone_out_instance_id: state.lm.bbOutInstanceId || null,
      backbone_out_port_label: state.lm.bbOutPortLabel || null,
    }
  };

  /* ── EDIT mode: PATCH existing change ── */
  if (state.editingLineMove) {
    const ch = state.editingLineMove;
    // Merge with existing payload to keep snapshot, old_z, old_bb
    const merged = { ...(ch.payload_json || {}), new_z: payload.new_z };
    await apiJson(`${API_KW_CHANGES}/${ch.id}`, {
      method: "PATCH", headers: {"Content-Type":"application/json"},
      body: JSON.stringify({ status: String(ch.status || "planned"), payload_json: merged }),
    });
    resetLineMoveModalMode();
    closeAllModals();
    await loadChanges(state.selectedKw); await loadPlans(state.selectedKw);
    toast("Massnahme aktualisiert", "success");
    return;
  }

  /* ── CREATE mode ── */
  await apiJson(API_KW_CHANGES, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      kw: state.selectedKw,
      type: "LINE_MOVE",
      target_cross_connect_id: state.lmCC.id,
      payload_json: payload,
    }),
  });
  closeAllModals();
  await loadChanges(state.selectedKw); await loadPlans(state.selectedKw);
  toast("Line Move geplant", "success");
}

/* ══════════════════════════════════════
   FORM: PATH MOVE
   ══════════════════════════════════════ */
function openPathMoveForm() {
  if (!state.selectedKw) { toast("Bitte zuerst eine KW waehlen.", "error"); return; }
  state.pmA = null; state.pmB = null;
  $("pmSerialA").value = ""; $("pmSerialB").value = "";
  $("pmPreviewA").innerHTML = ""; $("pmPreviewB").innerHTML = "";
  $("btnSavePathMove").disabled = true;
  showModal("modalPathMove");
}

async function pmLookupA() {
  try {
    state.pmA = await lookupSerial($("pmSerialA")?.value);
    $("pmPreviewA").innerHTML = ccPreviewHtml(state.pmA);
    pmCheckReady();
  } catch(e) {
    $("pmPreviewA").innerHTML = `<div class="small" style="color:#ef5350;">${esc(e.message)}</div>`;
    state.pmA = null; pmCheckReady();
  }
}

async function pmLookupB() {
  try {
    state.pmB = await lookupSerial($("pmSerialB")?.value);
    // Validate room match against Leitung A
    if (state.pmA && state.pmB) {
      const roomA = String(state.pmA.customer_room || "").trim().toLowerCase();
      const roomB = String(state.pmB.customer_room || "").trim().toLowerCase();
      if (roomA && roomB && roomA !== roomB) {
        const rA = state.pmA.customer_room || "?";
        const rB = state.pmB.customer_room || "?";
        $("pmPreviewB").innerHTML = `<div class="small" style="color:#ef5350;font-weight:600;">
          ⚠ Diese Serial geht nach Raum <b>${esc(rB)}</b>, Leitung A geht aber nach Raum <b>${esc(rA)}</b>.<br>
          Path Move ist nur innerhalb desselben Raums erlaubt. Bitte Serial prüfen.
        </div>`;
        state.pmB = null; pmCheckReady();
        return;
      }
    }
    $("pmPreviewB").innerHTML = ccPreviewHtml(state.pmB);
    pmCheckReady();
  } catch(e) {
    $("pmPreviewB").innerHTML = `<div class="small" style="color:#ef5350;">${esc(e.message)}</div>`;
    state.pmB = null; pmCheckReady();
  }
}

function pmCheckReady() {
  let ok = !!(state.pmA && state.pmB);
  if (ok) {
    const roomA = String(state.pmA.customer_room || "").trim().toLowerCase();
    const roomB = String(state.pmB.customer_room || "").trim().toLowerCase();
    if (roomA && roomB && roomA !== roomB) ok = false;
  }
  $("btnSavePathMove").disabled = !ok;
}

async function savePathMove() {
  if (!state.pmA || !state.pmB) { toast("Bitte beide Leitungen suchen.", "error"); return; }
  if (state.pmA.id === state.pmB.id) { toast("Leitung A und B muessen unterschiedlich sein.", "error"); return; }
  const roomA = String(state.pmA.customer_room || "").trim().toLowerCase();
  const roomB = String(state.pmB.customer_room || "").trim().toLowerCase();
  if (roomA && roomB && roomA !== roomB) {
    toast(`Path Move nicht möglich: Leitung A → Raum ${state.pmA.customer_room}, Leitung B → Raum ${state.pmB.customer_room}. Beide müssen im selben Raum sein.`, "error");
    return;
  }

  await apiJson(API_KW_CHANGES, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      kw: state.selectedKw,
      type: "PATH_MOVE",
      payload_json: {
        line_a_id: state.pmA.id,
        line_b_id: state.pmB.id,
        line_a_serial: state.pmA.serial || state.pmA.serial_number || null,
        line_b_serial: state.pmB.serial || state.pmB.serial_number || null,
      },
    }),
  });
  closeAllModals();
  await loadChanges(state.selectedKw); await loadPlans(state.selectedKw);
  toast("Path Move geplant", "success");
}

/* ══════════════════════════════════════
   EVENT BINDING
   ══════════════════════════════════════ */
function bindEvents() {
  /* ── Header ── */
  $("btnFinishKw")?.addEventListener("click", async () => {
    try { await finishKw(); } catch(e) { toast(`Fehler: ${e.message}`, "error"); }
  });
  $("btnDownloadReport")?.addEventListener("click", async () => {
    try { await downloadReport(); } catch(e) { toast(`Fehler: ${e.message}`, "error"); }
  });
  $("kwYear")?.addEventListener("change", () => {
    state.kwNavYear = Number($("kwYear").value);
    renderKwNavigator(); renderPlanInfo();
  });
  $("kwMonth")?.addEventListener("change", () => {
    state.kwNavMonth = Number($("kwMonth").value);
    renderKwNavigator(); renderPlanInfo();
  });

  /* ── Type / Status Tabs ── */
  document.querySelectorAll("[data-filter]").forEach(btn => {
    btn.addEventListener("click", () => {
      state.typeFilter = btn.dataset.filter;
      btn.closest(".kw-tabs").querySelectorAll(".kw-tab").forEach(t => t.classList.remove("active"));
      btn.classList.add("active"); renderChanges();
    });
  });
  document.querySelectorAll("[data-sfilter]").forEach(btn => {
    btn.addEventListener("click", () => {
      state.statusFilter = btn.dataset.sfilter;
      btn.closest(".kw-tabs").querySelectorAll(".kw-tab").forEach(t => t.classList.remove("active"));
      btn.classList.add("active"); renderChanges();
    });
  });

  /* ── Table action delegation ── */
  $("changesBody")?.addEventListener("click", ev => {
    /* Status badge click → toggle planned ↔ in_progress */
    const badge = ev.target.closest("[data-status-toggle]");
    if (badge) {
      const id = Number(badge.dataset.statusToggle || 0); if (!id) return;
      const ch = state.changes.find(x => Number(x.id) === id); if (!ch) return;
      const cur = String(ch.status || "").toLowerCase();
      const next = cur === "planned" ? "in_progress" : "planned";
      apiJson(`${API_KW_CHANGES}/${ch.id}`, {
        method: "PATCH", headers: {"Content-Type":"application/json"},
        body: JSON.stringify({ status: next }),
      }).then(() => loadChanges(state.selectedKw)).then(() => loadPlans(state.selectedKw))
        .then(() => toast(`Status → ${STATUS_LABELS[next] || next}`, "success"))
        .catch(e => toast(`Fehler: ${e.message}`, "error"));
      return;
    }
    const btn = ev.target.closest("[data-action]"); if (!btn) return;
    const id = Number(btn.dataset.id || 0); if (!id) return;
    const action = btn.dataset.action;
    if (action === "expand") { const row = $(`expand-${id}`); if (row) row.classList.toggle("show"); return; }
    const ch = state.changes.find(x => Number(x.id) === id); if (!ch) return;
    if (action === "edit") openEdit(ch);
    if (action === "apply") applyChange(ch).catch(e => toast(`Fehler: ${e.message}`, "error"));
    if (action === "cancel") cancelChange(ch).catch(e => toast(`Fehler: ${e.message}`, "error"));
    if (action === "delete") deleteChange(ch.id).catch(e => toast(`Fehler: ${e.message}`, "error"));
  });

  /* ── Edit Modal ── */
  $("btnEditCancel")?.addEventListener("click", closeAllModals);
  $("btnEditSave")?.addEventListener("click", () => saveEdit().catch(e => toast(`Fehler: ${e.message}`, "error")));
  $("editBackdrop")?.addEventListener("click", ev => { if (ev.target.id === "editBackdrop") closeAllModals(); });

  /* ── Action Buttons (open create forms) ── */
  $("btnNewInstall")?.addEventListener("click", () => openInstallForm().catch(e => toast(`Fehler: ${e.message}`, "error")));
  $("btnNewDeinstall")?.addEventListener("click", () => openDeinstallForm());
  $("btnNewLineMove")?.addEventListener("click", () => openLineMoveForm().catch(e => toast(`Fehler: ${e.message}`, "error")));
  $("btnNewPathMove")?.addEventListener("click", () => openPathMoveForm());

  /* ── Install Form: text-input auto-fill ── */
  $("niSwitchName")?.addEventListener("input", niSwitchNameInput);
  $("niSwitchName")?.addEventListener("keydown", ev => {
    if (handleAutocompleteKey(ev, $("niSwitchNameList"))) return;
    if (ev.key === "Enter") { ev.preventDefault(); niTryResolveAside(); }
  });
  $("niSwitchName")?.addEventListener("blur", () => setTimeout(() => $("niSwitchNameList")?.classList.remove("show"), 200));
  $("niSwitchPort")?.addEventListener("input", niSwitchPortInput);
  $("niSwitchPort")?.addEventListener("keydown", ev => {
    if (handleAutocompleteKey(ev, $("niSwitchPortList"))) return;
    if (ev.key === "Enter") { ev.preventDefault(); niTryResolveAside(); }
  });
  $("niSwitchPort")?.addEventListener("blur", () => {
    setTimeout(() => $("niSwitchPortList")?.classList.remove("show"), 200);
    niTryResolveAside();
  });
  $("niZPP")?.addEventListener("input", niZPPInput);
  $("niZPP")?.addEventListener("blur", () => setTimeout(() => niZPPBlur(), 250));
  $("btnSaveInstall")?.addEventListener("click", () => saveInstall().catch(e => toast(`Fehler: ${e.message}`, "error")));
  $("btnDeleteInstall")?.addEventListener("click", () => {
    if (state.editingInstall) deleteChange(state.editingInstall.id).catch(e => toast(`Fehler: ${e.message}`, "error"));
  });
  $("btnDeleteGeneric")?.addEventListener("click", () => {
    if (state.editing) deleteChange(state.editing.id).catch(e => toast(`Fehler: ${e.message}`, "error"));
  });

  /* ── Deinstall Form ── */
  $("btnDiLookup")?.addEventListener("click", () => diLookup().catch(e => toast(e.message, "error")));
  $("diSerial")?.addEventListener("keydown", ev => { if (ev.key === "Enter") diLookup().catch(e => toast(e.message, "error")); });
  $("btnSaveDeinstall")?.addEventListener("click", () => saveDeinstall().catch(e => toast(`Fehler: ${e.message}`, "error")));

  /* ── Line Move Form ── */
  $("btnLmLookup")?.addEventListener("click", () => lmLookup().catch(e => toast(e.message, "error")));
  $("lmSerial")?.addEventListener("keydown", ev => { if (ev.key === "Enter") lmLookup().catch(e => toast(e.message, "error")); });
  $("lmZPP")?.addEventListener("input", lmZPPInput);
  $("lmZPP")?.addEventListener("blur", () => setTimeout(() => lmZPPBlur(), 250));
  $("btnSaveLineMove")?.addEventListener("click", () => saveLineMove().catch(e => toast(`Fehler: ${e.message}`, "error")));
  $("btnDeleteLineMove")?.addEventListener("click", () => {
    if (state.editingLineMove) deleteChange(state.editingLineMove.id).catch(e => toast(`Fehler: ${e.message}`, "error"));
  });

  /* ── Path Move Form ── */
  $("btnPmLookupA")?.addEventListener("click", () => pmLookupA().catch(e => toast(e.message, "error")));
  $("btnPmLookupB")?.addEventListener("click", () => pmLookupB().catch(e => toast(e.message, "error")));
  $("pmSerialA")?.addEventListener("keydown", ev => { if (ev.key === "Enter") pmLookupA().catch(e => toast(e.message, "error")); });
  $("pmSerialB")?.addEventListener("keydown", ev => { if (ev.key === "Enter") pmLookupB().catch(e => toast(e.message, "error")); });
  $("btnSavePathMove")?.addEventListener("click", () => savePathMove().catch(e => toast(`Fehler: ${e.message}`, "error")));

  /* ── All modal close buttons ── */
  document.querySelectorAll(".modal-close").forEach(btn => {
    btn.addEventListener("click", closeAllModals);
  });
  /* ── Click backdrop to close ── */
  document.querySelectorAll(".modal-bg").forEach(bg => {
    bg.addEventListener("click", ev => { if (ev.target === bg) closeAllModals(); });
  });
}

/* ── Init ── */
async function init() {
  const now = new Date();
  state.kwNavYear = now.getFullYear();
  state.kwNavMonth = now.getMonth();
  bindEvents();
  try { await loadPlans(currentIsoKwLabel()); }
  catch(e) { toast(`Laden fehlgeschlagen: ${e.message}`, "error"); }
}

document.addEventListener("DOMContentLoaded", init);
