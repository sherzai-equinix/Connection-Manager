/* ================================================================
   Cross Connects – Read-Only Bestandsuebersicht
   Vereinfachte Ansicht: Suche, Filter, aufklappbare Details.
   Aenderungen laufen ueber KW Planung.
   ================================================================ */

const API_CC = String(
  window.API_CROSSCONNECTS_MIN || `${window.API_ROOT || ""}/cross_connects`
).replace(/\/+$/, "");

const $ = (id) => document.getElementById(id);

/* -------------------- helpers -------------------- */

function esc(v) {
  return String(v ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function toast(msg, type = "info") {
  const w = $("toastWrap");
  if (!w) return;
  const el = document.createElement("div");
  el.className = `toast ${type}`;
  el.textContent = msg;
  w.appendChild(el);
  setTimeout(() => el.remove(), 3400);
}

function setStatus(msg, loading = false) {
  const b = $("listStatus");
  if (!b) return;
  b.innerHTML = loading
    ? `<span class="spinner"></span><span>${esc(msg)}</span>`
    : esc(msg || "");
}

function badge(status) {
  const s = String(status || "").toLowerCase();
  let cls = "badge-neutral";
  if (s === "active" || s === "done") cls = "badge-success";
  else if (s.includes("pending") || s === "planned" || s === "in_progress")
    cls = "badge-warning";
  else if (s === "deinstalled" || s === "cancelled" || s === "canceled")
    cls = "badge-danger";
  return `<span class="badge ${cls}">${esc(status || "-")}</span>`;
}

/* -------------------- state -------------------- */

const state = { items: [], total: 0, expanded: new Set(), pinnedIds: [] };
let _allItems = []; // master copy of full list (unfiltered)

/* -------------------- cell renderers -------------------- */

/** RFRA switch name + port */
function rfraCell(item) {
  const name = item.switch_name || "-";
  const port = item.switch_port || "";
  if (port) {
    return `<span class="mono">${esc(name)}</span><div class="cell-sub">${esc(port)}</div>`;
  }
  return `<span class="mono">${esc(name)}</span>`;
}

/** Generic side cell: room / rack / pp / port on one line */
function sideCell(room, rack, pp, port) {
  const parts = [room, rack, pp].filter((x) => x && x !== "-");
  if (port && port !== "-") parts.push(port);
  const main = parts.length ? parts.join(" / ") : "-";
  return `<span class="mono">${esc(main)}</span>`;
}

function aSideCell(item) {
  const pp = item.a_side?.pp || item.a_patchpanel_id || "";
  const port = item.a_side?.port || item.a_port_label || "";
  return sideCell("", "", pp, port);
}

function zSideCell(item) {
  const room = item.z_customer_room || item.z_side?.room || item.z_room || "";
  const rack =
    item.z_side?.rack || item.z_rack || item.rack_code || "";
  const pp =
    item.customer_patchpanel_instance_id ||
    item.z_side?.pp ||
    item.z_pp_number ||
    "";
  const port = item.z_side?.port || item.customer_port_label || "";
  return sideCell(room, rack, pp, port);
}

function bbCell(pp, port) {
  return `<span class="mono">${esc(pp || "-")} / ${esc(port || "-")}</span>`;
}

function customerText(item) {
  // Prefer system_name with full format (contains ':')
  const sn = item.system_name || "";
  if (sn && sn.includes(":")) return sn;
  // Fallback: customer field (may already be resolved by backend)
  return (
    item.customer ||
    item.system_name ||
    item.customer_base_name ||
    item.customer_name ||
    item.rack_code ||
    "-"
  );
}

/* -------------------- expandable detail row -------------------- */

function detailHtml(item) {
  function f(label, val) {
    return `<div class="detail-item"><div class="detail-label">${esc(
      label
    )}</div><div class="detail-value">${esc(val || "-")}</div></div>`;
  }

  const aPP = item.a_side?.pp || item.a_patchpanel_id || "-";
  const aPort = item.a_side?.port || item.a_port_label || "-";

  const zRoom = item.z_customer_room || item.z_side?.room || item.z_room || "-";
  const zRack =
    item.z_side?.rack || item.z_rack || item.rack_code || "-";
  const zPP =
    item.customer_patchpanel_instance_id ||
    item.z_side?.pp ||
    item.z_pp_number ||
    "-";
  const zPort = item.z_side?.port || item.customer_port_label || "-";

  const bbInPP =
    item.bb_in?.pp || item.backbone_in_instance_id || "-";
  const bbInPort =
    item.bb_in?.port || item.backbone_in_port_label || "-";
  const bbOutPP =
    item.bb_out?.pp || item.backbone_out_instance_id || "-";
  const bbOutPort =
    item.bb_out?.port || item.backbone_out_port_label || "-";

  return `<div class="detail-grid">
    ${f("Serial", item.serial)}
    ${f("Kunde", customerText(item))}
    ${f("Status", item.status)}
    ${f("RFRA Switch", item.switch_name)}
    ${f("RFRA Port", item.switch_port)}
    ${f("A-Patchpanel", aPP)}
    ${f("A-Port", aPort)}
    ${f("Z-Room", zRoom)}
    ${f("Z-Rack", zRack)}
    ${f("Z-Patchpanel", zPP)}
    ${f("Z-Port", zPort)}
    ${f("BB IN", bbInPP + " / " + bbInPort)}
    ${f("BB OUT", bbOutPP + " / " + bbOutPort)}
    ${item.deinstalled_at ? f("Deinstalliert am", item.deinstalled_at) : ""}
    ${item.deinstalled_by ? f("Deinstalliert von", item.deinstalled_by) : ""}
    ${item.reason ? f("Grund", item.reason) : ""}
    ${item.original_created_at ? f("Urspr. angelegt", item.original_created_at) : ""}
  </div>`;
}

/* -------------------- render table -------------------- */

function renderRows() {
  const body = $("ccTableBody");
  const empty = $("emptyState");
  if (!body) return;
  body.innerHTML = "";

  if (!state.items.length) {
    if (empty) {
      empty.hidden = false;
      empty.textContent = "Keine Cross Connects fuer diesen Filter.";
    }
    return;
  }
  if (empty) empty.hidden = true;

  /* Sort: pinned items first (newest pin on top), rest in original order */
  const sorted = [...state.items];
  if (state.pinnedIds.length) {
    sorted.sort((a, b) => {
      const aPin = state.pinnedIds.indexOf(a.id);
      const bPin = state.pinnedIds.indexOf(b.id);
      if (aPin !== -1 && bPin !== -1) return aPin - bPin;
      if (aPin !== -1) return -1;
      if (bPin !== -1) return 1;
      return 0;
    });
  }

  for (const item of sorted) {
    const id = item.id;
    const isOpen = state.expanded.has(id);
    const isPinned = state.pinnedIds.includes(id);

    /* main row */
    const tr = document.createElement("tr");
    tr.className = "data-row" + (isPinned ? " pinned-row" : "");
    tr.style.cursor = "pointer";
    tr.dataset.id = id;
    tr.innerHTML = `
      <td><span class="expand-btn${
        isOpen ? " open" : ""
      }" data-toggle="${id}">&#9654;</span></td>
      <td class="col-serial mono">${isPinned ? '<span class="pin-icon" title="Angepinnt">&#128204;</span> ' : ""}${esc(item.serial || "-")}</td>
      <td class="col-kunde">${esc(customerText(item))}</td>
      <td class="col-rfra">${rfraCell(item)}</td>
      <td class="col-aside">${aSideCell(item)}</td>
      <td class="col-zside">${zSideCell(item)}</td>
      <td class="col-bb">${bbCell(
        item.bb_in?.pp || item.backbone_in_instance_id,
        item.bb_in?.port || item.backbone_in_port_label
      )}</td>
      <td class="col-bb">${bbCell(
        item.bb_out?.pp || item.backbone_out_instance_id,
        item.bb_out?.port || item.backbone_out_port_label
      )}</td>
      <td>${badge(item.status)}</td>
    `;
    body.appendChild(tr);

    /* detail row (only when expanded) */
    if (isOpen) {
      const dr = document.createElement("tr");
      dr.className = "detail-row";
      dr.dataset.detailFor = id;
      dr.innerHTML = `<td colspan="9">${detailHtml(item)}</td>`;
      body.appendChild(dr);
    }
  }
}

function updateStats() {
  const s = $("statShown");
  const t = $("statTotal");
  const f = $("statFilter");
  if (s) s.textContent = String(state.items.length);
  if (t) t.textContent = String(state.total);
  if (f) f.textContent = $("statusFilter")?.value || "active";

  /* Pinned info */
  const pinnedInfo = $("pinnedInfo");
  const pinnedCount = $("pinnedCount");
  if (pinnedInfo && pinnedCount) {
    const validPins = state.pinnedIds.filter((pid) =>
      state.items.some((i) => i.id === pid)
    );
    if (validPins.length > 0) {
      pinnedInfo.style.display = "";
      pinnedCount.textContent = String(validPins.length);
    } else {
      pinnedInfo.style.display = "none";
    }
  }
}

/* -------------------- load data -------------------- */

/** Build API URL – optional search param */
function buildQuery(search = "") {
  const status = $("statusFilter")?.value || "active";
  if (status === "deinstalled") {
    let qs = `?limit=500`;
    if (search) qs += `&q=${encodeURIComponent(search)}`;
    return `${API_CC}/archive${qs}`;
  }
  let qs = `?status=${encodeURIComponent(status)}&limit=500`;
  if (search) qs += `&q=${encodeURIComponent(search)}`;
  return `${API_CC}${qs}`;
}

/** Load full list (no search filter). Stores master copy in _allItems. */
async function loadList() {
  setStatus("Lade Cross Connects...", true);
  try {
    const res = await fetch(buildQuery());
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.detail || `HTTP ${res.status}`);
    _allItems = Array.isArray(data.items) ? data.items : [];
    state.items = _allItems;
    state.total = Number(data.total || 0);
    renderRows();
    updateStats();
    setStatus(`Geladen: ${state.items.length} von ${state.total}`);
  } catch (err) {
    _allItems = [];
    state.items = [];
    state.total = 0;
    renderRows();
    updateStats();
    setStatus(`Fehler: ${err.message}`);
    toast(`Laden fehlgeschlagen: ${err.message}`, "error");
  }
}

/**
 * Pin-Search: find matching items via API, pin their IDs at top,
 * then show the full list with pinned items floated to the top.
 * Triggered only by Enter key.
 */
async function pinSearch() {
  const search = ($("searchInput")?.value || "").trim();
  if (!search) return;
  setStatus("Suche...", true);
  try {
    const res = await fetch(buildQuery(search));
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.detail || `HTTP ${res.status}`);
    const fetched = Array.isArray(data.items) ? data.items : [];
    const foundIds = fetched.map((i) => i.id);
    if (!foundIds.length) {
      toast("Keine Ergebnisse gefunden", "warn");
      setStatus(`Geladen: ${state.items.length} von ${state.total}`);
      return;
    }
    /* Remove from current pins, prepend at top */
    state.pinnedIds = state.pinnedIds.filter((pid) => !foundIds.includes(pid));
    state.pinnedIds = [...foundIds, ...state.pinnedIds];
    if (state.pinnedIds.length > 50) state.pinnedIds.length = 50;

    /* Clear search input and show full list with pins */
    $("searchInput").value = "";
    state.items = _allItems;
    renderRows();
    updateStats();
    setStatus(`Geladen: ${state.items.length} von ${state.total}`);
    toast(`${foundIds.length} Leitung(en) angepinnt`, "info");
  } catch (err) {
    setStatus(`Fehler: ${err.message}`);
    toast(`Suche fehlgeschlagen: ${err.message}`, "error");
  }
}

/* -------------------- expand / collapse -------------------- */

function toggleExpand(id) {
  if (state.expanded.has(id)) state.expanded.delete(id);
  else state.expanded.add(id);
  renderRows();
}

/* -------------------- CSV export -------------------- */

function doExport() {
  const status = $("statusFilter")?.value || "active";
  let qs = `?status=${encodeURIComponent(status)}`;
  window.open(`${API_CC}/export${qs}`, "_blank");
}

/* (no debounce – search pins only on Enter) */

/* -------------------- init -------------------- */

function applyUrlParams() {
  const p = new URLSearchParams(location.search);
  if (p.has("status")) {
    const sel = $("statusFilter");
    if (sel) sel.value = p.get("status");
  }
  if (p.has("q")) {
    const inp = $("searchInput");
    if (inp) inp.value = p.get("q");
  }
}

document.addEventListener("DOMContentLoaded", () => {
  applyUrlParams();

  $("btnRefresh")?.addEventListener("click", loadList);
  $("btnExport")?.addEventListener("click", doExport);
  $("statusFilter")?.addEventListener("change", () => {
    state.pinnedIds = [];
    loadList();
  });

  /* Enter key triggers pin-search */
  $("searchInput")?.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") {
      ev.preventDefault();
      pinSearch();
    }
  });

  /* row click / expand toggle */
  $("ccTableBody")?.addEventListener("click", (ev) => {
    const toggle = ev.target.closest("[data-toggle]");
    if (toggle) {
      toggleExpand(Number(toggle.dataset.toggle));
      return;
    }
    const row = ev.target.closest("tr.data-row");
    if (row && row.dataset.id) {
      toggleExpand(Number(row.dataset.id));
    }
  });

  /* clear pins button */
  $("btnClearPins")?.addEventListener("click", () => {
    state.pinnedIds = [];
    renderRows();
    updateStats();
  });

  loadList();
});
