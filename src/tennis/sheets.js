/**
 * Geneva Tennis: how a match lays out in a spreadsheet. Contract: src/tennis/index.d.ts.
 * Rows are built here once; buildXlsx (xlsx.js) turns them into a file, toCSV/toTSV into
 * text, and the Google Sheets connector gets them through plainRows. The Points header must
 * stay equal to POINT_HEADER in sheets-connector/Code.gs (a test checks it).
 * Private helpers are prefixed `_sh_` (the tracker build concatenates all src/tennis/*.js).
 */
import { computeStats, fmtRatio, gameGroups } from './stats.js';

const _sh_POINT_HEADER = ['#', 'Set', 'Game', 'Score', 'Server', 'Side', '1st In', 'Serve #', 'Serve mph', 'Placement', 'Rally', 'Outcome', 'Won by', 'Ended by', 'Wing', 'Final shot', 'Pressure', 'Break pt', 'Net', 'Secs', 'Source', 'Note'];
const _sh_SHOT_HEADER = ['Point', 'Shot', 'Player', 'Type', 'Wing', 'Speed mph', 'Spin rpm', 'Swing mph', 'Depth', 'Direction', 'Bounce x m', 'Bounce y m', 'Net clear m', 'Knee min\u00b0', 'Stance', 'Hip-shoulder\u00b0', 'Split step'];

const _sh_OUTCOME = { ace: 'Ace', df: 'Double fault', serviceWinner: 'Service winner', winner: 'Winner', ue: 'Unforced error', fe: 'Forced error' };
const _sh_KIND = { serve: 'Serve', return: 'Return', ground: 'Groundstroke', volley: 'Volley', overhead: 'Overhead', drop: 'Drop shot', lob: 'Lob' };
const _sh_WING = { FH: 'Forehand', BH: 'Backhand' };
const _sh_DEPTH = { deep: 'Deep', mid: 'Mid', short: 'Short', out: 'Out', net: 'Net' };
const _sh_DIR = { CC: 'Crosscourt', MID: 'Middle', DTL: 'Down the line' };
const _sh_SRC = { auto: 'Auto', manual: 'Manual', confirmed: 'Confirmed' };

const _sh_name = (names, i) => String((names && names[i]) || '').trim() || (i === 0 ? 'Us' : 'Them');

/** A number rounded to `d` decimals, or '' when there is none. */
function _sh_num(v, d) {
  if (v === null || v === undefined || typeof v !== 'number' || !Number.isFinite(v)) return '';
  const k = Math.pow(10, d);
  return Math.round(v * k) / k;
}

// ---- Points ---------------------------------------------------------------------------

/** Header + one row per point, ordered for a coach to read left to right. */
export function pointLogRows(points, names) {
  const rows = [_sh_POINT_HEADER.slice()];
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    const outcome = { v: _sh_OUTCOME[p.outcome] || p.outcome || '' };
    if (p.outcome === 'ace' || p.outcome === 'winner' || p.outcome === 'serviceWinner') outcome.s = 'good';
    else if (p.outcome === 'df' || p.outcome === 'ue') outcome.s = 'bad';
    rows.push([
      p.n,
      p.set,
      p.game,
      p.tb ? 'TB ' + p.scoreBefore : p.scoreBefore, // "TB 5-4": a bare 5-4 would turn into a date when pasted into a sheet
      _sh_name(names, p.server),
      p.side === 'ad' ? 'Ad' : 'Deuce',
      p.serve1In ? 'Yes' : '',
      p.serveNo,
      _sh_num(p.serveNo === 2 ? p.serve2Speed : p.serve1Speed, 1),
      p.placement || '',
      p.rally,
      outcome,
      _sh_name(names, p.winner),
      _sh_name(names, p.endedBy),
      _sh_WING[p.wing] || '',
      _sh_KIND[p.finalKind] || '',
      p.pressure ? 'Yes' : '',
      p.breakPoint ? 'Yes' : '',
      p.netApproach === 0 || p.netApproach === 1 ? _sh_name(names, p.netApproach) : '',
      _sh_num(p.durSec, 1),
      _sh_SRC[p.src] || p.src || '',
      p.note || '',
    ]);
  }
  return rows;
}

// ---- Shots ----------------------------------------------------------------------------

/** Header + one row per tracked shot. */
export function shotRows(points, names) {
  const rows = [_sh_SHOT_HEADER.slice()];
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    const shots = p.shots || [];
    for (let k = 0; k < shots.length; k++) {
      const s = shots[k];
      const f = s.form || {};
      rows.push([
        p.n,
        s.i + 1,
        _sh_name(names, s.who),
        _sh_KIND[s.kind] || s.kind || '',
        _sh_WING[s.wing] || '',
        _sh_num(s.speed, 1),
        _sh_num(s.spin, 0),
        _sh_num(s.swing, 1),
        _sh_DEPTH[s.depth] || '',
        _sh_DIR[s.dir] || '',
        s.bounce ? _sh_num(s.bounce.x, 2) : '',
        s.bounce ? _sh_num(s.bounce.y, 2) : '',
        _sh_num(s.netClear, 2),
        _sh_num(f.kneeMin, 0),
        _sh_num(f.stance, 2),
        _sh_num(f.sep, 0),
        f.splitStep === true ? 'Yes' : f.splitStep === false ? 'No' : '',
      ]);
    }
  }
  return rows;
}

// ---- Summary --------------------------------------------------------------------------

/** Side-by-side summary table: a header row, then sections of [label, player 0, player 1]. */
export function summaryRows(stats, names) {
  const P = stats.players;
  const rows = [[{ v: 'Stat', s: 'h' }, { v: _sh_name(names, 0), s: 'h' }, { v: _sh_name(names, 1), s: 'h' }]];
  const section = (title) => rows.push([{ v: title, s: 'hl' }, { v: '', s: 'hl' }, { v: '', s: 'hl' }]);
  // fn(player stats) is a Ratio (shown '7/12 (58%)') or a number (shown as is, '' when null)
  const line = (label, fn, style) => {
    const cell = (q) => {
      const x = fn(P[q], q);
      if (x !== null && typeof x === 'object') return fmtRatio(x);
      return x === null || x === undefined ? '' : style ? { v: x, s: style } : x;
    };
    rows.push([label, cell(0), cell(1)]);
  };
  const tracked = (q) => q.depth.deep + q.depth.mid + q.depth.short + q.depth.out + q.depth.net;
  const depth = (k) => (q) => ({ won: q.depth[k], of: tracked(q) });

  section('Serve');
  line('Aces', (q) => q.aces, 'int');
  line('Double faults', (q) => q.dfs, 'int');
  line('1st serve in', (q) => q.firstServeIn);
  line('1st serve points won', (q) => q.firstServeWon);
  line('2nd serve points won', (q) => q.secondServeWon);
  line('Service points won', (q) => q.servicePoints);
  line('Service games held', (q) => q.serviceGames);
  line('Break points saved', (q) => q.breakPointsSaved);
  line('1st serve speed, avg mph', (q) => q.serve1Speed.avg, 'num1');
  line('1st serve speed, max mph', (q) => q.serve1Speed.max, 'num1');
  line('2nd serve speed, avg mph', (q) => q.serve2Speed.avg, 'num1');

  section('Return');
  line('Return points won', (q) => q.returnPoints);
  line('Break points won', (q) => q.breakPointsWon);

  section('Rally');
  line('Points won', (q) => q.pointsWon, 'int');
  line('Won, rallies of 0-4 shots', (q) => q.rallyShort);
  line('Won, rallies of 5-8 shots', (q) => q.rallyMid);
  line('Won, rallies of 9+ shots', (q) => q.rallyLong);
  line('Net points won', (q) => q.netPoints);
  line('Longest run of points', (q) => q.longestRun, 'int');
  line('Average rally, shots', () => stats.avgRally, 'num1');

  section('Winners & errors');
  line('Winners', (q) => q.winners, 'int');
  line('Forehand winners', (q) => q.winnersFH, 'int');
  line('Backhand winners', (q) => q.winnersBH, 'int');
  line('Unforced errors', (q) => q.ue, 'int');
  line('Forehand unforced errors', (q) => q.ueFH, 'int');
  line('Backhand unforced errors', (q) => q.ueBH, 'int');
  line('Forced errors', (q) => q.fe, 'int');

  section('Pressure & mindset');
  line('Pressure points won', (q) => q.pressurePoints);
  line('Won the point after an own error', (q) => q.afterOwnError);
  line('Won the first point of a game', (q) => q.firstPointOfGame);

  section('Ball & swing (estimated)');
  line('Ball speed, avg mph', (q) => q.shotSpeed.avg, 'num1');
  line('Ball speed, max mph', (q) => q.shotSpeed.max, 'num1');
  line('Spin, avg rpm', (q) => q.spin.avg, 'int');
  line('Spin, max rpm', (q) => q.spin.max, 'int');
  line('Swing speed, avg mph', (q) => q.swing.avg, 'num1');
  line('Swing speed, max mph', (q) => q.swing.max, 'num1');
  line('Deep balls', depth('deep'));
  line('Mid-court balls', depth('mid'));
  line('Short balls', depth('short'));
  line('Out', depth('out'));
  line('Into the net', depth('net'));

  section('Form (estimated)');
  line('Knee bend at the load, avg degrees', (q) => q.kneeMin.avg, 'num1');
  line('Split step seen', (q) => q.splitStepRate);
  return rows;
}

/**
 * The score from the points alone, player 0 first: '6-4 4-6 [10-8]'. A game counts once it is
 * finished (a match tiebreak counts its points, in brackets).
 */
function _sh_scoreLine(points) {
  const sets = [];
  gameGroups(points).forEach((g) => {
    let s = sets[sets.length - 1];
    if (!s || s.set !== g.set) {
      const gb = g.pts[0].gamesBefore || [0, 0];
      s = { set: g.set, g: [0, 0], mtb: !!g.tb && gb[0] + gb[1] === 0 };
      sets.push(s);
    }
    if (s.mtb) g.pts.forEach((p) => (s.g[p.winner] += 1));
    else if (g.complete) s.g[g.winner] += 1;
  });
  return sets.map((s) => (s.mtb ? '[' + s.g[0] + '-' + s.g[1] + ']' : s.g[0] + '-' + s.g[1])).join(' ');
}

// ---- Serve Map and Trends -------------------------------------------------------------

function _sh_serveMapSheet(stats, names) {
  const rows = [
    [{ v: 'Serve map', s: 'title' }],
    [{ v: 'Where each player served, by court side. The serve that went in (a double fault: the second serve).', s: 'sub' }],
    [],
    ['Player', 'Side', 'Wide', 'Body', 'T', 'Total', 'Wide %', 'Body %', 'T %'].map((v) => ({ v, s: 'h' })),
  ];
  for (let q = 0; q < 2; q++) {
    const pl = stats.players[q].placement;
    [['Deuce', pl.deuce], ['Ad', pl.ad], ['Both', { Wide: pl.deuce.Wide + pl.ad.Wide, Body: pl.deuce.Body + pl.ad.Body, T: pl.deuce.T + pl.ad.T }]].forEach((e) => {
      const r = e[1];
      const total = r.Wide + r.Body + r.T;
      const share = (n) => (total ? { v: n / total, s: 'pct' } : '');
      const cell = (v) => (e[0] === 'Both' ? { v, s: 'bold' } : v);
      rows.push([cell(_sh_name(names, q)), cell(e[0]), cell(r.Wide), cell(r.Body), cell(r.T), cell(total), share(r.Wide), share(r.Body), share(r.T)]);
    });
  }
  return { name: 'Serve Map', cols: [22, 8, 8, 8, 8, 8, 9, 9, 9], rows, merges: ['A1:I1', 'A2:I2'], freeze: { rows: 4 } };
}

function _sh_trendsSheet(alerts, names) {
  const rows = [['Point #', 'Player', 'Kind', 'Severity', 'Title', 'Detail', 'Cue'].map((v) => ({ v, s: 'h' }))];
  const list = (alerts || []).slice().sort((a, b) => a.at - b.at);
  list.forEach((a) => {
    const sev = a.severity === 'fix' ? 'bad' : a.severity === 'watch' ? 'gold' : undefined;
    rows.push([
      a.at,
      _sh_name(names, a.who),
      a.kind,
      sev ? { v: a.severity, s: sev } : a.severity,
      { v: a.title, s: 'wrap' },
      { v: a.detail, s: 'wrap' },
      { v: a.cue, s: 'wrap' },
    ]);
  });
  if (!list.length) rows.push([{ v: 'No trends were flagged in this match.', s: 'muted' }]);
  return { name: 'Trends', cols: [9, 18, 11, 10, 38, 60, 60], rows, freeze: { rows: 1 }, autoFilter: 'A1:G1' };
}

// ---- Workbook -------------------------------------------------------------------------

/** The same rows with the first one styled as a table header. */
const _sh_headed = (rows) => [rows[0].map((v) => ({ v, s: 'h' }))].concat(rows.slice(1));

/** The full workbook: Summary, Points, Shots, Serve Map, Trends. */
export function matchWorkbook(meta, points, alerts) {
  const names = meta.names;
  const stats = computeStats(points);
  const top = [
    [{ v: meta.title || 'Match', s: 'title' }],
    [{ v: _sh_name(names, 0) + ' vs ' + _sh_name(names, 1), s: 'sub' }],
    [{ v: 'Date', s: 'bold' }, meta.date || ''],
  ];
  if (meta.location) top.push([{ v: 'Location', s: 'bold' }, meta.location]);
  top.push([{ v: 'Format', s: 'bold' }, meta.formatLabel || '']);
  top.push([{ v: 'Charted by', s: 'bold' }, meta.chartedBy || '']);
  top.push([{ v: 'Final score (' + _sh_name(names, 0) + ' first)', s: 'bold' }, _sh_scoreLine(points) || '-']);
  top.push([]);
  const table = summaryRows(stats, names);
  return [
    { name: 'Summary', cols: [38, 24, 24], rows: top.concat(table), merges: ['A1:C1', 'A2:C2'], freeze: { rows: top.length + 1 } },
    {
      name: 'Points',
      cols: [6, 5, 6, 9, 16, 8, 7, 8, 10, 10, 7, 16, 16, 16, 10, 13, 9, 9, 14, 7, 10, 34],
      rows: _sh_headed(pointLogRows(points, names)),
      freeze: { rows: 1, cols: 1 },
      autoFilter: 'A1:V1',
    },
    {
      name: 'Shots',
      cols: [7, 6, 16, 13, 10, 10, 10, 10, 8, 14, 11, 11, 12, 10, 8, 13, 10],
      rows: _sh_headed(shotRows(points, names)),
      freeze: { rows: 1, cols: 1 },
      autoFilter: 'A1:Q1',
    },
    _sh_serveMapSheet(stats, names),
    _sh_trendsSheet(alerts, names),
  ];
}

/** 'GenevaTennis_2026-10-02_Ours-vs-Theirs.xlsx', with anything unsafe in a file name stripped. */
export function matchFileName(meta, ext) {
  const clean = (s, fallback) =>
    String(s || '')
      .replace(/\s+/g, '-')
      .replace(/[^A-Za-z0-9_\-\u00c0-\uffff]/g, '')
      .replace(/-{2,}/g, '-')
      .replace(/^[-_]+|[-_]+$/g, '') || fallback;
  const names = meta.names || [];
  const date = clean(meta.date, new Date().toISOString().slice(0, 10));
  return 'GenevaTennis_' + date + '_' + clean(names[0], 'Ours') + '-vs-' + clean(names[1], 'Theirs') + '.' + ext;
}
