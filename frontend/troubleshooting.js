// troubleshooting.js
// Frontend-Logik fuer die Troubleshooting-Seite

(function () {
  'use strict';

  var API_TS = (window.API_ROOT || '') + '/troubleshooting';
  var currentLine = null;   // the loaded cross-connect data
  var currentType = 'ticket'; // 'ticket' | 'normal'

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
  var resultCard     = document.getElementById('resultCard');
  var resultBody     = document.getElementById('resultBody');
  var btnReport      = document.getElementById('btnReport');
  var editOverlay    = document.getElementById('editOverlay');
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

  // ── Type toggle ──
  function setType(type) {
    currentType = type;
    btnTypeTicket.classList.toggle('active', type === 'ticket');
    btnTypeNormal.classList.toggle('active', type === 'normal');
    fieldsTicket.classList.toggle('visible', type === 'ticket');
    fieldsNormal.classList.toggle('visible', type === 'normal');
    // Clear result when switching
    resultCard.style.display = 'none';
    resultBody.innerHTML = '';
    currentLine = null;
  }

  btnTypeTicket.addEventListener('click', function () { setType('ticket'); });
  btnTypeNormal.addEventListener('click', function () { setType('normal'); });

  // ── Search ──
  function doSearch(serial) {
    serial = (serial || '').trim();
    if (!serial) { toast('Bitte Serial Number eingeben.', 'warn'); return; }

    fetch(API_TS + '/search?serial=' + encodeURIComponent(serial), {
      headers: authHeaders()
    })
      .then(function (r) {
        if (!r.ok) return r.json().then(function (j) { throw new Error(j.detail || 'Fehler'); });
        return r.json();
      })
      .then(function (json) {
        if (!json.success || !json.data) { toast('Keine aktive Leitung gefunden.', 'warn'); return; }
        currentLine = json.data;
        renderResult(json.data);
      })
      .catch(function (err) {
        toast(err.message || 'Suche fehlgeschlagen.', 'error');
      });
  }

  btnSearchTicket.addEventListener('click', function () {
    if (!inputTicketNr.value.trim()) { toast('Bitte Troubleticket-Nummer eingeben.', 'warn'); return; }
    doSearch(inputSerialTicket.value);
  });
  btnSearchNormal.addEventListener('click', function () {
    doSearch(inputSerialNormal.value);
  });

  // Enter key triggers search
  inputSerialTicket.addEventListener('keydown', function (e) { if (e.key === 'Enter') btnSearchTicket.click(); });
  inputSerialNormal.addEventListener('keydown', function (e) { if (e.key === 'Enter') btnSearchNormal.click(); });

  // ── Render found line ──
  function renderResult(data) {
    resultCard.style.display = '';
    var serial = data.serial || data.serial_number || '—';
    var customer = data.customer_patchpanel_instance_id || '—';
    var aSide = (data.a_patchpanel_id || '—') + '<div class="cell-sub">' + (data.a_port_label || '') + '</div>';
    var zSide = (data.customer_patchpanel_instance_id || String(data.customer_patchpanel_id || '—')) +
                '<div class="cell-sub">' + (data.customer_port_label || '') + '</div>';
    var bbIn = (data.backbone_in_instance_id || '—') +
               '<div class="cell-sub">' + (data.backbone_in_port_label || '') + '</div>';
    var bbOut = (data.backbone_out_instance_id || '—') +
                '<div class="cell-sub">' + (data.backbone_out_port_label || '') + '</div>';
    var status = data.status || '—';

    resultBody.innerHTML =
      '<tr>' +
      '<td>' + escHtml(serial) + '</td>' +
      '<td>' + escHtml(customer) + '</td>' +
      '<td>' + aSide + '</td>' +
      '<td>' + zSide + '</td>' +
      '<td>' + bbIn + '</td>' +
      '<td>' + bbOut + '</td>' +
      '<td><span class="badge badge-' + status + '">' + escHtml(status) + '</span></td>' +
      '<td><button class="btn-edit-line" id="btnEditLine">&#9998; Bearbeiten</button></td>' +
      '</tr>';

    document.getElementById('btnEditLine').addEventListener('click', openEdit);
  }

  function escHtml(str) {
    var d = document.createElement('div');
    d.textContent = str;
    return d.innerHTML;
  }

  // ── Open edit overlay ──
  function openEdit() {
    if (!currentLine) return;
    var d = currentLine;

    document.getElementById('edSerial').value = d.serial || d.serial_number || '';
    document.getElementById('edSwitch').value = (d.switch_name || '') + (d.switch_port ? ' / ' + d.switch_port : '');
    document.getElementById('edAsidePP').value = d.a_patchpanel_id || '';
    document.getElementById('edAsidePort').value = d.a_port_label || '';
    document.getElementById('edZsidePP').value = d.customer_patchpanel_instance_id || String(d.customer_patchpanel_id || '');
    document.getElementById('edZsidePort').value = d.customer_port_label || '';

    document.getElementById('edBbInPP').value = d.backbone_in_instance_id || '';
    document.getElementById('edBbInPort').value = d.backbone_in_port_label || '';
    document.getElementById('edBbOutPP').value = d.backbone_out_instance_id || '';
    document.getElementById('edBbOutPort').value = d.backbone_out_port_label || '';

    editOverlay.classList.add('open');
  }

  // ── Close edit overlay ──
  btnCancelEdit.addEventListener('click', function () {
    editOverlay.classList.remove('open');
  });
  editOverlay.addEventListener('click', function (e) {
    if (e.target === editOverlay) editOverlay.classList.remove('open');
  });

  // ── Save ──
  btnSaveEdit.addEventListener('click', function () {
    if (!currentLine) return;

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
      troubleshoot_type: currentType
    };

    if (currentType === 'ticket') {
      payload.ticket_number = inputTicketNr.value.trim();
      if (!payload.ticket_number) { toast('Troubleticket-Nummer fehlt.', 'warn'); return; }
    } else {
      payload.note = inputNote.value.trim();
    }

    btnSaveEdit.disabled = true;
    btnSaveEdit.textContent = 'Speichere...';

    fetch(API_TS + '/update-bb/' + currentLine.id, {
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
        editOverlay.classList.remove('open');

        // Refresh the displayed line
        var serial = currentType === 'ticket'
          ? inputSerialTicket.value.trim()
          : inputSerialNormal.value.trim();
        if (serial) doSearch(serial);
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
    // Use XMLHttpRequest for binary download with auth header
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
        // Extract filename from Content-Disposition header or use default
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
