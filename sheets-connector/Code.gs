/**
 * Geneva Tennis: Google Sheets connector (Apps Script web app, V8 runtime).
 *
 * The coach pastes this file into a script once and deploys it as a web app (see README.md).
 * The Geneva Tennis app then POSTs JSON to the deployment URL:
 *
 *   { token, action: 'ping' }                                      -> { ok, owner, version }
 *   { token, action: 'createMatch', match: { id, title, date, names } }
 *                                                                  -> { ok, sheetId, url }
 *   { token, action: 'pushPoints', match: { id, title, sheetId }, header, rows, summary,
 *     removed? }                                                   -> { ok, written, sheetId, url }
 *
 * Every match gets its own spreadsheet in the coach's Drive. pushPoints is an UPSERT: a row is
 * matched by its point number in column A, so a corrected point replaces the old row and a
 * re-sent batch changes nothing. Several phones can push at once (script lock).
 *
 * The protocol is described in docs/MATCH-DATA.md. This file is also stored inside the app
 * (src/tennis/connectorSource.js, built by scripts/build-connector.mjs) so the coach can copy it.
 */

// ---- Settings -------------------------------------------------------------------------

/** Pick any secret and paste the same one into the app. Anyone with the URL AND this token can write. */
const TOKEN = 'CHANGE-ME';

/** Bump when this file changes; ping reports it so the app can tell the coach to update. */
const VERSION = 1;

/** Must equal the header of pointLogRows() in src/tennis/sheets.js. */
const POINT_HEADER = ['#', 'Set', 'Game', 'Score', 'Server', 'Side', '1st In', 'Serve #', 'Serve mph', 'Placement', 'Rally', 'Outcome', 'Won by', 'Ended by', 'Wing', 'Final shot', 'Pressure', 'Break pt', 'Net', 'Secs', 'Source', 'Note'];

/** Column widths in pixels, same order as POINT_HEADER. */
const POINT_WIDTHS = [45, 40, 50, 70, 120, 60, 55, 65, 80, 80, 55, 120, 120, 120, 80, 100, 70, 70, 110, 55, 80, 260];

/** Columns that hold numbers. Every other column is written as plain text. */
const NUMBER_COLUMNS = ['#', 'Set', 'Game', 'Serve #', 'Serve mph', 'Rally', 'Secs'];

const COLORS = { head: '#5E4A1F', headText: '#FFFFFF', band: '#F7F1E3', section: '#F3E8CC', good: '#DDF5E3', bad: '#FBE0E0' };

// ---- Web app entry points -------------------------------------------------------------

/** Opening the URL in a browser: a status check, nothing private. */
function doGet() {
  return reply_({ ok: true, app: 'Geneva Tennis connector', version: VERSION, note: 'POST JSON to this URL; see README.md.' });
}

function doPost(e) {
  let req;
  try {
    req = JSON.parse((e && e.postData && e.postData.contents) || '{}');
  } catch (err) {
    return reply_({ ok: false, error: 'bad json' });
  }
  if (!req || req.token !== TOKEN) return reply_({ ok: false, error: 'bad token' });
  if (TOKEN === 'CHANGE-ME') return reply_({ ok: false, error: 'Edit TOKEN in Code.gs, save, then deploy a new version' });
  try {
    switch (req.action) {
      case 'ping':
        return reply_({ ok: true, owner: Session.getEffectiveUser().getEmail(), version: VERSION });
      case 'createMatch':
        return reply_(createMatch_(req.match || {}));
      case 'pushPoints':
        return reply_(pushPoints_(req));
      default:
        return reply_({ ok: false, error: 'unknown action' });
    }
  } catch (err) {
    return reply_({ ok: false, error: String((err && err.message) || err) });
  }
}

function reply_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

// ---- createMatch ----------------------------------------------------------------------

/**
 * A new, formatted spreadsheet for one match; remembers matchId -> sheetId. Asking again for a
 * match that already has a sheet returns that sheet, so a retry never makes a duplicate.
 */
function createMatch_(m) {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const ss = findMatchSheet_(m) || newMatchSheet_(m);
    return { ok: true, sheetId: ss.getId(), url: ss.getUrl() };
  } finally {
    lock.releaseLock();
  }
}

function newMatchSheet_(m) {
  const title = String(m.title || 'Match');
  const date = String(m.date || '');
  const ss = SpreadsheetApp.create('Geneva Tennis — ' + title + (date ? ' (' + date + ')' : ''));
  const points = ss.getSheets()[0];
  points.setName('Points');
  formatPoints_(points, POINT_HEADER);
  const summary = ss.insertSheet('Summary');
  summary.getRange(1, 1).setValue('Waiting for the first points.');
  writeAbout_(ss.insertSheet('About'), m, title, date);
  ss.setActiveSheet(points);
  remember_(m.id, ss.getId());
  return ss;
}

function writeAbout_(sheet, m, title, date) {
  const lines = [
    'Geneva Tennis match sheet',
    title + (date ? ' (' + date + ')' : ''),
    '',
    'Points: one row per point, added as the match is charted. A row is matched by its point number in column A, so a corrected point replaces its old row.',
    'Summary: the side-by-side match stats, rewritten on every update.',
    'Do not type in these tabs: the next update overwrites them. Copy the sheet first if you want to add your own notes.',
    '',
    'Written by the Geneva Tennis app through your Apps Script connector (version ' + VERSION + ').',
    m.id ? 'Match id: ' + m.id : '',
  ];
  sheet.getRange(1, 1, lines.length, 1).setValues(lines.map((s) => [text_(s)]));
  sheet.getRange(1, 1).setFontWeight('bold').setFontSize(14);
  sheet.setColumnWidth(1, 760);
  sheet.getRange(1, 1, lines.length, 1).setWrap(true);
}

// ---- pushPoints -----------------------------------------------------------------------

function pushPoints_(req) {
  const m = req.match || {};
  const header = Array.isArray(req.header) && req.header.length ? req.header.map(text_) : POINT_HEADER;
  const rows = (Array.isArray(req.rows) ? req.rows : []).filter(Array.isArray);
  const removed = Array.isArray(req.removed) ? req.removed.map(String) : [];
  const summary = (Array.isArray(req.summary) ? req.summary : []).filter(Array.isArray);

  // one writer at a time: two phones pushing together must not overwrite each other
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const ss = openMatchSheet_(m);
    upsertPoints_(ss, header, rows, removed);
    if (summary.length) writeSummary_(ss, summary);
    return { ok: true, written: rows.length, sheetId: ss.getId(), url: ss.getUrl() };
  } finally {
    lock.releaseLock();
  }
}

/** The match's spreadsheet if there is one we can still open: by sheetId, else the remembered one. */
function findMatchSheet_(m) {
  const key = m.id ? 'match:' + m.id : '';
  const id = m.sheetId || (key && PropertiesService.getScriptProperties().getProperty(key));
  if (!id) return null;
  try {
    const ss = SpreadsheetApp.openById(String(id));
    remember_(m.id, ss.getId());
    return ss;
  } catch (err) {
    return null; // deleted, or not ours any more
  }
}

/** The match's spreadsheet, or a new one when it is missing. */
function openMatchSheet_(m) {
  return findMatchSheet_(m) || newMatchSheet_(m);
}

function remember_(matchId, sheetId) {
  if (matchId) PropertiesService.getScriptProperties().setProperty('match:' + matchId, sheetId);
}

/** Merge the incoming rows into the Points tab by point number (column A), then write it back. */
function upsertPoints_(ss, header, rows, removed) {
  const n = header.length;
  const sheet = ss.getSheetByName('Points') || ss.insertSheet('Points', 0);
  ensureSize_(sheet, 2, n);
  const sameHeader = sheet.getLastRow() >= 1 && sheet.getRange(1, 1, 1, n).getValues()[0].join('\u0001') === header.join('\u0001');
  if (!sameHeader) formatPoints_(sheet, header);

  const last = sheet.getLastRow();
  const data = [];
  const at = Object.create(null); // point number -> index in data
  const have = last > 1 ? sheet.getRange(2, 1, last - 1, n).getValues() : [];
  have.forEach(function (r) {
    if (r[0] === '') return;
    at[String(r[0])] = data.length;
    data.push(r);
  });
  rows.forEach(function (r) {
    const row = fitRow_(r, header);
    const key = String(row[0]);
    if (key === '') return;
    if (key in at) {
      data[at[key]] = row;
    } else {
      at[key] = data.length;
      data.push(row);
    }
  });
  const gone = Object.create(null);
  removed.forEach(function (k) {
    gone[k] = true;
  });
  const keep = data.filter(function (r) {
    return !gone[String(r[0])];
  });
  keep.sort(function (a, b) {
    return Number(a[0]) - Number(b[0]);
  });

  ensureSize_(sheet, keep.length + 1, n);
  if (keep.length) sheet.getRange(2, 1, keep.length, n).setValues(keep);
  if (last - 1 > keep.length) sheet.getRange(2 + keep.length, 1, last - 1 - keep.length, n).clearContent();
}

/** One incoming row as exactly one cell per header column; numbers stay numbers, the rest is plain text. */
function fitRow_(r, header) {
  return header.map(function (name, c) {
    const v = r[c];
    if (NUMBER_COLUMNS.indexOf(name) >= 0) return typeof v === 'number' && isFinite(v) ? v : '';
    if (typeof v === 'number') return isFinite(v) ? String(v) : '';
    return text_(v);
  });
}

/** Text that cannot run as a formula: a leading = + @ (or - and more) gets a space in front. */
function text_(v) {
  const s = v === null || v === undefined ? '' : String(v).slice(0, 5000);
  return /^[=+@]|^-./.test(s) ? ' ' + s : s;
}

function ensureSize_(sheet, rows, cols) {
  if (sheet.getMaxRows() < rows) sheet.insertRowsAfter(sheet.getMaxRows(), rows - sheet.getMaxRows());
  if (sheet.getMaxColumns() < cols) sheet.insertColumnsAfter(sheet.getMaxColumns(), cols - sheet.getMaxColumns());
}

// ---- formatting -----------------------------------------------------------------------

/** Header, frozen row and column, widths, text columns, banding and outcome colours for the Points tab. */
function formatPoints_(sheet, header) {
  const n = header.length;
  ensureSize_(sheet, 200, n);
  const rowsMax = sheet.getMaxRows();

  // plain-text columns first (one call per run of them), so a score like "3-2" is never turned into a date
  for (let c = 0; c < n; ) {
    if (NUMBER_COLUMNS.indexOf(header[c]) >= 0) {
      c++;
      continue;
    }
    let end = c;
    while (end + 1 < n && NUMBER_COLUMNS.indexOf(header[end + 1]) < 0) end++;
    sheet.getRange(2, c + 1, rowsMax - 1, end - c + 1).setNumberFormat('@');
    c = end + 1;
  }

  sheet
    .getRange(1, 1, 1, n)
    .setValues([header])
    .setFontWeight('bold')
    .setFontColor(COLORS.headText)
    .setBackground(COLORS.head)
    .setHorizontalAlignment('center')
    .setVerticalAlignment('middle')
    .setWrap(true);
  sheet.setFrozenRows(1);
  sheet.setFrozenColumns(1);
  header.forEach(function (name, c) {
    sheet.setColumnWidth(c + 1, POINT_WIDTHS[c] || 90);
  });

  if (!sheet.getBandings().length) {
    sheet
      .getRange(1, 1, rowsMax, n)
      .applyRowBanding(SpreadsheetApp.BandingTheme.LIGHT_GREY, true, false)
      .setHeaderRowColor(COLORS.head)
      .setFirstRowColor('#FFFFFF')
      .setSecondRowColor(COLORS.band);
  }

  const col = header.indexOf('Outcome') + 1;
  if (col > 0) {
    const range = sheet.getRange(2, col, rowsMax - 1, 1);
    const rule = function (text, color) {
      return SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo(text).setBackground(color).setRanges([range]).build();
    };
    sheet.setConditionalFormatRules([
      rule('Ace', COLORS.good),
      rule('Winner', COLORS.good),
      rule('Service winner', COLORS.good),
      rule('Double fault', COLORS.bad),
      rule('Unforced error', COLORS.bad),
    ]);
  }
}

/** The Summary tab is cleared and rewritten: header row first, then sections and [label, ours, theirs] rows. */
function writeSummary_(ss, table) {
  const sheet = ss.getSheetByName('Summary') || ss.insertSheet('Summary');
  const w = table.reduce(function (m, r) {
    return Math.max(m, r.length);
  }, 3);
  const grid = table.map(function (r) {
    const row = [];
    for (let c = 0; c < w; c++) {
      const v = r[c];
      row.push(typeof v === 'number' && isFinite(v) ? v : text_(v));
    }
    return row;
  });
  sheet.clear();
  ensureSize_(sheet, grid.length + 1, w);
  sheet.getRange(1, 1, grid.length, 1).setNumberFormat('@');
  sheet.getRange(1, 1, grid.length, w).setValues(grid);
  sheet.getRange(1, 1, 1, w).setFontWeight('bold').setFontColor(COLORS.headText).setBackground(COLORS.head).setHorizontalAlignment('center');
  if (grid.length > 1) sheet.getRange(2, 2, grid.length - 1, w - 1).setHorizontalAlignment('right');

  // a section row is a label with nothing next to it
  const sections = [];
  grid.forEach(function (r, i) {
    if (i > 0 && r[0] !== '' && r.slice(1).every(function (v) { return v === ''; })) sections.push('A' + (i + 1) + ':' + columnLetter_(w) + (i + 1));
  });
  if (sections.length) sheet.getRangeList(sections).setFontWeight('bold').setBackground(COLORS.section);

  sheet.setFrozenRows(1);
  sheet.setColumnWidth(1, 260);
  for (let c = 2; c <= w; c++) sheet.setColumnWidth(c, 150);
}

/** 1 -> A, 26 -> Z, 27 -> AA */
function columnLetter_(n) {
  let s = '';
  for (; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}
