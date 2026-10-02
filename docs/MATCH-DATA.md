# Match data: the contract between the tracker, the app and the spreadsheet

`src/tennis/index.d.ts` is the authoritative type file. This page is the prose around it:
where each piece lives, and the messages that move a point from the fence-mounted phone
to the coach's spreadsheet.

## Pieces

| Piece | Where | Runs in |
|---|---|---|
| Scoring, stats, trends, xlsx/csv writer, sheet layout | `src/tennis/*.js` (plain ES modules, no deps) | Hermes (app), any browser (inlined into the tracker), node (tests) |
| Match tracker (camera, pose, ball, physics, charting UI) | `tracker/*.js` + `tracker/shell.html`, built by `scripts/build-tracker.mjs` into `scripts/worksheets/match-tracker.html` | WebView in the app; also a standalone page/demo |
| Match screens, Firestore sync, export, email | `app/(tabs)/matches.tsx`, `app/match/*`, `src/matches.ts` | the app |
| Google Sheets connector | `sheets-connector/Code.gs` (Apps Script, pasted once by the coach) | the coach's Google account |

## Firestore

```
matches/{matchId}
  title, date ('YYYY-MM-DD'), kind ('singles' | 'doubles'), position (e.g. '#1 Singles')
  names: [ours, theirs]            // display names, index = PlayerIdx
  athleteId?: string               // our player's roster record, when charted for one
  opponentSchool?: string
  formatId, format: MatchFormat
  firstServer: 0 | 1, nearAtStart: 0 | 1
  status: 'live' | 'final'
  scoreLine: '6-4 3-2 30-15'       // denormalised for the list
  pointCount: number
  summary: { ... }                 // a small subset of MatchStats for the list rows
  sheetUrl?: string, sheetId?: string   // the linked Google Sheet
  createdBy: uid, createdAt, updatedAt, lastSyncAt
matches/{matchId}/points/{nnnn}    // PointRecord, id = n zero-padded to 4 ('0007')
matches/{matchId}/clips/{clipId}   // a trend's body-shape animation, as pose keyframes (no video)
  alertId, title, who, fps, frames: string (compact JSON), createdAt, createdBy
team/settings                      // coach-written, member-read
  sheetsUrl?: string, sheetsToken?: string, coachEmail?: string
```

Read: the coach and any roster member. Write points/matches: the coach and roster members
(the student charting the match is a member). Delete: the coach, or whoever created it.

## Sync cadence

The tracker batches. It posts a `gt:points` message **every 3 points and at the end of every
game, whichever comes first**, plus once on "End match". The host writes the batch in one
Firestore `writeBatch` and, when the team has a Google Sheets connector, pushes the same rows
to it. So the coach's spreadsheet is never more than 3 points (or one game) behind.

## Bridge messages (tracker page ⇄ app)

App → page, injected after load:

```js
window.__gtInit({
  mode: 'app',
  matchId, title, names: ['Ours', 'Theirs'], format, formatId,
  firstServer: 0, nearAtStart: 0,
  points: [/* PointRecord[] already saved, to resume */],
  syncEvery: 3,
})
```

Page → app, `window.ReactNativeWebView.postMessage(JSON.stringify(msg))`:

| `type` | Payload | Host does |
|---|---|---|
| `gt:ready` | — | inject `__gtInit` |
| `gt:points` | `{ points: PointRecord[], removed: number[], scoreLine, final: boolean, summary }` | batch-write points, delete `removed`, update match doc, push to Sheets |
| `gt:alert` | `{ alert: TrendAlert }` | store on the match (`alerts` array, capped at 60) |
| `gt:clip` | `{ clip: { id, alertId, title, who, fps, frames } }` | write `clips/{id}` (frames capped at 180 KB) |
| `gt:file` | `{ name, mime, base64 }` | write to cache, open the share sheet |
| `gt:email` | `{ subject, body, name?, mime?, base64? }` | open the mail composer with the attachment |
| `gt:close` | — | navigate back |

In a plain browser (no `ReactNativeWebView`) the page does all of this itself: it keeps the
match in `localStorage`, downloads files with a Blob link, opens `mailto:` for email, and
posts to the Google Sheets connector URL directly.

## Google Sheets connector protocol

`POST <web app URL>` with `Content-Type: text/plain;charset=utf-8` (no CORS preflight) and a
JSON body. Every request carries the `token` the coach set in the script.

| action | body | returns |
|---|---|---|
| `ping` | `{}` | `{ ok: true, owner }` |
| `createMatch` | `{ match: { id, title, date, names } }` | `{ ok: true, sheetId, url }` — a NEW spreadsheet in the coach's Drive, formatted |
| `pushPoints` | `{ match: { id, title, sheetId }, header: [...], rows: [[...]], summary: [[...]] }` | `{ ok: true, written, url }` — rows are upserted by point number |
