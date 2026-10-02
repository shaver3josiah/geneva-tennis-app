/**
 * Which submission is this?
 *
 * `athletes/{id}/savedWorkflows/{wfId}` holds one document per workflow, so a second
 * save overwrites the first. That is right for the 4-Week Guard Development plan — you
 * tick its boxes over a month and there is one of them — and wrong for everything the
 * signed agreement asks for on a cadence:
 *
 *   "I agree to fill out my weekly 'game evaluations'..."
 *   "I agree to fill out my quarterly reports..."
 *   "I agree to bring my journal to EVERY session to document my progress"
 *
 * A weekly evaluation that overwrites last week's destroys the record it exists to
 * create. So a repeating workflow saves under `{wfId}__{periodKey}` and a one-off keeps
 * saving under `{wfId}` exactly as before — existing submissions are untouched.
 *
 * The period is derived from the date rather than counted, so two devices, or one device
 * that was offline, land on the same document instead of racing to create two.
 */

export type Cadence = 'once' | 'daily' | 'weekly' | 'quarterly';

const pad = (n: number) => String(n).padStart(2, '0');

/**
 * ISO-8601 week. Weeks start Monday and belong to the year containing their Thursday,
 * which is why this is not simply "day of year over seven" — the first days of January
 * often belong to the previous year's last week, and getting that wrong would file two
 * consecutive Sunday and Monday evaluations under different years.
 */
function isoWeek(d: Date): { year: number; week: number } {
  // Copy: this walks the date forward and must not mutate the caller's.
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  // Thursday of this week decides the year.
  t.setUTCDate(t.getUTCDate() + 4 - (t.getUTCDay() || 7));
  const year = t.getUTCFullYear();
  const jan1 = new Date(Date.UTC(year, 0, 1));
  const week = Math.ceil(((t.getTime() - jan1.getTime()) / 86400000 + 1) / 7);
  return { year, week };
}

/** The period a date falls in, for a given cadence. Empty string for 'once'. */
export function periodKey(cadence: Cadence, date: Date): string {
  switch (cadence) {
    case 'once':
      return '';
    case 'daily':
      return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
    case 'weekly': {
      const { year, week } = isoWeek(date);
      return `${year}-W${pad(week)}`;
    }
    case 'quarterly':
      return `${date.getFullYear()}-Q${Math.floor(date.getMonth() / 3) + 1}`;
  }
}

/**
 * The document id a submission saves to. A one-off keeps the bare workflow id, so
 * everything saved before cadences existed still resolves.
 */
export function submissionId(workflowId: string, cadence: Cadence, date: Date): string {
  const key = periodKey(cadence, date);
  return key ? `${workflowId}__${key}` : workflowId;
}

/** Split a submission id back into its parts. */
export function parseSubmissionId(id: string): { workflowId: string; periodKey: string } {
  const i = id.indexOf('__');
  return i === -1
    ? { workflowId: id, periodKey: '' }
    : { workflowId: id.slice(0, i), periodKey: id.slice(i + 2) };
}

/** How a period reads in the UI. "Week of 1 Sep", not "2026-W36". */
export function periodLabel(cadence: Cadence, key: string): string {
  if (!key) return '';
  if (cadence === 'quarterly') return key.replace('-Q', ' · Q');
  if (cadence === 'weekly') {
    const [year, w] = key.split('-W');
    return `Week ${Number(w)}, ${year}`;
  }
  const d = new Date(`${key}T00:00:00`);
  return Number.isNaN(d.getTime())
    ? key
    : d.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
}

/** Run directly to check the edge cases that would silently merge two submissions. */
export function demo() {
  const eq = (a: unknown, b: unknown, why: string) => {
    if (a !== b) throw new Error(`${why}: got ${String(a)}, expected ${String(b)}`);
  };

  eq(periodKey('once', new Date(2026, 8, 5)), '', 'a one-off has no period');
  eq(periodKey('daily', new Date(2026, 8, 5)), '2026-09-05', 'daily is the calendar date');
  eq(periodKey('quarterly', new Date(2026, 0, 1)), '2026-Q1', 'January is Q1');
  eq(periodKey('quarterly', new Date(2026, 8, 5)), '2026-Q3', 'September is Q3');
  eq(periodKey('quarterly', new Date(2026, 11, 31)), '2026-Q4', 'December is Q4');

  // The whole reason isoWeek is not arithmetic on the day of the year.
  eq(periodKey('weekly', new Date(2027, 0, 1)), '2026-W53', '1 Jan 2027 is a Friday, in 2026 week 53');
  eq(periodKey('weekly', new Date(2026, 0, 1)), '2026-W01', '1 Jan 2026 is a Thursday, so week 1');

  // Sunday and the Monday after it are DIFFERENT weeks. If this ever passes as equal,
  // a Sunday game evaluation silently overwrites the previous week's.
  const sun = periodKey('weekly', new Date(2026, 8, 6));
  const mon = periodKey('weekly', new Date(2026, 8, 7));
  if (sun === mon) throw new Error('Sunday and Monday must not share a week key');
  eq(sun, '2026-W36', 'Sun 6 Sep 2026 closes week 36');
  eq(mon, '2026-W37', 'Mon 7 Sep 2026 opens week 37');

  eq(submissionId('w1', 'once', new Date(2026, 8, 5)), 'w1', 'a one-off keeps its bare id');
  eq(submissionId('w4', 'weekly', new Date(2026, 8, 5)), 'w4__2026-W36', 'repeats are suffixed');

  const round = parseSubmissionId(submissionId('w4', 'weekly', new Date(2026, 8, 5)));
  eq(round.workflowId, 'w4', 'round-trips the workflow id');
  eq(round.periodKey, '2026-W36', 'round-trips the period');
  eq(parseSubmissionId('w1').workflowId, 'w1', 'a bare id parses as a one-off');

  return 'period.ts: all checks passed';
}
