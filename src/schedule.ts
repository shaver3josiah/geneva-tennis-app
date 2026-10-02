/**
 * The arithmetic behind "project it out": which dates one scheduling action writes,
 * and the clock label each of them gets.
 *
 * Pure, and kept out of src/data.ts on purpose, so it can be run by a plain node
 * script without pulling in the Firebase SDK. Getting this wrong is expensive in a way
 * that does not announce itself: a coach schedules twelve Tuesdays, and three of them
 * land on a Wednesday at midnight, and nobody notices until a family turns up on the
 * wrong day.
 */

import type { SessionType } from './theme';

/**
 * The dates a repeat writes, starting at `start` and stepping `everyWeeks` weeks,
 * `occurrences` times.
 *
 * `setDate` rather than adding 7 * 864e5 milliseconds. Adding milliseconds is wrong
 * twice a year: across a daylight-saving boundary it shifts a 4pm session to 3pm or
 * 5pm, and it keeps shifting for the rest of the run. setDate moves whole calendar
 * days, keeps the wall clock, and rolls months and years over by itself.
 */
export function projectDates(start: Date, occurrences: number, everyWeeks: number): Date[] {
  // `|| 1` because Math.max(1, NaN) is NaN: a blank count would write nothing and a
  // blank step would write Invalid Dates.
  const n = Math.max(1, Math.floor(occurrences) || 1);
  const step = Math.max(1, Math.floor(everyWeeks) || 1);
  const out: Date[] = [];
  for (let i = 0; i < n; i++) {
    const d = new Date(start);
    d.setDate(d.getDate() + i * step * 7);
    out.push(d);
  }
  return out;
}

/**
 * The time a calendar row prints. Stored on the event rather than derived, because
 * events written before the workout builder existed store it and a row must not show
 * a different time from the one above it. Rest and film days have no clock time.
 */
export const clockLabel = (d: Date, type: SessionType) =>
  type === 'rest' ? '' : d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

/** Run by scripts/check-schedule.mjs. Kept out of the module's own bottom so no
 *  argv branch ships inside the app bundle. */
export function demo(): string {
  const eq = (got: unknown, want: unknown, what: string) => {
    if (got !== want) throw new Error(`${what}: got ${String(got)}, wanted ${String(want)}`);
  };
  const ymd = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

  // A single session is the start date and nothing else.
  const once = projectDates(new Date(2026, 8, 15, 16, 0), 1, 1);
  eq(once.length, 1, 'one occurrence writes one date');
  eq(ymd(once[0]), '2026-09-15', 'the one date is the start');

  // A blank or garbled number from a form must not write nothing, or Invalid Dates.
  eq(projectDates(new Date(2026, 8, 15), NaN, 1).length, 1, 'a NaN count writes one session');
  eq(projectDates(new Date(2026, 8, 15), 3, NaN).map(ymd).join(' '), '2026-09-15 2026-09-22 2026-09-29', 'a NaN step repeats weekly');

  // Weekly, across a month boundary.
  const weekly = projectDates(new Date(2026, 8, 15, 16, 0), 4, 1);
  eq(weekly.map(ymd).join(' '), '2026-09-15 2026-09-22 2026-09-29 2026-10-06', 'weekly rolls the month over');

  // Every other week.
  const fortnight = projectDates(new Date(2026, 8, 15, 16, 0), 3, 2);
  eq(fortnight.map(ymd).join(' '), '2026-09-15 2026-09-29 2026-10-13', 'every 2 weeks steps 14 days');

  // Every occurrence is the same weekday as the start. This is the failure a coach
  // would actually notice, so it is pinned rather than assumed from the dates above.
  const dow = new Set(projectDates(new Date(2026, 8, 15, 16, 0), 12, 1).map((d) => d.getDay()));
  eq(dow.size, 1, 'every occurrence lands on the same weekday');

  // The daylight-saving trap. In the United States, clocks go back on 1 November
  // 2026. A 4pm session on 25 October must still be a 4pm session a week later; with
  // millisecond arithmetic it would be 3pm, and every session after it too.
  const overDst = projectDates(new Date(2026, 9, 25, 16, 0), 3, 1);
  eq(overDst.map(ymd).join(' '), '2026-10-25 2026-11-01 2026-11-08', 'dates step by whole days across DST');
  eq(
    overDst.every((d) => d.getHours() === 16 && d.getMinutes() === 0),
    true,
    'the wall clock survives the daylight-saving change'
  );

  // Nonsense input clamps rather than returning an empty run or looping backwards.
  eq(projectDates(new Date(2026, 8, 15), 0, 1).length, 1, 'zero occurrences still writes one');
  eq(projectDates(new Date(2026, 8, 15), -3, 1).length, 1, 'a negative count still writes one');
  eq(
    ymd(projectDates(new Date(2026, 8, 15), 2, 0)[1]),
    '2026-09-22',
    'a zero-week step falls back to weekly rather than stacking on one day'
  );

  // A rest day carries no clock time; everything else does.
  eq(clockLabel(new Date(2026, 8, 15, 16, 0), 'rest'), '', 'rest days have no clock label');
  if (!clockLabel(new Date(2026, 8, 15, 16, 0), 'skills')) {
    throw new Error('a skills session must carry a clock label');
  }

  return 'schedule.ts: all checks passed';
}
