// troubleshooting.js
// Frontend-Logik fuer die Troubleshooting-Seite
// - Suchergebnisse werden akkumuliert (mit Ueberschrift je Typ)
// - Edit-Modal im KW-Planning "Neue Installation" Layout

(function () {
  'use strict';

  var API_TS = (window.API_ROOT || '') + '/troubleshooting';
  var currentType = 'ticket'; // 'ticket' | 'normal'

  // Accumulated search results: [{type, ticketNr, note, serial, data}]
  var resultList = [];
  // Currently editing entry (from resultList)
  var editingEntry = null;

  // ── DOM refs ──
  var btnTypeTicket  = document.getElementById('btnTypeTicket');
  var btnTypeNormal  = document.getElementById('btnTypeNormal');
  var fieldsTicket   = document.getElementById('fieldsTicket');
  var fieldsNormal   = document.getElementById('fieldsNormal');
  var inputTicketNr  = document.getElementById('inputTicketNr');
  var inputSerialTicket = document.getElementById('inputSerialTicket');
  var inputNote      = document.getElementById('inputNote');
  var inputSerialNormal = document.getElementById('inputSerialNormal');
  var btnSearchTicket = document.getElementById('btnSearchTicket');
  var btnSearchNormal = document.getElementById('btnSearchNormal');
  var resultArea     = document.getElementById('resultArea');
  var btnReport      = document.getElementById('btnReport');
  var modalEdit      = document.getElementById('modalEdit');
  var btnCancelEdit  = document.getElementById('btnCancelEdit');
  var btnSaveEdit    = document.getElementById('btnSaveEdit');

  // ── Toast helper ──
  function toast(msg, type) {
    var wrap = document.getElementById('toastWrap');
    if (!wrap) return;
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

  // ── Auth header ──
  function authHeaders(extra) {
    var h = Object.assign({ 'Content-Type': 'application/json' }, extra || {});
    var token = localStorage.getItem('authToken') || sessionStorage.getItem('authToken');
    if (token) h['Authorization'] = 'Bearer ' + token;
    return h;
  }

  function escHtml(str) {
    var d = document.createElement('div');
    d.textContent = str || '';
    return d.innerHTML;
  }

  // ── Type toggle ──
  function setType(type) {
    currentType = type;
    btnTypeTicket.classList.toggle('active', type === 'ticket');
    btnTypeNormal.classList.toggle('active', type === 'normal');
    fieldsTicket.classList.toggle('visible', type === 'ticket');
    fieldsNormal.classList.toggle('visible', type === 'normal');
  }

  btnTypeTicket.addEventListener('click', function () { setType('ticket'); });
  btnTypeNormal.addEventListener('click', function () { setType('normal'); });

  // ── Search ──
  function doSearch(serial) {
    serial = (serial || '').trim();
    if (!serial) { toast('Bitte Serial Number eingeben.', 'warn'); return; }

    // Gather context before fetch
    var type = currentType;
    var ticketNr = (type === 'ticket') ? inputTicketNr.value.trim() : '';
    var note = (type === 'normal') ? inputNote.value.trim() : '';

    if (type === 'ticket' && !ticketNr) {
      toast('Bitte Troubleticket-Nummer eingeben.', 'warn');
      return;
    }

    fetch(API_TS + '/search?serial=' + encodeURIComponent(serial), {
      headers: authHeaders()
    })
      .then(function (r) {
        if (!r.ok) return r.json().then(function (j) { throw new Error(j.detail || 'Fehler'); });
        return r.json();
      })
      .then(function (json) {
        if (!json.success || !json.data) { toast('Keine aktive Leitung gefunden.', 'warn'); return; }

        // Check if same serial already in list
        var exists = resultList.some(function (e) { return e.data.id === json.data.id; });
        if (exists) {
          toast('Diese Leitung ist bereits in der Liste.', 'warn');
          return;
        }

        resultList.push({
          type: type,
          ticketNr: ticketNr,
          note: note,
          serial: serial,
          data: json.data
        });

        renderResults();
        toast('Leitung hinzugefuegt.', 'success');
      })
      .catch(function (err) {
        toast(err.message || 'Suche fehlgeschlagen.', 'error');
      });
  }

  btnSearchTicket.addEventListener('click', function () {
    doSearch(inputSerialTicket.value);
  });
  btnSearchNormal.addEventListener('click', function () {
    doSearch(inputSerialNormal.value);
  });

  // Enter key triggers search
  inputSerialTicket.addEventListener('keydown', function (e) { if (e.key === 'Enter') btnSearchTicket.click(); });
  inputSerialNormal.addEventListener('keydown', function (e) { if (e.key === 'Enter') btnSearchNormal.click(); });

  // ── Render accumulated results ──
  function renderResults() {
    resultArea.innerHTML = '';
    if (resultList.length === 0) return;

    // Group by type
    var tickets = resultList.filter(function (e) { return e.type === 'ticket'; });
    var normals = resultList.filter(function (e) { return e.type === 'normal'; });

    if (tickets.length > 0) {
      resultArea.appendChild(buildResultSection('ticket', 'Troubleticket', tickets));
    }
    if (normals.length > 0) {
      resultArea.appendChild(buildResultSection('normal', 'Normales Troubleshooting', normals));
    }
  }

  function buildResultSection(type, title, entries) {
    var section = document.createElement('div');
    section.className = 'card ts-result-section';

    // Heading
    var heading = document.createElement('div');
    heading.className = 'ts-result-heading';
    heading.innerHTML = '<span class="type-pill ' + type + '">' + escHtml(title) + '</span>' +
                        '<span class="heading-text">' + entries.length + ' Leitung' + (entries.length > 1 ? 'en' : '') + '</span>';
    section.appendChild(heading);

    // Table
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
    entries.forEach(function (entry, idx) {
      var d = entry.data;
      var tr = document.createElement('tr');

      var meta = (type === 'ticket') ? escHtml(entry.ticketNr) : escHtml((entry.note || '').substring(0, 40));

      tr.innerHTML =
        '<td>' + escHtml(d.serial || d.serial_number || '—') + '</td>' +
        '<td>' + meta + '</td>' +
        '<td>' + escHtml(d.a_patchpanel_id || '—') + '<div class="cell-sub">' + escHtml(d.a_port_label || '') + '</div></td>' +
        '<td>' + escHtml(d.customer_patchpanel_instance_id || String(d.customer_patchpanel_id || '—')) +
          '<div class="cell-sub">' + escHtml(d.customer_port_label || '') + '</div></td>' +
        '<td>' + escHtml(d.backbone_in_instance_id || '—') + '<div class="cell-sub">' + escHtml(d.backbone_in_port_label || '') + '</div></td>' +
        '<td>' + escHtml(d.backbone_out_instance_id || '—') + '<div class="cell-sub">' + escHtml(d.backbone_out_port_label || '') + '</div></td>' +
        '<td><span class="badge badge-' + escHtml(d.status || '') + '">' + escHtml(d.status || '—') + '</span></td>' +
        '<td></td>';

      // Action buttons cell
      var actionCell = tr.querySelector('td:last-child');
      var btnEdit = document.createElement('button');
      btnEdit.className = 'btn-edit-line';
      btnEdit.innerHTML = '&#9998; Bearbeiten';
      btnEdit.addEventListener('click', function () { openEdit(entry); });
      actionCell.appendChild(btnEdit);

      var btnRemove = document.createElement('button');
      btnRemove.className = 'btn-remove-line';
      btnRemove.textContent = '✕';
      btnRemove.title = 'Aus Liste entfernen';
      btnRemove.addEventListener('click', function () {
        var i = resultList.indexOf(entry);
        if (i >= 0) resultList.splice(i, 1);
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

  // ── Open edit modal (KW-Planning style) ──
  function openEdit(entry) {
    editingEntry = entry;
    var d = entry.data;

    // Set pill
    var pill = document.getElementById('edTypePill');
    pill.className = 'type-pill ' + entry.type;
    pill.textContent = (entry.type === 'ticket') ? 'Troubleticket' : 'Troubleshooting';

    // Grunddaten
    document.getElementById('edSerial').value = d.serial || d.serial_number || '';
    document.getElementById('edStatus').value = d.status || '';

    // A-Seite
    document.getElementById('edSwitchName').value = d.switch_name || '';
    document.getElementById('edSwitchPort').value = d.switch_port || '';
    document.getElementById('edAsidePP').value = d.a_patchpanel_id || '';
    document.getElementById('edAsidePort').value = d.a_port_label || '';

    // Z-Seite
    document.getElementById('edZsidePP').value = d.customer_patchpanel_instance_id || String(d.customer_patchpanel_id || '');
    document.getElementById('edZsidePort').value = d.customer_port_label || '';

    // BB (editable)
    document.getElementById('edBbInPP').value = d.backbone_in_instance_id || '';
    document.getElementById('edBbInPort').value = d.backbone_in_port_label || '';
    document.getElementById('edBbOutPP').value = d.backbone_out_instance_id || '';
    document.getElementById('edBbOutPort').value = d.backbone_out_port_label || '';

    modalEdit.classList.add('show');
  }

  // ── Close edit modal ──
  btnCancelEdit.addEventListener('click', function () {
    modalEdit.classList.remove('show');
    editingEntry = null;
  });
  modalEdit.addEventListener('click', function (e) {
    if (e.target === modalEdit) {
      modalEdit.classList.remove('show');
      editingEntry = null;
    }
  });

  // ── Save ──
  btnSaveEdit.addEventListener('click', function () {
    if (!editingEntry) return;

    var newBbInPP = document.getElementById('edBbInPP').value.trim();
    var newBbInPort = document.getElementById('edBbInPort').value.trim();
    var newBbOutPP = document.getElementById('edBbOutPP').value.trim();
    var newBbOutPort = document.getElementById('edBbOutPort').value.trim();

    if (!newBbInPP || !newBbInPort || !newBbOutPP || !newBbOutPort) {
      toast('Bitte alle BB-Felder ausfuellen.', 'warn');
      return;
    }

    var payload = {
      backbone_in_instance_id: newBbInPP,
      backbone_in_port_label: newBbInPort,
      backbone_out_instance_id: newBbOutPP,
      backbone_out_port_label: newBbOutPort,
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
      .then(function (json) {
        toast('BB-Weg erfolgreich aktualisiert!', 'success');
        modalEdit.classList.remove('show');

        // Update the entry data locally
        editingEntry.data.backbone_in_instance_id = document.getElementById('edBbInPP').value.trim();
        editingEntry.data.backbone_in_port_label = document.getElementById('edBbInPort').value.trim();
        editingEntry.data.backbone_out_instance_id = document.getElementById('edBbOutPP').value.trim();
        editingEntry.data.backbone_out_port_label = document.getElementById('edBbOutPort').value.trim();

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

  // ── Report download ──
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

  // ── Presence action tracking ──
  if (window.setPresenceAction) {
    window.setPresenceAction('Troubleshooting geoeffnet');
  }

})();
