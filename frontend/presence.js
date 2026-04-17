// presence.js
// Live-Anzeige aktiver Benutzer (Widget fuer Dashboard-Sidebar).
// Kann sauber entfernt werden: dieses Script + Widget-HTML aus dashboard.html loeschen.

(function () {
  'use strict';

  const POLL_INTERVAL = 15000; // 15s Polling fuer Online-Liste
  const API = String(window.API_ROOT || '').replace(/\/+$/, '');

  function esc(v) {
    return String(v ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  function timeAgo(isoStr) {
    if (!isoStr) return '—';
    const d = new Date(isoStr);
    if (isNaN(d.getTime())) return '—';
    const diff = Math.floor((Date.now() - d.getTime()) / 1000);
    if (diff < 30) return 'gerade eben';
    if (diff < 60) return diff + 's';
    if (diff < 3600) return Math.floor(diff / 60) + ' min';
    return Math.floor(diff / 3600) + 'h ' + Math.floor((diff % 3600) / 60) + 'min';
  }

  function loginSince(isoStr) {
    if (!isoStr) return '—';
    const d = new Date(isoStr);
    if (isNaN(d.getTime())) return '—';
    return d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
  }

  function statusDot(secondsAgo) {
    if (secondsAgo < 60) return '<span class="presence-dot dot-online" title="Online"></span>';
    if (secondsAgo < 120) return '<span class="presence-dot dot-idle" title="Idle"></span>';
    return '<span class="presence-dot dot-offline" title="Offline"></span>';
  }

  function renderPresenceWidget(users) {
    const container = document.getElementById('presenceWidgetBody');
    if (!container) return;

    if (!users || users.length === 0) {
      container.innerHTML = '<div class="presence-empty">Keine aktiven Benutzer</div>';
      return;
    }

    const html = users.map(u => `
      <div class="presence-user">
        <div class="presence-user-head">
          ${statusDot(u.seconds_ago)}
          <span class="presence-name">${esc(u.username)}</span>
          <span class="presence-since">seit ${loginSince(u.login_at)}</span>
        </div>
        <div class="presence-user-detail">
          ${u.current_page_label ? `<span class="presence-page" title="${esc(u.current_page || '')}">${esc(u.current_page_label)}</span>` : ''}
          ${u.last_action ? `<span class="presence-action">${esc(u.last_action)}</span>` : ''}
        </div>
        <div class="presence-user-ago">Aktiv: ${timeAgo(u.last_seen)}</div>
      </div>
    `).join('');

    container.innerHTML = html;

    // Update counter badge
    const badge = document.getElementById('presenceCount');
    if (badge) {
      badge.textContent = users.length;
      badge.classList.remove('pop');
      void badge.offsetWidth; // force reflow
      badge.classList.add('pop');
    }
  }

  async function fetchPresence() {
    try {
      const token = localStorage.getItem('authToken') || sessionStorage.getItem('authToken');
      if (!token) return;
      const res = await fetch(API + '/presence/online', {
        headers: { 'Authorization': 'Bearer ' + token }
      });
      if (!res.ok) return;
      const data = await res.json();
      renderPresenceWidget(data);
    } catch (e) {
      // silent – widget is optional
    }
  }

  // Auto-init when DOM ready
  document.addEventListener('DOMContentLoaded', () => {
    // Only run on dashboard page (where the widget exists)
    if (!document.getElementById('presenceWidgetBody')) return;

    fetchPresence();
    setInterval(fetchPresence, POLL_INTERVAL);
  });
})();
