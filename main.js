const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs   = require('fs');
const https = require('https');
const { spawn } = require('child_process');
const initSqlJs = require('sql.js');

let db;
let dbPath;
let win;
let testDataActive = false;

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

  // One-time migration from v1.0.5: db was stored next to the exe
  if (!fs.existsSync(dbPath) && process.env.PORTABLE_EXECUTABLE_DIR) {
    const legacyPath = path.join(process.env.PORTABLE_EXECUTABLE_DIR, 'bathroom-tracker.db');
    if (fs.existsSync(legacyPath)) {
      fs.copyFileSync(legacyPath, dbPath);
      fs.unlinkSync(legacyPath);
    }
  }

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

  // Migration: add is_test column if not present
  const cols = queryAll(`PRAGMA table_info(passes)`).map(r => r.name);
  if (!cols.includes('is_test')) {
    db.run(`ALTER TABLE passes ADD COLUMN is_test INTEGER DEFAULT 0`);
  }

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
  win.webContents.on('did-finish-load', () => {
    win.setTitle(`Bathroom Tracker v${app.getVersion()}`);
  });
}

// ── Auto-update (portable only) ───────────────────────────────────────────────

async function checkForUpdates() {
  if (!process.env.PORTABLE_EXECUTABLE_FILE) return;

  function isNewer(latest, current) {
    const a = latest.replace(/^v/, '').split('.').map(Number);
    const b = current.split('.').map(Number);
    for (let i = 0; i < 3; i++) {
      if ((a[i] || 0) > (b[i] || 0)) return true;
      if ((a[i] || 0) < (b[i] || 0)) return false;
    }
    return false;
  }

  function httpsGet(url, redirectsLeft = 5) {
    return new Promise((resolve, reject) => {
      const req = https.get(url, {
        headers: { 'User-Agent': 'Bathroom-Tracker-Updater' },
      }, res => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirectsLeft > 0) {
          resolve(httpsGet(res.headers.location, redirectsLeft - 1));
          return;
        }
        let data = '';
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => resolve({ statusCode: res.statusCode, body: data }));
      });
      req.setTimeout(5000, () => req.destroy());
      req.on('error', reject);
    });
  }

  try {
    const { statusCode, body } = await httpsGet('https://api.github.com/repos/mikemcs121/Bathroom-Tracker/releases/latest');
    if (statusCode !== 200) return;

    const release = JSON.parse(body);
    const latestTag = release.tag_name || '';
    if (!isNewer(latestTag, app.getVersion())) return;

    const { response: updateResponse } = await dialog.showMessageBox(win, {
      type: 'info',
      title: 'Update Available',
      message: `A new version (${latestTag}) is available.\nYou are on v${app.getVersion()}.\n\nDownload now?`,
      buttons: ['Download', 'Skip'],
      defaultId: 0,
      cancelId: 1,
    });
    if (updateResponse !== 0) return;

    const { response: warnResponse } = await dialog.showMessageBox(win, {
      type: 'info',
      title: 'Before You Update',
      message: `The app will close after downloading ${latestTag}, the old version will be deleted, and the new version will launch automatically.\n\nYour data will not be affected.\n\nContinue?`,
      buttons: ['Continue', 'Cancel'],
      defaultId: 0,
      cancelId: 1,
    });
    if (warnResponse !== 0) return;

    const portableAsset = (release.assets || []).find(a =>
      /portable/i.test(a.name) && /\.exe$/i.test(a.name)
    );

    if (!portableAsset) {
      await dialog.showMessageBox(win, {
        type: 'info',
        title: 'Download Update',
        message: `No portable asset found in the release.\nVisit the GitHub releases page to download manually:\nhttps://github.com/mikemcs121/Bathroom-Tracker/releases`,
      });
      return;
    }

    const oldExePath = process.env.PORTABLE_EXECUTABLE_FILE;
    const currentDir = path.dirname(oldExePath);
    const suggestedName = `Bathroom Tracker ${latestTag}.exe`;

    const { canceled, filePath: savePath } = await dialog.showSaveDialog(win, {
      title: 'Save Update',
      defaultPath: path.join(currentDir, suggestedName),
      filters: [{ name: 'Executable', extensions: ['exe'] }],
    });
    if (canceled || !savePath) return;

    await new Promise((resolve, reject) => {
      const file = fs.createWriteStream(savePath);
      function download(url, redirectsLeft = 5) {
        https.get(url, { headers: { 'User-Agent': 'Bathroom-Tracker-Updater' } }, res => {
          if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirectsLeft > 0) {
            download(res.headers.location, redirectsLeft - 1);
            return;
          }
          res.pipe(file);
          file.on('finish', () => file.close(resolve));
        }).on('error', err => {
          fs.unlink(savePath, () => {});
          reject(err);
        });
      }
      download(portableAsset.browser_download_url);
    });

    await dialog.showMessageBox(win, {
      type: 'info',
      title: 'Download Complete',
      message: `Update downloaded.\n\nThe app will now close, the old version will be deleted, and the new version will launch automatically.`,
    });

    // Launch a detached batch script to delete the old exe and start the new one
    const batPath = path.join(app.getPath('temp'), 'bt-cleanup.bat');
    fs.writeFileSync(batPath, `@echo off\r\n:loop\r\ntimeout /t 1 /nobreak >nul\r\ndel /f /q "${oldExePath}" 2>nul\r\nif exist "${oldExePath}" goto loop\r\nstart "" "${savePath}"\r\ndel /f /q "%~f0"\r\n`);
    spawn('cmd.exe', ['/c', batPath], { detached: true, stdio: 'ignore' }).unref();

    app.quit();
  } catch (_) {
    // Network unavailable or any other error — silently ignore
  }
}

app.whenReady().then(async () => {
  await initDB();
  createWindow();
  checkForUpdates();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  if (testDataActive && db) {
    db.run('DELETE FROM passes WHERE is_test = 1');
    saveDB();
  }
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

  // Warn and clear test data before importing real data
  const testCount = queryGet('SELECT COUNT(*) AS cnt FROM passes WHERE is_test = 1');
  if (testCount.cnt > 0) {
    const { response } = await dialog.showMessageBox(win, {
      type: 'warning',
      title: 'Test Data Found',
      message: `There are ${testCount.cnt} test data records that will be deleted before importing.\n\nContinue?`,
      buttons: ['Continue', 'Cancel'],
      defaultId: 0,
      cancelId: 1,
    });
    if (response !== 0) return { success: false, message: 'Cancelled' };
    db.run('DELETE FROM passes WHERE is_test = 1');
    testDataActive = false;
  }

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
      if (r.teacher === '__none__') {
        return `(out_minutes >= :bs${i} AND out_minutes <= :be${i} AND (out_location IS NULL OR TRIM(out_location) = ''))`;
      }
      if (r.teacher) {
        params[`:bt${i}`] = r.teacher.toLowerCase().trim();
        return `(out_minutes >= :bs${i} AND out_minutes <= :be${i} AND LOWER(TRIM(out_location)) = :bt${i})`;
      }
      return `(out_minutes >= :bs${i} AND out_minutes <= :be${i})`;
    }).join(' OR ');
    whereClauses.push(`(${blockSQL})`);
  }

  whereClauses.push(`NOT (LOWER(TRIM(COALESCE(out_location2, ''))) LIKE '%request nurse%')`);

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
      if (r.teacher === '__none__') {
        return `(out_minutes >= :bs${i} AND out_minutes <= :be${i} AND (out_location IS NULL OR TRIM(out_location) = ''))`;
      }
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

ipcMain.handle('has-data', () => {
  const row = queryGet('SELECT COUNT(*) AS cnt FROM passes WHERE is_test = 0 OR is_test IS NULL');
  return row.cnt > 0;
});

ipcMain.handle('seed-test-data', () => {
  const cons = 'BCDFGHJKLMNPRSTVWXZ';
  const vow  = 'AEIOU';
  const randChar = s => s[rand(0, s.length - 1)];
  const fakeName = () => {
    const len = rand(3, 6);
    let n = randChar(cons);
    for (let i = 1; i < len; i++) n += randChar(i % 2 === 0 ? cons : vow).toLowerCase();
    return n;
  };

  const settingsRows = queryAll('SELECT key, value FROM settings');
  const s = Object.fromEntries(settingsRows.map(r => [r.key, r.value]));
  const count = Number(s.block_count) || 5;

  const toMins = hhmm => {
    if (!hhmm) return 0;
    const [h, m] = hhmm.split(':').map(Number);
    return (h || 0) * 60 + (m || 0);
  };

  const rand = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
  const pad  = n => String(n).padStart(2, '0');

  const blocks = [];
  for (let i = 1; i <= count; i++) {
    const configured = (s[`block${i}_teacher`] || '').trim();
    const startMins  = toMins(s[`block${i}_start`] || '');
    const endMins    = toMins(s[`block${i}_end`]   || '');
    if (endMins > startMins) {
      // Use configured teacher if set; All Teachers (empty) gets empty out_location
      const teacher = (configured && configured !== '__none__') ? configured : '';
      blocks.push({ teacher, startMins, endMins });
    }
  }

  if (!blocks.length) return { success: false, message: 'No blocks with a time range configured' };

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  db.run('BEGIN');
  try {
    for (let n = 0; n < 100; n++) {
      const d = new Date(today);
      d.setDate(d.getDate() - rand(0, 6));
      const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

      const block   = blocks[rand(0, blocks.length - 1)];
      const outMins = rand(block.startMins, block.endMins);
      const durMins = rand(2, 12);
      const inMins  = outMins + durMins;

      const outTime = `${pad(Math.floor(outMins / 60))}:${pad(outMins % 60)}`;
      const inTime  = `${pad(Math.floor(inMins  / 60))}:${pad(inMins  % 60)}`;
      const dur     = `0:${pad(durMins)}:00`;

      const fn = fakeName();
      const ln = fakeName();

      db.run(`
        INSERT OR IGNORE INTO passes (
          date, total_duration, total_seconds, first_name, last_name,
          out_location, out_time, out_minutes, in_time, is_test
        ) VALUES (?,?,?,?,?,?,?,?,?,1)
      `, [date, dur, durMins * 60, fn, ln, block.teacher, outTime, outMins, inTime]);
    }
    db.run('COMMIT');
  } catch (e) {
    db.run('ROLLBACK');
    return { success: false, message: e.message };
  }

  testDataActive = true;
  return { success: true };
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
