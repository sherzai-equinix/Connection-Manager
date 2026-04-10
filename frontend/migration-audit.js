// migration-audit.js
// ═══════════════════════════════════════════════════════════════
// Unified Cross-Connect Form for Migration Audit
// Same layout & interactions as KW Planning → Neue Installation
// ═══════════════════════════════════════════════════════════════

const API     = String(window.API_ROOT      || "").replace(/\/+$/, "");
const API_PP  = String(window.API_PATCHPANELS || `${API}/patchpanels`).replace(/\/+$/, "");
const API_RV  = String(window.API_RACKVIEW    || `${API}/rackview`).replace(/\/+$/, "");

const LETTERS   = ["A","B","C","D"];
const POSITIONS = [1,2,3,4,5,6];
const PAGE_SIZE = 50;

const el = (id) => document.getElementById(id);

/* ── Helpers ── */
function escapeHtml(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
const esc = escapeHtml;

function toast(msg) {
  const box = el("importMsg");
  if (box) box.textContent = msg;
}

function currentRole() {
  return String(
    localStorage.getItem("userRole") || sessionStorage.getItem("userRole") || "viewer"
  ).toLowerCase();
}
function isAdminRole() {
  const r = currentRole();
  return r === "admin" || r === "superadmin";
}

async function apiJson(url, opts) {
  const res = await fetch(url, opts);
  let data = null;
  try { data = await res.json(); } catch { /* ignore */ }
  if (!res.ok) {
    const d = (data && (data.detail || data.message)) ? (data.detail || data.message) : (res.statusText || "Error");
    throw new Error(d);
  }
  return data;
}

/** Normalize room: "M5.04 S6" → "5.4S6" */
function normalizeRoom(room) {
  let r = (room || "").trim();
  if (/^M\d/i.test(r)) r = r.slice(1);
  r = r.replace(/\s+/g, "");
  r = r.replace(/^(\d+)\.0+(\d)/, "$1.$2");
  return r;
}

/* ══════════════════════════════════════
   AUDIT TABLE – state
   ══════════════════════════════════════ */
let currentStatus = "imported";
let currentView = "current"; // "current" = deduplicated, "all" = full history
let allItems = [];
let catItems = { 0: [], 1: [], 2: [] };
let catPages = { 0: 1, 1: 1, 2: 1 };
let catCollapsed = { 0: true, 1: false, 2: false };
const auditFilters = { room:'', switch:'', bb_out_pp:'', serial:'', k_pp:'' };
let _filterCol = '';
let _filterModal = null;
let _lastDedup = null; // last dedup stats from backend

/* ── Load data from backend ── */
async function loadList() {
  toast("Lade...");
  try {
    const data = await apiJson(
      `${API}/migration-audit/list?status=${encodeURIComponent(currentStatus)}&page=1&page_size=50000&view=${encodeURIComponent(currentView)}`
    );
    allItems = data.items || [];
    _lastDedup = data.dedup || null;
    const filtered = _applyFilters(allItems);
    _classifyItems(filtered);
    _updateSummary(data.counts || {}, data.dedup || {});
    _renderAllCategories();
    _wireFilterUI();
    toast(`${allItems.length} Leitungen geladen.`);
  } catch (e) {
    toast(`Fehler: ${e.message}`);
  }
}

function _classifyItems(items) {
  catItems = { 0: [], 1: [], 2: [] };
  for (const it of items) {
    const cat = it.conflict_category ?? 0;
    (catItems[cat] || catItems[0]).push(it);
  }
  catPages = { 0: 1, 1: 1, 2: 1 };
}

/* ── Filters ── */
function _getFilterVal(it, col) {
  if (!it) return '';
  if (col === 'room') return String(it.room || '').trim();
  if (col === 'switch') return String(it.switch_name || '').trim();
  if (col === 'bb_out_pp') return String((it.backbone_out_instance_id || it.pp2_raw || it.pp2_number || '')).trim();
  if (col === 'serial') return String(it.serial_number || '').trim();
  if (col === 'k_pp') return String(it.z_pp_number || it.z_pp_raw || '').trim();
  return '';
}

function _applyFilters(items) {
  return (items || []).filter(it => {
    for (const [col, val] of Object.entries(auditFilters)) {
      if (!val) continue;
      if (_getFilterVal(it, col) !== val) return false;
    }
    return true;
  });
}

function _updateFilterBadges() {
  document.querySelectorAll('.audit-filter-badge').forEach(b => {
    const col = b.getAttribute('data-col');
    const v = auditFilters[col] || '';
    if (v) { b.textContent = v; b.classList.remove('d-none'); }
    else { b.textContent = ''; b.classList.add('d-none'); }
  });
}

function _ensureFilterModal() {
  if (_filterModal) return;
  const e = document.getElementById('filterModal');
  if (!e) return;
  _filterModal = new bootstrap.Modal(e);
}

function openFilter(col) {
  _filterCol = col;
  _ensureFilterModal();
  if (!_filterModal) return;
  const titleMap = { room:'A ROOM', switch:'Switch', bb_out_pp:'BB OUT PP', serial:'Serial', k_pp:'K.PP' };
  document.getElementById('filterModalTitle').textContent = 'Filter: ' + (titleMap[col] || col);
  const select = document.getElementById('filterModalSelect');
  const search = document.getElementById('filterModalSearch');
  const hint = document.getElementById('filterModalHint');
  const values = Array.from(new Set(
    (allItems || []).map(it => _getFilterVal(it, col)).filter(v => v)
  )).sort((a,b) => a.localeCompare(b));
  const current = auditFilters[col] || '';
  function renderOptions(q='') {
    const qq = String(q || '').trim().toLowerCase();
    select.innerHTML = '';
    const filtered = values.filter(v => !qq || v.toLowerCase().includes(qq));
    for (const v of filtered) {
      const opt = document.createElement('option');
      opt.value = v; opt.textContent = v;
      if (v === current) opt.selected = true;
      select.appendChild(opt);
    }
    hint.textContent = filtered.length + ' Werte';
  }
  search.value = '';
  renderOptions('');
  search.oninput = () => renderOptions(search.value);
  _filterModal.show();
}

function _wireFilterUI() {
  document.querySelectorAll('.audit-filter-btn').forEach(btn => {
    if (btn.dataset.bound === '1') return;
    btn.dataset.bound = '1';
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      openFilter(btn.getAttribute('data-col'));
    });
  });
  const applyBtn = document.getElementById('filterModalApply');
  const clearBtn = document.getElementById('filterModalClear');
  if (applyBtn && applyBtn.dataset.bound !== '1') {
    applyBtn.dataset.bound = '1';
    applyBtn.addEventListener('click', (e) => {
      e.preventDefault();
      const sel = document.getElementById('filterModalSelect');
      auditFilters[_filterCol] = (sel && sel.value) ? sel.value : '';
      const filtered = _applyFilters(allItems);
      _classifyItems(filtered);
      _updateFilterBadges();
      _renderAllCategories();
      _wireFilterUI();
      _filterModal.hide();
    });
  }
  if (clearBtn && clearBtn.dataset.bound !== '1') {
    clearBtn.dataset.bound = '1';
    clearBtn.addEventListener('click', (e) => {
      e.preventDefault();
      auditFilters[_filterCol] = '';
      const filtered = _applyFilters(allItems);
      _classifyItems(filtered);
      _updateFilterBadges();
      _renderAllCategories();
      _wireFilterUI();
      _filterModal.hide();
    });
  }
}

/* ── Summary bar ── */
function _updateSummary(counts, dedup) {
  const box = el("auditSummary");
  if (!box) return;
  const c2 = counts.errors_both ?? catItems[2].length;
  const c1 = counts.errors_single ?? catItems[1].length;
  const c0 = counts.clean ?? catItems[0].length;
  const dd = dedup || {};
  let html = `
    <div class="summary-item"><span class="summary-dot err"></span> ${c2} beidseitige Fehler</div>
    <div class="summary-item"><span class="summary-dot warn"></span> ${c1} einseitige Konflikte</div>
    <div class="summary-item"><span class="summary-dot ok"></span> ${c0} fehlerfrei</div>
  `;
  if (dd.total_imported && dd.discarded_old > 0) {
    html += `
      <div class="summary-item" style="border-left:1px solid var(--border,#444); padding-left:10px; margin-left:6px;">
        <span style="color:#94a3b8;">${dd.total_imported} Historienzeilen &rarr; <b>${dd.current_lines}</b> aktuelle Leitungen</span>
      </div>
      <div class="summary-item"><span style="color:#64748b;">${dd.discarded_old} Altstände verworfen</span></div>
    `;
  }
  html += `<div class="summary-item" style="margin-left:auto;">Gesamt: <b>${c2+c1+c0}</b></div>`;
  box.innerHTML = html;
  box.style.display = (c2 + c1 + c0) > 0 ? 'flex' : 'none';
}

/* ══════════════════════════════════════
   RENDER CATEGORIES + TABLES
   ══════════════════════════════════════ */

function _renderAllCategories() {
  for (const cat of [2, 1, 0]) {
    _renderCatCount(cat);
    _renderCatTable(cat);
    _renderCatPager(cat);
    _updateCatBodyState(cat);
  }
  _updateFilterBadges();
}

function _renderCatCount(cat) {
  const badge = el(`catCount${cat}`);
  if (badge) badge.textContent = catItems[cat].length;
  const section = el(`catSection${cat}`);
  if (section) section.style.display = catItems[cat].length > 0 ? '' : 'none';
}

function _updateCatBodyState(cat) {
  const body = el(`catBody${cat}`);
  const toggle = document.querySelector(`#catSection${cat} .audit-cat-toggle`);
  if (!body) return;
  if (catCollapsed[cat]) {
    body.classList.add('collapsed');
    if (toggle) toggle.innerHTML = '&#9654;';
  } else {
    body.classList.remove('collapsed');
    if (toggle) toggle.innerHTML = '&#9660;';
  }
}

const THEAD_HTML = `<tr>
  <th>ID</th>
  <th>A ROOM
    <button type="button" class="audit-filter-btn" data-col="room" title="Filter">&#9207;</button>
    <span class="badge bg-primary ms-1 d-none audit-filter-badge" data-col="room"></span>
  </th>
  <th>Switch
    <button type="button" class="audit-filter-btn" data-col="switch" title="Filter">&#9207;</button>
    <span class="badge bg-primary ms-1 d-none audit-filter-badge" data-col="switch"></span>
  </th>
  <th>A PP</th>
  <th>A Port</th>
  <th>BB IN PP</th>
  <th>BB IN Port</th>
  <th>BB OUT PP
    <button type="button" class="audit-filter-btn" data-col="bb_out_pp" title="Filter">&#9207;</button>
    <span class="badge bg-primary ms-1 d-none audit-filter-badge" data-col="bb_out_pp"></span>
  </th>
  <th>BB OUT Port</th>
  <th>K.Rack</th>
  <th>K.PP
    <button type="button" class="audit-filter-btn" data-col="k_pp" title="Filter">&#9207;</button>
    <span class="badge bg-primary ms-1 d-none audit-filter-badge" data-col="k_pp"></span>
  </th>
  <th>K.Port</th>
  <th>Product</th>
  <th>Serial
    <button type="button" class="audit-filter-btn" data-col="serial" title="Filter">&#9207;</button>
    <span class="badge bg-primary ms-1 d-none audit-filter-badge" data-col="serial"></span>
  </th>
  <th>Letzter Vorgang</th>
  <th>Konflikte</th>
  <th class="text-end">Aktion</th>
</tr>`;

function _renderCatTable(cat) {
  const thead = el(`catHead${cat}`);
  const tbody = el(`catTbody${cat}`);
  if (!thead || !tbody) return;
  thead.innerHTML = THEAD_HTML;
  tbody.innerHTML = '';
  const items = catItems[cat] || [];
  if (!items.length) {
    tbody.innerHTML = `<tr><td colspan="17" class="text-muted small" style="padding:12px;">Keine Eintraege in dieser Kategorie.</td></tr>`;
    return;
  }
  const page = catPages[cat] || 1;
  const start = (page - 1) * PAGE_SIZE;
  const end = Math.min(start + PAGE_SIZE, items.length);
  const isAdmin = isAdminRole();

  // Use DocumentFragment for performance
  const frag = document.createDocumentFragment();
  for (let i = start; i < end; i++) {
    const it = items[i];
    const tr = document.createElement("tr");
    const fmtPP = (raw, fallback) => {
      const r = (raw || "").toString().trim();
      return r || (fallback || "").toString().trim();
    };
    const conflictHtml = _buildConflictHtml(it);
    const eventBadge = _buildEventBadge(it.event_type || "Install");
    const histBtn = (it.history_count || 1) > 1
      ? `<button class="btn btn-sm btn-outline-info" data-action="history" data-id="${it.id}" style="font-size:.7rem;padding:1px 6px;margin-left:4px;" title="Verlauf (${it.history_count} Eintraege)">&#128337; ${it.history_count}</button>`
      : '';
    tr.innerHTML = `
      <td>${it.id}</td>
      <td>${esc(it.room || "")}</td>
      <td>
        ${esc(it.switch_name || "")}<div class="text-muted" style="font-size:.75rem;">${esc(it.switch_port || "")}</div>
        ${it.logical_name ? `<div class="text-muted" style="font-size:.7rem;">LN: ${esc(it.logical_name)}</div>` : ``}
      </td>
      <td>${esc(fmtPP(it.a_pp_number, it.a_pp_raw))}</td>
      <td>${esc(it.a_port_label || "")}${it.a_eqx_port ? (' <span class="text-muted">/' + esc(it.a_eqx_port) + '</span>') : ''}</td>
      <td>${esc((it.backbone_in_instance_id || it.pp1_raw || it.pp1_number || ""))}</td>
      <td>${esc(it.backbone_in_port_label || it.pp1_port_label || "")}</td>
      <td>${esc((it.backbone_out_instance_id || it.pp2_raw || it.pp2_number || ""))}</td>
      <td>${esc(it.backbone_out_port_label || it.pp2_port_label || "")}</td>
      <td>${esc(it.rack_code || "")}</td>
      <td>${esc(fmtPP(it.z_pp_number, it.z_pp_raw))}</td>
      <td>${esc(it.z_port_label || "")}</td>
      <td>${esc(it.product_id || "")}</td>
      <td>${esc(it.serial_number || "")}</td>
      <td>${eventBadge}${histBtn}</td>
      <td style="white-space:normal;max-width:260px;">${conflictHtml}</td>
      <td class="text-end" style="white-space:nowrap;">
        ${isAdmin ? (
          currentStatus === "imported" ? `
            <button class="btn btn-sm btn-outline-primary" data-action="edit" data-id="${it.id}" data-admin-only>Audit</button>
            <button class="btn btn-sm btn-outline-danger" data-action="delete" data-id="${it.id}" data-admin-only title="Leitung loeschen" style="margin-left:4px;">&#128465;</button>
          ` : (currentStatus === "audited" ? `
            <button class="btn btn-sm btn-outline-secondary" data-action="edit" data-id="${it.id}" data-admin-only>Bearbeiten</button>
            <button class="btn btn-sm btn-outline-danger" data-action="delete" data-id="${it.id}" data-admin-only title="Leitung loeschen" style="margin-left:4px;">&#128465;</button>
          ` : ``)
        ) : `<span class="text-muted small">read-only</span>`}
      </td>
    `;
    frag.appendChild(tr);
  }
  tbody.appendChild(frag);

  // Bind edit buttons
  if (isAdmin) {
    tbody.querySelectorAll("button[data-action='edit']").forEach(btn => {
      btn.addEventListener("click", () => openEdit(Number(btn.dataset.id)));
    });
  }
  // Bind history buttons
  tbody.querySelectorAll("button[data-action='history']").forEach(btn => {
    btn.addEventListener("click", () => openHistory(Number(btn.dataset.id)));
  });
  // Bind delete buttons
  tbody.querySelectorAll("button[data-action='delete']").forEach(btn => {
    btn.addEventListener("click", () => deleteAuditLine(Number(btn.dataset.id)));
  });
}

function _buildConflictHtml(it) {
  const ac = it.a_conflicts || [];
  const zc = it.z_conflicts || [];
  if (!ac.length && !zc.length) {
    const bi = it.backbone_in_instance_id || it.backbone_in_port_label;
    const bo = it.backbone_out_instance_id || it.backbone_out_port_label;
    if (!bi || !bo) {
      return `<span class="badge" style="background:rgba(245,158,11,.15);color:#fcd34d;font-size:.72rem;">BB fehlt</span>`;
    }
    return `<span class="badge" style="background:rgba(16,185,129,.15);color:#6ee7b7;font-size:.72rem;">OK</span>`;
  }
  let html = '';
  for (const c of ac) {
    html += `<div class="conflict-chip a-side">${esc(c.msg)}`;
    if (c.serial) html += `<span class="conflict-detail">Serial: ${esc(c.serial)}</span>`;
    if (c.switch_name) html += `<span class="conflict-detail">Switch: ${esc(c.switch_name)} ${esc(c.switch_port || '')}</span>`;
    if (c.dup_serials && c.dup_serials.length) html += `<span class="conflict-detail">Serials: ${c.dup_serials.map(s => esc(s)).join(', ')}</span>`;
    else if (c.dup_line_ids && c.dup_line_ids.length) html += `<span class="conflict-detail">IDs: ${c.dup_line_ids.join(', ')}</span>`;
    html += `</div>`;
  }
  for (const c of zc) {
    html += `<div class="conflict-chip z-side">${esc(c.msg)}`;
    if (c.serial) html += `<span class="conflict-detail">Serial: ${esc(c.serial)}</span>`;
    if (c.switch_name) html += `<span class="conflict-detail">Switch: ${esc(c.switch_name)} ${esc(c.switch_port || '')}</span>`;
    if (c.customer_pp) html += `<span class="conflict-detail">PP: ${esc(c.customer_pp)}</span>`;
    if (c.pp) html += `<span class="conflict-detail">PP: ${esc(c.pp)}</span>`;
    if (c.connected_to) html += `<span class="conflict-detail">Belegt: ${esc(c.connected_to)}</span>`;
    if (c.occupied_by_serials && c.occupied_by_serials.length) html += `<span class="conflict-detail">Belegt von: ${c.occupied_by_serials.map(s => esc(s)).join(', ')}</span>`;
    if (c.cc_id && !c.serial && !c.switch_name && !c.connected_to && !(c.occupied_by_serials && c.occupied_by_serials.length)) html += `<span class="conflict-detail">CC-ID: ${esc(c.cc_id)}</span>`;
    if (c.dup_serials && c.dup_serials.length) html += `<span class="conflict-detail">Serials: ${c.dup_serials.map(s => esc(s)).join(', ')}</span>`;
    else if (c.dup_line_ids && c.dup_line_ids.length) html += `<span class="conflict-detail">IDs: ${c.dup_line_ids.join(', ')}</span>`;
    html += `</div>`;
  }
  return html;
}

/* ── Event type badge ── */
function _buildEventBadge(eventType) {
  const colorMap = {
    'Install':    'background:rgba(16,185,129,.15);color:#6ee7b7;border:1px solid rgba(16,185,129,.3)',
    'Line Move':  'background:rgba(59,130,246,.15);color:#93c5fd;border:1px solid rgba(59,130,246,.3)',
    'Path Move':  'background:rgba(168,85,247,.15);color:#c4b5fd;border:1px solid rgba(168,85,247,.3)',
    'A-Update':   'background:rgba(245,158,11,.12);color:#fcd34d;border:1px solid rgba(245,158,11,.3)',
    'Z-Update':   'background:rgba(245,158,11,.12);color:#fcd34d;border:1px solid rgba(245,158,11,.3)',
    'Update':     'background:rgba(148,163,184,.12);color:#94a3b8;border:1px solid rgba(148,163,184,.3)',
  };
  const style = colorMap[eventType] || colorMap['Install'];
  return `<span class="badge" style="${style};font-size:.72rem;padding:2px 8px;border-radius:6px;">${esc(eventType || 'Install')}</span>`;
}

/* ── Delete audit line ── */
async function deleteAuditLine(lineId) {
  const item = allItems.find(it => it.id === lineId);
  const desc = item ? `ID ${lineId} (Serial: ${item.serial_number || '-'}, Switch: ${item.switch_name || '-'})` : `ID ${lineId}`;
  if (!confirm(`Leitung wirklich loeschen?\n\n${desc}\n\nDiese Aktion kann nicht rueckgaengig gemacht werden.`)) return;
  try {
    const resp = await fetch(`${API}/migration-audit/${lineId}`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${sessionStorage.getItem('token') || localStorage.getItem('token') || ''}` },
    });
    const data = await resp.json();
    if (!resp.ok || !data.success) throw new Error(data.detail || data.message || 'Loeschen fehlgeschlagen');
    toast(`Leitung ${lineId} geloescht.`);
    loadList();
  } catch (e) {
    toast(`Fehler: ${e.message}`);
  }
}

/* ── History modal ── */
async function openHistory(lineId) {
  try {
    const data = await apiJson(`${API}/migration-audit/history?line_id=${lineId}`);
    if (!data.success || !data.history || !data.history.length) {
      toast("Keine Historie gefunden.");
      return;
    }
    _showHistoryModal(data.history, data.group_key);
  } catch (e) {
    toast(`Fehler: ${e.message}`);
  }
}

function _showHistoryModal(history, groupKey) {
  // Remove existing modal if present
  let existing = document.getElementById('historyModalBg');
  if (existing) existing.remove();

  const bg = document.createElement('div');
  bg.id = 'historyModalBg';
  bg.className = 'modal-bg show';
  bg.style.zIndex = '1060';

  const fmtPP = (raw, fallback) => {
    const r = (raw || "").toString().trim();
    return r || (fallback || "").toString().trim();
  };

  let tableRows = '';
  for (const h of history) {
    const badge = _buildEventBadge(h.event_type || 'Install');
    const currentTag = h.is_current
      ? '<span class="badge bg-success ms-1" style="font-size:.68rem;">AKTUELL</span>'
      : '<span class="badge" style="font-size:.68rem;background:rgba(148,163,184,.15);color:#64748b;">Alt</span>';
    tableRows += `<tr style="${h.is_current ? 'background:rgba(16,185,129,.06);' : 'opacity:.75;'}">
      <td>${h.id}</td>
      <td>${badge} ${currentTag}</td>
      <td>${esc(h.switch_name || "")}<div class="text-muted" style="font-size:.72rem;">${esc(h.switch_port || "")}</div></td>
      <td>${esc(fmtPP(h.a_pp_number, h.a_pp_raw))}</td>
      <td>${esc(h.a_port_label || "")}</td>
      <td>${esc((h.backbone_in_instance_id || h.pp1_raw || ""))}</td>
      <td>${esc(h.backbone_in_port_label || h.pp1_port_label || "")}</td>
      <td>${esc((h.backbone_out_instance_id || h.pp2_raw || ""))}</td>
      <td>${esc(h.backbone_out_port_label || h.pp2_port_label || "")}</td>
      <td>${esc(fmtPP(h.z_pp_number, h.z_pp_raw))}</td>
      <td>${esc(h.z_port_label || "")}</td>
      <td>${esc(h.serial_number || "")}</td>
      <td>${esc(h.product_id || "")}</td>
      <td>${esc(h.room || "")}</td>
    </tr>`;
  }

  bg.innerHTML = `
    <div class="modal-panel" style="max-width:1200px;">
      <div class="modal-header">
        <h3>Verlauf: ${esc(groupKey || '')} (${history.length} Eintraege)</h3>
        <button class="btn" id="btnHistoryClose">Schliessen</button>
      </div>
      <div class="info-note">
        Zeigt alle historischen Zustaende dieser Leitung. Der aktuellste Eintrag wird in der Hauptliste angezeigt.
      </div>
      <div style="overflow:auto;max-height:60vh;">
        <table class="table table-sm table-striped align-middle audit-tbl">
          <thead>
            <tr>
              <th>ID</th>
              <th>Vorgang</th>
              <th>Switch</th>
              <th>A PP</th>
              <th>A Port</th>
              <th>BB IN PP</th>
              <th>BB IN Port</th>
              <th>BB OUT PP</th>
              <th>BB OUT Port</th>
              <th>Z PP</th>
              <th>Z Port</th>
              <th>Serial</th>
              <th>Product</th>
              <th>Room</th>
            </tr>
          </thead>
          <tbody>${tableRows}</tbody>
        </table>
      </div>
    </div>
  `;
  document.body.appendChild(bg);

  document.getElementById('btnHistoryClose').addEventListener('click', () => bg.remove());
  bg.addEventListener('click', (e) => { if (e.target === bg) bg.remove(); });
}

/* ── Pagination per category ── */
function _renderCatPager(cat) {
  const pager = el(`catPager${cat}`);
  if (!pager) return;
  const total = catItems[cat].length;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const page = catPages[cat] || 1;
  if (totalPages <= 1) { pager.innerHTML = ''; return; }

  let html = `<button ${page <= 1 ? 'disabled' : ''} data-go="${page - 1}">&laquo;</button>`;
  const start = Math.max(1, page - 3);
  const end = Math.min(totalPages, page + 3);
  for (let p = start; p <= end; p++) {
    html += `<button data-go="${p}" class="${p === page ? 'active' : ''}">${p}</button>`;
  }
  html += `<button ${page >= totalPages ? 'disabled' : ''} data-go="${page + 1}">&raquo;</button>`;
  html += `<span class="pager-info">${total} Eintraege, Seite ${page}/${totalPages}</span>`;
  pager.innerHTML = html;

  pager.querySelectorAll('button[data-go]').forEach(btn => {
    btn.addEventListener('click', () => {
      const p = parseInt(btn.dataset.go);
      if (p >= 1 && p <= totalPages) {
        catPages[cat] = p;
        _renderCatTable(cat);
        _renderCatPager(cat);
        _wireFilterUI();
      }
    });
  });
}

/* ── XLSB Import ── */
async function importXlsb() {
  if (!isAdminRole()) { toast("Nur Admin darf importieren."); return; }
  const f = el("auditFile").files && el("auditFile").files[0];
  if (!f) { toast("Bitte XLSB auswaehlen."); return; }
  toast("Import laeuft...");
  const fd = new FormData();
  fd.append("file", f);
  try {
    const data = await apiJson(`${API}/migration-audit/import`, { method: "POST", body: fd });
    toast(`Import ok: inserted=${data.inserted}, skipped=${data.skipped}`);
    await loadList();
  } catch (e) {
    toast(`Import Fehler: ${e.message}`);
  }
}

/* ── Z-Side Import ── */
async function importZside() {
  if (!isAdminRole()) { toast("Nur Admin darf importieren."); return; }
  if (!confirm("Z-Side Kundenstruktur jetzt importieren?\n\nDies erstellt fehlende Kunden, Raeume, Racks und Patchpanels aus den Audit-Daten.")) return;
  const btn = el("btnImportZside");
  if (btn) { btn.disabled = true; btn.textContent = "Importiert..."; }
  toast("Z-Side Import laeuft...");
  try {
    const data = await apiJson(`${API}/migration-audit/import-zside`, { method: "POST" });
    const parts = [];
    if (data.pps_created) parts.push(`${data.pps_created} PPs erstellt`);
    if (data.customers_created) parts.push(`${data.customers_created} Kunden`);
    if (data.racks_created) parts.push(`${data.racks_created} Racks`);
    if (data.audit_lines_updated) parts.push(`${data.audit_lines_updated} Zeilen aktualisiert`);
    if (data.pps_existed) parts.push(`${data.pps_existed} PPs existierten`);
    if (data.errors) parts.push(`${data.errors} Fehler`);
    toast(`Z-Side Import: ${parts.join(", ") || "Keine Aenderungen"}`);
    showZsideStatus(data);
  } catch (e) {
    toast(`Z-Side Import Fehler: ${e.message}`);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = "Z-Side Import"; }
  }
}

function showZsideStatus(data) {
  const box = el("zsideStatus");
  if (!box) return;
  const lines = [];
  if (data.pps_created != null) lines.push(`<b>${data.pps_created}</b> PPs erstellt`);
  if (data.pps_existed != null) lines.push(`<b>${data.pps_existed}</b> PPs existierten`);
  if (data.customers_created != null) lines.push(`<b>${data.customers_created}</b> Kunden erstellt`);
  if (data.racks_created != null) lines.push(`<b>${data.racks_created}</b> Racks erstellt`);
  if (data.audit_lines_updated != null) lines.push(`<b>${data.audit_lines_updated}</b> Zeilen PP-Format aktualisiert`);
  if (data.ports_marked != null) lines.push(`<b>${data.ports_marked}</b> Ports als belegt markiert`);
  if (data.errors) lines.push(`<span style="color:#ef4444"><b>${data.errors}</b> Fehler</span>`);
  box.innerHTML = lines.join(" &middot; ");
  box.style.display = lines.length ? "" : "none";
}

async function loadZsideStatus() {
  try {
    const data = await apiJson(`${API}/migration-audit/zside-status`);
    const box = el("zsideStatus");
    if (!box) return;
    if (data.zside_pps > 0) {
      box.innerHTML = `Z-Side: <b>${data.zside_pps}</b> PPs, <b>${data.customers}</b> Kunden, <b>${data.racks}</b> Racks` +
        (data.missing_zpp > 0 ? ` &middot; <span style="color:#f59e0b">${data.missing_zpp} fehlende PPs</span>` : ` &middot; <span style="color:#10b981">vollstaendig</span>`);
      box.style.display = "";
    }
  } catch { /* ignore */ }
}

/* ══════════════════════════════════════
   UNIFIED EDIT FORM – state
   ══════════════════════════════════════ */
let editId = null;
let editItem = null;

const auState = {
  switchName: "", switchPort: "",
  aRoom: "", aPPInstanceId: "", aPortLabel: "",
  zPPInstanceId: "", zPPDbId: null, zRoom: "", zCustomer: "", zPortLabel: "",
  zRack: "",
  bbInDbId: null, bbInInstanceId: "", bbInPortLabel: "",
  bbOutInstanceId: "", bbOutPortLabel: "",
  bbPanels: [], selectedBbIdx: -1,
};

function resetAuState() {
  Object.assign(auState, {
    switchName: "", switchPort: "",
    aRoom: "", aPPInstanceId: "", aPortLabel: "",
    zPPInstanceId: "", zPPDbId: null, zRoom: "", zCustomer: "", zPortLabel: "",
    zRack: "",
    bbInDbId: null, bbInInstanceId: "", bbInPortLabel: "",
    bbOutInstanceId: "", bbOutPortLabel: "",
    bbPanels: [], selectedBbIdx: -1,
  });
}

/* ══════════════════════════════════════
   PATCHPANEL / PORT helpers
   ══════════════════════════════════════ */
async function fetchPorts(ppId) {
  const d = await apiJson(`${API_PP}/${ppId}/ports`);
  return d.ports || [];
}

/**
 * Auto-release cassettes based on audit lines.
 * Scans allItems for lines whose z_pp_number matches ppInstanceId,
 * finds which cassettes are referenced by z_port_label,
 * and flips any "unavailable" ports in those cassettes to "free".
 */
function _releaseCassettesFromAudit(ports, ppInstanceId) {
  if (!ports || !ppInstanceId) return;
  const ppNorm = String(ppInstanceId).trim().toLowerCase();
  const usedCassettes = new Set();
  for (const it of allItems) {
    const zpp = String(it.z_pp_number || it.z_pp_raw || "").trim().toLowerCase();
    if (zpp !== ppNorm) continue;
    const lbl = String(it.z_port_label || "").trim();
    const m = lbl.match(/^(\d+[A-D])\d+$/i);
    if (m) usedCassettes.add(m[1].toUpperCase());
  }
  if (!usedCassettes.size) return;
  for (const p of ports) {
    if (p.status !== "unavailable") continue;
    const lbl = String(p.port_label || "");
    const m = lbl.match(/^(\d+[A-D])\d+$/i);
    if (m && usedCassettes.has(m[1].toUpperCase())) {
      p.status = "free";
      p.occupied = false;
      p.selectable = true;
      p.usable = true;
    }
  }
}

/* ── Port Grid Renderer (cassette-style, same as KW Planning) ── */
function renderPortGrid(container, ports, onPick, selectedLabel) {
  container.innerHTML = "";
  if (!ports || !ports.length) {
    container.innerHTML = '<div class="small muted">Keine Ports gefunden.</div>';
    return;
  }
  const map = new Map();
  ports.forEach(p => map.set(String(p.port_label || p.label || ""), p));

  let maxRow = 0;
  // Collect cassettes that have at least one real (non-unavailable) port
  const liveCassettes = new Set();
  for (const [label, p] of map.entries()) {
    const m = String(label).match(/^(\d+)([A-D])\d+$/);
    if (m) {
      maxRow = Math.max(maxRow, Number(m[1]));
      if (p.status !== "unavailable") {
        liveCassettes.add(`${m[1]}${m[2]}`);
      }
    }
  }

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

  for (let row = 1; row <= maxRow; row++) {
    const rowDiv = document.createElement("div");
    rowDiv.className = "cassette-row";
    for (const letter of LETTERS) {
      const casKey = `${row}${letter}`;
      const casExists = liveCassettes.has(casKey);
      const card = document.createElement("div");
      card.className = "cassette" + (casExists ? "" : " cassette-empty");
      const title = document.createElement("h4");
      title.textContent = `Kassette ${casKey}`;
      if (!casExists) title.textContent += " (leer)";
      card.appendChild(title);
      if (casExists) {
        const grid = document.createElement("div");
        grid.className = "ports-grid";
        for (const pos of POSITIONS) {
          const label = `${row}${letter}${pos}`;
          const p = map.get(label);
          grid.appendChild(_makePortBtn(label, p, onPick, selectedLabel));
        }
        card.appendChild(grid);
      }
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
    btn.classList.add("occ"); btn.disabled = true;
    btn.title = `Belegt: ${port.serial || ""} ${port.customer || ""}`.trim();
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

/* ══════════════════════════════════════
   AUTOCOMPLETE helpers (same as KW Planning)
   ══════════════════════════════════════ */
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

function handleAutocompleteKey(ev, listEl) {
  if (!listEl || !listEl.classList.contains("show")) return false;
  const items = listEl._acItems || [];
  const pick = listEl._acPick;
  if (!items.length || !pick) return false;
  if (ev.key === "ArrowDown") {
    ev.preventDefault();
    listEl._acIdx = Math.min((listEl._acIdx ?? -1) + 1, items.length - 1);
    _highlightAcItem(listEl); return true;
  }
  if (ev.key === "ArrowUp") {
    ev.preventDefault();
    listEl._acIdx = Math.max((listEl._acIdx ?? 0) - 1, 0);
    _highlightAcItem(listEl); return true;
  }
  if (ev.key === "Enter") {
    ev.preventDefault();
    const idx = (listEl._acIdx >= 0) ? listEl._acIdx : 0;
    if (items[idx] !== undefined) { pick(items[idx]); listEl.classList.remove("show"); }
    return true;
  }
  return false;
}

function _highlightAcItem(listEl) {
  const children = listEl.querySelectorAll(".autocomplete-item");
  children.forEach((c, i) => c.classList.toggle("active", i === listEl._acIdx));
}

/* ══════════════════════════════════════
   A-SIDE: Switch Autocomplete + Resolve
   ══════════════════════════════════════ */
let _auSwNameTimer = null;
function auSwitchNameInput() {
  clearTimeout(_auSwNameTimer);
  let val = (el("auSwitchName")?.value || "").trim();
  if (val.length < 2) { el("auSwitchNameList")?.classList.remove("show"); return; }
  let searchVal = val;
  if (/^\d+$/.test(val)) searchVal = "RFRA" + val;
  _auSwNameTimer = setTimeout(async () => {
    try {
      const d = await apiJson(`${API_RV}/switch-names?q=${encodeURIComponent(searchVal)}`);
      const items = d.items || [];
      if (items.length === 1 && /^\d+$/.test(val)) {
        el("auSwitchName").value = items[0];
        auState.switchName = items[0];
        el("auSwitchNameList")?.classList.remove("show");
        auResolveAside();
        return;
      }
      showAutocomplete(el("auSwitchNameList"), items, name => {
        el("auSwitchName").value = name;
        auState.switchName = name;
        auResolveAside();
      });
    } catch(e) { /* ignore */ }
  }, 250);
}

let _auSwPortTimer = null;
function auSwitchPortInput() {
  clearTimeout(_auSwPortTimer);
  const sw = (el("auSwitchName")?.value || "").trim();
  let val = (el("auSwitchPort")?.value || "").trim();
  if (!sw || val.length < 1) { el("auSwitchPortList")?.classList.remove("show"); return; }
  let searchVal = val;
  if (/^\d+$/.test(val)) searchVal = "ETH1/" + val;
  else if (/^\d+\/\d+$/.test(val)) searchVal = "ETH" + val;
  _auSwPortTimer = setTimeout(async () => {
    try {
      const d = await apiJson(`${API_RV}/switch-ports?switch_name=${encodeURIComponent(sw)}&q=${encodeURIComponent(searchVal)}`);
      const items = d.items || [];
      if (items.length === 1 && /^\d+(\/\d+)?$/.test(val)) {
        el("auSwitchPort").value = items[0];
        auState.switchPort = items[0];
        el("auSwitchPortList")?.classList.remove("show");
        auResolveAside();
        return;
      }
      showAutocomplete(el("auSwitchPortList"), items, port => {
        el("auSwitchPort").value = port;
        auState.switchPort = port;
        auResolveAside();
      });
    } catch(e) { /* ignore */ }
  }, 250);
}

async function auResolveAside() {
  const sw = (el("auSwitchName")?.value || "").trim();
  const sp = (el("auSwitchPort")?.value || "").trim();
  const box = el("auASideResult");
  if (!sw || !sp) { if (box) box.style.display = "none"; return; }
  try {
    const d = await apiJson(`${API_RV}/resolve-switch-port?switch_name=${encodeURIComponent(sw)}&switch_port=${encodeURIComponent(sp)}`);
    if (!d.found) {
      if (box) { box.style.display = "block"; box.innerHTML = '<span style="color:#ef5350;">Kein Pre-Cabled Link gefunden.</span>'; }
      auState.aRoom = ""; auState.aPPInstanceId = ""; auState.aPortLabel = "";
      el("auARoom").value = "";
      return;
    }
    auState.aRoom = d.a_room || "";
    auState.aPPInstanceId = d.a_pp_instance_id || "";
    auState.aPortLabel = d.a_port_label || "";
    el("auARoom").value = d.a_room || "";
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

/* ══════════════════════════════════════
   Z-SIDE: Customer PP Autocomplete + Lookup
   ══════════════════════════════════════ */
let _auZPPTimer = null;
function auZPPInput() {
  clearTimeout(_auZPPTimer);
  const val = (el("auZPP")?.value || "").trim();
  if (val.length < 2) { el("auZPPList")?.classList.remove("show"); return; }
  _auZPPTimer = setTimeout(async () => {
    try {
      const d = await apiJson(`${API_RV}/patchpanel-search?q=${encodeURIComponent(val)}`);
      const items = (d.items || []).map(pp => ({
        label: pp.instance_id,
        sub: pp.existing_system_name || `${pp.customer_name || "?"} – ${(pp.customer_rooms && pp.customer_rooms.length) ? pp.customer_rooms.join(", ") : pp.room || "?"}`,
        _data: pp,
      }));
      showAutocomplete(el("auZPPList"), items, item => {
        el("auZPP").value = item._data.instance_id;
        auApplyZSideLookup(item._data);
      });
    } catch(e) { /* ignore */ }
  }, 300);
}

async function auZPPBlur() {
  el("auZPPList")?.classList.remove("show");
  const val = (el("auZPP")?.value || "").trim();
  if (!val || val === auState.zPPInstanceId) return;
  try {
    const d = await apiJson(`${API_RV}/customer-pp-lookup?instance_id=${encodeURIComponent(val)}`);
    if (d.found) {
      await auApplyZSideLookup(d);
    } else {
      auState.zPPDbId = null; auState.zRoom = ""; auState.zCustomer = "";
      el("auZCustomer").value = ""; el("auZRoom").value = "";
      el("auZPortGrid").innerHTML = '<div class="small" style="color:#ef5350;">Patchpanel nicht gefunden.</div>';
    }
  } catch(e) { /* ignore */ }
}

async function auApplyZSideLookup(pp) {
  auState.zPPInstanceId = pp.instance_id;
  auState.zPPDbId = pp.db_id;

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

  const ppMatch = String(pp.instance_id || "").match(/^PP:(\d{4}):/i);
  const rackFromPP = ppMatch ? ppMatch[1] : "";

  auState.zRoom = customerRoom;
  auState.zCustomer = composedSystemName;
  auState.zPortLabel = "";
  auState.zRack = rackFromPP;
  el("auZCustomer").value = composedSystemName;
  el("auZRoom").value = customerRoom;
  el("auZRack").value = rackFromPP;
  el("auZPortLabel").style.display = "none";

  if (pp.db_id) {
    try {
      const ports = await fetchPorts(pp.db_id);
      // Auto-release cassettes that have audit lines referencing them
      _releaseCassettesFromAudit(ports, pp.instance_id);
      function pickZPort(label) {
        auState.zPortLabel = label;
        el("auZPortLabel").textContent = `Gewaehlt: ${pp.instance_id} / Port ${label}`;
        el("auZPortLabel").style.display = "block";
        renderPortGrid(el("auZPortGrid"), ports, pickZPort, label);
      }
      renderPortGrid(el("auZPortGrid"), ports, pickZPort, auState.zPortLabel || null);
    } catch(e) {
      el("auZPortGrid").innerHTML = `<div class="small" style="color:#ef5350;">${esc(e.message)}</div>`;
    }
  }

  if (customerRoom) await auLoadBBContext(customerRoom);
}

/* ══════════════════════════════════════
   BB IN: Load panels + Port Grid
   ══════════════════════════════════════ */
async function auLoadBBContext(customerRoom) {
  const cards = el("auBbInCards"), hint = el("auBbInHint");
  const pgrid = el("auBbInPortGrid"), plbl = el("auBbInPortLabel");
  const bbout = el("auBbOutResult");
  auState.bbPanels = []; auState.selectedBbIdx = -1;
  auState.bbInDbId = null; auState.bbInInstanceId = ""; auState.bbInPortLabel = "";
  auState.bbOutInstanceId = ""; auState.bbOutPortLabel = "";
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
    const d = await apiJson(`${API_RV}/bb-panels-for-customer-room?customer_room=${encodeURIComponent(customerRoom)}`);
    let items = d.items || [];
    const aRoom = normalizeRoom(auState.aRoom || "");
    if (aRoom && items.length) {
      const filtered = items.filter(p => normalizeRoom(p.bb_room || "") === aRoom);
      if (filtered.length) items = filtered;
    }
    auState.bbPanels = items;
    if (!auState.bbPanels.length) {
      if (hint) hint.textContent = `Keine BB IN PPs gefunden die nach ${customerRoom} gehen.`;
      return;
    }
    auRenderBBCards();
  } catch(e) {
    if (hint) hint.textContent = `Fehler: ${e.message}`;
  }
}

function auRenderBBCards() {
  const cards = el("auBbInCards"); if (!cards) return;
  cards.innerHTML = "";
  for (let i = 0; i < auState.bbPanels.length; i++) {
    const p = auState.bbPanels[i];
    const card = document.createElement("div");
    card.className = "bb-card" + (i === auState.selectedBbIdx ? " selected" : "");
    card.innerHTML = `<div>${esc(p.bb_instance_id)}</div><div class="bb-label">${esc(p.bb_room)} \u2192 ${esc(p.peer_room)}</div>`;
    card.addEventListener("click", () => auSelectBBPanel(i));
    cards.appendChild(card);
  }
}

async function auSelectBBPanel(idx) {
  auState.selectedBbIdx = idx;
  auState.bbInPortLabel = "";
  auState.bbOutInstanceId = ""; auState.bbOutPortLabel = "";
  const panel = auState.bbPanels[idx];
  auState.bbInDbId = panel.bb_db_id;
  auState.bbInInstanceId = panel.bb_instance_id;
  auRenderBBCards();
  const bbout = el("auBbOutResult"); if (bbout) { bbout.style.display = "none"; bbout.innerHTML = ""; }
  el("auBbInPortLabel").style.display = "none";
  try {
    const ports = await fetchPorts(panel.bb_db_id);
    const gridEl = el("auBbInPortGrid"), lblEl = el("auBbInPortLabel");
    function pickBbPort(label) {
      auState.bbInPortLabel = label;
      lblEl.textContent = `Gewaehlt: ${panel.bb_instance_id} / Port ${label}`;
      lblEl.style.display = "block";
      renderPortGrid(gridEl, ports, pickBbPort, label);
      auResolveBBOut(panel.bb_instance_id, label);
    }
    renderPortGrid(gridEl, ports, pickBbPort, null);
  } catch(e) {
    el("auBbInPortGrid").innerHTML = `<div class="small" style="color:#ef5350;">${esc(e.message)}</div>`;
  }
}

/* ── BB OUT auto-resolve via peer ── */
async function auResolveBBOut(bbInInstanceId, bbInPortLabel) {
  const box = el("auBbOutResult");
  auState.bbOutInstanceId = ""; auState.bbOutPortLabel = "";
  if (!bbInInstanceId || !bbInPortLabel) { if (box) box.style.display = "none"; return; }
  try {
    const d = await apiJson(`${API_RV}/patchpanel-peer?instance_id=${encodeURIComponent(bbInInstanceId)}&port_label=${encodeURIComponent(bbInPortLabel)}`);
    if (d.peer_instance_id && d.peer_port_label) {
      auState.bbOutInstanceId = d.peer_instance_id;
      auState.bbOutPortLabel = d.peer_port_label;
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

/* ══════════════════════════════════════
   MODAL: open / close
   ══════════════════════════════════════ */
function showAuditModal() {
  const bg = el("auditEditBg");
  if (bg) { bg.classList.add("show"); bg.style.display = "block"; }
  document.documentElement.classList.add("modal-open");
}

function hideAuditModal() {
  const bg = el("auditEditBg");
  if (bg) { bg.classList.remove("show"); bg.style.display = "none"; }
  document.documentElement.classList.remove("modal-open");
  editId = null; editItem = null;
}

/* ══════════════════════════════════════
   OPEN EDIT – fill unified form from audit line
   ══════════════════════════════════════ */
async function openEdit(id) {
  if (!isAdminRole()) { toast("Nur Admin darf bearbeiten."); return; }
  editId = id;
  editItem = null;
  for (const cat of [0, 1, 2]) {
    editItem = catItems[cat].find(x => x.id === id);
    if (editItem) break;
  }
  if (!editItem) editItem = allItems.find(x => x.id === id);
  if (!editItem) return;

  resetAuState();

  el("auSerial").value = editItem.serial_number || "";
  el("auProductId").value = editItem.product_id || "";
  el("auComment").value = editItem.tech_comment || "";

  el("auSwitchName").value = editItem.switch_name || "";
  el("auSwitchPort").value = editItem.switch_port || "";
  el("auARoom").value = "";
  auState.switchName = editItem.switch_name || "";
  auState.switchPort = editItem.switch_port || "";

  const zppRaw = editItem.z_pp_number || editItem.z_pp_raw || "";
  el("auZPP").value = zppRaw;
  el("auZCustomer").value = "";
  el("auZRoom").value = "";
  el("auZRack").value = editItem.rack_code || "";
  auState.zRack = editItem.rack_code || "";

  ["auSwitchNameList","auSwitchPortList","auZPPList"].forEach(id2 => {
    const e = el(id2); if (e) e.classList.remove("show");
  });
  const aside = el("auASideResult"); if (aside) { aside.style.display = "none"; aside.innerHTML = ""; }
  const bbout = el("auBbOutResult"); if (bbout) { bbout.style.display = "none"; bbout.innerHTML = ""; }
  el("auBbInCards").innerHTML = "";
  el("auZPortGrid").innerHTML = "";
  el("auBbInPortGrid").innerHTML = "";
  el("auZPortLabel").style.display = "none";
  el("auBbInPortLabel").style.display = "none";
  el("auBbInHint").textContent = "Z-Seite eingeben, um passende BB IN PPs zu sehen.";

  // ── Show current BB values from audit line immediately as hint ──
  const _bbInId  = (editItem.backbone_in_instance_id || "").trim();
  const _bbInPt  = (editItem.backbone_in_port_label || "").trim();
  const _bbOutId = (editItem.backbone_out_instance_id || "").trim();
  const _bbOutPt = (editItem.backbone_out_port_label || "").trim();
  const hintBox = el("auBbPrefillHint");
  if (hintBox) {
    if (_bbInId || _bbOutId) {
      hintBox.style.display = "block";
      hintBox.innerHTML = `<div class="af-grid">
        <div><div class="af-label">BB IN (Excel)</div><div class="af-val">${esc(_bbInId || "-")} / ${esc(_bbInPt || "-")}</div></div>
        <div><div class="af-label">BB OUT (Excel)</div><div class="af-val">${esc(_bbOutId || "-")} / ${esc(_bbOutPt || "-")}</div></div>
      </div>`;
    } else {
      hintBox.style.display = "none";
      hintBox.innerHTML = "";
    }
  }

  showAuditModal();

  if (editItem.switch_name && editItem.switch_port) {
    await auResolveAside();
  }

  if (zppRaw) {
    try {
      const d = await apiJson(`${API_RV}/customer-pp-lookup?instance_id=${encodeURIComponent(zppRaw)}`);
      if (d.found) {
        await auApplyZSideLookup(d);
        if (editItem.z_port_label) {
          auState.zPortLabel = editItem.z_port_label;
          const zPortLabel = el("auZPortLabel");
          if (zPortLabel) {
            zPortLabel.textContent = `Gewaehlt: ${d.instance_id} / Port ${editItem.z_port_label}`;
            zPortLabel.style.display = "block";
          }
          if (d.db_id) {
            try {
              const ports = await fetchPorts(d.db_id);
              _releaseCassettesFromAudit(ports, d.instance_id);
              function pickZPort(label) {
                auState.zPortLabel = label;
                el("auZPortLabel").textContent = `Gewaehlt: ${d.instance_id} / Port ${label}`;
                el("auZPortLabel").style.display = "block";
                renderPortGrid(el("auZPortGrid"), ports, pickZPort, label);
              }
              renderPortGrid(el("auZPortGrid"), ports, pickZPort, editItem.z_port_label);
            } catch(e) { /* ignore */ }
          }
        }
      }
    } catch(e) { /* PP not found in DB */ }
  }

  const bbInWant = String(editItem.backbone_in_instance_id || "").split("->", 1)[0].trim();
  let bbMatched = false;
  if (bbInWant && auState.bbPanels.length) {
    const bbIdx = auState.bbPanels.findIndex(p => p.bb_instance_id === bbInWant);
    if (bbIdx >= 0) {
      bbMatched = true;
      await auSelectBBPanel(bbIdx);
      if (editItem.backbone_in_port_label) {
        auState.bbInPortLabel = editItem.backbone_in_port_label;
        const lbl = el("auBbInPortLabel");
        if (lbl) {
          lbl.textContent = `Gewaehlt: ${bbInWant} / Port ${editItem.backbone_in_port_label}`;
          lbl.style.display = "block";
        }
        if (auState.bbPanels[bbIdx]?.bb_db_id) {
          try {
            const ports = await fetchPorts(auState.bbPanels[bbIdx].bb_db_id);
            const gridEl = el("auBbInPortGrid"), lblEl = el("auBbInPortLabel");
            function pickBbPort(label) {
              auState.bbInPortLabel = label;
              lblEl.textContent = `Gewaehlt: ${bbInWant} / Port ${label}`;
              lblEl.style.display = "block";
              renderPortGrid(gridEl, ports, pickBbPort, label);
              auResolveBBOut(bbInWant, label);
            }
            renderPortGrid(gridEl, ports, pickBbPort, editItem.backbone_in_port_label);
          } catch(e) { /* ignore */ }
        }
        if (editItem.backbone_out_instance_id) {
          auState.bbOutInstanceId = editItem.backbone_out_instance_id;
          auState.bbOutPortLabel = editItem.backbone_out_port_label || "";
          const bboutEl = el("auBbOutResult");
          if (bboutEl) {
            bboutEl.style.display = "block";
            bboutEl.innerHTML = `<div class="af-grid">
              <div><div class="af-label">BB OUT Panel</div><div class="af-val">${esc(editItem.backbone_out_instance_id)}</div></div>
              <div><div class="af-label">BB OUT Port</div><div class="af-val">${esc(editItem.backbone_out_port_label || "-")}</div></div>
            </div>`;
          }
        }
        await auResolveBBOut(bbInWant, editItem.backbone_in_port_label);
      }
    }
  }
  // Fallback: if BB panels couldn't be matched but audit line has values,
  // pre-fill auState so existing data is preserved on save
  if (!bbMatched && (_bbInId || _bbOutId)) {
    if (_bbInId) {
      auState.bbInInstanceId = _bbInId;
      auState.bbInPortLabel = _bbInPt;
      const lbl = el("auBbInPortLabel");
      if (lbl && _bbInPt) {
        lbl.textContent = `Vorbelegt (Excel): ${_bbInId} / Port ${_bbInPt}`;
        lbl.style.display = "block";
      }
    }
    if (_bbOutId) {
      auState.bbOutInstanceId = _bbOutId;
      auState.bbOutPortLabel = _bbOutPt;
      const bboutEl = el("auBbOutResult");
      if (bboutEl) {
        bboutEl.style.display = "block";
        bboutEl.innerHTML = `<div class="af-grid">
          <div><div class="af-label">BB OUT Panel (Excel)</div><div class="af-val">${esc(_bbOutId)}</div></div>
          <div><div class="af-label">BB OUT Port (Excel)</div><div class="af-val">${esc(_bbOutPt || "-")}</div></div>
        </div>`;
      }
    }
  }
}

/* ══════════════════════════════════════
   SAVE AUDIT – persist + finalize
   ══════════════════════════════════════ */
async function saveAudit() {
  if (!isAdminRole()) { toast("Nur Admin darf speichern."); return; }
  if (!editId) return;

  const patchPayload = {
    switch_name:               (el("auSwitchName").value || "").trim() || null,
    switch_port:               (el("auSwitchPort").value || "").trim() || null,
    a_pp_number:               auState.aPPInstanceId || null,
    a_port_label:              auState.aPortLabel || null,
    z_pp_number:               (el("auZPP").value || "").trim() || null,
    z_port_label:              auState.zPortLabel || null,
    product_id:                (el("auProductId").value || "").trim() || null,
    serial_number:             (el("auSerial").value || "").trim() || null,
    backbone_in_instance_id:   auState.bbInInstanceId || null,
    backbone_in_port_label:    auState.bbInPortLabel || null,
    backbone_out_instance_id:  auState.bbOutInstanceId || null,
    backbone_out_port_label:   auState.bbOutPortLabel || null,
    tech_comment:              (el("auComment").value || "").trim() || null,
  };

  try {
    await apiJson(`${API}/migration-audit/${editId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patchPayload),
    });

    const username = localStorage.getItem('username') || sessionStorage.getItem('username') || 'unknown';
    await apiJson(`${API}/migration-audit/${editId}/audited`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ current_user: username }),
    });

    toast("Audit uebernommen.");

    currentStatus = "audited";
    document.querySelectorAll("#tabs button").forEach(b => b.classList.remove("active"));
    const tab = document.querySelector('#tabs button[data-status="audited"]');
    if (tab) tab.classList.add("active");
    await loadList();
    hideAuditModal();
  } catch (e) {
    toast(`Save Fehler: ${e.message}`);
  }
}

/* ══════════════════════════════════════
   EVENT BINDING
   ══════════════════════════════════════ */
function bindTabs() {
  document.querySelectorAll("#tabs button[data-status]").forEach(btn => {
    btn.addEventListener("click", async () => {
      document.querySelectorAll("#tabs button").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      currentStatus = btn.dataset.status;
      await loadList();
    });
  });
}

function bindCategoryToggles() {
  for (const cat of [0, 1, 2]) {
    const header = document.querySelector(`#catSection${cat} .audit-cat-header`);
    if (!header) continue;
    header.addEventListener("click", () => {
      catCollapsed[cat] = !catCollapsed[cat];
      _updateCatBodyState(cat);
      if (!catCollapsed[cat] && catItems[cat].length > 0) {
        _renderCatTable(cat);
        _renderCatPager(cat);
        _wireFilterUI();
      }
    });
  }
}

function bindFormEvents() {
  el("auSwitchName")?.addEventListener("input", auSwitchNameInput);
  el("auSwitchName")?.addEventListener("keydown", ev => {
    if (handleAutocompleteKey(ev, el("auSwitchNameList"))) return;
    if (ev.key === "Enter") { ev.preventDefault(); auResolveAside(); }
  });
  el("auSwitchName")?.addEventListener("blur", () =>
    setTimeout(() => el("auSwitchNameList")?.classList.remove("show"), 200)
  );

  el("auSwitchPort")?.addEventListener("input", auSwitchPortInput);
  el("auSwitchPort")?.addEventListener("keydown", ev => {
    if (handleAutocompleteKey(ev, el("auSwitchPortList"))) return;
    if (ev.key === "Enter") { ev.preventDefault(); auResolveAside(); }
  });
  el("auSwitchPort")?.addEventListener("blur", () => {
    setTimeout(() => el("auSwitchPortList")?.classList.remove("show"), 200);
    auResolveAside();
  });

  el("auZPP")?.addEventListener("input", auZPPInput);
  el("auZPP")?.addEventListener("blur", () => setTimeout(() => auZPPBlur(), 250));
  el("auZPP")?.addEventListener("keydown", ev => {
    handleAutocompleteKey(ev, el("auZPPList"));
  });

  el("btnSaveAudit")?.addEventListener("click", saveAudit);
  el("btnAuditClose")?.addEventListener("click", hideAuditModal);

  el("auditEditBg")?.addEventListener("click", ev => {
    if (ev.target.id === "auditEditBg") hideAuditModal();
  });
}

document.addEventListener("DOMContentLoaded", () => {
  bindTabs();
  bindCategoryToggles();
  bindFormEvents();
  el("btnImport")?.addEventListener("click", importXlsb);
  el("btnImportZside")?.addEventListener("click", importZside);
  el("btnReload")?.addEventListener("click", () => loadList());

  // View toggle: current state vs. all history
  document.querySelectorAll('#viewToggle button[data-view]').forEach(btn => {
    btn.addEventListener('click', () => {
      currentView = btn.dataset.view;
      document.querySelectorAll('#viewToggle button[data-view]').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      loadList();
    });
  });

  loadList().catch(err => toast(err.message));
  loadZsideStatus();
});
