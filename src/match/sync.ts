import {
  computeStats,
  MatchScore,
  pointLogRows,
  summaryRows,
  type PointRecord,
  type TrendAlert,
} from '../tennis';
import {
  addAlert,
  CLIP_MAX_CHARS,
  connectorPost,
  fullTitle,
  hasConnector,
  linkSheet,
  plainCells,
  saveClip,
  savePointBatch,
  saveUnsynced,
  summaryOf,
  type ClipMessage,
  type Unsynced,
} from '../matches';
import type { Match, TeamSettings } from '../types';

/**
 * The live tracker's host side: everything between a `gt:*` message from the tracker page
 * and Firestore or the coach's Google Sheet. See docs/MATCH-DATA.md.
 *
 * The one promise it keeps is that a charted point is never dropped quietly. Every point
 * sits in `dirty` until a commit that carried it succeeds, and in AsyncStorage beside it,
 * so a failed write, a dead spot at the courts and a phone that dies mid-set all end with
 * the point in Firestore eventually, and the screen saying so until then.
 */

export interface SyncState {
  /** Points Firestore has confirmed. */
  synced: number;
  /** Points charted that Firestore has not accepted yet. */
  waiting: number;
  db: 'ok' | 'offline' | 'denied' | 'failed' | 'gone';
  /** 'off' when the team has no Google Sheets connector. */
  sheet: 'off' | 'idle' | 'pushing' | 'ok' | 'failed';
  sheetError?: string;
}

/** The payload of a `gt:points` message. */
export interface PointsMessage {
  points?: PointRecord[];
  removed?: number[];
  scoreLine?: string;
  final?: boolean;
}

/** Firestore refuses a batch past 500 writes; the match update rides along with these. */
const MAX_OPS = 450;
/** A commit still pending after this long is a phone without signal, not a slow server. */
const SLOW_MS = 6000;

/** The rules accept a point numbered 1 to 2000 and nothing else, and one bad point would
 *  sink the whole batch with every good point in it. Checked here, at the boundary. */
const usableN = (n: unknown): n is number => Number.isInteger(n) && (n as number) >= 1 && (n as number) <= 2000;

export class MatchSync {
  private all = new Map<number, PointRecord>();
  /** Writes Firestore has not confirmed: a point to set, or null for one to delete. */
  private dirty = new Map<number, PointRecord | null>();
  /** Undone points whose rows the Google Sheet may still have. */
  private unsheet = new Set<number>();
  private alerts: TrendAlert[];
  private scoreLine?: string;
  private final: boolean;
  /** Bumped on every change, so a commit knows whether something arrived while it flew. */
  private ver = 0;
  private savedVer = 0;
  private alertsVer = 0;
  private savedAlertsVer = 0;
  private flushing = false;
  private retryMs = 0;
  private retryTimer?: ReturnType<typeof setTimeout>;
  private pushing = false;
  private pushAgain = false;
  private sheetTimer?: ReturnType<typeof setTimeout>;
  private clips: Array<ClipMessage & { tries: number }> = [];
  private clipBusy = false;
  private stopped = false;
  private settings: TeamSettings = {};
  private state: SyncState;

  constructor(
    private match: Match,
    saved: PointRecord[],
    restored: Unsynced | null,
    private uid: string,
    private onState: (s: SyncState) => void
  ) {
    this.alerts = match.alerts ?? [];
    this.final = match.status === 'final';
    for (const p of saved) this.all.set(p.n, p);
    // Points a previous session charted and never got into Firestore. Deletions first, so
    // a point that was undone and charted again comes back as the second version.
    for (const n of restored?.removed ?? []) {
      this.all.delete(n);
      this.dirty.set(n, null);
    }
    for (const p of restored?.points ?? []) {
      if (!usableN(p?.n)) continue;
      this.all.set(p.n, p);
      this.dirty.set(p.n, p);
    }
    this.state = { synced: saved.length, waiting: this.dirty.size, db: 'ok', sheet: 'off' };
    if (this.dirty.size) {
      this.ver++;
      void this.flush();
    }
  }

  /** What `window.__gtInit` gets: the match, and every point to resume from. */
  initPayload() {
    const m = this.match;
    return {
      mode: 'app',
      matchId: m.id,
      title: fullTitle(m),
      names: m.names,
      format: m.format,
      formatId: m.formatId,
      firstServer: m.firstServer,
      nearAtStart: m.nearAtStart,
      points: this.sorted(),
      syncEvery: 3,
      // Not in the contract's list, but the tracker reads it to link the sheet from its menu.
      ...(m.sheetUrl ? { sheetUrl: m.sheetUrl } : {}),
    };
  }

  /** Points charted that are not in Firestore yet. */
  unsaved = () => this.dirty.size;

  setMatch(m: Match) {
    // The snapshot can lag a sheet this engine linked a moment ago; keep the newer link.
    this.match = { ...m, sheetUrl: m.sheetUrl ?? this.match.sheetUrl, sheetId: m.sheetId ?? this.match.sheetId };
  }

  setSettings(s: TeamSettings) {
    const had = hasConnector(this.settings);
    this.settings = s;
    if (!hasConnector(s)) return this.emit({ sheet: 'off', sheetError: undefined });
    if (this.state.sheet === 'off') this.emit({ sheet: 'idle' });
    // On a resume, bring the sheet level with every saved point straight away. Rows are
    // upserted by point number, so re-sending what it already has changes nothing.
    if (!had) void this.pushSheet();
  }

  onPoints(msg: PointsMessage) {
    if (this.stopped) return;
    // Removals first: one batch can undo point 12 and chart a new point 12, and the new
    // one must be what survives.
    for (const raw of msg.removed ?? []) {
      const n = Number(raw);
      if (!usableN(n)) continue;
      this.all.delete(n);
      this.dirty.set(n, null);
      this.unsheet.add(n);
    }
    for (const p of msg.points ?? []) {
      if (!usableN(p?.n)) {
        console.warn('[gt] the tracker sent a point numbered', p?.n, '- skipped');
        continue;
      }
      this.all.set(p.n, p);
      this.dirty.set(p.n, p);
      this.unsheet.delete(p.n);
    }
    if (typeof msg.scoreLine === 'string') this.scoreLine = msg.scoreLine;
    if (typeof msg.final === 'boolean') this.final = msg.final;
    this.ver++;
    saveUnsynced(this.match.id, this.dirty);
    this.emit({ waiting: this.dirty.size });
    void this.flush();
    void this.pushSheet();
  }

  onAlert(alert: TrendAlert) {
    // A resumed tracker raises its alerts again. The id is stable, so the second copy is
    // dropped here rather than costing a write.
    if (this.stopped || !alert?.id || this.alerts.some((a) => a.id === alert.id)) return;
    this.alerts = addAlert(this.alerts, alert);
    this.alertsVer++;
    this.ver++;
    void this.flush();
  }

  onClip(clip: ClipMessage) {
    if (this.stopped || !clip?.id || typeof clip.frames !== 'string') return;
    if (clip.frames.length >= CLIP_MAX_CHARS) {
      console.warn(`[gt] clip ${clip.id} is ${clip.frames.length} chars, over the ${CLIP_MAX_CHARS} ceiling; not saved`);
      return;
    }
    this.clips.push({ ...clip, tries: 0 });
    void this.drainClips();
  }

  dispose() {
    this.stopped = true;
    clearTimeout(this.retryTimer);
    clearTimeout(this.sheetTimer);
  }

  // --- internals ---------------------------------------------------------------

  private sorted() {
    return [...this.all.values()].sort((a, b) => a.n - b.n);
  }

  private emit(patch: Partial<SyncState>) {
    const waitingSets = [...this.dirty.values()].filter(Boolean).length;
    this.state = { ...this.state, synced: this.all.size - waitingSets, waiting: this.dirty.size, ...patch };
    if (!this.stopped) this.onState(this.state);
  }

  /** The match fields every batch rewrites, from the whole point list as it now stands. */
  private patch(withAlerts: boolean): Record<string, unknown> {
    const pts = this.sorted();
    return {
      scoreLine: (this.scoreLine ?? this.replayedScore(pts)).slice(0, 80),
      pointCount: pts.length,
      summary: summaryOf(pts),
      // A batch arriving means the match is being played, whatever the coach marked.
      status: this.final ? 'final' : 'live',
      ...(withAlerts ? { alerts: this.alerts } : {}),
    };
  }

  /** The score line the tracker would send, for a flush of restored points before the
   *  tracker has sent anything this session. */
  private replayedScore(pts: PointRecord[]): string {
    try {
      const m = this.match;
      const sc = MatchScore.replay(m.format, m.firstServer, pts.map((p) => p.winner), m.nearAtStart);
      return sc.matchWinner === null && pts.length ? `${sc.setsLabel()} ${sc.pointLabel()}` : sc.setsLabel();
    } catch {
      return this.match.scoreLine ?? '';
    }
  }

  private async flush(): Promise<void> {
    if (this.flushing || this.stopped || this.state.db === 'gone') return;
    if (!this.dirty.size && this.savedVer === this.ver) return;
    this.flushing = true;
    clearTimeout(this.retryTimer);
    const ver = this.ver;
    const alertsVer = this.alertsVer;
    const ops = [...this.dirty].slice(0, MAX_OPS);
    // Offline, Firestore neither resolves nor rejects a commit: it waits for signal and
    // sends it then. So "offline" is inferred from a commit that has not come back.
    const slow = setTimeout(() => this.emit({ db: 'offline' }), SLOW_MS);
    try {
      await savePointBatch(this.match.id, ops, this.patch(alertsVer !== this.savedAlertsVer));
      // Only what this commit carried, and only if nothing newer replaced it meanwhile.
      for (const [n, p] of ops) if (this.dirty.get(n) === p) this.dirty.delete(n);
      this.savedVer = ver;
      this.savedAlertsVer = alertsVer;
      this.retryMs = 0;
      saveUnsynced(this.match.id, this.dirty);
      this.emit({ db: 'ok' });
      void this.drainClips();
    } catch (e) {
      const code = (e as { code?: string })?.code;
      if (code === 'not-found') {
        // The coach deleted the match mid-charting. Retrying would never succeed.
        this.emit({ db: 'gone' });
        return;
      }
      this.emit({ db: code === 'permission-denied' ? 'denied' : 'failed' });
      this.retryMs = Math.min(30000, this.retryMs ? this.retryMs * 2 : 3000);
      this.retryTimer = setTimeout(() => void this.flush(), this.retryMs);
      return;
    } finally {
      clearTimeout(slow);
      this.flushing = false;
    }
    if (this.dirty.size || this.savedVer !== this.ver) void this.flush();
  }

  /**
   * Every row, every time, to the coach's sheet. The connector upserts by point number, so
   * a push that failed is simply covered by the next one, and the sheet can never be left
   * missing a batch. Fire and forget: the points are safe in Firestore whatever happens here.
   */
  private async pushSheet(): Promise<void> {
    const s = this.settings;
    if (this.stopped || !hasConnector(s) || !this.all.size) return;
    if (this.pushing) {
      this.pushAgain = true;
      return;
    }
    this.pushing = true;
    this.pushAgain = false;
    clearTimeout(this.sheetTimer);
    this.emit({ sheet: 'pushing' });
    const pts = this.sorted();
    const rows = plainCells(pointLogRows(pts, this.match.names));
    const removed = [...this.unsheet];
    try {
      const reply = await connectorPost(s.sheetsUrl!, s.sheetsToken!, 'pushPoints', {
        match: {
          id: this.match.id,
          title: fullTitle(this.match),
          ...(this.match.sheetId ? { sheetId: this.match.sheetId } : {}),
        },
        header: rows[0],
        rows: rows.slice(1),
        summary: plainCells(summaryRows(computeStats(pts), this.match.names)),
        removed,
      });
      removed.forEach((n) => !this.all.has(n) && this.unsheet.delete(n));
      this.emit({ sheet: 'ok', sheetError: undefined });
      // A match nobody made a sheet for gets one from the connector on its first push.
      if (reply.url && reply.sheetId && reply.sheetId !== this.match.sheetId) {
        this.match = { ...this.match, sheetUrl: reply.url, sheetId: reply.sheetId };
        linkSheet(this.match.id, reply.url, reply.sheetId).catch((e) =>
          console.warn('[gt] could not link the sheet to the match:', e)
        );
      }
    } catch (e) {
      this.emit({ sheet: 'failed', sheetError: (e as Error).message });
      // The next batch retries this. The last batch of a match has no next one.
      this.sheetTimer = setTimeout(() => void this.pushSheet(), 30000);
    } finally {
      this.pushing = false;
    }
    if (this.pushAgain) void this.pushSheet();
  }

  /** Clips are the coaching extra, not the record: three tries each, then let go. */
  private async drainClips() {
    if (this.clipBusy) return;
    this.clipBusy = true;
    while (this.clips.length && !this.stopped) {
      const clip = this.clips[0];
      try {
        await saveClip(this.match.id, clip, this.uid);
        this.clips.shift();
      } catch (e) {
        clip.tries += 1;
        if (clip.tries < 3) break; // again after the next point batch lands
        console.warn('[gt] clip not saved after three tries:', clip.id, e);
        this.clips.shift();
      }
    }
    this.clipBusy = false;
  }
}

/**
 * `window.__gtInit(...)` as a script. JSON is valid JS source, so it is spliced in as-is;
 * only `<` (which could close an inline script) and the two line separators JSON allows
 * but a script does not are rewritten, exactly as src/workflowBridge.ts does.
 */
export function initScript(payload: unknown): string {
  const json = JSON.stringify(payload)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
  return `try { window.__gtInit && window.__gtInit(${json}); } catch (e) { console.error(e); } true;`;
}
