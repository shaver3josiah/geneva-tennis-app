# The App Store submission

`SHIPPING.md` §2 gets a build into TestFlight. This is the other half: the words, the
answers and the settings App Store Connect asks for before a build can go to review.

**Most of it is no longer typing.** `scripts/appstore-metadata.mjs` holds the listing
and pushes it over Apple's API, idempotently:

```powershell
node scripts/appstore-metadata.mjs --dry   # prints what it would change
node scripts/appstore-metadata.mjs
```

It sets the subtitle, the privacy policy URL, both categories, the description,
keywords, promotional text, the support and marketing URLs, the age rating
questionnaire, the price, the version string, the build to review, and the App Review
notes and demo account. Then it prints what is left.

**Two things it cannot do, and one it will not.** Screenshots are
`scripts/store-screenshots.mjs`. App Privacy has no API at all — every
`appDataUsages` path answers 404, and fastlane cannot reach it either — so §5 below is
still a console form. And it never submits for review; that stays a decision somebody
makes on purpose.

This file is now the reasoning. The script is the copy: change a word there, not here,
or the listing and the document drift apart with nothing to notice.

> **Demo credentials are not in this file.** This repository is public. They are in
> `docs/owner-open-items.md` at the project root, which is not version controlled.

---

## 1. The app record

| Field | Value |
|---|---|
| Name | `Geneva Tennis` |
| Subtitle | `Coach, parent, and player` |
| Bundle ID | `com.genevatennis.app` — must match `app.json` exactly |
| SKU | `geneva-tennis-app` |
| Primary category | Sports |
| Secondary category | Education |
| Primary language | English (U.S.) |
| Price | Free |
| Availability | United States is enough; the roster is one gym in Fort Lauderdale |

**Do not opt into the Kids Category.** It brings a stricter rule set — no external links,
no third-party analytics, a parental gate on everything — and this app is built for the
13-and-over shape described in §4 instead.

## 2. Description

**The live copy is `LISTING` in `scripts/appstore-metadata.mjs`.** What follows is the
same words, kept here for reading.

> Geneva Tennis is the private line between Coach the head coach, his players, and
> their parents.
>
> Messages, session schedules, and training workflows in one place, for the families
> training with Geneva Tennis in Fort Lauderdale. It is not a social network and there
> is nobody to meet: you see your coach, your athlete, and nothing else.
>
> **Built so a parent never has to wonder.**
>
> A guardian reads every message between the coach and their athlete. Not a setting, not
> a toggle the coach can reach — it is written into the database rules, and the athlete is
> told about it in plain words on the screen. Nobody can edit or delete a message after it
> is sent, the coach included.
>
> An athlete cannot message the coach at all until their guardian grants consent, and
> revoking it locks the conversation again immediately, without deleting anything that was
> already said.
>
> **What you get**
>
> - Direct messaging with your coach
> - The training calendar for your athlete
> - The Locker: workouts and evaluations the coach publishes, filled in on your phone
> - A workout timer that logs the minutes your athlete actually trained
> - Streak reminders on your own phone, with a switch to turn them off
>
> Accounts are created by the coach for families training with Geneva Tennis.
> Signing up needs an invitation to your email address.

**Promotional text** (changeable without a new build):

> Every message between the coach and your athlete, visible to you, permanently.

**Keywords** (100 characters, comma-separated, no spaces):

```
basketball,coach,training,youth sports,parent,player development,fort lauderdale,team
```

- **Support URL**: `SUPPORT_URL` (your own page)
- **Marketing URL**: `MARKETING_URL` (optional)
- **Privacy Policy URL**: `PRIVACY_POLICY_URL` (your own page, never committed)

The privacy policy and the support link also open from inside the app, on the You tab.
App Review looks for them there and not only on the listing.

## 3. Screenshots

Required: 6.9-inch iPhone, 1320 × 2868. One set covers every iPhone size. `app.json` sets
`supportsTablet: false`, so **no iPad screenshots are needed**.

`npm run screenshots` captures and uploads them. It renders the real app against the
seeded demo family in a local Firebase emulator, so nothing is staged and no real
family's conversation is photographed. Five, in this order, are the story:

1. **Messages** — the "You see everything" banner over the conversation list
2. **The conversation** — the monitored coach-to-athlete thread, read-only for the parent
3. **Calendar** — the month, the session types, the next session
4. **The Locker** — the workflows and the two built-in training tools
5. **You** — training consent granted, and the reader switch that cannot be turned off

It writes a Play set too, at 1080 x 2160. Play refuses a phone screenshot whose long
edge is more than twice its short edge, and 2868/1320 is 2.17, so the two stores need
two captures rather than one resized.

**One liberty is taken, and it is taken to be accurate.** On the web there is no home
indicator, so `react-native-safe-area-context` reports a zero bottom inset and the tab
bar sits against the very edge of the frame with 15 device pixels under its labels. A
real iPhone reserves 34pt there and an Android phone reserves its gesture bar, so the
capture pads it back. Nothing else about the pixels is touched.

The header of `scripts/store-screenshots.mjs` has the emulator setup, in order. The
step everyone skips is `EXPO_PUBLIC_FIREBASE_PROJECT_ID=geneva-tennis-dev` in
`.env.local`: the emulator serves whatever project id it is asked for, so without it
the app talks to an empty database inside the same emulator and the only symptom is
the app saying the coach has not added you to an athlete yet.

## 4. Age rating

Answer the questionnaire honestly. Two answers decide the outcome here:

- **Chat or messaging between users**: yes. Private and invitation-only, not open.
- **Unrestricted web access**: no. The only web view renders HTML the coach publishes, and
  it is sandboxed (`src/workflowBridge.ts`).

**Apple computes 4+ from honest answers, and that is wrong here.** Under the rating
system Apple moved to in 2025, private chat and user-generated content are shown to
parents as capabilities rather than raising the band, so the questionnaire alone leaves
this app offered to under-13s. `AGE_RATING.ageRatingOverrideV2` is therefore set to
`THIRTEEN_PLUS`, which is how a developer says the audience is older than the content
implies. App Store Connect then reports `appStoreAgeRating: TWELVE_PLUS`, which is the
legacy name for the same band; the store shows 13+.

Expect **13+**. That is also the rating this product wants: COPPA attaches below 13, and
the cheap compliant path is no logins for athletes under 13 — those families share the
parent's account, which the signup screen and the roster screen both say. Leaving the
athlete's email blank when inviting is what enforces it.

## 5. App Privacy

Everything below is **linked to the user's identity**, used for **App Functionality**, and
**not** used for tracking. There is no advertising SDK, no analytics SDK and no data broker
in this app — Firebase Auth and Firestore are the whole backend.

| Data type | Collected | Why |
|---|---|---|
| Email address | Yes | It is the login, and the invitation is addressed to it |
| Name | Yes | The coach records the athlete's and the guardian's names |
| Other user content | Yes | The messages, and the workflow answers an athlete fills in |
| User ID | Yes | The Firebase Auth uid every record is keyed on |
| Fitness | Yes | The workout timer files minutes trained and blocks finished under the athlete (`logWorkoutDone` in `src/data.ts`), and the account's own record keeps a training streak and a workout count |
| Other data | Yes | The athlete's age, an optional whole number the coach types on the Roster when he invites a family (`age` in `src/types.ts`) |
| Product Interaction (under Usage Data) | Yes | The streak: `/users/{uid}` stores the day the app was last opened, the run length, the best run, and which sessions were finished (`lastDay`, `streak`, `bestStreak`, `doneEvents` in `UserPrefs`). Purpose: **App Functionality only** |

Answer **No** to tracking, advertising data, location, contacts, photos, health, financial
info, browsing history and diagnostics. Nothing in the app collects them.

Three answers on that form are easy to get wrong here, so read them twice:

- **Health is No, Fitness is Yes.** Apple splits them. Nothing medical or clinical is
  collected. Minutes trained and blocks finished are exercise data, and they are shared
  with the coach, so they are declared.
- **Usage Data is Yes, Analytics is No.** Apple asks two separate things: what TYPE of
  data leaves the phone, and what PURPOSE it serves. The streak sends the date the app was
  last opened to Firestore, and "when the app was opened" is Product Interaction data, so
  the type is declared. Its only purpose is to run the streak on that same account, which
  the coach cannot read, so the purpose is App Functionality and Analytics stays unticked.
  An earlier version of this table left the row out entirely by conflating the two
  questions; the pre-resubmission audit of 22 September 2026 caught it.
- **The privacy policy now matches this table.** `your privacy policy` has a
  section on the app naming every row above. Until 22 September 2026 it described the
  website only, and both stores check the label against the linked policy.

Account deletion is offered in the app — You tab, Delete my account — which is what
Guideline 5.1.1(v) requires.

## 6. App Review Information

**Provision the account first: `npm run review:account -- --key <service-account.json>`.**
It creates the demo login with `emailVerified` already true, builds a synthetic athlete
record with a real conversation on it, and then signs in as the reviewer would and
proves all of it. Do not submit on a run that reported a failure.

Play rejected version code 18 because none of that had been done. The reviewer signed in
and hit the app's own email-verification gate, which Google reported as "Multi-factor
authentication blocks access" -- clearing it needed a Gmail inbox they correctly refused
to ask for. The gate is not a bug and has not been changed; the demo account is simply
verified through the admin API instead of by a human opening mail.

### 6.1 Google Play: Sign in details

Play Console, **App content**, **App access**. Choose *All or some functionality is
restricted*, add one instruction set, and paste:

| Field | Value |
| --- | --- |
| Name of the flow | `Guardian sign-in` |
| Username | `REVIEW_EMAIL` from `docs/owner-open-items.md` |
| Password | `REVIEW_PASSWORD` from `docs/owner-open-items.md` |

> This account is permanently verified and needs no one-time password, SMS code,
> secondary device, or access to any email inbox. Sign in and you are straight into the
> app. The credentials are reusable, do not expire, and work from any location.
>
> The app is a private messaging and scheduling tool for one basketball trainer and the
> families he coaches. It is invitation-only: the coach creates an athlete record naming
> a parent's email address, and an account sees nothing until a verified address matches
> one. This account is already attached to an athlete record with an active conversation,
> so there is nothing to set up.
>
> After signing in: the first tab is the conversation with the coach. The Calendar tab
> has scheduled workouts, the Locker tab has training worksheets, and the You tab has the
> guardian's consent control and Account, which contains account deletion.

### 6.2 Apple: the notes

**Do not paste these by hand.** They are `REVIEW_NOTES` in
`scripts/appstore-metadata.mjs`, and the demo login is the `REVIEW_EMAIL` /
`REVIEW_PASSWORD` repository secrets. The **App Store metadata** workflow pushes both and
reads them back; it runs by itself after every `v*` tag's TestFlight upload, and by hand
from `npm run release:panel`. A copy of the notes used to live here and had already
drifted from the file (it still said the report link opened a support form).

### 6.3 Apple: the screen recording (rejection of 1.0.4 build 9)

Apple rejected 1.0.4 (9) on 21 September 2026 under Guideline 2.1, Information Needed.
It is not a defect finding. It is the questionnaire a developer account with little
review history gets, and it asks for six things plus a recording. Items 2 to 6 are
answered by `REVIEW_NOTES` (6.2), which is why that block now carries them: Apple asked
for the answers in the Notes field "for reference on future submissions", not only in a
reply. Push them with the **App Store metadata** workflow (6.2), then paste the same text into the
reply in App Store Connect and attach the recording.

The recording is the only part nobody can automate. It has to be captured on a physical
device on the current iOS, start at launch, and show registration, login, account
deletion, user-generated content, and the reporting and blocking controls.

**Record it in this order, one take:**

1. **Launch from the home screen.** Apple asks for the recording to begin with launching
   the app, so start on the springboard, not inside the app.
2. **Registration.** Sign up with a brand new address. It will land on the verify-your-email
   screen and stop there. Say out loud, or caption, that this is the invitation model: an
   account reaches nothing until a verified address matches an athlete record the coach
   created. Stopping here is the honest demonstration, not a failure.
3. **Sign in as the demo account** from the Notes. Straight in, no code, no inbox.
4. **Messages.** Open the conversation. Send one message so user-generated content is
   visibly created, not just displayed.
5. **Reporting.** You tab, "Report a concern". Tap it and let the email open, addressed to
   the account holder rather than the coach.
6. **Blocking.** On the same tab, show the consent switch and turn it off, then on. That is
   the control that stops an athlete posting. Show a conversation's mute switch too.
7. **Calendar and Locker,** briefly. Tap a scheduled workout to show the timer. Open the
   Locker so the worksheets are visible. Do not open the camera or microphone tools unless
   you want to demonstrate the permission prompts, which is fine but not required.
8. **Account deletion.** You tab, Account, Delete account. Go all the way through to the
   end, including the screen explaining that messages are retained as the guardian's record.

**Step 8 destroys the reviewer's login, and step 8 is the one Apple insists on.**
Deleting the demo account removes the Auth user that the Notes field hands Apple, and the
athlete record, threads and messages all reference its uid.

Put it back before replying:

```
npm run review:account -- --key <path to the admin SDK json>
```

It recreates the account with the same address, rewrites the athlete, both threads and
every seeded message against the new uid, and then signs in as the reviewer to prove it.
Do not send the reply until that run reports the account ready. `npm run review:check`
re-checks it at any time.

If recording the deletion on the demo account feels too sharp, register a second throwaway
address at step 2, provision it by pointing `REVIEW_EMAIL` at it for one run, and delete
that one instead. The demo account is then never touched.

**One risk worth knowing before you send.** Apple asked to see "the required content
reporting and blocking mechanisms". This app has a report link and two controls that stop
a conversation, but it has no per-user block button, because there is no user to block:
the only person a family can message is their own coach. That argument is in the notes and
it is true. If Apple pushes back under Guideline 1.2 anyway, the smallest answer is a
"Report this message" action inside a thread that opens the same report email with the
thread id prefilled. That is a new build, so it is deliberately not being done pre-emptively.

## 7. Two things commonly panicked about that do not apply

- **Sign in with Apple** (Guideline 4.8) is required only when an app offers a *third-party*
  login — Google, Facebook and the like. This app has email and password through Firebase
  Auth and nothing else, so Sign in with Apple is not required.
- **A web page for account deletion** is not needed. Apple wants deletion to start in the
  app, and it does.

## 8. After the first upload

Apple emails within about an hour of a successful upload. Two messages are common and
neither blocks TestFlight:

- **"Missing Purpose String"** names an API used without a usage description. The app uses
  the camera (the Match Tracker) and the microphone (the Match Tracker), and `app.json` carries
  a usage string for each. It touches no location, contacts or photo library. If the notice
  names anything else, it names the key to add under `ios.infoPlist`.
- **A privacy manifest notice.** Expo's prebuild writes `PrivacyInfo.xcprivacy` and every
  native dependency here ships its own. If Apple names a missing declaration, add it under
  `ios.privacyManifests` in `app.json` and re-tag. It is metadata, not code.

A build stays installable from TestFlight for 90 days. The monthly keep-alive in
`.github/workflows/ios-testflight.yml` re-uploads the same code so a parent's app does not
quietly stop opening — see `SHIPPING.md` §5b.
