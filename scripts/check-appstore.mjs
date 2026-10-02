/**
 * node --test scripts/check-appstore.mjs  (npm run test:appstore)
 *
 * Offline. Pins the guard that stops appstore-metadata.mjs rewriting a version record
 * DOWN to an untagged build's 1.0.0 -- which it would have done on 22 September 2026,
 * the first time an iOS build was dispatched by hand.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { semverLess, REVIEW_NOTES, diffAttrs, pickHighest, latestVersion } from './appstore-metadata.mjs';

// The monthly keep-alive uploads an untagged 1.0.0 build AFTER the real release. Picking
// the most recent upload chose it, tripped the never-go-backwards guard, and left every
// dispatch unable to push the listing until a new binary was tagged.
test('the highest version wins, not the latest upload', () => {
  const builds = [
    { id: 'keepalive', number: '14', short: '1.0.0' },
    { id: 'rel', number: '11', short: '1.0.5' },
    { id: 'old', number: '9', short: '1.0.4' },
  ];
  assert.equal(pickHighest(builds).id, 'rel');
});

test('within one version the higher build number wins, compared as numbers', () => {
  const builds = [{ id: 'a', number: '9', short: '1.0.5' }, { id: 'b', number: '11', short: '1.0.5' }];
  assert.equal(pickHighest(builds).id, 'b');
  assert.equal(pickHighest([]), null);
});

test('the latest version record, which gates creating the next one', () => {
  assert.equal(latestVersion(['1.0.4', '1.0.10', '1.0.9']), '1.0.10');
  assert.equal(latestVersion([]), null);
});

// diffAttrs is what --expect-clean reads a push back through. If it calls a real
// difference equal, a failed push reads as success; if it calls an echo different,
// the read-back fails forever.
test('a value App Store Connect already holds is not sent again', () => {
  const r = diffAttrs({ subtitle: 'Coach', keywords: 'a,b' }, { subtitle: 'Coach', keywords: 'a,b,c' });
  assert.deepEqual(r, { changed: { keywords: 'a,b,c' }, blind: [] });
});

test('CRLF and edge whitespace in the echo do not count as a change', () => {
  const r = diffAttrs({ notes: 'one\r\ntwo\n' }, { notes: 'one\ntwo' });
  assert.deepEqual(r.changed, {});
});

test('null is a real answer (unset), a missing key is unreadable', () => {
  const r = diffAttrs({ subtitle: null }, { subtitle: 'Coach', demoAccountPassword: 'x' });
  assert.deepEqual(r, { changed: { subtitle: 'Coach' }, blind: ['demoAccountPassword'] });
});

test('booleans and enums compare by value', () => {
  const r = diffAttrs({ advertising: false, contests: 'NONE' }, { advertising: true, contests: 'NONE' });
  assert.deepEqual(r.changed, { advertising: true });
});

test('an untagged 1.0.0 build is below a 1.0.4 record', () => {
  assert.equal(semverLess('1.0.0', '1.0.4'), true);
});

test('a real bump, and the same version, both pass', () => {
  assert.equal(semverLess('1.0.5', '1.0.4'), false);
  assert.equal(semverLess('1.0.4', '1.0.4'), false);
});

test('parts compare as numbers, not strings', () => {
  assert.equal(semverLess('1.0.10', '1.0.9'), false);
  assert.equal(semverLess('1.1', '1.0.9'), false);
});

test('the review notes fit App Store Connect', () => {
  // Also enforced at import, but a test names the failure instead of crashing the suite.
  assert.ok(REVIEW_NOTES.length <= 4000, `${REVIEW_NOTES.length} characters`);
});
