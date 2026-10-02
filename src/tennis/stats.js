/**
 * Geneva Tennis: match statistics from PointRecord[]. Contract: src/tennis/index.d.ts.
 * Points must be in play order. Private helpers are prefixed `_st_` (the tracker build
 * concatenates every src/tennis/*.js file into one scope).
 */

/** Rounded integer percent, or null when nothing was played. */
export function pct(r) {
  return r && r.of > 0 ? Math.round((100 * r.won) / r.of) : null;
}

/** '7/12 (58%)', or '-' when nothing was played. */
export function fmtRatio(r) {
  const p = pct(r);
  return p === null ? '-' : r.won + '/' + r.of + ' (' + p + '%)';
}

const _st_r1 = (x) => Math.round(x * 10) / 10;

/** { avg, max } of a list of numbers, one decimal; nulls when the list is empty. */
function _st_speed(a) {
  if (!a.length) return { avg: null, max: null };
  let sum = 0;
  let max = a[0];
  for (let i = 0; i < a.length; i++) {
    sum += a[i];
    if (a[i] > max) max = a[i];
  }
  return { avg: _st_r1(sum / a.length), max: _st_r1(max) };
}

const _st_ratio = () => ({ won: 0, of: 0 });

function _st_blank() {
  return {
    pointsWon: 0,
    aces: 0,
    dfs: 0,
    firstServeIn: _st_ratio(),
    firstServeWon: _st_ratio(),
    secondServeWon: _st_ratio(),
    servicePoints: _st_ratio(),
    serviceGames: _st_ratio(),
    returnPoints: _st_ratio(),
    breakPointsSaved: _st_ratio(),
    breakPointsWon: _st_ratio(),
    winners: 0,
    winnersFH: 0,
    winnersBH: 0,
    ue: 0,
    ueFH: 0,
    ueBH: 0,
    fe: 0,
    netPoints: _st_ratio(),
    rallyShort: _st_ratio(),
    rallyMid: _st_ratio(),
    rallyLong: _st_ratio(),
    pressurePoints: _st_ratio(),
    afterOwnError: _st_ratio(),
    firstPointOfGame: _st_ratio(),
    longestRun: 0,
    serve1Speed: null,
    serve2Speed: null,
    shotSpeed: null,
    spin: null,
    swing: null,
    depth: { deep: 0, mid: 0, short: 0, out: 0, net: 0 },
    placement: { deuce: { Wide: 0, Body: 0, T: 0 }, ad: { Wide: 0, Body: 0, T: 0 } },
    kneeMin: { avg: null },
    splitStepRate: _st_ratio(),
  };
}

/**
 * Did this point (the last one of its game) decide the game? Read from the score before the
 * point and who won it. A game that is followed by another game is complete by definition;
 * this is only needed for the final point on the list.
 */
function _st_endsGame(p) {
  if (p.tb) {
    // a tiebreak point ends the tiebreak when the player leading it had set/match point and won
    const m = /^(\d+)-(\d+)$/.exec(p.scoreBefore || '');
    if (!m || !(p.setPoint || p.matchPoint)) return false;
    const a = Number(m[1]);
    const b = Number(m[2]);
    const leader = a > b ? p.server : b > a ? 1 - p.server : -1;
    return p.winner === leader;
  }
  const m = /^(0|15|30|40|AD)-(0|15|30|40|AD)$/.exec(p.scoreBefore || '');
  if (!m) return false; // 'Deuce' (ad scoring): the game cannot end on it
  const mine = p.winner === p.server ? m[1] : m[2];
  const theirs = p.winner === p.server ? m[2] : m[1];
  if (mine === 'AD') return true;
  if (mine !== '40' || theirs === 'AD') return false;
  if (theirs !== '40') return true;
  return !!p.breakPoint; // 40-40: only the no-ad deciding point ends the game
}

/**
 * Points grouped into games (and tiebreaks), in order:
 *   { set, game, tb, server, pts, complete, winner }
 * `server` is the server of the first point (a tiebreak changes server). `complete` is true
 * when a later game exists or the last point decided the game; `winner` is then who won it.
 */
export function gameGroups(points) {
  const out = [];
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    const g = out[out.length - 1];
    if (g && g.set === p.set && g.game === p.game) g.pts.push(p);
    else out.push({ set: p.set, game: p.game, tb: !!p.tb, server: p.server, pts: [p], complete: false, winner: null });
  }
  for (let i = 0; i < out.length; i++) {
    const g = out[i];
    const last = g.pts[g.pts.length - 1];
    g.complete = i < out.length - 1 || _st_endsGame(last);
    g.winner = g.complete ? last.winner : null;
  }
  return out;
}

export function computeStats(points) {
  const pl = [_st_blank(), _st_blank()];
  const raw = [0, 1].map(() => ({ s1: [], s2: [], shot: [], spin: [], swing: [], knee: [] }));
  const momentum = [];
  const run = [0, 0];
  let diff = 0;
  let rallySum = 0;
  let rallyN = 0;

  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    const w = p.winner;
    const l = 1 - w;
    const s = p.server;
    const r = 1 - s;
    const S = pl[s];
    const ry = p.rally || 0;

    pl[w].pointsWon += 1;
    run[w] += 1;
    run[l] = 0;
    if (run[w] > pl[w].longestRun) pl[w].longestRun = run[w];
    diff += w === 0 ? 1 : -1;
    momentum.push(diff);

    // serve and return
    S.servicePoints.of += 1;
    S.firstServeIn.of += 1; // every point starts with a first serve
    if (w === s) S.servicePoints.won += 1;
    if (p.serve1In) {
      S.firstServeIn.won += 1;
      S.firstServeWon.of += 1;
      if (w === s) S.firstServeWon.won += 1;
    }
    if (p.serveNo === 2) {
      S.secondServeWon.of += 1; // a double fault is a lost second serve
      if (w === s) S.secondServeWon.won += 1;
    }
    pl[r].returnPoints.of += 1;
    if (w === r) pl[r].returnPoints.won += 1;
    if (p.outcome === 'ace') S.aces += 1;
    if (p.outcome === 'df') S.dfs += 1;
    if (p.serve1Speed != null) raw[s].s1.push(p.serve1Speed);
    if (p.serve2Speed != null) raw[s].s2.push(p.serve2Speed);
    const row = S.placement[p.side];
    if (row && p.placement && typeof row[p.placement] === 'number') row[p.placement] += 1;

    // break points: saved on serve, converted on return
    if (p.breakPoint) {
      S.breakPointsSaved.of += 1;
      pl[r].breakPointsWon.of += 1;
      if (w === s) S.breakPointsSaved.won += 1;
      else pl[r].breakPointsWon.won += 1;
    }

    // how the point ended, credited to whoever hit the last ball (aces are counted apart)
    const e = p.endedBy;
    const E = pl[e];
    if (E) {
      if (p.outcome === 'winner') {
        E.winners += 1;
        if (p.wing === 'FH') E.winnersFH += 1;
        else if (p.wing === 'BH') E.winnersBH += 1;
      } else if (p.outcome === 'ue') {
        E.ue += 1;
        if (p.wing === 'FH') E.ueFH += 1;
        else if (p.wing === 'BH') E.ueBH += 1;
      } else if (p.outcome === 'fe') {
        E.fe += 1;
      }
    }

    if (p.netApproach === 0 || p.netApproach === 1) {
      pl[p.netApproach].netPoints.of += 1;
      if (w === p.netApproach) pl[p.netApproach].netPoints.won += 1;
    }

    // rally length buckets, pressure and first point of a game belong to both players
    const bucket = ry <= 4 ? 'rallyShort' : ry <= 8 ? 'rallyMid' : 'rallyLong';
    pl[0][bucket].of += 1;
    pl[1][bucket].of += 1;
    pl[w][bucket].won += 1;
    if (p.pressure) {
      pl[0].pressurePoints.of += 1;
      pl[1].pressurePoints.of += 1;
      pl[w].pressurePoints.won += 1;
    }
    if (!p.tb && p.scoreBefore === '0-0') {
      pl[0].firstPointOfGame.of += 1;
      pl[1].firstPointOfGame.of += 1;
      pl[w].firstPointOfGame.won += 1;
    }

    // the point right after a player's own unforced error
    const prev = i > 0 ? points[i - 1] : null;
    if (prev && prev.outcome === 'ue' && pl[prev.endedBy]) {
      pl[prev.endedBy].afterOwnError.of += 1;
      if (w === prev.endedBy) pl[prev.endedBy].afterOwnError.won += 1;
    }

    if (ry > 0) {
      rallySum += ry;
      rallyN += 1;
    }

    // tracked shots
    const shots = p.shots || [];
    for (let k = 0; k < shots.length; k++) {
      const sh = shots[k];
      const P = pl[sh.who];
      if (!P) continue;
      const R = raw[sh.who];
      if (sh.kind !== 'serve') {
        if (sh.speed != null) R.shot.push(sh.speed);
        if (sh.spin != null) R.spin.push(sh.spin);
        if (sh.swing != null) R.swing.push(sh.swing);
        if (sh.depth && typeof P.depth[sh.depth] === 'number') P.depth[sh.depth] += 1;
      }
      if (sh.form) {
        if (sh.form.kneeMin != null) R.knee.push(sh.form.kneeMin);
        if (sh.form.splitStep != null) {
          P.splitStepRate.of += 1;
          if (sh.form.splitStep) P.splitStepRate.won += 1;
        }
      }
    }
  }

  // service games: only the ones that finished, tiebreaks are not service games
  const groups = gameGroups(points);
  for (let i = 0; i < groups.length; i++) {
    const g = groups[i];
    if (g.tb || !g.complete) continue;
    pl[g.server].serviceGames.of += 1;
    if (g.winner === g.server) pl[g.server].serviceGames.won += 1;
  }

  for (let q = 0; q < 2; q++) {
    const P = pl[q];
    const R = raw[q];
    P.serve1Speed = _st_speed(R.s1);
    P.serve2Speed = _st_speed(R.s2);
    P.shotSpeed = _st_speed(R.shot);
    P.spin = _st_speed(R.spin);
    P.swing = _st_speed(R.swing);
    P.kneeMin = { avg: R.knee.length ? _st_speed(R.knee).avg : null };
  }

  return { players: pl, pointsPlayed: points.length, momentum, avgRally: rallyN ? _st_r1(rallySum / rallyN) : null };
}
