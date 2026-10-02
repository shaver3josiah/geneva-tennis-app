/**
 * The message window, against a real Firestore emulator.
 *
 * `orderBy('createdAt','asc') + limit(500)` returns the OLDEST 500 messages, so a busy
 * thread froze: past 500, every new message fell outside the window and never arrived.
 * The preview line was worse — it subscribed to the whole thread and took the last one,
 * up to 500 reads per thread per cold start to render two lines of text.
 *
 * These assertions are about QUERY SHAPE, not rules, so they run with rules disabled.
 *
 *   npm run test:messages
 */

import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { initializeTestEnvironment } from '@firebase/rules-unit-testing';
import {
  collection,
  doc,
  getDocs,
  limit,
  orderBy,
  query,
  setDoc,
  Timestamp,
} from 'firebase/firestore';

const TID = 'busy_thread';
const TOTAL = 620; // comfortably past the old 500 ceiling

let env;
let db;

before(async () => {
  env = await initializeTestEnvironment({
    projectId: 'geneva-tennis-messages-test',
    // Wide open on purpose: these tests are about the query, and rules have their own
    // suite. Narrowing them here would only test the rules twice.
    firestore: { rules: `rules_version='2';service cloud.firestore{match /{d=**}{allow read,write:if true;}}`, host: '127.0.0.1', port: 8080 },
  });

  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async (ctx) => {
    const w = ctx.firestore();
    // Sequential timestamps a minute apart, so "newest" is unambiguous.
    const base = Date.UTC(2026, 0, 1, 12, 0, 0);
    for (let i = 0; i < TOTAL; i++) {
      await setDoc(doc(w, 'threads', TID, 'messages', `m${String(i).padStart(4, '0')}`), {
        senderUid: i % 2 ? 'coach_uid' : 'player_uid',
        text: `message ${i}`,
        createdAt: Timestamp.fromMillis(base + i * 60_000),
      });
    }
  });

  db = env.unauthenticatedContext().firestore();
});

after(async () => {
  await env?.cleanup();
});

/** What the app now runs: newest N, reversed for display. */
async function windowOf(max) {
  const snap = await getDocs(
    query(collection(db, 'threads', TID, 'messages'), orderBy('createdAt', 'desc'), limit(max))
  );
  const msgs = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  msgs.sort((a, b) => a.createdAt.toMillis() - b.createdAt.toMillis());
  return msgs;
}

describe('the message window', () => {
  test('a thread past 500 messages still shows the newest one', async () => {
    const msgs = await windowOf(200);
    assert.equal(msgs.length, 200);
    assert.equal(msgs.at(-1).text, `message ${TOTAL - 1}`, 'the newest message must be in the window');
  });

  test('the old ascending query is the bug — it returns the OLDEST, and never the newest', async () => {
    // Pinned deliberately: if someone restores orderBy asc + limit, this goes red and
    // says why, instead of the thread silently freezing in production months later.
    const snap = await getDocs(
      query(collection(db, 'threads', TID, 'messages'), orderBy('createdAt', 'asc'), limit(500))
    );
    const texts = snap.docs.map((d) => d.data().text);
    assert.equal(texts[0], 'message 0');
    assert.equal(texts.at(-1), 'message 499');
    assert.ok(!texts.includes(`message ${TOTAL - 1}`), 'the newest message is outside the old window');
  });

  test('the window is contiguous and ends at the newest message', async () => {
    const msgs = await windowOf(50);
    const nums = msgs.map((m) => Number(m.text.split(' ')[1]));
    assert.deepEqual(nums, Array.from({ length: 50 }, (_, i) => TOTAL - 50 + i));
  });

  test('the preview costs one document read, not the whole thread', async () => {
    const snap = await getDocs(
      query(collection(db, 'threads', TID, 'messages'), orderBy('createdAt', 'desc'), limit(1))
    );
    assert.equal(snap.docs.length, 1, 'a preview must never pull the thread');
    assert.equal(snap.docs[0].data().text, `message ${TOTAL - 1}`);
  });

  test('a short thread comes back whole, oldest first', async () => {
    const msgs = await windowOf(TOTAL + 100);
    assert.equal(msgs.length, TOTAL);
    assert.equal(msgs[0].text, 'message 0');
    assert.equal(msgs.at(-1).text, `message ${TOTAL - 1}`);
  });
});
