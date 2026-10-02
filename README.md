# Geneva Tennis — the team app for Geneva College tennis

Messages, the practice calendar, workout worksheets and a match tracker with live stats for
the Geneva College (Beaver Falls, PA) men's and women's tennis teams. One React Native
codebase produces the iOS build and the Android `.apk`, and both talk to the same Firebase
project — so a message typed on an iPhone lands on an Android phone, and the other way
round, with no bridge code in between.

Players are college athletes, so almost everyone is an adult who manages their own account
and consent. The original parent-monitoring model for a player under 18 is still here, intact,
for the rare first-year who is one.

## The match tracker

A phone on the back fence (arm's reach above head height, ~3 m behind the baseline, 0.5x lens,
landscape) follows both players and the ball. It keeps the score in college format, measures
ball pace, net clearance, topspin, racket speed and depth, and reads body shape (legs, load,
trunk turn). It raises trend alerts with body-shape clips. The coach's sheet updates every 3
points or at the end of each game, with Excel, CSV and Google Sheets export. A student can
email the file from their own account.

- How to set it up and use it: [docs/START-HERE.md](docs/START-HERE.md)
- What it measures, how, and the research behind it: [docs/RESEARCH.md](docs/RESEARCH.md)
- The data contract between the tracker, the app and the sheet: [docs/MATCH-DATA.md](docs/MATCH-DATA.md)
- The tracker page itself opens in any browser: .
  Use **Watch the demo match** to run the whole pipeline on a simulated match.

---

## The roles

| Role | Sees | Can do |
|---|---|---|
| **Coach** (head coach, assistant) | every thread, the roster's calendar, the Locker | message, schedule, publish HTML workflows, run the match tracker |
| **Player** (18+) | their own thread with the coach, their calendar, the Locker | message the coach, save workflows, track matches — they manage their own consent |
| **Parent** (only for a player under 18) | their own thread with the coach **and** the full coach↔player thread | message the coach, grant or revoke consent, mute notifications |

**There is no coach account in the code.** A coach is whoever has a `/coaches/{uid}`
document, and the only way to write one is the team's coach code: sign up, confirm your email,
and on the *Nearly there* screen choose **I'm a coach**. The owner sets the code once with
`npm run set-coach-code -- "<a long random code>"`; only its SHA-256 is stored. See
[docs/START-HERE.md](docs/START-HERE.md).

Two guarantees hold the product together, and both are enforced by
[Firestore Security Rules](firebase/firestore.rules) rather than by the UI:

1. **Consent gate.** A player under 18 has a read-only thread until their guardian grants
   consent. Revoking it re-locks the thread immediately without deleting anything. A player
   invited with no guardian (18+) is their own guardian: both slots on the record hold their
   uid, and they grant their own consent on first sign-in.
2. **Parent monitoring.** For a player under 18, the guardian's uid is on the coach↔player
   thread's `readers` array from creation and cannot be removed — threads are immutable, and
   messages can never be edited or deleted by anyone, the coach included. The player is *told*
   this in a visible banner. Silent surveillance of a minor is both an ethics problem and an
   App Review problem.

The UI mirrors those rules; it does not implement them. A modified client gets the same
answer, because the check runs on Google's servers.

---

## Run it locally

Needs Node 22.13+ (Expo SDK 57's floor) and, for the Firebase emulator, **JDK 21+**
(current `firebase-tools` refuses to start on Java 17).

```bash
npm install
```

Copy the env file:

```bash
cp .env.example .env
```

Terminal 1 — the local Firebase emulator:

```bash
npm run emulators
```

Terminal 2 — load the demo data (once per emulator start):

```bash
npm run seed
```

Terminal 3 — the app:

```bash
npm start
```

Press `i` for the iOS simulator, `a` for Android, or `w` for the browser. The seed
script prints the four demo logins: a coach, a college player, and a parent with a minor.

**Consent starts OFF for the minor on purpose.** Sign in as the teen and the composer is
locked. Sign in as the parent, flip *Training consent* on the You tab, and the teen's
composer unlocks — live, without either client restarting. The college player has no parent
and is already consented. To try the coach claim, sign up a new account, confirm it, and
claim coach access with the demo code `GENEVA-DEMO`.

### Two sessions at once, for testing

Firebase Auth keeps its session per ORIGIN, so two tabs on the same port are one login —
signing in as the coach in one signs you in as the coach in both. Two ports are two
origins, and therefore two independent sessions.

Terminal 1 — the coach:

```bash
npm run web:coach
```

Terminal 2 — the parent or player:

```bash
npm run web:player
```

Then `http://localhost:8081` and `http://localhost:8082`. Both talk to the same backend,
so a message sent in one appears in the other with no refresh. (An incognito window
against a single server works too, and needs no second terminal.)

### Proving the two platforms really do talk

Run the app twice against the same emulator — an iOS simulator and an Android emulator,
or two browser windows — and sign in as different people. Send a message in one. It
appears in the other. There is no sync layer to configure: both clients are the same
JavaScript holding an `onSnapshot` listener on one Firestore collection.

---

## Layout

```
app/                     expo-router file routes
  _layout.tsx            SessionProvider + themed Stack
  index.tsx              auth gate
  sign-in.tsx
  (tabs)/                Messages · Calendar · Workouts (coach only) · Locker · You
  thread/[id].tsx        conversation, with the monitoring banner
  workflow/[id].tsx      sandboxed WebView for a coach-published HTML doc (and the Match Tracker)
  roster.tsx             invite a player (18+: no parent), open threads
src/
  firebase.ts            app/auth/db init; emulator wiring
  data.ts                every Firestore read and write, each shaped to a rule
  session.tsx            who is signed in, which role, live consent, claiming invites
  theme.ts               design-system tokens: night, Geneva gold, court blue
  ui.tsx                 Banner, Avatar, Card, Setting, Button …
  workflowBridge.ts      the script injected into workflow WebViews
firebase/
  firestore.rules        the security model
  test/rules.test.mjs    the cases that pin it, one per rule it must not lose
scripts/
  seed.mjs               demo data for the emulator
  workflow-docs.mjs      the training documents the seed publishes
  set-coach-code.mjs     sets the team's coach code (stored only as a SHA-256)
.github/workflows/       CI, Android APK, iOS TestFlight
```

## Checks

```bash
npm run typecheck
```

```bash
npm run test:rules
```

The rules suite boots the Firestore emulator itself and asserts the things that would be
expensive to get wrong: that an athlete cannot post before consent, that a parent *can*
message the coach before consent (talking to him is how she decides), that the coach can
neither grant consent nor write the guardian out of a thread, that messages are
permanent, and that the exact queries `src/data.ts` runs are the ones the rules permit.
Both run in CI on every push.

---

## Shipping

**New here? [`docs/START-HERE.md`](docs/START-HERE.md) is the ordered list of what still
needs the owner** — Firebase, the Android keystore, and the Apple account, in the order
they unblock each other. `docs/SHIPPING.md` is the deeper reference behind it.

The short version: this repo is public, so GitHub-hosted runners — including macOS —
are free, and a pushed `v*` tag builds both binaries with no Mac and no EAS
subscription.

- **Android `.apk`** — an Ubuntu runner prebuilds and runs `assembleRelease`, then
  re-signs with your upload keystore. The APK is attached to the GitHub Release. If the
  keystore secrets are not set yet you still get a debug-signed APK you can sideload.
- **iOS TestFlight** — a macOS runner prebuilds, archives with Xcode cloud signing
  against an App Store Connect API key, and uploads with `fastlane pilot`.

Nine repository secrets: four Apple (`APPLE_TEAM_ID`, `ASC_KEY_ID`, `ASC_ISSUER_ID`,
`ASC_KEY_P8`), four Android, and `ENV_FILE` — the whole of `.env`, which both builds
need because Expo inlines the Firebase config into the bundle and a build without it
produces an app nobody can sign in to. `docs/SHIPPING.md` says exactly where each comes
from and which steps only the account holder can perform; `docs/APP-STORE.md` has the
listing copy, the privacy answers and the review notes for the submission itself.

---

## Known limits, stated plainly

- **No push notifications.** Sending an FCM message needs server-side code, and Cloud
  Functions require Firebase's paid Blaze plan. The per-thread mute toggle is built and
  persists to the muter's own account, so the setting is already there when push is
  wired up. Until then it governs nothing.
- **Unread counts are approximate.** The Messages badge counts visible threads, not
  unread messages; real read receipts need a `lastRead` pointer and a rules change.
- **The Locker's read rule is open to any signed-in account.** Workflows are training
  content rather than personal data, but they are the coach's own material. Closing it
  needs a membership record, which is a signup-flow decision nobody has made yet — so it
  is flagged here rather than guessed at.
- **Workflow HTML is capped at ~900 KB** by a security rule, below Firestore's 1 MiB
  document ceiling, so an oversized upload fails as a clear denial instead of an opaque
  write error.
- **Under-13 athletes should not have logins.** COPPA attaches below 13. The cheapest
  compliant path is a 13+ age rating and younger families using the parent account only.
  That is an owner decision, not a code change.
