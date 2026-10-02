/**
 * Streaks, workout counts, and the celebration animations they unlock.
 *
 * Pure on purpose: no Firebase, no React, no clock of its own. Everything takes the
 * current state and a Date and hands back the patch to write, or null when there is
 * nothing to write — which is what keeps opening the app forty times in one day from
 * being forty document writes.
 *
 * The state lives in the account's OWN /users/{uid} document, next to the mute list.
 * Nobody else can read it and nothing else reads through it, so it is a scoreboard an
 * player keeps on themselves. That is also why the numbers are not defended against a
 * determined owner: the only person a lie here reaches is the liar.
 */

export interface RewardState {
  /** Consecutive days the app was opened, counted in the phone's own timezone. */
  streak: number;
  bestStreak: number;
  /** 'YYYY-MM-DD' of the last day this account opened the app. */
  lastDay: string;
  /** Workouts finished on the built-in timer. Nothing else increments it. */
  workouts: number;
  /** Ids of the sessions already counted, so finishing one twice pays once. */
  doneEvents: string[];
  /** The celebration the athlete picked. Unknown or locked falls back to `spark`. */
  celebration: string;
}

export const EMPTY: RewardState = {
  streak: 0,
  bestStreak: 0,
  lastDay: '',
  workouts: 0,
  doneEvents: [],
  celebration: 'spark',
};

/** Whatever the document holds, filled out to a complete state. */
export function readState(prefs: Partial<RewardState> | undefined | null): RewardState {
  return {
    streak: prefs?.streak ?? 0,
    bestStreak: prefs?.bestStreak ?? 0,
    lastDay: prefs?.lastDay ?? '',
    workouts: prefs?.workouts ?? 0,
    doneEvents: prefs?.doneEvents ?? [],
    celebration: prefs?.celebration ?? 'spark',
  };
}

/**
 * The local calendar day. Deliberately not an ISO timestamp: a streak is about the
 * day the athlete lived, so 11pm Tuesday and 1am Wednesday are two days even though
 * they are two hours apart, and a flight across a timezone does not erase a streak.
 */
export const dayKey = (d: Date): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** Whole calendar days back, via setDate — subtracting 864e5 ms breaks across a
 *  daylight-saving change and would silently drop a day off every streak that spans one. */
function daysBefore(d: Date, n: number): Date {
  const out = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  out.setDate(out.getDate() - n);
  return out;
}

/** How many days ago that key was, or -1 if it is not a day this side of sanity. */
export function daysSince(lastDay: string, now: Date): number {
  if (!lastDay) return -1;
  for (let i = 0; i <= 2; i++) if (dayKey(daysBefore(now, i)) === lastDay) return i;
  return -1;
}

/**
 * Called once when the app opens. Returns the patch to save, or null on a day this
 * account has already been counted for.
 */
export function visit(state: RewardState, now: Date): Partial<RewardState> | null {
  const today = dayKey(now);
  if (state.lastDay === today) return null;
  // Flown west across the date line: the last open is dated tomorrow (up to two days
  // ahead, +14 to -12) here. That day is already counted; writing today over it would
  // reset the run and move lastDay backwards. Bounded, so a clock set years ahead by
  // mistake cannot freeze a streak.
  if ([1, 2].some((n) => dayKey(daysBefore(now, -n)) === state.lastDay)) return null;
  // Yesterday continues the run. Anything older starts a new one at 1, because a
  // streak that survives a gap is not a streak.
  const streak = daysSince(state.lastDay, now) === 1 ? state.streak + 1 : 1;
  return { streak, bestStreak: Math.max(streak, state.bestStreak), lastDay: today };
}

/** The most doneEvents ids kept. The rule caps the list; this keeps it under the cap. */
export const DONE_CAP = 60;

/**
 * Called when a workout is finished on the timer. Returns null if this session has
 * already paid out, which is what a second tap on Finish, or reopening a session
 * tomorrow, both look like.
 */
export function finishWorkout(state: RewardState, eventId: string): Partial<RewardState> | null {
  if (!eventId || state.doneEvents.includes(eventId)) return null;
  return {
    workouts: state.workouts + 1,
    doneEvents: [...state.doneEvents, eventId].slice(-DONE_CAP),
  };
}

/** A local reminder, planned here so the scheduling rules can be checked offline. */
export interface Reminder {
  /** Stable key, so a plan can be compared without comparing prose. */
  kind: 'keep' | 'broken' | 'start';
  title: string;
  body: string;
  at: Date;
}

/** Evening, when a player can still get on court. */
export const NUDGE_HOUR = 18;
/** Morning after, when the streak is already gone and the point is to start again. */
export const BROKEN_HOUR = 10;

const at = (base: Date, addDays: number, hour: number): Date => {
  const d = new Date(base.getFullYear(), base.getMonth(), base.getDate(), hour, 0, 0, 0);
  d.setDate(d.getDate() + addDays); // whole calendar days, so a DST change cannot shift it
  return d;
};

/**
 * What to put on the phone's clock, given the streak as it stands after today's visit.
 *
 * Two notifications, both local, both re-planned from scratch every time the app is
 * opened. That is what makes them accurate without a server: opening the app tomorrow
 * cancels tomorrow's reminder and plans the day after, so the only way one fires is if
 * the athlete genuinely did not come back.
 *
 * The evening one is a warning while the day can still be saved. The morning one is the
 * one the ask was for: the streak is broken, here is what it was, start another.
 */
export function reminderPlan(state: RewardState, now: Date): Reminder[] {
  const n = state.streak;
  if (n < 1) {
    return [
      {
        kind: 'start',
        title: 'No streak yet',
        body: 'One session starts it. Open the app when you have trained today.',
        at: at(now, 1, NUDGE_HOUR),
      },
    ];
  }
  return [
    {
      kind: 'keep',
      title: `Day ${n} is on the line`,
      body: `Your ${n} day streak ends at midnight. Get a workout in and log it.`,
      at: at(now, 1, NUDGE_HOUR),
    },
    {
      kind: 'broken',
      title: `Your ${n} day streak ended`,
      body:
        n >= 7
          ? `${n} days is a real run. Train today and start the next one.`
          : 'It happens. Train today and day one starts again.',
      at: at(now, 2, BROKEN_HOUR),
    },
  ];
}

export interface Celebration {
  id: string;
  label: string;
  /** What it looks like, in the athlete's language, on the picker. */
  blurb: string;
  /** Unlocked when EITHER bar is cleared. A player who trains hard and a player who
   *  shows up daily both get somewhere; neither route is a dead end. */
  needWorkouts?: number;
  needStreak?: number;
}

/** Ordered easiest to hardest. The first one is free and is the fallback. */
export const CELEBRATIONS: Celebration[] = [
  { id: 'spark', label: 'Spark', blurb: 'A clean gold burst. Yours from day one.' },
  { id: 'ace', label: 'Ace', blurb: 'Optic yellow rips past the returner.', needWorkouts: 3, needStreak: 3 },
  { id: 'onfire', label: 'On Fire', blurb: 'The screen catches fire.', needWorkouts: 6, needStreak: 5 },
  { id: 'smash', label: 'Smash', blurb: 'An overhead that shakes the court.', needWorkouts: 12, needStreak: 10 },
  { id: 'bolt', label: 'Lightning', blurb: 'Bolts, and the lights cut out.', needWorkouts: 20, needStreak: 14 },
  { id: 'nova', label: 'Supernova', blurb: 'Everything goes white. Earned, not given.', needWorkouts: 35, needStreak: 30 },
];

export function isUnlocked(c: Celebration, state: RewardState): boolean {
  if (c.needWorkouts === undefined && c.needStreak === undefined) return true;
  return (
    (c.needWorkouts !== undefined && state.workouts >= c.needWorkouts) ||
    (c.needStreak !== undefined && state.bestStreak >= c.needStreak)
  );
}

/** The chosen celebration, or `spark` when the choice is unknown or not unlocked yet. */
export function activeCelebration(state: RewardState): string {
  const c = CELEBRATIONS.find((x) => x.id === state.celebration);
  return c && isUnlocked(c, state) ? c.id : 'spark';
}

/** The next thing to chase, in one line, or null when everything is unlocked. */
export function nextUp(state: RewardState): { celebration: Celebration; hint: string } | null {
  const c = CELEBRATIONS.find((x) => !isUnlocked(x, state));
  if (!c) return null;
  const parts: string[] = [];
  if (c.needWorkouts !== undefined) {
    const n = c.needWorkouts - state.workouts;
    parts.push(`${n} more workout${n === 1 ? '' : 's'}`);
  }
  if (c.needStreak !== undefined) parts.push(`a ${c.needStreak} day streak`);
  return { celebration: c, hint: parts.join(' or ') };
}

/**
 * Self-check. Run it with `npm run test:rewards`.
 *
 * The one failure that never announces itself is the streak arithmetic across a
 * daylight-saving change, so that is pinned first.
 */
export function demo(): string {
  const eq = (got: unknown, want: unknown, what: string) => {
    const g = JSON.stringify(got);
    const w = JSON.stringify(want);
    if (g !== w) throw new Error(`${what}: got ${g}, wanted ${w}`);
  };

  const at = (y: number, m: number, d: number, h = 9) => new Date(y, m - 1, d, h);
  const ymdh = (d: Date) => `${dayKey(d)} ${String(d.getHours()).padStart(2, '0')}`;
  const state = (p: Partial<RewardState>): RewardState => ({ ...EMPTY, ...p });

  // First ever open.
  eq(visit(EMPTY, at(2026, 9, 15)), { streak: 1, bestStreak: 1, lastDay: '2026-09-15' }, 'first open starts at 1');

  // Same day, any number of times, writes nothing.
  eq(visit(state({ streak: 1, lastDay: '2026-09-15' }), at(2026, 9, 15, 23)), null, 'a second open the same day is not a write');

  // Consecutive days.
  eq(
    visit(state({ streak: 4, bestStreak: 4, lastDay: '2026-09-14' }), at(2026, 9, 15)),
    { streak: 5, bestStreak: 5, lastDay: '2026-09-15' },
    'yesterday continues the run'
  );

  // A gap resets to 1 and leaves the record standing.
  eq(
    visit(state({ streak: 9, bestStreak: 9, lastDay: '2026-09-12' }), at(2026, 9, 15)),
    { streak: 1, bestStreak: 9, lastDay: '2026-09-15' },
    'a missed day restarts the streak but keeps the best'
  );

  // Daylight saving. US clocks go back on 1 November 2026. Opening at 9am on the 1st,
  // the day before is 31 October — and with millisecond arithmetic it would come out
  // as the 31st at 10am, which is a different day only by luck of the hour chosen.
  eq(
    visit(state({ streak: 3, bestStreak: 3, lastDay: '2026-10-31' }), at(2026, 11, 1, 9)),
    { streak: 4, bestStreak: 4, lastDay: '2026-11-01' },
    'a streak survives the daylight-saving change'
  );
  eq(daysSince('2026-10-31', new Date(2026, 10, 1, 0, 30)), 1, 'just past midnight is still one day back');

  // Westward across the date line: opened Wednesday in Tokyo, now it is Tuesday in
  // Los Angeles. Tuesday is not a new day, and Wednesday here continues the run.
  const flown = state({ streak: 9, bestStreak: 9, lastDay: '2026-09-30' });
  eq(visit(flown, at(2026, 9, 29, 20)), null, 'flying west over the date line keeps the streak');
  eq(visit(flown, at(2026, 9, 30, 9)), null, 'and the day it was opened is still counted once');
  eq(visit(flown, at(2026, 10, 1)), { streak: 10, bestStreak: 10, lastDay: '2026-10-01' }, 'and the next day continues it');
  eq(
    visit(state({ streak: 9, bestStreak: 9, lastDay: '2027-09-30' }), at(2026, 9, 29)),
    { streak: 1, bestStreak: 9, lastDay: '2026-09-29' },
    'a clock set a year ahead by mistake does not freeze the streak'
  );

  // Workouts pay once each.
  const one = finishWorkout(EMPTY, 'ev1');
  eq(one, { workouts: 1, doneEvents: ['ev1'] }, 'finishing a workout counts it');
  eq(finishWorkout(state(one as RewardState), 'ev1'), null, 'the same session never pays twice');
  eq(finishWorkout(EMPTY, ''), null, 'a session with no id pays nothing');

  // The done list stays under the rule's cap however long the athlete trains.
  let long = state({ workouts: 0, doneEvents: [] });
  for (let i = 0; i < DONE_CAP + 20; i++) long = { ...long, ...finishWorkout(long, `e${i}`)! };
  eq(long.doneEvents.length, DONE_CAP, 'the done list is capped');
  eq(long.workouts, DONE_CAP + 20, 'the count keeps going after the list stops growing');

  // Unlocks: either bar clears it.
  const ace = CELEBRATIONS[1];
  eq(isUnlocked(ace, state({ workouts: 3 })), true, 'three workouts unlocks Ace');
  eq(isUnlocked(ace, state({ bestStreak: 3 })), true, 'a three day streak unlocks Ace too');
  eq(isUnlocked(ace, state({ workouts: 2, bestStreak: 2 })), false, 'two of each unlocks nothing');
  eq(isUnlocked(CELEBRATIONS[0], EMPTY), true, 'the first one is free');

  // A locked pick never plays. Someone who edits their own document down to nothing
  // must not keep an animation they no longer have.
  eq(activeCelebration(state({ celebration: 'nova' })), 'spark', 'a locked choice falls back');
  eq(activeCelebration(state({ celebration: 'zzz', workouts: 99 })), 'spark', 'an unknown choice falls back');
  eq(activeCelebration(state({ celebration: 'ace', workouts: 3 })), 'ace', 'an unlocked choice plays');

  eq(nextUp(state({ workouts: 99, bestStreak: 99 })), null, 'nothing left to chase');
  if (!nextUp(EMPTY)?.hint.includes('3 more workouts')) throw new Error('the hint should name the shortfall');

  // Reminders. The evening warning lands tomorrow, the broken-streak notice the
  // morning after that, and both are re-planned on every open.
  const now = at(2026, 9, 15, 9);
  const alive = reminderPlan(state({ streak: 5, lastDay: '2026-09-15' }), now);
  eq(alive.map((r) => r.kind), ['keep', 'broken'], 'a live streak gets a warning and a wake');
  eq(ymdh(alive[0].at), '2026-09-16 18', 'the warning lands tomorrow evening');
  eq(ymdh(alive[1].at), '2026-09-17 10', 'the broken notice lands the morning after that');
  if (!alive[0].body.includes('5 day')) throw new Error('the warning should name the streak');
  if (!alive[1].title.includes('5 day')) throw new Error('the broken notice should name what was lost');

  eq(reminderPlan(EMPTY, now).map((r) => r.kind), ['start'], 'with no streak there is nothing to lose yet');

  // Same daylight-saving trap as the streak itself: these are wall-clock times on a
  // calendar day, so 6pm must stay 6pm across the change, not become 5pm.
  const overDst = reminderPlan(state({ streak: 2 }), at(2026, 10, 31, 9));
  eq(ymdh(overDst[0].at), '2026-11-01 18', 'the evening reminder survives the clock change');
  eq(ymdh(overDst[1].at), '2026-11-02 10', 'and so does the morning one');

  return 'rewards.ts: all checks passed';
}
