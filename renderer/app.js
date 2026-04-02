// ── State ─────────────────────────────────────────────────────────────────────
let settings = {};
let teachers = [];

// ── Utility ───────────────────────────────────────────────────────────────────

function secsToDisplay(secs) {
  if (!secs || secs < 0) return '0:00';
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function hhmToMins(hhmm) {
  if (!hhmm) return -1;
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + (m || 0);
}

function formatTimeDisplay(hhmm) {
  if (!hhmm) return '';
  const [h, m] = hhmm.split(':').map(Number);
  const ampm = h >= 12 ? 'PM' : 'AM';
  const h12 = h % 12 || 12;
  return `${h12}:${String(m).padStart(2, '0')} ${ampm}`;
}

// Returns the active block number for a given block-tabs container id
function getActiveBlock(tabsId) {
  const active = document.querySelector(`#${tabsId} .block-tab.active`);
  return active ? Number(active.dataset.block) : 1;
}

// Returns [{start, end, teacher}] for the given block number
function getBlockRange(blockNum) {
  return [{
    start:   hhmToMins(settings[`block${blockNum}_start`]   || '00:00'),
    end:     hhmToMins(settings[`block${blockNum}_end`]     || '23:59'),
    teacher: settings[`block${blockNum}_teacher`] || '',
  }];
}

function formatDate(d) {
  if (!d) return '';
  const p = d.split('-');
  if (p.length === 3) return `${parseInt(p[1])}/${parseInt(p[2])}/${p[0]}`;
  return d;
}

function esc(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function showToast(msg, type = 'info') {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = `toast ${type}`;
  el.classList.remove('hidden');
  clearTimeout(el._timer);
  el._timer = setTimeout(() => el.classList.add('hidden'), 3500);
}

// ── Tabs ──────────────────────────────────────────────────────────────────────

document.querySelectorAll('.tab').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(s => s.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById(`tab-${btn.dataset.tab}`).classList.add('active');
    const loaders = { totals: loadTotals, detail: loadDetail, raw: loadRaw };
    if (loaders[btn.dataset.tab]) loaders[btn.dataset.tab]();
  });
});

// ── Block tabs (event delegation) ────────────────────────────────────────────

document.getElementById('totals-block-tabs').addEventListener('click', e => {
  const btn = e.target.closest('.block-tab');
  if (!btn) return;
  document.querySelectorAll('#totals-block-tabs .block-tab').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  loadTotals();
});

document.getElementById('detail-block-tabs').addEventListener('click', e => {
  const btn = e.target.closest('.block-tab');
  if (!btn) return;
  document.querySelectorAll('#detail-block-tabs .block-tab').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  loadDetail();
});

// ── Block tab rendering ───────────────────────────────────────────────────────

function renderBlockTabs() {
  const count = Number(settings.block_count) || 5;
  const defaultBlock = 1;

  ['totals-block-tabs', 'detail-block-tabs'].forEach(containerId => {
    const container = document.getElementById(containerId);
    const activeBtn = container.querySelector('.block-tab.active');
    const currentActive = activeBtn ? Number(activeBtn.dataset.block) : 0;
    const setActive = (currentActive >= 1 && currentActive <= count) ? currentActive : defaultBlock;

    let html = '';
    for (let i = 1; i <= count; i++) {
      const name  = settings[`block${i}_name`]  || `Block ${i}`;
      const start = settings[`block${i}_start`] || '';
      const end   = settings[`block${i}_end`]   || '';
      const teacher = settings[`block${i}_teacher`] || '';
      const teacherLabel = teacher === '__none__' ? 'No Teacher' : teacher;
      const label = start && end
        ? `${esc(name)} (${formatTimeDisplay(start)}–${formatTimeDisplay(end)}${teacherLabel ? ' · ' + esc(teacherLabel) : ''})`
        : esc(name);
      html += `<button class="block-tab${i === setActive ? ' active' : ''}" data-block="${i}"><span data-block-label="${i}">${label}</span></button>`;
    }
    container.innerHTML = html;
  });
}

// ── Student Totals ────────────────────────────────────────────────────────────

async function loadTotals() {
  const activeBlock = getActiveBlock('totals-block-tabs');
  const statsEl = document.getElementById('totals-stats');
  const tableEl = document.getElementById('totals-table');

  const blockRanges = getBlockRange(activeBlock);
  const rows = await window.api.getStudentTotals({
    dateFrom:   document.getElementById('totals-from').value,
    dateTo:     document.getElementById('totals-to').value,
    blockRanges,
    nearLimit:  Number(settings.near_limit_min) || 10,
    overLimit:  Number(settings.over_limit_min) || 15,
  });

  if (!rows.length) {
    statsEl.innerHTML = '<span class="stat">No data</span>';
    tableEl.innerHTML = '<p class="empty">No passes found for the selected filters.</p>';
    return;
  }

  const totalPasses = rows.reduce((a, r) => a + r.num_passes, 0);
  const overCount   = rows.filter(r => r.status === 'Over Limit').length;
  const nearCount   = rows.filter(r => r.status === 'Near Limit').length;

  statsEl.innerHTML = `
    <span class="stat">${rows.length} student${rows.length !== 1 ? 's' : ''}</span>
    <span class="stat">${totalPasses} pass${totalPasses !== 1 ? 'es' : ''}</span>
    ${overCount ? `<span class="stat badge-red">${overCount} over limit</span>` : ''}
    ${nearCount ? `<span class="stat badge-amber">${nearCount} near limit</span>` : ''}
  `;

  let html = `
    <table>
      <thead>
        <tr>
          <th>Last Name</th>
          <th>First Name</th>
          <th class="num">Passes</th>
          <th class="num">Total Time</th>
          <th>Status</th>
        </tr>
      </thead>
      <tbody>
  `;

  for (const r of rows) {
    const badgeClass = r.status === 'Over Limit' ? 'badge-red'
                     : r.status === 'Near Limit' ? 'badge-amber'
                     : 'badge-green';
    const rowClass = r.status === 'Over Limit' ? 'row-highlight-red'
                   : r.status === 'Near Limit' ? 'row-highlight' : '';
    html += `
      <tr class="${rowClass}">
        <td>${esc(r.last_name)}</td>
        <td>${esc(r.first_name)}</td>
        <td class="num">${r.num_passes}</td>
        <td class="num mono">${secsToDisplay(r.total_secs)}</td>
        <td><button class="badge ${badgeClass} badge-btn"
              data-first="${esc(r.first_name)}" data-last="${esc(r.last_name)}"
            >${esc(r.status)}</button></td>
      </tr>
    `;
  }

  html += '</tbody></table>';
  tableEl.innerHTML = html;
}

document.getElementById('refresh-totals').addEventListener('click', loadTotals);

document.getElementById('totals-table').addEventListener('click', e => {
  const btn = e.target.closest('.badge-btn');
  if (!btn) return;
  openStudentModal(btn.dataset.first, btn.dataset.last);
});

// ── Student Detail Modal ──────────────────────────────────────────────────────

async function openStudentModal(firstName, lastName) {
  const modal     = document.getElementById('student-modal');
  const titleEl   = document.getElementById('student-modal-title');
  const bodyEl    = document.getElementById('student-modal-body');

  titleEl.textContent = `${firstName} ${lastName} — Pass Detail`;
  bodyEl.innerHTML = '<p class="empty">Loading…</p>';
  modal.classList.remove('hidden');

  const blockRanges = getBlockRange(getActiveBlock('totals-block-tabs'));
  const rows = await window.api.getPassDetail({
    dateFrom:    document.getElementById('totals-from').value,
    dateTo:      document.getElementById('totals-to').value,
    blockRanges,
    studentFirst: firstName,
    studentLast:  lastName,
  });

  if (!rows.length) {
    bodyEl.innerHTML = '<p class="empty">No passes found.</p>';
    return;
  }

  let html = `
    <table>
      <thead>
        <tr>
          <th>Date</th>
          <th class="num">Duration</th>
          <th>Out Location</th>
          <th>Out Time</th>
          <th>In Time</th>
        </tr>
      </thead>
      <tbody>
  `;
  for (const r of rows) {
    html += `
      <tr>
        <td class="nowrap">${esc(formatDate(r.date))}</td>
        <td class="num mono">${secsToDisplay(r.total_seconds)}</td>
        <td>${esc(r.out_location)}</td>
        <td class="nowrap">${esc(r.out_time)}</td>
        <td class="nowrap">${esc(r.in_time)}</td>
      </tr>
    `;
  }
  html += '</tbody></table>';
  bodyEl.innerHTML = html;
}

document.getElementById('student-modal-close').addEventListener('click', () => {
  document.getElementById('student-modal').classList.add('hidden');
});
document.getElementById('student-modal').addEventListener('click', e => {
  if (e.target === e.currentTarget) e.currentTarget.classList.add('hidden');
});

// ── Pass Detail ───────────────────────────────────────────────────────────────

async function loadDetail() {
  const blockRanges = getBlockRange(getActiveBlock('detail-block-tabs'));
  const rows = await window.api.getPassDetail({
    dateFrom:   document.getElementById('detail-from').value,
    dateTo:     document.getElementById('detail-to').value,
    blockRanges,
    search:     document.getElementById('detail-search').value.trim(),
  });

  const statsEl = document.getElementById('detail-stats');
  const tableEl = document.getElementById('detail-table');

  statsEl.innerHTML = `<span class="stat">${rows.length} pass${rows.length !== 1 ? 'es' : ''}</span>`;

  if (!rows.length) {
    tableEl.innerHTML = '<p class="empty">No passes found for the selected filters.</p>';
    return;
  }

  let html = `
    <table>
      <thead>
        <tr>
          <th>Date</th>
          <th>Last Name</th>
          <th>First Name</th>
          <th class="num">Duration</th>
          <th>Out Location</th>
          <th>Out Time</th>
          <th>In Time</th>
          <th>Out Location 2</th>
          <th>Out Time 2</th>
          <th>In Time 2</th>
          <th>Type</th>
          <th>Comment</th>
        </tr>
      </thead>
      <tbody>
  `;

  for (const r of rows) {
    html += `
      <tr>
        <td class="nowrap">${esc(formatDate(r.date))}</td>
        <td>${esc(r.last_name)}</td>
        <td>${esc(r.first_name)}</td>
        <td class="num mono">${secsToDisplay(r.total_seconds)}</td>
        <td>${esc(r.out_location)}</td>
        <td class="nowrap">${esc(r.out_time)}</td>
        <td class="nowrap">${esc(r.in_time)}</td>
        <td>${esc(r.out_location2)}</td>
        <td class="nowrap">${esc(r.out_time2)}</td>
        <td class="nowrap">${esc(r.in_time2)}</td>
        <td>${esc(r.type)}</td>
        <td>${esc(r.comment)}</td>
      </tr>
    `;
  }

  html += '</tbody></table>';
  tableEl.innerHTML = html;
}

document.getElementById('refresh-detail').addEventListener('click', loadDetail);
document.getElementById('detail-search').addEventListener('keydown', e => {
  if (e.key === 'Enter') loadDetail();
});

// ── Raw Data ──────────────────────────────────────────────────────────────────

async function loadRaw() {
  const [rows, stats] = await Promise.all([
    window.api.getRawData({
      dateFrom: document.getElementById('raw-from').value,
      dateTo:   document.getElementById('raw-to').value,
    }),
    window.api.getStats(),
  ]);

  const statsEl = document.getElementById('raw-stats');
  const tableEl = document.getElementById('raw-table');

  const dateRange = stats.earliest_date
    ? `<span class="stat">${formatDate(stats.earliest_date)} – ${formatDate(stats.latest_date)}</span>`
    : '';
  statsEl.innerHTML = `
    <span class="stat">${stats.total_passes} total passes</span>
    <span class="stat">${stats.total_students} students</span>
    ${dateRange}
  `;

  if (!rows.length) {
    tableEl.innerHTML = `<p class="empty">No data yet. Click <strong>Import CSV from Securly Pass</strong> to load pass records.</p>`;
    return;
  }

  let html = `
    <table class="small">
      <thead>
        <tr>
          <th>Date</th>
          <th>Last Name</th>
          <th>First Name</th>
          <th class="num">Duration</th>
          <th>Out Location</th>
          <th>Out Time</th>
          <th>In Time</th>
          <th>Out Location 2</th>
          <th>Out Time 2</th>
          <th>In Time 2</th>
          <th>Type</th>
          <th>Comment</th>
        </tr>
      </thead>
      <tbody>
  `;

  for (const r of rows) {
    html += `
      <tr>
        <td class="nowrap">${esc(formatDate(r.date))}</td>
        <td>${esc(r.last_name)}</td>
        <td>${esc(r.first_name)}</td>
        <td class="num mono">${secsToDisplay(r.total_seconds)}</td>
        <td>${esc(r.out_location)}</td>
        <td class="nowrap">${esc(r.out_time)}</td>
        <td class="nowrap">${esc(r.in_time)}</td>
        <td>${esc(r.out_location2)}</td>
        <td class="nowrap">${esc(r.out_time2)}</td>
        <td class="nowrap">${esc(r.in_time2)}</td>
        <td>${esc(r.type)}</td>
        <td>${esc(r.comment)}</td>
      </tr>
    `;
  }

  html += '</tbody></table>';
  tableEl.innerHTML = html;
}

document.getElementById('import-btn').addEventListener('click', async () => {
  const result = await window.api.importCSV();
  if (result.success) {
    showToast(result.message, 'success');
    teachers = await window.api.getTeachers();
    renderSettings();
    loadRaw();
  } else if (result.message !== 'Cancelled') {
    showToast(`Import failed: ${result.message}`, 'error');
  }
});

document.getElementById('clear-btn').addEventListener('click', async () => {
  if (!confirm('Delete all pass data? This cannot be undone.')) return;
  await window.api.clearData();
  showToast('All data cleared.', 'info');
  loadRaw();
});

document.getElementById('refresh-raw').addEventListener('click', loadRaw);

// ── Settings ──────────────────────────────────────────────────────────────────

// Read current form values back into settings (call before add/remove/save)
function readFormIntoSettings() {
  const count = Number(settings.block_count) || 5;
  for (let i = 1; i <= count; i++) {
    const nameEl    = document.getElementById(`block${i}-name`);
    const startEl   = document.getElementById(`block${i}-start`);
    const endEl     = document.getElementById(`block${i}-end`);
    const teacherEl = document.getElementById(`block${i}-teacher`);
    if (nameEl)    settings[`block${i}_name`]    = nameEl.value.trim() || `Block ${i}`;
    if (startEl)   settings[`block${i}_start`]   = startEl.value;
    if (endEl)     settings[`block${i}_end`]     = endEl.value;
    if (teacherEl) settings[`block${i}_teacher`] = teacherEl.value;
  }
}

function renderSettings() {
  const count = Number(settings.block_count) || 5;
  const grid = document.getElementById('block-settings-grid');
  let html = `
    <div class="block-row header-row">
      <span></span>
      <span>Name</span>
      <span>Start</span>
      <span>End</span>
      <span>Teacher</span>
      <span></span>
    </div>
  `;
  for (let i = 1; i <= count; i++) {
    let teacherVal = settings[`block${i}_teacher`] || '';
    if (teacherVal && teacherVal !== '__none__' && !teachers.includes(teacherVal)) {
      teacherVal = '';
      settings[`block${i}_teacher`] = '';
    }
    const options = [
      `<option value=""${teacherVal === '' ? ' selected' : ''}>All Teachers</option>`,
      `<option value="__none__"${teacherVal === '__none__' ? ' selected' : ''}>No Teacher</option>`,
      ...teachers.map(t => `<option value="${esc(t)}"${t === teacherVal ? ' selected' : ''}>${esc(t)}</option>`),
    ].join('');
    html += `
      <div class="block-row" data-block-row="${i}">
        <span class="block-num">Block ${i}</span>
        <input type="text" id="block${i}-name"  value="${esc(settings[`block${i}_name`]  || `Block ${i}`)}" />
        <input type="time" id="block${i}-start" value="${esc(settings[`block${i}_start`] || '')}" />
        <input type="time" id="block${i}-end"   value="${esc(settings[`block${i}_end`]   || '')}" />
        <select id="block${i}-teacher">${options}</select>
        ${count > 1
          ? `<button class="btn btn-danger btn-sm remove-block-btn" data-remove="${i}" title="Remove block">✕</button>`
          : '<span></span>'}
      </div>
    `;
  }
  html += `
    <div style="margin-top:8px;">
      <button class="btn" id="add-block-btn">+ Add Block</button>
    </div>
  `;
  grid.innerHTML = html;

  document.getElementById('near-limit').value = settings.near_limit_min || 10;
  document.getElementById('over-limit').value = settings.over_limit_min || 15;

  document.getElementById('add-block-btn').addEventListener('click', addBlock);
  grid.querySelectorAll('.remove-block-btn').forEach(btn => {
    btn.addEventListener('click', () => removeBlock(Number(btn.dataset.remove)));
  });
}

function addBlock() {
  readFormIntoSettings();
  const count = Number(settings.block_count) || 5;
  const newNum = count + 1;
  settings.block_count = String(newNum);
  settings[`block${newNum}_name`]    = `Block ${newNum}`;
  settings[`block${newNum}_start`]   = '';
  settings[`block${newNum}_end`]     = '';
  settings[`block${newNum}_teacher`] = '';
  renderSettings();
  renderBlockTabs();
}

function removeBlock(n) {
  readFormIntoSettings();
  const count = Number(settings.block_count) || 5;
  if (count <= 1) return;
  // Shift blocks n+1..count down by 1
  for (let i = n; i < count; i++) {
    settings[`block${i}_name`]    = settings[`block${i + 1}_name`]    || `Block ${i}`;
    settings[`block${i}_start`]   = settings[`block${i + 1}_start`]   || '';
    settings[`block${i}_end`]     = settings[`block${i + 1}_end`]     || '';
    settings[`block${i}_teacher`] = settings[`block${i + 1}_teacher`] || '';
  }
  delete settings[`block${count}_name`];
  delete settings[`block${count}_start`];
  delete settings[`block${count}_end`];
  delete settings[`block${count}_teacher`];
  settings.block_count = String(count - 1);
  renderSettings();
  renderBlockTabs();
}

document.getElementById('save-settings-btn').addEventListener('click', async () => {
  readFormIntoSettings();
  const count = Number(settings.block_count) || 5;
  const updated = {
    block_count:    String(count),
    near_limit_min: document.getElementById('near-limit').value,
    over_limit_min: document.getElementById('over-limit').value,
  };
  for (let i = 1; i <= count; i++) {
    updated[`block${i}_name`]    = settings[`block${i}_name`]    || `Block ${i}`;
    updated[`block${i}_start`]   = settings[`block${i}_start`]   || '';
    updated[`block${i}_end`]     = settings[`block${i}_end`]     || '';
    updated[`block${i}_teacher`] = settings[`block${i}_teacher`] || '';
  }

  await window.api.saveSettings(updated);
  settings = { ...settings, ...updated };
  renderBlockTabs();
  loadTotals();
  loadRaw();
  showToast('Settings saved.', 'success');
});

// ── Init ──────────────────────────────────────────────────────────────────────

function setCurrentWeekDates() {
  const today = new Date();
  const day = today.getDay(); // 0=Sun, 1=Mon
  const diffToMonday = day === 0 ? -6 : 1 - day;
  const monday = new Date(today);
  monday.setDate(today.getDate() + diffToMonday);
  const friday = new Date(monday);
  friday.setDate(monday.getDate() + 4);
  const fmt = d => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  document.getElementById('totals-from').value = fmt(monday);
  document.getElementById('totals-to').value   = fmt(friday);
}

async function init() {
  [settings, teachers] = await Promise.all([
    window.api.getSettings(),
    window.api.getTeachers(),
  ]);
  setCurrentWeekDates();
  renderSettings();
  renderBlockTabs();
  loadTotals();
  loadRaw();

  const seedBtn = document.getElementById('seed-test-data-btn');
  const hasData = await window.api.hasData();
  if (!hasData) seedBtn.style.display = '';

  seedBtn.addEventListener('click', async () => {
    const result = await window.api.seedTestData();
    if (!result.success) {
      showToast(result.message, 'error');
      return;
    }
    seedBtn.style.display = 'none';
    teachers = await window.api.getTeachers();
    renderSettings();
    renderBlockTabs();
    loadTotals();
    loadRaw();
    showToast('Test data loaded — will be removed when the app closes.', 'info');
  });
}

init();
