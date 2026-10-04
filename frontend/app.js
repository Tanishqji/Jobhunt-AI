/**
 * JobHunt AI Dashboard — Application Logic & Onboarding Flow
 */

const state = {
  view: 'onboarding', // 'onboarding' | 'dashboard'
  activeTab: 'feed',
  jobs: [],
  companies: [],
  profile: {},
  config: {},
  stats: {},
  searchQuery: '',
  minScore: 0.0,
  appliedFilter: 'all', // 'all' | 'unapplied' | 'applied'
  isRunning: false,
  pollInterval: null,
};

// --- Initialization ---
document.addEventListener('DOMContentLoaded', async () => {
  await Promise.all([
    loadStats(),
    loadJobs(),
    loadCompanies(),
    loadProfile(),
    loadConfig(),
  ]);

  // If user already has a configured profile, pre-fill form
  prefillOnboardingForm();

  // Check agent status every 4 seconds
  setInterval(checkAgentStatus, 4000);
});

// --- Page & View Navigation ---
function goToDashboard() {
  document.getElementById('view-onboarding').style.display = 'none';
  document.getElementById('view-dashboard').style.display = 'flex';
  state.view = 'dashboard';
  loadJobs();
  loadStats();
}

function goToOnboarding() {
  document.getElementById('view-dashboard').style.display = 'none';
  document.getElementById('view-onboarding').style.display = 'flex';
  state.view = 'onboarding';
  prefillOnboardingForm();
}

function switchTab(tabId) {
  state.activeTab = tabId;

  document.querySelectorAll('.sidebar-nav .nav-item').forEach(el => el.classList.remove('active'));
  document.querySelectorAll('.tab-view').forEach(el => el.classList.remove('active'));

  const navBtn = document.getElementById(`nav-${tabId}`);
  const tabView = document.getElementById(`tab-${tabId}`);

  if (navBtn) navBtn.classList.add('active');
  if (tabView) tabView.classList.add('active');

  if (tabId === 'tracker') renderTracker();
  if (tabId === 'digest') refreshDigest();
}

// --- Onboarding Flow ---
function prefillOnboardingForm() {
  if (state.profile.name) {
    document.getElementById('ob-fullname').value = state.profile.name;
  }
  if (state.profile.target_titles && state.profile.target_titles.length) {
    document.getElementById('ob-positions').value = state.profile.target_titles.join(', ');
  }
  if (state.config.filters && state.config.filters.locations) {
    const locs = [...state.config.filters.locations];
    if (state.config.filters.allow_remote && !locs.includes('remote')) {
      locs.push('Remote');
    }
    document.getElementById('ob-locations').value = locs.join(', ');
  }
  // Try fetching current MAIL_TO from .env via stats or fallback
  if (state.stats && state.stats.email) {
    document.getElementById('ob-email').value = state.stats.email;
  }
}

function handleFileSelected(input) {
  const file = input.files[0];
  if (!file) return;
  document.getElementById('dropzone-title').textContent = `📄 ${file.name} (${Math.round(file.size / 1024)} KB)`;
  document.getElementById('resume-dropzone').style.borderColor = 'var(--accent-cyan)';
}

async function handleOnboardSubmit(event) {
  event.preventDefault();

  const form = document.getElementById('onboard-form');
  const formData = new FormData(form);
  const btn = document.getElementById('btn-submit-onboard');
  btn.disabled = true;

  // Show processing overlay with animation
  const overlay = document.getElementById('view-processing');
  overlay.classList.add('open');

  // Animated progression
  const chk1 = document.getElementById('chk-1');
  const chk2 = document.getElementById('chk-2');
  const chk3 = document.getElementById('chk-3');
  const chk4 = document.getElementById('chk-4');

  chk1.className = 'check-item done';
  chk2.className = 'check-item active';

  try {
    const res = await fetch('/api/onboard', {
      method: 'POST',
      body: formData,
    });

    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.detail || 'Failed to submit onboarding');
    }

    const data = await res.json();

    setTimeout(() => {
      chk2.className = 'check-item done';
      chk3.className = 'check-item active';
    }, 1200);

    setTimeout(() => {
      chk3.className = 'check-item done';
      chk4.className = 'check-item active';
    }, 2400);

    setTimeout(async () => {
      chk4.className = 'check-item done';
      overlay.classList.remove('open');
      btn.disabled = false;

      // Update banner with user info
      document.getElementById('banner-title').textContent = `Opportunities for ${data.name}`;
      document.getElementById('banner-desc').textContent = `Matched for: ${data.positions.join(', ')} in ${data.locations.join(', ')}. Alerts sent to ${data.email}`;

      // Transition to Dashboard View!
      goToDashboard();

      // Trigger background status check and reload jobs
      await loadProfile();
      await loadConfig();
      await loadStats();
      loadJobs();
      pollLogs();
    }, 3600);

  } catch (err) {
    overlay.classList.remove('open');
    btn.disabled = false;
    alert('Onboarding error: ' + err.message);
  }
}

// --- API Calls & Data Loaders ---
async function loadStats() {
  try {
    const res = await fetch('/api/stats');
    if (!res.ok) return;
    const data = await res.json();
    state.stats = data;

    document.getElementById('stat-tracked').textContent = data.tracked || 0;
    document.getElementById('stat-emailed').textContent = data.emailed || 0;
    document.getElementById('stat-applied').textContent = data.applied || 0;
    document.getElementById('stat-companies').textContent = data.companies_monitored || 0;

    document.getElementById('badge-total-jobs').textContent = data.tracked || 0;
    document.getElementById('badge-applied-count').textContent = data.applied || 0;
    document.getElementById('badge-companies-count').textContent = data.companies_monitored || 0;

    updateAgentIndicator(data.is_running);
  } catch (err) {
    console.error('Failed to load stats:', err);
  }
}

async function loadJobs() {
  try {
    const res = await fetch('/api/jobs');
    if (!res.ok) throw new Error('API error');
    const data = await res.json();
    state.jobs = data.jobs || [];
    renderJobs();
    if (state.activeTab === 'tracker') renderTracker();
  } catch (err) {
    console.error('Failed to load jobs:', err);
    document.getElementById('jobs-grid').innerHTML = `
      <div class="empty-state">
        <p>Failed to connect to backend server. Make sure <code>python -m jobhunt web</code> is running.</p>
      </div>`;
  }
}

async function loadCompanies() {
  try {
    const res = await fetch('/api/companies');
    if (!res.ok) return;
    const data = await res.json();
    state.companies = data.companies || [];
    renderCompanies();
  } catch (err) {
    console.error('Failed to load companies:', err);
  }
}

async function loadProfile() {
  try {
    const res = await fetch('/api/profile');
    if (!res.ok) return;
    state.profile = await res.json();
    populateProfileForm();
  } catch (err) {
    console.error('Failed to load profile:', err);
  }
}

async function loadConfig() {
  try {
    const res = await fetch('/api/config');
    if (!res.ok) return;
    state.config = await res.json();
    populateConfigForm();
  } catch (err) {
    console.error('Failed to load config:', err);
  }
}

// --- Search and Filtering ---
function handleSearch(val) {
  state.searchQuery = val.trim().toLowerCase();
  renderJobs();
  if (state.activeTab === 'tracker') renderTracker();
}

function handleScoreChange(val) {
  state.minScore = parseFloat(val);
  document.getElementById('score-display').textContent = Number(val).toFixed(1);
  renderJobs();
}

function setAppliedFilter(filter) {
  state.appliedFilter = filter;
  document.querySelectorAll('.filter-toggle-group .filter-btn').forEach(b => b.classList.remove('active'));
  document.getElementById(`f-${filter}`).classList.add('active');
  renderJobs();
}

function getFilteredJobs() {
  return state.jobs.filter(job => {
    // Score filter
    if ((job.score || 0) < state.minScore) return false;

    // Applied filter
    if (state.appliedFilter === 'applied' && !job.applied) return false;
    if (state.appliedFilter === 'unapplied' && job.applied) return false;

    // Search query
    if (state.searchQuery) {
      const corpus = `${job.title} ${job.company} ${job.location} ${job.reason}`.toLowerCase();
      if (!corpus.includes(state.searchQuery)) return false;
    }

    return true;
  });
}

// --- Render Functions ---
function renderJobs() {
  const container = document.getElementById('jobs-grid');
  const filtered = getFilteredJobs();

  if (filtered.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style="margin-bottom:12px;opacity:0.5;">
          <circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line>
        </svg>
        <h3>No matching jobs found</h3>
        <p>Try lowering the minimum score or adjusting search keywords.</p>
      </div>`;
    return;
  }

  container.innerHTML = filtered.map(job => {
    const score = job.score || 0;
    let scoreClass = 'score-low';
    if (score >= 7.0) scoreClass = 'score-high';
    else if (score >= 5.0) scoreClass = 'score-med';

    const initial = job.company ? job.company.charAt(0).toUpperCase() : 'J';
    const ats = job.job_id.split(':')[0] || 'ats';

    return `
      <div class="job-card ${job.applied ? 'is-applied' : ''}" id="card-${encodeURIComponent(job.job_id)}">
        <div class="job-card-top">
          <div class="job-company-badge">
            <div class="company-avatar">${initial}</div>
            <div>
              <span class="company-name">${escapeHtml(job.company)}</span>
              <span class="ats-tag">${ats}</span>
            </div>
          </div>
          <div class="job-score-gauge ${scoreClass}">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"></polygon></svg>
            <span>${score.toFixed(1)}</span>
          </div>
        </div>

        <h3 class="job-title">${escapeHtml(job.title)}</h3>
        <div class="job-location">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"></path><circle cx="12" cy="10" r="3"></circle></svg>
          <span>${escapeHtml(job.location || 'Remote / Unspecified')}</span>
        </div>

        ${job.reason ? `<div class="job-reason">${escapeHtml(job.reason)}</div>` : ''}

        <div class="job-card-actions">
          <a href="${job.url}" target="_blank" rel="noopener" class="btn-apply-direct">
            <span>Apply Now</span>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path><polyline points="15 3 21 3 21 9"></polyline><line x1="10" y1="14" x2="21" y2="3"></line></svg>
          </a>
          <button class="btn-toggle-apply ${job.applied ? 'applied' : ''}" onclick="toggleApply('${escapeQuote(job.job_id)}')">
            ${job.applied ? '✓ Applied' : 'Mark Applied'}
          </button>
        </div>
      </div>
    `;
  }).join('');
}

function renderTracker() {
  const tbody = document.getElementById('tracker-body');
  const filtered = getFilteredJobs();

  if (filtered.length === 0) {
    tbody.innerHTML = `<tr><td colspan="7" style="text-align:center;padding:30px;color:var(--text-subtle);">No jobs in tracker matching current filters.</td></tr>`;
    return;
  }

  tbody.innerHTML = filtered.map(job => {
    const score = job.score || 0;
    const appliedDate = job.applied_on ? new Date(job.applied_on).toLocaleDateString() : '—';
    return `
      <tr>
        <td><strong>${escapeHtml(job.company)}</strong></td>
        <td><a href="${job.url}" target="_blank" style="color:var(--accent-cyan);text-decoration:none;font-weight:600;">${escapeHtml(job.title)}</a></td>
        <td>${escapeHtml(job.location)}</td>
        <td><span class="job-score-gauge ${score >= 7 ? 'score-high' : score >= 5 ? 'score-med' : 'score-low'}">${score.toFixed(1)}</span></td>
        <td>
          <span style="font-size:12px;font-weight:700;color:${job.applied ? 'var(--color-green)' : 'var(--text-subtle)'};">
            ${job.applied ? '✓ Applied' : 'Pending'}
          </span>
        </td>
        <td style="color:var(--text-muted);font-family:var(--font-mono);font-size:12px;">${appliedDate}</td>
        <td>
          <button class="btn-toggle-apply ${job.applied ? 'applied' : ''}" onclick="toggleApply('${escapeQuote(job.job_id)}')">
            ${job.applied ? 'Undo' : 'Mark Applied'}
          </button>
        </td>
      </tr>
    `;
  }).join('');
}

function renderCompanies() {
  const container = document.getElementById('companies-grid');
  if (state.companies.length === 0) {
    container.innerHTML = `<div class="empty-state"><p>No companies configured. Click "+ Add New Board" to add one.</p></div>`;
    return;
  }

  container.innerHTML = state.companies.map(c => `
    <div class="company-card">
      <div class="company-info">
        <h4>${escapeHtml(c.name)}</h4>
        <div class="company-meta">
          <span class="ats-tag">${escapeHtml(c.ats)}</span>
          <span style="margin-left:6px;font-family:var(--font-mono);">${escapeHtml(c.slug)}</span>
        </div>
      </div>
      <button class="btn-icon-danger" title="Remove company" onclick="deleteCompany('${escapeQuote(c.ats)}', '${escapeQuote(c.slug)}')">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
      </button>
    </div>
  `).join('');
}

// --- Actions ---
async function toggleApply(jobId) {
  try {
    const res = await fetch(`/api/jobs/${encodeURIComponent(jobId)}/apply`, { method: 'POST' });
    if (!res.ok) return;
    const data = await res.json();

    // Update local state
    const job = state.jobs.find(j => j.job_id === jobId);
    if (job) {
      job.applied = data.applied;
      job.applied_on = data.applied ? new Date().toISOString() : null;
    }

    loadStats();
    renderJobs();
    if (state.activeTab === 'tracker') renderTracker();
  } catch (err) {
    console.error('Toggle apply failed:', err);
  }
}

async function deleteCompany(ats, slug) {
  if (!confirm(`Are you sure you want to stop monitoring ${slug} (${ats})?`)) return;
  try {
    const res = await fetch(`/api/companies/${encodeURIComponent(ats)}/${encodeURIComponent(slug)}`, {
      method: 'DELETE',
    });
    if (!res.ok) return;
    const data = await res.json();
    state.companies = data.companies;
    renderCompanies();
    loadStats();
  } catch (err) {
    console.error('Delete company error:', err);
  }
}

function refreshDigest() {
  const frame = document.getElementById('digest-frame');
  frame.src = '/api/digest?t=' + Date.now();
}

// --- Forms ---
function populateProfileForm() {
  const p = state.profile;
  if (!p) return;
  document.getElementById('prof-name').value = p.name || '';
  document.getElementById('prof-title').value = p.current_title || '';
  document.getElementById('prof-seniority').value = p.seniority || '';
  document.getElementById('prof-education').value = p.education || '';
  document.getElementById('prof-skills').value = (p.core_skills || []).join(', ');
}

function populateConfigForm() {
  const c = state.config;
  if (!c) return;
  const f = c.filters || {};
  document.getElementById('cfg-score-threshold').value = c.score_threshold || 5.5;
  document.getElementById('cfg-max-age').value = f.max_age_days || 30;
  document.getElementById('cfg-locations').value = (f.locations || []).join(', ');
  document.getElementById('cfg-allow-remote').checked = Boolean(f.allow_remote);
}

async function saveProfileAndConfig() {
  const p = state.profile || {};
  p.name = document.getElementById('prof-name').value.trim();
  p.current_title = document.getElementById('prof-title').value.trim();
  p.seniority = document.getElementById('prof-seniority').value.trim();
  p.education = document.getElementById('prof-education').value.trim();
  p.core_skills = document.getElementById('prof-skills').value.split(',').map(s => s.trim()).filter(Boolean);

  const c = state.config || {};
  c.score_threshold = parseFloat(document.getElementById('cfg-score-threshold').value) || 5.5;
  c.filters = c.filters || {};
  c.filters.max_age_days = parseInt(document.getElementById('cfg-max-age').value) || 30;
  c.filters.locations = document.getElementById('cfg-locations').value.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  c.filters.allow_remote = document.getElementById('cfg-allow-remote').checked;

  try {
    await fetch('/api/profile', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(p),
    });

    await fetch('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(c),
    });

    alert('Settings successfully updated!');
  } catch (err) {
    alert('Failed to save settings: ' + err.message);
  }
}

// --- Run Crawler Modal & Execution ---
function openRunModal() {
  document.getElementById('modal-run').classList.add('open');
  checkAgentStatus();
}

function closeRunModal() {
  document.getElementById('modal-run').classList.remove('open');
}

async function startScan() {
  const sendEmail = document.getElementById('run-send').checked;
  const noDraft = document.getElementById('run-nodraft').checked;
  const mock = document.getElementById('run-mock').checked;

  const btn = document.getElementById('btn-start-scan');
  btn.disabled = true;

  try {
    const res = await fetch('/api/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ send: sendEmail, no_draft: noDraft, mock: mock }),
    });

    if (!res.ok) {
      const err = await res.json();
      alert(err.detail || 'Could not start scan');
      btn.disabled = false;
      return;
    }

    state.isRunning = true;
    updateAgentIndicator(true);
    pollLogs();
  } catch (err) {
    alert('Request failed: ' + err.message);
    btn.disabled = false;
  }
}

function pollLogs() {
  if (state.pollInterval) clearInterval(state.pollInterval);

  state.pollInterval = setInterval(async () => {
    try {
      const res = await fetch('/api/run/status');
      if (!res.ok) return;
      const data = await res.json();

      const term = document.getElementById('terminal-output');
      const badge = document.getElementById('terminal-badge');

      term.textContent = data.logs || 'Scan initialized...';
      term.scrollTop = term.scrollHeight;

      if (data.is_running) {
        badge.textContent = 'Running...';
        badge.style.color = 'var(--accent-cyan)';
      } else {
        badge.textContent = data.exit_code === 0 ? 'Completed' : 'Finished with errors';
        badge.style.color = data.exit_code === 0 ? 'var(--color-green)' : 'var(--color-red)';
        clearInterval(state.pollInterval);
        const btn = document.getElementById('btn-start-scan');
        if (btn) btn.disabled = false;
        state.isRunning = false;
        updateAgentIndicator(false);
        loadStats();
        loadJobs();
      }
    } catch (err) {
      console.error('Error polling status:', err);
    }
  }, 1500);
}

async function checkAgentStatus() {
  try {
    const res = await fetch('/api/run/status');
    if (!res.ok) return;
    const data = await res.json();
    updateAgentIndicator(data.is_running);
    if (data.is_running && !state.pollInterval) {
      pollLogs();
    }
  } catch (err) {}
}

function updateAgentIndicator(isRunning) {
  const pulse = document.getElementById('agent-pulse');
  const label = document.getElementById('agent-status-text');
  const modalPulse = document.getElementById('modal-pulse');

  if (isRunning) {
    if (pulse) { pulse.className = 'pulse-dot running'; }
    if (label) { label.textContent = 'Agent Scanning...'; label.style.color = 'var(--accent-cyan)'; }
    if (modalPulse) { modalPulse.className = 'pulse-dot running'; }
  } else {
    if (pulse) { pulse.className = 'pulse-dot idle'; }
    if (label) { label.textContent = 'Agent Idle'; label.style.color = 'var(--text-muted)'; }
    if (modalPulse) { modalPulse.className = 'pulse-dot idle'; }
  }
}

// --- Add Company Modal ---
function openAddCompanyModal() {
  document.getElementById('modal-company').classList.add('open');
  document.getElementById('comp-validate-msg').textContent = '';
}

function closeCompanyModal() {
  document.getElementById('modal-company').classList.remove('open');
}

async function submitCompany() {
  const name = document.getElementById('comp-name').value.trim();
  const ats = document.getElementById('comp-ats').value;
  const slug = document.getElementById('comp-slug').value.trim();
  const msgEl = document.getElementById('comp-validate-msg');
  const btn = document.getElementById('btn-save-company');

  if (!name || !slug) {
    msgEl.className = 'validation-msg error';
    msgEl.textContent = 'Please fill in both name and board slug.';
    return;
  }

  btn.disabled = true;
  msgEl.className = 'validation-msg';
  msgEl.textContent = 'Validating ATS API endpoint...';

  try {
    const res = await fetch('/api/companies', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, ats, slug }),
    });

    const data = await res.json();
    if (!res.ok) {
      msgEl.className = 'validation-msg error';
      msgEl.textContent = data.detail || 'Validation failed. Check slug.';
      btn.disabled = false;
      return;
    }

    msgEl.className = 'validation-msg success';
    msgEl.textContent = `Success! Board verified with ${data.active_jobs} active postings.`;

    setTimeout(() => {
      closeCompanyModal();
      btn.disabled = false;
      loadCompanies();
      loadStats();
    }, 1200);
  } catch (err) {
    msgEl.className = 'validation-msg error';
    msgEl.textContent = 'Network error: ' + err.message;
    btn.disabled = false;
  }
}

// Utility
function escapeHtml(str) {
  if (!str) return '';
  return String(str).replace(/[&<>"']/g, m => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  })[m]);
}

function escapeQuote(str) {
  if (!str) return '';
  return String(str).replace(/'/g, "\\'");
}
