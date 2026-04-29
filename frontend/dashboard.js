const API_DASHBOARD = String(window.API_DASHBOARD || "").replace(/\/+$/, "");
const $ = id => document.getElementById(id);

function esc(v) {
  return String(v ?? "").replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;").replaceAll("'","&#039;");
}
function toast(msg, type = "info") {
  const w = $("toastWrap"); if (!w) return;
  const el = document.createElement("div"); el.className = `toast ${type}`; el.textContent = msg;
  w.appendChild(el); setTimeout(() => el.remove(), 3400);
}
function setStatus(msg, loading = false) {
  const b = $("dashboardStatus"); if (!b) return;
  b.innerHTML = loading ? `<span class="spinner"></span> ${esc(msg)}` : esc(msg);
}

/* ═══════════════════════════════════════════
   ANIMATED NUMBER COUNT-UP
   ═══════════════════════════════════════════ */
function animateValue(el, end, duration = 600) {
  const start = parseInt(el.textContent) || 0;
  if (start === end) return;
  const range = end - start;
  const startTime = performance.now();
  function step(now) {
    const t = Math.min((now - startTime) / duration, 1);
    const ease = 1 - Math.pow(1 - t, 3); // easeOutCubic
    el.textContent = Math.round(start + range * ease);
    if (t < 1) requestAnimationFrame(step);
    else { el.textContent = end; el.classList.add("pop"); setTimeout(() => el.classList.remove("pop"), 350); }
  }
  requestAnimationFrame(step);
}

/* ═══════════════════════════════════════════
   STAT CARDS — centered icon + big number
   ═══════════════════════════════════════════ */
function cardHtml(icon, iconBg, label, value, hint, target, id) {
  return `<a class="dash-card" href="${esc(target || '#')}">
    <div class="dash-card-icon" style="background:${iconBg}">${icon}</div>
    <div class="dash-card-val" data-counter="${id}">${esc(value)}</div>
    <div class="dash-card-label">${esc(label)}</div>
    <div class="dash-card-hint">${esc(hint || '')}</div>
  </a>`;
}

function render(stats, tsCount = 0) {
  const grid = $("dashboardGrid"); if (!grid) return;
  const kwInfo = stats.current_kw || {};
  const kwLabel = kwInfo.year && kwInfo.kw ? `${kwInfo.year}-KW${String(kwInfo.kw).padStart(2,"0")}` : "-";
  const kwPending = stats.current_kw_pending_tasks || 0;

  /* Hero KW bar */
  const strip = $("kwStrip");
  if (strip) {
    strip.style.display = "flex";
    const lbl = $("kwStripLabel"); if (lbl) lbl.textContent = kwLabel;
    const kwTotal = (stats.kw_install||0)+(stats.kw_deinstall||0)+(stats.kw_linemove||0)+(stats.kw_pathmove||0);
    const kwDone = stats.kw_done || 0;
    const pct = kwTotal > 0 ? Math.round(kwDone / kwTotal * 100) : 0;
    const bar = $("kwStripBar");
    if (bar) setTimeout(() => bar.style.width = `${pct}%`, 100); // delay for animation
    const pctEl = $("kwStripPct");
    if (pctEl) pctEl.textContent = kwTotal > 0 ? `${kwDone}/${kwTotal} (${pct}%)` : `${kwPending} offen`;
  }

  const vals = {
    lines: stats.active_lines || 0,
    install: stats.pending_install || 0,
    deinstall: stats.pending_deinstall || 0,
    move: stats.pending_move || 0,
    pathmove: stats.pending_path_move || 0,
    kw: kwPending,
  };

  const cards = [
    cardHtml("&#128279;","rgba(102,187,106,.15)","Active Lines",vals.lines,"Aktive Leitungen","cross-connects.html?status=active","lines"),
    cardHtml("&#10133;","rgba(79,195,247,.15)","Install",vals.install,"Offene Neuinstall","kw-planning.html","install"),
    cardHtml("&#128465;","rgba(239,83,80,.15)","Deinstall",vals.deinstall,"Offene Rueckbauten","kw-planning.html","deinstall"),
    cardHtml("&#8596;","rgba(255,183,77,.15)","Line Move",vals.move,"Offene Line Moves","kw-planning.html","move"),
    cardHtml("&#8644;","rgba(171,71,188,.15)","Path Move",vals.pathmove,"Offene Path Moves","kw-planning.html","pathmove"),
    cardHtml("&#128197;","rgba(253,216,53,.15)","KW Offen",vals.kw,kwLabel,"kw-planning.html","kw"),
  ];

  if (tsCount > 0) {
    vals.troubleshooting = tsCount;
    cards.push(
      cardHtml("&#128295;","rgba(239,83,80,.15)","Troubleshooting",tsCount,"Offene TS Aufgaben","troubleshooting.html","troubleshooting")
    );
  }

  grid.innerHTML = cards.join("");

  // Animate the numbers
  requestAnimationFrame(() => {
    for (const [key, val] of Object.entries(vals)) {
      const el = document.querySelector(`[data-counter="${key}"]`);
      if (el) animateValue(el, val, 700);
    }
  });
}

async function getTroubleshootingCount() {
  try {
    const apiTs = String(window.API_TROUBLESHOOTING || (window.API_ROOT || '') + '/troubleshooting').replace(/\/+$/, '');
    const res = await fetch(`${apiTs}/worklines`);
    const data = await res.json().catch(() => ({}));
    return res.ok && Array.isArray(data.items) ? data.items.length : 0;
  } catch (e) {
    return 0;
  }
}

async function loadDashboard() {
  setStatus("Laden...", true);
  try {
    const [statsRes, tsCount] = await Promise.all([
      fetch(`${API_DASHBOARD}/stats`),
      getTroubleshootingCount(),
    ]);
    const data = await statsRes.json().catch(() => ({}));
    if (!statsRes.ok) throw new Error(data?.detail || `HTTP ${statsRes.status}`);
    render(data.stats || {}, tsCount); setStatus("");
    // Update Troubleshooting sidebar widget
    const tsWidget = $("tsWidget");
    const tsWidgetCount = $("tsWidgetCount");
    const tsWidgetBody = $("tsWidgetBody");
    if (tsWidget) {
      if (tsCount > 0) {
        tsWidget.style.display = "block";
        if (tsWidgetCount) tsWidgetCount.textContent = tsCount;
        if (tsWidgetBody) tsWidgetBody.textContent = `${tsCount} Leitung${tsCount > 1 ? 'en' : ''} in Bearbeitung`;
      } else {
        tsWidget.style.display = "none";
      }
    }
  } catch (e) { setStatus(`Fehler: ${e.message}`); toast(e.message, "error"); }
}

/* ═══════════════════════════════════════════
   QUARTERLY — Tabbed view
   ═══════════════════════════════════════════ */
let lastQ = null;
let activeTab = "overview";

function initQuarterSelectors() {
  const yr = $("qYearSelect"); if (!yr) return;
  const now = new Date(), curYear = now.getFullYear();
  for (let y = curYear; y >= curYear - 3; y--) {
    const o = document.createElement("option"); o.value = y; o.textContent = y; yr.appendChild(o);
  }
  yr.value = curYear;
  const qs = $("qQuarterSelect");
  if (qs) qs.value = Math.floor(now.getMonth() / 3) + 1;
}

async function loadQuarterly() {
  const year = Number($("qYearSelect")?.value);
  const quarter = Number($("qQuarterSelect")?.value);
  const box = $("qBody"); if (!box) return;
  box.innerHTML = '<div style="padding:28px 0;text-align:center;display:flex;align-items:center;justify-content:center;gap:8px;opacity:.5;"><span class="spinner"></span>Laden...</div>';
  try {
    const res = await fetch(`${API_DASHBOARD}/quarterly?year=${year}&quarter=${quarter}`);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.detail || `HTTP ${res.status}`);
    lastQ = data;
    renderTab();
    updateFutureSidebar(data);
  } catch (e) { box.innerHTML = `<div style="color:#ef5350;padding:20px 0;text-align:center;">Fehler: ${esc(e.message)}</div>`; }
}

function switchTab(tab) {
  activeTab = tab;
  document.querySelectorAll(".q-tab").forEach(t => t.classList.toggle("active", t.dataset.tab === tab));
  if (lastQ) renderTab();
}

function renderTab() {
  const box = $("qBody"); if (!box || !lastQ) return;
  if (activeTab === "overview")       box.innerHTML = renderOverview(lastQ);
  else if (activeTab === "kwtable")   box.innerHTML = renderKwTable(lastQ);
  else if (activeTab === "leaderboard") box.innerHTML = renderLeaderboard(lastQ);
}

/* ── Future sidebar widget ── */
function updateFutureSidebar(data) {
  const el = $("futureQuickBody"); if (!el) return;
  const t = data.totals || {};
  const pct = (t.total_all||0) > 0 ? Math.round((t.total_done||0)/(t.total_all||0)*100) : 0;
  el.innerHTML = `
    <div style="display:flex;flex-direction:column;gap:6px;">
      <div style="display:flex;justify-content:space-between;font-size:.78rem;">
        <span style="color:var(--muted,#999);">Quartal</span>
        <span style="font-weight:700;">${esc(data.label||'-')}</span>
      </div>
      <div style="display:flex;justify-content:space-between;font-size:.78rem;">
        <span style="color:var(--muted,#999);">Erledigt</span>
        <span style="font-weight:700;color:#66bb6a;">${t.total_done||0} / ${t.total_all||0}</span>
      </div>
      <div style="height:6px;border-radius:4px;background:rgba(255,255,255,.06);overflow:hidden;margin-top:2px;">
        <div style="height:100%;border-radius:4px;width:${pct}%;background:linear-gradient(90deg,#3b82f6,#8b5cf6);transition:width .6s;"></div>
      </div>
      <div style="font-size:.68rem;color:var(--muted,#666);text-align:right;">${pct}% abgeschlossen</div>
    </div>`;
}

/* ── Trend arrows ── */
function trend(cur, prev) {
  const c = Number(cur)||0, p = Number(prev)||0;
  if (p === 0 && c === 0) return '';
  const d = c - p;
  if (d === 0) return '<span class="q-trend flat">&#8594; 0%</span>';
  const pct = p > 0 ? Math.round(Math.abs(d)/p*100) : 100;
  return d > 0
    ? `<span class="q-trend up">&#9650; ${pct}%</span>`
    : `<span class="q-trend down">&#9660; ${pct}%</span>`;
}

/* ── SVG Donut ── */
function donutSvg(slices, total) {
  if (total <= 0) return '';
  const size=120, cx=60, cy=60, r=46, sw=16, circ=2*Math.PI*r;
  let off=0, paths='';
  for (const s of slices) {
    if ((s.value||0) <= 0) continue;
    const dash = circ * s.value / total, gap = circ - dash;
    paths += `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${s.color}" stroke-width="${sw}"
      stroke-dasharray="${dash.toFixed(1)} ${gap.toFixed(1)}" stroke-dashoffset="${(-off).toFixed(1)}"
      stroke-linecap="round" transform="rotate(-90 ${cx} ${cy})"
      style="transition:stroke-dasharray .7s ease,stroke-dashoffset .7s ease;"/>`;
    off += dash;
  }
  return `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">${paths}</svg>`;
}

/* ── TAB: Overview ── */
function renderOverview(data) {
  const t = data.totals || {}, pv = data.prev_quarter || {};
  const slices = [
    {value:t.install||0, color:"#4fc3f7", label:"Install"},
    {value:t.deinstall||0, color:"#ef5350", label:"Deinstall"},
    {value:t.linemove||0, color:"#ffb74d", label:"Line Move"},
    {value:t.pathmove||0, color:"#ab47bc", label:"Path Move"},
  ];
  const done = slices.reduce((s,x)=>s+x.value,0);

  let h = `<div class="q-chart-row">`;
  h += `<div class="q-donut-wrap">${donutSvg(slices, done||1)}
    <div class="q-donut-center"><div class="big">${t.total_done||0}</div><div class="sub">Erledigt</div></div></div>`;
  h += `<div class="q-legend">`;
  for (const s of slices) h += `<div class="q-legend-item"><span class="q-legend-dot" style="background:${s.color}"></span><span>${s.label}</span><span class="q-legend-val">${s.value}</span></div>`;
  h += `</div></div>`;

  h += `<div class="q-totals-compact">`;
  h += tp("&#10133;","#4fc3f7",t.install,"Install",trend(t.install,pv.install));
  h += tp("&#128465;","#ef5350",t.deinstall,"Deinstall",trend(t.deinstall,pv.deinstall));
  h += tp("&#8596;","#ffb74d",t.linemove,"Line Move",trend(t.linemove,pv.linemove));
  h += tp("&#8644;","#ab47bc",t.pathmove,"Path Move",trend(t.pathmove,pv.pathmove));
  h += tp("&#9989;","#66bb6a",t.total_done,"Erledigt",trend(t.total_done,pv.total_done));
  h += tp("&#128683;","#78909c",t.total_canceled,"Abgebr.","");
  h += `</div>`;
  if (pv.label) h += `<div style="font-size:.72rem;color:var(--muted,#666);margin-top:-4px;">Trend vs. ${esc(pv.label)}</div>`;
  return h;
}

function tp(icon, color, val, label, trendH) {
  return `<div class="q-tp"><span class="q-tp-icon" style="color:${color}">${icon}</span><div><div class="q-tp-num" style="color:${color}">${val||0} ${trendH||""}</div><div class="q-tp-label">${esc(label)}</div></div></div>`;
}

/* ── TAB: KW Table ── */
function renderKwTable(data) {
  const t = data.totals || {}, perKw = data.per_kw || [];
  if (!perKw.length) return '<div style="padding:24px 0;text-align:center;opacity:.4;">Keine KW-Daten.</div>';
  const kwMax = Math.max(1, ...perKw.map(r=>r.total||0));
  let h = `<div style="overflow-x:auto;"><table class="q-table"><thead><tr>
    <th>KW</th><th class="num">Install</th><th class="num">Deinstall</th>
    <th class="num">Line Mv</th><th class="num">Path Mv</th>
    <th class="num">Erledigt</th><th class="num">Gesamt</th>
  </tr></thead><tbody>`;
  for (const r of perKw) {
    const tot = r.total||0, pct = Math.round(tot/kwMax*100);
    h += `<tr><td class="kw-label">KW${String(r.kw).padStart(2,"0")}</td>
      <td class="num">${r.install||0}</td><td class="num">${r.deinstall||0}</td>
      <td class="num">${r.linemove||0}</td><td class="num">${r.pathmove||0}</td>
      <td class="num" style="color:#66bb6a">${r.done||0}</td>
      <td class="num"><div class="kw-cell-bar"><span>${tot}</span><div class="kw-cell-track"><div class="kw-cell-fill bar-install" style="width:${pct}%"></div></div></div></td></tr>`;
  }
  h += `<tr style="border-top:2px solid rgba(255,255,255,.08);font-weight:700;"><td>Gesamt</td>
    <td class="num">${t.install||0}</td><td class="num">${t.deinstall||0}</td>
    <td class="num">${t.linemove||0}</td><td class="num">${t.pathmove||0}</td>
    <td class="num" style="color:#66bb6a">${t.total_done||0}</td><td class="num">${t.total_all||0}</td></tr>`;
  h += `</tbody></table></div>`;
  return h;
}

/* ── TAB: Leaderboard ── */
function renderLeaderboard(data) {
  const perTech = data.per_technician || [];
  if (!perTech.length) return '<div style="padding:24px 0;text-align:center;opacity:.4;">Keine Techniker-Daten.</div>';
  const maxT = Math.max(1, ...perTech.map(t=>t.total||0));
  const ranks = ["&#129351;","&#129352;","&#129353;"], cls = ["gold","silver","bronze"];
  let h = `<div class="q-section-title">&#127942; Techniker Leaderboard – ${esc(data.label)}</div>`;
  h += `<div class="tech-grid">`;
  for (let i = 0; i < perTech.length; i++) {
    const t = perTech[i], c = i < 3 ? cls[i] : "", m = i < 3 ? ranks[i] : `#${i+1}`;
    h += `<div class="tech-card ${c}" style="animation-delay:${i*.08}s"><div class="tech-rank">${m}</div>
      <div class="tech-name">${esc(t.technician)}</div>
      <div class="tech-total"><strong>${t.total}</strong> Massnahmen</div>
      <div class="tech-bars">
        ${tbar("Install",t.install,maxT,"bar-install")}
        ${tbar("Deinstall",t.deinstall,maxT,"bar-deinstall")}
        ${tbar("Line Mv",t.linemove,maxT,"bar-linemove")}
        ${tbar("Path Mv",t.pathmove,maxT,"bar-pathmove")}
      </div></div>`;
  }
  h += `</div>`;
  return h;
}

function tbar(label, val, max, cls) {
  const pct = max > 0 ? Math.round((val||0)/max*100) : 0;
  return `<div class="tech-bar-row"><span class="tech-bar-label">${esc(label)}</span><div class="tech-bar-track"><div class="tech-bar-fill ${cls}" style="width:${pct}%"></div></div><span class="tech-bar-num">${val||0}</span></div>`;
}

/* ── Init ── */
document.addEventListener("DOMContentLoaded", () => {
  $("btnRefreshDashboard")?.addEventListener("click", () => { loadDashboard(); loadQuarterly(); });
  $("btnLoadQ")?.addEventListener("click", loadQuarterly);
  document.querySelectorAll(".q-tab").forEach(btn => {
    btn.addEventListener("click", () => switchTab(btn.dataset.tab));
  });
  initQuarterSelectors();
  loadDashboard();
  loadQuarterly();
});
