/**
 * admin.js – V1 Admin / Benutzerverwaltung
 * Full CRUD for users, role management, password reset, audit log.
 */
(function () {
  'use strict';

  const API = String(window.API_ROOT || '').replace(/\/+$/, '');
  let users = [];
  let selectedUser = null;

  // ── Helpers ──────────────────────────────────────────────────────────────

  function el(id) { return document.getElementById(id); }

  function fmtDate(value) {
    if (!value) return '\u2014';
    const d = new Date(value);
    if (isNaN(d.getTime())) return String(value);
    return d.toLocaleString('de-DE', { day:'2-digit', month:'2-digit', year:'numeric', hour:'2-digit', minute:'2-digit' });
  }

  function escHtml(str) {
    const div = document.createElement('div');
    div.textContent = str || '';
    return div.innerHTML;
  }

  function toast(msg, type) {
    type = type || 'success';
    const container = el('toastContainer');
    if (!container) return;
    const div = document.createElement('div');
    div.className = 'toast-msg ' + type;
    div.innerHTML = '<i class="fas fa-' + (type === 'success' ? 'check-circle' : 'exclamation-triangle') + '"></i> ' + escHtml(msg);
    container.appendChild(div);
    setTimeout(function () { div.remove(); }, 4000);
  }

  async function apiJson(url, opts) {
    const res = await fetch(url, opts);
    let data = null;
    try { data = await res.json(); } catch (e) { /* ignore */ }
    if (!res.ok) {
      var msg = (data && (data.detail || data.message)) || res.statusText || 'Error';
      throw new Error(msg);
    }
    return data;
  }

  // ── Tabs ─────────────────────────────────────────────────────────────────

  function initTabs() {
    document.querySelectorAll('.admin-tabs .tab-btn').forEach(function (btn) {
      btn.addEventListener('click', function () {
        document.querySelectorAll('.admin-tabs .tab-btn').forEach(function (b) { b.classList.remove('active'); });
        document.querySelectorAll('.tab-content').forEach(function (c) { c.classList.remove('active'); });
        btn.classList.add('active');
        var tabId = 'tab-' + btn.dataset.tab;
        var content = el(tabId);
        if (content) content.classList.add('active');
        if (btn.dataset.tab === 'audit') loadAuditLog();
      });
    });
  }

  // ── Stats ────────────────────────────────────────────────────────────────

  function updateStats() {
    var total = users.length;
    var active = 0, inactive = 0, admins = 0, techs = 0, viewers = 0;
    for (var i = 0; i < users.length; i++) {
      var u = users[i];
      if (u.is_active) active++; else inactive++;
      if (u.role === 'admin' || u.role === 'superadmin') admins++;
      else if (u.role === 'techniker') techs++;
      else viewers++;
    }
    el('statTotal').textContent = total;
    el('statActive').textContent = active;
    el('statInactive').textContent = inactive;
    el('statAdmins').textContent = admins;
    el('statTechs').textContent = techs;
    el('statViewers').textContent = viewers;
  }

  // ── User List ────────────────────────────────────────────────────────────

  function renderUsers() {
    var tbody = el('usersTable') && el('usersTable').querySelector('tbody');
    if (!tbody) return;
    tbody.innerHTML = '';
    if (!users.length) {
      tbody.innerHTML = '<tr><td colspan="7" class="text-muted small">Keine Benutzer vorhanden.</td></tr>';
      return;
    }

    for (var i = 0; i < users.length; i++) {
      var u = users[i];
      var roleClass = u.role === 'admin' || u.role === 'superadmin' ? 'admin' : u.role === 'techniker' ? 'techniker' : 'viewer';
      var statusBadge = u.is_active ? '<span class="badge-active">aktiv</span>' : '<span class="badge-inactive">inaktiv</span>';
      var selectedClass = selectedUser && selectedUser.id === u.id ? ' selected' : '';

      var tr = document.createElement('tr');
      tr.className = 'user-row' + selectedClass;
      tr.dataset.id = u.id;
      tr.innerHTML =
        '<td class="small muted">' + u.id + '</td>' +
        '<td class="fw-semibold">' + escHtml(u.username) + '</td>' +
        '<td class="small">' + escHtml(u.full_name || '\u2014') + '</td>' +
        '<td><span class="badge-role ' + roleClass + '">' + escHtml(u.role) + '</span></td>' +
        '<td>' + statusBadge + '</td>' +
        '<td class="small muted">' + fmtDate(u.last_login) + '</td>' +
        '<td class="text-end"><button class="btn btn-sm btn-outline-primary" data-action="select" data-id="' + u.id + '"><i class="fas fa-chevron-right"></i></button></td>';
      tbody.appendChild(tr);
    }

    // Click handler on rows
    tbody.querySelectorAll('.user-row').forEach(function (row) {
      row.addEventListener('click', function (e) {
        if (e.target.closest('button')) return;
        selectUser(Number(row.dataset.id));
      });
    });
    tbody.querySelectorAll('button[data-action="select"]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        selectUser(Number(btn.dataset.id));
      });
    });
  }

  // ── User Detail ──────────────────────────────────────────────────────────

  function selectUser(id) {
    selectedUser = null;
    for (var i = 0; i < users.length; i++) {
      if (users[i].id === id) { selectedUser = users[i]; break; }
    }
    renderUserDetail();
    renderUsers(); // re-render to update selected highlight
  }

  function renderUserDetail() {
    var empty = el('userDetailEmpty');
    var detail = el('userDetail');
    if (!selectedUser) {
      if (empty) empty.classList.remove('d-none');
      if (detail) detail.classList.add('d-none');
      return;
    }
    if (empty) empty.classList.add('d-none');
    if (detail) detail.classList.remove('d-none');

    var u = selectedUser;
    el('detailId').textContent = u.id;
    el('detailUsername').textContent = u.username || '-';
    el('detailFullName').textContent = u.full_name || '\u2014';
    el('detailEmail').textContent = u.email || '\u2014';

    var roleEl = el('detailRole');
    var roleClass = u.role === 'admin' || u.role === 'superadmin' ? 'admin' : u.role === 'techniker' ? 'techniker' : 'viewer';
    roleEl.innerHTML = '<span class="badge-role ' + roleClass + '">' + escHtml(u.role) + '</span>';

    var statusEl = el('detailStatus');
    statusEl.innerHTML = u.is_active ? '<span class="badge-active">aktiv</span>' : '<span class="badge-inactive">inaktiv</span>';

    el('detailCreatedAt').textContent = fmtDate(u.created_at);
    el('detailLastLogin').textContent = fmtDate(u.last_login);
    el('detailForcePw').innerHTML = u.force_password_change
      ? '<span style="color:#f59e0b;"><i class="fas fa-exclamation-triangle"></i> Ja</span>'
      : '<span style="color:#4ade80;">Nein</span>';

    // Permissions
    var permEl = el('detailPermissions');
    permEl.innerHTML = '';
    var perms = u.effective_permissions || [];
    if (!perms.length) {
      permEl.innerHTML = '<span class="small muted">Keine</span>';
    } else {
      for (var i = 0; i < perms.length; i++) {
        permEl.innerHTML += '<span class="perm-tag">' + escHtml(perms[i]) + '</span>';
      }
    }

    // Populate edit form
    el('editFullName').value = u.full_name || '';
    el('editEmail').value = u.email || '';
    el('editRole').value = u.role || 'viewer';

    // Toggle active button text
    el('toggleActiveText').textContent = u.is_active ? 'Deaktivieren' : 'Aktivieren';
    var toggleBtn = el('btnToggleActive');
    if (toggleBtn) {
      toggleBtn.className = u.is_active ? 'btn btn-sm btn-outline-danger' : 'btn btn-sm btn-outline-success';
    }

    // ── Super-Admin guard: hide dangerous buttons for normal admins ──
    var myUsername = (localStorage.getItem('username') || sessionStorage.getItem('username') || '').toLowerCase();
    var isSuperAdmin = myUsername === 'admin';
    var targetIsAdmin = u.role === 'admin' || u.role === 'superadmin';

    // Delete button: only super-admin may delete anyone
    var btnDel = el('btnDeleteUser');
    if (btnDel) btnDel.style.display = isSuperAdmin ? '' : 'none';

    // Reset password + toggle active: hide if normal admin targets another admin
    var btnReset = el('btnResetPassword');
    var btnToggle = el('btnToggleActive');
    if (!isSuperAdmin && targetIsAdmin) {
      if (btnReset) btnReset.style.display = 'none';
      if (btnToggle) btnToggle.style.display = 'none';
    } else {
      if (btnReset) btnReset.style.display = '';
      if (btnToggle) btnToggle.style.display = '';
    }
  }

  // ── API calls ────────────────────────────────────────────────────────────

  async function loadUsers() {
    try {
      var data = await apiJson(API + '/admin/users');
      users = data.items || [];
      renderUsers();
      updateStats();
      if (selectedUser) {
        var updated = null;
        for (var i = 0; i < users.length; i++) {
          if (users[i].id === selectedUser.id) { updated = users[i]; break; }
        }
        selectedUser = updated;
        renderUserDetail();
      }
    } catch (err) {
      toast('Fehler beim Laden: ' + err.message, 'error');
    }
  }

  async function loadAuditLog() {
    try {
      var params = {};
      var actor = (el('auditActor') && el('auditActor').value || '').trim();
      var target = (el('auditTarget') && el('auditTarget').value || '').trim();
      var action = (el('auditAction') && el('auditAction').value || '').trim();
      var dateFrom = el('auditFrom') && el('auditFrom').value;
      var dateTo = el('auditTo') && el('auditTo').value;
      if (actor) params.actor_user_id = actor;
      if (target) params.target_user_id = target;
      if (action) params.action = action;
      if (dateFrom) params.date_from = dateFrom;
      if (dateTo) params.date_to = dateTo;
      var qs = new URLSearchParams(params).toString();
      var data = await apiJson(API + '/admin/audit-log' + (qs ? '?' + qs : ''));
      renderAuditLog(data.items || []);
    } catch (err) {
      toast('Audit Log Fehler: ' + err.message, 'error');
    }
  }

  function renderAuditLog(items) {
    var tbody = el('auditTable') && el('auditTable').querySelector('tbody');
    if (!tbody) return;
    tbody.innerHTML = '';
    el('auditCount').textContent = items.length + ' Eintraege';

    if (!items.length) {
      tbody.innerHTML = '<tr><td colspan="6" class="text-muted small">Keine Eintraege.</td></tr>';
      return;
    }

    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      var details = it.details;
      if (typeof details === 'object' && details !== null) {
        try { details = JSON.stringify(details); } catch (e) { details = String(details); }
      }
      var detailStr = String(details || '\u2014');

      var actorDisplay = it.actor_username
        ? escHtml(it.actor_username) + ' <span class="small muted">(' + (it.actor_user_id || '') + ')</span>'
        : (it.actor_user_id || '\u2014');
      var targetDisplay = it.target_username
        ? escHtml(it.target_username) + ' <span class="small muted">(' + (it.target_user_id || '') + ')</span>'
        : (it.target_user_id || '\u2014');

      var actionBadge = escHtml(it.action || '-');

      var tr = document.createElement('tr');
      tr.innerHTML =
        '<td class="small">' + fmtDate(it.ts) + '</td>' +
        '<td class="small">' + actorDisplay + '</td>' +
        '<td><span class="badge-role viewer" style="font-size:.72rem;">' + actionBadge + '</span></td>' +
        '<td class="small">' + targetDisplay + '</td>' +
        '<td class="small muted">' + escHtml(it.entity_type || '') + '</td>' +
        '<td class="small audit-details" title="' + escHtml(detailStr) + '">' + escHtml(detailStr.length > 80 ? detailStr.substring(0, 77) + '...' : detailStr) + '</td>';
      tbody.appendChild(tr);
    }
  }

  // ── Create User ──────────────────────────────────────────────────────────

  function openCreateModal() {
    el('createUserForm').reset();
    el('newForceChange').checked = true;
    el('createResult').classList.add('d-none');
    el('createUserForm').classList.remove('d-none');
    el('createUserModal').classList.add('show');
  }

  function closeCreateModal() {
    el('createUserModal').classList.remove('show');
  }

  async function handleCreateUser(e) {
    e.preventDefault();
    var username = (el('newUsername').value || '').trim();
    if (!username) { toast('Benutzername ist erforderlich', 'error'); return; }

    var body = {
      username: username,
      full_name: (el('newFullName').value || '').trim() || null,
      email: (el('newEmail').value || '').trim() || null,
      role: el('newRole').value || 'techniker',
      password: (el('newPassword').value || '').trim() || null,
      force_password_change: el('newForceChange').checked,
    };

    try {
      var data = await apiJson(API + '/admin/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      // Hide form, show result
      el('createUserForm').classList.add('d-none');
      el('createResult').classList.remove('d-none');
      el('resultUsername').textContent = data.username || username;
      el('resultPassword').textContent = data.temp_password || '(manuell gesetzt)';

      toast('Benutzer "' + username + '" wurde erstellt!', 'success');
      loadUsers();
    } catch (err) {
      toast('Fehler: ' + err.message, 'error');
    }
  }

  // ── Save User (Edit) ────────────────────────────────────────────────────

  async function saveUser() {
    if (!selectedUser) return;
    var body = {
      full_name: el('editFullName').value.trim(),
      email: el('editEmail').value.trim(),
      role: el('editRole').value,
    };

    try {
      await apiJson(API + '/admin/users/' + selectedUser.id, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      toast('Benutzer gespeichert!', 'success');
      await loadUsers();
    } catch (err) {
      toast('Fehler: ' + err.message, 'error');
    }
  }

  // ── Toggle Active ────────────────────────────────────────────────────────

  async function toggleActive() {
    if (!selectedUser) return;
    var action = selectedUser.is_active ? 'deaktivieren' : 'aktivieren';
    if (!confirm('Benutzer "' + selectedUser.username + '" wirklich ' + action + '?')) return;

    try {
      await apiJson(API + '/admin/users/' + selectedUser.id + '/toggle-active', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      toast('Benutzer wurde ' + (selectedUser.is_active ? 'deaktiviert' : 'aktiviert') + '.', 'success');
      await loadUsers();
    } catch (err) {
      toast('Fehler: ' + err.message, 'error');
    }
  }

  // ── Reset Password ───────────────────────────────────────────────────────

  function openResetPwModal() {
    if (!selectedUser) return;
    el('resetPwUser').textContent = selectedUser.username;
    el('resetPwInput').value = '';
    el('resetResult').classList.add('d-none');
    el('resetPwForm').classList.remove('d-none');
    el('resetPwModal').classList.add('show');
  }

  function closeResetPwModal() {
    el('resetPwModal').classList.remove('show');
  }

  async function handleResetPw(e) {
    e.preventDefault();
    if (!selectedUser) return;

    var body = {};
    var pw = (el('resetPwInput').value || '').trim();
    if (pw) body.new_password = pw;

    try {
      var data = await apiJson(API + '/admin/users/' + selectedUser.id + '/reset-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      el('resetPwForm').classList.add('d-none');
      el('resetResult').classList.remove('d-none');
      el('resetResultPw').textContent = data.temp_password || '(manuell gesetzt)';

      toast('Passwort wurde zurueckgesetzt!', 'success');
      loadUsers();
    } catch (err) {
      toast('Fehler: ' + err.message, 'error');
    }
  }

  // ── Delete User ─────────────────────────────────────────────────────────

  async function deleteUser() {
    if (!selectedUser) return;
    var u = selectedUser;
    if (!confirm('Benutzer "' + u.username + '" (ID ' + u.id + ') wirklich endgueltig loeschen?\n\nDiese Aktion kann nicht rueckgaengig gemacht werden!')) return;

    try {
      await apiJson(API + '/admin/users/' + u.id, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
      });
      toast('Benutzer "' + u.username + '" wurde geloescht.', 'success');
      selectedUser = null;
      renderUserDetail();
      await loadUsers();
    } catch (err) {
      toast('Fehler beim Loeschen: ' + err.message, 'error');
    }
  }

  // ── Show User Audit ──────────────────────────────────────────────────────

  function showUserAudit() {
    if (!selectedUser) return;
    // Switch to audit tab with target filter set
    document.querySelectorAll('.admin-tabs .tab-btn').forEach(function (b) { b.classList.remove('active'); });
    document.querySelectorAll('.tab-content').forEach(function (c) { c.classList.remove('active'); });
    document.querySelector('.tab-btn[data-tab="audit"]').classList.add('active');
    el('tab-audit').classList.add('active');

    // Set filter
    el('auditTarget').value = selectedUser.id;
    el('auditActor').value = '';
    el('auditAction').value = '';
    loadAuditLog();
  }

  // ── Clear Audit Filters ──────────────────────────────────────────────────

  function clearAuditFilters() {
    el('auditActor').value = '';
    el('auditTarget').value = '';
    el('auditAction').value = '';
    el('auditFrom').value = '';
    el('auditTo').value = '';
    loadAuditLog();
  }

  // ── Init ─────────────────────────────────────────────────────────────────

  document.addEventListener('DOMContentLoaded', function () {
    initTabs();

    // Buttons
    el('btnReloadUsers') && el('btnReloadUsers').addEventListener('click', loadUsers);
    el('btnCreateUser') && el('btnCreateUser').addEventListener('click', openCreateModal);
    el('btnCancelCreate') && el('btnCancelCreate').addEventListener('click', closeCreateModal);
    el('createUserForm') && el('createUserForm').addEventListener('submit', handleCreateUser);
    el('btnCloseCreateResult') && el('btnCloseCreateResult').addEventListener('click', function () { closeCreateModal(); });

    el('btnSaveUser') && el('btnSaveUser').addEventListener('click', saveUser);
    el('btnToggleActive') && el('btnToggleActive').addEventListener('click', toggleActive);
    el('btnResetPassword') && el('btnResetPassword').addEventListener('click', openResetPwModal);
    el('btnCancelReset') && el('btnCancelReset').addEventListener('click', closeResetPwModal);
    el('resetPwForm') && el('resetPwForm').addEventListener('submit', handleResetPw);
    el('btnCloseResetResult') && el('btnCloseResetResult').addEventListener('click', function () { closeResetPwModal(); });

    el('btnShowUserAudit') && el('btnShowUserAudit').addEventListener('click', showUserAudit);
    el('btnDeleteUser') && el('btnDeleteUser').addEventListener('click', deleteUser);

    el('btnReloadAudit') && el('btnReloadAudit').addEventListener('click', loadAuditLog);
    el('btnApplyAudit') && el('btnApplyAudit').addEventListener('click', loadAuditLog);
    el('btnClearAudit') && el('btnClearAudit').addEventListener('click', clearAuditFilters);

    // Close modals on overlay click
    el('createUserModal') && el('createUserModal').addEventListener('click', function (e) {
      if (e.target === el('createUserModal')) closeCreateModal();
    });
    el('resetPwModal') && el('resetPwModal').addEventListener('click', function (e) {
      if (e.target === el('resetPwModal')) closeResetPwModal();
    });

    // Escape key closes modals
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') {
        closeCreateModal();
        closeResetPwModal();
      }
    });

    // Initial load
    loadUsers();
  });
})();
