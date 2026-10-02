/**
 * Offline self-check for scripts/play-upload.mjs. No network, no credentials.
 *
 * WHAT IT IS ACTUALLY GUARDING. This script publishes to the Play Store, and every
 * failure it can have is silent in a different way:
 *
 *  - Sending the version code from app.json instead of the one Play returns puts the
 *    release on a track pointing at a bundle nobody uploaded. Play accepts it.
 *  - Skipping the commit leaves an edit that looks fine in the log and ships nothing.
 *  - Throwing without deleting the edit strands the uploaded bundle where the console
 *    will not show it, and the next run's upload collides with it.
 *  - RS256 vs Apple's ES256: Google answers a wrongly-signed assertion with
 *    "invalid_grant" and no mention of the algorithm.
 *
 * So the order and the shape of the four calls are pinned here rather than discovered
 * against the live store.
 */
import { strict as assert } from 'node:assert';
import { generateKeyPairSync } from 'node:crypto';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { publish } from './play-upload.mjs';

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const KEY = {
  client_email: 'ci@geneva-tennis.iam.gserviceaccount.com',
  private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
  token_uri: 'https://oauth2.googleapis.com/token',
};

const dir = mkdtempSync(join(tmpdir(), 'play-check-'));
const AAB = join(dir, 'app.aab');
const BYTES = Buffer.from('not really a bundle, but the bytes must arrive intact');
writeFileSync(AAB, BYTES);

/** Records every call and answers from `routes`, first matching prefix wins. */
const recorder = (routes) => {
  const calls = [];
  const fetchImpl = async (url, opts = {}) => {
    calls.push({ url, method: opts.method || 'GET', headers: opts.headers || {}, body: opts.body });
    for (const [match, reply] of routes) {
      if (url.includes(match)) {
        const r = typeof reply === 'function' ? reply(calls.at(-1)) : reply;
        return {
          ok: r.ok !== false,
          status: r.status || (r.ok === false ? 500 : 200),
          json: async () => r.body ?? {},
          text: async () => JSON.stringify(r.body ?? {}),
        };
      }
    }
    throw new Error(`unrouted call: ${url}`);
  };
  return { calls, fetchImpl };
};

// The upload route has to be matched before the bare /edits route, since both appear
// in the same URL. Order it the way `publish` will hit it.
const routes = [
  ['oauth2.googleapis.com/token', { body: { access_token: 'tok-123' } }],
  ['uploadType=media', { body: { versionCode: 41 } }],
  [':commit', { body: {} }],
  ['/edits', { body: { id: 'edit-abc' } }],
];

let failures = 0;
const check = (name, fn) => {
  try { fn(); console.log(`  ok  ${name}`); }
  catch (e) { failures++; console.log(`FAIL  ${name}\n      ${e.message}`); }
};

console.log('play-upload self-check\n');

// ---- happy path -----------------------------------------------------------------
{
  const { calls, fetchImpl } = recorder(routes);
  const out = await publish({
    aab: AAB, track: 'internal', name: 'v1.0.5', notes: 'Fixed the keyboard.',
    key: KEY, fetchImpl, log: () => {},
  });

  const [token, edit, upload, track, commit] = calls;

  check('the access token is an RS256 service-account assertion', () => {
    const form = new URLSearchParams(token.body);
    assert.equal(form.get('grant_type'), 'urn:ietf:params:oauth:grant-type:jwt-bearer');
    const [h, p] = form.get('assertion').split('.');
    const header = JSON.parse(Buffer.from(h, 'base64url'));
    const claims = JSON.parse(Buffer.from(p, 'base64url'));
    assert.equal(header.alg, 'RS256', 'Google signs RS256; ES256 is Apple');
    assert.equal(claims.iss, KEY.client_email);
    assert.equal(claims.scope, 'https://www.googleapis.com/auth/androidpublisher');
    assert.ok(claims.exp > claims.iat);
  });

  check('an edit is opened first', () => {
    assert.equal(edit.method, 'POST');
    assert.match(edit.url, /applications\/com\.genevatennis\.app\/edits$/);
    assert.equal(edit.headers.authorization, 'Bearer tok-123');
  });

  check('the bundle bytes are uploaded verbatim as octet-stream', () => {
    assert.equal(upload.method, 'POST');
    assert.match(upload.url, /\/upload\/androidpublisher\/v3\/.*edits\/edit-abc\/bundles\?uploadType=media$/);
    assert.equal(upload.headers['content-type'], 'application/octet-stream');
    assert.ok(Buffer.isBuffer(upload.body), 'must send raw bytes, not JSON');
    assert.equal(Buffer.compare(upload.body, BYTES), 0);
  });

  check("the track takes Play's versionCode, not one we made up", () => {
    assert.equal(track.method, 'PUT');
    assert.match(track.url, /\/edits\/edit-abc\/tracks\/internal$/);
    const sent = JSON.parse(track.body);
    assert.deepEqual(sent.releases[0].versionCodes, ['41']);
    assert.equal(sent.releases[0].status, 'completed');
    assert.equal(sent.releases[0].name, 'v1.0.5');
    assert.deepEqual(sent.releases[0].releaseNotes, [{ language: 'en-US', text: 'Fixed the keyboard.' }]);
  });

  check('the edit is committed last, and nothing follows it', () => {
    assert.equal(commit.method, 'POST');
    assert.match(commit.url, /\/edits\/edit-abc:commit$/);
    assert.equal(calls.length, 5, 'exactly five calls: token, edit, upload, track, commit');
  });

  check('it reports the version code that actually shipped', () => {
    assert.equal(out.versionCode, 41);
    assert.equal(out.track, 'internal');
  });
}

// ---- release notes and name are optional -----------------------------------------
{
  const { calls, fetchImpl } = recorder(routes);
  await publish({ aab: AAB, key: KEY, fetchImpl, log: () => {} });
  check('no notes means no releaseNotes key at all', () => {
    const sent = JSON.parse(calls[3].body);
    assert.equal('releaseNotes' in sent.releases[0], false);
    assert.equal('name' in sent.releases[0], false);
    assert.match(calls[3].url, /tracks\/internal$/, 'internal is the default track');
  });
}

// ---- a failed upload must not strand the edit ------------------------------------
{
  const { calls, fetchImpl } = recorder([
    ['oauth2.googleapis.com/token', { body: { access_token: 'tok-123' } }],
    ['uploadType=media', { ok: false, status: 403, body: { error: { message: 'no permission' } } }],
    ['/edits', { body: { id: 'edit-abc' } }],
  ]);
  let threw = null;
  await publish({ aab: AAB, key: KEY, fetchImpl, log: () => {} }).catch((e) => { threw = e; });

  check('an upload failure rethrows and deletes the edit', () => {
    assert.ok(threw, 'must not swallow the failure');
    assert.match(threw.message, /403/);
    const del = calls.at(-1);
    assert.equal(del.method, 'DELETE');
    assert.match(del.url, /\/edits\/edit-abc$/);
  });
}

// ---- an upload that reports no version code is a failure, not a release ----------
{
  const { calls, fetchImpl } = recorder([
    ['oauth2.googleapis.com/token', { body: { access_token: 'tok-123' } }],
    ['uploadType=media', { body: { /* no versionCode */ } }],
    ['/edits', { body: { id: 'edit-abc' } }],
  ]);
  let threw = null;
  await publish({ aab: AAB, key: KEY, fetchImpl, log: () => {} }).catch((e) => { threw = e; });

  check('a bundle with no versionCode never reaches a track', () => {
    assert.ok(threw, 'silently committing this would publish nothing');
    assert.equal(calls.some((c) => c.method === 'PUT'), false);
    assert.equal(calls.at(-1).method, 'DELETE');
  });
}

// ---- Play refuses to send for review automatically -------------------------------
// What v1.0.6 hit on 30 September 2026: the upload worked and the commit came back
// 400, because the app has had a change reviewed before. The edit is still open, so
// the fix is to commit it again with the flag Google names, not to throw it away.
const NOT_AUTO = 'Changes cannot be sent for review automatically. Please set the query parameter changesNotSentForReview to true.';
{
  const logs = [];
  const { calls, fetchImpl } = recorder([
    ['oauth2.googleapis.com/token', { body: { access_token: 'tok-123' } }],
    ['uploadType=media', { body: { versionCode: 41 } }],
    [':commit', (c) => c.url.includes('changesNotSentForReview=true')
      ? { body: {} }
      : { ok: false, status: 400, body: { error: { code: 400, message: NOT_AUTO } } }],
    ['/edits', { body: { id: 'edit-abc' } }],
  ]);
  const out = await publish({ aab: AAB, key: KEY, fetchImpl, log: (l) => logs.push(l) });

  check('a commit Play will not auto-review is retried with the flag on the same edit', () => {
    const commits = calls.filter((c) => c.url.includes(':commit'));
    assert.equal(commits.length, 2);
    assert.match(commits[1].url, /\/edits\/edit-abc:commit\?changesNotSentForReview=true$/);
    assert.equal(calls.some((c) => c.method === 'DELETE'), false, 'the edit must not be thrown away');
  });
  check('it says the release still has to be sent for review by hand', () => {
    assert.equal(out.sentForReview, false);
    assert.ok(logs.some((l) => /::warning.*Send changes for review/.test(l)));
  });
}

// ---- any other commit failure still fails, and still cleans up --------------------
{
  const { calls, fetchImpl } = recorder([
    ['oauth2.googleapis.com/token', { body: { access_token: 'tok-123' } }],
    ['uploadType=media', { body: { versionCode: 41 } }],
    [':commit', { ok: false, status: 400, body: { error: { message: 'APK specifies a version code that has already been used.' } } }],
    ['/edits', { body: { id: 'edit-abc' } }],
  ]);
  let threw = null;
  await publish({ aab: AAB, key: KEY, fetchImpl, log: () => {} }).catch((e) => { threw = e; });
  check('an unrelated commit error is not retried with the flag', () => {
    assert.ok(threw);
    assert.equal(calls.filter((c) => c.url.includes(':commit')).length, 1);
    assert.equal(calls.at(-1).method, 'DELETE');
  });
}

// ---- a bad token is reported as a token failure ----------------------------------
{
  const { fetchImpl } = recorder([
    ['oauth2.googleapis.com/token', { ok: false, status: 400, body: { error: 'invalid_grant' } }],
  ]);
  let threw = null;
  await publish({ aab: AAB, key: KEY, fetchImpl, log: () => {} }).catch((e) => { threw = e; });
  check('a rejected assertion names the token exchange', () => {
    assert.ok(threw);
    assert.match(threw.message, /token exchange failed.*invalid_grant/s);
  });
}

console.log(failures ? `\n${failures} failing` : '\nall passing');
process.exit(failures ? 1 : 0);
