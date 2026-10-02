/**
 * node --test scripts/check-review-account.mjs  (or: npm run test:review)
 *
 * Offline. No credential, no network, no project. It covers the two things in
 * review-account.mjs that are worth failing loudly: the guardrail that keeps a real
 * family's athlete record out of a Google reviewer's hands, and the Firestore
 * value encoding those writes go through.
 *
 * The provisioning and verification paths are deliberately NOT mocked. Faking the
 * Identity Toolkit would only prove the fake agrees with itself; the honest test of
 * those is `--check` against the real project, which is what the script does last.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { val, fields, plain, unsafeTarget } from './review-account.mjs';

const REVIEW = 'owner+gtdemo@example.com';
const PLAYER = 'owner+gtplayer@example.com';

test('an empty or absent record is safe to write', () => {
  assert.equal(unsafeTarget({}, REVIEW, PLAYER), null);
  assert.equal(unsafeTarget(undefined, REVIEW, PLAYER), null);
  assert.equal(unsafeTarget({ playerName: 'Demo' }, REVIEW, PLAYER), null);
});

test('a record already holding the review addresses is safe', () => {
  assert.equal(unsafeTarget({ guardianEmail: REVIEW, playerEmail: PLAYER }, REVIEW, PLAYER), null);
  assert.equal(unsafeTarget({ guardianEmail: REVIEW, playerEmail: '' }, REVIEW, PLAYER), null);
});

// THE ONE THAT MATTERS. If this stops failing, the script will happily overwrite a
// real family's athlete record and hand their conversation to a Play reviewer.
test('a real family on the review athlete id is refused', () => {
  assert.deepEqual(
    unsafeTarget({ guardianEmail: 'someone@real.example' }, REVIEW, PLAYER),
    ['guardianEmail', 'someone@real.example']
  );
  assert.deepEqual(
    unsafeTarget({ guardianEmail: REVIEW, playerEmail: 'kid@real.example' }, REVIEW, PLAYER),
    ['playerEmail', 'kid@real.example']
  );
});

test('a review account with no player configured does not widen the guard', () => {
  // PLAYER_EMAIL is optional, so it arrives as undefined. A stray address must still
  // be caught rather than compared against undefined and waved through.
  assert.deepEqual(
    unsafeTarget({ playerEmail: 'kid@real.example' }, REVIEW, undefined),
    ['playerEmail', 'kid@real.example']
  );
});

test('values encode to the types Firestore REST expects', () => {
  assert.deepEqual(val('x'), { stringValue: 'x' });
  assert.deepEqual(val(true), { booleanValue: true });
  assert.deepEqual(val(15), { integerValue: '15' });
  assert.deepEqual(val(null), { nullValue: null });
  assert.deepEqual(val(['a', 'b']), { arrayValue: { values: [{ stringValue: 'a' }, { stringValue: 'b' }] } });
});

test('a Date becomes a timestamp, not a string', () => {
  // joinedAt and every message createdAt go through this. As a stringValue they would
  // write without error and then sort and render wrongly in the app.
  const d = new Date('2026-09-01T12:00:00.000Z');
  assert.deepEqual(val(d), { timestampValue: '2026-09-01T12:00:00.000Z' });
});

test('undefined fields are dropped rather than written as null', () => {
  // playerEmail is undefined for a guardian-only athlete. Writing an explicit null
  // would differ from the absent field the rules and the app both expect.
  assert.deepEqual(fields({ a: 'keep', b: undefined }), { a: { stringValue: 'keep' } });
});

test('plain() reads back what fields() wrote', () => {
  const src = { guardianEmail: REVIEW, age: 15, readers: ['u1', 'u2'], consent: true };
  const back = plain(fields(src));
  assert.equal(back.guardianEmail, REVIEW);
  assert.equal(back.age, '15'); // Firestore returns integers as strings; the guard only compares emails
  assert.deepEqual(back.readers, ['u1', 'u2']);
  assert.equal(back.consent, true);
});

test('the guard reads a real Firestore document shape, not a hand-made object', () => {
  // assertSafeTarget pipes the API response through plain() before the guard sees it,
  // so the guard has to survive that exact shape.
  const doc = { fields: fields({ guardianEmail: 'someone@real.example', playerName: 'Real Kid' }) };
  assert.deepEqual(
    unsafeTarget(plain(doc.fields), REVIEW, PLAYER),
    ['guardianEmail', 'someone@real.example']
  );
});
