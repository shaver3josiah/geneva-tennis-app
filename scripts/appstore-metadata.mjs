/**
 * Pushes the App Store listing into App Store Connect over its API.
 *
 * WHY THIS EXISTS RATHER THAN A DOCUMENT SOMEBODY TYPES FROM. docs/APP-STORE.md used
 * to be the copy AND the instructions for pasting it in by hand, which means the
 * listing and the file drift apart the first time anyone edits one of them, and
 * nothing notices. This file is the listing. The doc now describes the answers and
 * points here for the words.
 *
 * IT IS IDEMPOTENT. Every call is a PATCH of a resource App Store Connect creates
 * with the app, and each one first compares what is already there, so running it
 * twice changes nothing the second time. `--dry` prints what differs and touches
 * nothing. `--expect-clean` is `--dry` that exits 1 when anything still differs,
 * which is how a push is read back rather than assumed.
 *
 *   node scripts/appstore-metadata.mjs --dry
 *   node scripts/appstore-metadata.mjs
 *   node scripts/appstore-metadata.mjs --expect-clean
 *
 * WAIT_FOR_VERSION=1.0.6 waits (up to WAIT_MINUTES, default 60) until Apple has
 * processed a build of exactly that version, and attaches that build rather than
 * the highest one. If no version record is editable (the last one was approved), it
 * creates the 1.0.6 record first. The workflow sets it from the tag when a TestFlight
 * upload finishes, which is what makes tag -> build -> listing one unattended flow.
 *
 * WHAT IT DELIBERATELY DOES NOT DO:
 *   - Screenshots. scripts/store-screenshots.mjs uploads those.
 *   - App Privacy (the nutrition label). Apple exposes it, but getting it wrong is a
 *     legal statement about a minor's data, so it is answered in the console against
 *     the table in docs/APP-STORE.md section 5 and read back by this script.
 *   - Submitting for review. That is `--submit`, and it is separate on purpose.
 *
 * CREDENTIALS come from the environment, never this file: the repository is public
 * and the App Review demo login reaches a real conversation with a minor in it.
 *
 *   ASC_KEY_ID, ASC_ISSUER_ID, ASC_KEY_P8_PATH (or ASC_KEY_P8 for the raw PEM)
 *   APP_REVIEW_DEMO_EMAIL, APP_REVIEW_DEMO_PASSWORD
 *   APP_REVIEW_CONTACT_FIRST/LAST/EMAIL/PHONE   (defaults below are all published)
 */
import { createSign, createPrivateKey } from 'node:crypto';
import { readFileSync } from 'node:fs';

const BUNDLE_ID = 'com.genevatennis.app';
const EXPECT_CLEAN = process.argv.includes('--expect-clean');
const DRY = EXPECT_CLEAN || process.argv.includes('--dry');
const WAIT_FOR = process.env.WAIT_FOR_VERSION?.trim().replace(/^v/, '') || null;
const WAIT_MINUTES = Number(process.env.WAIT_MINUTES) || 60;

/** Everything a dry run found still different. --expect-clean fails on any of it. */
const pending = [];

// ---------------------------------------------------------------------------------
// The listing itself.
// ---------------------------------------------------------------------------------

/**
 * Subtitle is 30 characters. Privacy policy must be reachable and specific.
 *
 * The three URLs are the owner's own pages and are NOT committed: set PRIVACY_POLICY_URL,
 * SUPPORT_URL and (optionally) MARKETING_URL as repository variables. The `.example`
 * fallbacks below are reserved names that can never resolve, and push() refuses to send
 * one to App Store Connect, so a forgotten variable stops the run instead of putting a
 * dead link in front of App Review.
 */
const SITE = 'https://genevatennis.example';
export const APP_INFO = {
  subtitle: 'Team app for Geneva College',
  privacyPolicyUrl: process.env.PRIVACY_POLICY_URL || `${SITE}/privacy`,
};

export const CATEGORIES = { primary: 'SPORTS', secondary: 'EDUCATION' };

/**
 * Apple wants the year the rights were obtained followed by the entity that owns them,
 * and nothing else -- no "Copyright", no (c), no "All rights reserved", no URL. It is
 * the developer entity on the account, which is the name Apple cross-checks, rather
 * than Geneva College, whose team this is but who does not hold the App Store
 * account or the software.
 *
 * Its absence is why "Add for Review" refuses with "You have one or more errors on this
 * page" and names nothing useful until you scroll.
 */
export const COPYRIGHT = '2026 JOBDASH, LLC';

export const LISTING = {
  description: `Geneva Tennis is the team app for Geneva College men's and women's tennis: messages, the practice calendar, and a match tracker with live stats, in one private place.

Not a social network and there is nobody to meet. You see your coaches, your teammates' schedule, and nothing else.

WHAT YOU GET

- Direct messages with your coaches
- The practice and match calendar, with a workout timer that logs the minutes you actually trained
- The Locker: worksheets and evaluations your coaches publish, filled in on your phone
- Match Tracker: point-by-point scoring with live stats, and a camera and microphone mode that follows the ball and both players on the phone itself. Nothing is recorded or uploaded
- Streak reminders on your own phone, with a switch to turn them off

PRIVATE BY DESIGN

Accounts are for Geneva College tennis. Signing up needs an invitation to your email address, from your coach. Players 18 and over manage their own consent. For a player under 18 the coach invites a parent or guardian as well, who can read every message between the coach and their player: not a setting, but a rule written into the database. Nobody can edit or delete a message after it is sent, the coach included.`,

  // Changeable without a new build, so it carries the one sentence that sells this.
  promotionalText: 'Messages, the practice calendar and a match tracker with live stats, all in one private team app.',

  // 100 characters, comma separated, NO spaces after the commas: a space is a
  // character, and Apple counts every one of them against the same 100.
  keywords: 'tennis,college,team,coach,player,practice,schedule,match tracker,live stats,scoring,geneva',

  supportUrl: process.env.SUPPORT_URL || `${SITE}/support`,
  marketingUrl: process.env.MARKETING_URL || SITE,
};

/** A listing URL that is still the reserved placeholder. push() refuses to send one. */
export const placeholderUrls = () =>
  [
    ['PRIVACY_POLICY_URL', APP_INFO.privacyPolicyUrl],
    ['SUPPORT_URL', LISTING.supportUrl],
    ['MARKETING_URL', LISTING.marketingUrl],
  ].filter(([, url]) => url.startsWith(SITE));

/**
 * The age rating questionnaire. Booleans and enums are not interchangeable and the
 * API says which is which; the enums take NONE, INFREQUENT_OR_MILD or
 * FREQUENT_OR_INTENSE.
 *
 * THE TWO THAT DECIDE THE RATING:
 *   messagingAndChat    true  - private, invitation only, but it is still chat.
 *   userGeneratedContent true - the messages and the workflow answers. Private and
 *                               visible only to the coach and that family, but
 *                               "nobody else can see it" is not what the question asks.
 *
 * Answering either of those false to chase a lower rating is a false statement on a
 * form about an app used by minors, so both are true and the rating is whatever that
 * makes it. The review notes explain the safety model that goes with them.
 */
export const AGE_RATING = {
  alcoholTobaccoOrDrugUseOrReferences: 'NONE',
  gamblingSimulated: 'NONE',
  gunsOrOtherWeapons: 'NONE',
  horrorOrFearThemes: 'NONE',
  matureOrSuggestiveThemes: 'NONE',
  profanityOrCrudeHumor: 'NONE',
  sexualContentGraphicAndNudity: 'NONE',
  sexualContentOrNudity: 'NONE',
  violenceCartoonOrFantasy: 'NONE',
  violenceRealistic: 'NONE',
  violenceRealisticProlongedGraphicOrSadistic: 'NONE',

  // contests and medicalOrTreatmentInformation LOOK like yes/no questions and are
  // graded enums like the content ones. The API is the only place that says which is
  // which, and it says so only when you send the wrong type.
  contests: 'NONE',
  medicalOrTreatmentInformation: 'NONE',

  // Required, and the app has no ad SDK of any kind.
  advertising: false,
  gambling: false,
  lootBox: false,
  // TRUE, and it was false until 22 September 2026. The app is structured exercise:
  // workouts the coach publishes, a timer that logs minutes trained, a daily streak.
  // App Privacy declares Fitness data for exactly that reason, and an age-rating form
  // saying the same app has no health or wellness content contradicts the label a
  // reviewer reads beside it. It is a capability shown to parents, not a rating raise,
  // and ageRatingOverrideV2 below already fixes the band at 13+.
  healthOrWellnessTopics: true,
  messagingAndChat: true,
  userGeneratedContent: true,
  socialMedia: false,
  // Only meaningful when socialMedia is true, and this is not social media.
  socialMediaAgeRestricted: false,
  // The only web view renders HTML the coach publishes and is sandboxed
  // (src/workflowBridge.ts). There is no address bar and no way to reach the web.
  unrestrictedWebAccess: false,
  // No age verification of any kind: the coach knows every family personally.
  ageAssurance: false,
  // Athletes under 13 are given no login; their family uses the parent's account.
  parentalControls: false,

  // APPLE COMPUTES 4+ FROM THE ANSWERS ABOVE AND THAT IS WRONG FOR THIS PRODUCT.
  // Under the age rating system Apple moved to in 2025, private chat and
  // user-generated content no longer raise the band by themselves; they are shown to
  // parents as capabilities instead. Left at the computed rating this app would be
  // offered to under-13s, and the whole COPPA position here is that an athlete under
  // 13 gets no login at all and trains from the parent's account. The override is
  // how a developer says the intended audience is older than the content implies.
  ageRatingOverrideV2: 'THIRTEEN_PLUS',
};

export const REVIEW_NOTES = `WHAT THE APP IS AND WHO IT IS FOR
The team app for Geneva College men's and women's tennis (Beaver Falls, Pennsylvania): messages between the coaches and the players, the practice calendar, and a match tracker with live stats. Not a social network, a marketplace or an internal business tool. Audience: the coaches, the college players (18 and over), and, for any player under 18, a parent or guardian invited by the coach. Accounts exist only by invitation to an email address the coach has on file.

HOW TO SET UP AND REACH EVERY FEATURE
Use the demo account in the fields above. It is permanently verified: no one-time code, SMS, secondary device or inbox. It is already attached to a player record with two conversations and a calendar. Messages is the conversation with the coach. Calendar has scheduled workouts; tapping one opens a training timer. Locker holds worksheets, including the Match Tracker, which uses the camera and microphone. You holds the consent control, notification settings, and Account, which contains deletion. Nothing is sold in the app.

EXTERNAL SERVICES
Firebase Authentication (Google) for sign-in and Cloud Firestore (Google) for messages, schedules and match and training records. Nothing else. No analytics, crash reporting, advertising, tracking or AI service, and no payment processor, because nothing is sold. Notifications are local only, scheduled by the device clock: there is no push server and no APNs token. The Match Tracker's camera mode downloads a pose-detection library from jsDelivr and its model from Google on first use, and the worksheets load fonts from Google Fonts; the video is then analysed on the device. A coach may optionally connect their own Google Sheet so match statistics are posted there.

REGIONAL DIFFERENCES
None. The app behaves identically everywhere, is English only, with no geo-gating or region-specific content.

REGULATED INDUSTRY AND THIRD-PARTY MATERIAL
Neither applies. This is college tennis. All content is written by the coaches or typed by the players; no licensed third-party material is included.

SAFETY, SINCE A PLAYER MAY BE A MINOR
Players 18 and over manage their own consent and have no parent on their conversation. For a player under 18, a guardian is a permanent reader on every conversation between the coach and that player, enforced by Firestore Security Rules, not by the UI. The coach cannot remove the guardian, nor edit or delete a message. The player sees a banner saying so. A player under 18 cannot send a message until the guardian grants consent, and the guardian can revoke it at any moment, locking the conversation immediately. Players under 13 get no login; those families use the parent's account, which is why the rating is 13 and over.

USER GENERATED CONTENT, REPORTING AND BLOCKING
The only content anyone creates is a message to their own coach and answers typed into a worksheet. There is no feed, profile or search, and no way for one user to reach another, so nobody meets a stranger's content. Reporting: You tab, "Report a concern", which opens an email to the account holder. It deliberately does not go to the coach, so a player can report the one adult they talk to. Blocking: for a player under 18, the guardian's consent switch on the You tab immediately stops that conversation, and each conversation can be muted. We will add any further control Apple considers necessary.

CAMERA AND MICROPHONE
The Match Tracker, one optional tool, uses them. The camera watches the court to follow the ball and both players; the microphone listens for the pop of the racket to time each shot. No image or audio is ever recorded or transmitted. Each asks before opening the hardware, and the app works fully without either.

ACCOUNT DELETION
You tab, under Account. It deletes the login and that account's settings. Messages are retained deliberately and the screen says so: they are the safety record a guardian is promised, and nobody, the coach included, can delete one.`;

// App Store Connect caps the review notes at 4000 characters and refuses a longer
// one at the API, after the rest of the metadata has already been pushed. Fail here
// instead, where the message can say which field and by how much.
if (REVIEW_NOTES.length > 4000) {
  throw new Error(
    'REVIEW_NOTES is ' + REVIEW_NOTES.length + ' characters; App Store Connect allows 4000.'
  );
}

// ---------------------------------------------------------------------------------
// API client. ES256, raw (P1363) signature -- a DER one is rejected as malformed.
// ---------------------------------------------------------------------------------

const b64u = (b) => Buffer.from(b).toString('base64url');

function token() {
  const keyId = need('ASC_KEY_ID');
  const issuer = need('ASC_ISSUER_ID');
  const pem = process.env.ASC_KEY_P8
    ?? readFileSync(need('ASC_KEY_P8_PATH'), 'utf8');

  const now = Math.floor(Date.now() / 1000);
  const head = b64u(JSON.stringify({ alg: 'ES256', kid: keyId, typ: 'JWT' }));
  const body = b64u(JSON.stringify({ iss: issuer, iat: now, exp: now + 600, aud: 'appstoreconnect-v1' }));
  const s = createSign('SHA256');
  s.update(`${head}.${body}`);
  return `${head}.${body}.${b64u(s.sign({ key: createPrivateKey(pem), dsaEncoding: 'ieee-p1363' }))}`;
}

/** The highest of a list of version strings, or null. */
export const latestVersion = (list) => list.reduce((a, b) => (!a || semverLess(a, b) ? b : a), null);

/** True when version a sorts strictly before b, numerically per dot-separated part. */
export function semverLess(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] || 0, y = pb[i] || 0;
    if (x !== y) return x < y;
  }
  return false;
}

function need(name) {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set. See the header of scripts/appstore-metadata.mjs.`);
  return v;
}

export async function asc(path, { method = 'GET', body } = {}) {
  const url = path.startsWith('http') ? path : `https://api.appstoreconnect.apple.com/v1/${path}`;
  const res = await fetch(url, {
    method,
    headers: { authorization: `Bearer ${token()}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(`${method} ${url} -> ${res.status}\n${JSON.stringify(json?.errors ?? json, null, 2)}`);
  return json;
}

/** App Store Connect echoes text back with its own line endings and edges. */
const norm = (v) => (typeof v === 'string' ? v.replace(/\r\n/g, '\n').trim() : v);

/**
 * Split `wanted` against what App Store Connect already holds. `changed` differs;
 * `blind` is a key the API never returns (write-only), which cannot be compared, so
 * a push always sends it and a read-back cannot hold it against the listing. A key
 * that comes back null is NOT blind: null is a real answer meaning "unset".
 */
export function diffAttrs(current, wanted) {
  const changed = {};
  const blind = [];
  for (const [k, v] of Object.entries(wanted)) {
    if (current?.[k] === undefined) blind.push(k);
    else if (norm(current[k]) !== norm(v)) changed[k] = v;
  }
  return { changed, blind };
}

/** PATCH only what differs from `current`. Under --dry, say what differs and move on. */
async function patch(type, id, wanted, label, current) {
  const { changed, blind } = diffAttrs(current, wanted);
  const keys = Object.keys(changed);
  if (DRY) {
    if (keys.length) {
      pending.push(label);
      console.log(`  would patch ${label}: ${keys.join(', ')}`);
    } else {
      console.log(`  ${label}: already current`);
    }
    if (blind.length) console.log(`    (not readable back, always sent: ${blind.join(', ')})`);
    return;
  }
  const send = { ...changed, ...Object.fromEntries(blind.map((k) => [k, wanted[k]])) };
  if (!Object.keys(send).length) { console.log(`  ${label}: already current`); return; }
  await asc(`${type}/${id}`, { method: 'PATCH', body: { data: { type, id, attributes: send } } });
  console.log(`  ${label}: ${Object.keys(send).join(', ')}`);
}

/** Record something a dry run would change that is not an attribute PATCH. */
function wouldChange(label, what) {
  pending.push(label);
  console.log(`  would ${what}`);
}

// ---------------------------------------------------------------------------------

export async function push() {
  // A placeholder URL pushed to App Store Connect is a dead link in front of App Review.
  // Dry runs may print them; a real push may not.
  const dead = placeholderUrls();
  if (!DRY && dead.length) {
    throw new Error(
      `${dead.map(([name]) => name).join(', ')} still point at the placeholder site. ` +
        'Set them to your real pages (repository variables) before pushing the listing.'
    );
  }

  const { data: [app] } = await asc(`apps?filter[bundleId]=${BUNDLE_ID}`);
  if (!app) throw new Error(`no app record for ${BUNDLE_ID}`);
  console.log(`app ${app.id} (${app.attributes.name})`);

  // Nothing in this app plays music, shows film or quotes a book. Left unanswered,
  // Apple holds the submission for it.
  await patch('apps', app.id, { contentRightsDeclaration: 'DOES_NOT_USE_THIRD_PARTY_CONTENT' }, 'content rights', app.attributes);

  // The version comes FIRST, before anything app-level: creating the next version is
  // what makes App Store Connect open a new editable app info record, and the subtitle,
  // categories and age rating below have to be written to that one, not the live one.

  // ---- the version being prepared ------------------------------------------------
  // EVERY EDITABLE STATE, not just PREPARE_FOR_SUBMISSION. A rejected version sits in
  // REJECTED, and that is precisely when the review notes most need rewriting -- Apple
  // rejected 1.0.4 build 9 asking for answers in the Notes field, and this script could
  // not reach the version to put them there. It failed with "create one in App Store
  // Connect", which was misleading: the version existed and was editable in the UI.
  //
  // The states are ordered by how much they mean "this is the one being worked on", and
  // the first match wins, so a fresh PREPARE_FOR_SUBMISSION still beats a stale rejected
  // one if both somehow exist.
  const EDITABLE = [
    'PREPARE_FOR_SUBMISSION',
    'DEVELOPER_REJECTED',
    'REJECTED',
    'METADATA_REJECTED',
    'INVALID_BINARY',
  ];
  let version = null;
  for (const state of EDITABLE) {
    const { data } = await asc(`apps/${app.id}/appStoreVersions?filter[appStoreState]=${state}&limit=1`);
    if (data[0]) {
      version = data[0];
      if (state !== 'PREPARE_FOR_SUBMISSION') console.log(`  version is ${state}, which is editable -- patching it`);
      break;
    }
  }
  // THE NEXT RELEASE. Once a version is approved, App Store Connect holds no editable
  // record until somebody creates one, so an unattended tag would stop right here. A tag
  // is the decision to ship that version, so the record is created for it -- only when
  // the version is above every record that exists, so a mistyped dispatch cannot litter
  // the app with stray versions. Nothing is submitted.
  if (!version && WAIT_FOR) {
    const { data: all } = await asc(`apps/${app.id}/appStoreVersions?limit=200`);
    const top = latestVersion(all.map((v) => v.attributes.versionString));
    if (top && !semverLess(top, WAIT_FOR)) {
      throw new Error(`no version is editable, and ${WAIT_FOR} is not above the latest record, ${top}.`);
    }
    if (DRY) {
      wouldChange(`version ${WAIT_FOR}`, `create App Store version ${WAIT_FOR}, then fill it in`);
      return { appId: app.id, versionId: null };
    }
    ({ data: version } = await asc('appStoreVersions', {
      method: 'POST',
      body: {
        data: {
          type: 'appStoreVersions',
          attributes: { platform: 'IOS', versionString: WAIT_FOR },
          relationships: { app: { data: { type: 'apps', id: app.id } } },
        },
      },
    }));
    console.log(`  created App Store version ${WAIT_FOR}`);
    await settle(app.id, version.id);
  }
  if (!version) {
    throw new Error(
      `no version is in an editable state (${EDITABLE.join(', ')}). ` +
      'Either create one in App Store Connect, or the current version is already in review ' +
      'or released, in which case metadata cannot be changed until a new version exists.',
    );
  }

  // ---- the app-level record: name, subtitle, privacy policy, categories ----------
  // Once a version has shipped there are two: the live one, which cannot be edited, and
  // the one opened for the next version. Write to the one still being prepared.
  const { data: infos } = await asc(`apps/${app.id}/appInfos`);
  const info = openInfo(infos) ?? infos[0];
  const { data: infoLocs } = await asc(`appInfos/${info.id}/appInfoLocalizations`);
  const enInfo = infoLocs.find((l) => l.attributes.locale === 'en-US');
  await patch('appInfoLocalizations', enInfo.id, APP_INFO, 'subtitle and privacy policy URL', enInfo.attributes);

  // A category that cannot be read counts as unset, so a read-back fails loudly
  // rather than passing on a relationship nobody looked at.
  const category = async (rel) => (await asc(`appInfos/${info.id}/${rel}`).catch(() => null))?.data?.id ?? null;
  const [primary, secondary] = await Promise.all([category('primaryCategory'), category('secondaryCategory')]);
  if (primary === CATEGORIES.primary && secondary === CATEGORIES.secondary) {
    console.log(`  categories: already ${primary} / ${secondary}`);
  } else if (DRY) {
    wouldChange('categories', `set categories: ${primary} / ${secondary} -> ${CATEGORIES.primary} / ${CATEGORIES.secondary}`);
  } else {
    // Categories are relationships, not attributes, so they do not go through patch().
    await asc(`appInfos/${info.id}`, {
      method: 'PATCH',
      body: {
        data: {
          type: 'appInfos',
          id: info.id,
          relationships: {
            primaryCategory: { data: { type: 'appCategories', id: CATEGORIES.primary } },
            secondaryCategory: { data: { type: 'appCategories', id: CATEGORIES.secondary } },
          },
        },
      },
    });
    console.log(`  categories ${CATEGORIES.primary} / ${CATEGORIES.secondary}`);
  }

  // Read the declaration rather than assuming it shares the appInfo's id. It does
  // today, and a listing of appInfos does not carry the relationship at all, so
  // assuming it is a guess that happens to work.
  const rating = await asc(`appInfos/${info.id}/ageRatingDeclaration`);
  await patch('ageRatingDeclarations', rating.data.id, AGE_RATING, 'age rating questionnaire', rating.data.attributes);


  // The version string has to equal the build's CFBundleShortVersionString, and the
  // workflow stamps that from the git tag -- so the newest build decides it, not
  // app.json, whose expo.version has sat at 1.0.0 across every release on purpose.
  const build = WAIT_FOR ? await waitForBuild(app.id, WAIT_FOR) : await newestBuild(app.id);
  console.log(`version ${version.attributes.versionString} -> ${build.short} (build ${build.number})`);

  // NEVER GO BACKWARDS. Only a v* tag stamps a real version into a build; a
  // workflow_dispatch run or the monthly keep-alive has no tag, so it ships app.json's
  // 1.0.0. The newest build then "decides" the version, and this script rewrote the
  // 1.0.4 record down to 1.0.0 in a dry run on 22 September 2026 -- the pre-resubmission
  // audit had flagged exactly this and it was dismissed as unable to fire. It fired
  // the first time anyone dispatched an iOS build by hand. Refuse, and name the fix.
  if (semverLess(build.short, version.attributes.versionString)) {
    throw new Error(
      `newest build ${build.number} is version ${build.short}, below the record's ` +
      `${version.attributes.versionString}. That build came from a run with no v* tag. ` +
      'Tag a release (git tag vX.Y.Z && git push origin vX.Y.Z) so the build carries a ' +
      'real version, wait for Apple to process it, and run this again.'
    );
  }

  await patch('appStoreVersions', version.id, { versionString: build.short, copyright: COPYRIGHT },
    `version ${build.short}, copyright`, version.attributes);

  const attached = (await asc(`appStoreVersions/${version.id}/build`).catch(() => null))?.data?.id ?? null;
  if (attached === build.id) {
    console.log(`  build ${build.number}: already attached`);
  } else if (DRY) {
    wouldChange(`build ${build.number}`, `attach build ${build.number}`);
  } else {
    await asc(`appStoreVersions/${version.id}/relationships/build`, {
      method: 'PATCH',
      body: { data: { type: 'builds', id: build.id } },
    });
    console.log(`  attached build ${build.number}`);
  }

  const { data: verLocs } = await asc(`appStoreVersions/${version.id}/appStoreVersionLocalizations`);
  const enVer = verLocs.find((l) => l.attributes.locale === 'en-US');
  if (enVer) {
    await patch('appStoreVersionLocalizations', enVer.id, LISTING, 'description, keywords and URLs', enVer.attributes);
  } else if (DRY) {
    wouldChange('en-US listing', 'create the en-US description, keywords and URLs');
  } else {
    await asc('appStoreVersionLocalizations', {
      method: 'POST',
      body: {
        data: {
          type: 'appStoreVersionLocalizations',
          attributes: { locale: 'en-US', ...LISTING },
          relationships: { appStoreVersion: { data: { type: 'appStoreVersions', id: version.id } } },
        },
      },
    });
    console.log('  created the en-US description, keywords and URLs');
  }

  // ---- what App Review is told ---------------------------------------------------
  const review = {
    contactFirstName: process.env.APP_REVIEW_CONTACT_FIRST || 'Josiah',
    contactLastName: process.env.APP_REVIEW_CONTACT_LAST || 'Shaver',
    contactEmail: process.env.APP_REVIEW_CONTACT_EMAIL || 'shaver3josiah@gmail.com',
    contactPhone: process.env.APP_REVIEW_CONTACT_PHONE || '+1 503 686 8371',
    demoAccountRequired: true,
    // THE SAME CREDENTIAL scripts/review-account.mjs provisions and proves, under the
    // name that script uses. Two env vars for one account is how they drift, and a
    // drifted demo password in App Store Connect is the exact rejection class that
    // cost version code 18 on Play. APP_REVIEW_DEMO_* still wins if it is set, so an
    // existing environment keeps working.
    demoAccountName: process.env.APP_REVIEW_DEMO_EMAIL || need('REVIEW_EMAIL'),
    demoAccountPassword: process.env.APP_REVIEW_DEMO_PASSWORD || need('REVIEW_PASSWORD'),
    notes: REVIEW_NOTES,
  };

  const existing = await asc(`appStoreVersions/${version.id}/appStoreReviewDetail`).catch(() => null);
  if (existing?.data) {
    await patch('appStoreReviewDetails', existing.data.id, review, 'review notes and demo account', existing.data.attributes);
  } else if (DRY) {
    wouldChange('review detail', 'create the review detail (demo account + notes)');
  } else {
    await asc('appStoreReviewDetails', {
      method: 'POST',
      body: {
        data: {
          type: 'appStoreReviewDetails',
          attributes: review,
          relationships: { appStoreVersion: { data: { type: 'appStoreVersions', id: version.id } } },
        },
      },
    });
    console.log('  review notes and demo account');
  }

  await setFreePrice(app.id);

  return { appId: app.id, versionId: version.id, infoId: info.id, build };
}

/**
 * A price schedule with one free tier. Without any schedule the app has no price at
 * all and the submission is held for it, which reads in the console as the vague
 * "Pricing and Availability" warning rather than as a missing number.
 *
 * The price point id encodes the app, so it is looked up rather than hard-coded, and
 * the free one is the row whose customerPrice is zero.
 */
async function setFreePrice(appId) {
  const existing = await asc(`appPriceSchedules/${appId}/manualPrices?limit=1`).catch(() => null);
  if (existing?.data?.length) { console.log('  price already set'); return; }

  const { data: points } = await asc(`apps/${appId}/appPricePoints?filter[territory]=USA&limit=200`);
  const free = points.find((p) => Number(p.attributes.customerPrice) === 0);
  if (!free) throw new Error('no free price point offered for USA');

  if (DRY) { wouldChange('price', 'set the price to Free, base territory USA'); return; }

  await asc('appPriceSchedules', {
    method: 'POST',
    body: {
      data: {
        type: 'appPriceSchedules',
        relationships: {
          app: { data: { type: 'apps', id: appId } },
          baseTerritory: { data: { type: 'territories', id: 'USA' } },
          manualPrices: { data: [{ type: 'appPrices', id: '${new-price}' }] },
        },
      },
      included: [{
        type: 'appPrices',
        id: '${new-price}',
        relationships: {
          appPricePoint: { data: { type: 'appPricePoints', id: free.id } },
          territory: { data: { type: 'territories', id: 'USA' } },
        },
      }],
    },
  });
  console.log('  price: Free, base territory USA');
}

/** The app info still being prepared, as opposed to the live one a release leaves behind. */
const OPEN_INFO = ['PREPARE_FOR_SUBMISSION', 'DEVELOPER_REJECTED', 'REJECTED'];
const openInfo = (infos) => infos.find((i) => OPEN_INFO.includes(i.attributes.state ?? i.attributes.appStoreState));

/**
 * Wait until App Store Connect LISTS a version it just created, and the editable app
 * info that came with it. The create returns at once but the lists lag for tens of
 * seconds (fastlane retries its own lookups for minutes for the same reason); reading
 * them too early wrote the subtitle to the live record and made a read-back seconds
 * later report a version that did exist as missing.
 */
async function settle(appId, versionId) {
  const deadline = Date.now() + 5 * 60_000;
  for (;;) {
    const { data: open } = await asc(`apps/${appId}/appStoreVersions?filter[appStoreState]=PREPARE_FOR_SUBMISSION&limit=5`);
    const { data: infos } = await asc(`apps/${appId}/appInfos`);
    if (open.some((v) => v.id === versionId) && openInfo(infos)) return;
    if (Date.now() > deadline) {
      throw new Error('App Store Connect has not listed the new version and its editable app info after 5 minutes. Run the workflow again; every write is idempotent.');
    }
    console.log('  waiting for App Store Connect to list the new version');
    await new Promise((r) => setTimeout(r, 10_000));
  }
}

/** The build with the highest marketing version, and the highest build number within it. */
export function pickHighest(builds) {
  let best = null;
  for (const b of builds) {
    if (!best || semverLess(best.short, b.short) ||
        (best.short === b.short && Number(b.number) > Number(best.number))) best = b;
  }
  return best;
}

/**
 * The VALID build with the highest marketing version, NOT the most recently uploaded.
 * The monthly TestFlight keep-alive and any hand-dispatched build carry no tag and
 * upload as app.json's 1.0.0; "most recent" then picked that, tripped the guard in
 * push(), and left every dispatch -- the release panel's included -- unable to push
 * the listing until somebody tagged a new binary.
 */
async function newestBuild(appId) {
  // The top-level /builds collection, not apps/{id}/builds: the relationship
  // endpoint accepts no filter, no sort and no include, so it can only hand back
  // whatever order it likes.
  const { data, included = [] } = await asc(
    `builds?filter[app]=${appId}&filter[processingState]=VALID&sort=-uploadedDate&limit=50&include=preReleaseVersion`,
  );
  const versionOf = new Map(included.filter((i) => i.type === 'preReleaseVersions').map((i) => [i.id, i.attributes.version]));
  const best = pickHighest(data
    .map((b) => ({ id: b.id, number: b.attributes.version, short: versionOf.get(b.relationships?.preReleaseVersion?.data?.id) }))
    .filter((b) => b.short));
  if (!best) throw new Error('no VALID build is uploaded yet');
  return best;
}

/**
 * The newest build of exactly `version`, once Apple has processed it. An upload is
 * PROCESSING for anywhere from five minutes to an hour, and attaching the newest VALID
 * build during that window would quietly attach the previous release instead.
 */
async function waitForBuild(appId, version) {
  const deadline = Date.now() + WAIT_MINUTES * 60_000;
  for (;;) {
    const { data } = await asc(
      `builds?filter[app]=${appId}&filter[preReleaseVersion.version]=${encodeURIComponent(version)}` +
      '&sort=-uploadedDate&limit=1',
    );
    const b = data[0];
    const state = b?.attributes.processingState;
    if (state === 'VALID') return { id: b.id, number: b.attributes.version, short: version };
    if (state === 'INVALID' || state === 'FAILED') {
      throw new Error(`build ${b.attributes.version} of ${version} is ${state}. Apple emails the reason to the account holder.`);
    }
    if (Date.now() > deadline) {
      throw new Error(`no processed build of ${version} after ${WAIT_MINUTES} minutes (last seen: ${state ?? 'not uploaded'}).`);
    }
    console.log(`  waiting for Apple to process ${version} (${state ?? 'not uploaded yet'})`);
    await new Promise((r) => setTimeout(r, 60_000));
  }
}

/** Everything the API cannot answer, read back so the gap is a list rather than a surprise. */
export async function remaining({ appId, versionId }) {
  const gaps = [];

  if (versionId) {
    const { data: locs } = await asc(`appStoreVersions/${versionId}/appStoreVersionLocalizations`);
    const en = locs.find((l) => l.attributes.locale === 'en-US');
    const { data: sets } = await asc(`appStoreVersionLocalizations/${en.id}/appScreenshotSets`);
    if (!sets.length) gaps.push('screenshots: none uploaded (npm run screenshots -- --upload)');

    // An UPDATE cannot be submitted without it, and it is the one field that changes
    // every release, so it is written in the console rather than kept in this file.
    const { data: live } = await asc(`apps/${appId}/appStoreVersions?filter[appStoreState]=READY_FOR_SALE&limit=1`);
    if (live.length && !en.attributes.whatsNew?.trim()) {
      gaps.push("What's New: empty, and an update cannot be submitted without it (App Store Connect, the version page)");
    }
  }

  // App Privacy is NOT in the App Store Connect API -- every appDataUsage path
  // answers 404, and fastlane cannot reach it either. It is a console form, and it
  // is the one remaining thing this script cannot check OR fill, so it is always
  // reported rather than guessed at.
  gaps.push('App Privacy: answer the nutrition label in the console, from docs/APP-STORE.md section 5 (no API exists)');

  const price = await asc(`appPriceSchedules/${appId}/manualPrices?limit=1`).catch(() => null);
  if (!price?.data?.length) gaps.push('price: no price tier is set');

  return gaps;
}

if (process.argv[1]?.endsWith('appstore-metadata.mjs')) {
  const ids = await push();
  const gaps = await remaining(ids);
  console.log(gaps.length ? `\nstill needed before review:\n  - ${gaps.join('\n  - ')}` : '\nnothing else outstanding');
  if (EXPECT_CLEAN) {
    if (pending.length) {
      console.error(`\nApp Store Connect does not match the file: ${pending.join('; ')}`);
      process.exit(1);
    }
    console.log('\nread back: App Store Connect matches the file');
  }
}
