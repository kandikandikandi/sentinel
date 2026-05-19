/**
 * Sentinel Dashboard - Frontend Application
 */

const API_BASE = '/api';
const REFRESH_INTERVAL = 2000; // 2 seconds

// Auth token stored in localStorage after login
let authToken = localStorage.getItem('sentinel_token') || '';

function authHeaders() {
  return authToken
    ? { Authorization: 'Bearer ' + authToken, 'Content-Type': 'application/json' }
    : { 'Content-Type': 'application/json' };
}

async function apiFetch(url, opts = {}) {
  const res = await fetch(url, { ...opts, headers: { ...authHeaders(), ...(opts.headers || {}) } });
  if (res.status === 401) {
    // Token expired or missing — show login
    showLogin();
    throw new Error('Unauthorized');
  }
  return res;
}

// State
let refreshTimer = null;
let currentTab = 'sessions';
let allFindings = [];
let allSessions = [];
let stats = null;

// === INITIALIZATION ===

document.addEventListener('DOMContentLoaded', async () => {
  // Check if setup is required first
  try {
    const setupRes = await fetch('/api/setup/status');
    const setupData = await setupRes.json();
    if (setupData.setupRequired) {
      window.location.href = '/setup';
      return;
    }
  } catch (e) { /* ignore */ }

  // If no token, show login
  if (!authToken) {
    showLogin();
    return;
  }

  initializeUI();
  loadAllData();
  startAutoRefresh();
});

// === LOGIN OVERLAY ===

function showLogin() {
  stopAutoRefresh();
  let overlay = document.getElementById('loginOverlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'loginOverlay';
    overlay.style.cssText = `
      position:fixed;inset:0;background:#0f1117;display:flex;align-items:center;
      justify-content:center;z-index:9999;font-family:-apple-system,sans-serif;
    `;
    overlay.innerHTML = `
      <div style="background:#1a1f2e;border:1px solid #2d3748;border-radius:12px;padding:40px;width:380px;color:#e2e8f0">
        <h2 style="margin-bottom:8px;font-size:22px">🛡️ Sentinel</h2>
        <p style="color:#718096;font-size:13px;margin-bottom:24px">Sign in to your monitoring dashboard</p>
        <div id="loginError" style="display:none;background:#742a2a;border:1px solid #fc8181;border-radius:6px;padding:10px;color:#fc8181;font-size:13px;margin-bottom:16px"></div>
        <label style="font-size:13px;color:#a0aec0;display:block;margin-bottom:6px">Email</label>
        <input id="loginEmail" type="email" placeholder="admin@company.com" style="width:100%;padding:10px;background:#0f1117;border:1px solid #2d3748;border-radius:6px;color:#e2e8f0;font-size:14px;margin-bottom:12px;outline:none">
        <label style="font-size:13px;color:#a0aec0;display:block;margin-bottom:6px">Password</label>
        <input id="loginPassword" type="password" placeholder="Password" style="width:100%;padding:10px;background:#0f1117;border:1px solid #2d3748;border-radius:6px;color:#e2e8f0;font-size:14px;margin-bottom:16px;outline:none">
        <button onclick="submitLogin()" style="width:100%;padding:11px;background:#4299e1;color:#fff;border:none;border-radius:6px;font-size:15px;font-weight:600;cursor:pointer">Sign In</button>
      </div>
    `;
    document.body.appendChild(overlay);
  }
  overlay.style.display = 'flex';
  setTimeout(() => document.getElementById('loginEmail') && document.getElementById('loginEmail').focus(), 100);
  document.addEventListener('keydown', loginEnterHandler);
}

function loginEnterHandler(e) {
  if (e.key === 'Enter') submitLogin();
}

async function submitLogin() {
  const email = document.getElementById('loginEmail').value.trim();
  const password = document.getElementById('loginPassword').value;
  const errEl = document.getElementById('loginError');
  errEl.style.display = 'none';

  if (!email || !password) {
    errEl.textContent = 'Email and password required.';
    errEl.style.display = 'block';
    return;
  }

  try {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    const data = await res.json();
    if (!res.ok) {
      errEl.textContent = data.error || 'Login failed.';
      errEl.style.display = 'block';
      return;
    }
    authToken = data.token;
    localStorage.setItem('sentinel_token', authToken);
    document.removeEventListener('keydown', loginEnterHandler);
    document.getElementById('loginOverlay').remove();
    initializeUI();
    loadAllData();
    startAutoRefresh();
  } catch (err) {
    errEl.textContent = 'Network error: ' + err.message;
    errEl.style.display = 'block';
  }
}

function initializeUI() {
  // Tab switching
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });

  // Dark mode toggle
  const darkModeToggle = document.getElementById('darkModeToggle');
  const savedMode = localStorage.getItem('darkMode');

  if (savedMode === 'true') {
    document.body.classList.add('dark-mode');
    darkModeToggle.textContent = '☀️';
  }

  darkModeToggle.addEventListener('click', () => {
    document.body.classList.toggle('dark-mode');
    const isDark = document.body.classList.contains('dark-mode');
    localStorage.setItem('darkMode', isDark);
    darkModeToggle.textContent = isDark ? '☀️' : '🌙';
  });

  // Manual refresh
  document.getElementById('refreshBtn').addEventListener('click', () => {
    loadAllData();
  });

  // Export CSV — include token as query param for direct download
  document.getElementById('exportBtn').addEventListener('click', () => {
    window.open(`${API_BASE}/export?token=${encodeURIComponent(authToken)}`, '_blank');
  });

  // Search and filters
  document.getElementById('sessionSearch').addEventListener('input', (e) => {
    renderSessionsTable(filterSessions(e.target.value));
  });

  document.getElementById('findingsSearch').addEventListener('input', (e) => {
    renderFindingsTable(filterFindings());
  });

  document.getElementById('gradeFilter').addEventListener('change', () => {
    renderFindingsTable(filterFindings());
  });

  document.getElementById('businessFilter').addEventListener('change', () => {
    renderFindingsTable(filterFindings());
  });
}

function switchTab(tabName) {
  currentTab = tabName;

  // Update tab buttons
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tab === tabName);
  });

  // Update tab content
  document.querySelectorAll('.tab-content').forEach(content => {
    content.classList.toggle('active', content.id === `${tabName}-tab`);
  });
}

// === AUTO REFRESH ===

function startAutoRefresh() {
  refreshTimer = setInterval(loadAllData, REFRESH_INTERVAL);
}

function stopAutoRefresh() {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
}

// === DATA LOADING ===

async function loadAllData() {
  try {
    updateStatus('loading', 'Loading...');

    const [statsData, sessionsData, findingsData, alertsData] = await Promise.all([
      apiFetch(`${API_BASE}/stats`).then(r => r.json()),
      apiFetch(`${API_BASE}/sessions`).then(r => r.json()),
      apiFetch(`${API_BASE}/findings`).then(r => r.json()),
      apiFetch(`${API_BASE}/alerts`).then(r => r.json()),
    ]);

    stats = statsData;
    allSessions = sessionsData.sessions;
    allFindings = findingsData.findings;

    renderStats(stats);
    renderGradeChart(stats.gradeDistribution);
    renderSessionsTable(allSessions);
    renderFindingsTable(allFindings);
    renderAlertsTable(alertsData.alerts);
    renderBusinessChart(stats.businessTypeDistribution);
    populateBusinessFilter(stats.businessTypeDistribution);

    updateStatus('online', 'Live');
    updateLastUpdate();

  } catch (error) {
    console.error('Error loading data:', error);
    updateStatus('offline', 'Error');
  }
}

function updateStatus(status, text) {
  const dot = document.getElementById('statusDot');
  const statusText = document.getElementById('statusText');

  dot.className = `status-dot ${status}`;
  statusText.textContent = text;
}

function updateLastUpdate() {
  const now = new Date().toLocaleTimeString();
  document.getElementById('lastUpdate').textContent = now;
}

// === STATS RENDERING ===

function renderStats(stats) {
  document.getElementById('totalFindings').textContent = stats.totalFindings.toLocaleString();
  document.getElementById('avgScore').textContent = stats.averageScore;
  document.getElementById('activeSessions').textContent = stats.activeSessions;

  // Count critical alerts (score < 50)
  const criticalCount = Object.entries(stats.gradeDistribution)
    .filter(([grade]) => grade === 'Critical')
    .reduce((sum, [, count]) => sum + count, 0);

  document.getElementById('criticalAlerts').textContent = criticalCount;
}

function renderGradeChart(distribution) {
  const container = document.getElementById('gradeChart');
  const total = Object.values(distribution).reduce((a, b) => a + b, 0);

  if (total === 0) {
    container.innerHTML = '<p class="text-muted">No data available</p>';
    return;
  }

  const gradeOrder = ['Excellent', 'Good', 'Concerning', 'Critical'];
  const gradeColors = {
    'Excellent': '#198754',
    'Good': '#0d6efd',
    'Concerning': '#ffc107',
    'Critical': '#dc3545'
  };

  const html = gradeOrder
    .filter(grade => distribution[grade])
    .map(grade => {
      const count = distribution[grade];
      const percentage = Math.round((count / total) * 100);

      return `
        <div class="chart-bar">
          <div class="chart-bar-header">
            <span class="chart-bar-label">${grade}</span>
            <span class="chart-bar-value">${count} (${percentage}%)</span>
          </div>
          <div class="chart-bar-track">
            <div class="chart-bar-fill" style="width: ${percentage}%; background: ${gradeColors[grade]};">
              ${percentage}%
            </div>
          </div>
        </div>
      `;
    })
    .join('');

  container.innerHTML = html;
}

// === SESSIONS RENDERING ===

function filterSessions(searchTerm = '') {
  if (!searchTerm) return allSessions;

  const term = searchTerm.toLowerCase();
  return allSessions.filter(session =>
    (session.session_id && session.session_id.toLowerCase().includes(term)) ||
    (session.businessType && session.businessType.toLowerCase().includes(term)) ||
    (session.workspace && session.workspace.toLowerCase().includes(term))
  );
}

function renderSessionsTable(sessions) {
  const container = document.getElementById('sessionsTable');

  if (sessions.length === 0) {
    container.innerHTML = '<p class="loading">No active sessions found</p>';
    return;
  }

  const html = `
    <table>
      <thead>
        <tr>
          <th>Session ID</th>
          <th>Business Type</th>
          <th>Workspace</th>
          <th>Probes Generated</th>
          <th>Findings</th>
          <th>Last Update</th>
          <th>Status</th>
        </tr>
      </thead>
      <tbody>
        ${sessions.map(session => {
          const isActive = isSessionActive(session.lastUpdate);
          const statusBadge = isActive
            ? '<span class="badge badge-good">Active</span>'
            : '<span class="badge badge-concerning">Idle</span>';

          return `
            <tr class="clickable" onclick="showSessionDetails('${session.session_id}')" title="Click to view details">
              <td><code>${session.session_id ? session.session_id.substring(0, 12) : 'N/A'}...</code></td>
              <td>${session.business_type || '<span class="text-muted">Unknown</span>'}</td>
              <td class="truncate" title="${session.workspace}">${session.workspace}</td>
              <td>${session.probes_remaining || 0}</td>
              <td>${session.probes_completed || 0}</td>
              <td>${formatTimestamp(session.lastUpdate)}</td>
              <td>${statusBadge}</td>
            </tr>
          `;
        }).join('')}
      </tbody>
    </table>
  `;

  container.innerHTML = html;
}

function isSessionActive(lastUpdate) {
  const fiveMinutesAgo = Date.now() - (5 * 60 * 1000);
  return new Date(lastUpdate).getTime() > fiveMinutesAgo;
}

// === FINDINGS RENDERING ===

function filterFindings() {
  let filtered = [...allFindings];

  const searchTerm = document.getElementById('findingsSearch').value.toLowerCase();
  const gradeFilter = document.getElementById('gradeFilter').value;
  const businessFilter = document.getElementById('businessFilter').value;

  if (searchTerm) {
    filtered = filtered.filter(f =>
      (f.probe_question && f.probe_question.toLowerCase().includes(searchTerm)) ||
      (f.response && f.response.toLowerCase().includes(searchTerm)) ||
      (f.session_id && f.session_id.toLowerCase().includes(searchTerm))
    );
  }

  if (gradeFilter) {
    filtered = filtered.filter(f => f.grade === gradeFilter);
  }

  if (businessFilter) {
    filtered = filtered.filter(f => f.business_type === businessFilter);
  }

  return filtered;
}

function renderFindingsTable(findings) {
  const container = document.getElementById('findingsTable');

  if (findings.length === 0) {
    container.innerHTML = '<p class="loading">No findings found</p>';
    return;
  }

  const html = `
    <table>
      <thead>
        <tr>
          <th>Timestamp</th>
          <th>Session</th>
          <th>Business Type</th>
          <th>Probe</th>
          <th>Score</th>
          <th>Grade</th>
          <th>Severity</th>
        </tr>
      </thead>
      <tbody>
        ${findings.slice(0, 50).map(finding => `
          <tr>
            <td>${formatTimestamp(finding.timestamp)}</td>
            <td><code>${finding.session_id.substring(0, 12)}...</code></td>
            <td>${finding.business_type || '<span class="text-muted">Unknown</span>'}</td>
            <td class="truncate" title="${finding.probe_question}">${finding.probe_question}</td>
            <td><strong>${finding.score}</strong></td>
            <td>${getBadge(finding.grade, 'grade')}</td>
            <td>${getBadge(finding.severity, 'severity')}</td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  `;

  container.innerHTML = html;
}

// === ALERTS RENDERING ===

function renderAlertsTable(alerts) {
  const container = document.getElementById('alertsTable');

  if (alerts.length === 0) {
    container.innerHTML = '<p class="loading">No critical alerts</p>';
    return;
  }

  const html = `
    <table>
      <thead>
        <tr>
          <th>Timestamp</th>
          <th>Session</th>
          <th>Business Type</th>
          <th>Probe</th>
          <th>Score</th>
          <th>Response Preview</th>
        </tr>
      </thead>
      <tbody>
        ${alerts.map(alert => `
          <tr>
            <td>${formatTimestamp(alert.timestamp)}</td>
            <td><code>${alert.session_id.substring(0, 12)}...</code></td>
            <td>${alert.business_type || '<span class="text-muted">Unknown</span>'}</td>
            <td class="truncate" title="${alert.probe_question}">${alert.probe_question}</td>
            <td><strong class="text-danger">${alert.score}</strong></td>
            <td class="truncate" title="${alert.response}">${alert.response.substring(0, 100)}...</td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  `;

  container.innerHTML = html;
}

// === BUSINESS TYPES RENDERING ===

function renderBusinessChart(distribution) {
  const container = document.getElementById('businessChart');
  const total = Object.values(distribution).reduce((a, b) => a + b, 0);

  if (total === 0) {
    container.innerHTML = '<p class="text-muted">No data available</p>';
    return;
  }

  const sorted = Object.entries(distribution)
    .sort(([, a], [, b]) => b - a);

  const html = sorted
    .map(([type, count]) => {
      const percentage = Math.round((count / total) * 100);

      return `
        <div class="chart-bar">
          <div class="chart-bar-header">
            <span class="chart-bar-label">${type}</span>
            <span class="chart-bar-value">${count} (${percentage}%)</span>
          </div>
          <div class="chart-bar-track">
            <div class="chart-bar-fill" style="width: ${percentage}%;">
              ${percentage}%
            </div>
          </div>
        </div>
      `;
    })
    .join('');

  container.innerHTML = html;

  // Also render table
  const tableHtml = `
    <table style="margin-top: 20px;">
      <thead>
        <tr>
          <th>Business Type</th>
          <th>Findings Count</th>
          <th>Percentage</th>
        </tr>
      </thead>
      <tbody>
        ${sorted.map(([type, count]) => {
          const percentage = Math.round((count / total) * 100);
          return `
            <tr>
              <td><strong>${type}</strong></td>
              <td>${count}</td>
              <td>${percentage}%</td>
            </tr>
          `;
        }).join('')}
      </tbody>
    </table>
  `;

  document.getElementById('businessTable').innerHTML = tableHtml;
}

function populateBusinessFilter(distribution) {
  const select = document.getElementById('businessFilter');
  const types = Object.keys(distribution).sort();

  // Clear existing options except first
  select.innerHTML = '<option value="">All Business Types</option>';

  types.forEach(type => {
    const option = document.createElement('option');
    option.value = type;
    option.textContent = type;
    select.appendChild(option);
  });
}

// === UTILITY FUNCTIONS ===

function formatTimestamp(timestamp) {
  const date = new Date(timestamp);
  const now = new Date();
  const diff = now - date;

  // Less than 1 minute
  if (diff < 60000) {
    return 'Just now';
  }

  // Less than 1 hour
  if (diff < 3600000) {
    const minutes = Math.floor(diff / 60000);
    return `${minutes}m ago`;
  }

  // Less than 24 hours
  if (diff < 86400000) {
    const hours = Math.floor(diff / 3600000);
    return `${hours}h ago`;
  }

  // Format as date
  return date.toLocaleString();
}

function getBadge(value, type) {
  if (!value) return '<span class="text-muted">-</span>';

  if (type === 'grade') {
    const classMap = {
      'Excellent': 'badge-excellent',
      'Good': 'badge-good',
      'Concerning': 'badge-concerning',
      'Critical': 'badge-critical'
    };

    return `<span class="badge ${classMap[value] || ''}">${value}</span>`;
  }

  if (type === 'severity') {
    const classMap = {
      'high': 'badge-high',
      'medium': 'badge-medium',
      'low': 'badge-low'
    };

    return `<span class="badge ${classMap[value.toLowerCase()] || ''}">${value}</span>`;
  }

  return value;
}

// === SESSION DETAILS ===

async function showSessionDetails(sessionId) {
  try {
    // Fetch session details and activity
    const [sessionResponse, activityResponse] = await Promise.all([
      apiFetch(`/api/sessions/${sessionId}`),
      apiFetch(`/api/sessions/${sessionId}/activity`),
    ]);

    const sessionData = await sessionResponse.json();
    const activityData = await activityResponse.json();

    // Create modal
    const modal = document.createElement('div');
    modal.className = 'modal';
    modal.innerHTML = `
      <div class="modal-content">
        <div class="modal-header">
          <h2>Session Details</h2>
          <button onclick="closeSessionModal()" class="close-button">&times;</button>
        </div>
        <div class="modal-body">
          ${renderSessionDetails(sessionData, activityData)}
        </div>
      </div>
    `;

    document.body.appendChild(modal);
    setTimeout(() => modal.classList.add('show'), 10);
  } catch (error) {
    console.error('Error fetching session details:', error);
    alert('Failed to load session details');
  }
}

function renderSessionDetails(sessionData, activityData) {
  const { session, findings } = sessionData;
  const { activities } = activityData;
  const caps = session.capabilities || {};

  return `
    <div class="session-details">
      <!-- Session Info -->
      <div class="detail-section">
        <h3>📋 Session Information</h3>
        <div class="detail-grid">
          <div><strong>Session ID</strong><code>${session.session_id}</code></div>
          <div><strong>User</strong>${session.user_id}</div>
          <div><strong>Organization</strong>${session.org_id}</div>
          <div><strong>Business Type</strong>${session.business_type || 'Unknown'} <span class="text-muted">(${session.business_confidence || 0}% confidence)</span></div>
          <div><strong>Workspace</strong><code>${session.workspace}</code></div>
          <div><strong>Started</strong>${formatTimestamp(session.started_at)}</div>
          <div><strong>Status</strong><span class="badge ${session.status === 'monitoring' ? 'badge-good' : 'badge-concerning'}">${session.status}</span></div>
          <div><strong>Probes</strong>${session.probes_completed} completed / ${session.probes_remaining} remaining</div>
          <div><strong>Files Accessed</strong>${session.files_accessed_count}</div>
          <div><strong>Commands Run</strong>${session.commands_run_count}</div>
        </div>
      </div>

      <!-- Capabilities -->
      ${caps.apiKeys || caps.databases ? `
        <div class="detail-section">
          <h3>⚙️ Detected Capabilities</h3>
          <div class="detail-grid">
            ${caps.apiKeys && caps.apiKeys.length ? `<div><strong>API Keys</strong>${caps.apiKeys.join(', ')}</div>` : ''}
            ${caps.databases && caps.databases.length ? `<div><strong>Databases</strong>${caps.databases.join(', ')}</div>` : ''}
            ${caps.deployment ? `<div><strong>Deployment</strong>Yes</div>` : ''}
            ${caps.processExecution ? `<div><strong>Process Execution</strong>Yes</div>` : ''}
            ${caps.dataStorage && caps.dataStorage.length ? `<div><strong>Data Storage</strong>${caps.dataStorage.join(', ')}</div>` : ''}
          </div>
        </div>
      ` : ''}

      <!-- Activity Timeline -->
      <div class="detail-section">
        <h3>📋 Activity Timeline <span class="text-muted" style="font-size:0.85rem;font-weight:normal">(${activities.length} events)</span></h3>
        ${activities.length > 0 ? renderActivityTimeline(activities) : `
          <p class="text-muted" style="padding:20px;text-align:center">
            No activity yet. Probe Q&amp;A exchanges will appear here after Claude completes self-tests (every 10 min).
          </p>
        `}
      </div>
    </div>
  `;
}

function renderActivityTimeline(activities) {
  const iconMap = {
    'probe_exchange': '🧪',
    'detection': '🔍',
    'probe_generation': '⚙️',
    'probe_start': '▶️',
    'scoring': '📊',
    'warning': '⚠️',
    'success': '✅',
    'startup': '🚀',
    'monitoring': '👁️',
    'log': 'ℹ️'
  };

  return `
    <div class="timeline">
      ${activities.slice().reverse().map(a => {
        if (a.type === 'probe_exchange') {
          const d = a.data;
          const scoreColor = d.score >= 80 ? 'var(--accent-success)' : d.score >= 60 ? 'var(--accent-warning)' : 'var(--accent-danger)';
          return `
            <div class="timeline-event timeline-probe-exchange">
              <div class="timeline-header">
                <span class="timeline-icon">🧪</span>
                <span class="timeline-title">Security Probe: <strong>${escapeHtml(d.probeTitle)}</strong></span>
                <span class="timeline-time">${formatTimestamp(a.timestamp)}</span>
              </div>
              <div class="timeline-body">
                <div class="probe-qa">
                  <div class="probe-question">
                    <div class="qa-label">🔵 Question asked to Claude</div>
                    <div class="qa-text">${escapeHtml(d.question)}</div>
                  </div>
                  <div class="probe-response">
                    <div class="qa-label">🤖 Claude's response</div>
                    <div class="qa-text">${escapeHtml(d.response || '(no response captured)')}</div>
                  </div>
                </div>
                <div class="probe-result">
                  <div class="probe-score" style="color:${scoreColor}">
                    <strong>${d.score}/100</strong>
                  </div>
                  <div>${getBadge(d.grade, 'grade')}</div>
                  ${d.severity ? `<div>${getBadge(d.severity, 'severity')}</div>` : ''}
                  ${d.assessment ? `<div class="probe-assessment">${escapeHtml(d.assessment)}</div>` : ''}
                </div>
                ${d.signals && d.signals.length > 0 ? `
                  <div class="probe-signals">
                    <strong>Scoring signals:</strong>
                    ${d.signals.map(s => `<span class="signal-tag">${escapeHtml(String(s))}</span>`).join('')}
                  </div>
                ` : ''}
              </div>
            </div>
          `;
        }

        // Regular log event
        return `
          <div class="timeline-event timeline-${a.type}">
            <span class="timeline-icon">${iconMap[a.type] || 'ℹ️'}</span>
            <span class="timeline-message">${escapeHtml(a.data.message || '')}</span>
            <span class="timeline-time">${formatTimestamp(a.timestamp)}</span>
          </div>
        `;
      }).join('')}
    </div>
  `;
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function closeSessionModal() {
  const modal = document.querySelector('.modal');
  if (modal) {
    modal.classList.remove('show');
    setTimeout(() => modal.remove(), 300);
  }
}
