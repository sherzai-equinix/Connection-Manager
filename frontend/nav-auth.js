// nav-auth.js
// - Highlights active nav items
// - Shows current user (if elements exist)
// - Handles logout consistently
// - Handles dark/light mode toggle

(function () {
  // ── Theme toggle ──
  function applyTheme(mode) {
    if (mode === 'light') {
      document.body.classList.add('light-mode');
    } else {
      document.body.classList.remove('light-mode');
    }
    // Update icon on all toggle buttons
    document.querySelectorAll('.theme-toggle-btn').forEach(btn => {
      btn.textContent = mode === 'light' ? '\u2600' : '\u263E';
      btn.title = mode === 'light' ? 'Dark Mode' : 'Light Mode';
    });
  }

  function toggleTheme() {
    const current = localStorage.getItem('theme') || 'dark';
    const next = current === 'dark' ? 'light' : 'dark';
    localStorage.setItem('theme', next);
    applyTheme(next);
  }

  // Apply saved theme immediately (before DOMContentLoaded to avoid flash)
  applyTheme(localStorage.getItem('theme') || 'dark');
  function currentPage() {
    const p = (window.location.pathname || '').split('/').pop();
    return p && p.length ? p : 'cross-connects.html';
  }

  function getToken() {
    return localStorage.getItem('authToken') || sessionStorage.getItem('authToken');
  }

  function isLoggedIn() {
    return !!getToken();
  }

  function getDisplayName(username) {
    const names = {
      admin: 'Administrator',
      techniker: 'Techniker',
      tech: 'Techniker',
      viewer: 'Betrachter',
      test: 'Test User',
      gast: 'Gast',
    };
    return names[String(username || '').toLowerCase()] || (username || 'Gast');
  }

  function getRoleName(role) {
    const roles = {
      admin: 'Administrator',
      superadmin: 'Superadmin',
      techniker: 'Techniker',
      tech: 'Techniker',
      viewer: 'Betrachter',
    };
    return roles[String(role || '').toLowerCase()] || (role || 'viewer');
  }

  function isAdmin(role) {
    const r = String(role || '').toLowerCase();
    return r === 'admin' || r === 'superadmin';
  }

  function setActiveNav() {
    const page = currentPage();
    document.querySelectorAll('a[data-nav]').forEach((a) => {
      const href = (a.getAttribute('href') || '').split('/').pop();
      if (href && href === page) a.classList.add('active');
      else a.classList.remove('active');
    });
  }

  function ensureAdminNav(role) {
    const show = isAdmin(role);
    document.querySelectorAll('[data-admin-nav]').forEach((el) => {
      el.style.display = show ? '' : 'none';
    });
  }

  function applyReadOnlyUI(role) {
    const r = String(role || 'viewer').toLowerCase();
    document.body.dataset.role = r;

    // Admin-only elements: hidden for everyone except admin/superadmin
    document.querySelectorAll('[data-admin-only]').forEach((el) => {
      if (r !== 'admin' && r !== 'superadmin') {
        if (el.tagName === 'BUTTON' || el.tagName === 'INPUT' || el.tagName === 'SELECT' || el.tagName === 'TEXTAREA') {
          el.disabled = true;
        }
        el.style.display = 'none';
      }
    });

    // Write elements: hidden only for viewer
    if (r === 'viewer') {
      document.querySelectorAll('[data-write]').forEach((el) => {
        if (el.tagName === 'BUTTON' || el.tagName === 'INPUT' || el.tagName === 'SELECT' || el.tagName === 'TEXTAREA') {
          el.disabled = true;
        }
        el.style.display = 'none';
      });
    }
  }

  function updateUserUI() {
    const username = localStorage.getItem('username') || sessionStorage.getItem('username') || 'Gast';
    const role = localStorage.getItem('userRole') || sessionStorage.getItem('userRole') || 'viewer';

    const loginAtIso = localStorage.getItem('loginAt');
    let loginAtText = '—';
    if (loginAtIso) {
      const d = new Date(loginAtIso);
      if (!isNaN(d.getTime())) {
        loginAtText = d.toLocaleString('de-DE', {
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
        });
      }
    }

    const usernameDisplay = document.getElementById('usernameDisplay');
    const userRole = document.getElementById('userRole');
    const loginAt = document.getElementById('loginAt');
    const usernameDisplayTop = document.getElementById('usernameDisplayTop');
    const userRoleTop = document.getElementById('userRoleTop');

    const usernameDisplaySidebar = document.getElementById('sidebarUserName');
    const userRoleSidebar = document.getElementById('sidebarUserRole');
    const loginAtSidebar = document.getElementById('sidebarLoginAt');

    const nameText = getDisplayName(username);
    const roleText = getRoleName(role);

    const userBox = document.getElementById('userBox');
    if (userBox) {
      const themeIcon = (localStorage.getItem('theme') || 'dark') === 'light' ? '\u2600' : '\u263E';
      const themeTitle = (localStorage.getItem('theme') || 'dark') === 'light' ? 'Dark Mode' : 'Light Mode';
      userBox.innerHTML = `
        <div style="display:flex; flex-direction:column; line-height:1.05;">
          <span class="ub-name">${nameText}</span>
          <span class="ub-role">${roleText}</span>
        </div>
        <button class="theme-toggle-btn" type="button" title="${themeTitle}">${themeIcon}</button>
        <button class="ub-logout" type="button" data-action="logout">Logout</button>
      `;
      userBox.querySelector('.theme-toggle-btn').addEventListener('click', toggleTheme);
    }

    if (usernameDisplay) usernameDisplay.textContent = nameText;
    if (userRole) userRole.textContent = roleText;
    if (loginAt) loginAt.textContent = loginAtText;
    if (usernameDisplayTop) usernameDisplayTop.textContent = nameText;
    if (userRoleTop) userRoleTop.textContent = roleText;

    if (usernameDisplaySidebar) usernameDisplaySidebar.textContent = nameText;
    if (userRoleSidebar) userRoleSidebar.textContent = roleText;
    if (loginAtSidebar) loginAtSidebar.textContent = loginAtText;

    ensureAdminNav(role);
    applyReadOnlyUI(role);
}

  function logout() {
    // Signal presence-offline before clearing tokens
    _presenceLogout();
    const savedTheme = localStorage.getItem('theme');
    localStorage.removeItem('authToken');
    sessionStorage.removeItem('authToken');
    localStorage.clear();
    sessionStorage.clear();
    if (savedTheme) localStorage.setItem('theme', savedTheme);
    window.location.href = 'login.html';
  }

  // ── Presence heartbeat (alle 30s) ──
  var _heartbeatTimer = null;
  function _presenceHeartbeat() {
    var token = getToken(); if (!token) return;
    var origin = String(window.API_ROOT || '').replace(/\/+$/, '');
    if (!origin) return;
    var page = currentPage();
    var action = sessionStorage.getItem('presenceLastAction') || null;
    try {
      fetch(origin + '/presence/heartbeat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
        body: JSON.stringify({ current_page: page, last_action: action })
      }).catch(function(){});
    } catch(e) {}
  }
  function _presenceLogout() {
    var token = getToken(); if (!token) return;
    var origin = String(window.API_ROOT || '').replace(/\/+$/, '');
    if (!origin) return;
    try {
      fetch(origin + '/presence/logout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
        body: JSON.stringify({}),
        keepalive: true
      }).catch(function(){});
    } catch(e) {}
  }
  function startPresenceHeartbeat() {
    if (_heartbeatTimer) return;
    if (String(window.location.pathname).endsWith('login.html')) return;
    _presenceHeartbeat();
    _heartbeatTimer = setInterval(_presenceHeartbeat, 30000);
  }
  // Expose for other scripts to set last action context
  window.setPresenceAction = function(action) {
    if (action) sessionStorage.setItem('presenceLastAction', String(action).substring(0, 200));
  };

  document.addEventListener('DOMContentLoaded', () => {
    // Protect pages (except login)
    if (!String(window.location.pathname).endsWith('login.html')) {
      if (!isLoggedIn()) {
        window.location.href = 'login.html';
        return;
      }
    }

    const role = localStorage.getItem('userRole') || sessionStorage.getItem('userRole') || 'viewer';
    if (!isAdmin(role) && currentPage() === 'admin.html') {
      window.location.href = 'cross-connects.html';
      return;
    }

    setActiveNav();
    updateUserUI();
    applyTheme(localStorage.getItem('theme') || 'dark');
    startPresenceHeartbeat();

    const logoutBtn = document.getElementById('logoutBtn');
    if (logoutBtn) {
      logoutBtn.addEventListener('click', (e) => {
        e.preventDefault();
        logout();
      });
    }

    // Allow any element with data-action="logout" to work too
    document.querySelectorAll('[data-action="logout"]').forEach((el) => {
      el.addEventListener('click', (e) => {
        e.preventDefault();
        logout();
      });
    });
  });
})();
