// kw-jobs.js
const API = window.API_IMPORT || "http://127.0.0.1:8000";

const el = (id) => document.getElementById(id);

function escapeHtml(v) {
  return String(v ?? "").replace(/[&<>"]/g, (m) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;"
  }[m]));
}

function fmtDt(dt) {
  if (!dt) return "—";
  try {
    const d = new Date(dt);
    return d.toLocaleString();
  } catch { return String(dt); }
}

function render(items) {
  if (!items || items.length === 0) {
    el("jobsWrap").innerHTML = '<div class="muted">Keine Jobs vorhanden. Erstelle einen Job über Import/Export → "Import übernehmen".</div>';
    return;
  }

  const rows = items.map(j => {
    const title = `KW ${escapeHtml(j.kw)} · ${escapeHtml(j.mode)}`;
    const file = escapeHtml(j.file_name || "—");
    return `
      <tr>
        <td><span class="job-pill">${title}</span></td>
        <td>${file}</td>
        <td>${fmtDt(j.created_at)}</td>
        <td>${j.total ?? 0}</td>
        <td>${j.planned ?? 0}</td>
        <td>${j.review ?? 0}</td>
        <td>${j.in_progress ?? 0}</td>
        <td>${j.done ?? 0}</td>
        <td>${j.pending_serial ?? 0}</td>
        <td>${j.active ?? 0}</td>
        <td class="job-actions">
          <button class="primary" onclick="window.location.href='kw-job-detail.html?job_id=${encodeURIComponent(String(j.id))}'">Öffnen</button>
        </td>
      </tr>
    `;
  }).join("");

  el("jobsWrap").innerHTML = `
    <table class="job-table">
      <thead>
        <tr>
          <th>KW / Modus</th>
          <th>Datei</th>
          <th>Erstellt</th>
          <th>Total</th>
          <th>Planned</th>
          <th>Review</th>
          <th>In Progress</th>
          <th>Done</th>
          <th>Pending Serial</th>
          <th>Active</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        ${rows}
      </tbody>
    </table>
  `;
}

async function loadJobs() {
  el("jobsWrap").innerHTML = '<div class="muted">Lade Jobs...</div>';
  const res = await fetch(`${API}/api/v1/jobs`);
  const data = await res.json();
  render(data.items || []);
}

el("btnReload").addEventListener("click", loadJobs);
loadJobs();
