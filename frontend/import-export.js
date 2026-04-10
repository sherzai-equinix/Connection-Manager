// import-export.js
// ✅ Wichtig: setz in config.js -> window.API_IMPORT = "http://127.0.0.1:8000";
const IMPORT_BASE = window.API_IMPORT || "http://127.0.0.1:8000";

const el = (id) => document.getElementById(id);

let onlyErrors = false;
let lastData = null;

function setEnabled() {
  const hasFile = el("file").files && el("file").files.length > 0;
  el("btnPreview").disabled = !hasFile;
  // Commit erst nach erfolgreicher Preview (ohne Errors)
  const canCommit = !!hasFile && !!lastData && ((lastData?.counts?.error ?? 0) === 0) && ((lastData?.counts?.ok ?? 0) > 0);
  if (el("btnCommit")) el("btnCommit").disabled = !canCommit;
}

function pill(id, text, cls = "") {
  const e = el(id);
  e.textContent = text;
  e.className = "pill " + cls;
}

function escapeHtml(v) {
  return String(v ?? "").replace(/[&<>"']/g, (m) => ({
    "&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#039;"
  }[m]));
}

function normStatus(v) {
  const s = String(v || "").toUpperCase().trim();
  if (s === "OK" || s === "WARN" || s === "ERROR") return s;
  return "ERROR";
}

function renderSummary(counts) {
  el("summary").style.display = "flex";
  pill("pillTotal", `Total: ${counts.total ?? 0}`);
  pill("pillOk", `OK: ${counts.ok ?? 0}`, "ok");
  pill("pillWarn", `WARN: ${counts.warn ?? 0}`, "warn");
  pill("pillErr", `ERROR: ${counts.error ?? 0}`, "err");
}

function buildSteps(r) {
  // A-Side
  const a = `${r.a_pp ?? "—"} • ${r.a_port ?? "—"}`;

  // Backbone
  const bbIn = `${r.bb_in_pp ?? "—"} • ${r.bb_in_port ?? "—"}`;
  const bbOut = `${r.bb_out_pp ?? "—"} • ${r.bb_out_port ?? "—"}`;

  // ✅ Z-Side IMMER aus Excel Eingabe (niemals router_port!)
  const zPP = r.z_pp_number ?? "—";
  const zPortExcel = r.z_port_label ?? "—";
  const zRoom = r.z_room ?? "—";

  const zText = `Z-Side PP ${zPP} • Port ${zPortExcel} (Room: ${zRoom})`;

  return {
    patch1: `Patch 1: A-Side (Precable) ${a}  ->  BB IN ${bbIn}`,
    patch2: `Patch 2: BB OUT ${bbOut}  ->  ${zText}`,
    text: `Patch 1: A-Side (Precable) ${a}  ->  BB IN ${bbIn}\nPatch 2: BB OUT ${bbOut}  ->  ${zText}`
  };
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (e) {
    console.warn("Clipboard failed:", e);
    return false;
  }
}

function renderList(rows) {
  const list = el("list");
  list.innerHTML = "";

  const all = Array.isArray(rows) ? rows : [];
  const filtered = onlyErrors ? all.filter(r => normStatus(r.status) === "ERROR") : all;

  if (!filtered.length) {
    list.innerHTML = `<div class="lead"><div class="leadTitle">Keine Zeilen (oder Filter aktiv).</div></div>`;
    return;
  }

  filtered.forEach((r, idx) => {
    const status = normStatus(r.status);
    const msg = r.message || "";

    // ✅ Product ID ist das wichtigste (so wie du willst)
    const productId = r.product_id ?? "-";

    // Excel/basic
    const routerPort = r.router_port || "-";
    const customerName = r.customer_name || "-";
    const excelRow = r._excel_row ?? r.row_index ?? "-";

    // A-side (precable)
    const aPP = r.a_pp ?? "—";
    const aPort = r.a_port ?? "—";
    const aRoom = r.a_room ?? "—";

    // Backbone
    const bbInPP = r.bb_in_pp ?? "—";
    const bbInPort = r.bb_in_port ?? "—";
    const bbOutPP = r.bb_out_pp ?? "—";
    const bbOutPort = r.bb_out_port ?? "—";

    // ✅ Z-side: IMMER Excel Values anzeigen, auch wenn Backend ERROR hat
    const zPP = r.z_pp_number ?? "—";
    const zPort = r.z_port_label ?? "—";
    const zRoom = r.z_room ?? "—";

    const steps = buildSteps(r);
    const leadNo = idx + 1;

    const html = `
      <div class="lead" data-lead>
        <div class="leadTop">
          <div>
            <div class="leadTitle">Leitung ${leadNo} • Product ID ${escapeHtml(productId)}</div>
            <div class="leadMeta">
              Router Port: <b>${escapeHtml(routerPort)}</b>
              • Customer: <b>${escapeHtml(customerName)}</b>
              • Excel Row: ${escapeHtml(excelRow)}
            </div>
          </div>

          <div style="display:flex; gap:10px; align-items:center;">
            <button class="btn ghost" data-copy>Copy Steps</button>
            <div class="badgeStatus ${status}">${status}</div>
          </div>
        </div>

        <!-- 5-box schema (Router | A-Side | BB IN | BB OUT | Z-Side) -->
        <div class="schema" style="grid-template-columns: 1.15fr 1.1fr 1fr 1fr 1.25fr;">
          <div class="box">
            <div class="boxLabel">Router (Excel)</div>
            <div class="boxValue">${escapeHtml(routerPort)}</div>
            <div class="boxSub">Product ID: ${escapeHtml(productId)}</div>
          </div>

          <div class="box">
            <div class="boxLabel">A-Side Precable (PP/Port)</div>
            <div class="boxValue">${escapeHtml(aPP)} • ${escapeHtml(aPort)}</div>
            <div class="boxSub">Room: ${escapeHtml(aRoom)}</div>
          </div>

          <div class="box">
            <div class="boxLabel">Backbone IN</div>
            <div class="boxValue">${escapeHtml(bbInPP)} • ${escapeHtml(bbInPort)}</div>
            <div class="boxSub">${escapeHtml(steps.patch1)}</div>
          </div>

          <div class="box">
            <div class="boxLabel">Backbone OUT</div>
            <div class="boxValue">${escapeHtml(bbOutPP)} • ${escapeHtml(bbOutPort)}</div>
            <div class="boxSub">${escapeHtml(steps.patch2)}</div>
          </div>

          <div class="box">
            <div class="boxLabel">Z-Side Kunde (PP/Port)</div>
            <div class="boxValue">PP ${escapeHtml(zPP)} • Port ${escapeHtml(zPort)}</div>
            <div class="boxSub">Room: ${escapeHtml(zRoom)}</div>
          </div>
        </div>

        ${msg ? `<div class="errorText">${escapeHtml(msg)}</div>` : ``}

        <textarea data-steps style="position:absolute; left:-9999px; top:-9999px;">${escapeHtml(steps.text)}</textarea>
      </div>
    `;

    list.insertAdjacentHTML("beforeend", html);
  });

  list.querySelectorAll("[data-lead] [data-copy]").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      const lead = e.target.closest("[data-lead]");
      const ta = lead?.querySelector("[data-steps]");
      const text = ta?.value || "";
      const ok = await copyText(text);

      if (ok) {
        const old = btn.textContent;
        btn.textContent = "Copied!";
        setTimeout(() => (btn.textContent = old), 900);
      } else {
        alert("Copy geht nicht (Browser). Bitte Steps manuell kopieren.");
      }
    });
  });
}

function collectMissingPps(rows) {
  const missing = (rows || [])
    .filter(r => String(r.message || "").includes("Z-PP nicht gefunden"))
    .map(r => r.z_pp_number)
    .filter(Boolean);

  const uniq = [...new Set(missing.map(String))];
  if (uniq.length) console.log("✅ Missing pp_numbers (HU/PP Z):", uniq.join(", "));
  else console.log("✅ Missing pp_numbers: none");
}

async function preview() {
  const kw = parseInt(el("kw").value || "0", 10);
  const mode = (el("mode")?.value || "install");
  const file = el("file").files?.[0];
  if (!file) return;

  const fd = new FormData();
  fd.append("kw", String(kw));
  fd.append("mode", String(mode));
  fd.append("file", file);

  el("btnPreview").disabled = true;
  el("btnPreview").textContent = "Prüfe...";

  try {
    const res = await fetch(`${IMPORT_BASE}/import/preview`, { method: "POST", body: fd });

    if (!res.ok) {
      const txt = await res.text();
      throw new Error(txt);
    }

    const data = await res.json();
    lastData = data;

    renderSummary(data.counts || { total: 0, ok: 0, warn: 0, error: 0 });
    renderList(data.rows || []);
    collectMissingPps(data.rows || []);

    el("hint").innerHTML = `Preview fertig. <b>OK</b> = bereit, <b>ERROR</b> = fehlt etwas (PP/Port/etc.).`;
    el("btnOnlyErrors").disabled = false;
    // Commit Button ggf. aktivieren
    setEnabled();

  } catch (e) {
    console.error(e);
    alert("Preview Fehler:\n" + (e?.message || e));
  } finally {
    el("btnPreview").disabled = false;
    el("btnPreview").textContent = "Import prüfen";
  }
}

async function commitImport() {
  if (!(window.isAdminRole && window.isAdminRole())) {
    alert("Nur Admin darf committen.");
    return;
  }
  const kw = parseInt(el("kw").value || "0", 10);
  const mode = (el("mode")?.value || "install");
  const file = el("file").files?.[0];
  if (!file) return;

  if (!lastData) {
    alert("Bitte zuerst \"Import prüfen\" ausführen.");
    return;
  }
  if ((lastData?.counts?.error ?? 0) > 0) {
    alert("Commit nicht möglich: Preview enthält Errors.");
    return;
  }

  if (!confirm(`Import übernehmen?\n\nKW: ${kw}\nModus: ${mode}\nOK: ${lastData?.counts?.ok ?? 0}`)) {
    return;
  }

  const fd = new FormData();
  fd.append("kw", String(kw));
  fd.append("mode", String(mode));
  fd.append("file", file);

  el("btnCommit").disabled = true;
  el("btnCommit").textContent = "Übernehme...";

  try {
    const res = await fetch(`${IMPORT_BASE}/import/commit`, { method: "POST", body: fd });
    if (!res.ok) {
      const txt = await res.text();
      throw new Error(txt);
    }
    const data = await res.json();
    // Direkt in KW-Detail springen
    if (data?.job_id) {
      window.location.href = `kw-job-detail.html?job_id=${encodeURIComponent(String(data.job_id))}`;
      return;
    }
    alert("Commit erfolgreich.");
  } catch (e) {
    console.error(e);
    alert("Commit Fehler:\n" + (e?.message || e));
  } finally {
    el("btnCommit").disabled = false;
    el("btnCommit").textContent = "Import übernehmen";
  }
}

function showHelp() {
  alert(
`So funktioniert's:

1) KW setzen
2) Excel hochladen
3) "Import prüfen"

Was du siehst:
- Router (Excel) | A-Side Precable | BB IN | BB OUT | Z-Side Kunde
- Product ID ist immer oben (wichtigste Info)

Tipps:
- "Nur ERROR" zeigt nur Fehler-Zeilen.
- Console zeigt Missing pp_numbers (HU/PP Z).
- "Copy Steps" kopiert beide Patch-Schritte.`
  );
}

el("file").addEventListener("change", setEnabled);
el("btnPreview").addEventListener("click", preview);
if (el("btnCommit")) el("btnCommit").addEventListener("click", commitImport);
el("btnHelp").addEventListener("click", showHelp);

el("btnOnlyErrors").addEventListener("click", () => {
  onlyErrors = !onlyErrors;
  el("btnOnlyErrors").textContent = onlyErrors ? "Alle anzeigen" : "Nur ERROR";
  el("btnOnlyErrors").classList.toggle("active", onlyErrors);
  if (lastData) renderList(lastData.rows || []);
});

setEnabled();
