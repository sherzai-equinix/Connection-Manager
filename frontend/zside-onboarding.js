// zside-onboarding.js — NEW/EXISTING customer onboarding (Step3 polished, NO ports)
const BASE_URL = "http://127.0.0.1:8000";

const API = {
  rooms: () => `${BASE_URL}/zside/rooms`,
  customers: (room) => `${BASE_URL}/zside/customers?room=${encodeURIComponent(room)}`,
  locations: (room, customer_id) =>
    `${BASE_URL}/zside/locations?room=${encodeURIComponent(room)}&customer_id=${encodeURIComponent(customer_id)}`,
  racks: (location_id) => `${BASE_URL}/zside/racks?location_id=${encodeURIComponent(location_id)}`,

  onboardNew: () => `${BASE_URL}/zside/onboard`,
  onboardExisting: () => `${BASE_URL}/zside/onboard-existing`,
};

function qs(id){ return document.getElementById(id); }

function setStep(n){
  ["step1","step2","step3"].forEach((id, idx)=>qs(id).classList.toggle("hidden", idx !== (n-1)));
  [1,2,3].forEach(i=>qs(`stepBadge${i}`).classList.toggle("active", i===n));
}

async function fetchJSON(url, opts){
  const res = await fetch(url, opts);
  const text = await res.text();
  let data = null;
  try{ data = text ? JSON.parse(text) : null; } catch { data = text; }
  if(!res.ok) throw new Error((data && (data.detail || data.message)) || `${res.status} ${res.statusText}`);
  return data;
}

// ----- helpers -----
function ppFormat(pp){
  const v = (pp || "").trim();
  if(/^\d+$/.test(v)) return String(Number(v)).padStart(2, "0");
  return v;
}
function buildInstanceId(rack, pp){
  const r = (rack || "").trim();
  const p = ppFormat(pp);
  if(!r || !p) return "";
  return `PP:${r}:${p}`;
}
function updateInstanceIdFromInputs(){
  const mode = qs("customerMode").value;

  let rack = "";
  if(mode === "existing"){
    const rackMode = qs("existingRackMode").value;
    if(rackMode === "new"){
      rack = qs("existingRackLabel").value.trim();
    }else{
      const sel = qs("existingRackSelect");
      rack = sel && sel.value ? (sel.options[sel.selectedIndex].textContent || "").trim() : "";
      rack = rack.split("—")[0].trim();
    }
  }else{
    rack = qs("rackLabel").value.trim();
  }

  const pp = qs("ppLabel").value.trim();
  qs("instanceId").value = buildInstanceId(rack, pp);
}

function showSave(msg, isErr){
  qs("saveResult").className = "mt-3 small " + (isErr ? "text-danger" : "text-success");
  qs("saveResult").textContent = msg;
}

// ----- Cassette Model -----
function slotRows(portCount){
  const n = Number(portCount);
  if(n === 48) return 2;
  if(n === 72) return 3;
  if(n === 96) return 4;
  return 2;
}
function slotCodes(portCount){
  const rows = slotRows(portCount);
  const letters = ["A","B","C","D"];
  const out = [];
  for(let r=1; r<=rows; r++){
    for(const l of letters) out.push(`${r}${l}`); // 1A,1B...
  }
  return out;
}

const state = {
  step: 1,
  portCount: 48,
  slotStatus: {}, // slotCode -> "missing"|"installed"|"tested"

  rooms: [],
  existingCustomers: [],
  existingLocations: [],
  existingRacks: [],
};

function cycleStatus(cur){
  if(cur === "missing") return "installed";
  if(cur === "installed") return "tested";
  return "missing";
}
function isSlotUsable(status){
  return status === "installed" || status === "tested";
}

function renderEnabledCassettesPreview(){
  const el = qs("enabledCassettesPreview");
  if(!el) return;

  const slots = slotCodes(state.portCount);

  if(!slots.length){
    el.textContent = "-";
    return;
  }

  el.innerHTML = slots.map(s=>{
    const st = state.slotStatus[s] || "missing";
    const ok = isSlotUsable(st);
    const badgeCls = ok ? "green" : "red";
    const tick = (st === "tested") ? " ✓" : "";
    return `<span class="onboard-badge ${badgeCls}">${s}${tick}</span>`;
  }).join("");
}

function renderCassettes(){
  const grid = qs("cassetteGrid");
  const slots = slotCodes(state.portCount);

  for(const s of slots){
    if(!state.slotStatus[s]) state.slotStatus[s] = "missing";
  }

  grid.innerHTML = slots.map(s=>{
    const st = state.slotStatus[s];
    const tick = (st === "tested") ? `<span class="tick">✓</span>` : "";
    return `<button type="button" class="cassBtn ${st}" data-slot="${s}">
              <span>${s}</span>${tick}
            </button>`;
  }).join("");

  grid.querySelectorAll(".cassBtn").forEach(btn=>{
    btn.addEventListener("click", ()=>{
      const s = btn.dataset.slot;
      state.slotStatus[s] = cycleStatus(state.slotStatus[s]);
      renderCassettes();
      renderEnabledCassettesPreview();
    });
  });

  renderEnabledCassettesPreview();
}

// ----- Rooms -----
async function loadRooms(){
  const data = await fetchJSON(API.rooms());
  const rooms = Array.isArray(data) ? data : [];
  state.rooms = rooms;

  const dl = qs("roomsList");
  dl.innerHTML = rooms.map(r=>`<option value="${r}"></option>`).join("");

  if(!qs("roomInput").value && rooms.length) qs("roomInput").value = rooms[0];
}

// ----- Existing Flow Lookups -----
function setExistingCustomerPreview(){
  const sel = qs("existingCustomerSelect");
  const id = sel.value ? String(sel.value) : "-";
  qs("existingCustomerIdPreview").textContent = id;
}

function applyExistingCustomerFilter(){
  const q = (qs("existingCustomerSearch").value || "").trim().toLowerCase();
  const sel = qs("existingCustomerSelect");

  const list = !q
    ? state.existingCustomers
    : state.existingCustomers.filter(c => (c.name || "").toLowerCase().includes(q));

  sel.innerHTML = `<option value="">— Bitte Kunde wählen —</option>` + list.map(c =>
    `<option value="${c.id}">${c.name}</option>`
  ).join("");

  setExistingCustomerPreview();
}

async function loadExistingCustomers(){
  const room = qs("existingRoomInput").value.trim();
  if(!room){
    state.existingCustomers = [];
    qs("existingCustomerSelect").innerHTML = `<option value="">— Bitte Room wählen —</option>`;
    qs("existingCustomerSearch").value = "";
    setExistingCustomerPreview();
    return;
  }

  const data = await fetchJSON(API.customers(room));
  state.existingCustomers = Array.isArray(data) ? data : [];
  qs("existingCustomerSearch").value = "";
  applyExistingCustomerFilter();
}

async function loadExistingLocations(){
  const room = qs("existingRoomInput").value.trim();
  const customer_id = qs("existingCustomerSelect").value;

  qs("existingLocationSelect").innerHTML = `<option value="">— Loading… —</option>`;
  qs("existingRackSelect").innerHTML = `<option value="">— Bitte Location wählen —</option>`;
  qs("existingRackSelect").disabled = true;
  qs("existingRackMode").disabled = true;
  qs("existingNewRackWrap").classList.add("hidden");
  qs("existingRackLabel").value = "";

  if(!room || !customer_id){
    qs("existingLocationSelect").innerHTML = `<option value="">— Bitte Kunde wählen —</option>`;
    return;
  }

  const data = await fetchJSON(API.locations(room, customer_id));
  state.existingLocations = Array.isArray(data) ? data : [];

  const opts = [
    `<option value="">— Bitte Location wählen —</option>`,
    `<option value="__NEW__">+ Neue Location anlegen</option>`,
    ...state.existingLocations.map(l=>{
      const label = (l.cage_no === null || l.cage_no === undefined || l.cage_no === "")
        ? "OpenColo (no cage)"
        : `Cage: ${l.cage_no}`;
      return `<option value="${l.id}">${label}</option>`;
    })
  ];

  qs("existingLocationSelect").innerHTML = opts.join("");
}

async function loadExistingRacks(){
  const locVal = qs("existingLocationSelect").value;

  qs("existingRackSelect").innerHTML = `<option value="">— Loading… —</option>`;
  qs("existingRackSelect").disabled = true;
  qs("existingRackMode").disabled = true;
  qs("existingRackMode").value = "pick";
  qs("existingNewRackWrap").classList.add("hidden");
  qs("existingRackLabel").value = "";

  if(!locVal || locVal === "__NEW__"){
    qs("existingRackSelect").innerHTML = `<option value="">— Bitte Location wählen —</option>`;
    updateInstanceIdFromInputs();
    return;
  }

  const data = await fetchJSON(API.racks(locVal));
  state.existingRacks = Array.isArray(data) ? data : [];

  qs("existingRackSelect").innerHTML =
    `<option value="">— Bitte Rack wählen —</option>` +
    state.existingRacks.map(r => `<option value="${r.id}">${r.rack_label}</option>`).join("");

  qs("existingRackSelect").disabled = false;
  qs("existingRackMode").disabled = false;
  updateInstanceIdFromInputs();
}

// ----- Mode UI -----
function applyCustomerModeUI(){
  const mode = qs("customerMode").value;

  qs("newCustomerFields").classList.toggle("hidden", mode !== "new");
  qs("existingCustomerFields").classList.toggle("hidden", mode !== "existing");
  qs("existingRoomWrap").classList.toggle("hidden", mode !== "existing");

  qs("step2NewFlow").classList.toggle("hidden", mode !== "new");
  qs("step2ExistingFlow").classList.toggle("hidden", mode !== "existing");

  if(mode === "existing"){
    qs("existingRoomPreview").value = qs("existingRoomInput").value.trim();
  }else{
    qs("existingRoomPreview").value = "";
  }

  updateInstanceIdFromInputs();
}

// ----- Save / Onboard -----
function buildSlotsPayload(port_count){
  return slotCodes(port_count).map(s=>{
    const st = state.slotStatus[s] || "missing";
    return {
      slot_code: s,
      has_cassette: (st !== "missing"),
      trunk_status: st
    };
  });
}

async function saveOnboard(){
  if (!(window.isAdminRole && window.isAdminRole())) {
    showSave("Nur Admin darf speichern.", true);
    return;
  }
  const mode = qs("customerMode").value;

  const rack_unit = Number(qs("rackUnit").value);
  const pp_label = qs("ppLabel").value.trim();
  const port_count = Number(qs("portCount").value);

  if(!rack_unit || rack_unit < 1) return showSave(`❌ RU fehlt (>=1)`, true);
  if(!pp_label) return showSave(`❌ Patchpanel Name fehlt`, true);

  const slots = buildSlotsPayload(port_count);

  showSave("Saving…", false);

  try{
    if(mode === "new"){
      const customer_name = qs("customerName").value.trim();
      const customer_code = qs("customerCode").value.trim() || null;
      const comment = qs("customerComment").value.trim() || null;

      const room = qs("roomInput").value.trim();
      const has_cage = qs("hasCage").value === "yes";
      const cage_name = has_cage ? (qs("cageName").value.trim() || null) : null;

      const rack_label = qs("rackLabel").value.trim();

      if(!customer_name) return showSave(`❌ Kundenname fehlt`, true);
      if(!room) return showSave(`❌ Raum fehlt`, true);
      if(has_cage && !cage_name) return showSave(`❌ Cage Name fehlt`, true);
      if(!rack_label) return showSave(`❌ Rack fehlt`, true);

      const payload = {
        customer_name,
        customer_code,
        comment,
        room,
        has_cage,
        cage_name,
        rack_label,
        rack_unit,
        pp_label: pp_label,
        port_count,
        slots
      };

      const res = await fetchJSON(API.onboardNew(), {
        method: "POST",
        headers: {"Content-Type":"application/json"},
        body: JSON.stringify(payload)
      });

      showSave(`✅ OK: ${res.message || "onboarded"} (pp_id=${res.patchpanel_id})`, false);
      return;
    }

    // EXISTING
    const room = qs("existingRoomInput").value.trim();
    const customer_id = Number(qs("existingCustomerSelect").value || 0);
    if(!room) return showSave(`❌ Room fehlt`, true);
    if(!customer_id) return showSave(`❌ Bitte Kunde auswählen`, true);

    const locVal = qs("existingLocationSelect").value;
    let location_id = null;

    let has_cage = false;
    let cage_name = null;

    if(!locVal){
      return showSave(`❌ Bitte Location wählen (oder + Neue Location)`, true);
    }

    if(locVal === "__NEW__"){
      has_cage = qs("existingHasCage").value === "yes";
      cage_name = has_cage ? (qs("existingCageName").value.trim() || null) : null;
      if(has_cage && !cage_name) return showSave(`❌ Cage Name fehlt`, true);
      location_id = null;
    }else{
      location_id = Number(locVal);
    }

    const rackMode = qs("existingRackMode").value;
    let rack_id = null;
    let rack_label = null;

    if(rackMode === "new"){
      rack_label = qs("existingRackLabel").value.trim();
      if(!rack_label) return showSave(`❌ Neues Rack Label fehlt`, true);
      rack_id = null;
    }else{
      rack_id = Number(qs("existingRackSelect").value || 0);
      if(!rack_id) return showSave(`❌ Bitte Rack auswählen (oder Rack Mode = Neues Rack)`, true);
      rack_label = null;
    }

    const payload = {
      room,
      customer_id,
      location_id,
      has_cage,
      cage_name,
      rack_id,
      rack_label,
      rack_unit,
      pp_label: pp_label,
      port_count,
      slots
    };

    const res = await fetchJSON(API.onboardExisting(), {
      method: "POST",
      headers: {"Content-Type":"application/json"},
      body: JSON.stringify(payload)
    });

    showSave(`✅ OK: ${res.message || "onboarded"} (pp_id=${res.patchpanel_id})`, false);

  }catch(e){
    showSave(`❌ Fehler: ${e.message}`, true);
  }
}

// ----- init -----
function resetAll(){
  state.step = 1;
  state.portCount = 48;
  state.slotStatus = {};

  // Step1 new fields
  qs("customerMode").value = "new";
  qs("customerName").value = "";
  qs("customerCode").value = "";
  qs("customerComment").value = "";

  // Step1 existing
  qs("existingRoomInput").value = "";
  qs("existingRoomPreview").value = "";
  qs("existingCustomerSearch").value = "";
  qs("existingCustomerSelect").innerHTML = `<option value="">— Bitte Room wählen —</option>`;
  qs("existingCustomerIdPreview").textContent = "-";

  // Step2 new
  qs("hasCage").value = "no";
  qs("cageName").value = "";
  qs("cageName").disabled = true;
  qs("rackLabel").value = "";
  qs("rackUnit").value = "1";
  qs("ppLabel").value = "";

  // Step2 existing
  qs("existingLocationSelect").innerHTML = `<option value="">— Bitte Kunde wählen —</option>`;
  qs("existingRackSelect").innerHTML = `<option value="">— Bitte Location wählen —</option>`;
  qs("existingRackSelect").disabled = true;
  qs("existingRackMode").value = "pick";
  qs("existingRackMode").disabled = true;
  qs("existingNewRackWrap").classList.add("hidden");
  qs("existingRackLabel").value = "";

  qs("existingNewLocationWrap").classList.add("hidden");
  qs("existingHasCage").value = "no";
  qs("existingCageName").value = "";
  qs("existingCageName").disabled = true;

  // Step3
  qs("portCount").value = "48";
  qs("enabledCassettesPreview").textContent = "-";
  qs("saveResult").textContent = "";
  qs("instanceId").value = "";

  applyCustomerModeUI();
  setStep(1);
  renderCassettes();
  updateInstanceIdFromInputs();
}

window.addEventListener("DOMContentLoaded", async ()=>{
  qs("resetBtn").addEventListener("click", resetAll);

  // NEW flow cage toggle
  qs("hasCage").addEventListener("change", ()=>{
    const has = qs("hasCage").value === "yes";
    qs("cageName").disabled = !has;
    if(!has) qs("cageName").value = "";
  });

  // EXISTING new location cage toggle
  qs("existingHasCage").addEventListener("change", ()=>{
    const has = qs("existingHasCage").value === "yes";
    qs("existingCageName").disabled = !has;
    if(!has) qs("existingCageName").value = "";
  });

  // mode switch
  qs("customerMode").addEventListener("change", async ()=>{
    applyCustomerModeUI();
    if(qs("customerMode").value === "existing"){
      if(!state.rooms.length) await loadRooms();
    }
  });

  // existing room -> load customers
  qs("existingRoomInput").addEventListener("change", async ()=>{
    qs("existingRoomPreview").value = qs("existingRoomInput").value.trim();
    await loadExistingCustomers();

    qs("existingLocationSelect").innerHTML = `<option value="">— Bitte Kunde wählen —</option>`;
    qs("existingRackSelect").innerHTML = `<option value="">— Bitte Location wählen —</option>`;
    qs("existingRackSelect").disabled = true;
    qs("existingRackMode").disabled = true;
    qs("existingNewRackWrap").classList.add("hidden");
    qs("existingRackLabel").value = "";
    qs("existingNewLocationWrap").classList.add("hidden");
  });

  qs("existingCustomerSearch").addEventListener("input", applyExistingCustomerFilter);

  qs("existingCustomerSelect").addEventListener("change", async ()=>{
    setExistingCustomerPreview();
    await loadExistingLocations();
  });

  qs("existingLocationSelect").addEventListener("change", async ()=>{
    const locVal = qs("existingLocationSelect").value;
    const isNew = (locVal === "__NEW__");
    qs("existingNewLocationWrap").classList.toggle("hidden", !isNew);

    if(!locVal){
      qs("existingRackSelect").disabled = true;
      qs("existingRackMode").disabled = true;
      qs("existingRackSelect").innerHTML = `<option value="">— Bitte Location wählen —</option>`;
      updateInstanceIdFromInputs();
      return;
    }

    if(isNew){
      qs("existingRackSelect").innerHTML = `<option value="">— Neues Rack anlegen (Rack Mode = Neues Rack) —</option>`;
      qs("existingRackSelect").disabled = true;
      qs("existingRackMode").disabled = false;
      qs("existingRackMode").value = "new";
      qs("existingNewRackWrap").classList.remove("hidden");
      updateInstanceIdFromInputs();
      return;
    }

    await loadExistingRacks();
  });

  qs("existingRackMode").addEventListener("change", ()=>{
    const m = qs("existingRackMode").value;
    qs("existingNewRackWrap").classList.toggle("hidden", m !== "new");
    updateInstanceIdFromInputs();
  });

  qs("existingRackSelect").addEventListener("change", updateInstanceIdFromInputs);
  qs("existingRackLabel").addEventListener("input", updateInstanceIdFromInputs);

  qs("rackLabel").addEventListener("input", updateInstanceIdFromInputs);
  qs("ppLabel").addEventListener("input", updateInstanceIdFromInputs);

  qs("portCount").addEventListener("change", ()=>{
    state.portCount = Number(qs("portCount").value);
    state.slotStatus = {};
    renderCassettes();
  });

  qs("step1Next").addEventListener("click", ()=>{
    const mode = qs("customerMode").value;

    if(mode === "new"){
      if(!qs("customerName").value.trim()){
        alert("Bitte Kundenname eingeben.");
        return;
      }
    }else{
      if(!qs("existingRoomInput").value.trim()){
        alert("Bitte Room wählen.");
        return;
      }
      if(!qs("existingCustomerSelect").value){
        alert("Bitte Kunde auswählen.");
        return;
      }
      qs("existingRoomPreview").value = qs("existingRoomInput").value.trim();
    }

    setStep(2);
    updateInstanceIdFromInputs();
  });

  qs("step2Back").addEventListener("click", ()=>setStep(1));

  qs("step2Next").addEventListener("click", ()=>{
    const mode = qs("customerMode").value;

    const ru = Number(qs("rackUnit").value);
    if(!ru || ru < 1){ alert("Bitte RU (>=1) eingeben."); return; }
    if(!qs("ppLabel").value.trim()){ alert("Bitte PP Label eingeben."); return; }

    if(mode === "new"){
      const room = qs("roomInput").value.trim();
      const rack = qs("rackLabel").value.trim();
      if(!room){ alert("Bitte Raum wählen / tippen."); return; }
      if(!rack){ alert("Bitte Rack tippen."); return; }
      if(qs("hasCage").value === "yes" && !qs("cageName").value.trim()){
        alert("Bitte Cage Name eingeben.");
        return;
      }
    }else{
      const room = qs("existingRoomInput").value.trim();
      if(!room){ alert("Bitte Room wählen."); return; }
      const loc = qs("existingLocationSelect").value;
      if(!loc){ alert("Bitte Location wählen."); return; }

      if(loc === "__NEW__"){
        if(qs("existingHasCage").value === "yes" && !qs("existingCageName").value.trim()){
          alert("Bitte Cage Name eingeben.");
          return;
        }
        if(qs("existingRackMode").value !== "new"){
          alert("Bei neuer Location: Bitte Rack Mode = Neues Rack wählen.");
          return;
        }
        if(!qs("existingRackLabel").value.trim()){
          alert("Bitte neues Rack Label eingeben.");
          return;
        }
      }else{
        if(qs("existingRackMode").value === "pick"){
          if(!qs("existingRackSelect").value){
            alert("Bitte Rack auswählen oder Rack Mode = Neues Rack.");
            return;
          }
        }else{
          if(!qs("existingRackLabel").value.trim()){
            alert("Bitte neues Rack Label eingeben.");
            return;
          }
        }
      }
    }

    setStep(3);
    renderCassettes();
  });

  qs("step3Back").addEventListener("click", ()=>setStep(2));
  qs("saveBtn").addEventListener("click", saveOnboard);

  resetAll();
  await loadRooms();
});
