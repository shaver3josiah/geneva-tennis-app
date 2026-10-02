/**
 * The security rules ARE the security model — there is no server-side code to fall
 * back on (Cloud Functions need the Blaze plan). So they get tested.
 *
 * A prior audit found three majors in this file: the coach could pre-grant consent at
 * create time, he could write the guardian out of a thread's readers, and the consent
 * gate wrongly locked the PARENT out of messaging. Each of those is pinned below, so a
 * future edit that reintroduces one fails here instead of in production.
 *
 *   npm run test:rules      (starts the emulator itself)
 *
 * Uses node:test — no jest, no vitest, no config file.
 */

import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  initializeTestEnvironment,
  assertFails,
  assertSucceeds,
} from '@firebase/rules-unit-testing';
import {
  doc,
  getDoc,
  setDoc,
  updateDoc,
  deleteDoc,
  addDoc,
  collection,
  getDocs,
  query,
  where,
  serverTimestamp,
  deleteField,
  writeBatch,
} from 'firebase/firestore';

const HERE = dirname(fileURLToPath(import.meta.url));

const COACH = 'coach_test_uid';
const PARENT = 'parent_test_uid';
const PLAYER = 'player_test_uid';
const STRANGER = 'stranger_test_uid';
const ATHLETE = 'athlete1';
const T_CP = 'thread_coach_player';
const T_CX = 'thread_coach_parent';

/** The team's coach code in these tests. The rules only ever see its SHA-256. */
const COACH_CODE = 'a-long-random-test-coach-code';
const sha256Hex = (s) => createHash('sha256').update(s, 'utf8').digest('hex');

/**
 * The rules exactly as shipped. The coach is a DOCUMENT now (/coaches/{uid}), so there is
 * nothing to patch: seed() writes the coach with the rules switched off, the way a
 * successful claim would have, and the claim tests below go through the real door.
 */
function rulesUnderTest() {
  return readFileSync(join(HERE, '..', 'firestore.rules'), 'utf8');
}

let env;

before(async () => {
  env = await initializeTestEnvironment({
    projectId: 'geneva-tennis-rules-test',
    firestore: {
      rules: rulesUnderTest(),
      host: '127.0.0.1',
      port: 8080,
    },
  });
});

after(async () => {
  await env?.cleanup();
});

/** Fresh, rule-free baseline before every test. */
async function seed({ consent = false } = {}) {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    // The coach role and the code that grants it, written behind the rules' back.
    await setDoc(doc(db, 'coaches', COACH), {
      name: 'Coach Test',
      email: 'coach@example.com',
      createdAt: new Date(),
    });
    await setDoc(doc(db, 'coachKeys', sha256Hex(COACH_CODE)), { createdAt: 1 });
    await setDoc(doc(db, 'athletes', ATHLETE), {
      guardianEmail: 'denise@example.com',
      playerEmail: 'marcus@example.com',
      guardianUid: PARENT,
      playerUid: PLAYER,
      playerName: 'Marcus Alvarez',
      guardianName: 'Denise Alvarez',
      age: 15,
      ...(consent ? { consentGrantedAt: new Date() } : {}),
    });
    // The guardian sits in `readers` on the coach<->player thread. That is the
    // monitoring guarantee, and it is what makes one array-contains query serve
    // all three roles.
    await setDoc(doc(db, 'threads', T_CP), {
      athleteId: ATHLETE,
      participants: [COACH, PLAYER],
      readers: [COACH, PLAYER, PARENT],
      kind: 'coach-player',
      title: 'Coach Test ↔ Marcus',
    });
    await setDoc(doc(db, 'threads', T_CX), {
      athleteId: ATHLETE,
      participants: [COACH, PARENT],
      readers: [COACH, PARENT],
      kind: 'coach-parent',
      title: 'Coach Test ↔ Denise',
    });
    await setDoc(doc(db, 'threads', T_CP, 'messages', 'm1'), {
      senderUid: COACH,
      text: 'Saw the film from Saturday.',
      createdAt: new Date(),
    });
  });
}

const as = (uid) => env.authenticatedContext(uid).firestore();

const send = (db, uid, tid, text = 'hello coach') =>
  addDoc(collection(db, 'threads', tid, 'messages'), {
    senderUid: uid,
    text,
    createdAt: serverTimestamp(),
  });

// ---------------------------------------------------------------------------

describe('consent gate', () => {
  test('player cannot post before the guardian grants consent', async () => {
    await seed({ consent: false });
    await assertFails(send(as(PLAYER), PLAYER, T_CP));
  });

  test('player can post once consent exists', async () => {
    await seed({ consent: true });
    await assertSucceeds(send(as(PLAYER), PLAYER, T_CP));
  });

  test('revoking consent re-locks the thread', async () => {
    await seed({ consent: true });
    await assertSucceeds(
      updateDoc(doc(as(PARENT), 'athletes', ATHLETE), { consentGrantedAt: null })
    );
    await assertFails(send(as(PLAYER), PLAYER, T_CP));
  });

  test('an absent consent field reads as no consent, not as an error', async () => {
    await seed({ consent: true });
    await assertSucceeds(
      updateDoc(doc(as(PARENT), 'athletes', ATHLETE), { consentGrantedAt: deleteField() })
    );
    await assertFails(send(as(PLAYER), PLAYER, T_CP));
  });

  test('the parent can message the coach WITHOUT consent — talking to him is how she decides', async () => {
    await seed({ consent: false });
    await assertSucceeds(send(as(PARENT), PARENT, T_CX));
  });

  test('the coach can message an athlete without consent — only the athlete is gated', async () => {
    await seed({ consent: false });
    await assertSucceeds(send(as(COACH), COACH, T_CP));
  });
});

describe('consent is the guardian’s alone', () => {
  test('the coach cannot pre-grant consent at create time', async () => {
    await seed();
    await assertFails(
      setDoc(doc(as(COACH), 'athletes', 'athlete2'), {
        guardianUid: PARENT,
        playerUid: PLAYER,
        consentGrantedAt: new Date(),
      })
    );
  });

  test('the coach can create an athlete without a consent field', async () => {
    await seed();
    await assertSucceeds(
      setDoc(doc(as(COACH), 'athletes', 'athlete2'), {
        guardianUid: PARENT,
        playerUid: PLAYER,
        playerName: 'Second Athlete',
      })
    );
  });

  test('the coach cannot grant consent by update either', async () => {
    await seed();
    await assertFails(
      updateDoc(doc(as(COACH), 'athletes', ATHLETE), { consentGrantedAt: new Date() })
    );
  });

  test('the player cannot grant his own consent', async () => {
    await seed();
    await assertFails(
      updateDoc(doc(as(PLAYER), 'athletes', ATHLETE), { consentGrantedAt: new Date() })
    );
  });

  test('the guardian may touch consent and nothing else', async () => {
    await seed();
    await assertSucceeds(
      updateDoc(doc(as(PARENT), 'athletes', ATHLETE), { consentGrantedAt: new Date() })
    );
    await assertFails(updateDoc(doc(as(PARENT), 'athletes', ATHLETE), { playerName: 'Renamed' }));
  });

  test('the coach may edit roster fields but never reassign the guardian', async () => {
    await seed();
    await assertSucceeds(updateDoc(doc(as(COACH), 'athletes', ATHLETE), { age: 16 }));
    await assertFails(updateDoc(doc(as(COACH), 'athletes', ATHLETE), { guardianUid: STRANGER }));
  });
});

describe('parent monitoring is structural', () => {
  test('the parent reads every message in the coach↔player thread', async () => {
    await seed();
    await assertSucceeds(getDoc(doc(as(PARENT), 'threads', T_CP, 'messages', 'm1')));
  });

  test('the parent cannot post into the coach↔player thread', async () => {
    await seed({ consent: true });
    await assertFails(send(as(PARENT), PARENT, T_CP));
  });

  test('the coach cannot create a thread that leaves the guardian out', async () => {
    await seed();
    await assertFails(
      setDoc(doc(as(COACH), 'threads', 'sneaky'), {
        athleteId: ATHLETE,
        participants: [COACH, PLAYER],
        readers: [COACH, PLAYER],
        kind: 'coach-player',
        title: 'off the record',
      })
    );
  });

  test('threads are immutable — the guardian cannot be edited out afterwards', async () => {
    await seed();
    await assertFails(updateDoc(doc(as(COACH), 'threads', T_CP), { readers: [COACH, PLAYER] }));
    await assertFails(deleteDoc(doc(as(COACH), 'threads', T_CP)));
  });

  test('messages are permanent, for the coach as much as the player', async () => {
    await seed({ consent: true });
    await assertFails(deleteDoc(doc(as(COACH), 'threads', T_CP, 'messages', 'm1')));
    await assertFails(deleteDoc(doc(as(PLAYER), 'threads', T_CP, 'messages', 'm1')));
    await assertFails(
      updateDoc(doc(as(COACH), 'threads', T_CP, 'messages', 'm1'), { text: 'never mind' })
    );
  });
});

describe('message shape', () => {
  test('a sender cannot forge someone else’s uid', async () => {
    await seed({ consent: true });
    await assertFails(send(as(PLAYER), COACH, T_CP));
  });

  test('empty and oversized text are rejected', async () => {
    await seed({ consent: true });
    await assertFails(send(as(PLAYER), PLAYER, T_CP, ''));
    await assertFails(send(as(PLAYER), PLAYER, T_CP, 'x'.repeat(4001)));
  });

  test('a client-chosen timestamp is rejected — createdAt must be the server time', async () => {
    await seed({ consent: true });
    await assertFails(
      addDoc(collection(as(PLAYER), 'threads', T_CP, 'messages'), {
        senderUid: PLAYER,
        text: 'backdated',
        createdAt: new Date(2020, 0, 1),
      })
    );
  });

  test('extra fields are rejected', async () => {
    await seed({ consent: true });
    await assertFails(
      addDoc(collection(as(PLAYER), 'threads', T_CP, 'messages'), {
        senderUid: PLAYER,
        text: 'hi',
        createdAt: serverTimestamp(),
        readByCoach: true,
      })
    );
  });
});

describe('outsiders', () => {
  test('a signed-in stranger sees no athlete, no thread, no message', async () => {
    await seed();
    await assertFails(getDoc(doc(as(STRANGER), 'athletes', ATHLETE)));
    await assertFails(getDoc(doc(as(STRANGER), 'threads', T_CP)));
    await assertFails(getDoc(doc(as(STRANGER), 'threads', T_CP, 'messages', 'm1')));
  });

  test('an unauthenticated client sees nothing', async () => {
    await seed();
    const anon = env.unauthenticatedContext().firestore();
    await assertFails(getDoc(doc(anon, 'threads', T_CP, 'messages', 'm1')));
  });
});

describe('the queries the app actually runs', () => {
  test('readers array-contains is the one thread query that serves all three roles', async () => {
    await seed();
    for (const uid of [COACH, PARENT, PLAYER]) {
      await assertSucceeds(
        getDocs(query(collection(as(uid), 'threads'), where('readers', 'array-contains', uid)))
      );
    }
  });

  test('an unconstrained thread list is denied for a parent and allowed for the coach', async () => {
    await seed();
    await assertFails(getDocs(collection(as(PARENT), 'threads')));
    await assertSucceeds(getDocs(collection(as(COACH), 'threads')));
  });

  test('events must be queried by athleteId — rules never filter', async () => {
    await seed();
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), 'events', 'e1'), {
        athleteId: ATHLETE,
        type: 'skills',
        name: 'Ball Handling',
        location: 'Kendall Indoor',
        startsAt: new Date(),
      });
    });
    await assertFails(getDocs(collection(as(PARENT), 'events')));
    await assertSucceeds(
      getDocs(query(collection(as(PARENT), 'events'), where('athleteId', '==', ATHLETE)))
    );
  });

  test('only the coach writes the calendar', async () => {
    await seed();
    const ev = {
      athleteId: ATHLETE,
      type: 'skills',
      name: 'Extra work',
      location: 'anywhere',
      startsAt: new Date(),
    };
    await assertFails(setDoc(doc(as(PARENT), 'events', 'e2'), ev));
    await assertSucceeds(setDoc(doc(as(COACH), 'events', 'e2'), ev));
  });
});

describe('a coached session is one shared document', () => {
  // A second family, so a shared session has someone to be shared WITH.
  const A2 = 'athlete_two';
  const P2 = 'parent_two_uid';
  const K2 = 'player_two_uid';

  async function seedSecondFamily({ claimed = true } = {}) {
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), 'athletes', A2), {
        guardianEmail: 'other@example.com',
        playerEmail: 'kid@example.com',
        guardianUid: claimed ? P2 : '',
        playerUid: claimed ? K2 : '',
        playerName: 'Jordan Reyes',
        guardianName: 'Maria Reyes',
      });
    });
  }

  const shared = (over) => ({
    athleteId: ATHLETE,
    athleteIds: [ATHLETE, A2],
    memberUids: [PARENT, PLAYER, P2, K2],
    type: 'team',
    name: 'Small group',
    location: 'the gym',
    startsAt: new Date(),
    ...over,
  });

  test('both families read the one document, and a stranger does not', async () => {
    await seed();
    await seedSecondFamily();
    await assertSucceeds(setDoc(doc(as(COACH), 'events', 'g1'), shared()));

    // The second family is on memberUids but NOT on athleteId, so this is the branch
    // that only exists because the session is shared.
    await assertSucceeds(getDoc(doc(as(P2), 'events', 'g1')));
    await assertSucceeds(getDoc(doc(as(K2), 'events', 'g1')));
    await assertSucceeds(getDoc(doc(as(PARENT), 'events', 'g1')));

    // And the query shape src/data.ts actually runs.
    await assertSucceeds(
      getDocs(query(collection(as(P2), 'events'), where('memberUids', 'array-contains', P2)))
    );
  });

  test('the coach cannot leave a family off a session their child is on', async () => {
    await seed();
    await seedSecondFamily();
    // memberUids is the audience and the coach writes it, so this is the same power
    // the audit took away from him on threads: quietly excluding the parent who is
    // supposed to be watching. The rule reads the athlete records rather than
    // trusting the list.
    await assertFails(
      setDoc(doc(as(COACH), 'events', 'g2'), shared({ memberUids: [PARENT, PLAYER, K2] }))
    );
    // Leaving the ATHLETE off is refused for the same reason.
    await assertFails(
      setDoc(doc(as(COACH), 'events', 'g3'), shared({ memberUids: [PARENT, PLAYER, P2] }))
    );
    // Nor can he smuggle an athlete in without naming them at all.
    await assertFails(
      setDoc(doc(as(COACH), 'events', 'g4'), shared({ athleteIds: [ATHLETE, A2, 'ghost'] }))
    );
  });

  test('a family with no account cannot be put on a shared session', async () => {
    await seed();
    await seedSecondFamily({ claimed: false });
    // Their guardianUid is the empty string. If '' satisfied a membership test the
    // session would look shared and be readable by nobody, which is exactly the bug
    // the thread rule was fixed for.
    await assertFails(setDoc(doc(as(COACH), 'events', 'g5'), shared({ memberUids: [PARENT, PLAYER, ''] })));
    await assertFails(setDoc(doc(as(COACH), 'events', 'g5'), shared()));
  });

  test('athleteId must be one of the athletes on the session', async () => {
    await seed();
    await seedSecondFamily();
    // The read rule still resolves athleteId through a get(), so a document whose
    // athleteId names someone not on it would grant a family a session they are not
    // part of.
    await assertFails(
      setDoc(doc(as(COACH), 'events', 'g6'), shared({ athleteId: 'someone_else' }))
    );
  });

  test('an individual session still works, and needs none of this', async () => {
    await seed();
    // No athleteIds at all: every event written before sessions could be shared has
    // this shape, and must keep working untouched.
    await assertSucceeds(
      setDoc(doc(as(COACH), 'events', 'solo'), {
        athleteId: ATHLETE,
        type: 'skills',
        name: 'On your own',
        location: 'home court',
        startsAt: new Date(),
      })
    );
    await assertSucceeds(getDoc(doc(as(PARENT), 'events', 'solo')));
    await assertSucceeds(getDoc(doc(as(PLAYER), 'events', 'solo')));
  });

  test('a session carries every category it covers, and nothing else', async () => {
    await seed();
    const multi = (over) => ({
      athleteId: ATHLETE,
      type: 'handle',
      name: 'Handling into finishing',
      location: 'the gym',
      startsAt: new Date(),
      ...over,
    });
    // A coach works two things in one session, so `types` carries the set and `type`
    // stays the primary one the calendar tints the day with.
    await assertSucceeds(
      setDoc(doc(as(COACH), 'events', 'm1'), multi({ types: ['handle', 'shoot'] }))
    );
    // A key the app does not draw would render as a blank chip on a family's calendar.
    await assertFails(
      setDoc(doc(as(COACH), 'events', 'm2'), multi({ types: ['handle', 'dunking'] }))
    );
    // Six categories exist, so anything longer is a duplicate or free storage.
    await assertFails(
      setDoc(
        doc(as(COACH), 'events', 'm3'),
        multi({ types: ['skills', 'shoot', 'handle', 'cond', 'team', 'rest', 'skills'] })
      )
    );
  });

  test('eight athletes is the ceiling the rules unroll to', async () => {
    await seed();
    await seedSecondFamily();
    await assertFails(
      setDoc(doc(as(COACH), 'events', 'g7'), shared({
        athleteIds: [ATHLETE, A2, 'a3', 'a4', 'a5', 'a6', 'a7', 'a8', 'a9'],
      }))
    );
  });

  // memberUids is a snapshot, and update re-runs audienceWritten over the whole
  // document. So once a child on a shared session gets their own login, a write that
  // leaves the list alone is refused (the coach could not move, edit or cancel it) and
  // the child cannot read it. src/data.ts rebuilds the list on every coach write
  // (freshAudience); this pins both halves of why.
  test('a shared session stays writable after a child on it gets their own login', async () => {
    await seed();
    await seedSecondFamily();
    // Scheduled while the second child had no login of their own.
    await env.withSecurityRulesDisabled(async (ctx) => {
      await updateDoc(doc(ctx.firestore(), 'athletes', A2), { playerUid: '' });
    });
    await assertSucceeds(
      setDoc(doc(as(COACH), 'events', 'late'), shared({ memberUids: [PARENT, PLAYER, P2] }))
    );
    // The child signs up afterwards.
    await env.withSecurityRulesDisabled(async (ctx) => {
      await updateDoc(doc(ctx.firestore(), 'athletes', A2), { playerUid: K2 });
    });
    // The stale list is refused, which is the bug the app used to hit...
    await assertFails(
      updateDoc(doc(as(COACH), 'events', 'late'), { startsAt: new Date(), timeLabel: '5:00 PM' })
    );
    await assertFails(getDoc(doc(as(K2), 'events', 'late')));
    // ...and moveEvent's write now, with the audience rebuilt, goes through.
    await assertSucceeds(
      updateDoc(doc(as(COACH), 'events', 'late'), {
        startsAt: new Date(),
        timeLabel: '5:00 PM',
        memberUids: [PARENT, PLAYER, P2, K2],
      })
    );
    await assertSucceeds(getDoc(doc(as(K2), 'events', 'late')));
  });
});

describe('the Locker', () => {
  test('only the coach publishes, and the html has a size ceiling', async () => {
    await seed();
    const wf = { name: 'Warmup', html: '<h1>hi</h1>', publishedBy: 'Coach Test' };
    await assertFails(setDoc(doc(as(PLAYER), 'workflows', 'w1'), wf));
    await assertSucceeds(setDoc(doc(as(COACH), 'workflows', 'w1'), wf));
    await assertFails(
      setDoc(doc(as(COACH), 'workflows', 'w2'), { ...wf, html: 'x'.repeat(900001) })
    );
  });

  test('answers belong to the athlete — the coach reads them but cannot author them', async () => {
    await seed();
    const answers = { answers: { 'Week 10': true }, updatedAt: new Date() };
    await assertSucceeds(
      setDoc(doc(as(PLAYER), 'athletes', ATHLETE, 'savedWorkflows', 'w1'), answers)
    );
    await assertSucceeds(
      getDoc(doc(as(COACH), 'athletes', ATHLETE, 'savedWorkflows', 'w1'))
    );
    await assertFails(
      setDoc(doc(as(COACH), 'athletes', ATHLETE, 'savedWorkflows', 'w1'), answers)
    );
  });

  test('a progress doc cannot be used as free storage', async () => {
    await seed();
    const tooMany = Object.fromEntries(Array.from({ length: 201 }, (_, i) => [`k${i}`, true]));
    await assertFails(
      setDoc(doc(as(PLAYER), 'athletes', ATHLETE, 'savedWorkflows', 'w1'), {
        answers: tooMany,
        updatedAt: new Date(),
      })
    );
  });
});

describe('submissions on a cadence', () => {
  // Ids are written out as literals on purpose: this suite tests the RULES, so it must
  // not borrow src/period.ts to build the very ids the rules are supposed to pin.
  const W36 = 'w4__2026-W36';
  const W37 = 'w4__2026-W37';
  const sub = (uid, sid, data) =>
    setDoc(doc(as(uid), 'athletes', ATHLETE, 'savedWorkflows', sid), data);
  const submissions = (uid) => getDocs(collection(as(uid), 'athletes', ATHLETE, 'savedWorkflows'));

  test('a one-off still saves under the bare workflow id', async () => {
    await seed();
    // Written before cadences existed: no workflowId, no periodKey.
    await assertSucceeds(sub(PLAYER, 'w1', { answers: { 'Week 10': true }, updatedAt: new Date() }));
    // And the new client's one-off, which carries an empty period.
    await assertSucceeds(
      sub(PLAYER, 'w1', {
        answers: { 'Week 10': true },
        updatedAt: new Date(),
        workflowId: 'w1',
        periodKey: '',
      })
    );
  });

  test('a repeating submission saves under {workflowId}__{periodKey}', async () => {
    await seed();
    await assertSucceeds(
      sub(PLAYER, W36, {
        answers: { shooting: '7' },
        updatedAt: new Date(),
        workflowId: 'w4',
        periodKey: '2026-W36',
      })
    );
  });

  test('two weeks of the same evaluation coexist — this is the bug', async () => {
    await seed();
    await assertSucceeds(
      sub(PLAYER, W36, {
        answers: { shooting: '7' },
        updatedAt: new Date(),
        workflowId: 'w4',
        periodKey: '2026-W36',
      })
    );
    await assertSucceeds(
      sub(PLAYER, W37, {
        answers: { shooting: '9' },
        updatedAt: new Date(),
        workflowId: 'w4',
        periodKey: '2026-W37',
      })
    );
    const snap = await assertSucceeds(submissions(PLAYER));
    const byId = Object.fromEntries(snap.docs.map((d) => [d.id, d.data()]));
    assert.deepEqual(Object.keys(byId).sort(), [W36, W37]);
    assert.equal(byId[W36].answers.shooting, '7');
    assert.equal(byId[W37].answers.shooting, '9');
  });

  test('re-saving the same week overwrites it rather than piling up', async () => {
    await seed();
    const week = (shooting) => ({
      answers: { shooting },
      updatedAt: new Date(),
      workflowId: 'w4',
      periodKey: '2026-W36',
    });
    await assertSucceeds(sub(PLAYER, W36, week('7')));
    await assertSucceeds(sub(PLAYER, W36, week('8')));
    const snap = await assertSucceeds(submissions(PLAYER));
    assert.equal(snap.size, 1);
    assert.equal(snap.docs[0].data().answers.shooting, '8');
  });

  test('the id is pinned — a week cannot be refiled as another week', async () => {
    await seed();
    await assertFails(
      sub(PLAYER, W37, {
        answers: { shooting: '2' },
        updatedAt: new Date(),
        workflowId: 'w4',
        periodKey: '2026-W36',
      })
    );
    await assertFails(
      sub(PLAYER, W37, {
        answers: { shooting: '2' },
        updatedAt: new Date(),
        workflowId: 'w9',
        periodKey: '2026-W37',
      })
    );
  });

  test('a workflowId with no periodKey cannot claim a suffixed id', async () => {
    await seed();
    // Looks like an odd case, and is: the rule builds workflowId + '__' + periodKey, and
    // reading a key that is not there errors out in rules — which denies. The deny is the
    // point, so it is pinned here rather than left to luck.
    await assertFails(
      sub(PLAYER, W36, { answers: { shooting: '7' }, updatedAt: new Date(), workflowId: 'w4' })
    );
  });

  test('extra fields are rejected on a submission too', async () => {
    await seed();
    await assertFails(
      sub(PLAYER, W36, {
        answers: { shooting: '7' },
        updatedAt: new Date(),
        workflowId: 'w4',
        periodKey: '2026-W36',
        gradedBy: COACH,
      })
    );
  });

  test('the 200-key cap survives the new shape', async () => {
    await seed();
    const tooMany = Object.fromEntries(Array.from({ length: 201 }, (_, i) => [`k${i}`, true]));
    await assertFails(
      sub(PLAYER, W36, {
        answers: tooMany,
        updatedAt: new Date(),
        workflowId: 'w4',
        periodKey: '2026-W36',
      })
    );
  });

  test('the guardian reads a submission — monitoring extends to assigned forms', async () => {
    await seed();
    const week = {
      answers: { shooting: '7' },
      updatedAt: new Date(),
      workflowId: 'w4',
      periodKey: '2026-W36',
    };
    await assertSucceeds(sub(PLAYER, W36, week));
    await assertSucceeds(getDoc(doc(as(PARENT), 'athletes', ATHLETE, 'savedWorkflows', W36)));
    await assertSucceeds(getDoc(doc(as(COACH), 'athletes', ATHLETE, 'savedWorkflows', W36)));
    await assertFails(getDoc(doc(as(STRANGER), 'athletes', ATHLETE, 'savedWorkflows', W36)));
  });

  test('the coach cannot author a submission, and the guardian still can', async () => {
    await seed();
    const week = {
      answers: { shooting: '7' },
      updatedAt: new Date(),
      workflowId: 'w4',
      periodKey: '2026-W36',
    };
    // The coach is the monitored party: he reads answers, he never writes them.
    await assertFails(sub(COACH, W36, week));
    // The guardian can, and that is deliberate — she files for a minor who cannot.
    // Pinned so removing it is a decision, not an accident.
    await assertSucceeds(sub(PARENT, W36, week));
  });
});

describe('claiming an invited slot', () => {
  const INVITED = 'athlete_unclaimed';
  const G_MAIL = 'newparent@example.com';
  const P_MAIL = 'newplayer@example.com';

  /** The coach invites a family by email; both uid slots start empty. */
  async function invite() {
    await env.clearFirestore();
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), 'athletes', INVITED), {
        guardianEmail: G_MAIL,
        playerEmail: P_MAIL,
        guardianUid: '',
        playerUid: '',
        guardianName: 'New Parent',
        playerName: 'New Player',
      });
    });
  }

  /** A signed-in context carrying an email token, as a password account does. */
  const asEmail = (uid, email, verified = true) =>
    env.authenticatedContext(uid, { email, email_verified: verified }).firestore();

  test('an invited guardian finds the record naming their email', async () => {
    await invite();
    await assertSucceeds(
      getDocs(
        query(collection(asEmail('new_p', G_MAIL), 'athletes'), where('guardianEmail', '==', G_MAIL))
      )
    );
  });

  test('an invited guardian claims the empty slot', async () => {
    await invite();
    await assertSucceeds(
      updateDoc(doc(asEmail('new_p', G_MAIL), 'athletes', INVITED), { guardianUid: 'new_p' })
    );
  });

  test('an unverified email cannot claim — this is the whole security of the branch', async () => {
    await invite();
    await assertFails(
      updateDoc(
        doc(asEmail('imposter', G_MAIL, false), 'athletes', INVITED),
        { guardianUid: 'imposter' }
      )
    );
  });

  test('a stranger cannot claim a slot invited to someone else', async () => {
    await invite();
    await assertFails(
      updateDoc(
        doc(asEmail('stranger', 'someone@else.com'), 'athletes', INVITED),
        { guardianUid: 'stranger' }
      )
    );
    await assertFails(getDoc(doc(asEmail('stranger', 'someone@else.com'), 'athletes', INVITED)));
  });

  test('a claimed slot cannot be stolen', async () => {
    await invite();
    await assertSucceeds(
      updateDoc(doc(asEmail('new_p', G_MAIL), 'athletes', INVITED), { guardianUid: 'new_p' })
    );
    // Same invited address, different account: the slot is no longer empty.
    await assertFails(
      updateDoc(doc(asEmail('thief', G_MAIL), 'athletes', INVITED), { guardianUid: 'thief' })
    );
  });

  test('a claimer cannot write a uid that is not their own', async () => {
    await invite();
    await assertFails(
      updateDoc(doc(asEmail('new_p', G_MAIL), 'athletes', INVITED), { guardianUid: 'somebody_else' })
    );
  });

  test('the guardian email cannot claim the PLAYER slot', async () => {
    await invite();
    await assertFails(
      updateDoc(doc(asEmail('new_p', G_MAIL), 'athletes', INVITED), { playerUid: 'new_p' })
    );
  });

  test('a claim cannot smuggle anything else through', async () => {
    await invite();
    await assertFails(
      updateDoc(doc(asEmail('new_p', G_MAIL), 'athletes', INVITED), {
        guardianUid: 'new_p',
        consentGrantedAt: new Date(),
      })
    );
    await assertFails(
      updateDoc(doc(asEmail('new_p', G_MAIL), 'athletes', INVITED), {
        guardianUid: 'new_p',
        playerName: 'Renamed',
      })
    );
  });

  test('the player claims their own slot independently', async () => {
    await invite();
    await assertSucceeds(
      updateDoc(doc(asEmail('new_a', P_MAIL), 'athletes', INVITED), { playerUid: 'new_a' })
    );
  });

  test('claiming does not grant consent — the gate still starts closed', async () => {
    await invite();
    await assertSucceeds(
      updateDoc(doc(asEmail('new_a', P_MAIL), 'athletes', INVITED), { playerUid: 'new_a' })
    );
    const a = await getDoc(doc(asEmail('new_a', P_MAIL), 'athletes', INVITED));
    assert.equal(a.data().consentGrantedAt, undefined, 'a claimed athlete must start unconsented');
  });
});

describe('the coach inviting a family', () => {
  test('the coach creates an athlete with empty slots and invited emails', async () => {
    await seed();
    await assertSucceeds(
      setDoc(doc(as(COACH), 'athletes', 'invited1'), {
        playerName: 'New Player',
        guardianName: 'New Parent',
        guardianEmail: 'p@example.com',
        playerEmail: 'a@example.com',
        guardianUid: '',
        playerUid: '',
      })
    );
  });

  test('threads cannot be opened before the guardian has signed up', async () => {
    await seed();
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), 'athletes', 'invited2'), {
        guardianEmail: 'p2@example.com',
        guardianUid: '',
        playerUid: '',
        guardianName: 'Waiting Parent',
        playerName: 'Waiting Player',
      });
    });
    // guardianUid is '' so the guardian cannot be among the readers, and the rule
    // requires her there. This is why the roster waits rather than offering the button.
    await assertFails(
      setDoc(doc(as(COACH), 'threads', 'invited2_parent'), {
        athleteId: 'invited2',
        kind: 'coach-parent',
        title: 'early',
        participants: [COACH, ''],
        readers: [COACH, ''],
      })
    );
  });

  test('once claimed, the coach opens both threads with the guardian in readers', async () => {
    await seed();
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), 'athletes', 'joined'), {
        guardianUid: 'g_uid',
        playerUid: 'p_uid',
        guardianName: 'Joined Parent',
        playerName: 'Joined Player',
      });
    });
    await assertSucceeds(
      setDoc(doc(as(COACH), 'threads', 'joined_parent'), {
        athleteId: 'joined',
        kind: 'coach-parent',
        title: 'Coach ↔ Parent',
        participants: [COACH, 'g_uid'],
        readers: [COACH, 'g_uid'],
      })
    );
    await assertSucceeds(
      setDoc(doc(as(COACH), 'threads', 'joined_player'), {
        athleteId: 'joined',
        kind: 'coach-player',
        title: 'Coach ↔ Player',
        participants: [COACH, 'p_uid'],
        readers: [COACH, 'p_uid', 'g_uid'],
      })
    );
  });
});

describe('workout templates', () => {
  // The Workout Builder writes here. Unlike /workflows, which any signed-in account
  // may read, a template is the coach's own material and a family has no reason to
  // see another family's plan. Scheduling copies the blocks onto the event, so
  // nothing a parent or athlete needs is behind this rule.
  const TPL = { name: 'Tuesday skills', type: 'skills', kind: 'individual', blocks: [], totalMinutes: 0 };

  test('only the coach can read or write a template', async () => {
    await seed();
    await assertSucceeds(setDoc(doc(as(COACH), 'workoutTemplates', 't1'), TPL));
    await assertSucceeds(getDoc(doc(as(COACH), 'workoutTemplates', 't1')));

    await assertFails(getDoc(doc(as(PARENT), 'workoutTemplates', 't1')));
    await assertFails(getDoc(doc(as(PLAYER), 'workoutTemplates', 't1')));
    await assertFails(setDoc(doc(as(PARENT), 'workoutTemplates', 't2'), TPL));
    await assertFails(deleteDoc(doc(as(PLAYER), 'workoutTemplates', 't1')));
  });

  test('a template is not free storage', async () => {
    await seed();
    // No name at all, and a blocks list past the ceiling: both are rejected, so a
    // client cannot park arbitrary documents in the library.
    await assertFails(setDoc(doc(as(COACH), 'workoutTemplates', 'bad'), { ...TPL, name: '' }));
    await assertFails(
      setDoc(doc(as(COACH), 'workoutTemplates', 'big'), {
        ...TPL,
        blocks: Array.from({ length: 61 }, (_, i) => ({ id: String(i), name: 'x', minutes: 5 })),
      })
    );
  });

  test('a template can cover several categories, but only real ones', async () => {
    await seed();
    await assertSucceeds(
      setDoc(doc(as(COACH), 'workoutTemplates', 't3'), {
        ...TPL,
        types: ['skills', 'handle', 'shoot'],
      })
    );
    // Same two bounds the events rule carries: no invented category, and no list
    // longer than the six that exist.
    await assertFails(
      setDoc(doc(as(COACH), 'workoutTemplates', 't4'), { ...TPL, types: ['skills', 'dunking'] })
    );
    await assertFails(
      setDoc(doc(as(COACH), 'workoutTemplates', 't5'), {
        ...TPL,
        types: ['skills', 'shoot', 'handle', 'cond', 'team', 'rest', 'skills'],
      })
    );
  });
});

describe('notification mutes', () => {
  test('a mute lives under its owner’s uid and nobody else can reach it', async () => {
    await seed();
    await assertSucceeds(
      setDoc(doc(as(PARENT), 'users', PARENT), { mutedThreads: [T_CP], displayName: 'Denise' })
    );
    await assertFails(setDoc(doc(as(PLAYER), 'users', PARENT), { mutedThreads: [] }));
    await assertFails(getDoc(doc(as(PLAYER), 'users', PARENT)));
    await assertFails(getDoc(doc(as(COACH), 'users', PARENT)));
  });

  // app/delete-account.tsx deletes exactly this document and then the Auth user.
  // If the delete rule ever narrows, the in-app deletion App Review requires would
  // fail at the last step, having already revoked the family’s consent.
  test('account deletion removes its own prefs, and only its own', async () => {
    await seed();
    await assertSucceeds(setDoc(doc(as(PARENT), 'users', PARENT), { mutedThreads: [T_CP] }));
    await assertFails(deleteDoc(doc(as(PLAYER), 'users', PARENT)));
    await assertFails(deleteDoc(doc(as(COACH), 'users', PARENT)));
    await assertSucceeds(deleteDoc(doc(as(PARENT), 'users', PARENT)));
  });

  test('prefs are not a general-purpose bucket', async () => {
    await seed();
    await assertFails(
      setDoc(doc(as(PARENT), 'users', PARENT), { mutedThreads: [], role: 'coach' })
    );
  });
});

describe('the workout log — what the coach is allowed to see', () => {
  const log = (db, aid, eid, over = {}) =>
    setDoc(doc(db, 'athletes', aid, 'workoutLog', eid), {
      eventId: eid,
      name: 'Tuesday skills',
      completedAt: serverTimestamp(),
      minutes: 42,
      blocksDone: 4,
      blocksTotal: 5,
      ...over,
    });

  // The whole reason this collection exists: the reward counters on /users are private
  // to the account, so before this the coach had no readable record of what an athlete
  // had actually trained.
  test('the family writes it and the coach reads it', async () => {
    await seed();
    await assertSucceeds(log(as(PLAYER), ATHLETE, 'ev_1'));
    await assertSucceeds(log(as(PARENT), ATHLETE, 'ev_2'));
    await assertSucceeds(getDoc(doc(as(COACH), 'athletes', ATHLETE, 'workoutLog', 'ev_1')));
  });

  // He is the monitored party. He may read the log and must not be able to write one:
  // a coach who can mark sessions done for a family can manufacture a training record.
  test('the coach cannot forge a completion', async () => {
    await seed();
    await assertFails(log(as(COACH), ATHLETE, 'ev_3'));
  });

  test('a stranger gets nothing, either way', async () => {
    await seed();
    await assertSucceeds(log(as(PLAYER), ATHLETE, 'ev_1'));
    await assertFails(getDoc(doc(as(STRANGER), 'athletes', ATHLETE, 'workoutLog', 'ev_1')));
    await assertFails(log(as(STRANGER), ATHLETE, 'ev_4'));
  });

  // The id IS the event id, which is what makes finishing twice idempotent instead of
  // a duplicate, so a row must not be filed under a session it does not belong to.
  test('the row is pinned to the session it claims', async () => {
    await seed();
    await assertFails(log(as(PLAYER), ATHLETE, 'ev_5', { eventId: 'somewhere_else' }));
  });

  // Same guard the messages rule uses. Without it a log can be backdated into a week
  // the athlete did not train, which is exactly the number the coach reads.
  test('the clock is the server’s', async () => {
    await seed();
    await assertFails(log(as(PLAYER), ATHLETE, 'ev_6', { completedAt: new Date('2020-01-01') }));
  });

  test('the fields are bounded and closed', async () => {
    await seed();
    await assertFails(log(as(PLAYER), ATHLETE, 'ev_7', { minutes: 9999 }));
    await assertFails(log(as(PLAYER), ATHLETE, 'ev_8', { minutes: 12.5 }));
    await assertFails(log(as(PLAYER), ATHLETE, 'ev_9', { grade: 'A+' }));
    await assertFails(log(as(PLAYER), ATHLETE, 'ev_10', { name: 'x'.repeat(141) }));
  });

  test('a family can remove its own row', async () => {
    await seed();
    await assertSucceeds(log(as(PLAYER), ATHLETE, 'ev_1'));
    await assertFails(deleteDoc(doc(as(COACH), 'athletes', ATHLETE, 'workoutLog', 'ev_1')));
    await assertSucceeds(deleteDoc(doc(as(PLAYER), 'athletes', ATHLETE, 'workoutLog', 'ev_1')));
  });
});

describe('the reward counters a workout writes', () => {
  // THE REGRESSION THIS PINS. The app shipped with these keys written by the Finish
  // button while the DEPLOYED ruleset still carried the old two-key allowlist, so every
  // write came back permission-denied and the athlete was told to check their
  // connection. The rules file being right is not the same as the rules being right.
  test('finishing a workout writes streak and workout keys', async () => {
    await seed();
    const loaded = {
      mutedThreads: [],
      chatColor: 'ocean',
      celebration: 'swish',
      streak: 4,
      bestStreak: 9,
      lastDay: '2026-09-15',
      workouts: 2,
      doneEvents: ['ev_a'],
      remind: true,
    };
    await assertSucceeds(setDoc(doc(as(PLAYER), 'users', PLAYER), loaded, { merge: true }));
    await assertSucceeds(
      setDoc(
        doc(as(PLAYER), 'users', PLAYER),
        { ...loaded, workouts: 3, doneEvents: ['ev_a', 'ev_b'] },
        { merge: true }
      )
    );
  });

  test('the done list is capped where the client clamps it', async () => {
    await seed();
    const ids = (n) => Array.from({ length: n }, (_, i) => `e${i}`);
    await assertSucceeds(
      setDoc(doc(as(PLAYER), 'users', PLAYER), { mutedThreads: [], doneEvents: ids(60) })
    );
    await assertFails(
      setDoc(doc(as(PLAYER), 'users', PLAYER), { mutedThreads: [], doneEvents: ids(61) })
    );
  });
});

// ---------------------------------------------------------------------------
// The coach role is a document, and the only door into it is the coach code.
// ---------------------------------------------------------------------------

describe('claiming the coach role', () => {
  const NEW = 'new_coach_uid';
  const MAIL = 'assistant@example.com';

  const asEmail = (uid, email = MAIL, verified = true) =>
    env.authenticatedContext(uid, { email, email_verified: verified }).firestore();

  /** What claimCoach in src/data.ts writes: the claim and the coach, in ONE batch. */
  function claim(db, uid, code, { withClaim = true, extra = {} } = {}) {
    const batch = writeBatch(db);
    if (withClaim) batch.set(doc(db, 'coachClaims', uid), { key: sha256Hex(code) });
    batch.set(doc(db, 'coaches', uid), {
      name: 'Assistant Coach',
      email: MAIL,
      createdAt: serverTimestamp(),
      ...extra,
    });
    return batch.commit();
  }

  // withSecurityRulesDisabled resolves to void, not to the callback's value, so carry it out.
  const exists = async (...path) => {
    let found;
    await env.withSecurityRulesDisabled(async (ctx) => {
      found = (await getDoc(doc(ctx.firestore(), ...path))).exists();
    });
    return found;
  };

  test('the right code makes a verified account a coach', async () => {
    await seed();
    await assertSucceeds(claim(asEmail(NEW), NEW, COACH_CODE));
    assert.equal(await exists('coaches', NEW), true);
    // From then on the rules treat them as one: they can list every athlete, which no
    // other account can do unconstrained.
    await assertSucceeds(getDocs(collection(asEmail(NEW), 'athletes')));
  });

  test('a wrong code fails, and writes neither document', async () => {
    await seed();
    await assertFails(claim(asEmail(NEW), NEW, 'not-the-code'));
    assert.equal(await exists('coaches', NEW), false);
    assert.equal(await exists('coachClaims', NEW), false);
    await assertFails(getDocs(collection(asEmail(NEW), 'athletes')));
  });

  test('an unverified email fails even with the right code', async () => {
    await seed();
    await assertFails(claim(asEmail(NEW, MAIL, false), NEW, COACH_CODE));
    assert.equal(await exists('coaches', NEW), false);
  });

  test('a coaches document without a claim in the same batch fails', async () => {
    await seed();
    await assertFails(claim(asEmail(NEW), NEW, COACH_CODE, { withClaim: false }));
    assert.equal(await exists('coaches', NEW), false);
  });

  test('nobody can claim on behalf of somebody else', async () => {
    await seed();
    await assertFails(claim(asEmail('someone_else'), NEW, COACH_CODE));
  });

  test('the coach document takes only name, email and createdAt', async () => {
    await seed();
    await assertFails(claim(asEmail(NEW), NEW, COACH_CODE, { extra: { admin: true } }));
  });

  test('with no coach code configured, nobody can claim', async () => {
    await seed();
    await env.withSecurityRulesDisabled(async (ctx) => deleteDoc(doc(ctx.firestore(), 'coachKeys', sha256Hex(COACH_CODE))));
    await assertFails(claim(asEmail(NEW), NEW, COACH_CODE));
  });

  test('neither the code nor its digest can be read, and the digest cannot be written', async () => {
    await seed();
    await claim(asEmail(NEW), NEW, COACH_CODE);
    await assertFails(getDoc(doc(asEmail(NEW), 'coachClaims', NEW)));
    await assertFails(getDoc(doc(asEmail(NEW), 'config', 'coachCode')));
    await assertFails(setDoc(doc(asEmail(NEW), 'config', 'coachCode'), { sha256: 'x' }));
    // Not even an existing coach: rotating the code is an admin operation (npm run set-coach-code).
    await assertFails(setDoc(doc(as(COACH), 'config', 'coachCode'), { sha256: 'x' }));
    // The key documents themselves: not readable, not listable, not writable by anyone.
    await assertFails(getDoc(doc(asEmail(NEW), 'coachKeys', sha256Hex(COACH_CODE))));
    await assertFails(getDocs(collection(asEmail(NEW), 'coachKeys')));
    await assertFails(setDoc(doc(as(COACH), 'coachKeys', sha256Hex('NEW-CODE')), { createdAt: 1 }));
  });

  test('a coach renames themselves and nothing else, and no client deletes a coach', async () => {
    await seed();
    await assertSucceeds(updateDoc(doc(as(COACH), 'coaches', COACH), { name: 'Head Coach' }));
    await assertFails(updateDoc(doc(as(COACH), 'coaches', COACH), { email: 'x@example.com' }));
    await assertFails(updateDoc(doc(as(COACH), 'coaches', COACH), { name: 'n'.repeat(61) }));
    await assertFails(deleteDoc(doc(as(COACH), 'coaches', COACH)));
    // And one coach cannot rewrite another.
    await assertSucceeds(claim(asEmail(NEW), NEW, COACH_CODE));
    await assertFails(updateDoc(doc(as(COACH), 'coaches', NEW), { name: 'Hijacked' }));
  });
});

// ---------------------------------------------------------------------------
// A college player (18+) is invited with no guardian and holds both slots.
// ---------------------------------------------------------------------------

describe('adult players', () => {
  const ADULT = 'athlete_adult';
  const UID = 'adult_uid';
  const MAIL = 'jordan@example.com';

  const asEmail = (uid, email, verified = true) =>
    env.authenticatedContext(uid, { email, email_verified: verified }).firestore();

  /** Both slots name the player, both uids start empty, and the record says adult. */
  const invitation = (extra = {}) => ({
    playerName: 'Jordan Pierce',
    guardianName: 'Jordan Pierce',
    guardianEmail: MAIL,
    playerEmail: MAIL,
    guardianUid: '',
    playerUid: '',
    adult: true,
    ...extra,
  });

  async function invited() {
    await seed();
    await assertSucceeds(setDoc(doc(as(COACH), 'athletes', ADULT), invitation()));
  }

  test('the coach invites an adult; the flag must be a boolean', async () => {
    await seed();
    await assertSucceeds(setDoc(doc(as(COACH), 'athletes', ADULT), invitation()));
    await assertFails(setDoc(doc(as(COACH), 'athletes', 'bad_flag'), invitation({ adult: 'yes' })));
  });

  test('the player claims guardianUid then playerUid, one write each', async () => {
    await invited();
    const db = asEmail(UID, MAIL);
    await assertSucceeds(updateDoc(doc(db, 'athletes', ADULT), { guardianUid: UID }));
    await assertSucceeds(updateDoc(doc(db, 'athletes', ADULT), { playerUid: UID }));
  });

  test('both slots in a single write is refused: claimsSlot allows exactly one key', async () => {
    await invited();
    await assertFails(
      updateDoc(doc(asEmail(UID, MAIL), 'athletes', ADULT), { guardianUid: UID, playerUid: UID })
    );
  });

  test('an unverified address cannot claim an adult record either', async () => {
    await invited();
    await assertFails(updateDoc(doc(asEmail(UID, MAIL, false), 'athletes', ADULT), { guardianUid: UID }));
  });

  test('once both slots are theirs they grant their own consent, and nobody else can', async () => {
    await invited();
    const db = asEmail(UID, MAIL);
    await updateDoc(doc(db, 'athletes', ADULT), { guardianUid: UID });
    await updateDoc(doc(db, 'athletes', ADULT), { playerUid: UID });
    await assertFails(updateDoc(doc(as(COACH), 'athletes', ADULT), { consentGrantedAt: new Date() }));
    await assertSucceeds(updateDoc(doc(db, 'athletes', ADULT), { consentGrantedAt: serverTimestamp() }));
  });

  test('the one coach<->player thread opens with each uid listed once, then they can post', async () => {
    await invited();
    const db = asEmail(UID, MAIL);
    await updateDoc(doc(db, 'athletes', ADULT), { guardianUid: UID });
    await updateDoc(doc(db, 'athletes', ADULT), { playerUid: UID });
    await updateDoc(doc(db, 'athletes', ADULT), { consentGrantedAt: serverTimestamp() });
    // guardianUid === playerUid, so the guardian the rule asks for IS the player.
    await assertSucceeds(
      setDoc(doc(as(COACH), 'threads', ADULT + '_player'), {
        athleteId: ADULT,
        kind: 'coach-player',
        title: 'Coach Test ↔ Jordan',
        participants: [COACH, UID],
        readers: [COACH, UID],
      })
    );
    await assertSucceeds(send(db, UID, ADULT + '_player'));
  });

  test('before the player has signed up, no thread can be opened', async () => {
    await invited();
    await assertFails(
      setDoc(doc(as(COACH), 'threads', ADULT + '_player'), {
        athleteId: ADULT,
        kind: 'coach-player',
        title: 'early',
        participants: [COACH, ''],
        readers: [COACH, ''],
      })
    );
  });
});
