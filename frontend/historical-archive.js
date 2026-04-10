/* ================================================================
   Leitungsarchiv – Historische CSV-Leitungen (Read-Only)
   ================================================================ */

const API_HL = `${window.API_ROOT || ""}/historical-lines`;

const $ = (id) => document.getElementById(id);

/* ── helpers ── */

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

/* ── state ── */

const state = {
  items: [],
  total: 0,
  page: 1,
  pages: 1,
  pageSize: 50,
  expanded: new Set(),
};

/* ── detail row ── */

function detailHtml(item) {
  function f(label, val) {
    return `<div class="detail-item"><div class="detail-label">${esc(label)}</div><div class="detail-value">${esc(val || "-")}</div></div>`;
  }
  function fw(label, val) {
    return `<div class="detail-item full-width"><div class="detail-label">${esc(label)}</div><div class="detail-value">${esc(val || "-")}</div></div>`;
  }
  return `<div class="detail-grid">
    ${f("Serial", item.serial)}
    ${f("Product ID", item.product_id)}
    ${f("Kunde", item.customer_name)}
    ${f("System Name", item.system_name)}
    ${f("Logical Name", item.logical_name)}
    ${f("Trunk No", item.trunk_no)}
    ${f("Loc A Room", item.location_a)}
    ${f("RFRA Ports", item.rfra_ports)}
    ${f("PP A", item.pp_a)}
    ${f("Port A", item.port_a)}
    ${f("EQX Port A", item.eqx_port_a)}
    ${f("PP 1", item.pp_1)}
    ${f("Port 1", item.port_1)}
    ${f("EQX Port 1", item.eqx_port_1)}
    ${f("PP 2", item.pp_2)}
    ${f("Port 2", item.port_2)}
    ${f("EQX Port 2", item.eqx_port_2)}
    ${f("PP Z", item.pp_z)}
    ${f("Port Z", item.port_z)}
    ${f("EQX Port Z", item.eqx_port_z)}
    ${f("Sales Order", item.sales_order)}
    ${f("Looptest", item.looptest_successful)}
    ${f("Ersteller", item.created_by)}
    ${f("Installationsdatum", item.installation_date)}
    ${f("Active Line", item.active_line)}
    ${fw("Interne Infos", item.internal_infos_ops)}
    ${f("Importdatei", item.source_filename)}
    ${f("Importiert am", item.imported_at ? new Date(item.imported_at).toLocaleString("de-DE") : "-")}
    ${f("Importiert von", item.imported_by)}
  </div>`;
}

/* ── render table ── */

function renderRows() {
  const body = $("hlTableBody");
  const empty = $("emptyState");
  if (!body) return;
  body.innerHTML = "";

  if (!state.items.length) {
    if (empty) {
      empty.hidden = false;
      empty.textContent = "Keine historischen Leitungen gefunden.";
    }
    return;
  }
  if (empty) empty.hidden = true;

  for (const item of state.items) {
    const id = item.id;
    const isOpen = state.expanded.has(id);

    const tr = document.createElement("tr");
    tr.className = "data-row";
    tr.style.cursor = "pointer";
    tr.dataset.id = id;
    tr.innerHTML = `
      <td><span class="expand-btn${isOpen ? " open" : ""}" data-toggle="${id}">&#9654;</span></td>
      <td class="col-serial mono">${esc(item.serial || "-")}</td>
      <td class="mono">${esc(item.product_id || "-")}</td>
      <td class="col-kunde">${esc(item.customer_name || "-")}</td>
      <td class="mono">${esc(item.rfra_ports || "-")}</td>
      <td class="col-pp mono">${esc(item.pp_a || "-")}</td>
      <td class="col-pp mono">${esc(item.pp_1 || "-")}</td>
      <td class="col-pp mono">${esc(item.pp_2 || "-")}</td>
      <td class="col-pp mono">${esc(item.pp_z || "-")}</td>
      <td>${esc(item.logical_name || "-")}</td>
    `;
    body.appendChild(tr);

    if (isOpen) {
      const dr = document.createElement("tr");
      dr.className = "detail-row";
      dr.dataset.detailFor = id;
      dr.innerHTML = `<td colspan="10">${detailHtml(item)}</td>`;
      body.appendChild(dr);
    }
  }
}

/* ── pagination ── */

function updatePager() {
  const s = $("statShown");
  const t = $("statTotal");
  const sp = $("statPage");
  const sps = $("statPages");
  const pn = $("pageNum");
  const pc = $("pageCount");

  if (s) s.textContent = String(state.items.length);
  if (t) t.textContent = String(state.total);
  if (sp) sp.textContent = String(state.page);
  if (sps) sps.textContent = String(state.pages);
  if (pn) pn.textContent = String(state.page);
  if (pc) pc.textContent = String(state.pages);

  const first = $("btnFirst");
  const prev = $("btnPrev");
  const next = $("btnNext");
  const last = $("btnLast");
  if (first) first.disabled = state.page <= 1;
  if (prev) prev.disabled = state.page <= 1;
  if (next) next.disabled = state.page >= state.pages;
  if (last) last.disabled = state.page >= state.pages;
}

/* ── build query ── */

function buildQuery(page) {
  const search = ($("searchInput")?.value || "").trim();
  const serialFilter = $("serialFilter")?.value || "";
  const customer = ($("filterCustomer")?.value || "").trim();
  const pp = ($("filterPP")?.value || "").trim();

  let qs = `?page=${page}&page_size=${state.pageSize}`;
  if (search) qs += `&q=${encodeURIComponent(search)}`;
  if (serialFilter) qs += `&serial_filter=${encodeURIComponent(serialFilter)}`;
  if (customer) qs += `&customer=${encodeURIComponent(customer)}`;
  if (pp) qs += `&pp=${encodeURIComponent(pp)}`;
  return `${API_HL}/list${qs}`;
}

/* ── load data ── */

async function loadList(page = 1) {
  setStatus("Lade historische Leitungen...", true);
  try {
    const res = await fetch(buildQuery(page));
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.detail || `HTTP ${res.status}`);
    state.items = Array.isArray(data.items) ? data.items : [];
    state.total = Number(data.total || 0);
    state.page = Number(data.page || 1);
    state.pages = Number(data.pages || 1);
    state.expanded.clear();
    renderRows();
    updatePager();
    setStatus(`Geladen: ${state.items.length} von ${state.total}`);
  } catch (err) {
    state.items = [];
    state.total = 0;
    state.page = 1;
    state.pages = 1;
    renderRows();
    updatePager();
    setStatus(`Fehler: ${err.message}`);
    toast(`Laden fehlgeschlagen: ${err.message}`, "error");
  }
}

/* ── expand / collapse ── */

function toggleExpand(id) {
  if (state.expanded.has(id)) state.expanded.delete(id);
  else state.expanded.add(id);
  renderRows();
}

/* ── CSV import ── */

async function doImport() {
  const fileInput = $("csvFile");
  const resultDiv = $("importResult");
  if (!fileInput?.files?.length) {
    toast("Keine Datei ausgewaehlt", "warn");
    return;
  }
  const file = fileInput.files[0];
  const form = new FormData();
  form.append("file", file);

  resultDiv.innerHTML = '<div class="import-result" style="color:var(--muted,#999);">Importiere...</div>';
  $("btnImport").disabled = true;

  try {
    const res = await fetch(`${API_HL}/import`, { method: "POST", body: form });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.detail || `HTTP ${res.status}`);

    let html = `<div class="import-result success">`;
    html += `<strong>Import erfolgreich!</strong><br>`;
    html += `Importiert: <strong>${data.imported}</strong> Zeilen`;
    if (data.mapped_columns) html += ` (${data.mapped_columns} Spalten erkannt)`;
    html += `<br>`;
    if (data.warnings_count > 0) html += `Warnungen: ${data.warnings_count}<br>`;
    if (data.errors_count > 0) html += `Fehler: ${data.errors_count}<br>`;
    if (data.warnings?.length) {
      html += `<br><details><summary>Warnungen anzeigen</summary><pre style="font-size:.78rem;max-height:200px;overflow:auto;">${esc(data.warnings.join("\n"))}</pre></details>`;
    }
    if (data.errors?.length) {
      html += `<br><details><summary>Fehler anzeigen</summary><pre style="font-size:.78rem;max-height:200px;overflow:auto;">${esc(data.errors.join("\n"))}</pre></details>`;
    }
    html += `</div>`;
    resultDiv.innerHTML = html;
    toast(`${data.imported} Zeilen importiert`, "success");

    // Reset file input
    fileInput.value = "";
    $("fileName").textContent = "";
    $("btnImport").disabled = true;

    // Reload list on search tab
    loadList(1);
    // Reload batches
    loadBatches();
  } catch (err) {
    resultDiv.innerHTML = `<div class="import-result error">Import fehlgeschlagen: ${esc(err.message)}</div>`;
    toast(`Import fehlgeschlagen: ${err.message}`, "error");
    $("btnImport").disabled = false;
  }
}

/* ── batches ── */

async function loadBatches() {
  const container = $("batchList");
  if (!container) return;
  container.innerHTML = '<div style="text-align:center;padding:20px;color:var(--muted,#999);">Lade...</div>';

  try {
    const res = await fetch(`${API_HL}/batches`);
    const data = await res.json().catch(() => []);
    if (!res.ok) throw new Error("Fehler beim Laden");

    if (!data.length) {
      container.innerHTML = '<div style="text-align:center;padding:20px;color:var(--muted,#999);">Noch keine Importe vorhanden.</div>';
      return;
    }

    container.innerHTML = data
      .map(
        (b) => `
      <div class="batch-item" data-batch="${esc(b.import_batch_id)}">
        <div class="batch-meta">
          <span>&#128196; <span class="val">${esc(b.source_filename || "unbekannt")}</span></span>
          <span>${esc(b.row_count)} Zeilen</span>
          <span>von ${esc(b.imported_by || "-")}</span>
          <span>${b.imported_at ? new Date(b.imported_at).toLocaleString("de-DE") : "-"}</span>
        </div>
        <button class="btn-del-batch" data-del-batch="${esc(b.import_batch_id)}" title="Diesen Import loeschen">Loeschen</button>
      </div>
    `
      )
      .join("");
  } catch (err) {
    container.innerHTML = `<div style="text-align:center;padding:20px;color:var(--muted,#999);">Fehler: ${esc(err.message)}</div>`;
  }
}

async function deleteBatch(batchId) {
  if (!confirm(`Import "${batchId}" wirklich loeschen? Alle zugehoerigen Datensaetze werden entfernt.`)) return;
  try {
    const res = await fetch(`${API_HL}/batch/${encodeURIComponent(batchId)}`, { method: "DELETE" });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.detail || `HTTP ${res.status}`);
    toast(`${data.deleted} Datensaetze geloescht`, "success");
    loadBatches();
    loadList(1);
  } catch (err) {
    toast(`Loeschen fehlgeschlagen: ${err.message}`, "error");
  }
}

/* ── CSV export ── */

function doExport() {
  const search = ($("searchInput")?.value || "").trim();
  const serialFilter = $("serialFilter")?.value || "";
  const customer = ($("filterCustomer")?.value || "").trim();
  const pp = ($("filterPP")?.value || "").trim();

  let qs = "?";
  if (search) qs += `q=${encodeURIComponent(search)}&`;
  if (serialFilter) qs += `serial_filter=${encodeURIComponent(serialFilter)}&`;
  if (customer) qs += `customer=${encodeURIComponent(customer)}&`;
  if (pp) qs += `pp=${encodeURIComponent(pp)}&`;

  window.open(`${API_HL}/export${qs}`, "_blank");
}

/* ── tabs ── */

function switchTab(tabName) {
  document.querySelectorAll(".tab-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.tab === tabName);
  });
  $("tabSearch").classList.toggle("active", tabName === "search");
  $("tabImport").classList.toggle("active", tabName === "import");
  $("tabBatches").classList.toggle("active", tabName === "batches");

  if (tabName === "batches") loadBatches();
}

/* ── init ── */

document.addEventListener("DOMContentLoaded", () => {
  /* tabs */
  document.querySelectorAll(".tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => switchTab(btn.dataset.tab));
  });

  /* search */
  $("btnSearch")?.addEventListener("click", () => loadList(1));
  $("btnRefresh")?.addEventListener("click", () => loadList(1));
  $("searchInput")?.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") {
      ev.preventDefault();
      loadList(1);
    }
  });
  $("serialFilter")?.addEventListener("change", () => loadList(1));

  /* pagination */
  $("btnFirst")?.addEventListener("click", () => loadList(1));
  $("btnPrev")?.addEventListener("click", () => {
    if (state.page > 1) loadList(state.page - 1);
  });
  $("btnNext")?.addEventListener("click", () => {
    if (state.page < state.pages) loadList(state.page + 1);
  });
  $("btnLast")?.addEventListener("click", () => loadList(state.pages));

  /* expand toggle */
  $("hlTableBody")?.addEventListener("click", (ev) => {
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

  /* export */
  $("btnExport")?.addEventListener("click", doExport);

  /* CSV file selection */
  const csvFile = $("csvFile");
  csvFile?.addEventListener("change", () => {
    const name = csvFile.files?.[0]?.name || "";
    $("fileName").textContent = name ? `Ausgewaehlt: ${name}` : "";
    $("btnImport").disabled = !name;
  });

  /* Drag & Drop */
  const dropZone = $("dropZone");
  if (dropZone) {
    dropZone.addEventListener("dragover", (ev) => {
      ev.preventDefault();
      dropZone.classList.add("drag-over");
    });
    dropZone.addEventListener("dragleave", () => {
      dropZone.classList.remove("drag-over");
    });
    dropZone.addEventListener("drop", (ev) => {
      ev.preventDefault();
      dropZone.classList.remove("drag-over");
      if (ev.dataTransfer?.files?.length) {
        csvFile.files = ev.dataTransfer.files;
        csvFile.dispatchEvent(new Event("change"));
      }
    });
  }

  /* Import button */
  $("btnImport")?.addEventListener("click", doImport);

  /* Delete batch (delegated) */
  $("batchList")?.addEventListener("click", (ev) => {
    const btn = ev.target.closest("[data-del-batch]");
    if (btn) deleteBatch(btn.dataset.delBatch);
  });

  /* Load initial data */
  loadList(1);
});
