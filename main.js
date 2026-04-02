const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs   = require('fs');
const initSqlJs = require('sql.js');

let db;
let dbPath;
let win;

// ── Utility helpers ───────────────────────────────────────────────────────────

function parseDurationToSeconds(str) {
  if (!str || typeof str !== 'string') return 0;
  str = str.trim();
  const parts = str.split(':').map(s => parseInt(s, 10) || 0);
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return 0;
}

function parseTimeToMinutes(str) {
  if (!str || typeof str !== 'string') return -1;
  str = str.trim();
  if (!str) return -1;
  // Excel fractional day (e.g. "0.4375" = 10:30 AM)
  const num = parseFloat(str);
  if (!isNaN(num) && num > 0 && num < 1) return Math.round(num * 1440);

  const ampmMatch = str.match(/\s*(AM|PM)\s*$/i);
  const ampm = ampmMatch ? ampmMatch[1].toUpperCase() : null;
  const timeStr = str.replace(/\s*(AM|PM)\s*$/i, '').trim();
  const parts = timeStr.split(':').map(s => parseInt(s, 10) || 0);
  let h = parts[0];
  const m = parts[1] || 0;

  if (ampm === 'PM' && h !== 12) h += 12;
  if (ampm === 'AM' && h === 12) h = 0;
  return h * 60 + m;
}

function normalizeDate(str) {
  if (!str) return '';
  str = str.trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(str)) return str.slice(0, 10);
  const m = str.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m) return `${m[3]}-${m[1].padStart(2,'0')}-${m[2].padStart(2,'0')}`;
  const n = parseInt(str, 10);
  if (!isNaN(n) && n > 40000 && n < 60000) {
    const d = new Date((n - 25569) * 86400000);
    return d.toISOString().slice(0, 10);
  }
  return str;
}

function parseCSVLine(line) {
  const result = [];
  let curr = '', inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      if (inQ && line[i + 1] === '"') { curr += '"'; i++; }
      else inQ = !inQ;
    } else if (c === ',' && !inQ) {
      result.push(curr.trim());
      curr = '';
    } else {
      curr += c;
    }
  }
  result.push(curr.trim());
  return result;
}

// ── DB helpers ────────────────────────────────────────────────────────────────

function saveDB() {
  const data = db.export();
  fs.writeFileSync(dbPath, Buffer.from(data));
}

function queryAll(sql, params = {}) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

function queryGet(sql, params = {}) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  let result = null;
  if (stmt.step()) result = stmt.getAsObject();
  stmt.free();
  return result;
}

// ── Database init ─────────────────────────────────────────────────────────────

async function initDB() {
  const SQL = await initSqlJs({
    locateFile: file => path.join(__dirname, 'node_modules/sql.js/dist', file),
  });

  dbPath = path.join(app.getPath('userData'), 'bathroom-tracker.db');

  if (fs.existsSync(dbPath)) {
    db = new SQL.Database(fs.readFileSync(dbPath));
  } else {
    db = new SQL.Database();
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS passes (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      date           TEXT,
      total_duration TEXT,
      total_seconds  INTEGER DEFAULT 0,
      first_name     TEXT,
      last_name      TEXT,
      email          TEXT,
      out_location   TEXT,
      out_time       TEXT,
      out_minutes    INTEGER DEFAULT -1,
      in_location    TEXT,
      in_time        TEXT,
      out_location2  TEXT,
      out_time2      TEXT,
      in_location2   TEXT,
      in_time2       TEXT,
      type           TEXT,
      comment        TEXT
    );
    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS uq_pass
      ON passes (date, first_name, last_name, out_time);
  `);

  const defaults = [
    ['block_count','5'],
    ['block1_name','Block 1'], ['block1_start','07:45'], ['block1_end','09:15'],
    ['block2_name','Block 2'], ['block2_start','09:20'], ['block2_end','10:50'],
    ['block3_name','Block 3'], ['block3_start','10:55'], ['block3_end','12:25'],
    ['block4_name','Block 4'], ['block4_start','12:30'], ['block4_end','14:00'],
    ['block5_name','Block 5'], ['block5_start','14:05'], ['block5_end','15:35'],
    ['near_limit_min','10'],
    ['over_limit_min','15'],
    ['default_blocks','3,4'],
  ];
  defaults.forEach(([k, v]) => {
    db.run('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)', [k, v]);
  });

  saveDB();
}

// ── Window ────────────────────────────────────────────────────────────────────

function createWindow() {
  win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    title: 'Bathroom Tracker',
  });
  win.loadFile('renderer/index.html');
}

app.whenReady().then(async () => {
  await initDB();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ── IPC Handlers ──────────────────────────────────────────────────────────────

ipcMain.handle('get-settings', () => {
  const rows = queryAll('SELECT key, value FROM settings');
  return Object.fromEntries(rows.map(r => [r.key, r.value]));
});

ipcMain.handle('save-settings', (_e, settings) => {
  for (const [k, v] of Object.entries(settings)) {
    db.run('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', [k, v]);
  }
  saveDB();
  return true;
});

ipcMain.handle('import-csv', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title: 'Import Securly Pass CSV',
    filters: [{ name: 'CSV Files', extensions: ['csv'] }],
    properties: ['openFile'],
  });
  if (canceled || !filePaths.length) return { success: false, message: 'Cancelled' };

  try {
    const content = fs.readFileSync(filePaths[0], 'utf-8');
    const lines = content.split(/\r?\n/).filter(l => l.trim());
    if (lines.length < 2) return { success: false, message: 'File has no data rows' };

    let count = 0;
    db.run('BEGIN');
    try {
      for (const line of lines.slice(1)) {
        const c = parseCSVLine(line);
        if (c.length < 4) continue;

        const date  = normalizeDate(c[0]);
        const dur   = c[1]  || '';
        const secs  = parseDurationToSeconds(dur);
        const fn    = c[2]  || '';
        const ln    = c[3]  || '';
        if (!fn && !ln && !date) continue;

        db.run(`
          INSERT OR IGNORE INTO passes (
            date, total_duration, total_seconds, first_name, last_name, email,
            out_location, out_time, out_minutes, in_location, in_time,
            out_location2, out_time2, in_location2, in_time2, type, comment
          ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        `, [
          date, dur, secs, fn, ln, c[4]||'',
          c[5]||'', c[6]||'', parseTimeToMinutes(c[6]||''), c[7]||'', c[8]||'',
          c[9]||'', c[10]||'', c[11]||'', c[12]||'', c[13]||'', c[14]||'',
        ]);
        count++;
      }
      db.run('COMMIT');
    } catch (e) {
      db.run('ROLLBACK');
      throw e;
    }

    saveDB();
    return { success: true, count, message: `Imported ${count} pass${count !== 1 ? 'es' : ''}` };
  } catch (err) {
    return { success: false, message: err.message };
  }
});

ipcMain.handle('get-raw-data', (_e, { dateFrom, dateTo } = {}) => {
  const whereClauses = ['1=1'];
  const params = {};
  if (dateFrom) { whereClauses.push('date >= :dateFrom'); params[':dateFrom'] = dateFrom; }
  if (dateTo)   { whereClauses.push('date <= :dateTo');   params[':dateTo']   = dateTo;   }
  const where = whereClauses.join(' AND ');
  return queryAll(`SELECT * FROM passes WHERE ${where} ORDER BY date DESC, last_name, first_name`, params);
});

ipcMain.handle('get-student-totals', (_e, { dateFrom, dateTo, blockRanges, nearLimit, overLimit } = {}) => {
  const whereClauses = ['1=1'];
  const params = {};

  if (dateFrom) { whereClauses.push('date >= :dateFrom'); params[':dateFrom'] = dateFrom; }
  if (dateTo)   { whereClauses.push('date <= :dateTo');   params[':dateTo']   = dateTo;   }

  if (blockRanges && blockRanges.length > 0) {
    const blockSQL = blockRanges.map((r, i) => {
      params[`:bs${i}`] = r.start;
      params[`:be${i}`] = r.end;
      if (r.teacher) {
        params[`:bt${i}`] = r.teacher.toLowerCase().trim();
        return `(out_minutes >= :bs${i} AND out_minutes <= :be${i} AND LOWER(TRIM(out_location)) = :bt${i})`;
      }
      return `(out_minutes >= :bs${i} AND out_minutes <= :be${i})`;
    }).join(' OR ');
    whereClauses.push(`(${blockSQL})`);
  }

  whereClauses.push(`NOT (LOWER(TRIM(out_location2)) LIKE '%request nurse%')`);

  const where = whereClauses.join(' AND ');
  const rows = queryAll(`
    SELECT
      last_name, first_name,
      COUNT(*) AS num_passes,
      SUM(total_seconds) AS total_secs
    FROM passes
    WHERE ${where}
    GROUP BY LOWER(TRIM(last_name)), LOWER(TRIM(first_name))
    ORDER BY last_name, first_name
  `, params);

  const nearSecs = (Number(nearLimit) || 10) * 60;
  const overSecs = (Number(overLimit) || 15) * 60;

  return rows.map(r => ({
    ...r,
    status: r.total_secs >= overSecs ? 'Over Limit'
           : r.total_secs >= nearSecs ? 'Near Limit'
           : 'OK',
  }));
});

ipcMain.handle('get-pass-detail', (_e, { dateFrom, dateTo, blockRanges, search, studentFirst, studentLast } = {}) => {
  const whereClauses = ['1=1'];
  const params = {};

  if (dateFrom) { whereClauses.push('date >= :dateFrom'); params[':dateFrom'] = dateFrom; }
  if (dateTo)   { whereClauses.push('date <= :dateTo');   params[':dateTo']   = dateTo;   }
  if (studentFirst && studentLast) {
    whereClauses.push('LOWER(TRIM(first_name)) = :sFirst AND LOWER(TRIM(last_name)) = :sLast');
    params[':sFirst'] = studentFirst.toLowerCase().trim();
    params[':sLast']  = studentLast.toLowerCase().trim();
  } else if (search) {
    whereClauses.push('(LOWER(first_name) LIKE :search OR LOWER(last_name) LIKE :search)');
    params[':search'] = `%${search.toLowerCase()}%`;
  }

  if (blockRanges && blockRanges.length > 0) {
    const blockSQL = blockRanges.map((r, i) => {
      params[`:bs${i}`] = r.start;
      params[`:be${i}`] = r.end;
      if (r.teacher) {
        params[`:bt${i}`] = r.teacher.toLowerCase().trim();
        return `(out_minutes >= :bs${i} AND out_minutes <= :be${i} AND LOWER(TRIM(out_location)) = :bt${i})`;
      }
      return `(out_minutes >= :bs${i} AND out_minutes <= :be${i})`;
    }).join(' OR ');
    whereClauses.push(`(${blockSQL})`);
  }

  const where = whereClauses.join(' AND ');
  return queryAll(`
    SELECT id, date, last_name, first_name, total_duration, total_seconds,
           out_location, out_time, in_location, in_time,
           out_location2, out_time2, in_location2, in_time2, type, comment
    FROM passes
    WHERE ${where}
    ORDER BY date DESC, out_time
  `, params);
});

ipcMain.handle('clear-data', () => {
  db.run('DELETE FROM passes');
  saveDB();
  return true;
});

ipcMain.handle('get-teachers', () => {
  return queryAll(`
    SELECT DISTINCT TRIM(out_location) AS name
    FROM passes
    WHERE out_location IS NOT NULL AND TRIM(out_location) != ''
    ORDER BY name
  `).map(r => r.name);
});

ipcMain.handle('get-stats', () => {
  return queryGet(`
    SELECT
      COUNT(*) AS total_passes,
      COUNT(DISTINCT LOWER(TRIM(last_name)) || ',' || LOWER(TRIM(first_name))) AS total_students,
      MIN(date) AS earliest_date,
      MAX(date) AS latest_date
    FROM passes
  `);
});
