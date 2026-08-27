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
    return p && p.length ? p : 'dashboard.html';
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

  const PAGE_HERO_CONFIG = {
    'dashboard.html': {
      card: '.dash-hero', title: '.dash-hero-title', kicker: 'Operations',
      label: 'Dashboard', compact: true,
      icon: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><path d="M14 18h7M17.5 14v7"/>',
    },
    'kw-planning.html': {
      card: '.kw-nav-card', title: '.kw-nav-left .card-title', subtitle: '.kw-nav-left .card-subtitle',
      kicker: 'Einsatzplanung', label: 'Wochenplanung',
      description: 'Kalenderwoche auswählen, automatisch anlegen und Maßnahmen verwalten.',
      icon: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M16 3v4M8 3v4M3 10h18M8 14h.01M12 14h.01M16 14h.01M8 18h.01M12 18h.01"/>',
    },
    'troubleshooting.html': {
      card: '.main-content > .card:first-of-type', title: '.main-content > .card:first-of-type .card-title', subtitle: '.main-content > .card:first-of-type .card-subtitle',
      kicker: 'Leitungskorrektur', label: 'Troubleshooting',
      description: 'Backbone-Weg (BB IN / BB OUT) einer aktiven Leitung korrigieren.',
      icon: '<path d="M14.7 6.3a4 4 0 0 0-5-5l2.1 2.1-2.4 2.4-2.1-2.1a4 4 0 0 0 5 5l7.4 7.4a2 2 0 0 1-2.8 2.8l-7.4-7.4"/><path d="m5 19 4-4"/>',
    },
    'patchpanels.html': {
      card: '.pp-explorer-header', title: '.pp-explorer-header .card-title', subtitle: '.pp-explorer-header .card-subtitle',
      kicker: 'Infrastruktur', label: 'Patchpanel Explorer',
      description: 'Alle Patchpanels durchsuchen, filtern und verwalten.',
      icon: '<rect x="3" y="4" width="18" height="6" rx="2"/><rect x="3" y="14" width="18" height="6" rx="2"/><path d="M7 7h.01M7 17h.01M11 7h7M11 17h7"/>',
    },
    'historical-archive.html': {
      card: '.main-content > .card:first-of-type', title: '.main-content > .card:first-of-type .card-title', subtitle: '.main-content > .card:first-of-type .card-subtitle',
      kicker: 'Historie', label: 'Leitungsarchiv',
      description: 'Historische Leitungen aus CSV-Importen – ohne Auswirkung auf aktive Daten.',
      icon: '<path d="M3 6h18M5 6v14h14V6M9 10h6"/><path d="M4 3h16l1 3H3l1-3Z"/>',
    },
    'migration-audit.html': {
      card: '.main-content > .card:first-of-type', title: '.main-content > .card:first-of-type .card-title', subtitle: '.main-content > .card:first-of-type .card-subtitle',
      kicker: 'Datenqualität', label: 'Migration Audit',
      description: 'Leitungen prüfen, Konflikte lösen und Backbone-Zuordnungen kontrollieren.',
      icon: '<rect x="5" y="4" width="14" height="17" rx="2"/><path d="M9 4V2h6v2M9 10l2 2 4-4M9 16h6"/>',
    },
    'admin.html': {
      card: '.main-content > .card:first-of-type', title: '.admin-header h1', subtitle: '.admin-header .subtitle',
      kicker: 'Systemverwaltung', label: 'Admin – Benutzerverwaltung',
      description: 'Benutzer verwalten, Rollen zuweisen und Audit-Logs einsehen.',
      icon: '<path d="M12 3 20 6v5c0 5-3.4 8.4-8 10-4.6-1.6-8-5-8-10V6l8-3Z"/><path d="m9 12 2 2 4-4"/>',
    },
  };

  function enhancePageHero() {
    const config = PAGE_HERO_CONFIG[currentPage()];
    if (!config) return;
    const card = document.querySelector(config.card);
    const title = document.querySelector(config.title);
    if (!card || !title || card.querySelector('.page-hero-brand')) return;

    const subtitle = config.subtitle ? document.querySelector(config.subtitle) : null;
    const brand = document.createElement('div');
    brand.className = `page-hero-brand${config.compact ? ' compact' : ''}`;
    brand.innerHTML = `
      <div class="page-hero-icon" aria-hidden="true"><svg viewBox="0 0 24 24">${config.icon}</svg></div>
      <div class="page-hero-copy">
        <div class="page-hero-kicker">${config.kicker}</div>
        <h1 class="page-hero-title">${config.label}</h1>
        ${config.description ? `<div class="page-hero-subtitle">${config.description}</div>` : ''}
      </div>`;

    card.classList.add('page-hero-card');
    title.replaceWith(brand);
    if (subtitle) subtitle.remove();
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
    const savedTheme = localStorage.getItem('theme');
    localStorage.removeItem('authToken');
    sessionStorage.removeItem('authToken');
    localStorage.clear();
    sessionStorage.clear();
    if (savedTheme) localStorage.setItem('theme', savedTheme);
    window.location.href = 'login.html';
  }

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
      window.location.href = 'dashboard.html';
      return;
    }

    enhancePageHero();
    setActiveNav();
    updateUserUI();
    applyTheme(localStorage.getItem('theme') || 'dark');

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
