// troubleshooting.js
// - Ergebnisse werden in der Datenbank gespeichert (nicht sessionStorage)
// - BB Panel-Filter: nur PPs aus dem gleichen Backbone-Raum
// - Edit-Modal mit Kassetten-Port-Grid + aktuellem Port vorausgewaehlt

(function () {
  'use strict';

  /* ── API endpoints ── */
  var API_TS       = (window.API_ROOT || '') + '/troubleshooting';
  var API_PP       = (window.API_PATCHPANELS || (window.API_ROOT || '') + '/patchpanels').replace(/\/+$/, '');
  var API_RACKVIEW = (window.API_RACKVIEW || (window.API_ROOT || '') + '/rackview').replace(/\/+$/, '');

  /* ── Constants (same as kw-planning) ── */
  var LETTERS   = ['A', 'B', 'C', 'D'];
  var POSITIONS = [1, 2, 3, 4, 5, 6];

  var currentType = 'ticket';

  // Accumulated search results: [{type, ticketNr, note, serial, data}]
  var resultList = [];

  // Edit state
  var editingEntry    = null;
  var edBbPanels      = [];
  var edSelectedBbIdx = -1;
  var edBbInInstanceId = '';
  var edBbInPortLabel  = '';
  var edBbInDbId       = null;
  var edBbOutInstanceId = '';
  var edBbOutPortLabel  = '';

  /* ── DOM refs ── */
  var btnTypeTicket     = document.getElementById('btnTypeTicket');
  var btnTypeNormal     = document.getElementById('btnTypeNormal');
  var fieldsTicket      = document.getElementById('fieldsTicket');
  var fieldsNormal      = document.getElementById('fieldsNormal');
  var inputTicketNr     = document.getElementById('inputTicketNr');
  var inputSerialTicket = document.getElementById('inputSerialTicket');
  var inputNote         = document.getElementById('inputNote');
  var inputSerialNormal = document.getElementById('inputSerialNormal');
  var btnSearchTicket   = document.getElementById('btnSearchTicket');
  var btnSearchNormal   = document.getElementById('btnSearchNormal');
  var resultArea        = document.getElementById('resultArea');
  var btnReport         = document.getElementById('btnReport');
  var modalEdit         = document.getElementById('modalEdit');
  var btnCancelEdit     = document.getElementById('btnCancelEdit');
  var btnSaveEdit       = document.getElementById('btnSaveEdit');

  /* ── Helpers ── */
  function $(id) { return document.getElementById(id); }

  function esc(v) {
    return String(v == null ? '' : v).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  function toast(msg, type) {
    var wrap = $('toastWrap'); if (!wrap) return;
    var el = document.createElement('div');
    el.className = 'toast toast-' + (type || 'info');
    el.textContent = msg;
    wrap.appendChild(el);
    setTimeout(function () { el.classList.add('show'); }, 30);
    setTimeout(function () {
      el.classList.remove('show');
      setTimeout(function () { el.remove(); }, 350);
    }, 4000);
  }

  function authHeaders(extra) {
    var h = Object.assign({ 'Content-Type': 'application/json' }, extra || {});
    var token = localStorage.getItem('authToken') || sessionStorage.getItem('authToken');
    if (token) h['Authorization'] = 'Bearer ' + token;
    return h;
  }

  function apiJson(url, opts) {
    return fetch(url, opts).then(function (res) {
      return res.json().then(function (data) {
        if (!res.ok) throw new Error(data.detail || 'HTTP ' + res.status);
        return data;
      });
    });
  }

  /* ══════════════════════════════════════════
     DB PERSISTENCE — save / load / remove work lines
     ══════════════════════════════════════════ */
  function dbSaveWorkline(entry) {
    return fetch(API_TS + '/worklines', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({
        cross_connect_id: entry.data.id,
        serial_number: entry.serial,
        troubleshoot_type: entry.type,
        ticket_number: entry.ticketNr || '',
        note: entry.note || '',
        cc_data: entry.data
      })
    }).then(function (res) {
      return res.json().then(function (data) {
        if (!res.ok && res.status !== 409) {
          throw new Error(data.detail || 'HTTP ' + res.status);
        }
        return data;
      });
    });
  }

  function dbRemoveWorkline(ccId) {
    return fetch(API_TS + '/worklines/' + ccId, {
      method: 'DELETE',
      headers: authHeaders()
    }).then(function () { saveFallbackList(); })
      .catch(function () { saveFallbackList(); });
  }

  function dbLoadWorklines() {
    return apiJson(API_TS + '/worklines', { headers: authHeaders() })
      .then(function (res) {
        var items = res.items || [];
        if (items.length) {
          // DB is the single source of truth
          resultList = items.map(function (row) {
            return {
              type: row.troubleshoot_type || 'normal',
              ticketNr: row.ticket_number || '',
              note: row.note || '',
              serial: row.serial_number || '',
              data: row.cc_data || {}
            };
          });
          saveFallbackList();
        } else {
          // DB is empty — clear local list too
          resultList = [];
          saveFallbackList();
        }
        renderResults();
      })
      .catch(function () {
        // API failed — use localStorage as fallback
        loadFallbackList();
        renderResults();
      });
  }

  // localStorage fallback for when API is unreachable
  function saveFallbackList() {
    try { localStorage.setItem('ts_resultList', JSON.stringify(resultList)); } catch(e) {}
  }
  function loadFallbackList() {
    try {
      var raw = localStorage.getItem('ts_resultList');
      if (raw) resultList = JSON.parse(raw);
    } catch(e) { resultList = []; }
  }

  /* ══════════════════════════════════════════
     TYPE TOGGLE (results persist!)
     ══════════════════════════════════════════ */
  function setType(type) {
    currentType = type;
    btnTypeTicket.classList.toggle('active', type === 'ticket');
    btnTypeNormal.classList.toggle('active', type === 'normal');
    fieldsTicket.classList.toggle('visible', type === 'ticket');
    fieldsNormal.classList.toggle('visible', type === 'normal');
    sessionStorage.setItem('ts_currentType', type);
  }
  btnTypeTicket.addEventListener('click', function () { setType('ticket'); });
  btnTypeNormal.addEventListener('click', function () { setType('normal'); });

  /* ── Persist input fields across page navigation ── */
  function saveInputs() {
    sessionStorage.setItem('ts_ticketNr', inputTicketNr.value || '');
    sessionStorage.setItem('ts_note', inputNote.value || '');
    sessionStorage.setItem('ts_serialTicket', inputSerialTicket.value || '');
    sessionStorage.setItem('ts_serialNormal', inputSerialNormal.value || '');
  }
  function restoreInputs() {
    var savedType = sessionStorage.getItem('ts_currentType');
    if (savedType === 'ticket' || savedType === 'normal') setType(savedType);
    inputTicketNr.value = sessionStorage.getItem('ts_ticketNr') || '';
    inputNote.value = sessionStorage.getItem('ts_note') || '';
    inputSerialTicket.value = sessionStorage.getItem('ts_serialTicket') || '';
    inputSerialNormal.value = sessionStorage.getItem('ts_serialNormal') || '';
  }
  // Save on every input change
  inputTicketNr.addEventListener('input', saveInputs);
  inputNote.addEventListener('input', saveInputs);
  inputSerialTicket.addEventListener('input', saveInputs);
  inputSerialNormal.addEventListener('input', saveInputs);
  // Restore on page load
  restoreInputs();

  /* ══════════════════════════════════════════
     SEARCH (accumulate results)
     ══════════════════════════════════════════ */
  function doSearch(serial) {
    serial = (serial || '').trim();
    if (!serial) { toast('Bitte Serial Number eingeben.', 'warn'); return; }

    var type = currentType;
    var ticketNr = (type === 'ticket') ? inputTicketNr.value.trim() : '';
    var note = (type === 'normal') ? inputNote.value.trim() : '';

    if (type === 'ticket' && !ticketNr) {
      toast('Bitte Troubleticket-Nummer eingeben.', 'warn'); return;
    }

    fetch(API_TS + '/search?serial=' + encodeURIComponent(serial), { headers: authHeaders() })
      .then(function (r) {
        if (!r.ok) return r.json().then(function (j) { throw new Error(j.detail || 'Fehler'); });
        return r.json();
      })
      .then(function (json) {
        if (!json.success || !json.data) return;
        var exists = resultList.some(function (e) { return e.data.id === json.data.id; });
        if (exists) return;
        var entry = { type: type, ticketNr: ticketNr, note: note, serial: serial, data: json.data };
        // Save to DB first, then add to local list
        dbSaveWorkline(entry).then(function () {
          resultList.push(entry);
          saveFallbackList();
          renderResults();
          // Clear inputs after successful add
          inputTicketNr.value = '';
          inputNote.value = '';
          inputSerialTicket.value = '';
          inputSerialNormal.value = '';
          saveInputs();
        }).catch(function (err) {
          // Still add locally as fallback
          resultList.push(entry);
          saveFallbackList();
          renderResults();
        });
      })
      .catch(function (err) { });
  }

  btnSearchTicket.addEventListener('click', function () { doSearch(inputSerialTicket.value); });
  btnSearchNormal.addEventListener('click', function () { doSearch(inputSerialNormal.value); });
  inputSerialTicket.addEventListener('keydown', function (e) { if (e.key === 'Enter') btnSearchTicket.click(); });
  inputSerialNormal.addEventListener('keydown', function (e) { if (e.key === 'Enter') btnSearchNormal.click(); });

  /* ══════════════════════════════════════════
     RENDER ACCUMULATED RESULTS
     ══════════════════════════════════════════ */
  function renderResults() {
    resultArea.innerHTML = '';
    if (!resultList.length) return;

    var tickets = resultList.filter(function (e) { return e.type === 'ticket'; });
    var normals = resultList.filter(function (e) { return e.type === 'normal'; });

    if (tickets.length) resultArea.appendChild(buildResultSection('ticket', 'Troubleticket', tickets));
    if (normals.length) resultArea.appendChild(buildResultSection('normal', 'Normales Troubleshooting', normals));
  }

  function buildResultSection(type, title, entries) {
    var section = document.createElement('div');
    section.className = 'card ts-result-section';

    var heading = document.createElement('div');
    heading.className = 'ts-result-heading';
    heading.innerHTML = '<span class="type-pill ' + type + '">' + esc(title) + '</span>' +
                        '<span class="heading-text">' + entries.length + ' Leitung' + (entries.length > 1 ? 'en' : '') + '</span>';
    section.appendChild(heading);

    var tableWrap = document.createElement('div');
    tableWrap.className = 'table-scroll';
    var table = document.createElement('table');
    table.className = 'ts-result-table';
    table.innerHTML =
      '<thead><tr>' +
      '<th>Serial</th>' +
      (type === 'ticket' ? '<th>Ticket-Nr</th>' : '<th>Notiz</th>') +
      '<th>A-Seite</th><th>Z-Seite</th><th>BB IN</th><th>BB OUT</th><th>Status</th><th style="width:140px;"></th>' +
      '</tr></thead>';

    var tbody = document.createElement('tbody');
    entries.forEach(function (entry) {
      var d = entry.data;
      var tr = document.createElement('tr');
      var meta = (type === 'ticket') ? esc(entry.ticketNr) : esc((entry.note || '').substring(0, 40));

      tr.innerHTML =
        '<td>' + esc(d.serial || d.serial_number || '\u2014') + '</td>' +
        '<td>' + meta + '</td>' +
        '<td>' + esc(d.a_patchpanel_id || '\u2014') + '<div class="cell-sub">' + esc(d.a_port_label || '') + '</div></td>' +
        '<td>' + esc(d.customer_patchpanel_instance_id || String(d.customer_patchpanel_id || '\u2014')) +
          '<div class="cell-sub">' + esc(d.customer_port_label || '') + '</div></td>' +
        '<td>' + esc(d.backbone_in_instance_id || '\u2014') + '<div class="cell-sub">' + esc(d.backbone_in_port_label || '') + '</div></td>' +
        '<td>' + esc(d.backbone_out_instance_id || '\u2014') + '<div class="cell-sub">' + esc(d.backbone_out_port_label || '') + '</div></td>' +
        '<td><span class="badge badge-' + esc(d.status || '') + '">' + esc(d.status || '\u2014') + '</span></td>' +
        '<td></td>';

      var actionCell = tr.querySelector('td:last-child');
      var btnEdit = document.createElement('button');
      btnEdit.className = 'btn-edit-line';
      btnEdit.innerHTML = '&#9998; Bearbeiten';
      btnEdit.addEventListener('click', function () { openEdit(entry); });
      actionCell.appendChild(btnEdit);

      var btnRemove = document.createElement('button');
      btnRemove.className = 'btn-remove-line';
      btnRemove.textContent = '\u2715';
      btnRemove.title = 'Aus Liste entfernen';
      btnRemove.addEventListener('click', function () {
        var ccId = entry.data.id;
        var i = resultList.indexOf(entry);
        if (i >= 0) resultList.splice(i, 1);
        saveFallbackList();
        renderResults();
        dbRemoveWorkline(ccId).then(function () {
          // Confirm removal succeeded
          saveFallbackList();
        }).catch(function () {
          // If DB delete failed, keep local state (already removed)
          saveFallbackList();
        });
      });
      actionCell.appendChild(btnRemove);

      tbody.appendChild(tr);
    });

    table.appendChild(tbody);
    tableWrap.appendChild(table);
    section.appendChild(tableWrap);
    return section;
  }

  /* ══════════════════════════════════════════
     PORT GRID RENDERER (cassette layout, same as KW Planning)
     ══════════════════════════════════════════ */
  function renderPortGrid(container, ports, onPick, selectedLabel) {
    container.innerHTML = '';
    if (!ports || !ports.length) {
      container.innerHTML = '<div class="small muted">Keine Ports gefunden.</div>';
      return;
    }

    var map = new Map();
    ports.forEach(function (p) { map.set(String(p.port_label || ''), p); });

    // Auto-activate cassettes
    var occCassettes = new Set();
    map.forEach(function (p, label) {
      if (p.occupied || p.status === 'occupied' || p.connected_to) {
        var cm = String(label).match(/^(\d+[A-D])\d+$/);
        if (cm) occCassettes.add(cm[1]);
      }
    });
    if (occCassettes.size) {
      map.forEach(function (p, label) {
        if (String(p.status || '').toLowerCase() === 'unavailable') {
          var cm = String(label).match(/^(\d+[A-D])\d+$/);
          if (cm && occCassettes.has(cm[1])) p.status = 'free';
        }
      });
    }

    var maxRow = 0;
    map.forEach(function (_p, label) {
      var m = String(label).match(/^(\d+)[A-D]\d+$/);
      if (m) maxRow = Math.max(maxRow, Number(m[1]));
    });

    // Flat grid for simple numeric ports
    if (!maxRow) {
      var wrap = document.createElement('div');
      wrap.className = 'ports-grid';
      var sorted = [];
      map.forEach(function (p, label) { sorted.push([label, p]); });
      sorted.sort(function (a, b) { return (parseInt(a[0]) || 0) - (parseInt(b[0]) || 0) || a[0].localeCompare(b[0]); });
      sorted.forEach(function (pair) {
        wrap.appendChild(makePortBtn(pair[0], pair[1], onPick, selectedLabel));
      });
      container.appendChild(wrap);
      return;
    }

    // Cassette layout
    for (var row = 1; row <= maxRow; row++) {
      var rowDiv = document.createElement('div');
      rowDiv.className = 'cassette-row';
      for (var li = 0; li < LETTERS.length; li++) {
        var letter = LETTERS[li];
        var card = document.createElement('div');
        card.className = 'cassette';
        var hdr = document.createElement('h4');
        hdr.textContent = 'Kassette ' + row + letter;
        card.appendChild(hdr);
        var grid = document.createElement('div');
        grid.className = 'ports-grid';
        for (var pi = 0; pi < POSITIONS.length; pi++) {
          var label = '' + row + letter + POSITIONS[pi];
          var p = map.get(label);
          grid.appendChild(makePortBtn(label, p, onPick, selectedLabel));
        }
        card.appendChild(grid);
        rowDiv.appendChild(card);
      }
      container.appendChild(rowDiv);
    }
  }

  function makePortBtn(label, port, onPick, selectedLabel) {
    var btn = document.createElement('button');
    btn.className = 'pbtn';
    btn.textContent = label;
    btn.type = 'button';

    if (!port) { btn.classList.add('na'); btn.disabled = true; return btn; }

    var isOcc = port.occupied || port.status === 'occupied';
    var isSel = selectedLabel && label === selectedLabel;

    if (isOcc && !isSel) {
      btn.classList.add('occ');
      var occInfo = ((port.serial || '') + ' ' + (port.customer || '')).trim();
      btn.title = 'Belegt: ' + occInfo;
      btn.disabled = true;
    } else if (port.status === 'unavailable') {
      btn.classList.add('na'); btn.disabled = true;
    } else {
      btn.classList.add('free');
      btn.addEventListener('click', function () { onPick(label); });
    }

    if (isSel) {
      btn.classList.add('sel');
      if (isOcc) btn.classList.add('occ');
    }
    return btn;
  }

  /* ══════════════════════════════════════════
     EDIT MODAL — open with cassette grid
     ══════════════════════════════════════════ */
  function openEdit(entry) {
    editingEntry = entry;
    edBbPanels = [];
    edSelectedBbIdx = -1;
    edBbInInstanceId = '';
    edBbInPortLabel = '';
    edBbInDbId = null;
    edBbOutInstanceId = '';
    edBbOutPortLabel = '';

    var d = entry.data;

    // Type pill
    var pill = $('edTypePill');
    pill.className = 'type-pill ' + entry.type;
    pill.textContent = (entry.type === 'ticket') ? 'Troubleticket' : 'Troubleshooting';

    // Grunddaten
    $('edSerial').value = d.serial || d.serial_number || '';
    $('edStatus').value = d.status || '';

    // A-Seite
    $('edSwitchName').value = d.switch_name || '';
    $('edSwitchPort').value = d.switch_port || '';
    $('edAsidePP').value = d.a_patchpanel_id || '';
    $('edAsidePort').value = d.a_port_label || '';

    // Z-Seite
    $('edZsidePP').value = d.customer_patchpanel_instance_id || String(d.customer_patchpanel_id || '');
    $('edZsidePort').value = d.customer_port_label || '';
    $('edZRoom').value = d.customer_room || '';

    // Clear BB sections
    $('edBbInCards').innerHTML = '';
    $('edBbInPortGrid').innerHTML = '';
    $('edBbInPortLabel').style.display = 'none';
    $('edBbOutResult').style.display = 'none';
    $('edBbOutResult').innerHTML = '';
    $('edBbInHint').textContent = 'BB IN Patchpanels werden geladen...';

    modalEdit.classList.add('show');

    // Derive customer room to load BB panels
    var customerRoom = d.customer_room || '';
    if (!customerRoom) {
      var ppId = d.customer_patchpanel_instance_id || '';
      if (ppId) {
        var m = ppId.match(/M([\d.]+[A-Za-z]*\d*)/i);
        if (m) customerRoom = m[1];
      }
    }

    if (customerRoom) {
      loadBBPanels(customerRoom);
    } else {
      $('edBbInHint').textContent = 'Kundenraum konnte nicht ermittelt werden.';
    }
  }

  /* ── Load BB IN panels for customer room ── */
  function loadBBPanels(customerRoom) {
    $('edBbInHint').textContent = 'BB IN PPs die Richtung Raum ' + customerRoom + ' gehen:';

    var curBbInId   = (editingEntry && editingEntry.data.backbone_in_instance_id) || '';
    var curBbInPort = (editingEntry && editingEntry.data.backbone_in_port_label) || '';

    // Pass bb_instance_id so the backend filters to the same backbone room
    var url = API_RACKVIEW + '/bb-panels-for-customer-room?customer_room=' + encodeURIComponent(customerRoom);
    if (curBbInId) {
      url += '&bb_instance_id=' + encodeURIComponent(curBbInId);
    }

    apiJson(url)
      .then(function (data) {
        var items = data.items || [];
        edBbPanels = items;
        if (!items.length) {
          $('edBbInHint').textContent = 'Keine BB IN PPs gefunden fuer Raum ' + customerRoom + '.';
          return;
        }
        renderBBCards();

        // Auto-select the current BB IN panel and port
        if (curBbInId) {
          var matchIdx = -1;
          for (var i = 0; i < edBbPanels.length; i++) {
            if (edBbPanels[i].bb_instance_id === curBbInId) { matchIdx = i; break; }
          }
          if (matchIdx >= 0) {
            selectBBPanel(matchIdx, curBbInPort);
          }
        }
      })
      .catch(function (err) {
        $('edBbInHint').textContent = 'Fehler beim Laden: ' + err.message;
      });
  }

  /* ── Render BB IN panel cards ── */
  function renderBBCards() {
    var cardsEl = $('edBbInCards');
    cardsEl.innerHTML = '';

    for (var i = 0; i < edBbPanels.length; i++) {
      (function (idx) {
        var p = edBbPanels[idx];
        var card = document.createElement('div');
        card.className = 'bb-card' + (idx === edSelectedBbIdx ? ' selected' : '');
        card.innerHTML = '<div>' + esc(p.bb_instance_id) + '</div><div class="bb-label">' + esc(p.bb_room || '') + ' \u2192 ' + esc(p.peer_room || '') + '</div>';
        card.addEventListener('click', function () { selectBBPanel(idx); });
        cardsEl.appendChild(card);
      })(i);
    }
  }

  /* ── Select BB panel and load port grid ── */
  function selectBBPanel(idx, preSelectPort) {
    edSelectedBbIdx = idx;
    edBbInPortLabel = '';
    edBbOutInstanceId = '';
    edBbOutPortLabel = '';

    var panel = edBbPanels[idx];
    edBbInDbId = panel.bb_db_id;
    edBbInInstanceId = panel.bb_instance_id;

    renderBBCards();

    $('edBbOutResult').style.display = 'none';
    $('edBbOutResult').innerHTML = '';
    $('edBbInPortLabel').style.display = 'none';

    apiJson(API_PP + '/' + panel.bb_db_id + '/ports')
      .then(function (data) {
        var ports = data.ports || [];
        var gridEl = $('edBbInPortGrid');
        var lblEl  = $('edBbInPortLabel');

        function pickBbPort(label) {
          edBbInPortLabel = label;
          lblEl.textContent = 'Gewaehlt: ' + panel.bb_instance_id + ' / Port ' + label;
          lblEl.style.display = 'block';
          renderPortGrid(gridEl, ports, pickBbPort, label);
          resolveBBOut(panel.bb_instance_id, label);
        }

        if (preSelectPort) {
          pickBbPort(preSelectPort);
        } else {
          renderPortGrid(gridEl, ports, pickBbPort, null);
        }
      })
      .catch(function (err) {
        $('edBbInPortGrid').innerHTML = '<div class="small" style="color:#ef5350;">' + esc(err.message) + '</div>';
      });
  }

  /* ── Resolve BB OUT via peer lookup ── */
  function resolveBBOut(bbInInstanceId, bbInPortLabel) {
    var box = $('edBbOutResult');
    edBbOutInstanceId = '';
    edBbOutPortLabel = '';

    if (!bbInInstanceId || !bbInPortLabel) { box.style.display = 'none'; return; }

    apiJson(API_RACKVIEW + '/patchpanel-peer?instance_id=' + encodeURIComponent(bbInInstanceId) + '&port_label=' + encodeURIComponent(bbInPortLabel))
      .then(function (data) {
        if (data.peer_instance_id && data.peer_port_label) {
          edBbOutInstanceId = data.peer_instance_id;
          edBbOutPortLabel = data.peer_port_label;
          box.style.display = 'block';
          box.innerHTML = '<div class="af-grid">' +
            '<div><div class="af-label">BB OUT Panel</div><div class="af-val">' + esc(data.peer_instance_id) + '</div></div>' +
            '<div><div class="af-label">BB OUT Port</div><div class="af-val">' + esc(data.peer_port_label) + '</div></div>' +
            '<div><div class="af-label">Raum</div><div class="af-val">' + esc(data.peer_room || '-') + '</div></div>' +
            '</div>';
        } else {
          box.style.display = 'block';
          box.innerHTML = '<span style="color:#ffb74d;">Kein Peer gefunden fuer diesen Port.</span>';
        }
      })
      .catch(function (err) {
        box.style.display = 'block';
        box.innerHTML = '<span style="color:#ef5350;">' + esc(err.message) + '</span>';
      });
  }

  /* ══════════════════════════════════════════
     CLOSE EDIT MODAL
     ══════════════════════════════════════════ */
  btnCancelEdit.addEventListener('click', function () {
    modalEdit.classList.remove('show');
    editingEntry = null;
  });
  modalEdit.addEventListener('click', function (e) {
    if (e.target === modalEdit) { modalEdit.classList.remove('show'); editingEntry = null; }
  });

  /* ══════════════════════════════════════════
     SAVE
     ══════════════════════════════════════════ */
  btnSaveEdit.addEventListener('click', function () {
    if (!editingEntry) return;

    if (!edBbInInstanceId || !edBbInPortLabel) {
      toast('Bitte BB IN Patchpanel und Port auswaehlen.', 'warn'); return;
    }
    if (!edBbOutInstanceId || !edBbOutPortLabel) {
      toast('BB OUT konnte nicht aufgeloest werden. Bitte BB IN pruefen.', 'warn'); return;
    }

    var payload = {
      backbone_in_instance_id: edBbInInstanceId,
      backbone_in_port_label: edBbInPortLabel,
      backbone_out_instance_id: edBbOutInstanceId,
      backbone_out_port_label: edBbOutPortLabel,
      troubleshoot_type: editingEntry.type
    };

    if (editingEntry.type === 'ticket') {
      payload.ticket_number = editingEntry.ticketNr;
      if (!payload.ticket_number) { toast('Troubleticket-Nummer fehlt.', 'warn'); return; }
    } else {
      payload.note = editingEntry.note || '';
    }

    btnSaveEdit.disabled = true;
    btnSaveEdit.textContent = 'Speichere...';

    fetch(API_TS + '/update-bb/' + editingEntry.data.id, {
      method: 'PATCH',
      headers: authHeaders(),
      body: JSON.stringify(payload)
    })
      .then(function (r) {
        if (!r.ok) return r.json().then(function (j) { throw new Error(j.detail || 'Fehler'); });
        return r.json();
      })
      .then(function () {
        toast('BB-Weg erfolgreich aktualisiert!', 'success');
        modalEdit.classList.remove('show');

        // Remove from result list + DB
        var ccId = editingEntry.data.id;
        var i = resultList.indexOf(editingEntry);
        if (i >= 0) resultList.splice(i, 1);
        saveFallbackList();
        renderResults();
        dbRemoveWorkline(ccId).catch(function () {});
        editingEntry = null;
      })
      .catch(function (err) {
        toast(err.message || 'Speichern fehlgeschlagen.', 'error');
      })
      .finally(function () {
        btnSaveEdit.disabled = false;
        btnSaveEdit.textContent = 'Speichern';
      });
  });

  /* ══════════════════════════════════════════
     REPORT DOWNLOAD
     ══════════════════════════════════════════ */
  btnReport.addEventListener('click', function () {
    var token = localStorage.getItem('authToken') || sessionStorage.getItem('authToken');
    var xhr = new XMLHttpRequest();
    xhr.open('GET', API_TS + '/report', true);
    xhr.responseType = 'blob';
    if (token) xhr.setRequestHeader('Authorization', 'Bearer ' + token);
    xhr.onload = function () {
      if (xhr.status === 200) {
        var blob = xhr.response;
        var url = window.URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url;
        var disposition = xhr.getResponseHeader('Content-Disposition');
        var filename = 'Troubleshooting_Report.xlsx';
        if (disposition) {
          var match = disposition.match(/filename="?([^";\s]+)"?/);
          if (match) filename = match[1];
        }
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
        window.URL.revokeObjectURL(url);
        toast('Report heruntergeladen.', 'success');
      } else {
        toast('Report-Download fehlgeschlagen.', 'error');
      }
    };
    xhr.onerror = function () { toast('Report-Download fehlgeschlagen.', 'error'); };
    xhr.send();
  });

  /* ── Init: load worklines from DB ── */
  dbLoadWorklines();

  /* ── Presence ── */
  if (window.setPresenceAction) window.setPresenceAction('Troubleshooting geoeffnet');

})();
// troubleshooting.js
// Frontend-Logik fuer die Troubleshooting-Seite
// - Suchergebnisse bleiben beim Typ-Wechsel erhalten
// - Edit-Modal mit Kassetten-Port-Grid (identisch zu KW Planung)

(function () {
  'use strict';

  /* ── API endpoints ── */
  var API_TS       = (window.API_ROOT || '') + '/troubleshooting';
  var API_PP       = (window.API_PATCHPANELS || (window.API_ROOT || '') + '/patchpanels').replace(/\/+$/, '');
  var API_RACKVIEW = (window.API_RACKVIEW || (window.API_ROOT || '') + '/rackview').replace(/\/+$/, '');

  /* ── Constants (same as kw-planning) ── */
  var LETTERS   = ['A', 'B', 'C', 'D'];
  var POSITIONS = [1, 2, 3, 4, 5, 6];

  var currentType = 'ticket';

  // Accumulated search results: [{type, ticketNr, note, serial, data}]
  // Persisted in sessionStorage so they survive page navigation
  var resultList = [];

  function saveResultList() {
    try { sessionStorage.setItem('ts_resultList', JSON.stringify(resultList)); } catch(e) {}
  }
  function loadResultList() {
    try {
      var raw = sessionStorage.getItem('ts_resultList');
      if (raw) resultList = JSON.parse(raw);
    } catch(e) { resultList = []; }
  }

  // Edit state
  var editingEntry  = null;
  var edBbPanels    = [];
  var edSelectedBbIdx = -1;
  var edBbInInstanceId = '';
  var edBbInPortLabel  = '';
  var edBbInDbId       = null;
  var edBbOutInstanceId = '';
  var edBbOutPortLabel  = '';

  /* ── DOM refs ── */
  var btnTypeTicket     = document.getElementById('btnTypeTicket');
  var btnTypeNormal     = document.getElementById('btnTypeNormal');
  var fieldsTicket      = document.getElementById('fieldsTicket');
  var fieldsNormal      = document.getElementById('fieldsNormal');
  var inputTicketNr     = document.getElementById('inputTicketNr');
  var inputSerialTicket = document.getElementById('inputSerialTicket');
  var inputNote         = document.getElementById('inputNote');
  var inputSerialNormal = document.getElementById('inputSerialNormal');
  var btnSearchTicket   = document.getElementById('btnSearchTicket');
  var btnSearchNormal   = document.getElementById('btnSearchNormal');
  var resultArea        = document.getElementById('resultArea');
  var btnReport         = document.getElementById('btnReport');
  var modalEdit         = document.getElementById('modalEdit');
  var btnCancelEdit     = document.getElementById('btnCancelEdit');
  var btnSaveEdit       = document.getElementById('btnSaveEdit');

  /* ── Helpers ── */
  function $(id) { return document.getElementById(id); }

  function esc(v) {
    return String(v == null ? '' : v).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  function toast(msg, type) {
    var wrap = $('toastWrap'); if (!wrap) return;
    var el = document.createElement('div');
    el.className = 'toast toast-' + (type || 'info');
    el.textContent = msg;
    wrap.appendChild(el);
    setTimeout(function () { el.classList.add('show'); }, 30);
    setTimeout(function () {
      el.classList.remove('show');
      setTimeout(function () { el.remove(); }, 350);
    }, 4000);
  }

  function authHeaders(extra) {
    var h = Object.assign({ 'Content-Type': 'application/json' }, extra || {});
    var token = localStorage.getItem('authToken') || sessionStorage.getItem('authToken');
    if (token) h['Authorization'] = 'Bearer ' + token;
    return h;
  }

  function apiJson(url, opts) {
    return fetch(url, opts).then(function (res) {
      return res.json().then(function (data) {
        if (!res.ok) throw new Error(data.detail || 'HTTP ' + res.status);
        return data;
      });
    });
  }

  /* ══════════════════════════════════════════
     TYPE TOGGLE (results persist!)
     ══════════════════════════════════════════ */
  function setType(type) {
    currentType = type;
    btnTypeTicket.classList.toggle('active', type === 'ticket');
    btnTypeNormal.classList.toggle('active', type === 'normal');
    fieldsTicket.classList.toggle('visible', type === 'ticket');
    fieldsNormal.classList.toggle('visible', type === 'normal');
    // DO NOT clear resultList — results persist across type switch
  }
  btnTypeTicket.addEventListener('click', function () { setType('ticket'); });
  btnTypeNormal.addEventListener('click', function () { setType('normal'); });

  /* ══════════════════════════════════════════
     SEARCH (accumulate results)
     ══════════════════════════════════════════ */
  function doSearch(serial) {
    serial = (serial || '').trim();
    if (!serial) { toast('Bitte Serial Number eingeben.', 'warn'); return; }

    var type = currentType;
    var ticketNr = (type === 'ticket') ? inputTicketNr.value.trim() : '';
    var note = (type === 'normal') ? inputNote.value.trim() : '';

    if (type === 'ticket' && !ticketNr) {
      toast('Bitte Troubleticket-Nummer eingeben.', 'warn'); return;
    }

    fetch(API_TS + '/search?serial=' + encodeURIComponent(serial), { headers: authHeaders() })
      .then(function (r) {
        if (!r.ok) return r.json().then(function (j) { throw new Error(j.detail || 'Fehler'); });
        return r.json();
      })
      .then(function (json) {
        if (!json.success || !json.data) { toast('Keine aktive Leitung gefunden.', 'warn'); return; }
        var exists = resultList.some(function (e) { return e.data.id === json.data.id; });
        if (exists) { toast('Diese Leitung ist bereits in der Liste.', 'warn'); return; }
        resultList.push({ type: type, ticketNr: ticketNr, note: note, serial: serial, data: json.data });
        saveResultList();
        renderResults();
        toast('Leitung hinzugefuegt.', 'success');
      })
      .catch(function (err) { toast(err.message || 'Suche fehlgeschlagen.', 'error'); });
  }

  btnSearchTicket.addEventListener('click', function () { doSearch(inputSerialTicket.value); });
  btnSearchNormal.addEventListener('click', function () { doSearch(inputSerialNormal.value); });
  inputSerialTicket.addEventListener('keydown', function (e) { if (e.key === 'Enter') btnSearchTicket.click(); });
  inputSerialNormal.addEventListener('keydown', function (e) { if (e.key === 'Enter') btnSearchNormal.click(); });

  /* ══════════════════════════════════════════
     RENDER ACCUMULATED RESULTS
     ══════════════════════════════════════════ */
  function renderResults() {
    resultArea.innerHTML = '';
    if (!resultList.length) return;

    var tickets = resultList.filter(function (e) { return e.type === 'ticket'; });
    var normals = resultList.filter(function (e) { return e.type === 'normal'; });

    if (tickets.length) resultArea.appendChild(buildResultSection('ticket', 'Troubleticket', tickets));
    if (normals.length) resultArea.appendChild(buildResultSection('normal', 'Normales Troubleshooting', normals));
  }

  function buildResultSection(type, title, entries) {
    var section = document.createElement('div');
    section.className = 'card ts-result-section';

    var heading = document.createElement('div');
    heading.className = 'ts-result-heading';
    heading.innerHTML = '<span class="type-pill ' + type + '">' + esc(title) + '</span>' +
                        '<span class="heading-text">' + entries.length + ' Leitung' + (entries.length > 1 ? 'en' : '') + '</span>';
    section.appendChild(heading);

    var tableWrap = document.createElement('div');
    tableWrap.className = 'table-scroll';
    var table = document.createElement('table');
    table.className = 'ts-result-table';
    table.innerHTML =
      '<thead><tr>' +
      '<th>Serial</th>' +
      (type === 'ticket' ? '<th>Ticket-Nr</th>' : '<th>Notiz</th>') +
      '<th>A-Seite</th><th>Z-Seite</th><th>BB IN</th><th>BB OUT</th><th>Status</th><th style="width:140px;"></th>' +
      '</tr></thead>';

    var tbody = document.createElement('tbody');
    entries.forEach(function (entry) {
      var d = entry.data;
      var tr = document.createElement('tr');
      var meta = (type === 'ticket') ? esc(entry.ticketNr) : esc((entry.note || '').substring(0, 40));

      tr.innerHTML =
        '<td>' + esc(d.serial || d.serial_number || '\u2014') + '</td>' +
        '<td>' + meta + '</td>' +
        '<td>' + esc(d.a_patchpanel_id || '\u2014') + '<div class="cell-sub">' + esc(d.a_port_label || '') + '</div></td>' +
        '<td>' + esc(d.customer_patchpanel_instance_id || String(d.customer_patchpanel_id || '\u2014')) +
          '<div class="cell-sub">' + esc(d.customer_port_label || '') + '</div></td>' +
        '<td>' + esc(d.backbone_in_instance_id || '\u2014') + '<div class="cell-sub">' + esc(d.backbone_in_port_label || '') + '</div></td>' +
        '<td>' + esc(d.backbone_out_instance_id || '\u2014') + '<div class="cell-sub">' + esc(d.backbone_out_port_label || '') + '</div></td>' +
        '<td><span class="badge badge-' + esc(d.status || '') + '">' + esc(d.status || '\u2014') + '</span></td>' +
        '<td></td>';

      var actionCell = tr.querySelector('td:last-child');
      var btnEdit = document.createElement('button');
      btnEdit.className = 'btn-edit-line';
      btnEdit.innerHTML = '&#9998; Bearbeiten';
      btnEdit.addEventListener('click', function () { openEdit(entry); });
      actionCell.appendChild(btnEdit);

      var btnRemove = document.createElement('button');
      btnRemove.className = 'btn-remove-line';
      btnRemove.textContent = '\u2715';
      btnRemove.title = 'Aus Liste entfernen';
      btnRemove.addEventListener('click', function () {
        var i = resultList.indexOf(entry);
        if (i >= 0) resultList.splice(i, 1);
        saveResultList();
        renderResults();
      });
      actionCell.appendChild(btnRemove);

      tbody.appendChild(tr);
    });

    table.appendChild(tbody);
    tableWrap.appendChild(table);
    section.appendChild(tableWrap);
    return section;
  }

  /* ══════════════════════════════════════════
     PORT GRID RENDERER (cassette layout, same as KW Planning)
     ══════════════════════════════════════════ */
  function renderPortGrid(container, ports, onPick, selectedLabel) {
    container.innerHTML = '';
    if (!ports || !ports.length) {
      container.innerHTML = '<div class="small muted">Keine Ports gefunden.</div>';
      return;
    }

    var map = new Map();
    ports.forEach(function (p) { map.set(String(p.port_label || ''), p); });

    // Auto-activate cassettes
    var occCassettes = new Set();
    map.forEach(function (p, label) {
      if (p.occupied || p.status === 'occupied' || p.connected_to) {
        var cm = String(label).match(/^(\d+[A-D])\d+$/);
        if (cm) occCassettes.add(cm[1]);
      }
    });
    if (occCassettes.size) {
      map.forEach(function (p, label) {
        if (String(p.status || '').toLowerCase() === 'unavailable') {
          var cm = String(label).match(/^(\d+[A-D])\d+$/);
          if (cm && occCassettes.has(cm[1])) p.status = 'free';
        }
      });
    }

    var maxRow = 0;
    map.forEach(function (_p, label) {
      var m = String(label).match(/^(\d+)[A-D]\d+$/);
      if (m) maxRow = Math.max(maxRow, Number(m[1]));
    });

    // Flat grid for simple numeric ports
    if (!maxRow) {
      var wrap = document.createElement('div');
      wrap.className = 'ports-grid';
      var sorted = [];
      map.forEach(function (p, label) { sorted.push([label, p]); });
      sorted.sort(function (a, b) { return (parseInt(a[0]) || 0) - (parseInt(b[0]) || 0) || a[0].localeCompare(b[0]); });
      sorted.forEach(function (pair) {
        wrap.appendChild(makePortBtn(pair[0], pair[1], onPick, selectedLabel));
      });
      container.appendChild(wrap);
      return;
    }

    // Cassette layout
    for (var row = 1; row <= maxRow; row++) {
      var rowDiv = document.createElement('div');
      rowDiv.className = 'cassette-row';
      for (var li = 0; li < LETTERS.length; li++) {
        var letter = LETTERS[li];
        var card = document.createElement('div');
        card.className = 'cassette';
        var title = document.createElement('h4');
        title.textContent = 'Kassette ' + row + letter;
        card.appendChild(title);
        var grid = document.createElement('div');
        grid.className = 'ports-grid';
        for (var pi = 0; pi < POSITIONS.length; pi++) {
          var label = '' + row + letter + POSITIONS[pi];
          var p = map.get(label);
          grid.appendChild(makePortBtn(label, p, onPick, selectedLabel));
        }
        card.appendChild(grid);
        rowDiv.appendChild(card);
      }
      container.appendChild(rowDiv);
    }
  }

  function makePortBtn(label, port, onPick, selectedLabel) {
    var btn = document.createElement('button');
    btn.className = 'pbtn';
    btn.textContent = label;
    btn.type = 'button';

    if (!port) { btn.classList.add('na'); btn.disabled = true; return btn; }

    var isOcc = port.occupied || port.status === 'occupied';
    var isSel = selectedLabel && label === selectedLabel;

    if (isOcc && !isSel) {
      btn.classList.add('occ');
      var occInfo = ((port.serial || '') + ' ' + (port.customer || '')).trim();
      btn.title = 'Belegt: ' + occInfo;
      btn.disabled = true;
    } else if (port.status === 'unavailable') {
      btn.classList.add('na'); btn.disabled = true;
    } else {
      btn.classList.add('free');
      btn.addEventListener('click', function () { onPick(label); });
    }

    if (isSel) {
      btn.classList.add('sel');
      if (isOcc) btn.classList.add('occ');
    }
    return btn;
  }

  /* ══════════════════════════════════════════
     EDIT MODAL — open with cassette grid
     ══════════════════════════════════════════ */
  function openEdit(entry) {
    editingEntry = entry;
    edBbPanels = [];
    edSelectedBbIdx = -1;
    edBbInInstanceId = '';
    edBbInPortLabel = '';
    edBbInDbId = null;
    edBbOutInstanceId = '';
    edBbOutPortLabel = '';

    var d = entry.data;

    // Type pill
    var pill = $('edTypePill');
    pill.className = 'type-pill ' + entry.type;
    pill.textContent = (entry.type === 'ticket') ? 'Troubleticket' : 'Troubleshooting';

    // Grunddaten
    $('edSerial').value = d.serial || d.serial_number || '';
    $('edStatus').value = d.status || '';

    // A-Seite
    $('edSwitchName').value = d.switch_name || '';
    $('edSwitchPort').value = d.switch_port || '';
    $('edAsidePP').value = d.a_patchpanel_id || '';
    $('edAsidePort').value = d.a_port_label || '';

    // Z-Seite
    $('edZsidePP').value = d.customer_patchpanel_instance_id || String(d.customer_patchpanel_id || '');
    $('edZsidePort').value = d.customer_port_label || '';
    $('edZRoom').value = d.customer_room || '';

    // Clear BB sections
    $('edBbInCards').innerHTML = '';
    $('edBbInPortGrid').innerHTML = '';
    $('edBbInPortLabel').style.display = 'none';
    $('edBbOutResult').style.display = 'none';
    $('edBbOutResult').innerHTML = '';
    $('edBbInHint').textContent = 'BB IN Patchpanels werden geladen...';

    modalEdit.classList.add('show');

    // Derive customer room to load BB panels
    var customerRoom = d.customer_room || '';
    if (!customerRoom) {
      // Try to extract room from customer PP instance_id
      var ppId = d.customer_patchpanel_instance_id || '';
      if (ppId) {
        var m = ppId.match(/M([\d.]+[A-Za-z]*\d*)/i);
        if (m) customerRoom = m[1];
      }
    }

    if (customerRoom) {
      loadBBPanels(customerRoom);
    } else {
      $('edBbInHint').textContent = 'Kundenraum konnte nicht ermittelt werden. BB IN manuell waehlen.';
    }
  }

  /* ── Load BB IN panels for customer room ── */
  function loadBBPanels(customerRoom) {
    $('edBbInHint').textContent = 'BB IN PPs die Richtung Raum ' + customerRoom + ' gehen:';

    // Current BB IN info from the cross-connect (to filter room + pre-select)
    var curBbInId    = (editingEntry && editingEntry.data.backbone_in_instance_id) || '';
    var curBbInPort  = (editingEntry && editingEntry.data.backbone_in_port_label) || '';

    apiJson(API_RACKVIEW + '/bb-panels-for-customer-room?customer_room=' + encodeURIComponent(customerRoom))
      .then(function (data) {
        var items = data.items || [];

        // Filter to same backbone room as current BB IN panel (if exists)
        if (curBbInId && items.length) {
          var curPanel = items.find(function (p) { return p.bb_instance_id === curBbInId; });
          if (curPanel) {
            var curRoom = curPanel.bb_room;
            items = items.filter(function (p) { return p.bb_room === curRoom; });
          }
        }

        edBbPanels = items;
        if (!items.length) {
          $('edBbInHint').textContent = 'Keine BB IN PPs gefunden fuer Raum ' + customerRoom + '.';
          return;
        }
        renderBBCards();

        // Auto-select the current BB IN panel and port
        if (curBbInId) {
          var matchIdx = -1;
          for (var i = 0; i < edBbPanels.length; i++) {
            if (edBbPanels[i].bb_instance_id === curBbInId) { matchIdx = i; break; }
          }
          if (matchIdx >= 0) {
            selectBBPanel(matchIdx, curBbInPort);
          }
        }
      })
      .catch(function (err) {
        $('edBbInHint').textContent = 'Fehler beim Laden: ' + err.message;
      });
  }

  /* ── Render BB IN panel cards ── */
  function renderBBCards() {
    var cardsEl = $('edBbInCards');
    cardsEl.innerHTML = '';

    for (var i = 0; i < edBbPanels.length; i++) {
      (function (idx) {
        var p = edBbPanels[idx];
        var card = document.createElement('div');
        card.className = 'bb-card' + (idx === edSelectedBbIdx ? ' selected' : '');
        card.innerHTML = '<div>' + esc(p.bb_instance_id) + '</div><div class="bb-label">' + esc(p.bb_room || '') + ' \u2192 ' + esc(p.peer_room || '') + '</div>';
        card.addEventListener('click', function () { selectBBPanel(idx); });
        cardsEl.appendChild(card);
      })(i);
    }
  }

  /* ── Select BB panel and load port grid ── */
  function selectBBPanel(idx, preSelectPort) {
    edSelectedBbIdx = idx;
    edBbInPortLabel = '';
    edBbOutInstanceId = '';
    edBbOutPortLabel = '';

    var panel = edBbPanels[idx];
    edBbInDbId = panel.bb_db_id;
    edBbInInstanceId = panel.bb_instance_id;

    renderBBCards();

    $('edBbOutResult').style.display = 'none';
    $('edBbOutResult').innerHTML = '';
    $('edBbInPortLabel').style.display = 'none';

    // Fetch ports for selected BB panel
    apiJson(API_PP + '/' + panel.bb_db_id + '/ports')
      .then(function (data) {
        var ports = data.ports || [];
        var gridEl = $('edBbInPortGrid');
        var lblEl  = $('edBbInPortLabel');

        function pickBbPort(label) {
          edBbInPortLabel = label;
          lblEl.textContent = 'Gewaehlt: ' + panel.bb_instance_id + ' / Port ' + label;
          lblEl.style.display = 'block';
          renderPortGrid(gridEl, ports, pickBbPort, label);
          // Auto-resolve BB OUT via peer
          resolveBBOut(panel.bb_instance_id, label);
        }

        // If a port was pre-selected (current BB IN port), auto-pick it
        if (preSelectPort) {
          pickBbPort(preSelectPort);
        } else {
          renderPortGrid(gridEl, ports, pickBbPort, null);
        }
      })
      .catch(function (err) {
        $('edBbInPortGrid').innerHTML = '<div class="small" style="color:#ef5350;">' + esc(err.message) + '</div>';
      });
  }

  /* ── Resolve BB OUT via peer lookup ── */
  function resolveBBOut(bbInInstanceId, bbInPortLabel) {
    var box = $('edBbOutResult');
    edBbOutInstanceId = '';
    edBbOutPortLabel = '';

    if (!bbInInstanceId || !bbInPortLabel) { box.style.display = 'none'; return; }

    apiJson(API_RACKVIEW + '/patchpanel-peer?instance_id=' + encodeURIComponent(bbInInstanceId) + '&port_label=' + encodeURIComponent(bbInPortLabel))
      .then(function (data) {
        if (data.peer_instance_id && data.peer_port_label) {
          edBbOutInstanceId = data.peer_instance_id;
          edBbOutPortLabel = data.peer_port_label;
          box.style.display = 'block';
          box.innerHTML = '<div class="af-grid">' +
            '<div><div class="af-label">BB OUT Panel</div><div class="af-val">' + esc(data.peer_instance_id) + '</div></div>' +
            '<div><div class="af-label">BB OUT Port</div><div class="af-val">' + esc(data.peer_port_label) + '</div></div>' +
            '<div><div class="af-label">Raum</div><div class="af-val">' + esc(data.peer_room || '-') + '</div></div>' +
            '</div>';
        } else {
          box.style.display = 'block';
          box.innerHTML = '<span style="color:#ffb74d;">Kein Peer gefunden fuer diesen Port.</span>';
        }
      })
      .catch(function (err) {
        box.style.display = 'block';
        box.innerHTML = '<span style="color:#ef5350;">' + esc(err.message) + '</span>';
      });
  }

  /* ══════════════════════════════════════════
     CLOSE EDIT MODAL
     ══════════════════════════════════════════ */
  btnCancelEdit.addEventListener('click', function () {
    modalEdit.classList.remove('show');
    editingEntry = null;
  });
  modalEdit.addEventListener('click', function (e) {
    if (e.target === modalEdit) { modalEdit.classList.remove('show'); editingEntry = null; }
  });

  /* ══════════════════════════════════════════
     SAVE
     ══════════════════════════════════════════ */
  btnSaveEdit.addEventListener('click', function () {
    if (!editingEntry) return;

    if (!edBbInInstanceId || !edBbInPortLabel) {
      toast('Bitte BB IN Patchpanel und Port auswaehlen.', 'warn'); return;
    }
    if (!edBbOutInstanceId || !edBbOutPortLabel) {
      toast('BB OUT konnte nicht aufgeloest werden. Bitte BB IN pruefen.', 'warn'); return;
    }

    var payload = {
      backbone_in_instance_id: edBbInInstanceId,
      backbone_in_port_label: edBbInPortLabel,
      backbone_out_instance_id: edBbOutInstanceId,
      backbone_out_port_label: edBbOutPortLabel,
      troubleshoot_type: editingEntry.type
    };

    if (editingEntry.type === 'ticket') {
      payload.ticket_number = editingEntry.ticketNr;
      if (!payload.ticket_number) { toast('Troubleticket-Nummer fehlt.', 'warn'); return; }
    } else {
      payload.note = editingEntry.note || '';
    }

    btnSaveEdit.disabled = true;
    btnSaveEdit.textContent = 'Speichere...';

    fetch(API_TS + '/update-bb/' + editingEntry.data.id, {
      method: 'PATCH',
      headers: authHeaders(),
      body: JSON.stringify(payload)
    })
      .then(function (r) {
        if (!r.ok) return r.json().then(function (j) { throw new Error(j.detail || 'Fehler'); });
        return r.json();
      })
      .then(function () {
        toast('BB-Weg erfolgreich aktualisiert!', 'success');
        modalEdit.classList.remove('show');

        // Remove saved entry from result list
        var i = resultList.indexOf(editingEntry);
        if (i >= 0) resultList.splice(i, 1);
        saveResultList();
        renderResults();
        editingEntry = null;
      })
      .catch(function (err) {
        toast(err.message || 'Speichern fehlgeschlagen.', 'error');
      })
      .finally(function () {
        btnSaveEdit.disabled = false;
        btnSaveEdit.textContent = 'Speichern';
      });
  });

  /* ══════════════════════════════════════════
     REPORT DOWNLOAD
     ══════════════════════════════════════════ */
  btnReport.addEventListener('click', function () {
    var token = localStorage.getItem('authToken') || sessionStorage.getItem('authToken');
    var xhr = new XMLHttpRequest();
    xhr.open('GET', API_TS + '/report', true);
    xhr.responseType = 'blob';
    if (token) xhr.setRequestHeader('Authorization', 'Bearer ' + token);
    xhr.onload = function () {
      if (xhr.status === 200) {
        var blob = xhr.response;
        var url = window.URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url;
        var disposition = xhr.getResponseHeader('Content-Disposition');
        var filename = 'Troubleshooting_Report.xlsx';
        if (disposition) {
          var match = disposition.match(/filename="?([^";\s]+)"?/);
          if (match) filename = match[1];
        }
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
        window.URL.revokeObjectURL(url);
        toast('Report heruntergeladen.', 'success');
      } else {
        toast('Report-Download fehlgeschlagen.', 'error');
      }
    };
    xhr.onerror = function () { toast('Report-Download fehlgeschlagen.', 'error'); };
    xhr.send();
  });

  /* ── Init: restore persisted results ── */
  loadResultList();
  if (resultList.length) renderResults();

  /* ── Presence ── */
  if (window.setPresenceAction) window.setPresenceAction('Troubleshooting geoeffnet');

})();
