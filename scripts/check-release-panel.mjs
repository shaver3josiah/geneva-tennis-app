/**
 * node --test scripts/check-release-panel.mjs  (npm run test:panel)
 *
 * Offline. The release panel can set repository secrets and push tags from a server
 * on localhost, so the parts that decide who may call it and what it will store are
 * pinned here.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { allowed, checkSecret, latestTag, nextPatch, extractOutput, SKIP_MARKER } from './release-panel.mjs';

// GitHub starts no workflow for a tag on a commit carrying one of these, so the panel
// must refuse such a tip rather than spend the version number on a release that
// never builds. The keep-alive message is the one that used to carry [skip ci].
test('a skip marker at the tip is caught, the keep-alive message is not', () => {
  for (const m of ['x [skip ci]', 'x [CI SKIP]', '[no ci] y', 'z [skip actions]', 'a\n\nskip-checks: true']) {
    assert.ok(SKIP_MARKER.test(m), m);
  }
  assert.equal(SKIP_MARKER.test('chore: TestFlight keep-alive, build 42'), false);
  assert.equal(SKIP_MARKER.test('Skip CI flakes in the rules test'), false);
});

const TOKEN = 'a'.repeat(48);

test('only its own host with its own token gets in', () => {
  assert.equal(allowed({ host: '127.0.0.1:5000', 'x-panel-token': TOKEN }, 5000, TOKEN), true);
  assert.equal(allowed({ host: '127.0.0.1:5000' }, 5000, TOKEN), false, 'no token');
  assert.equal(allowed({ host: '127.0.0.1:5000', 'x-panel-token': 'b'.repeat(48) }, 5000, TOKEN), false, 'wrong token');
  assert.equal(allowed({ host: '127.0.0.1:5000', 'x-panel-token': 'a' }, 5000, TOKEN), false, 'short token');
  // DNS rebinding: a hostile name resolving to 127.0.0.1 arrives with its own Host.
  assert.equal(allowed({ host: 'evil.example:5000', 'x-panel-token': TOKEN }, 5000, TOKEN), false);
  assert.equal(allowed({ host: 'localhost:5000', 'x-panel-token': TOKEN }, 5000, TOKEN), false);
});

test('it sets only the secrets a release reads', () => {
  assert.match(checkSecret('GITHUB_TOKEN', 'x'), /not a secret this panel sets/);
  assert.match(checkSecret('__proto__', 'x'), /not a secret this panel sets/);
  assert.match(checkSecret('toString', 'x'), /not a secret this panel sets/);
});

test('the usual wrong pastes are refused before GitHub stores them', () => {
  assert.match(checkSecret('GOOGLE_PLAY_SERVICE_ACCOUNT_JSON', 'not json'), /not JSON/);
  assert.match(checkSecret('GOOGLE_PLAY_SERVICE_ACCOUNT_JSON', '{"type":"authorized_user"}'), /not a service account/);
  assert.equal(checkSecret('GOOGLE_PLAY_SERVICE_ACCOUNT_JSON',
    JSON.stringify({ type: 'service_account', client_email: 'x@y.iam.gserviceaccount.com', private_key: 'k' })), null);
  // A base64'd .p8 fails at export twenty minutes into a build.
  assert.match(checkSecret('ASC_KEY_P8', 'LS0tLS1CRUdJTi'), /not base64/);
  assert.equal(checkSecret('ASC_KEY_P8', '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n'), null);
  assert.equal(checkSecret('ASC_KEY_ID', '89H35WL893'), null);
  assert.match(checkSecret('REVIEW_PASSWORD', 'short'), /8 characters/);
  assert.match(checkSecret('ANDROID_KEY_ALIAS', '   '), /empty/);
  assert.match(checkSecret('ENV_FILE', 'FOO=1'), /EXPO_PUBLIC_FIREBASE_PROJECT_ID/);
});

test('versions: the highest tag, compared as numbers, and the next patch', () => {
  assert.equal(latestTag(['v1.0.9', 'v1.0.10', 'v1.0.2', 'junk', 'v2.0']), '1.0.10');
  assert.equal(latestTag([]), null);
  assert.equal(nextPatch('1.0.9'), '1.0.10');
  assert.equal(nextPatch(null), '1.0.0');
});

test('the run output is what the script printed, not the echoed script', () => {
  const log = [
    'metadata\tSet up job\t2026-09-23T10:00:00.0000000Z Current runner version',
    'metadata\tPush the listing\t\uFEFF2026-09-23T10:00:01.0000000Z ##[group]Run set -euo pipefail',
    'metadata\tPush the listing\t2026-09-23T10:00:01.1000000Z   ASC_KEY_P8: ***',
    'metadata\tPush the listing\t2026-09-23T10:00:01.2000000Z ##[endgroup]',
    'metadata\tPush the listing\t2026-09-23T10:00:02.0000000Z app 1234567890 (Geneva Tennis)',
    'metadata\tRead it back\t2026-09-23T10:00:05.0000000Z ##[endgroup]',
    'metadata\tRead it back\t2026-09-23T10:00:06.0000000Z ##[error]Process completed with exit code 1.',
  ].join('\n');
  assert.equal(extractOutput(log),
    '== Push the listing\napp 1234567890 (Geneva Tennis)\n== Read it back\nerror: Process completed with exit code 1.');
});
