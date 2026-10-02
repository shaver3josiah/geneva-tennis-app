/**
 * Geneva Tennis — the shared match-data contract.
 *
 * ONE implementation (src/tennis/*.js, plain ES modules, zero dependencies) is used in
 * three places: the React Native app (Hermes), the match-tracker HTML page (inlined by
 * scripts/build-tracker.mjs into a WebView / any browser), and node tests. So the .js
 * files must avoid: Intl / toLocaleString, TextEncoder, Buffer, DOM, `import` of anything
 * outside src/tennis. Field names here are load-bearing: Firestore rules, the xlsx layout
 * and the Apps Script connector all read them by name.
 *
 * Player index convention everywhere: 0 = OUR player (Geneva), 1 = OPPONENT.
 * Court frame (meters): x across the court, 0 = centre line, singles sidelines at
 * +-4.115, doubles at +-5.485. y along the court, 0 = the CAMERA-SIDE baseline,
 * 11.885 = net, 23.77 = far baseline. The camera sits behind y = 0.
 */

export type PlayerIdx = 0 | 1;
export type Wing = 'FH' | 'BH';
export type ShotKind = 'serve' | 'return' | 'ground' | 'volley' | 'overhead' | 'drop' | 'lob';
export type Depth = 'deep' | 'mid' | 'short' | 'out' | 'net';
export type Direction = 'CC' | 'MID' | 'DTL';
export type ServePlacement = 'Wide' | 'Body' | 'T';
export type Outcome = 'ace' | 'df' | 'serviceWinner' | 'winner' | 'ue' | 'fe';
export type Side = 'deuce' | 'ad';

/** Body-shape numbers measured from the pose model around one stroke. All optional:
 *  a far-court player is often too small for every joint to resolve. Angles in degrees. */
export interface FormSnapshot {
  /** Smallest knee angle during the load (180 = straight leg). Lower = more knee bend. */
  kneeMin?: number | null;
  /** Ankle spread divided by hip width at contact. ~1 = narrow, 2+ = wide base. */
  stance?: number | null;
  /** Hip-line vs shoulder-line rotation difference at the end of the backswing. */
  sep?: number | null;
  /** Contact point in front of the front foot, metres (+ = in front). */
  contactAhead?: number | null;
  /** A split-step (both feet unweighted) seen just before the opponent's contact. */
  splitStep?: boolean | null;
  /** Steps taken after contact before the next opponent contact. */
  recoverySteps?: number | null;
  /** Serve only: knee angle at the trophy position. */
  trophyKnee?: number | null;
  /** Serve only: toss apex above the court, metres. */
  tossHeight?: number | null;
}

export interface ShotRecord {
  /** Index in the rally, 0 = the serve that went in (or the last fault on a DF). */
  i: number;
  who: PlayerIdx;
  /** Seconds since the point started (first serve motion). */
  t?: number | null;
  kind: ShotKind;
  wing?: Wing | null;
  /** Ball speed just after contact, mph (estimated from the tracked arc). */
  speed?: number | null;
  /** Spin, rpm. Positive = topspin, negative = slice/backspin (estimated from the arc). */
  spin?: number | null;
  /** Racket-head speed at contact, mph (estimated from wrist kinematics). */
  swing?: number | null;
  depth?: Depth | null;
  dir?: Direction | null;
  /** Bounce point in the court frame, metres. */
  bounce?: { x: number; y: number } | null;
  /** Height the ball cleared the net tape by, metres. */
  netClear?: number | null;
  form?: FormSnapshot | null;
}

export interface PointRecord {
  /** 1-based point number in the match. Also the Firestore doc id, zero-padded to 4. */
  n: number;
  /** 1-based set number, and 1-based game number within that set. */
  set: number;
  game: number;
  /** A tiebreak point (set tiebreak or match tiebreak). */
  tb: boolean;
  /** Score BEFORE the point, server first: '30-15', '40-40', 'AD-40', or '3-2' in a tiebreak. */
  scoreBefore: string;
  /** Games in the current set before the point, indexed by player. */
  gamesBefore: [number, number];
  /** Sets won before the point, indexed by player. */
  setsBefore: [number, number];
  server: PlayerIdx;
  side: Side;
  /** Did the first serve go in? */
  serve1In: boolean;
  /** Which serve started the rally (2 when the first faulted). A double fault is serveNo 2. */
  serveNo: 1 | 2;
  serve1Speed?: number | null;
  serve2Speed?: number | null;
  /** Placement of the serve that went in (for a DF: of the second fault). */
  placement?: ServePlacement | null;
  outcome: Outcome;
  /** Who won the point. */
  winner: PlayerIdx;
  /** Who struck the last ball: the winner/ace hitter, or the player who erred. */
  endedBy: PlayerIdx;
  /** Wing of the final shot, when it was a groundstroke/volley. */
  wing?: Wing | null;
  finalKind?: ShotKind | null;
  /** Shots in the rally including the serve that went in. Ace = 1, double fault = 0. */
  rally: number;
  /** Who came to the net during the point, if anyone. */
  netApproach?: PlayerIdx | null;
  breakPoint: boolean;
  gamePoint?: boolean;
  setPoint?: boolean;
  matchPoint?: boolean;
  /** 30-30, deuce/40-40, break point, any tiebreak point. */
  pressure: boolean;
  shots?: ShotRecord[];
  durSec?: number | null;
  /** Epoch ms when the point ended. */
  at: number;
  /** Who decided the outcome: the tracker alone, a person, or a person confirming the tracker. */
  src: 'auto' | 'manual' | 'confirmed';
  /** Optional free-text tag from the charter ("let cord", "foot fault"). */
  note?: string | null;
}

export interface MatchFormat {
  /** Sets in the match: 1, 3 or 5. */
  bestOf: 1 | 3 | 5;
  /** Games to win a set: 6, or 8 for a pro set. */
  games: number;
  /** No-ad: at deuce one deciding point, receiver chooses the side. */
  noAd: boolean;
  /** A set tiebreak is played when games reach tiebreakAt-tiebreakAt. */
  tiebreakAt: number;
  /** Points to win a set tiebreak (win by 2). */
  tbPoints: number;
  /** The deciding set is replaced by a match tiebreak. */
  finalSetMTB: boolean;
  /** Points to win the match tiebreak (win by 2). */
  mtbPoints: number;
}

export interface FormatPreset {
  id: 'college' | 'collegeShort' | 'standard' | 'doubles' | 'pro8' | 'fast4';
  label: string;
  hint: string;
  format: MatchFormat;
}
export declare const FORMATS: FormatPreset[];

export interface Situation {
  breakPoint: boolean;
  gamePoint: boolean;
  setPoint: boolean;
  matchPoint: boolean;
  pressure: boolean;
}

export interface PointResult {
  gameWon: PlayerIdx | null;
  setWon: PlayerIdx | null;
  matchWon: PlayerIdx | null;
  /** Players change ends after this point (odd cumulative games, or every 6 tiebreak points). */
  endsChange: boolean;
}

/** Pure tennis scoring. Replays from the list of winners, so undo is exact. */
export declare class MatchScore {
  constructor(format: MatchFormat, firstServer: PlayerIdx, nearAtStart?: PlayerIdx);
  static replay(format: MatchFormat, firstServer: PlayerIdx, winners: PlayerIdx[], nearAtStart?: PlayerIdx): MatchScore;
  readonly format: MatchFormat;
  readonly firstServer: PlayerIdx;
  /** Winner of every point so far, in order. */
  readonly history: PlayerIdx[];
  readonly server: PlayerIdx;
  readonly receiver: PlayerIdx;
  /** Which court the server serves from for the NEXT point. */
  readonly side: Side;
  readonly inTiebreak: boolean;
  readonly inMatchTiebreak: boolean;
  /** Games per set, completed sets first, current set last. Indexed by player. */
  readonly sets: Array<[number, number]>;
  /** Points in the current game or tiebreak, indexed by player. */
  readonly points: [number, number];
  readonly setsWon: [number, number];
  /** 1-based. */
  readonly setNumber: number;
  /** 1-based game number within the current set. */
  readonly gameNumber: number;
  readonly matchWinner: PlayerIdx | null;
  /** Which player is on the camera (near, y = 0) end for the NEXT point. */
  readonly near: PlayerIdx;
  /** Score of the current game, server first ('30-15', 'Deuce', 'AD-40'; tiebreak '3-2'). */
  pointLabel(): string;
  /** '6-4 3-2' (sets, from player 0's view) */
  setsLabel(): string;
  /** Situation of the NEXT point. breakPoint = the receiver wins the game by winning it. */
  situation(): Situation;
  pointWon(winner: PlayerIdx): PointResult;
  undo(): void;
  /** Fields a PointRecord needs about the score before the next point. */
  snapshot(): Pick<PointRecord, 'set' | 'game' | 'tb' | 'scoreBefore' | 'gamesBefore' | 'setsBefore' | 'server' | 'side' | 'breakPoint' | 'gamePoint' | 'setPoint' | 'matchPoint' | 'pressure'>;
}

export interface Ratio { won: number; of: number }

export interface PlayerStats {
  pointsWon: number;
  aces: number;
  dfs: number;
  firstServeIn: Ratio;          // won = in, of = attempted
  firstServeWon: Ratio;         // points won when the first serve went in
  secondServeWon: Ratio;
  servicePoints: Ratio;
  serviceGames: Ratio;          // service games held
  returnPoints: Ratio;
  breakPointsSaved: Ratio;      // on own serve
  breakPointsWon: Ratio;        // converted on return
  winners: number;
  winnersFH: number;
  winnersBH: number;
  ue: number;
  ueFH: number;
  ueBH: number;
  fe: number;                   // forced errors committed
  netPoints: Ratio;
  rallyShort: Ratio;            // 0-4 shots
  rallyMid: Ratio;              // 5-8
  rallyLong: Ratio;             // 9+
  pressurePoints: Ratio;
  afterOwnError: Ratio;         // the point right after this player's own UE
  firstPointOfGame: Ratio;
  longestRun: number;           // most consecutive points won
  serve1Speed: { avg: number | null; max: number | null };
  serve2Speed: { avg: number | null; max: number | null };
  shotSpeed: { avg: number | null; max: number | null };
  spin: { avg: number | null; max: number | null };
  swing: { avg: number | null; max: number | null };
  depth: Record<Depth, number>; // counts of tracked rally balls (not serves)
  placement: Record<Side, Record<ServePlacement, number>>;
  kneeMin: { avg: number | null };
  splitStepRate: Ratio;
}

export interface MatchStats {
  players: [PlayerStats, PlayerStats];
  pointsPlayed: number;
  /** Running (player 0 points - player 1 points) after each point. */
  momentum: number[];
  avgRally: number | null;
}
export declare function computeStats(points: PointRecord[]): MatchStats;
/** 'won/of (pct%)' or '-' */
export declare function fmtRatio(r: Ratio): string;
export declare function pct(r: Ratio): number | null;

export interface TrendAlert {
  /** Stable id so an alert is raised once, e.g. 'fs-drop:0:set1'. */
  id: string;
  /** Point number it was raised after. */
  at: number;
  who: PlayerIdx;
  kind: 'serve' | 'errors' | 'form' | 'pattern' | 'mindset' | 'scouting' | 'fitness';
  severity: 'info' | 'watch' | 'fix';
  title: string;
  detail: string;
  /** The coaching cue to say on the changeover. */
  cue: string;
  /** Shots that show it, for the body-shape animation. */
  shotRefs?: Array<{ n: number; i: number }>;
}
/** Alerts that hold for these points. Pass the alerts already raised to get only new ones. */
export declare function detectTrends(points: PointRecord[], names: [string, string], already?: TrendAlert[]): TrendAlert[];

// --- spreadsheet ---------------------------------------------------------------------

export type XStyle = 'title' | 'sub' | 'h' | 'hl' | 'int' | 'num1' | 'pct' | 'muted' | 'good' | 'bad' | 'gold' | 'wrap' | 'bold';
export type XCell = string | number | boolean | null | undefined | { v: string | number | boolean | null; s?: XStyle };
export interface XSheet {
  name: string;
  /** Column widths in characters. */
  cols?: number[];
  rows: XCell[][];
  /** Freeze this many top rows / left columns. */
  freeze?: { rows?: number; cols?: number };
  /** e.g. 'A1:F1' */
  merges?: string[];
  /** e.g. 'A3:Z3' — header row of a table, gets filter buttons. */
  autoFilter?: string;
}
/** A real .xlsx (OOXML, zip STORE), with styles. Opens in Excel, Numbers and Google Sheets. */
export declare function buildXlsx(sheets: XSheet[]): Uint8Array;
export declare function bytesToBase64(bytes: Uint8Array): string;
export declare function toCSV(rows: XCell[][]): string;
/** Tab-separated, for pasting straight into Google Sheets. */
export declare function toTSV(rows: XCell[][]): string;

export interface MatchMeta {
  title: string;
  /** 'YYYY-MM-DD' */
  date: string;
  names: [string, string];
  formatLabel?: string;
  location?: string;
  chartedBy?: string;
}
/** Header + one row per point, ordered for a coach to read left to right. */
export declare function pointLogRows(points: PointRecord[], names: [string, string]): XCell[][];
/** Header + one row per tracked shot. */
export declare function shotRows(points: PointRecord[], names: [string, string]): XCell[][];
/** Side-by-side summary table: label | player 0 | player 1. */
export declare function summaryRows(stats: MatchStats, names: [string, string]): XCell[][];
/** The full workbook: Summary, Points, Shots, Serve Map, Trends. */
export declare function matchWorkbook(meta: MatchMeta, points: PointRecord[], alerts?: TrendAlert[]): XSheet[];
export declare function matchFileName(meta: MatchMeta, ext: 'xlsx' | 'csv'): string;
