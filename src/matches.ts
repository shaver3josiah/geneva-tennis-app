import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  limit,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  writeBatch,
  type Unsubscribe,
} from 'firebase/firestore';
import { db } from './firebase';
import {
  computeStats,
  pct,
  type FormatPreset,
  type MatchFormat,
  type PlayerIdx,
  type PlayerStats,
  type PointRecord,
  type TrendAlert,
  type XCell,
} from './tennis';
import type { Match, MatchClip, MatchSummaryLine, TeamSettings } from './types';

/**
 * Matches: the Firestore side of docs/MATCH-DATA.md.
 *
 * The rules behind every call here (firebase/firestore.rules, "Matches") let the coach and
 * any roster MEMBER read and write matches, and a member is an account with a
 * /members/{uid} document. None of those rules look at the match itself, so no query
 * below has to be shaped around them.
 */

const err = (label: string) => (e: unknown) => {
  // A denied listener fails silently otherwise, which reads as "no matches" and sends you
  // hunting through the UI for a bug that is actually a missing members document.
  console.warn(`[gt] ${label} listener failed:`, e);
};

/** The school this app is for. Our player is always index 0. */
export const OUR_SCHOOL = 'Geneva';

/** A point's document id: '0007'. Zero-padded so the console lists points in play order. */
export const pointId = (n: number) => String(n).padStart(4, '0');

/** 'Geneva vs Westminster', or 'vs Kate Doe' when nobody typed a school. */
export const matchTitle = (opponentSchool: string | undefined, opponent: string) =>
  opponentSchool?.trim() ? `${OUR_SCHOOL} vs ${opponentSchool.trim()}` : `vs ${opponent.trim()}`;

/** '#1 Singles · Geneva vs Westminster'. Nine lines of one dual match share a title, so
 *  anything that leaves the app (a file, an email subject, a sheet) carries the position. */
export const fullTitle = (m: Pick<Match, 'position' | 'title'>) =>
  m.position ? `${m.position} · ${m.title}` : m.title;

/** Today as 'YYYY-MM-DD' in local time. toISOString would hand back tomorrow's date to
 *  anyone charting an evening match west of Greenwich. */
export function dayKey(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// --- membership --------------------------------------------------------------

const memberChecks = new Map<string, Promise<boolean>>();

/**
 * Make sure this account has its /members/{uid} document, which is what the match rules
 * read. Idempotent and memoised: the session calls it at sign-in and every match screen
 * awaits the same promise, so it costs one read per launch and one write ever.
 *
 * Resolves false instead of throwing. A cached "does not exist" is treated as "could not
 * tell" rather than as a miss, because the rules make the document create-only and a
 * second create from a phone that was merely offline would be refused.
 */
export function ensureMember(uid: string, athleteId: string): Promise<boolean> {
  const key = `${uid}:${athleteId}`;
  let check = memberChecks.get(key);
  if (!check) {
    check = (async () => {
      const ref = doc(db, 'members', uid);
      const snap = await getDoc(ref);
      if (snap.exists()) return true;
      if (snap.metadata.fromCache) throw new Error('offline, membership unknown');
      await setDoc(ref, { athleteId, joinedAt: serverTimestamp() });
      return true;
    })().catch((e) => {
      console.warn('[gt] membership check failed:', (e as { code?: string })?.code ?? e);
      memberChecks.delete(key); // so the next screen that asks tries again
      return false;
    });
    memberChecks.set(key, check);
  }
  return check;
}

// --- reading -------------------------------------------------------------------

/**
 * The newest matches first. ponytail: one season is a few dozen charted matches, so 150
 * covers it with room to spare. Page on `date` the season that stops being true.
 */
export function subscribeMatches(cb: (m: Match[]) => void, onError?: (e: unknown) => void): Unsubscribe {
  return onSnapshot(
    query(collection(db, 'matches'), orderBy('date', 'desc'), limit(150)),
    (snap) =>
      cb(snap.docs.map((d) => ({ id: d.id, ...d.data({ serverTimestamps: 'estimate' }) }) as Match)),
    (e) => {
      err('matches')(e);
      onError?.(e);
    }
  );
}

/** null once Firestore confirms the match is gone. */
export function subscribeMatch(
  id: string,
  cb: (m: Match | null) => void,
  onError?: (e: unknown) => void
): Unsubscribe {
  return onSnapshot(
    doc(db, 'matches', id),
    (snap) => {
      // A cold cache answers "does not exist" before the server has said anything. Saying
      // "this match was deleted" on that would be a lie told to every fresh launch.
      if (!snap.exists() && snap.metadata.fromCache) return;
      cb(snap.exists() ? ({ id: snap.id, ...snap.data({ serverTimestamps: 'estimate' }) } as Match) : null);
    },
    (e) => {
      err('match')(e);
      onError?.(e);
    }
  );
}

/** Every point, in play order. */
export function subscribePoints(id: string, cb: (p: PointRecord[]) => void): Unsubscribe {
  return onSnapshot(
    query(collection(db, 'matches', id, 'points'), orderBy('n')),
    (snap) => cb(snap.docs.map((d) => d.data() as PointRecord)),
    err('points')
  );
}

/**
 * The saved points, once, for the tracker to resume from.
 *
 * Fires only on an answer the server confirmed, or on a cached one that already holds every
 * point the match document counts. Offline, a cold cache answers "no points" at once, and
 * resuming from that would chart a new point 1 straight over the real point 1.
 */
export function waitForPoints(
  id: string,
  expect: number,
  cb: (p: PointRecord[]) => void,
  onError: (e: unknown) => void
): Unsubscribe {
  let done = false;
  return onSnapshot(
    query(collection(db, 'matches', id, 'points'), orderBy('n')),
    { includeMetadataChanges: true },
    (snap) => {
      if (done || (snap.metadata.fromCache && snap.size < expect)) return;
      done = true;
      cb(snap.docs.map((d) => d.data() as PointRecord));
    },
    (e) => {
      err('points (resume)')(e);
      onError(e);
    }
  );
}

/** Clips carry up to 180 KB of keyframes each, so only the Trends tab opens this. */
export function subscribeClips(id: string, cb: (c: MatchClip[]) => void): Unsubscribe {
  return onSnapshot(
    collection(db, 'matches', id, 'clips'),
    (snap) => cb(snap.docs.map((d) => ({ id: d.id, ...d.data() }) as MatchClip)),
    err('clips')
  );
}

/**
 * Never leaves a screen waiting: a member whose /members document has not landed yet is
 * refused this read, and "no connector" is the right answer for them until it has.
 */
export function subscribeTeamSettings(cb: (s: TeamSettings) => void): Unsubscribe {
  return onSnapshot(
    doc(db, 'team', 'settings'),
    (snap) => cb((snap.data() as TeamSettings | undefined) ?? {}),
    (e) => {
      err('team settings')(e);
      cb({});
    }
  );
}

// --- writing ---------------------------------------------------------------------

/** A match id minted on the phone, offline if need be, so a Google Sheet can be made for
 *  the match before its document exists. Only the id is taken from this reference. */
export const newMatchId = () => doc(collection(db, 'matches')).id;

export interface NewMatch {
  names: [string, string];
  athleteId?: string;
  opponentSchool?: string;
  position: string;
  kind: Match['kind'];
  formatId: FormatPreset['id'];
  format: MatchFormat;
  firstServer: PlayerIdx;
  nearAtStart: PlayerIdx;
  date: string;
}

/**
 * Resolves when the SERVER has the match, which at a court with one bar can be a while.
 * Firestore applies the write locally at once, so callers race this against a short
 * timer and move on: every screen after this one reads the local copy until it syncs.
 */
export function createMatch(
  id: string,
  m: NewMatch,
  uid: string,
  sheet?: { url: string; sheetId: string }
): Promise<void> {
  return setDoc(doc(db, 'matches', id), {
    title: matchTitle(m.opponentSchool, m.names[1]),
    date: m.date,
    kind: m.kind,
    position: m.position,
    names: [m.names[0].trim(), m.names[1].trim()],
    ...(m.athleteId ? { athleteId: m.athleteId } : {}),
    ...(m.opponentSchool?.trim() ? { opponentSchool: m.opponentSchool.trim() } : {}),
    formatId: m.formatId,
    format: m.format,
    firstServer: m.firstServer,
    nearAtStart: m.nearAtStart,
    status: 'live',
    scoreLine: '',
    pointCount: 0,
    ...(sheet ? { sheetUrl: sheet.url, sheetId: sheet.sheetId } : {}),
    // The rule pins this to the caller. It is also who may delete the match besides the coach.
    createdBy: uid,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });
}

/** The few numbers per player that a list row shows. */
export function summaryOf(points: PointRecord[]): [MatchSummaryLine, MatchSummaryLine] {
  const line = (q: PlayerStats): MatchSummaryLine => ({
    fsPct: pct(q.firstServeIn),
    winners: q.winners,
    ue: q.ue,
    aces: q.aces,
    dfs: q.dfs,
  });
  const { players } = computeStats(points);
  return [line(players[0]), line(players[1])];
}

/**
 * One tracker batch, in ONE commit: each point set by its zero-padded number, each undone
 * point deleted, and the match document brought up to date beside them. A list row can
 * therefore never show a score the point log does not have yet, or the other way round.
 *
 * `ops` is at most ~450 long; Firestore refuses a batch past 500 writes.
 */
export function savePointBatch(
  matchId: string,
  ops: Array<[number, PointRecord | null]>,
  patch: Record<string, unknown>
): Promise<void> {
  const batch = writeBatch(db);
  for (const [n, p] of ops) {
    const ref = doc(db, 'matches', matchId, 'points', pointId(n));
    if (p) batch.set(ref, p);
    else batch.delete(ref);
  }
  batch.update(doc(db, 'matches', matchId), {
    ...patch,
    updatedAt: serverTimestamp(),
    lastSyncAt: serverTimestamp(),
  });
  return batch.commit();
}

/**
 * The newest 60 alerts with this one in, deduplicated by id. Pure: the tracker host writes
 * the result with the next point batch, so an alert rides the same retry as the points.
 * A resumed tracker raises its alerts again, and the stable id is what keeps them single.
 */
export function addAlert(alerts: TrendAlert[], alert: TrendAlert): TrendAlert[] {
  if (!alert || typeof alert.id !== 'string') return alerts;
  const rest = alerts.filter((a) => a.id !== alert.id);
  return [...rest, alert].sort((a, b) => (a.at ?? 0) - (b.at ?? 0)).slice(-60);
}

export interface ClipMessage {
  id: string;
  alertId: string;
  title: string;
  who: PlayerIdx;
  fps: number;
  frames: string;
}

/** The rule's ceiling is 190 000; the contract's is 180 000. The gap is headroom, not slack. */
export const CLIP_MAX_CHARS = 180_000;

/**
 * Create-only by rule. A tracker that resumes sends its clips again, and set() on a clip
 * that already exists is an update the rules refuse, so that refusal is checked for and
 * counted as saved.
 */
export async function saveClip(matchId: string, clip: ClipMessage, uid: string): Promise<void> {
  // A slash in an id would turn it into a path.
  const ref = doc(db, 'matches', matchId, 'clips', String(clip.id).replace(/\//g, '_').slice(0, 200));
  try {
    await setDoc(ref, {
      alertId: String(clip.alertId ?? ''),
      title: String(clip.title ?? '').slice(0, 200),
      who: clip.who === 1 ? 1 : 0,
      fps: Number(clip.fps) || 15,
      frames: clip.frames,
      createdAt: serverTimestamp(),
      createdBy: uid,
    });
  } catch (e) {
    if ((await getDoc(ref).catch(() => null))?.exists()) return;
    throw e;
  }
}

export function setMatchFinal(id: string) {
  return updateDoc(doc(db, 'matches', id), { status: 'final', updatedAt: serverTimestamp() });
}

/** Links the spreadsheet the connector made on its own for a match that had none. */
export function linkSheet(id: string, url: string, sheetId: string) {
  return updateDoc(doc(db, 'matches', id), { sheetUrl: url, sheetId });
}

/**
 * Points and clips first, the match last. Firestore does not delete a subcollection with
 * its parent, and a match whose children went first can simply be deleted again, where
 * one whose children were orphaned would bill storage forever with nothing pointing at it.
 */
export async function deleteMatch(id: string) {
  for (const sub of ['points', 'clips']) {
    const snap = await getDocs(collection(db, 'matches', id, sub));
    for (let i = 0; i < snap.docs.length; i += 400) {
      const batch = writeBatch(db);
      snap.docs.slice(i, i + 400).forEach((d) => batch.delete(d.ref));
      await batch.commit();
    }
  }
  await deleteDoc(doc(db, 'matches', id));
}

export function saveTeamSettings(s: TeamSettings) {
  return setDoc(doc(db, 'team', 'settings'), {
    sheetsUrl: s.sheetsUrl?.trim() ?? '',
    sheetsToken: s.sheetsToken?.trim() ?? '',
    coachEmail: s.coachEmail?.trim().toLowerCase() ?? '',
  });
}

export const hasConnector = (s: TeamSettings | null | undefined) => !!(s?.sheetsUrl && s.sheetsToken);

// --- points the phone could not save yet -------------------------------------------

/**
 * Points the tracker charted that Firestore has not accepted yet, kept on the phone.
 *
 * Firestore queues offline writes in MEMORY on React Native, so a phone that dies or gets
 * swiped away during a long dead spot at the courts loses everything since the signal
 * went. This copy survives that: the next time the tracker opens for the match, the
 * points come back from here and are sent again. Sets and deletes are both idempotent,
 * so sending one that did land after all changes nothing.
 */
export interface Unsynced {
  points: PointRecord[];
  removed: number[];
}

const unsyncedKey = (matchId: string) => `gt:unsynced:${matchId}`;

export async function loadUnsynced(matchId: string): Promise<Unsynced | null> {
  try {
    const raw = await AsyncStorage.getItem(unsyncedKey(matchId));
    const u = raw ? (JSON.parse(raw) as Unsynced) : null;
    return u && Array.isArray(u.points) && Array.isArray(u.removed) ? u : null;
  } catch {
    return null;
  }
}

export function saveUnsynced(matchId: string, ops: Map<number, PointRecord | null>) {
  const key = unsyncedKey(matchId);
  const points = [...ops.values()].filter((p): p is PointRecord => !!p);
  const removed = [...ops].filter(([, p]) => !p).map(([n]) => n);
  (ops.size ? AsyncStorage.setItem(key, JSON.stringify({ points, removed })) : AsyncStorage.removeItem(key)).catch(
    (e) => console.warn('[gt] could not keep unsaved points on the phone:', e)
  );
}

// --- the Google Sheets connector -------------------------------------------------

export interface ConnectorReply {
  ok: boolean;
  error?: string;
  owner?: string;
  version?: number;
  sheetId?: string;
  url?: string;
  written?: number;
}

/** A cell's bare value. */
export const cellValue = (c: XCell) => (c !== null && typeof c === 'object' ? c.v : c) ?? '';

/** Cells as bare values. Every connector can write those; a style object is ours alone. */
export const plainCells = (rows: XCell[][]) => rows.map((r) => r.map(cellValue));

export interface SummarySection {
  title: string;
  rows: Array<{ label: string; cells: [XCell, XCell] }>;
}

/**
 * summaryRows() regrouped for reading on a phone. A section is the row summaryRows styles
 * 'hl', not merely one with empty cells: a stat nobody measured has empty cells too. Such
 * stats are dropped (ball speed in a match charted by hand is a column of dashes), and
 * so is a section left with nothing in it.
 */
export function summarySections(table: XCell[][]): SummarySection[] {
  const out: SummarySection[] = [];
  const blank = (c: XCell) => ['', '-'].includes(String(cellValue(c)));
  for (const r of table.slice(1)) {
    const head = r[0];
    if (head !== null && typeof head === 'object' && head.s === 'hl') {
      out.push({ title: String(head.v ?? ''), rows: [] });
      continue;
    }
    if (blank(r[1]) && blank(r[2])) continue;
    if (!out.length) out.push({ title: '', rows: [] });
    out[out.length - 1].rows.push({ label: String(cellValue(head)), cells: [r[1], r[2]] });
  }
  return out.filter((s) => s.rows.length);
}

/**
 * One call to the coach's Apps Script web app (sheets-connector/Code.gs).
 *
 * text/plain is deliberate: it is a "simple" content type, so a browser sends it with no
 * CORS preflight, which Apps Script cannot answer. Google replies with a redirect to the
 * script's output, which fetch follows. Every failure comes back as an Error whose message
 * a coach can act on, because "TypeError: Network request failed" is not one.
 */
export async function connectorPost(
  url: string,
  token: string,
  action: 'ping' | 'createMatch' | 'pushPoints',
  body: Record<string, unknown> = {}
): Promise<ConnectorReply> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  let status = 0;
  let text = '';
  try {
    const res = await fetch(url.trim(), {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ ...body, action, token }),
      redirect: 'follow',
      signal: ctrl.signal,
    });
    status = res.status;
    text = await res.text();
  } catch {
    throw new Error(
      ctrl.signal.aborted
        ? 'Google took more than 15 seconds to answer. Check signal and try again.'
        : 'Could not reach Google. Check signal, and that the web app URL is right.'
    );
  } finally {
    clearTimeout(timer);
  }

  let reply: ConnectorReply | null = null;
  try {
    reply = JSON.parse(text) as ConnectorReply;
  } catch {
    // A deployment not shared with "Anyone" answers with Google's sign-in page: HTML, and
    // often a 200, so the status alone cannot tell this apart from success.
    if (/<html|<!doctype/i.test(text) || status === 401 || status === 403) {
      throw new Error('Google sent a sign-in page instead of the script. Deploy it again with "Who has access: Anyone".');
    }
    if (status === 404) throw new Error('There is no script at that address. Copy the web app URL again; it ends in /exec.');
    throw new Error(`The script sent back something unexpected (HTTP ${status}).`);
  }
  if (!reply || typeof reply !== 'object') throw new Error('The script sent back something unexpected.');
  if (!reply.ok) {
    const why = String(reply.error ?? '');
    if (why === 'bad token') throw new Error('The token does not match TOKEN in the script. Type it again exactly.');
    if (/edit token/i.test(why)) {
      throw new Error('The script still has its placeholder token. Set TOKEN in Code.gs, save, and deploy a new version.');
    }
    throw new Error(why ? `The script said: ${why}` : 'The script refused the request.');
  }
  return reply;
}

// --- list helpers ------------------------------------------------------------------

/** How long after its last sync a match still counts as being charted right now. Long
 *  enough to cover a set break, short enough that an abandoned match stops pulsing. */
const LIVE_WINDOW_MS = 20 * 60 * 1000;

export type MatchState = 'live' | 'paused' | 'new' | 'final';

/** What a list row and the header say about a match, in one word each. */
export function matchState(m: Match, now = Date.now()): MatchState {
  if (m.status === 'final') return 'final';
  if (!m.pointCount) return 'new';
  const last = m.lastSyncAt?.toMillis?.() ?? 0;
  return now - last < LIVE_WINDOW_MS ? 'live' : 'paused';
}

export const STATE_WORD: Record<MatchState, string> = {
  live: 'Live',
  paused: 'In progress',
  new: 'Not started',
  final: 'Final',
};

/** Doubles first, as a dual match is played, then by line: #1 before #2. */
export function lineOrder(position: string): number {
  const n = Number(/#(\d+)/.exec(position)?.[1] ?? 9);
  return (/doubles/i.test(position) ? 0 : 10) + n;
}

/** 'Today', 'Yesterday', or 'Sat, Oct 4'. */
export function dateLabel(key: string, now = new Date()): string {
  if (key === dayKey(now)) return 'Today';
  const y = new Date(now);
  y.setDate(y.getDate() - 1);
  if (key === dayKey(y)) return 'Yesterday';
  const [yy, mm, dd] = key.split('-').map(Number);
  if (!yy || !mm || !dd) return key;
  const d = new Date(yy, mm - 1, dd);
  return d.toLocaleDateString([], {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    ...(yy !== now.getFullYear() ? { year: 'numeric' } : {}),
  });
}
