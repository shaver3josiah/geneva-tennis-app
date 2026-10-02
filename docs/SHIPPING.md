# Shipping Geneva Tennis

One `git tag` produces both binaries:

| Tag pushed | What happens | Where it lands |
| --- | --- | --- |
| `v1.0.1` | `android-apk.yml` builds and signs an APK | GitHub **Releases**, download to any Android phone |
| `v1.0.1` | the same job builds and signs an `.aab` and uploads it | **Google Play**, `internal` track |
| `v1.0.1` | `ios-testflight.yml` builds, signs, uploads | **TestFlight**, install on any iPhone |
| (then) | `appstore-metadata.yml` waits for Apple to process that build, pushes the listing with it attached, and reads every field back | the App Store version record, ready for **Submit for Review** |

The store listings themselves are code too, not a form somebody retypes:
`scripts/appstore-metadata.mjs` pushes the whole App Store listing over Apple's API,
and section 7 covers the Play half.

Both binaries are the same JavaScript against the same Firebase project, so an
iPhone and an Android phone message each other with no extra work.

Everything runs on GitHub's own machines, including the Mac. Because this repo is
public, those minutes are free, and no Expo/EAS account or build credits are used.

---

## 1. What only you can do

These need your Apple account or your private keys. Nobody can do them for you.

- Enrol in the Apple Developer Program ($99/year).
- Create the App ID and the app record in App Store Connect.
- Create the App Store Connect API key, and download the `.p8`, which is offered
  **once**.
- Accept the App Store Connect agreements.
- Add TestFlight testers.
- Generate the Android upload keystore (it is your signing identity).
- Create the Google Play app record, and the service account that lets CI upload to
  it (section 7). Play has no API that creates an app.
- Answer **App Privacy** in App Store Connect and **Data safety** in the Play Console.
  Neither has an API; both are legal statements about a child's data, and the answers
  are written out in `APP-STORE.md` section 5.
- Paste every secret in the §4 table into GitHub as a repository secret, `ENV_FILE`
  included. That one is not an Apple or Android key and is easy to skip, and skipping it
  gives you a green build of an app that dead-ends on "unconfigured".

Everything after that is automatic.

---

## 2. Apple setup (one time)

### 2.1 Enrol

<https://developer.apple.com/programs/> - $99/year. Wait for approval before
continuing; the steps below do not exist until you are enrolled.

### 2.2 Register the bundle ID

<https://developer.apple.com/account/resources/identifiers> then **+** then App IDs
then App.

- Description: `Geneva Tennis`
- Bundle ID: **Explicit**, set to `com.genevatennis.app`
- Capabilities: tick **Push Notifications**. The app never sends a push, but
  `expo-notifications` is what draws the streak reminders and it puts the push
  entitlement on every iOS build. Without the tick the export fails, about twenty
  minutes into the run.

This string must match `ios.bundleIdentifier` in `app.json` exactly. It is already
set to `com.genevatennis.app` there, so use that unless you change both.

### 2.3 Create the app record

<https://appstoreconnect.apple.com/apps> then **+** then New App.

- Platform: iOS
- Name: `Geneva Tennis`. This must be unique across the entire App Store. If it
  is taken, pick something else here; the name on the phone comes from `app.json`,
  not from this field.
- Bundle ID: the one from 2.2
- SKU: anything, e.g. `geneva-tennis`

### 2.4 Accept the agreements

App Store Connect then **Business** (older name: Agreements, Tax, and Banking).
Accept the free-apps agreement. **Uploads are rejected until this is done**, with an
error message that never mentions agreements.

### 2.5 Create the API key, and watch the role

<https://appstoreconnect.apple.com/access/integrations/api> then the **Team Keys**
tab then **+**.

- Name: `GitHub Actions`
- Access: **App Manager**. Admin also works.

> **This is the most common failure in this whole pipeline.** A key with the
> **Developer** role archives perfectly, then fails minutes later at the export
> step with `Cloud signing permission error`. If you see that message, the role is
> wrong. Roles cannot be edited after creation, so revoke the key and make a new
> one.

Then:

1. **Download the `.p8`.** Apple lets you download it exactly once.
2. Note the **Key ID**, 10 characters, shown in the row.
3. Note the **Issuer ID**, a UUID shown above the table. It is the same for every
   key on the team.

### 2.6 Add yourself as a TestFlight tester

App Store Connect then your app then **TestFlight** then Internal Testing. Create a
group and add your Apple ID. Internal testers need no review and get the build
within a few minutes of upload.

---

## 3. Android keystore (one time, on Windows)

The keystore is your app's permanent identity. **If you lose it you cannot ship an
update that installs over the old app**, because Android refuses a signature
change. Back it up somewhere you will still have it in five years.

`keytool` ships with the JDK. If the command is not found, install Temurin JDK 17
from <https://adoptium.net/> and reopen PowerShell.

Generate the keystore. It prompts for a password, and for your name and
organisation, which can be anything:

```powershell
keytool -genkeypair -v -storetype PKCS12 -keystore geneva-tennis-upload.jks -alias geneva-tennis -keyalg RSA -keysize 2048 -validity 10000
```

Use the **same password** for the store and for the key. A PKCS12 keystore really
only has one password, and setting two different ones is a reliable way to get a
build that fails to sign for no visible reason.

Now turn it into text you can paste into a GitHub secret:

```powershell
[Convert]::ToBase64String([IO.File]::ReadAllBytes("geneva-tennis-upload.jks")) | Set-Clipboard
```

That puts the whole base64 blob on your clipboard, ready to paste as
`ANDROID_KEYSTORE_BASE64`.

> Do **not** use `certutil -encode` for this. It wraps its output in
> `-----BEGIN CERTIFICATE-----` header and footer lines, and the workflow's
> `base64 -d` chokes on them.

If you would rather write it to a file than use the clipboard:

```powershell
[Convert]::ToBase64String([IO.File]::ReadAllBytes("geneva-tennis-upload.jks")) | Set-Content -Encoding ascii keystore.base64.txt
```

Keep `geneva-tennis-upload.jks` and `keystore.base64.txt` **out of the repo**.
`.gitignore` already excludes `*.jks`.

---

## 4. The ten secrets

GitHub, then your repo, then **Settings**, then Secrets and variables, then
**Actions**, then New repository secret.

| Secret | Used by | Value |
| --- | --- | --- |
| `APPLE_TEAM_ID` | iOS | 10-character Team ID, top right of <https://developer.apple.com/account> |
| `ASC_KEY_ID` | iOS | 10-character Key ID from step 2.5 |
| `ASC_ISSUER_ID` | iOS | Issuer ID (UUID) from step 2.5 |
| `ASC_KEY_P8` | iOS | **Raw contents** of the `.p8` file, see below |
| `ANDROID_KEYSTORE_BASE64` | Android | The base64 blob from step 3 |
| `ANDROID_KEYSTORE_PASSWORD` | Android | The keystore password you chose |
| `ANDROID_KEY_ALIAS` | Android | `geneva-tennis` |
| `ANDROID_KEY_PASSWORD` | Android | Same as the keystore password |
| `ENV_FILE` | both | The whole of `.env`, verbatim. **Not optional** — see below |
| `GOOGLE_PLAY_SERVICE_ACCOUNT_JSON` | Android | The whole service-account JSON from section 7. Without it the `.aab` is built and signed but not published |

### `ENV_FILE`: the one whose absence is silent

`.env` is gitignored and `EXPO_PUBLIC_*` is inlined into the JavaScript bundle at build
time, so a runner without this file builds an app carrying no Firebase config at all: it
installs, it opens, and it dead-ends on the "unconfigured" screen. Both build workflows
now refuse to continue without a project id and a coach uid in it, because the failure is
otherwise a perfectly green build of a dead app.

```powershell
gh secret set ENV_FILE --repo shaver3josiah/geneva-tennis-app < "C:/Users/shave/Documents/Claude/Projects/Geneva/geneva-tennis-app/.env"
```

Re-run that whenever `.env` changes. A secret is a copy, not a link.

### `ASC_KEY_P8`: paste it raw

Open the downloaded `AuthKey_XXXXXXXXXX.p8` in Notepad, select all, copy, paste. It
must include the first and last lines, like this:

```
-----BEGIN PRIVATE KEY-----
MIGTAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBHkwdwIBAQQg...
-----END PRIVATE KEY-----
```

**Do not base64-encode it.** The workflow writes this value straight to disk with
`echo`. An encoded key produces `invalidPEMDocument` from Apple's crypto library
later in the run.

### The Android secrets are optional at first

If the four `ANDROID_*` secrets are missing, the Android job still runs and still
gives you a working, installable `.apk`. It is just debug-signed, and the run
summary says so in large letters. That is deliberate: getting the app onto a phone
should not have to wait on keystore paperwork.

A debug-signed APK installs and runs, but it cannot go to Google Play, and a later
release-signed APK will not upgrade over it. You would have to uninstall first.

---

## 5. Releasing

**The simplest way is the release panel**, a page on this machine:

```powershell
npm run release:panel
```

It shows which of the secrets above exist and gives a box for any that are missing
(what you paste goes straight to `gh secret set` and is never shown again), previews and
pushes the App Store listing, and tags a new version, refusing one that is not above the
last tag or a commit CI has not passed. It never submits anything for review.

Or from the project folder in PowerShell:

```powershell
.\scripts\Ship.ps1
```

That commits everything, pushes, tags the next patch version, and pushes the tag,
which starts both release builds. To choose the version yourself:

```powershell
.\scripts\Ship.ps1 -Version 1.2.0 -Message "New drill screen"
```

Then watch **Actions** in GitHub. Roughly:

- Android: about 10 minutes, then the `.apk` appears on the Releases page and as a
  workflow artifact.
- iOS: about 20 minutes, then the build appears in App Store Connect under
  TestFlight, followed by a few more minutes of Apple-side processing before
  testers are notified.

### Installing the APK on a phone

Open the Releases page on the Android phone, download the `.apk`, tap it, and allow
"install unknown apps" for your browser when prompted.

### Running one platform on its own

Actions, then pick **Android APK** or **iOS TestFlight**, then **Run workflow**.
This builds without creating a tag or a release.

---

## 5b. The 90-day TestFlight clock

A TestFlight build stops being installable **90 days after upload**. Nobody is
warned — the app just disappears from a tester's phone one day, and the first you
hear about it is a parent saying it is gone.

`ios-testflight.yml` re-uploads on the 1st of every month to keep that from
happening. You do not have to do anything, but two things are worth knowing:

- The monthly run uploads the **same code** with a new build number. That is all
  App Store Connect requires, and it resets the 90-day clock for every tester.
- Each scheduled run also commits `.github/last-keepalive.txt`. That is not
  decoration: GitHub disables a scheduled workflow after 60 days with no
  repository activity, which would kill the keep-alive about a month before the
  build it renews expires. The commit keeps the clock reset, and the file is a
  plain-text record of the last upload.

If you ever see the keep-alive failing, fix it rather than muting it — the
consequence is silent, and it lands on the families, not on you.

## 7. Google Play

A tag builds `geneva-tennis.aab` beside the `.apk`, signs it with the same upload
keystore, and pushes it to the **internal** track. `scripts/play-upload.mjs` does the
upload in four HTTP calls with no third-party action, because the credential involved
can publish to the store; `npm run test:play` pins its behaviour offline.

### 7.1 The app record (one time, yours)

<https://play.google.com/console> then **Create app**.

- App name: `Geneva Tennis`
- Default language: English (United States)
- App or game: App. Free or paid: **Free** (this cannot be changed to paid later)
- Package name: **`com.genevatennis.app`**, taken from the first upload, so it must
  match `app.json` exactly and can never be changed afterwards

Play will not accept a production release until these are answered, and none of them
has an API:

| Section | Answer |
| --- | --- |
| Privacy policy | `PRIVACY_POLICY_URL` (your own page, never committed) |
| App access | All functionality is behind a login. Give the demo credentials from `docs/owner-open-items.md` and the instructions from `APP-STORE.md` section 6 |
| Ads | No ads |
| Content rating | Same answers as Apple's: private messaging yes, user-generated content yes, no unrestricted web access, nothing else |
| Target audience | **13 and over.** Do not tick an under-13 age band: it opts the app into the Families policy, and the whole design here is that an athlete under 13 has no login and trains from the parent's account |
| Data safety | **Use the Play table under 7.1.1 below, not Apple's.** Same data, different category names, and one of Apple's (Other user content) has no Play equivalent |
| Government apps / financial / health | No to all |

### 7.1.1 Play's Data safety form, row by row

Apple's table in `APP-STORE.md` section 5 is the same data, but Play names its
categories differently, and Apple's "Other user content" has no Play equivalent. Filling
Play's form from Apple's names is how the MESSAGES get left off, because nothing in
Play's picker is called that. Messages between a coach and a minor are the most
sensitive thing this app holds, and an undeclared data type Play finds the app
transmitting is a policy violation on its own.

Every row below: **Collected: yes. Shared: no.** (Google is a service provider, which
Play does not count as sharing, and nobody else receives anything.) **Processed
ephemerally: no. Required.** Purpose: **App functionality**, and **Account management**
where noted. Nothing is used for analytics, advertising, personalisation or fraud.

| Play category | Play data type | What it is here |
|---|---|---|
| Personal info | Name | The athlete's and guardian's names the coach types in; a chosen display name |
| Personal info | Email address | The login, and the address the invitation is sent to. Also Account management |
| Personal info | User IDs | The Firebase Auth uid every record is keyed on. Also Account management |
| Personal info | Other info | The athlete's age, an optional number the coach types in |
| Messages | Other in-app messages | **The coach/parent and coach/athlete conversations.** This is the row that goes missing |
| Health and fitness | Fitness info | Minutes trained and workout blocks finished |
| App activity | App interactions | The streak: the day the app was last opened, and which sessions were finished |
| App activity | Other user-generated content | Answers typed into training worksheets; the Match Tracker's saved count and ball fingerprint |

Then the section-level questions:

| Question | Answer |
|---|---|
| Is all data encrypted in transit? | **Yes.** Firebase Auth and Firestore are TLS only |
| Do you provide a way for users to request deletion? | **Yes** |
| Deletion URL | `PRIVACY_POLICY_URL` (your own page, never committed) — the "The Geneva Tennis app" section names the in-app path and a web route that works without the app installed. Play requires the web route; it did not exist before 22 September 2026 |

Answer **no** to location, financial info, contacts, photos and videos, audio files
(the Match Tracker hears audio and saves none of it, only a count and a numeric
fingerprint, which are declared above as user-generated content), files, calendar
(Play's "Calendar events" means the phone's calendar, which the app never reads), web
browsing, app info and performance, and device IDs.

### 7.2 The service account (one time, yours)

The upload credential. It is a Google Cloud service account that the Play Console
grants release access to.

1. <https://console.cloud.google.com/iam-admin/serviceaccounts> - pick any project you
   own (the `<your-firebase-project-id>` Firebase project is fine) then **Create service
   account**. Name it `play-publisher`. Give it **no** project roles: the permission
   that matters is granted in the Play Console, not here.
2. On the new account, **Keys**, **Add key**, **Create new key**, **JSON**. The file
   downloads once.
3. Play Console, **Users and permissions**, **Invite new users**. Paste the service
   account's email (`play-publisher@....iam.gserviceaccount.com`). App permissions:
   Geneva Tennis. Grant **Release to testing tracks**, **Release apps to
   production**, and **View app information**.
4. Set the secret from the downloaded file:

```powershell
gh secret set GOOGLE_PLAY_SERVICE_ACCOUNT_JSON --repo shaver3josiah/geneva-tennis-app < "$HOME\Downloads\play-publisher-key.json"
```

> **The very first upload cannot be an API upload.** Play requires the first bundle
> for a brand new app to go through the console by hand, because that upload is what
> enrols the app in Play App Signing. Download the **geneva-tennis-aab** artifact
> from any tag run and drag it into the internal track once. Every upload after that
> goes through CI.

### 7.3 Tracks

`internal` is live within minutes, needs no review, and reaches only the testers you
list. `production` is public and takes a review of a day or two on a new app.

The tag build always goes to `internal`. Promoting is a button in the console, which
is deliberate: a first production release is refused until 7.1 is complete, and the
error says only that the release is invalid.

To push somewhere else on purpose: Actions, **Android APK**, Run workflow, and pick
the track. `none` skips the bundle entirely and builds only the sideload `.apk`.

---

## 6. When something breaks

| Symptom | Cause | Fix |
| --- | --- | --- |
| `Cloud signing permission error` at the export step | API key has the Developer role | Revoke it, create a new key with **App Manager**, step 2.5 |
| `invalidPEMDocument` | `ASC_KEY_P8` was base64-encoded | Re-paste the raw file contents |
| Upload rejected, message mentions contracts | Agreements not accepted | Step 2.4 |
| `Project must have a 'ios.bundleIdentifier' set` | `app.json` was edited | Restore `ios.bundleIdentifier` and `android.package` |
| Android build succeeds, APK will not install over the old one | Signature changed, debug to release or a new keystore | Uninstall the old app first |
| `No profiles were found` | Bundle ID in `app.json` does not match the App ID | Make step 2.2 and `app.json` agree |
| `doesn't include the aps-environment entitlement`, or a push entitlement mismatch at export | `expo-notifications` puts a Push Notifications entitlement on every iOS build, even though this app only schedules local reminders | Turn **Push Notifications** on for the App ID in step 2.2. `app.json` already pins `mode: production`, which is what an App Store build has to carry |
| iOS build number rejected as duplicate | Two runs produced the same build number | Push a new tag; the build number is the GitHub run number |
| Play: "Your app cannot be published yet" | A console section in 7.1 is unanswered | The console names it; Data safety and Target audience are the usual two |
| Play: a version code that has already been used | Two runs produced the same versionCode | The version code is the GitHub run number, so start a new run rather than re-running the failed step |
| Play upload: 403 from the API | The service account was never granted access to this app in the Play Console | 7.2 step 3. Granting it in Google Cloud IAM is not the same thing and does nothing |

Version numbers: on a `v*` tag build, **the tag is the version a tester reads**, not
`expo.version` in `app.json`. Both workflows strip the `v` and stamp what is left over
whatever `app.json` produced, iOS into `CFBundleShortVersionString` and Android into
`versionName`, because `Ship.ps1` tags a release without editing `app.json` and the two
would otherwise disagree. The iOS job also insists the tag reads `vX.Y.Z`, and stops
right after the prebuild if it does not, rather than letting Apple reject the upload half
an hour later. A run started by hand and the monthly keep-alive have no tag to read, so
those keep `expo.version`. The build number is the GitHub run number either way, so it
always increases on its own and you never need to bump it by hand.
