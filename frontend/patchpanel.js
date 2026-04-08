// patchpanel.js (PatchPanel OVERVIEW)
// Features:
// 1) Port search + highlight + auto-scroll
// 2) Filter toggles (All/Free/Occupied/Broken) with block auto-hide
// 3) Custom tooltip on hover

const API_BASE = window.API_RACKVIEW;

const letters = ["A", "B", "C", "D"];
const positions = [1, 2, 3, 4, 5, 6];

const roomsCache = { value: null };
const instancesByRoomCache = new Map();

let currentRoom = "";
let allPanelsInRoom = [];
let filteredPanels = [];

let currentInstanceId = "";
let currentMeta = null;
let currentPorts = [];
let selectedPortLabel = null;

let currentFilter = "all"; // all|free|used|broken
let currentSearch = "";    // port search

function $(id) {
  return document.getElementById(id);
}

/* -----------------------------
   Fetch helper
----------------------------- */
async function fetchJSON(url, opts) {
  const res = await fetch(url, opts);
  const txt = await res.text();
  let data = null;

  try { data = txt ? JSON.parse(txt) : null; } catch { /* ignore */ }

  if (!res.ok) {
    const detail = data && (data.detail || data.error) ? (data.detail || data.error) : txt;
    throw new Error(`${res.status} ${res.statusText}: ${detail}`);
  }
  return data;
}

/* -----------------------------
   UI helpers
----------------------------- */
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

function setLegendToggle() {
  const legendToggle = document.querySelector(".pp-legend-toggle");
  const legendItems = $("ppLegendItems");
  if (!legendToggle || !legendItems) return;

  legendToggle.addEventListener("click", () => {
    legendItems.classList.toggle("is-collapsed");
  });
}

function setDetails(obj) {
  const el = $("detailsBox");
  if (!el) return;
  el.textContent = JSON.stringify(obj || {}, null, 2);
}

function setControlsEnabled(enabled) {
  const portSearch = $("portSearch");
  const clearBtn = $("clearPortSearchBtn");

  if (portSearch) portSearch.disabled = !enabled;
  if (clearBtn) clearBtn.disabled = !enabled;

  document.querySelectorAll(".pp-filter").forEach((b) => {
    b.disabled = !enabled;
  });
}

/* -----------------------------
   API
----------------------------- */
async function fetchRooms() {
  if (roomsCache.value) return roomsCache.value;

  const data = await fetchJSON(API_BASE + "/patchpanel-rooms");
  if (!data?.success) throw new Error(data?.detail || data?.error || "Rooms load failed");

  roomsCache.value = data.rooms || [];
  return roomsCache.value;
}

async function fetchInstancesByRoom(room) {
  if (instancesByRoomCache.has(room)) return instancesByRoomCache.get(room);

  const data = await fetchJSON(API_BASE + "/patchpanel-instances?room=" + encodeURIComponent(room));
  if (!data?.success) throw new Error(data?.detail || data?.error || "Patchpanels load failed");

  const instances = data.instances || [];
  instancesByRoomCache.set(room, instances);
  return instances;
}

async function fetchPatchpanelPorts(instanceId) {
  const url =
    API_BASE +
    "/patchpanel-ports?instance_id=" +
    encodeURIComponent(instanceId) +
    "&_=" +
    Date.now();

  const data = await fetchJSON(url);
  if (!data?.success) throw new Error(data?.detail || data?.error || "Load failed");

  return {
    meta: data.patchpanel,
    ports: Array.isArray(data.ports) ? data.ports : (data.ports?.data || []),
  };
}

/* -----------------------------
   Port state
----------------------------- */
function isBrokenStatus(status) {
  const st = String(status || "").toLowerCase().trim();
  if (!st) return false;
  return (
    st === "broken" ||
    st === "faulty" ||
    st === "damaged" ||
    st === "defect" ||
    st === "kaputt" ||
    st === "out_of_service" ||
    st === "oos"
  );
}

function getPortState(port) {
  if (!port) return "broken"; // missing in DB => treat as broken
  if (isBrokenStatus(port.status)) return "broken";
  if (port.occupied === true) return "used";
  return "free"; // peer/connected ist nur info
}

function portTooltip(port, label) {
  if (!port) return `Port ${label}\nState: missing`;

  const state = getPortState(port);
  const parts = [`Port ${label}`, `State: ${state}`];

  if (state === "used") {
    const sc = (port.switch_connection || "").trim();
    if (sc) parts.push(`Connected to: ${sc}`);
  }

  if (port.peer && port.peer.instance_id && port.peer.port_label) {
    parts.push(`Peer: ${port.peer.instance_id} : ${port.peer.port_label}`);
  }

  const rawStatus = String(port.status || "").trim();
  if (rawStatus) parts.push(`Status: ${rawStatus}`);

  return parts.join("\n");
}

/* -----------------------------
   Render Meta / Stats
----------------------------- */
function renderMeta(meta) {
  const el = $("ppMeta");
  if (!el) return;

  el.style.display = "block";
  el.innerHTML = `
    <div class="pp-meta-row">
      <div><span class="pp-meta-k">Room</span><span class="pp-meta-v">${meta.room ?? "-"}</span></div>
      <div><span class="pp-meta-k">Instance</span><span class="pp-meta-v">${meta.instance_id ?? "-"}</span></div>
      <div><span class="pp-meta-k">RU</span><span class="pp-meta-v">${meta.rack_unit ?? "-"}</span></div>
      <div><span class="pp-meta-k">Type</span><span class="pp-meta-v">${meta.panel_type ?? "-"}</span></div>
      <div><span class="pp-meta-k">Ports</span><span class="pp-meta-v">${meta.total_ports ?? "-"}</span></div>
    </div>
  `;
}

function renderStats(meta, ports) {
  const el = $("ppStats");
  if (!el) return;

  const expected = Number(meta?.total_ports || ports.length || 0);
  const missing = Math.max(0, expected - (ports?.length || 0));

  let used = 0;
  let broken = 0;

  (ports || []).forEach((p) => {
    const st = getPortState(p);
    if (st === "used") used += 1;
    else if (st === "broken") broken += 1;
  });

  broken += missing;
  const free = Math.max(0, expected - used - broken);
  const util = expected ? Math.round((used / expected) * 1000) / 10 : 0;

  el.style.display = "grid";
  el.innerHTML = `
    <div class="pp-stat">
      <div class="k">Total</div>
      <div class="v">${expected}</div>
    </div>
    <div class="pp-stat free">
      <div class="k">Free</div>
      <div class="v">${free}</div>
    </div>
    <div class="pp-stat used">
      <div class="k">Occupied</div>
      <div class="v">${used}</div>
    </div>
    <div class="pp-stat broken">
      <div class="k">Broken</div>
      <div class="v">${broken}</div>
    </div>
    <div class="pp-stat">
      <div class="k">Utilization</div>
      <div class="v">${util}%</div>
    </div>
  `;
}

/* -----------------------------
   Tooltip (custom)
----------------------------- */
function tooltipEls() {
  return { tip: $("ppTooltip") };
}

function showTooltip(text, x, y) {
  const { tip } = tooltipEls();
  if (!tip) return;

  tip.textContent = text;
  tip.style.display = "block";
  tip.setAttribute("aria-hidden", "false");
  moveTooltip(x, y);
}

function moveTooltip(x, y) {
  const { tip } = tooltipEls();
  if (!tip) return;

  // offset so it doesn't sit under cursor
  const ox = 14;
  const oy = 16;

  // keep inside viewport
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  tip.style.left = "0px";
  tip.style.top = "0px";

  const rect = tip.getBoundingClientRect();
  let left = x + ox;
  let top = y + oy;

  if (left + rect.width > vw - 10) left = vw - rect.width - 10;
  if (top + rect.height > vh - 10) top = vh - rect.height - 10;

  tip.style.left = left + "px";
  tip.style.top = top + "px";
}

function hideTooltip() {
  const { tip } = tooltipEls();
  if (!tip) return;

  tip.style.display = "none";
  tip.setAttribute("aria-hidden", "true");
}

/* -----------------------------
   Render Grid
----------------------------- */
function clearSelectedInGrid(root) {
  if (!root) return;
  root.querySelectorAll(".pp-port.selected").forEach((b) => b.classList.remove("selected"));
}

function clearSearchHits(root) {
  if (!root) return;
  root.querySelectorAll(".pp-port.search-hit, .pp-port.search-hit-strong").forEach((b) => {
    b.classList.remove("search-hit");
    b.classList.remove("search-hit-strong");
  });
}

function computeBlocks(meta, ports) {
  // Prefer DB row if available (row = block number)
  let maxRow = 0;
  (ports || []).forEach((p) => {
    const n = Number(p.row);
    if (!Number.isNaN(n)) maxRow = Math.max(maxRow, n);
  });

  const expected = Number(meta?.total_ports || ports.length || 0);
  const byTotal = Math.max(1, Math.ceil(expected / 24));

  return Math.max(1, maxRow || byTotal);
}

function renderGrid(meta, ports) {
  const root = $("ppGrid");
  if (!root) return;

  root.innerHTML = "";
  selectedPortLabel = null;
  setDetails({});

  const map = new Map();
  (ports || []).forEach((p) => map.set(p.label, p));

  const blocks = computeBlocks(meta, ports);

  for (let blockNo = 1; blockNo <= blocks; blockNo++) {
    const block = document.createElement("div");
    block.className = "pp-block";
    block.dataset.block = String(blockNo);

    const head = document.createElement("div");
    head.className = "pp-block-head";
    head.innerHTML = `<div class="pp-block-title">Block ${blockNo}</div>
                      <div class="pp-block-sub">Ports ${((blockNo - 1) * 24) + 1}–${blockNo * 24}</div>`;
    block.appendChild(head);

    const grid = document.createElement("div");
    grid.className = "pp-port-grid";

    letters.forEach((letter) => {
      positions.forEach((pos) => {
        const label = `${blockNo}${letter}${pos}`;
        const port = map.get(label) || null;

        const btn = document.createElement("button");
        btn.className = "pp-port";
        btn.type = "button";
        btn.dataset.label = label;

        const state = getPortState(port);
        btn.dataset.state = state;
        btn.textContent = label;
        btn.classList.add(state);

        // broken => disabled
        if (state === "broken") btn.disabled = true;

        // Tooltip events
        const tipText = portTooltip(port, label);
        btn.addEventListener("mouseenter", (e) => showTooltip(tipText, e.clientX, e.clientY));
        btn.addEventListener("mousemove", (e) => moveTooltip(e.clientX, e.clientY));
        btn.addEventListener("mouseleave", () => hideTooltip());

        // Click details
        btn.addEventListener("click", () => {
          selectedPortLabel = label;
          clearSelectedInGrid(root);
          btn.classList.add("selected");

          setDetails({
            instance_id: meta?.instance_id,
            room: meta?.room,
            port_label: label,
            state,
            port: port || null,
          });
        });

        grid.appendChild(btn);
      });
    });

    block.appendChild(grid);
    root.appendChild(block);
  }

  // apply filter + search after render
  applyFilterAndSearch();
}

/* -----------------------------
   Filter + Search logic
----------------------------- */
function setActiveFilterButton(filter) {
  document.querySelectorAll(".pp-filter").forEach((b) => {
    b.classList.toggle("is-active", b.dataset.filter === filter);
  });
}

function applyFilterAndSearch() {
  const root = $("ppGrid");
  if (!root) return;

  // Filter
  const filter = currentFilter;

  root.querySelectorAll(".pp-port").forEach((btn) => {
    const st = btn.dataset.state || "free";
    const show =
      filter === "all" ? true :
      filter === "free" ? st === "free" :
      filter === "used" ? st === "used" :
      filter === "broken" ? st === "broken" :
      true;

    btn.style.display = show ? "" : "none";
  });

  // Hide empty blocks
  root.querySelectorAll(".pp-block").forEach((block) => {
    const anyVisible = Array.from(block.querySelectorAll(".pp-port")).some(
      (b) => b.style.display !== "none"
    );
    block.style.display = anyVisible ? "" : "none";
  });

  // Search (highlights among visible ports only)
  clearSearchHits(root);

  const term = (currentSearch || "").trim().toUpperCase();
  if (!term) return;

  const ports = Array.from(root.querySelectorAll(".pp-port"))
    .filter((b) => b.style.display !== "none");

  let firstMatch = null;
  let exactMatch = null;

  ports.forEach((b) => {
    const lbl = String(b.dataset.label || "").toUpperCase();
    if (!lbl) return;

    if (lbl === term) {
      b.classList.add("search-hit-strong");
      exactMatch = exactMatch || b;
      firstMatch = firstMatch || b;
    } else if (lbl.includes(term)) {
      b.classList.add("search-hit");
      firstMatch = firstMatch || b;
    }
  });

  const target = exactMatch || firstMatch;
  if (target) {
    target.scrollIntoView({ behavior: "smooth", block: "center", inline: "center" });
  }
}

/* -----------------------------
   Patchpanel search (dropdown filter)
----------------------------- */
function applyPanelFilter(term) {
  const t = (term || "").toLowerCase().trim();

  if (!t) filteredPanels = [...allPanelsInRoom];
  else {
    filteredPanels = allPanelsInRoom.filter((p) => {
      const iid = String(p.instance_id || "").toLowerCase();
      const ru = String(p.rack_unit ?? "").toLowerCase();
      const typ = String(p.panel_type ?? "").toLowerCase();
      return iid.includes(t) || ru.includes(t) || typ.includes(t);
    });
  }

  const panelSelect = $("panelSelect");
  fillSelect(
    panelSelect,
    filteredPanels,
    "Patchpanel…",
    (p) => p.instance_id,
    (p) => `${p.instance_id}  ·  RU ${p.rack_unit ?? "?"}  ·  ${p.panel_type ?? "?"}`
  );

  panelSelect.disabled = filteredPanels.length === 0;
  $("loadBtn").disabled = true;
}

/* -----------------------------
   Init
----------------------------- */
document.addEventListener("DOMContentLoaded", async () => {
  setLegendToggle();

  const roomSelect = $("roomSelect");
  const ppSearch = $("ppSearch");
  const panelSelect = $("panelSelect");
  const loadBtn = $("loadBtn");

  const portSearch = $("portSearch");
  const clearPortSearchBtn = $("clearPortSearchBtn");

  const metaEl = $("ppMeta");
  const statsEl = $("ppStats");
  const gridEl = $("ppGrid");

  if (!roomSelect || !ppSearch || !panelSelect || !loadBtn) return;

  // initial hide
  if (metaEl) metaEl.style.display = "none";
  if (statsEl) statsEl.style.display = "none";
  if (gridEl) gridEl.innerHTML = "";
  setDetails({});

  setControlsEnabled(false);
  currentFilter = "all";
  currentSearch = "";
  setActiveFilterButton("all");

  // load rooms
  try {
    const rooms = await fetchRooms();
    fillSelect(roomSelect, rooms, "Room…", (r) => r, (r) => r);
  } catch (e) {
    alert("Rooms konnten nicht geladen werden: " + e.message);
    return;
  }

  // Room change
  roomSelect.addEventListener("change", async () => {
    currentRoom = roomSelect.value || "";

    // reset UI
    currentInstanceId = "";
    currentMeta = null;
    currentPorts = [];
    selectedPortLabel = null;

    currentFilter = "all";
    currentSearch = "";
    setActiveFilterButton("all");

    if (metaEl) metaEl.style.display = "none";
    if (statsEl) statsEl.style.display = "none";
    if (gridEl) gridEl.innerHTML = "";
    setDetails({});
    hideTooltip();

    ppSearch.value = "";
    ppSearch.disabled = true;

    panelSelect.disabled = true;
    fillSelect(panelSelect, [], "Patchpanel…", (x) => x, (x) => x);

    loadBtn.disabled = true;
    setControlsEnabled(false);

    if (portSearch) portSearch.value = "";
    if (clearPortSearchBtn) clearPortSearchBtn.disabled = true;

    if (!currentRoom) return;

    try {
      allPanelsInRoom = await fetchInstancesByRoom(currentRoom);
      filteredPanels = [...allPanelsInRoom];

      fillSelect(
        panelSelect,
        filteredPanels,
        "Patchpanel…",
        (p) => p.instance_id,
        (p) => `${p.instance_id}  ·  RU ${p.rack_unit ?? "?"}  ·  ${p.panel_type ?? "?"}`
      );

      panelSelect.disabled = filteredPanels.length === 0;
      ppSearch.disabled = false;
      ppSearch.focus();
    } catch (e) {
      alert("Patchpanels konnten nicht geladen werden: " + e.message);
    }
  });

  // Patchpanel dropdown filter
  ppSearch.addEventListener("input", () => applyPanelFilter(ppSearch.value));

  // enable Load
  panelSelect.addEventListener("change", () => {
    loadBtn.disabled = !panelSelect.value;
  });

  // Load patchpanel
  loadBtn.addEventListener("click", async () => {
    const iid = panelSelect.value;
    if (!iid) return;

    try {
      loadBtn.disabled = true;
      loadBtn.textContent = "Loading…";

      const payload = await fetchPatchpanelPorts(iid);

      currentInstanceId = iid;
      currentMeta = payload.meta;
      currentPorts = payload.ports;

      renderMeta(currentMeta);
      renderStats(currentMeta, currentPorts);
      renderGrid(currentMeta, currentPorts);

      // enable features
      setControlsEnabled(true);

      // reset search/filter to defaults
      currentFilter = "all";
      currentSearch = "";
      setActiveFilterButton("all");
      if (portSearch) portSearch.value = "";

      loadBtn.textContent = "Load";
      loadBtn.disabled = false;
    } catch (e) {
      loadBtn.textContent = "Load";
      loadBtn.disabled = false;
      alert(e.message);
    }
  });

  // Filters
  document.querySelectorAll(".pp-filter").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (btn.disabled) return;
      currentFilter = btn.dataset.filter || "all";
      setActiveFilterButton(currentFilter);
      applyFilterAndSearch();
    });
  });

  // Port Search
  if (portSearch) {
    portSearch.addEventListener("input", () => {
      currentSearch = portSearch.value || "";
      applyFilterAndSearch();
    });

    // Enter => force scroll to first/exact match
    portSearch.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        currentSearch = portSearch.value || "";
        applyFilterAndSearch();
      }
    });
  }

  // Clear port search
  if (clearPortSearchBtn) {
    clearPortSearchBtn.addEventListener("click", () => {
      if (clearPortSearchBtn.disabled) return;
      currentSearch = "";
      if (portSearch) portSearch.value = "";
      applyFilterAndSearch();
    });
  }

  // enable/disable clear button based on input
  if (portSearch && clearPortSearchBtn) {
    portSearch.addEventListener("input", () => {
      clearPortSearchBtn.disabled = portSearch.disabled || !(portSearch.value || "").trim();
    });
  }

  // hide tooltip when scrolling
  window.addEventListener("scroll", () => hideTooltip(), { passive: true });
});
