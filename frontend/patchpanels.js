/* ─────────────────────────────────────────────────────────────
   Patchpanel Explorer v2 – frontend/patchpanels.js
   Accordion sidebar | PP Cards | Detail + Compare
   ───────────────────────────────────────────────────────────── */
(() => {
"use strict";

const API = String(window.API_PATCHPANELS || "").replace(/\/+$/, "");

/* ── state ───────────────────────────────────────────────── */
const S = {
  allItems:      [],
  filteredItems: [],
  searchQuery:   "",
  // sidebar
  sidebarFilter: null,          // {cat:"BB"|"A"|"Z", room?:string}
  expandedCats:  new Set(["BB","A","Z"]),
  // detail slots  (A = primary,  B = compare)
  slotA: { id:null, panel:null, ports:[], selectedPort:null, view:"grid" },
  slotB: { id:null, panel:null, ports:[], selectedPort:null, view:"grid" },
  // create-modal
  customers: [],
  systemRacks: [],
  modalStep: 1,
  modalData: {},
};

/* ── helpers ─────────────────────────────────────────────── */
const $ = id => document.getElementById(id);
const esc = v => String(v??"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
function toast(m,t="info"){const w=$("toastWrap");if(!w)return;const e=document.createElement("div");e.className=`toast ${t}`;e.textContent=m;w.appendChild(e);setTimeout(()=>e.remove(),3400);}
function setStatus(m){const s=$("ppStatus");if(s) s.textContent=m||"";}
async function api(u){const r=await fetch(u);const d=await r.json().catch(()=>({}));if(!r.ok) throw new Error(d?.detail||`HTTP ${r.status}`);return d;}
async function apiPost(u,b){const r=await fetch(u,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(b)});const d=await r.json().catch(()=>({}));if(!r.ok) throw new Error(d?.detail||`HTTP ${r.status}`);return d;}

function cassLabel(n){
  n=Number(n||0);if(!Number.isFinite(n)||n<1) return "-";
  const c=Math.floor((n-1)/24)+1,w=(n-1)%24,g=Math.floor(w/6),p=(w%6)+1;
  return `${c}${"ABCD"[g]||"A"}${p}`;
}
let _st;function debounce(fn,ms=220){return(...a)=>{clearTimeout(_st);_st=setTimeout(()=>fn(...a),ms);};}

const CAT_LABELS = { BB:"BB IN & OUT", A:"A-Seite PPs", Z:"Kunden PP" };
const CAT_ORDER  = ["BB","A","Z"];

/* ── data loading ────────────────────────────────────────── */
async function loadAll(){
  setStatus("Lade Patchpanels…");
  try{
    const d=await api(API);
    S.allItems=Array.isArray(d.items)?d.items:[];
    applyFilters();
    setStatus(`${S.allItems.length} Patchpanels geladen.`);
  }catch(e){setStatus(`Fehler: ${e.message}`);toast(`Laden fehlgeschlagen: ${e.message}`,"error");}
}

/* ── filtering ───────────────────────────────────────────── */
function applyFilters(){
  const q=S.searchQuery.toLowerCase();
  S.filteredItems=S.allItems.filter(it=>{
    if(S.sidebarFilter){
      if(it.category!==S.sidebarFilter.cat) return false;
      if(S.sidebarFilter.room && (it.room||"")!==S.sidebarFilter.room) return false;
    }
    if(q){
      const hay=`${it.name||""} ${it.room||""} ${it.rack||""} ${it.cage||""} ${it.location||""} ${it.customer_name||""}`.toLowerCase();
      if(!hay.includes(q)) return false;
    }
    return true;
  });
  renderSidebar();
  renderCards();
}

/* ── sidebar (accordion) ─────────────────────────────────── */
function buildCatTree(){
  const tree={BB:{rooms:{}},A:{rooms:{}},Z:{rooms:{}}};
  for(const it of S.allItems){
    const cat=it.category||"BB";
    const room=it.room||"Unbekannt";
    if(!tree[cat]) tree[cat]={rooms:{}};
    if(!tree[cat].rooms[room]) tree[cat].rooms[room]={items:[],customer_name:null,rack:null};
    tree[cat].rooms[room].items.push(it);
    if(it.customer_name) tree[cat].rooms[room].customer_name=it.customer_name;
    if(it.rack) tree[cat].rooms[room].rack=it.rack;
  }
  return tree;
}

function renderSidebar(){
  const sb=$("ppSidebar");if(!sb) return;
  const tree=buildCatTree();
  let html="";

  for(const cat of CAT_ORDER){
    const node=tree[cat]||{rooms:{}};
    const rooms=Object.keys(node.rooms).sort();
    const total=rooms.reduce((s,r)=>s+node.rooms[r].items.length,0);
    const open=S.expandedCats.has(cat);
    const isActiveCat=S.sidebarFilter?.cat===cat && !S.sidebarFilter?.room;

    html+=`<div class="pp-acc-section">
      <div class="pp-acc-head${isActiveCat?" active":""}" data-cat="${cat}">
        <span class="pp-acc-arrow${open?" open":""}">▶</span>
        <span class="pp-acc-label">${esc(CAT_LABELS[cat])}</span>
        <span class="pp-loc-count">${total}</span>
      </div>`;
    if(open){
      html+=`<div class="pp-acc-body">`;
      for(const room of rooms){
        const rn=node.rooms[room];
        const cnt=rn.items.length;
        const isActive=S.sidebarFilter?.cat===cat && S.sidebarFilter?.room===room;
        let label=room;
        if(cat==="Z" && rn.customer_name){
          const parts=[room,rn.rack,rn.customer_name].filter(Boolean);
          label=parts.join(":");
        }
        html+=`<div class="pp-loc-item${isActive?" active":""}" data-cat="${cat}" data-room="${esc(room)}">
          <span class="pp-loc-name">${esc(label)}</span>
          <span class="pp-loc-count">${cnt}</span>
        </div>`;
      }
      html+=`</div>`;
    }
    html+=`</div>`;
  }

  sb.innerHTML=html;

  // accordion head click → toggle expand + optional category filter
  sb.querySelectorAll(".pp-acc-head").forEach(el=>{
    el.addEventListener("click",()=>{
      const cat=el.dataset.cat;
      if(S.expandedCats.has(cat)) S.expandedCats.delete(cat); else S.expandedCats.add(cat);
      // also set category filter
      if(S.sidebarFilter?.cat===cat && !S.sidebarFilter?.room) S.sidebarFilter=null;
      else S.sidebarFilter={cat};
      applyFilters();
    });
  });

  // room click → filter to category + room
  sb.querySelectorAll(".pp-loc-item").forEach(el=>{
    el.addEventListener("click",e=>{
      e.stopPropagation();
      const cat=el.dataset.cat, room=el.dataset.room;
      if(S.sidebarFilter?.cat===cat && S.sidebarFilter?.room===room) S.sidebarFilter=null;
      else S.sidebarFilter={cat,room};
      applyFilters();
    });
  });
}

/* ── cards (middle) ──────────────────────────────────────── */
function renderCards(){
  const grid=$("ppCardsGrid"), title=$("ppCardsTitle"), count=$("ppCardsCount");
  if(!grid) return;
  const filterLabel=S.sidebarFilter
    ?(S.sidebarFilter.room||CAT_LABELS[S.sidebarFilter.cat]||"")
    :"Alle Patchpanels";
  if(title) title.textContent=filterLabel;
  if(count) count.textContent=`${S.filteredItems.length} Patchpanels`;

  if(!S.filteredItems.length){
    grid.innerHTML=`<div class="pp-empty-state" style="grid-column:1/-1;">
      <div class="pp-empty-icon">🔍</div>
      <div class="pp-empty-title">Keine Patchpanels gefunden</div>
      <div class="pp-empty-sub small muted">${S.searchQuery?"Suchbegriff ändern oder Filter zurücksetzen.":"Keine PPs in dieser Kategorie."}</div>
    </div>`;
    return;
  }

  let html="";
  for(const it of S.filteredItems){
    const tot=it.ports_total||48, occ=it.ports_occupied||0, free=it.ports_free??(tot-occ);
    const pF=tot>0?Math.round(free/tot*100):100, pO=100-pF;
    const isA=Number(it.id)===Number(S.slotA.id);
    const isB=Number(it.id)===Number(S.slotB.id);
    html+=`<div class="pp-card${isA?" active":""}${isB?" compare":""}" data-id="${it.id}">
      <div class="pp-card-name">${esc(it.name)}</div>
      <div class="pp-card-loc small muted">${esc(it.location||"-")}${it.customer_name?` · ${esc([it.room,it.rack,it.customer_name].filter(Boolean).join(":"))}`:""}</div>
      <div class="pp-card-bar"><div class="pp-bar-free" style="width:${pF}%"></div><div class="pp-bar-occ" style="width:${pO}%"></div></div>
      <div class="pp-card-stats">
        <span class="pp-stat-free">${free} frei</span>
        <span class="pp-stat-occ">${occ} belegt</span>
        <span class="pp-stat-total small muted">/ ${tot}</span>
      </div>
    </div>`;
  }
  grid.innerHTML=html;
  grid.querySelectorAll(".pp-card").forEach(el=>{
    el.addEventListener("click",()=>{
      const id=Number(el.dataset.id);
      if(id) onCardClick(id);
    });
  });
}

/* ── card click → slot A or B ────────────────────────────── */
function onCardClick(id){
  if(!S.slotA.id || S.slotA.id===id){
    loadSlot("A",id);
  } else if(S.slotB.id===id){
    // already in B
  } else {
    loadSlot("B",id);
  }
}

function updateDeinstallBtn(){
  const btn=$("btnDeinstallPp");
  if(!btn) return;
  btn.disabled=!S.slotA.id;
}

async function loadSlot(slot,id){
  const s=slot==="A"?S.slotA:S.slotB;
  s.id=id; s.panel=null; s.ports=[]; s.selectedPort=null;
  renderCards();
  showDetailZone();
  const container=$(`ppDetail${slot}`);
  if(container) container.innerHTML='<div class="pp-detail-loading small muted" style="padding:32px 0;text-align:center;">Lade Ports…</div>';
  try{
    const d=await api(`${API}/${id}/ports`);
    s.panel=d.patchpanel||null;
    s.ports=Array.isArray(d.ports)?d.ports:[];
    s.selectedPort=null;
    renderSlot(slot);
    updateDeinstallBtn();
  }catch(e){
    if(container) container.innerHTML=`<div class="pp-empty-state"><div class="pp-empty-icon">⚠️</div><div class="pp-empty-title">Fehler</div><div class="pp-empty-sub small muted">${esc(e.message)}</div></div>`;
  }
}

function closeSlot(slot){
  const s=slot==="A"?S.slotA:S.slotB;
  s.id=null; s.panel=null; s.ports=[]; s.selectedPort=null;
  if(slot==="A" && S.slotB.id){
    Object.assign(S.slotA, {...S.slotB});
    S.slotB={id:null,panel:null,ports:[],selectedPort:null,view:"grid"};
  }
  showDetailZone();
  renderCards();
  updateDeinstallBtn();
  if(S.slotA.id) renderSlot("A"); else renderEmptySlot("A");
  if(S.slotB.id) renderSlot("B"); else{const b=$("ppDetailB");if(b)b.style.display="none";}
}

function showDetailZone(){
  const zA=$("ppDetailA"), zB=$("ppDetailB"), zone=$("ppDetailZone");
  if(!zA) return;
  zA.style.display="";
  if(zB) zB.style.display=S.slotB.id?"":"none";
  zone?.classList.toggle("pp-compare-mode",!!S.slotB.id);
}

function renderEmptySlot(slot){
  const c=$(`ppDetail${slot}`);
  if(!c) return;
  c.innerHTML=`<div class="pp-empty-state"><div class="pp-empty-icon">📋</div><div class="pp-empty-title">Patchpanel auswählen</div><div class="pp-empty-sub small muted">Klicke auf ein Patchpanel, um die Ports anzuzeigen.</div></div>`;
}

/* ── detail slot rendering ───────────────────────────────── */
function renderSlot(slot){
  const c=$(`ppDetail${slot}`);
  const s=slot==="A"?S.slotA:S.slotB;
  if(!c||!s.panel) return;
  const p=s.panel, ports=s.ports;
  const total=p.ports_total||ports.length;
  const occ=ports.filter(x=>x.is_occupied).length;
  const free=ports.filter(x=>x.status==="free"&&!x.is_occupied).length;
  const nav=ports.filter(x=>x.status==="unavailable").length;

  c.innerHTML=`
    <div class="pp-slot-head">
      <div style="flex:1;min-width:0">
        <div class="pp-detail-title">${esc(p.name)}</div>
        <div class="pp-detail-loc small muted">${esc(p.location||"-")} · ${total} Ports</div>
      </div>
      <button class="pp-close-btn" data-slot="${slot}" title="Schließen">&times;</button>
    </div>
    <div class="pp-detail-stats">
      <div class="pp-dstat free"><span class="pp-dstat-n">${free}</span><span class="pp-dstat-l">Frei</span></div>
      <div class="pp-dstat occupied"><span class="pp-dstat-n">${occ}</span><span class="pp-dstat-l">Belegt</span></div>
      ${nav>0?`<div class="pp-dstat unavailable"><span class="pp-dstat-n">${nav}</span><span class="pp-dstat-l">N/A</span></div>`:""}
    </div>
    <div class="pp-detail-toolbar">
      <button class="btn btn-sm pp-view-btn${s.view==="grid"?" active":""}" data-view="grid" data-slot="${slot}">Grid</button>
      <button class="btn btn-sm pp-view-btn${s.view==="table"?" active":""}" data-view="table" data-slot="${slot}">Tabelle</button>
    </div>
    <div class="pp-cassettes" data-slot="${slot}" style="${s.view==="grid"?"":"display:none"}"></div>
    <div class="pp-table-wrap" data-slot="${slot}" style="${s.view==="table"?"":"display:none"}"></div>
  `;

  c.querySelector(".pp-close-btn")?.addEventListener("click",()=>closeSlot(slot));
  c.querySelectorAll(".pp-view-btn").forEach(b=>{
    b.addEventListener("click",()=>{
      s.view=b.dataset.view;
      c.querySelectorAll(".pp-view-btn").forEach(x=>x.classList.toggle("active",x===b));
      const cass=c.querySelector(".pp-cassettes"), tbl=c.querySelector(".pp-table-wrap");
      if(cass) cass.style.display=s.view==="grid"?"":"none";
      if(tbl) tbl.style.display=s.view==="table"?"":"none";
    });
  });

  renderCassettes(slot);
  renderTable(slot);
}

/* ── cassettes ───────────────────────────────────────────── */
function renderCassettes(slot){
  const s=slot==="A"?S.slotA:S.slotB;
  const wrap=document.querySelector(`.pp-cassettes[data-slot="${slot}"]`);
  if(!wrap) return;
  const ports=s.ports, total=s.panel?.ports_total||ports.length;
  if(!total||!ports.length){wrap.innerHTML='<div class="small muted" style="padding:12px 0;">Keine Portdaten.</div>';return;}
  const pm=new Map(); for(const p of ports) pm.set(Number(p.port_number||0),p);
  const rowCount=Math.ceil(total/24);
  const isZside=s.panel?.category==="Z";
  const letters=["A","B","C","D"];

  let html='<div class="cassette-host">';

  if(!isZside){
    /* ── BB / A-Seite: classic 24-port rows (Kassette 1 = 1A1–1D6) ── */
    for(let r=0;r<rowCount;r++){
      const rowNo=r+1, st=r*24+1, en=Math.min(st+23,total);
      html+=`<div class="cassette-card"><div class="cassette-title">Kassette ${rowNo} (${rowNo}A1–${rowNo}D6)</div><div class="cassette-grid">`;
      for(let i=st;i<=en;i++){
        const port=pm.get(i)||{port_number:i,is_occupied:false,status:"free"};
        const lab=cassLabel(i);
        const occ=!!port.is_occupied, unav=String(port.status||"").toLowerCase()==="unavailable";
        const cls=unav?"unavailable":(occ?"occupied":"free");
        html+=`<button type="button" class="port-tile ${cls}" data-pn="${i}" data-slot="${slot}" title="Port ${lab} (#${i}) – ${unav?"n/a":(occ?"belegt":"frei")}"${unav?" disabled":""}>
          <span>${esc(lab)}</span><span class="dot"></span></button>`;
      }
      html+='</div></div>';
    }
  } else {
    /* ── Z-Seite: individual 6-port cassettes with release/lock ── */
    for(let r=0;r<rowCount;r++){
      const rowNo=r+1;
      for(let g=0;g<4;g++){
        const letter=letters[g];
        const cassSlot=`${rowNo}${letter}`;
        const baseIdx=r*24+g*6;
        if(baseIdx+1>total) continue;
        // Analyze cassette state
        let allUnavailable=true, allFreeOrUnavailable=true, anyOccupied=false, anyFree=false;
        for(let p=1;p<=6;p++){
          const pn=baseIdx+p;
          if(pn>total){allUnavailable=false;break;}
          const port=pm.get(pn)||{status:"free"};
          const st2=String(port.status||"").toLowerCase();
          if(st2!=="unavailable") allUnavailable=false;
          if(st2==="free"&&!port.is_occupied) anyFree=true;
          if(port.is_occupied) anyOccupied=true;
        }
        // Button logic: unavailable → show release, free (no occupied) → show lock
        let actionBtn="";
        if(allUnavailable){
          actionBtn=`<button type="button" class="btn btn-sm pp-cass-release-btn" data-cass="${cassSlot}" data-slot="${slot}" title="Kassette ${cassSlot} freigeben">🔓 Freigeben</button>`;
        } else if(anyFree && !anyOccupied){
          actionBtn=`<button type="button" class="btn btn-sm pp-cass-lock-btn" data-cass="${cassSlot}" data-slot="${slot}" title="Kassette ${cassSlot} sperren">🔒</button>`;
        }
        html+=`<div class="cassette-card">
          <div class="cassette-head">
            <div class="cassette-title">Kassette ${cassSlot} (${cassSlot}1–${cassSlot}6)</div>
            ${actionBtn}
          </div>
          <div class="cassette-grid cassette-grid-6">`;
        for(let p=1;p<=6;p++){
          const pn=baseIdx+p;
          if(pn>total) break;
          const port=pm.get(pn)||{port_number:pn,is_occupied:false,status:"free"};
          const lab=cassLabel(pn);
          const occ=!!port.is_occupied, unav=String(port.status||"").toLowerCase()==="unavailable";
          const cls=unav?"unavailable":(occ?"occupied":"free");
          html+=`<button type="button" class="port-tile ${cls}" data-pn="${pn}" data-slot="${slot}" title="Port ${lab} (#${pn}) – ${unav?"n/a":(occ?"belegt":"frei")}"${unav?" disabled":""}>
            <span>${esc(lab)}</span><span class="dot"></span></button>`;
        }
        html+='</div></div>';
      }
    }
  }

  html+='</div>';
  wrap.innerHTML=html;
  wrap.querySelectorAll(".port-tile:not([disabled])").forEach(b=>{
    b.addEventListener("click",e=>{
      const pn=Number(b.dataset.pn), sl=b.dataset.slot;
      const st2=sl==="A"?S.slotA:S.slotB;
      const port=st2.ports.find(x=>Number(x.port_number)===pn);
      if(port) showPortPopup(port,e,sl);
    });
  });
  // Kassette freigeben buttons
  wrap.querySelectorAll(".pp-cass-release-btn").forEach(b=>{
    b.addEventListener("click",async()=>{
      const cassSlot=b.dataset.cass, sl=b.dataset.slot;
      const st2=sl==="A"?S.slotA:S.slotB;
      if(!st2.id) return;
      if(!confirm(`Kassette ${cassSlot} wirklich freigeben? Alle 6 Ports werden auf „frei" gesetzt.`)) return;
      b.disabled=true; b.textContent="⏳ …";
      try{
        await fetch(`${API}/${st2.id}/cassette/${cassSlot}/release`,{method:"PUT",headers:{"Content-Type":"application/json"}});
        toast(`Kassette ${cassSlot} freigegeben!`,"success");
        await loadSlot(sl,st2.id);
      }catch(e){toast(`Fehler: ${e.message}`,"error");b.disabled=false;b.textContent="🔓 Freigeben";}
    });
  });
  // Kassette sperren (lock) buttons
  wrap.querySelectorAll(".pp-cass-lock-btn").forEach(b=>{
    b.addEventListener("click",async()=>{
      const cassSlot=b.dataset.cass, sl=b.dataset.slot;
      const st2=sl==="A"?S.slotA:S.slotB;
      if(!st2.id) return;
      if(!confirm(`Kassette ${cassSlot} wirklich sperren? Alle freien Ports werden auf „nicht verfügbar" gesetzt.`)) return;
      b.disabled=true; b.textContent="⏳ …";
      try{
        await fetch(`${API}/${st2.id}/cassette/${cassSlot}/lock`,{method:"PUT",headers:{"Content-Type":"application/json"}});
        toast(`Kassette ${cassSlot} gesperrt.`,"success");
        await loadSlot(sl,st2.id);
      }catch(e){toast(`Fehler: ${e.message}`,"error");b.disabled=false;b.textContent="🔒";}
    });
  });
}

/* ── table ───────────────────────────────────────────────── */
function renderTable(slot){
  const s=slot==="A"?S.slotA:S.slotB;
  const wrap=document.querySelector(`.pp-table-wrap[data-slot="${slot}"]`);
  if(!wrap) return;
  if(!s.ports.length){wrap.innerHTML='<div class="small muted">Keine Portdaten.</div>';return;}
  let html=`<div class="table-scroll" style="max-height:400px;"><table class="table-list-table table-list">
    <thead><tr><th>#</th><th>Port</th><th>Status</th><th>Serial</th><th>Kunde</th><th>Side</th></tr></thead><tbody>`;
  for(const port of s.ports){
    const lab=cassLabel(port.port_number);
    const st=String(port.status||"").toLowerCase();
    const badge=st==="unavailable"?'<span class="badge badge-danger">n/a</span>':(port.is_occupied?'<span class="badge badge-warning">belegt</span>':'<span class="badge badge-neutral">frei</span>');
    html+=`<tr class="pp-tbl-row" data-pn="${port.port_number}" data-slot="${slot}" style="cursor:pointer">
      <td>${port.port_number||"-"}</td><td>${esc(lab)}</td><td>${badge}</td>
      <td class="mono">${esc(port.serial||"-")}</td><td>${esc(port.customer||"-")}</td><td>${esc(port.side||"-")}</td></tr>`;
  }
  html+='</tbody></table></div>';
  wrap.innerHTML=html;
  wrap.querySelectorAll(".pp-tbl-row").forEach(tr=>{
    tr.addEventListener("click",e=>{
      const pn=Number(tr.dataset.pn), sl=tr.dataset.slot;
      const st2=sl==="A"?S.slotA:S.slotB;
      const port=st2.ports.find(x=>Number(x.port_number)===pn);
      if(port && String(port.status||"").toLowerCase()!=="unavailable") showPortPopup(port,e,sl);
    });
  });
}

/* ── port popup (floating) ───────────────────────────────── */
function showPortPopup(port,event,slot){
  const popup=$("ppPortPopup");if(!popup) return;
  const lab=cassLabel(port.port_number);
  const occ=port.is_occupied;

  let html=`<div class="pp-popup-head">
    <span class="pp-popup-title">Port ${esc(lab)}</span>
    <button class="pp-popup-close" id="ppPopupClose">&times;</button>
  </div><div class="pp-popup-body">
    <div class="small muted">Portnummer: ${port.port_number}</div>`;

  if(!occ){
    html+=`<div class="small" style="margin-top:4px;">Status: <span style="color:#10b981;font-weight:600;">frei</span></div>`;
  } else {
    const ccLink=port.serial?`cross-connects.html?q=${encodeURIComponent(port.serial)}`:"cross-connects.html";
    html+=`
    <div class="small" style="margin-top:4px;">Status: <span style="color:#ef4444;font-weight:600;">belegt</span></div>
    <div class="pp-popup-serial">
      <span class="mono">${esc(port.serial||"-")}</span>
      <button class="pp-popup-copy" title="Serial kopieren" data-serial="${esc(port.serial||"")}">📋</button>
    </div>
    <div class="small"><b>Kunde:</b> ${esc(port.customer||"-")}</div>
    <div class="small"><b>Side:</b> ${esc(port.side||"-")}</div>
    <div style="margin-top:6px;"><a class="btn btn-sm" href="${esc(ccLink)}">→ Cross Connect</a></div>`;
  }
  html+=`</div>`;
  popup.innerHTML=html;
  popup.style.display="block";

  // position near clicked element
  const rect=event.target.closest(".port-tile,.pp-tbl-row")?.getBoundingClientRect();
  if(rect){
    const x=Math.min(rect.right+8, window.innerWidth-280);
    const y=Math.min(rect.top, window.innerHeight-250);
    popup.style.left=x+"px";
    popup.style.top=Math.max(8,y)+"px";
  }

  popup.querySelector("#ppPopupClose")?.addEventListener("click",hidePortPopup);
  popup.querySelector(".pp-popup-copy")?.addEventListener("click",e2=>{
    const serial=e2.currentTarget.dataset.serial;
    if(serial) navigator.clipboard.writeText(serial).then(()=>toast("Serial kopiert!","success"));
  });

  // close on outside click
  setTimeout(()=>{
    const closer=e2=>{if(!popup.contains(e2.target)){hidePortPopup();document.removeEventListener("mousedown",closer);}};
    document.addEventListener("mousedown",closer);
  },50);
}

function hidePortPopup(){const p=$("ppPortPopup");if(p){p.style.display="none";p.innerHTML="";}}

/* ════════════════════════════════════════════════════════════
   Create PP Modal  (customer-first wizard, 4 steps)
   ════════════════════════════════════════════════════════════ */
function openModal(){
  S.modalStep=1;
  S.modalData={customer_id:null,customer_name:"",loc_id:null,room:"",rack_label:"",rack_id:null,pp_number:"",rack_unit:1,total_ports:48,cassettes:[]};
  $("ppCreateModal").style.display="";
  document.documentElement.classList.add("modal-open");
  renderModal();
}
function closeModal(){
  $("ppCreateModal").style.display="none";
  document.documentElement.classList.remove("modal-open");
}

async function loadCustomers(){
  try{const d=await api(`${API}/customers`);S.customers=d.customers||[];S.systemRacks=d.system_racks||[];}catch(e){S.customers=[];S.systemRacks=[];}
}

function renderModal(){
  const body=$("ppModalBody");if(!body) return;
  const d=S.modalData, step=S.modalStep;

  // step indicator
  let html=`<div class="pp-modal-steps">
    <div class="pp-step${step>=1?" active":""}${step>1?" done":""}"><span>1</span> Kunde</div>
    <div class="pp-step${step>=2?" active":""}${step>2?" done":""}"><span>2</span> Rack</div>
    <div class="pp-step${step>=3?" active":""}${step>3?" done":""}"><span>3</span> PP Details</div>
    <div class="pp-step${step>=4?" active":""}"><span>4</span> Kassette</div>
  </div>`;

  /* ── Step 1 : Customer ─────────────────────────── */
  if(step===1){
    html+=`<div class="cc-section">
      <label class="form-label small muted">Kunde suchen oder neu anlegen</label>
      <input id="modalCustSearch" class="input" placeholder="Kundenname eingeben…" value="${esc(d.customer_name)}" autocomplete="off" />
      <div id="modalCustResults" class="pp-modal-results"></div>
      <div style="margin-top:8px;"><button class="btn btn-sm btn-secondary" id="modalCustNew">+ Neuen Kunden anlegen</button></div>
    </div>
    <div class="pp-modal-nav">
      <button class="btn btn-secondary" id="modalCancel">Abbrechen</button>
      <button class="btn" id="modalNext1" ${!d.customer_name?"disabled":""}>Weiter →</button>
    </div>`;
  }

  /* ── Step 2 : Room + Rack ──────────────────────── */
  else if(step===2){
    const cust=S.customers.find(c=>c.id===d.customer_id);
    const locs=cust?.locations||[];
    // If a location was pre-selected in step 1, filter to that location only
    const filteredLocs=d.loc_id?locs.filter(l=>l.id===d.loc_id):locs;
    html+=`<div class="cc-section">
      <label class="form-label small muted">Kunde: <b>${esc(d.customer_name)}</b></label>`;
    if(filteredLocs.length){
      html+=`<label class="form-label small muted" style="margin-top:8px;">Raum (vom Kunden)</label>
        <select id="modalRoomSel" class="select"><option value="">Raum wählen…</option>`;
      for(const l of filteredLocs) html+=`<option value="${l.id}" data-room="${esc(l.room)}" ${l.room===d.room?"selected":""}>${esc(l.room)}${l.cage_no?` / Cage ${l.cage_no}`:""}</option>`;
      html+=`</select>`;
      const selLoc=filteredLocs.find(l=>l.room===d.room);
      if(selLoc?.racks?.length){
        html+=`<div style="margin-top:10px;">
          <label class="form-label small muted">Racks am Standort</label>
          <div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:4px;">`;
        for(const rk of selLoc.racks)
          html+=`<button type="button" class="pp-rack-chip${d.rack_label===rk.rack_label?" selected":""}" data-rack="${esc(rk.rack_label)}" data-id="${rk.id}">${esc(rk.rack_label)}</button>`;
        html+=`</div></div>`;
      }
    }
    html+=`<div style="margin-top:10px;">
      <label class="form-label small muted">Oder manuell eingeben</label>
      <input id="modalRoomManual" class="input" placeholder="Raum z.B. 1A2" value="${esc(d.room)}" />
      <input id="modalRackManual" class="input" placeholder="Rack z.B. 0607" value="${esc(d.rack_label)}" style="margin-top:6px;" />
    </div></div>
    <div class="pp-modal-nav">
      <button class="btn btn-secondary" id="modalBack">← Zurück</button>
      <button class="btn" id="modalNext2" ${!d.room||!d.rack_label?"disabled":""}>Weiter →</button>
    </div>`;
  }

  /* ── Step 3 : PP number + RU ───────────────────── */
  else if(step===3){
    const preview=d.pp_number && d.rack_label ? `PP:${d.rack_label}:${d.pp_number}` : "—";
    html+=`<div class="cc-section">
      <label class="form-label small muted">Rack Unit (RU)</label>
      <input id="modalRU" class="input" type="number" min="1" max="48" placeholder="z.B. 38" value="${d.rack_unit||""}" />
      <label class="form-label small muted" style="margin-top:8px;">PP-Nummer</label>
      <input id="modalPPNum" class="input" placeholder="z.B. 1370187" value="${esc(d.pp_number)}" />
      <label class="form-label small muted" style="margin-top:10px;">PP-Typ (Ports)</label>
      <div class="pp-port-type-sel" style="display:flex;gap:10px;margin-top:4px;">
        <label class="pp-modal-radio"><input type="radio" name="modalPortType" value="48" ${d.total_ports===48?"checked":""}> 48 Ports</label>
        <label class="pp-modal-radio"><input type="radio" name="modalPortType" value="72" ${d.total_ports===72?"checked":""}> 72 Ports</label>
      </div>
      <div class="pp-modal-preview">
        <div class="small muted">Vorschau Instance-ID:</div>
        <div class="pp-modal-preview-val" id="modalPreview">${esc(preview)}${d.rack_unit?` /RU${d.rack_unit}`:""} · ${d.total_ports} Ports</div>
      </div>
    </div>
    <div class="pp-modal-nav">
      <button class="btn btn-secondary" id="modalBack">← Zurück</button>
      <button class="btn" id="modalNext3" ${!d.pp_number?"disabled":""}>Weiter →</button>
    </div>`;
  }

  /* ── Step 4 : Cassette picker ──────────────────── */
  else if(step===4){
    const numCass=d.total_ports===72?3:2;  // 48→2, 72→3
    const slots=[];
    for(let c=0;c<numCass;c++){for(let g=0;g<4;g++) slots.push(`${c+1}${"ABCD"[g]}`);}
    html+=`<div class="cc-section">
      <label class="form-label small muted">Kassette(n) auswählen – ${d.total_ports} Ports (${numCass} Kassetten)</label>
      <div class="pp-cass-picker" id="modalCassPicker">`;
    for(const sl of slots){
      const sel=d.cassettes.includes(sl);
      html+=`<button type="button" class="pp-cass-chip${sel?" selected":""}" data-slot="${sl}">${sl}</button>`;
    }
    html+=`</div>
      <div class="pp-modal-preview" style="margin-top:10px;">
        <div class="small muted">Vorschau Portlayout:</div>
        <div id="modalCassPreview" class="pp-cass-preview"></div>
      </div>
    </div>
    <div class="pp-modal-nav">
      <button class="btn btn-secondary" id="modalBack">← Zurück</button>
      <button class="btn" id="modalSave">Patchpanel anlegen</button>
    </div>`;
  }

  body.innerHTML=html;
  bindModalEvents();
  if(step===4) renderCassPreview();
}

/* ── modal event bindings ────────────────────────────────── */
function bindModalEvents(){
  /* step 1 */
  const cs=$("modalCustSearch");
  if(cs){
    cs.focus();
    cs.addEventListener("input",debounce(()=>{
      const q=cs.value.trim().toLowerCase();
      S.modalData.customer_name=cs.value.trim();
      const res=$("modalCustResults");if(!res) return;
      if(!q){res.innerHTML="";return;}
      // Flatten: one entry per customer+location
      const entries=[];
      for(const c of S.customers){
        if(!c.name.toLowerCase().includes(q)) continue;
        if(c.locations?.length){
          for(const loc of c.locations){
            const rackPart=loc.racks?.map(r=>r.rack_label).join("/")||"";
            const display=[loc.room,rackPart,c.name].filter(Boolean).join(":");
            entries.push({id:c.id,name:c.name,display,loc_id:loc.id,room:loc.room,rack:loc.racks?.[0]?.rack_label||"",rack_id:loc.racks?.[0]?.id||null});
          }
        } else {
          entries.push({id:c.id,name:c.name,display:c.name,loc_id:null,room:"",rack:"",rack_id:null});
        }
      }
      res.innerHTML=entries.map((e,i)=>
        `<div class="pp-modal-result-item" data-idx="${i}">${esc(e.display)}</div>`
      ).join("");
      res.querySelectorAll(".pp-modal-result-item").forEach(el=>{
        el.addEventListener("click",()=>{
          const e=entries[Number(el.dataset.idx)];
          S.modalData.customer_id=e.id;
          S.modalData.customer_name=e.name;
          S.modalData.loc_id=e.loc_id;
          S.modalData.room=e.room;
          S.modalData.rack_label=e.rack;
          S.modalData.rack_id=e.rack_id;
          cs.value=e.display;
          res.innerHTML="";
          $("modalNext1")?.removeAttribute("disabled");
        });
      });
    },150));
  }
  $("modalCustNew")?.addEventListener("click",()=>{
    S.modalData.customer_id=null;
    S.modalData.customer_name=cs?.value.trim()||"";
    if(S.modalData.customer_name) $("modalNext1")?.removeAttribute("disabled");
  });
  $("modalNext1")?.addEventListener("click",()=>{if(S.modalData.customer_name){S.modalStep=2;renderModal();}});

  /* step 2 */
  $("modalRoomSel")?.addEventListener("change",e=>{
    const opt=e.target.selectedOptions[0];
    S.modalData.room=opt?.dataset.room||"";
    const mi=$("modalRoomManual");if(mi) mi.value=S.modalData.room;
    // auto-select rack when location has exactly one
    const cust=S.customers.find(c=>c.id===S.modalData.customer_id);
    const loc=cust?.locations?.find(l=>l.id===Number(opt?.value));
    if(loc?.racks?.length===1){
      S.modalData.rack_label=loc.racks[0].rack_label;
      S.modalData.rack_id=loc.racks[0].id;
    } else {
      S.modalData.rack_label="";
      S.modalData.rack_id=null;
    }
    renderModal();
  });
  // rack chips (filtered to selected location)
  document.querySelectorAll('.pp-rack-chip').forEach(btn=>{
    btn.addEventListener('click',()=>{
      S.modalData.rack_label=btn.dataset.rack;
      S.modalData.rack_id=Number(btn.dataset.id)||null;
      const mi=$("modalRackManual");if(mi) mi.value=btn.dataset.rack;
      document.querySelectorAll('.pp-rack-chip').forEach(b=>b.classList.toggle('selected',b===btn));
      chk2();
    });
  });
  $("modalRoomManual")?.addEventListener("input",e=>{S.modalData.room=e.target.value.trim();chk2();});
  $("modalRackManual")?.addEventListener("input",e=>{S.modalData.rack_label=e.target.value.trim();chk2();});
  function chk2(){
    if(S.modalData.room&&S.modalData.rack_label) $("modalNext2")?.removeAttribute("disabled");
    else $("modalNext2")?.setAttribute("disabled","");
  }
  $("modalNext2")?.addEventListener("click",()=>{if(S.modalData.room&&S.modalData.rack_label){S.modalStep=3;renderModal();}});

  /* step 3 */
  $("modalRU")?.addEventListener("input",e=>{S.modalData.rack_unit=Number(e.target.value)||1;updPrev();});
  $("modalPPNum")?.addEventListener("input",e=>{
    S.modalData.pp_number=e.target.value.trim();updPrev();
    if(S.modalData.pp_number) $("modalNext3")?.removeAttribute("disabled");
    else $("modalNext3")?.setAttribute("disabled","");
  });
  document.querySelectorAll('input[name="modalPortType"]').forEach(r=>{
    r.addEventListener("change",()=>{S.modalData.total_ports=Number(r.value);updPrev();});
  });
  function updPrev(){const p=$("modalPreview");if(!p)return;const d2=S.modalData;p.textContent=d2.pp_number&&d2.rack_label?`PP:${d2.rack_label}:${d2.pp_number}${d2.rack_unit?` /RU${d2.rack_unit}`:""} · ${d2.total_ports} Ports`:"—";}
  $("modalNext3")?.addEventListener("click",()=>{if(S.modalData.pp_number){S.modalStep=4;renderModal();}});

  /* step 4 */
  $("modalCassPicker")?.querySelectorAll(".pp-cass-chip").forEach(b=>{
    b.addEventListener("click",()=>{
      const sl=b.dataset.slot;
      const idx=S.modalData.cassettes.indexOf(sl);
      if(idx>=0) S.modalData.cassettes.splice(idx,1); else S.modalData.cassettes.push(sl);
      b.classList.toggle("selected");
      renderCassPreview();
    });
  });
  $("modalSave")?.addEventListener("click",doCreatePP);

  /* common */
  $("modalBack")?.addEventListener("click",()=>{S.modalStep=Math.max(1,S.modalStep-1);renderModal();});
  $("modalCancel")?.addEventListener("click",closeModal);
}

function renderCassPreview(){
  const box=$("modalCassPreview");if(!box) return;
  const sel=new Set(S.modalData.cassettes);
  const numCass=S.modalData.total_ports===72?3:2;
  let html='<div class="pp-cass-mini-grid">';
  for(let c=0;c<numCass;c++){
    const no=c+1;
    html+=`<div class="pp-cass-mini-card"><div class="pp-cass-mini-title">Reihe ${no}</div>`;
    for(let g=0;g<4;g++){
      const slot=`${no}${"ABCD"[g]}`;
      const active=sel.has(slot);
      html+=`<div class="pp-cass-mini-row${active?" active":""}">
        <span>${slot}</span>
        <span class="pp-cass-mini-dots">${Array(6).fill(0).map(()=>`<span class="pp-cass-dot${active?" green":""}"></span>`).join("")}</span>
      </div>`;
    }
    html+=`</div>`;
  }
  html+='</div>';
  box.innerHTML=html;
}

async function doDeinstallPp(){
  if(!S.slotA.id) return;
  const name=S.slotA.panel?.name||`PP #${S.slotA.id}`;
  if(!confirm(`Patchpanel "${name}" wirklich deinstallieren?\n\nAlle Ports werden gelöscht. Dies ist nur möglich wenn keine aktiven Leitungen mehr vorhanden sind.`)) return;
  try{
    const r=await fetch(`${API}/${S.slotA.id}`,{method:"DELETE"});
    const d2=await r.json().catch(()=>({}));
    if(!r.ok) throw new Error(d2?.detail||`HTTP ${r.status}`);
    toast(`Patchpanel "${name}" deinstalliert.`,"success");
    closeSlot("A");
    await loadAll();
  }catch(e){toast(`Fehler: ${e.message}`,"error");}
}

async function doCreatePP(){
  const d=S.modalData;
  try{
    await apiPost(API,{
      customer_id:d.customer_id||null,
      customer_name:d.customer_name||null,
      room:d.room,
      rack_label:d.rack_label,
      pp_number:d.pp_number,
      rack_unit:d.rack_unit,
      total_ports:d.total_ports||48,
      cassettes:d.cassettes,
    });
    toast("Patchpanel angelegt!","success");
    closeModal();
    await loadAll();
    await loadCustomers();
  }catch(e){toast(`Fehler: ${e.message}`,"error");}
}

/* ── top-level events ────────────────────────────────────── */
function bindEvents(){
  $("ppSearch")?.addEventListener("input",debounce(()=>{
    S.searchQuery=($("ppSearch")?.value||"").trim();
    applyFilters();
  }));
  $("btnNewPp")?.addEventListener("click",openModal);
  $("btnDeinstallPp")?.addEventListener("click",doDeinstallPp);
  $("ppModalClose")?.addEventListener("click",closeModal);
  $("ppCreateModal")?.addEventListener("click",e=>{if(e.target===$("ppCreateModal")) closeModal();});
}

/* ── init ────────────────────────────────────────────────── */
document.addEventListener("DOMContentLoaded",async()=>{
  bindEvents();
  renderEmptySlot("A");
  await Promise.all([loadAll(), loadCustomers()]);
});

})();
