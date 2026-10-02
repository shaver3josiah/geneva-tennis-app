# Geneva Tennis — start here

The team app for Geneva College men's and women's tennis. One Expo codebase builds the
Android `.apk` and the iOS TestFlight build on GitHub Actions, with no Mac and no EAS. It is a
sibling of the Fast Basketball app on the same accounts, with its own Firebase project, bundle
id and signing key.

## What is already done

| Piece | State |
|---|---|
| Firebase project `geneva-tennis-35a1a` | Created. Email/password sign-in is on, Firestore (nam5) exists, and the security rules in `firebase/firestore.rules` are deployed. |
| Coach access | Claimed in the app with a coach code. Only the code's SHA-256 is stored, so the code itself is not in this repository; the owner has it. |
| Android signing | A new upload keystore exists and the four `ANDROID_*` secrets are set, so every APK is release-signed and upgrades in place. |
| Apple | The same team and App Store Connect key as Fast Basketball. Bundle id `com.genevatennis.app` is registered and the four Apple secrets are set. |
| CI | Typecheck, rules tests, tracker and worksheet drift checks on every push; the iOS compile check on every push to `main`. |

## The one step left for iPhones

Apple's API can register a bundle id but cannot create an app record, so a person creates it,
once:

1. Go to [appstoreconnect.apple.com](https://appstoreconnect.apple.com), then **Apps**, then **+**, then **New App**.
2. Fill in: Platform **iOS**, Name **Geneva Tennis**, Primary language **English (U.S.)**,
   Bundle ID **com.genevatennis.app**, SKU **geneva-tennis-app**, User access **Full Access**.
3. Select **Create**.

Nothing else is needed. The **TestFlight when ready** workflow checks App Store Connect every
30 minutes. The first time the record exists with no build in it, the workflow starts the iOS
build, uploads it to TestFlight, and then switches itself off. Add testers under **TestFlight →
Internal Testing**. Until then, every iOS run still archives and signs the app and keeps the
`.ipa` as a run artifact.

If the name "Geneva Tennis" is already taken on the App Store, use **Geneva Golden Tornadoes
Tennis** and keep everything else the same.

## Installing the Android app

Open the latest [release](https://github.com/shaver3josiah/geneva-tennis-app/releases), download
`geneva-tennis.apk` on the phone, and allow installs from that browser when Android asks.
Updates install over the top of the previous version.

## First run

1. **Coach.** Create an account and open the confirmation email. On the "waiting for an
   invite" screen, tap **I'm a coach** and enter the coach code. An assistant coach does the
   same with the same code.
2. **Roster.** On the **You** tab, select **Add or manage players**. For a college player,
   enter only the player's name and email and leave the guardian fields blank: an 18+ player
   manages their own consent. A player then signs up with that same email.
3. **A match.** Go to **Matches**, select **New match**, choose the format (**College singles**:
   no-ad, tiebreak at 6-6, full third set), and select **Track live**.

## Tracking a match

- **Mount.** Put the phone on the back fence, an arm's reach above head height and about 3 m
  (10 ft) behind the baseline, in landscape, centred on the court. Keep the sun behind the
  phone.
- **Lens.** On iPhones with a 0.5x lens the tracker selects it automatically (iOS 17+). Many
  Android phones do not give the ultra-wide lens to apps that use the camera this way. If the
  near corners are cut off, use **Near corners hidden?** during calibration. That calibrates
  from the service line and the far corners instead.
- **Calibrate.** Tap the four court points in order. The tracker reports the lens angle and
  the camera height it worked out, so you can check them.
- **Charting.** The tracker calls each point: ace, double fault, winner, forced or unforced
  error. Tap **Confirm** or **Fix**. With **Hands-free** on, its calls save without a tap and
  can be fixed later in the Sheet tab.
- **Sync.** Points save to Firestore every 3 points and at the end of every game. The coach's
  Matches tab and the Google Sheet update at that cadence.

**Measurements are estimates.** Ball pace, spin and net clearance come from fitting a
drag-and-Magnus flight model to the tracked ball through the court calibration. Racket speed
comes from impact physics. Body-shape numbers come from MediaPipe pose. The near player and
near-court balls are measured best. The far player is about 5% of the frame height through a
0.5x lens, so expect coarser numbers on that side.

## Spreadsheets

- **No setup.** In a match, open **Export**. **Excel (.xlsx)** shares a formatted workbook
  with Summary, Points, Shots, Serve Map and Trends sheets. **Copy for Google Sheets** puts
  every point on the clipboard; paste it into cell A1. **New Google Sheet** copies the points
  and opens a blank sheet.
- **Live Google Sheet.** The coach pastes the Apps Script connector into a Google Sheet once,
  which takes about 3 minutes; see `sheets-connector/README.md`. After that, every new match
  can create its own formatted Google Sheet, and points are written to it every 3 points.
- **Students email the coach.** In **Export**, select **Email stats**. It attaches the `.xlsx`
  and goes to the coach email set under **Matches → Google Sheets**.

## Before coaching off the live feed in a dual match

ITA rule I.M.9 restricts "Player Analysis Technology" during a match for coaching purposes,
limits phones to coaches, and allows players no devices. Using the tracker in practice and after
a match is unrestricted. For live use in a dual match, get written clearance from the PAC and
the ITA (officials@itatennis.com) first. Make the person charting a designated coach rather
than a rostered player.

## Commands

```bash
npm ci
```

```bash
npm run typecheck
```

```bash
npm run test:tennis
```

```bash
npm run tracker
```

```bash
npm run worksheets
```

`npm run tracker` rebuilds `scripts/worksheets/match-tracker.html` from `tracker/*.js` and
`src/tennis/*.js`. `npm run worksheets` bakes it into the app. The tracker page also opens
directly in a browser; its **Watch the demo match** mode runs the whole pipeline on a
simulated match.
