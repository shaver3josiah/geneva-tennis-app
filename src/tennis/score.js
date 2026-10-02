/**
 * Geneva Tennis: pure scoring. Contract: src/tennis/index.d.ts.
 *
 * No dependencies, no Intl/DOM, so the same file runs in Hermes, any browser (inlined into
 * the match tracker) and node. Private helpers carry the `_sc_` prefix because the tracker
 * build concatenates every src/tennis/*.js file into one scope.
 *
 * Rules implemented
 *  - The server changes every game. In a tiebreak the player due to serve serves point 1,
 *    then serve changes every 2 points. After a tiebreak (set or match) the player who
 *    RECEIVED its first point serves the next game.
 *  - Court side: 'deuce' when the points played in the game (or tiebreak) are even, else
 *    'ad'. At the no-ad deciding point (40-40) the receiver chooses the side in real play;
 *    we record 'deuce' for it, which is what the parity gives (6 points played).
 *  - Ends (ITF Rule 10): players change ends after the 1st, 3rd and every odd game OF EACH
 *    SET, counted afresh every set, and inside any tiebreak after every 6 points; a set
 *    tiebreak is that set's 13th game. So after a 6-3 or 7-6 set they change at the set
 *    break AND again after game 1 of the next set. `_sc_flipsAfterGame` holds the rule.
 *  - A match tiebreak replaces the deciding set when `finalSetMTB` and the sets are level at
 *    one short of the target (1-1 in a best of 3). It is stored as the last entry of `sets`
 *    holding its POINTS, and setsLabel() prints it in brackets: '6-4 4-6 [10-8]'.
 */

/** Match-format presets, the first one is the default. */
export const FORMATS = [
  {
    // ITA rulebook I.B (2025-26 and 2026-27): singles are best of three no-ad sets with a
    // 7-point tiebreak at 6-all and a FULL third set.
    id: 'college',
    label: 'College singles',
    hint: 'ITA dual format: no-ad, tiebreak at 6-6, full third set',
    format: { bestOf: 3, games: 6, noAd: true, tiebreakAt: 6, tbPoints: 7, finalSetMTB: false, mtbPoints: 10 },
  },
  {
    // The "shortened format", used once the dual match is already decided.
    id: 'collegeShort',
    label: 'College, shortened',
    hint: 'No-ad, 10-point match tiebreak instead of a third set (dual already decided)',
    format: { bestOf: 3, games: 6, noAd: true, tiebreakAt: 6, tbPoints: 7, finalSetMTB: true, mtbPoints: 10 },
  },
  {
    id: 'standard',
    label: 'Standard best of 3',
    hint: 'Ad scoring, tiebreak at 6-6, full third set',
    format: { bestOf: 3, games: 6, noAd: false, tiebreakAt: 6, tbPoints: 7, finalSetMTB: false, mtbPoints: 10 },
  },
  {
    id: 'doubles',
    label: 'College doubles',
    hint: 'One set to 6, no-ad, tiebreak at 6-6',
    format: { bestOf: 1, games: 6, noAd: true, tiebreakAt: 6, tbPoints: 7, finalSetMTB: false, mtbPoints: 10 },
  },
  {
    id: 'pro8',
    label: 'Pro set',
    hint: 'One set to 8 games, no-ad, tiebreak at 8-8',
    format: { bestOf: 1, games: 8, noAd: true, tiebreakAt: 8, tbPoints: 7, finalSetMTB: false, mtbPoints: 10 },
  },
  {
    id: 'fast4',
    label: 'Fast4',
    hint: 'Best of 3 sets to 4 games, no-ad, tiebreak at 3-3 to 5 points, 10-point match tiebreak for the third set',
    // Tiebreaks are win-by-2 here (index.d.ts), not Fast4's sudden death at 4-4.
    format: { bestOf: 3, games: 4, noAd: true, tiebreakAt: 3, tbPoints: 5, finalSetMTB: true, mtbPoints: 10 },
  },
];

const _sc_LABELS = ['0', '15', '30', '40'];

/** Sets a player must win. */
function _sc_need(f) {
  return (f.bestOf + 1) >> 1;
}

/** Would `a` points against `b` win the game? tb: 0 = normal game, 1 = set tiebreak, 2 = match tiebreak. */
function _sc_gameOver(a, b, tb, f) {
  if (tb) return a >= (tb === 2 ? f.mtbPoints : f.tbPoints) && a - b >= 2;
  return f.noAd ? a >= 4 : a >= 4 && a - b >= 2;
}

export class MatchScore {
  constructor(format, firstServer, nearAtStart) {
    this.format = format;
    this.firstServer = firstServer === 1 ? 1 : 0;
    this._near0 = nearAtStart === 1 ? 1 : 0;
    this._h = [];
    this._reset();
  }

  static replay(format, firstServer, winners, nearAtStart) {
    const m = new MatchScore(format, firstServer, nearAtStart);
    for (let i = 0; i < winners.length; i++) m.pointWon(winners[i]);
    return m;
  }

  _reset() {
    this._sets = [[0, 0]];
    this._pts = [0, 0];
    this._won = [0, 0];
    this._gs = this.firstServer; // server of the current game, or first server of the current tiebreak
    this._tb = 0; // 0 = normal game, 1 = set tiebreak, 2 = match tiebreak
    this._mtbSet = false; // the last entry of _sets is a match tiebreak
    this._games = 0; // games completed in the match, a tiebreak counts as one
    this._near = this._near0;
    this._winner = null;
    this._enterSet();
  }

  /** Called when a set starts: it is a match tiebreak when the sets are level one short of the target. */
  _enterSet() {
    const f = this.format;
    const k = _sc_need(f) - 1;
    if (f.finalSetMTB && this._won[0] === k && this._won[1] === k) {
      this._tb = 2;
      this._mtbSet = true;
    }
  }

  /**
   * Do the ends change after the game just counted in `_games`? `set` is the [a, b] games of the
   * set it was played in. index.d.ts says "odd cumulative games". The ITF text restarts the count
   * in every set, which would be: return (set[0] + set[1]) % 2 === 1;
   */
  _sc_flipsAfterGame(set) {
    // `set` still holds the games BEFORE the one just completed (it is incremented after
    // this call), so the completed game's number within the set is their sum plus one.
    return (set[0] + set[1] + 1) % 2 === 1;
  }

  // ---- state ----------------------------------------------------------------------------

  get history() {
    return this._h.slice();
  }
  get server() {
    if (this._tb) {
      const n = this._pts[0] + this._pts[1];
      return Math.floor((n + 1) / 2) % 2 === 0 ? this._gs : 1 - this._gs;
    }
    return this._gs;
  }
  get receiver() {
    return 1 - this.server;
  }
  get side() {
    return (this._pts[0] + this._pts[1]) % 2 === 0 ? 'deuce' : 'ad';
  }
  get inTiebreak() {
    return this._tb !== 0;
  }
  get inMatchTiebreak() {
    return this._tb === 2;
  }
  get sets() {
    return this._sets.map((s) => [s[0], s[1]]);
  }
  get points() {
    return [this._pts[0], this._pts[1]];
  }
  get setsWon() {
    return [this._won[0], this._won[1]];
  }
  get setNumber() {
    return this._sets.length;
  }
  get gameNumber() {
    if (this._tb === 2) return 1;
    const s = this._sets[this._sets.length - 1];
    return s[0] + s[1] + 1;
  }
  get matchWinner() {
    return this._winner;
  }
  get near() {
    return this._near;
  }

  // ---- labels ---------------------------------------------------------------------------

  pointLabel() {
    const s = this.server;
    const a = this._pts[s];
    const b = this._pts[1 - s];
    if (this._tb) return a + '-' + b;
    if (a >= 3 && b >= 3) {
      if (this.format.noAd) return '40-40';
      if (a === b) return 'Deuce';
      return a > b ? 'AD-40' : '40-AD';
    }
    return _sc_LABELS[a] + '-' + _sc_LABELS[b];
  }

  setsLabel() {
    const last = this._sets.length - 1;
    return this._sets
      .map((s, i) => (this._mtbSet && i === last ? '[' + s[0] + '-' + s[1] + ']' : s[0] + '-' + s[1]))
      .join(' ');
  }

  // ---- the next point -------------------------------------------------------------------

  situation() {
    const none = { breakPoint: false, gamePoint: false, setPoint: false, matchPoint: false, pressure: false };
    if (this._winner !== null) return none;
    const f = this.format;
    const tb = this._tb;
    const p = this._pts;
    const s = this.server;
    const set = this._sets[this._sets.length - 1];
    const k = _sc_need(f);
    const gameIf = (a) => _sc_gameOver(p[a] + 1, p[1 - a], tb, f);
    // would winning the next point win the SET? (a tiebreak decides the set by itself)
    const setIf = (a) => gameIf(a) && (tb !== 0 || (set[a] + 1 >= f.games && set[a] + 1 - set[1 - a] >= 2));
    const breakPoint = tb === 0 && gameIf(1 - s);
    return {
      breakPoint,
      gamePoint: gameIf(s),
      setPoint: setIf(0) || setIf(1),
      matchPoint: (setIf(0) && this._won[0] + 1 >= k) || (setIf(1) && this._won[1] + 1 >= k),
      pressure: breakPoint || tb !== 0 || (p[0] === p[1] && p[0] >= 2),
    };
  }

  snapshot() {
    const set = this._sets[this._sets.length - 1];
    const sit = this.situation();
    return {
      set: this._sets.length,
      game: this.gameNumber,
      tb: this._tb !== 0,
      scoreBefore: this.pointLabel(),
      // a match tiebreak is a set with no games played
      gamesBefore: this._tb === 2 ? [0, 0] : [set[0], set[1]],
      setsBefore: [this._won[0], this._won[1]],
      server: this.server,
      side: this.side,
      breakPoint: sit.breakPoint,
      gamePoint: sit.gamePoint,
      setPoint: sit.setPoint,
      matchPoint: sit.matchPoint,
      pressure: sit.pressure,
    };
  }

  // ---- moving on ------------------------------------------------------------------------

  pointWon(winner) {
    if (winner !== 0 && winner !== 1) throw new RangeError('pointWon: winner must be 0 or 1');
    if (this._winner !== null) return { gameWon: null, setWon: null, matchWon: null, endsChange: false };
    this._h.push(winner);
    return this._apply(winner);
  }

  undo() {
    if (!this._h.length) return;
    const keep = this._h.slice(0, -1);
    this._reset();
    this._h = [];
    for (let i = 0; i < keep.length; i++) this.pointWon(keep[i]);
  }

  _apply(w) {
    const f = this.format;
    const o = 1 - w;
    const tb = this._tb;
    const set = this._sets[this._sets.length - 1];
    const res = { gameWon: null, setWon: null, matchWon: null, endsChange: false };
    let flip = false;

    this._pts[w] += 1;
    if (tb === 2) {
      set[0] = this._pts[0];
      set[1] = this._pts[1];
    }
    // inside a tiebreak the players change ends after every 6 points
    if (tb && (this._pts[0] + this._pts[1]) % 6 === 0) flip = true;

    if (_sc_gameOver(this._pts[w], this._pts[o], tb, f)) {
      res.gameWon = w;
      this._pts = [0, 0];
      this._tb = 0;
      this._gs = 1 - this._gs; // the other player serves next (after a tiebreak: who received its first point)
      this._games += 1;
      if (this._sc_flipsAfterGame(set)) flip = true;
      let setOver;
      if (tb === 2) {
        setOver = true;
      } else {
        set[w] += 1;
        setOver = tb === 1 || (set[w] >= f.games && set[w] - set[o] >= 2);
      }
      if (setOver) {
        res.setWon = w;
        this._won[w] += 1;
        if (this._won[w] >= _sc_need(f)) {
          res.matchWon = w;
          this._winner = w;
        } else {
          this._sets.push([0, 0]);
          this._enterSet();
        }
      } else if (set[0] === f.tiebreakAt && set[1] === f.tiebreakAt) {
        this._tb = 1;
      }
    }
    if (this._winner !== null) flip = false; // nobody changes ends after the last point
    if (flip) this._near = 1 - this._near;
    res.endsChange = flip;
    return res;
  }
}
