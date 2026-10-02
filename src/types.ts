import type { Timestamp } from 'firebase/firestore';

export type Role = 'coach' | 'parent' | 'player';

/**
 * Field names here are load-bearing: firebase/firestore.rules validates them by
 * name. Renaming a field on this side without renaming it in the rules turns a
 * security control into a no-op. Change both or neither.
 */

export interface Athlete {
  id: string;
  /**
   * '' until the invited person signs up and claims the slot. The coach sets the
   * matching *Email field; the rules let exactly one verified account with that
   * address write its own uid here, exactly once.
   */
  guardianUid: string;
  playerUid: string;
  /** Who the coach invited. Claiming requires a VERIFIED account at this address. */
  guardianEmail?: string;
  playerEmail?: string;
  /** Absent OR null both mean "no consent". Only the guardian can write it. */
  consentGrantedAt?: Timestamp | null;
  playerName: string;
  guardianName: string;
  age?: number;
  joinedAt?: Timestamp;
  /**
   * An adult player (a college athlete, 18+): invited with no guardian, so both slots
   * carry the player's own name and address and, once claimed, the same uid. They manage
   * their own consent. Optional, because every record written before it existed is a
   * minor with a guardian and must keep reading as one. See isAdult() in src/data.ts.
   */
  adult?: boolean;
}

/**
 * A /coaches/{uid} document. Its existence IS the coach role: firestore.rules checks it
 * with exists(), and nothing in this bundle can grant it. Created once, by claimCoach in
 * src/data.ts, with the team's coach code.
 */
export interface Coach {
  /** The Auth uid, which is also the document id. */
  id: string;
  name: string;
  email: string;
  createdAt: Timestamp | null;
}

export interface Thread {
  id: string;
  athleteId: string;
  /** Who may post. */
  participants: string[];
  /** Who may read. Superset of participants — the guardian sits here on the
   *  coach<->player thread, which is the monitoring guarantee. */
  readers: string[];
  kind: 'coach-player' | 'coach-parent';
  title: string;
}

export interface Message {
  id: string;
  senderUid: string;
  text: string;
  /** serverTimestamp() on write; the rule requires createdAt == request.time. */
  createdAt: Timestamp | null;
}

export interface SessionEvent {
  id: string;
  /**
   * The athlete this session is primarily about, and always athleteIds[0].
   *
   * Kept even now that a coached session is one shared document, because the read
   * rule's athleteId branch resolves through a get() at READ time: a family that
   * signs up AFTER a session was scheduled can still see it, which a denormalised
   * memberUids snapshot cannot do on its own.
   */
  athleteId: string;
  /** Every athlete on the session. One entry for individual work, up to eight for a
   *  coached one (the ceiling the rules unroll to). */
  athleteIds?: string[];
  /**
   * Every uid allowed to read it: each athlete's guardian, and the athlete too where
   * they have a login. Denormalised so that deciding a read costs no document gets,
   * which is the whole reason a coached session can be one row instead of one per
   * athlete. The coach writes it and the rules check it against the athlete records,
   * because he is the monitored party and does not get to choose his own audience.
   */
  memberUids?: string[];
  /** The primary category, and always typesOf()[0]. Kept as the single source the
   *  calendar tints a day with, and the field firebase/firestore.rules already knew. */
  type: import('./theme').SessionType;
  /** Every category the session covers, when it covers more than one. Absent on
   *  anything written before multi-select, which is why nothing reads it directly:
   *  go through typesOf() in theme.ts. */
  types?: import('./theme').SessionType[];
  name: string;
  location: string;
  startsAt: Timestamp;
  /** Rendered struck-through at 40% opacity, plus the word "Canceled". */
  canceled?: boolean;
  /** Empty for rest/film days, which have no clock time. */
  timeLabel?: string;

  // Everything below is OPTIONAL on purpose. Events written before the workout
  // builder existed carry none of it and must keep rendering exactly as they did.

  /** Individual work or a coached session. A coached session is fanned out to one
   *  event per athlete, so this is per-athlete even when the session is shared. */
  kind?: WorkoutKind;
  /** A COPY of the template blocks taken at scheduling time, not a reference.
   *  Editing a template must not silently rewrite what a family was told to do
   *  three weeks ago, and reading it here costs no second document. */
  blocks?: WorkoutBlock[];
  durationMin?: number;
  notes?: string;
  /** Provenance only. Nothing reads through it. */
  templateId?: string;
  /** Shared by every athlete copy of one coached session. */
  groupId?: string;
  /** Shared by every occurrence projected out of one scheduling action, so the
   *  whole run can be moved or cancelled together. */
  seriesId?: string;
}

export interface Workflow {
  id: string;
  name: string;
  html: string;
  publishedBy: string;
  publishedAt: Timestamp | null;
  sizeBytes: number;
  /**
   * How often the athlete fills this in. Absent means 'once', so every workflow
   * published before cadences existed keeps its single saved document.
   * The agreement asks for a weekly game evaluation, a quarterly report and a
   * per-session journal — each needs its own submission, not an overwrite.
   */
  cadence?: import('./period').Cadence;
}

/**
 * One submission: the athlete's answers, never a second copy of the coach's HTML.
 * Document id is `{workflowId}` for a one-off and `{workflowId}__{periodKey}` for a
 * repeating one — see src/period.ts.
 */
export interface SavedWorkflow {
  answers: Record<string, string | boolean | number>;
  updatedAt: Timestamp | null;
  /** Denormalised from the document id so a submission can be listed without parsing it. */
  workflowId?: string;
  /** '' for a one-off. '2026-W36', '2026-Q3', '2026-09-05' otherwise. */
  periodKey?: string;
}

/**
 * Private per-user preferences. Lives under the owner's own uid so the mute list
 * is structurally unreachable by anyone else — a player cannot clear a mute his
 * guardian set, because it is not in a document he can write.
 */
export interface UserPrefs {
  mutedThreads: string[];
  displayName?: string;
  /** A key from CHAT_COLORS in theme.ts. Paints this account's own message bubbles. */
  chatColor?: string;
  /** Streaks, workout count and the celebration picked. See src/rewards.ts — the
   *  shape is its RewardState, optional here because every field has a default and a
   *  document written before any of this existed must keep loading. */
  streak?: number;
  bestStreak?: number;
  lastDay?: string;
  workouts?: number;
  doneEvents?: string[];
  celebration?: string;
  /** Streak reminders. Absent means on, so an account that predates them gets them. */
  remind?: boolean;
}

// --- workouts ---------------------------------------------------------------

/**
 * One line in a workout: what to do and for how long. Deliberately not a drill
 * library. The coach types what they want and moves on; a catalogue of canonical drills
 * is a second product and nobody has asked for it.
 */
export interface WorkoutBlock {
  /** Local id. Stable across a reorder so React keys and drag state survive it. */
  id: string;
  name: string;
  minutes: number;
  /** How many of it, when the block is counted rather than timed. */
  reps?: number;
  /**
   * Which of the two the block is measured in. ABSENT MEANS 'time': every block
   * written before reps existed carries only `minutes`, and reading absence as time
   * is what keeps those templates running their clock. A new block starts on 'reps',
   * which is what a coach writes most of.
   */
  measure?: 'reps' | 'time';
  notes?: string;
}

/**
 * One finished session, under /athletes/{aid}/workoutLog/{eventId}.
 *
 * Field names are load-bearing: firebase/firestore.rules validates them by name.
 */
export interface WorkoutLogEntry {
  /** The document id, which is also the event id. */
  id: string;
  eventId: string;
  name: string;
  /** serverTimestamp() on write; the rule requires completedAt == request.time. */
  completedAt: Timestamp | null;
  /** Minutes the athlete actually ran the built-in timer for. */
  minutes: number;
  blocksDone: number;
  blocksTotal: number;
}

/** Who the workout is for. Drives fan-out: a coached session writes one event per
 *  athlete, an individual one writes a single event. */
export type WorkoutKind = 'individual' | 'coached';

/**
 * A reusable workout the coach builds once in the Workout Builder and schedules
 * many times. Coach-only, both directions, in firebase/firestore.rules.
 */
export interface WorkoutTemplate {
  id: string;
  name: string;
  /** The primary category. See SessionEvent.type: same field, same reasons. */
  type: import('./theme').SessionType;
  /** Every category, when the workout covers more than one. Read it through
   *  typesOf() in theme.ts so a template written before multi-select still renders. */
  types?: import('./theme').SessionType[];
  kind: WorkoutKind;
  blocks: WorkoutBlock[];
  /** Denormalised sum of the TIMED blocks so a list can show it without adding up.
   *  A workout of nothing but reps sums to zero, so a list row shows the block count
   *  instead of a misleading "0 min". */
  totalMinutes: number;
  updatedAt: Timestamp | null;
}

// --- matches ----------------------------------------------------------------

/**
 * One charted match, at /matches/{id}. docs/MATCH-DATA.md is the contract and
 * src/tennis/index.d.ts the shape of everything inside it: the tracker page, the Google
 * Sheets connector and firebase/firestore.rules all read these fields by name.
 * Wherever a pair appears, index 0 is OUR player.
 */
export interface Match {
  id: string;
  /** 'Geneva vs Westminster'. The position is its own field so a list can sort by it. */
  title: string;
  /** 'YYYY-MM-DD', the local day it was played. */
  date: string;
  kind: 'singles' | 'doubles';
  /** '#1 Singles', '#3 Doubles'. */
  position: string;
  names: [string, string];
  /** Our player's roster record, when the match was charted for one. */
  athleteId?: string;
  opponentSchool?: string;
  formatId: import('./tennis').FormatPreset['id'];
  format: import('./tennis').MatchFormat;
  firstServer: import('./tennis').PlayerIdx;
  /** Which player starts on the camera end. */
  nearAtStart: import('./tennis').PlayerIdx;
  status: 'live' | 'final';
  /** '6-4 3-2 30-15', written by the tracker with every batch. */
  scoreLine: string;
  pointCount: number;
  /** A few numbers per player for the list, recomputed from every point on each sync. */
  summary?: [MatchSummaryLine, MatchSummaryLine];
  /** The newest 60 the tracker raised. */
  alerts?: import('./tennis').TrendAlert[];
  sheetUrl?: string;
  sheetId?: string;
  createdBy: string;
  createdAt: Timestamp | null;
  updatedAt: Timestamp | null;
  /** Set only by the live tracker, which is what makes it the honest "is anyone charting
   *  this right now" signal. updatedAt also moves when the coach marks a match final. */
  lastSyncAt?: Timestamp | null;
}

export interface MatchSummaryLine {
  /** First serves in, as a whole percent. Null until the player has served. */
  fsPct: number | null;
  winners: number;
  ue: number;
  aces: number;
  dfs: number;
}

/** A trend's body-shape animation, at /matches/{id}/clips/{clipId}. Pose keyframes, no video. */
export interface MatchClip {
  id: string;
  alertId: string;
  title: string;
  who: import('./tennis').PlayerIdx;
  fps: number;
  /** JSON: { w, h, fps, frames: Array<Array<[x, y, visibility]>> }, 33 landmarks, 0..1. */
  frames: string;
  createdAt: Timestamp | null;
  createdBy: string;
}

/** /team/settings: the coach writes it, every roster member reads it. */
export interface TeamSettings {
  /** The Apps Script web app URL, ending in /exec. */
  sheetsUrl?: string;
  sheetsToken?: string;
  /** Where a student's "Email stats" is addressed. */
  coachEmail?: string;
}
