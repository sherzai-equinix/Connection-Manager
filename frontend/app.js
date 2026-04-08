// app.js
// (Optional) Login-Helpers + Switch-Visualisierung

// config.js setzt window.API_* globals
const API_BASE_URL = window.API_RACKVIEW;

// Check Login Status
function checkLogin() {
    const isLoggedIn = !!(localStorage.getItem('authToken') || sessionStorage.getItem('authToken'));
    
    if (!isLoggedIn) {
        window.location.href = 'login.html';
        return false;
    }
    
    // User Info anzeigen
    const username = localStorage.getItem('username') || sessionStorage.getItem('username');
    const role = localStorage.getItem('userRole') || sessionStorage.getItem('userRole') || 'viewer';
    
    // nur setzen wenn Elemente existieren (wird von verschiedenen Pages genutzt)
    const elUsername = document.getElementById('usernameDisplay');
    const elDisplayName = document.getElementById('displayName');
    const elRole = document.getElementById('userRole');
    const elWelcome = document.getElementById('userWelcome');

    if (elUsername) elUsername.textContent = username;
    if (elDisplayName) elDisplayName.textContent = getDisplayName(username);
    if (elRole) elRole.textContent = getRoleName(role);
    if (elWelcome) elWelcome.textContent = `Willkommen, ${getDisplayName(username)}`;
    
    // Role-based UI anpassen
    adjustUIForRole(role);
    
    return true;
}

function getDisplayName(username) {
    const names = {
        'admin': 'Administrator',
        'superadmin': 'Superadmin',
        'techniker': 'Techniker',
        'tech': 'Techniker',
        'viewer': 'Betrachter',
        'test': 'Test User'
    };
    return names[username] || username;
}

function getRoleName(role) {
    const roles = {
        'admin': 'Administrator',
        'techniker': 'Techniker',
        'tech': 'Techniker',
        'viewer': 'Betrachter (nur Leserecht)'
    };
    return roles[role] || role;
}

function adjustUIForRole(role) {
    // Verstecke/Zeige Buttons basierend auf Rolle
    const isAdmin = role === 'admin' || role === 'superadmin';
    if (!isAdmin) {
        // Viewer darf nur sehen, nicht bearbeiten
        document.querySelectorAll('.btn-primary, .btn-success, .btn-danger').forEach(btn => {
            if (!btn.id.includes('search')) {
                btn.style.display = 'none';
            }
        });
    }
}

// Logout Funktion
document.getElementById('logoutBtn')?.addEventListener('click', function(e) {
    e.preventDefault();
    
    // Clear all storage
    localStorage.clear();
    sessionStorage.clear();
    
    // Redirect to login
    window.location.href = 'login.html';
});

// Am Anfang des DOMContentLoaded Event hinzufügen:
document.addEventListener('DOMContentLoaded', function() {
    // Zuerst Login checken
    if (!checkLogin()) {
        return;
    }
    
    // Dann restliche Initialisierung wie bisher...
    // ... dein bestehender Code ...
});

// Anstatt nur Text, rufe die Visualisierung auf
function displaySwitches(switches, roomData) {
    const switchesList = document.getElementById('switchesList');
    switchesList.innerHTML = '';
    
    switches.forEach(switchName => {
        // Hole Port-Daten von deiner API
        fetch(`${API_BASE_URL}/switch/${switchName}`)
            .then(response => response.json())
            .then(portData => {
                const switchHTML = createSwitchVisualization(switchName, portData);
                switchesList.innerHTML += `
                    <div class="col-md-6 mb-4">
                        ${switchHTML}
                    </div>
                `;
            });
    });
}

// In deinem app.js oder direkt in rack-view.html
function createSwitchVisualization(switchName, portData) {
    // portData Beispiel: [{port: 1, status: 'connected'}, {port: 2, status: 'available'}, ...]
    
    return `
        <div class="switch-visualization switch-rack">
            <div class="switch-front-panel">
                <div class="switch-header">
                    <div class="switch-brand">CISCO</div>
                    <div class="switch-model">${switchName}</div>
                </div>
                
                <div class="switch-ports">
                    <div class="port-column">
                        ${createPortsHTML(1, 24, portData)}
                    </div>
                    <div class="port-column">
                        ${createPortsHTML(25, 48, portData)}
                    </div>
                </div>
                
                <div class="status-leds">
                    <div class="status-led power" title="Power: ON"></div>
                    <div class="status-led system" title="System: OK"></div>
                    <div class="status-led poe" title="PoE: Active"></div>
                </div>
            </div>
            
            <div class="switch-stats mt-2">
                <small class="text-light">
                    ${countConnectedPorts(portData)}/48 Ports connected • 
                    ${calculateUtilization(portData)}% utilization
                </small>
            </div>
        </div>
    `;
}

function createPortsHTML(start, end, portData) {
    let html = '';
    for(let i = start; i <= end; i++) {
        const portStatus = getPortStatus(i, portData);
        const statusClass = portStatus === 'connected' ? 'connected' : 'available';
        const statusText = portStatus === 'connected' ? 'Connected' : 'Available';
        
        html += `
            <div class="port port-${i} ${statusClass}" 
                 title="Port ${i}: ${statusText}">
                <div class="port-number">${i}</div>
                <div class="port-led"></div>
            </div>
        `;
    }
    return html;
}

function getPortStatus(portNumber, portData) {
    // Hier mit deinen echten Daten verbinden
    // portData kommt von deiner API
    const port = portData.find(p => p.port === portNumber);
    return port ? port.status : 'available';
}

function countConnectedPorts(portData) {
    return portData.filter(p => p.status === 'connected').length;
}

function calculateUtilization(portData) {
    const connected = countConnectedPorts(portData);
    return Math.round((connected / 48) * 100);
}
