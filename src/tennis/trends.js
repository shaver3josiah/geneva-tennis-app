/**
 * Geneva Tennis: live trend detectors. Contract: src/tennis/index.d.ts.
 *
 * detectTrends(points, names, already) looks at the state of the match NOW (windows end at
 * the last point) and returns the alerts that hold and are not already in `already`. Every
 * id is anchored to something that stays put while the pattern persists (a set, a 10-point
 * bucket, the point that completed the pattern), so calling it after every point raises each
 * alert once. Detectors run for both players: filter on `alert.who` to show one side.
 * Private helpers are prefixed `_tr_` (the tracker build concatenates all src/tennis/*.js).
 */
import { computeStats, gameGroups } from './stats.js';

const _tr_EPS = 1e-9;

function _tr_clip(s) {
  return s.length > 48 ? s.slice(0, 47) + '\u2026' : s;
}

/** The player's name for a title: short enough that every title fits in 48 characters. */
function _tr_nm(c, p) {
  const n = String((c.names && c.names[p]) || '').trim() || (p === 0 ? 'Us' : 'Them');
  return n.length > 16 ? n.slice(0, 15) + '\u2026' : n;
}

function _tr_full(c, p) {
  return String((c.names && c.names[p]) || '').trim() || (p === 0 ? 'Us' : 'Them');
}

function _tr_mk(c, id, who, kind, severity, title, detail, cue, refs) {
  const a = { id, at: c.lastN, who, kind, severity, title: _tr_clip(title), detail, cue };
  if (refs && refs.length) a.shotRefs = refs;
  return a;
}

const _tr_avg = (a) => a.reduce((s, x) => s + x, 0) / a.length;
const _tr_r1 = (x) => Math.round(x * 10) / 10;

/** Every tracked shot by player p, oldest first: { n, sh } (n = the point number). */
function _tr_shots(c, p, keep) {
  const out = [];
  for (let i = 0; i < c.pts.length; i++) {
    const pt = c.pts[i];
    const shots = pt.shots || [];
    for (let k = 0; k < shots.length; k++) {
      if (shots[k].who === p && keep(shots[k])) out.push({ n: pt.n, sh: shots[k] });
    }
  }
  return out;
}

// ---- serve ----------------------------------------------------------------------------

/** First-serve % over the last 3 completed service games is under 50% and 10+ points below the match average. */
function _tr_fsLow(c, p) {
  const win = c.games.filter((g) => !g.tb && g.complete && g.server === p).slice(-3);
  const pts = [];
  win.forEach((g) => g.pts.forEach((x) => pts.push(x)));
  if (pts.length < 12) return null;
  const inN = pts.filter((x) => x.serve1In).length;
  const all = c.pts.filter((x) => x.server === p);
  const allIn = all.filter((x) => x.serve1In).length;
  const w = inN / pts.length;
  const avg = allIn / all.length;
  if (!(w < 0.5 && avg - w >= 0.1 - _tr_EPS)) return null;
  const set = win[win.length - 1].set;
  return _tr_mk(
    c,
    'fs-low:' + p + ':' + set,
    p,
    'serve',
    'watch',
    _tr_nm(c, p) + ': first serve is slipping',
    _tr_full(c, p) + ' has the first serve in on ' + inN + ' of ' + pts.length + ' (' + Math.round(w * 100) + '%) over the last ' + win.length + ' service games, against ' + Math.round(avg * 100) + '% for the match.',
    'Take 10% off the first serve and hit big targets. First ball in.'
  );
}

/** 2+ double faults in the last 2 service games (the one in progress counts). */
function _tr_dfCluster(c, p) {
  const win = c.games.filter((g) => !g.tb && g.server === p).slice(-2);
  const dfs = [];
  win.forEach((g) => g.pts.forEach((x) => x.outcome === 'df' && x.server === p && dfs.push(x)));
  if (dfs.length < 2) return null;
  return _tr_mk(
    c,
    'df-cluster:' + p + ':' + dfs[dfs.length - 1].n,
    p,
    'serve',
    'fix',
    _tr_nm(c, p) + ': double faults piling up',
    _tr_full(c, p) + ' has ' + dfs.length + ' double faults in the last ' + win.length + ' service games.',
    'Settle the toss: same spot, same height. Bounce, breathe, keep the rhythm, and put the second serve in with spin.'
  );
}

/** Average first-serve speed over the last 8 serves is 8%+ below the first 8. */
function _tr_pace(c, p) {
  const v = c.pts.filter((x) => x.server === p && x.serve1Speed != null).map((x) => x.serve1Speed);
  if (v.length < 16) return null;
  const a = _tr_avg(v.slice(0, 8));
  const b = _tr_avg(v.slice(-8));
  if (!(a > 0 && (a - b) / a >= 0.08 - _tr_EPS)) return null;
  return _tr_mk(
    c,
    'pace:' + p + ':' + c.last.set,
    p,
    'fitness',
    'watch',
    _tr_nm(c, p) + ': serve speed is dropping',
    'First serves average ' + _tr_r1(b) + ' mph over the last 8, against ' + _tr_r1(a) + ' mph over the first 8 (down ' + Math.round(((a - b) / a) * 100) + '%).',
    'Serve speed is dropping: legs and hydration at the changeover.'
  );
}

// ---- errors ---------------------------------------------------------------------------

/** 3+ unforced errors on one wing within the last 10 points. */
function _tr_ueWing(c, p, wing) {
  const hits = c.pts.slice(-10).filter((x) => x.outcome === 'ue' && x.endedBy === p && x.wing === wing);
  if (hits.length < 3) return null;
  const word = wing === 'FH' ? 'forehand' : 'backhand';
  const refs = hits.map((x) => ({ n: x.n, i: Math.max(0, (x.shots ? x.shots.length : x.rally) - 1) }));
  return _tr_mk(
    c,
    'ue-wing:' + p + ':' + wing + ':' + Math.floor(c.lastN / 10),
    p,
    'errors',
    'fix',
    _tr_nm(c, p) + ': ' + word + ' errors adding up',
    _tr_full(c, p) + ' has ' + hits.length + ' unforced errors on the ' + word + ' in the last 10 points.',
    'More margin on the ' + word + ': clear the net by a metre, aim a metre inside the lines.',
    refs
  );
}

/** Lost 3 of the last 4 points that followed the player's own unforced error. */
function _tr_reset(c, p) {
  const after = [];
  for (let i = 1; i < c.pts.length; i++) {
    const q = c.pts[i - 1];
    if (q.outcome === 'ue' && q.endedBy === p) after.push(c.pts[i]);
  }
  const win = after.slice(-4);
  if (win.length < 4) return null;
  const lost = win.filter((x) => x.winner !== p).length;
  if (lost < 3) return null;
  return _tr_mk(
    c,
    'reset:' + p + ':' + win[3].n,
    p,
    'mindset',
    'watch',
    _tr_nm(c, p) + ': losing the point after a miss',
    _tr_full(c, p) + ' lost ' + lost + ' of the last 4 points that followed an unforced error.',
    'Use the between-point reset: turn away, breathe, pick a target for the next ball.'
  );
}

// ---- mindset --------------------------------------------------------------------------

/** Under 35% of the pressure points won, with at least 6 played. */
function _tr_pressure(c, p) {
  const r = c.st.players[p].pressurePoints;
  if (r.of < 6 || r.won * 100 >= 35 * r.of) return null;
  return _tr_mk(
    c,
    'pressure:' + p + ':' + c.last.set,
    p,
    'mindset',
    'watch',
    _tr_nm(c, p) + ': struggling on pressure points',
    _tr_full(c, p) + ' has won ' + r.won + ' of ' + r.of + ' pressure points (' + Math.round((100 * r.won) / r.of) + '%).',
    'Play the point, not the score: breathe, slow down, and commit to your best pattern.'
  );
}

/** The opponent of p has won the last 5+ points in a row. */
function _tr_run(c, p) {
  let n = 0;
  const q = c.last.winner;
  while (n < c.pts.length && c.pts[c.pts.length - 1 - n].winner === q) n++;
  if (n < 5 || q !== 1 - p) return null;
  return _tr_mk(
    c,
    'run:' + p + ':' + c.pts[c.pts.length - n].n,
    p,
    'mindset',
    'watch',
    _tr_nm(c, p) + ': opponent on a ' + n + '-point run',
    _tr_full(c, 1 - p) + ' has won ' + n + ' points in a row.',
    'Slow down, take the full 25 seconds, play high-percentage targets.'
  );
}

// ---- patterns -------------------------------------------------------------------------

/** The opponent of p wins 70%+ of the rallies of 9+ shots (at least 5 played). */
function _tr_longRally(c, p) {
  const r = c.st.players[1 - p].rallyLong;
  if (r.of < 5 || r.won * 10 < 7 * r.of) return null;
  return _tr_mk(
    c,
    'long-rally:' + p,
    p,
    'pattern',
    'watch',
    _tr_nm(c, p) + ': losing the long rallies',
    _tr_full(c, 1 - p) + ' has won ' + r.won + ' of ' + r.of + ' rallies of 9+ shots (' + Math.round((100 * r.won) / r.of) + '%).',
    'Shorten points: take the first short ball and attack.'
  );
}

/** 60%+ of the last 10 tracked rally balls landed mid-court or short. */
function _tr_shortBall(c, p) {
  // Most college rally balls land short of the deep zone, so 'short' only means something
  // when it is lopsided: 9 of the last 12 short of the deep zone with 3+ inside the service line.
  const last = _tr_shots(c, p, (s) => s.kind !== 'serve' && !!s.depth).slice(-12);
  if (last.length < 12 || c.lastN < 12) return null;
  const bad = last.filter((o) => o.sh.depth === 'mid' || o.sh.depth === 'short');
  const veryShort = last.filter((o) => o.sh.depth === 'short').length;
  if (bad.length < 9 || veryShort < 3) return null;
  return _tr_mk(
    c,
    'short-ball:' + p + ':' + Math.floor(c.lastN / 10),
    p,
    'pattern',
    'watch',
    _tr_nm(c, p) + ': landing the ball short',
    bad.length + ' of ' + _tr_full(c, p) + "'s last 12 tracked rally balls landed short of the deep zone, " + veryShort + ' inside the service line.',
    'Get depth: more net clearance, aim two metres inside the baseline.',
    bad.map((o) => ({ n: o.n, i: o.sh.i }))
  );
}

// ---- form -----------------------------------------------------------------------------

/** Trophy-position knee angle of the last 5 serves is 10 degrees+ straighter than the first 5. */
function _tr_knee(c, p) {
  const v = _tr_shots(c, p, (s) => s.kind === 'serve' && s.form && s.form.trophyKnee != null);
  if (v.length < 10) return null;
  const a = _tr_avg(v.slice(0, 5).map((o) => o.sh.form.trophyKnee));
  const last = v.slice(-5);
  const b = _tr_avg(last.map((o) => o.sh.form.trophyKnee));
  if (b - a < 10 - _tr_EPS) return null;
  return _tr_mk(
    c,
    'knee:' + p + ':' + c.last.set,
    p,
    'form',
    'watch',
    _tr_nm(c, p) + ': knees straightening on serve',
    'Knee angle at the trophy position averages ' + Math.round(b) + ' degrees over the last 5 serves, against ' + Math.round(a) + ' over the first 5 (180 is straight).',
    'Load the legs in the trophy position: bend the knees.',
    last.map((o) => ({ n: o.n, i: 0 }))
  );
}

/** The split step is missing on half or more of the last 8 shots that have split-step data. */
function _tr_split(c, p) {
  const last = _tr_shots(c, p, (s) => s.form && s.form.splitStep != null).slice(-8);
  if (last.length < 8) return null;
  const missed = last.filter((o) => o.sh.form.splitStep === false);
  if (missed.length * 2 < last.length) return null;
  return _tr_mk(
    c,
    'split:' + p + ':' + Math.floor(c.lastN / 10),
    p,
    'form',
    'watch',
    _tr_nm(c, p) + ': missing the split step',
    'No split step on ' + missed.length + ' of ' + _tr_full(c, p) + "'s last 8 tracked shots.",
    'Split-step as the opponent swings.',
    missed.map((o) => ({ n: o.n, i: o.sh.i }))
  );
}

// ---- scouting -------------------------------------------------------------------------

/** The opponent (player 1) serves one placement 60%+ of the time on a side, from at least 5 serves. */
function _tr_oppServe(c) {
  const out = [];
  ['deuce', 'ad'].forEach((side) => {
    const row = c.st.players[1].placement[side];
    const total = row.Wide + row.Body + row.T;
    if (total < 5) return;
    ['Wide', 'Body', 'T'].forEach((pl) => {
      if (row[pl] * 5 < total * 3) return;
      out.push(
        _tr_mk(
          c,
          'opp-serve:' + side + ':' + pl,
          1,
          'scouting',
          'info',
          _tr_nm(c, 1) + ': serves ' + pl + ' on the ' + side + ' side',
          row[pl] + ' of ' + total + ' serves to the ' + side + ' court went ' + pl + ' (' + Math.round((100 * row[pl]) / total) + '%).',
          'Shade toward the ' + pl + ' on the ' + side + ' side.'
        )
      );
    });
  });
  return out;
}

/**
 * Alerts that hold for these points, minus the ones already raised (matched by id).
 * `points` in play order, `names` = [ours, theirs].
 */
export function detectTrends(points, names, already) {
  if (!points || !points.length) return [];
  const c = {
    pts: points,
    names,
    last: points[points.length - 1],
    lastN: points[points.length - 1].n,
    st: computeStats(points),
    games: gameGroups(points),
  };
  const found = [];
  const add = (a) => {
    if (a) found.push(a);
  };
  for (let p = 0; p < 2; p++) {
    add(_tr_fsLow(c, p));
    add(_tr_dfCluster(c, p));
    add(_tr_ueWing(c, p, 'FH'));
    add(_tr_ueWing(c, p, 'BH'));
    add(_tr_reset(c, p));
    add(_tr_pressure(c, p));
    add(_tr_longRally(c, p));
    add(_tr_shortBall(c, p));
    add(_tr_knee(c, p));
    add(_tr_split(c, p));
    add(_tr_run(c, p));
    add(_tr_pace(c, p));
  }
  _tr_oppServe(c).forEach(add);
  const seen = new Set((already || []).map((a) => a.id));
  // Cooldown: the same detector for the same player stays quiet for 12 points after it
  // fires. A coach gets one message per changeover; a repeat of the same message every few
  // points is noise, and noise gets the whole panel ignored.
  const lastAt = {};
  for (const a of already || []) {
    const k = a.id.split(':')[0] + ':' + a.who;
    if (lastAt[k] === undefined || a.at > lastAt[k]) lastAt[k] = a.at;
  }
  return found.filter((a) => {
    if (seen.has(a.id)) return false;
    const k = a.id.split(':')[0] + ':' + a.who;
    return lastAt[k] === undefined || a.at - lastAt[k] >= _tr_cooldown;
  });
}
const _tr_cooldown = 12;
