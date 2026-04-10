// kw-job-detail.js
const API = window.API_IMPORT || "http://127.0.0.1:8000";
const el = (id) => document.getElementById(id);

const params = new URLSearchParams(window.location.search);
const jobId = parseInt(params.get("job_id") || "0", 10);

let currentStatus = "all";
let currentLines = [];
let editId = null;
let reservedByInstance = new Map(); // instance_id -> Set(port_labels)
let jobStats = null;

let bbInCtx = null;
let bbInPorts = [];

const letters = ["A", "B", "C", "D"];
const positions = [1, 2, 3, 4, 5, 6];

const STATUS_TABS = [
  { key: "all", label: "All" },
  { key: "planned", label: "Planned" },
  { key: "review", label: "Review" },
  { key: "in_progress", label: "In Progress" },
  { key: "done", label: "Done" },
  { key: "troubleshoot", label: "Troubleshoot" },
  { key: "pending_serial", label: "Pending Serial" },
  { key: "active", label: "Active" },
  { key: "deinstalled", label: "Deinstalled" },
];

const STATUS_FLOW = [
  "planned",
  "review",
  "in_progress",
  "done",
  "troubleshoot",
  "pending_serial",
  "active",
  "deinstalled",
];


function formatDateTime(v){
  if (!v) return "-";
  const d = new Date(v);
  if (isNaN(d.getTime())) return String(v);
  return d.toLocaleString();
}

function escapeHtml(v) {
  return String(v ?? "").replace(/[&<>\"]/g, (m) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;"
  }[m]));
}

function userName() {
  return localStorage.getItem("username") || localStorage.getItem("user") || "";
}

function isLockedByOther(r) {
  const me = (userName() || "").trim().toLowerCase();
  const ass = String(r?.assigned_to || "").trim().toLowerCase();
  return !!(ass && me && ass !== me);
}

function lockHint(r) {
  if (!r?.assigned_to) return "";
  return `In Bearbeitung von ${r.assigned_to}`;
}

async function quickSetStatus(ccId, nextStatus) {
  const actor = userName();
  if (!actor) {
    alert("Kein Benutzer gefunden (bitte neu einloggen).");
    return;
  }
  try {
    const res = await fetch(`${API}/api/v1/cross-connects/item/${ccId}` , {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: nextStatus, current_user: actor })
    });
    if (!res.ok) {
      const txt = await res.text();
      throw new Error(txt);
    }
    await loadLines();
  } catch (e) {
    console.error(e);
    alert("Status konnte nicht gesetzt werden:\n" + (e?.message || e));
  }
}

async function assignSerial(ccId, serialValue) {
  const actor = userName();
  if (!actor) {
    alert("Kein Benutzer gefunden (bitte neu einloggen).");
    return;
  }
  const serial = String(serialValue || "").trim();
  if (!serial) {
    alert("Bitte Seriennummer eingeben.");
    return;
  }
  try {
    const res = await fetch(`${API}/api/v1/cross-connects/${ccId}/assign-serial`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ serial, current_user: actor })
    });
    if (!res.ok) {
      const txt = await res.text();
      throw new Error(txt);
    }
    // After successful activation, reload table & stats
    await loadLines();
  } catch (e) {
    alert(`Serial speichern fehlgeschlagen: ${e.message || e}`);
  }
}


function renderTabs() {
  const countFor = (key) => {
    if (!jobStats) return "";
    if (key === "all") return ` (${jobStats.total ?? 0})`;
    const v = jobStats[key];
    if (typeof v === "number") return ` (${v})`;
    return "";
  };

  el("tabs").innerHTML = STATUS_TABS.map(t => {
    const cls = t.key === currentStatus ? "tab active" : "tab";
    return `<button class="${cls}" data-key="${t.key}">${t.label}${countFor(t.key)}</button>`;
  }).join("");

  el("tabs").querySelectorAll("button").forEach(b => {
    b.addEventListener("click", () => {
      currentStatus = b.getAttribute("data-key") || "all";
      renderTabs();
      loadLines();
    });
  });
}

async function loadStats() {
  try {
    const res = await fetch(`${API}/api/v1/jobs/${jobId}/stats`);
    jobStats = await res.json();
  } catch (e) {
    jobStats = null;
  }
  renderTabs();
}

function renderTable(items) {
  if (!items || items.length === 0) {
    el("tbody").innerHTML = '<tr><td colspan="16" class="muted">Keine Leitungen für diesen Filter.</td></tr>';
    return;
  }

  const isAdmin = window.isAdminRole ? window.isAdminRole() : false;
  el("tbody").innerHTML = items.map(r => {
    const statusKey = String(r.status || "").toLowerCase();
    const st = escapeHtml(r.status || "");
    const badge = `<span class="badge">${st}</span>`;
    const bbIn = escapeHtml(r.backbone_in_instance_id || "-");
    const bbInP = escapeHtml(r.backbone_in_port_label || "-");
    const bbOut = escapeHtml(r.backbone_out_instance_id || "-");
    const bbOutP = escapeHtml(r.backbone_out_port_label || "-");
    const assigned = escapeHtml(r.assigned_to || "-");
    const updated = escapeHtml(formatDateTime(r.updated_at || r.assigned_at || r.created_at));
    const custPP = escapeHtml(r.customer_pp_name ?? r.customer_patchpanel_id ?? "");

    const locked = isLockedByOther(r);
    const lockedStatus = ["done","active","deinstalled"].includes(statusKey);
    const editDisabled = (locked || lockedStatus) ? "disabled" : "";
    const title = locked ? `title="${escapeHtml(lockHint(r))}"` : "";

    const canEditSerial = isAdmin && (statusKey === "pending_serial") && !locked;
    const serialVal = (r.serial_number || "").toString();
    const serialCell = canEditSerial
      ? `<div class="serial-edit">
           <input class="serial-input" data-serial-input="${r.id}" value="${escapeHtml(serialVal)}" placeholder="Serial No." />
           <button class="btn-mini serial-save" data-serial-save="${r.id}" title="Serial speichern & aktivieren">💾</button>
         </div>`
      : `<span class="muted">${escapeHtml(serialVal || "")}</span>`;

    const canStart = ["planned","review","troubleshoot"].includes(statusKey) && !locked;
    const canDone = ["in_progress","troubleshoot"].includes(statusKey) && !locked;
    const canTrouble = ["planned","review","in_progress","done"].includes(statusKey) && !locked;

    const btnStart = `<button class="btn-mini" data-q="start" data-id="${r.id}" ${canStart ? "" : "disabled"} ${title}>▶ Start</button>`;
    const btnDone  = `<button class="btn-mini" data-q="done" data-id="${r.id}" ${canDone ? "" : "disabled"} ${title}>✅ Done</button>`;
    const btnTrou  = `<button class="btn-mini" data-q="trouble" data-id="${r.id}" ${canTrouble ? "" : "disabled"} ${title}>⚠ Trouble</button>`;
    const btnEdit  = isAdmin ? `<button class="btn-mini" data-edit="${r.id}" data-admin-only ${editDisabled} ${title}>Bearbeiten</button>` : `<span class="muted">read-only</span>`;
    return `
      <tr>
        <td>${r.id}</td>
        <td>${escapeHtml(r.product_id || "")}</td>
        <td>${serialCell}</td>
        <td>${badge}</td>
        <td>${escapeHtml(r.switch_name || "")} ${escapeHtml(r.switch_port || "")}</td>
        <td>${escapeHtml(r.a_patchpanel_id || "")}</td>
        <td>${escapeHtml(r.a_port_label || "")}</td>
        <td>${bbIn}</td>
        <td>${bbInP}</td>
        <td>${bbOut}</td>
        <td>${bbOutP}</td>
        <td>${custPP}</td>
        <td>${escapeHtml(r.customer_port_label || "")}</td>
        <td>${assigned}</td>
        <td>${updated}</td>
        <td style="display:flex; gap:6px; align-items:center;">
          ${btnStart}
          ${btnDone}
          ${btnTrou}
          ${btnEdit}
        </td>
      </tr>
    `;
  }).join("");

  el("tbody").querySelectorAll("button[data-edit]").forEach(b => {
    b.addEventListener("click", () => openEdit(parseInt(b.getAttribute("data-edit"), 10)));
  });

  el("tbody").querySelectorAll("button[data-q]").forEach(b => {
    b.addEventListener("click", () => {
      const id = parseInt(b.getAttribute("data-id"), 10);
      const q = b.getAttribute("data-q");
      if (!id || !q) return;
      if (q === "start") return quickSetStatus(id, "in_progress");
      if (q === "done") return quickSetStatus(id, "done");
      if (q === "trouble") return quickSetStatus(id, "troubleshoot");
    });
  });
}

async function loadJob() {
  const res = await fetch(`${API}/api/v1/jobs/${jobId}`);
  const j = await res.json();
  if (!j) {
    el("jobTitle").textContent = "Job nicht gefunden";
    el("jobMeta").textContent = "";
    return;
  }
  el("jobTitle").textContent = `KW ${j.kw} · ${j.mode}`;
  el("jobMeta").textContent = `${j.file_name || ""} · ${new Date(j.created_at).toLocaleString()}`;
}

async function loadLines() {
  el("tbody").innerHTML = '<tr><td colspan="16" class="muted">Lade...</td></tr>';
  await loadStats();
  const res = await fetch(`${API}/api/v1/jobs/${jobId}/lines?status=${encodeURIComponent(currentStatus)}&limit=1000&offset=0`);
  const data = await res.json();
  currentLines = data.items || [];
  // Build reservation map: BB-IN ports already used in this job
reservedByInstance = new Map();
for (const r of (currentLines || [])) {
  const inst = (r.backbone_in_instance_id || "").trim();
  const port = (r.backbone_in_port_label || "").trim();
  if (!inst || !port) continue;

  if (!reservedByInstance.has(inst)) reservedByInstance.set(inst, new Set());
  reservedByInstance.get(inst).add(port);
}

  renderTable(currentLines);
}

function showModal(show) {
  el("modalBg").style.display = show ? "flex" : "none";
}


function applyModalLocking(statusKey){
  const s = String(statusKey || "").toLowerCase();
  const lockAll = ["done","active","deinstalled"].includes(s);
  const trouble = (s === "troubleshoot");

  const disable = (id, v=true) => {
    const e = el(id);
    if (!e) return;
    e.disabled = v;
    if (v) e.setAttribute("disabled","disabled"); else e.removeAttribute("disabled");
  };

  // default enable all
  ["editStatus","editBbInPP","editBbInPort","editBbOutInstance","editBbOutPort","editAssigned","btnSave"].forEach(id => disable(id,false));
  // bbInPort is readonly anyway; keep it disabled when needed
  if (el("editBbInPort")) el("editBbInPort").readOnly = true;

  if (lockAll){
    ["editStatus","editBbInPP","editBbInPort","editBbOutInstance","editBbOutPort","editAssigned","editComment"].forEach(id => disable(id,true));
    disable("btnSave", true);
    if (el("bbInGrid")) el("bbInGrid").innerHTML = "<div class=\"muted\">Status ist gesperrt (done/active/deinstalled). Keine Änderungen möglich.</div>";
    return;
  }

  if (trouble){
    // only allow comment
    ["editStatus","editBbInPP","editBbInPort","editBbOutInstance","editBbOutPort","editAssigned"].forEach(id => disable(id,true));
    disable("editComment", false);
    disable("btnSave", false);
    if (el("bbInGrid")) el("bbInGrid").innerHTML = "<div class=\"muted\">Troubleshoot: nur Bemerkung bearbeiten.</div>";
    return;
  }

  // normal: allow everything (comment too)
  disable("editComment", false);
}

function fillStatusOptions() {
  el("editStatus").innerHTML = STATUS_FLOW.map(s => `<option value="${s}">${s}</option>`).join("");
}

async function openEdit(id) {
  if (!(window.isAdminRole && window.isAdminRole())) {
    alert("Nur Admin darf bearbeiten.");
    return;
  }
  editId = id;
  const r = currentLines.find(x => x.id === id);
  if (!r) return;

  if (isLockedByOther(r)) {
    alert(lockHint(r));
    return;
  }

  fillStatusOptions();
  el("modalSub").textContent = `ID ${r.id} · Status ${r.status || ""} · Switch ${r.switch_name || ""} ${r.switch_port || ""}`;

  el("editStatus").value = (r.status || "planned");
  // Customer side is FIX (never editable in KW Jobs)
  el("viewCustPP").value = String(r.customer_pp_name ?? r.customer_patchpanel_id ?? "");
  el("viewCustPort").value = r.customer_port_label || "";

  // BB OUT is derived from BB IN (auto)
  el("editBbOutInstance").value = r.backbone_out_instance_id || "";
  el("editBbOutPort").value = r.backbone_out_port_label || "";
  el("editAssigned").value = r.assigned_to || "";
  if (el("editComment")) el("editComment").value = r.tech_comment || "";

  // BB IN selection: show only backbone panels that go to the customer's room
  await loadBbInPatchpanelsForLine(id, r.backbone_in_instance_id, r.backbone_in_port_label);

  applyModalLocking(r.status || "");
  showModal(true);
}

function ppOptionLabel(pp) {
  const parts = [];
  if (pp.instance_id) parts.push(pp.instance_id);
  if (pp.rack_unit != null) parts.push(`RU${pp.rack_unit}`);
  if (pp.rack_label) parts.push(pp.rack_label);
  return parts.join(" · ") || String(pp.id);
}

async function loadBbInPatchpanelsForLine(ccId, currentInstanceId, currentPort) {
  const sel = el("editBbInPP");
  const portInput = el("editBbInPort");
  const gridEl = el("bbInGrid");
  if (!sel || !portInput || !gridEl) return;

  sel.innerHTML = "<option value=\"\">Lade…</option>";
  portInput.value = currentPort || "";
  gridEl.innerHTML = "";
  bbInCtx = null;
  bbInPorts = [];

  try {
    const res = await fetch(`${API}/api/v1/jobs/lines/${ccId}/bbin-pps`);
    const data = await res.json();
    bbInCtx = data.context || null;
    const pps = data.patchpanels || [];

    if (!pps.length) {
      sel.innerHTML = "<option value=\"\">(keine Backbone-Panels gefunden)</option>";
      gridEl.innerHTML = "<div class=\"muted\">Keine passenden Backbone Panels für diesen Raum.</div>";
      return;
    }

    sel.innerHTML = pps.map(pp => {
      const id = pp.id;
      const lbl = ppOptionLabel(pp);
      const inst = escapeHtml(pp.instance_id || "");
      return `<option value=\"${id}\" data-instance=\"${inst}\">${escapeHtml(lbl)}</option>`;
    }).join("");

    // try select current (by instance_id match)
    const match = (currentInstanceId && pps.find(p => (p.instance_id || "") === currentInstanceId)) || null;
    sel.value = String((match && match.id) || pps[0].id);

    if (!sel.dataset.bound) {
      sel.dataset.bound = "1";
      sel.addEventListener("change", async () => {
        portInput.value = "";
        el("editBbOutInstance").value = "";
        el("editBbOutPort").value = "";
        await loadBbInPorts(Number(sel.value || 0), "");
      });
    }

    await loadBbInPorts(Number(sel.value || 0), currentPort || "");
  } catch (e) {
    console.error(e);
    sel.innerHTML = "<option value=\"\">(Fehler beim Laden)</option>";
    gridEl.innerHTML = "<div class=\"muted\">Fehler beim Laden der Backbone Panels.</div>";
  }
}

async function loadBbInPorts(ppId, preselectPort) {
  const portInput = el("editBbInPort");
  const gridEl = el("bbInGrid");
  if (!ppId) {
    gridEl.innerHTML = "";
    return;
  }

  gridEl.innerHTML = "<div class=\"muted\">Ports lade…</div>";

  // get instance_id string from dropdown (data-instance)
  const sel = el("editBbInPP");
  const opt = sel && sel.options && sel.selectedIndex >= 0 ? sel.options[sel.selectedIndex] : null;
  const bbInInstanceId = (opt && opt.dataset && opt.dataset.instance) ? String(opt.dataset.instance) : "";

  const res = await fetch(`${API}/patchpanels/${ppId}/ports`);
  const data = await res.json();

  const roomPrefix = (bbInCtx && bbInCtx.room) ? String(bbInCtx.room) : "";
  const selectedLabel = (preselectPort || portInput.value || "").trim();

  // reservation set for this BB-IN instance within this job
  const reservedSet = reservedByInstance.get(bbInInstanceId) || new Set();

  // normalize ports and compute occupied/selectable properly
  bbInPorts = (data.ports || []).map(p => {
    const label = (p.port_label || p.label || "").trim();
    const peerInst = (p.peer_instance_id || (p.peer && p.peer.instance_id) || "").toString().trim();
    const peerPort = (p.peer_port_label || (p.peer && p.peer.port_label) || "").toString().trim();

    const ct =
      (p.connected_to ?? p.connectedTo ?? p.switch_connection ?? p.switchConnection ?? "").toString().trim();

    // occupied from backend (real patch) OR if connected_to/switch_connection is set
    let occupied =
      (typeof p.occupied === "boolean") ? p.occupied :
      (ct !== "" && ct.toLowerCase() !== "null" && ct.toLowerCase() !== "none");

    // ✅ IMPORTANT: reservation from cross_connects (job-level locking)
    // block if reserved by another line in same job
    if (!occupied && bbInInstanceId && reservedSet.has(label) && label !== selectedLabel) {
      occupied = true; // treat as occupied in UI
    }

    const selectable =
      (typeof p.selectable === "boolean") ? p.selectable : !occupied;

    return {
      label,
      status: (p.status || "").toLowerCase(),
      peer_instance_id: peerInst || null,
      peer_port_label: peerPort || null,
      occupied,
      selectable
    };
  }).filter(p => p.label);

  const pick = (label) => {
    const portObj = bbInPorts.find(x => x.label === label);
    if (!portObj) return;

    // Guard: only allow ports that actually go to the target room
    if (roomPrefix && portObj.peer_instance_id && !String(portObj.peer_instance_id).startsWith(roomPrefix)) return;

    // block occupied
    if (portObj.occupied) return;

    portInput.value = label;

    // Auto-derive BB OUT from the selected port's peer mapping
    el("editBbOutInstance").value = portObj.peer_instance_id || "";
    el("editBbOutPort").value = portObj.peer_port_label || "";

    renderPortGrid(gridEl, bbInPorts, pick, { selected: label, roomPrefix });
  };

  renderPortGrid(gridEl, bbInPorts, pick, { selected: selectedLabel, roomPrefix });

  // If a port is already selected, ensure BB OUT is synced
  if (selectedLabel) {
    const portObj = bbInPorts.find(x => x.label === selectedLabel);
    if (portObj) {
      el("editBbOutInstance").value = portObj.peer_instance_id || el("editBbOutInstance").value;
      el("editBbOutPort").value = portObj.peer_port_label || el("editBbOutPort").value;
    }
  }
}


function renderPortGrid(container, ports, onPick, opts = {}) {
  container.innerHTML = "";
  const map = new Map();
  (ports || []).forEach(p => map.set(p.label, p));

  let maxRowNum = 0;
  for (const label of map.keys()) {
    const m = String(label).match(/^(\d+)[A-D]\d+$/);
    if (m) maxRowNum = Math.max(maxRowNum, Number(m[1]));
  }
  if (!maxRowNum) maxRowNum = 4;

  for (let rowNum = 1; rowNum <= maxRowNum; rowNum++) {
    const row = document.createElement("div");
    row.className = "cassette-row";

    for (const letter of letters) {
      const card = document.createElement("div");
      card.className = "cassette";

      const title = document.createElement("h4");
      title.textContent = `Kassette ${rowNum}${letter}`;
      card.appendChild(title);

      const portsWrap = document.createElement("div");
      portsWrap.className = "ports";

      for (const pos of positions) {
        const label = `${rowNum}${letter}${pos}`;
        const p = map.get(label);

        const btn = document.createElement("button");
        btn.className = "pbtn";
        btn.textContent = label;

        // --- kein Port -> NA
        if (!p) {
          btn.classList.add("na");
          btn.disabled = true;
          portsWrap.appendChild(btn);
          continue;
        }

        // --- room filter (wenn gesetzt)
        if (opts.roomPrefix && p.peer_instance_id && !String(p.peer_instance_id).startsWith(String(opts.roomPrefix))) {
          btn.classList.add("na");
          btn.disabled = true;
          portsWrap.appendChild(btn);
          continue;
        }

        // ✅ LOGIK:
        // occupied=true => rot + disabled
        // selectable=false => grau + disabled
        // sonst => grün + enabled
        if (p.occupied) {
          btn.classList.add("occ");
          btn.disabled = true;
        } else if (p.selectable === false) {
          btn.classList.add("na");
          btn.disabled = true;
        } else {
          btn.classList.add("free");
          btn.disabled = false;
        }

        // ✅ selected soll ROT aussehen (wie du willst)
        if (opts.selected && label === opts.selected) {
          btn.classList.add("sel");
          btn.classList.add("occ"); // <-- macht selected optisch rot
        }

        // ✅ click nur wenn nicht disabled
        if (!btn.disabled) {
          btn.addEventListener("click", () => onPick(label));
        }

        portsWrap.appendChild(btn);
      }

      card.appendChild(portsWrap);
      row.appendChild(card);
    }

    container.appendChild(row);
  }
}



async function saveEdit() {
  if (!(window.isAdminRole && window.isAdminRole())) {
    alert("Nur Admin darf speichern.");
    return;
  }
  if (!editId) return;
  const ppId = Number(el("editBbInPP").value || 0) || null;
  const currentLine = currentLines.find(x => x.id === editId);
  const stKey = String((currentLine && currentLine.status) || el("editStatus").value || "").toLowerCase();
  const payload = {
    status: el("editStatus").value,
    backbone_in_instance_id: null, // we store instance_id string (from dropdown meta)
    backbone_in_port_label: el("editBbInPort").value,
    backbone_out_instance_id: el("editBbOutInstance").value,
    backbone_out_port_label: el("editBbOutPort").value,
    assigned_to: el("editAssigned").value || userName(),
    current_user: userName(),
    tech_comment: el("editComment") ? el("editComment").value : undefined,
  };

  // Restrict payload by workflow rules
  if (["done","active","deinstalled"].includes(stKey)) {
    alert("Diese Leitung ist gesperrt (" + stKey + ").");
    return;
  }
  if (stKey === "troubleshoot") {
    // only send comment + assigned/status (optional)
    for (const k of Object.keys(payload)) {
      if (!["current_user","tech_comment","assigned_to","status"].includes(k)) delete payload[k];
    }
  }

  // Resolve BB IN instance_id label from currently selected option text? better: cache from dropdown
  const sel = el("editBbInPP");
  const opt = sel && sel.options && sel.selectedIndex >= 0 ? sel.options[sel.selectedIndex] : null;
  // We keep instance_id as the first token in option label OR store data-instance on option
  // For safety, prefer data-instance if present.
  payload.backbone_in_instance_id = (opt && opt.dataset && opt.dataset.instance) ? opt.dataset.instance : null;
  if (!payload.backbone_in_instance_id && opt) {
    // option label usually begins with instance_id
    const txt = (opt.textContent || "").trim();
    payload.backbone_in_instance_id = txt.split(" · ")[0] || null;
  }

  el("btnSave").disabled = true;
  el("btnSave").textContent = "Speichere...";
  try {
    const res = await fetch(`${API}/api/v1/cross-connects/item/${editId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    if (!res.ok) {
      const txt = await res.text();
      throw new Error(txt);
    }
    showModal(false);
    await loadLines();
  } catch (e) {
    console.error(e);
    alert("Speichern fehlgeschlagen:\n" + (e?.message || e));
  } finally {
    el("btnSave").disabled = false;
    el("btnSave").textContent = "Speichern";
  }
}

el("btnBack").addEventListener("click", () => window.location.href = "kw-jobs.html");
el("btnReload").addEventListener("click", () => loadLines());

el("modalClose").addEventListener("click", () => showModal(false));
el("btnCancel").addEventListener("click", () => showModal(false));
el("btnSave").addEventListener("click", saveEdit);

if (!jobId) {
  el("jobTitle").textContent = "Fehler: job_id fehlt";
  el("jobMeta").textContent = "";
} else {
  loadStats();
  loadJob();
  loadLines();
}


async function downloadFile(url, filename){
  const res = await fetch(url);
  if (!res.ok){
    const t = await res.text();
    throw new Error(t);
  }
  const blob = await res.blob();
  const a = document.createElement("a");
  const objUrl = window.URL.createObjectURL(blob);
  a.href = objUrl;
  a.download = filename || "export";
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.URL.revokeObjectURL(objUrl);
}

const btnCsv = el("btnExportCsv");
if (btnCsv) btnCsv.addEventListener("click", async () => {
  try{
    await downloadFile(`${API}/api/v1/jobs/${jobId}/export.csv`, `job_${jobId}_export.csv`);
  }catch(e){
    console.error(e);
    alert("Export CSV fehlgeschlagen:\n" + (e?.message || e));
  }
});

const btnX = el("btnExportXlsx");
if (btnX) btnX.addEventListener("click", async () => {
  try{
    await downloadFile(`${API}/api/v1/jobs/${jobId}/export.xlsx`, `job_${jobId}_export.xlsx`);
  }catch(e){
    console.error(e);
    alert("Export Excel fehlgeschlagen:\n" + (e?.message || e));
  }
});
