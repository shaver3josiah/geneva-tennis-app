import {
  addDoc,
  collection,
  deleteDoc,
  deleteField,
  doc,
  getDoc,
  getDocs,
  limit,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
  writeBatch,
  type DocumentData,
  type Query,
  Timestamp,
  type Unsubscribe,
} from 'firebase/firestore';
import { COACH_NAME, db } from './firebase';
import { coachKeyFor } from './sha256';
import { parseSubmissionId, periodKey, submissionId } from './period';
import { clockLabel, projectDates } from './schedule';
import { BUILTIN_WORKFLOWS, isBuiltin } from './worksheets.generated';

export { projectDates } from './schedule';
import type { SessionType } from './theme';
import type {
  Athlete,
  Coach,
  Message,
  Role,
  SavedWorkflow,
  SessionEvent,
  Thread,
  UserPrefs,
  Workflow,
  WorkoutBlock,
  WorkoutKind,
  WorkoutLogEntry,
  WorkoutTemplate,
} from './types';

/**
 * Every read here is shaped to satisfy firebase/firestore.rules. Rules never filter a
 * query — they reject any query that *could* return a document the caller cannot read.
 * So a query that looks merely inefficient is often the difference between working and
 * a blanket permission-denied. Each one below notes which rule it is answering to.
 */

const err = (label: string) => (e: unknown) => {
  // A denied listener fails silently otherwise, which reads as "no data" and sends you
  // hunting through the UI for a bug that is actually in the query shape.
  console.warn(`[gt] ${label} listener failed:`, e);
};

// --- roles -----------------------------------------------------------------

/**
 * Which of the three people is this? A coach is whoever has a /coaches/{uid} document,
 * which is exactly the question firestore.rules asks with exists() — so the screens drawn
 * are the screens the rules will serve. The other two are found by matching the signed-in
 * uid against the athlete record. Both queries are run because we do not know the answer
 * yet, and the rules permit each of them — the losing one simply comes back empty.
 */
export async function resolveRole(
  uid: string
): Promise<{ role: Role; athlete: Athlete | null }> {
  // Reading your own coaches/{uid} is allowed whether or not it exists; a non-coach just
  // gets "no document".
  if ((await getDoc(doc(db, 'coaches', uid))).exists()) {
    // The coach may list athletes unconstrained; isCoach() does not depend on the doc.
    const snap = await getDocs(collection(db, 'athletes'));
    const first = snap.docs[0];
    return { role: 'coach', athlete: first ? ({ id: first.id, ...first.data() } as Athlete) : null };
  }

  for (const [field, role] of [
    ['guardianUid', 'parent'],
    ['playerUid', 'player'],
  ] as const) {
    // Matches `resource.data.<field> == request.auth.uid` on /athletes.
    const snap = await getDocs(query(collection(db, 'athletes'), where(field, '==', uid)));
    if (!snap.empty) {
      const d = snap.docs[0];
      const athlete = { id: d.id, ...d.data() } as Athlete;
      // An adult player holds BOTH slots, so the guardian query finds them first. They are
      // the player, not a parent: the guardian's screens (consent, monitoring) are not theirs.
      return { role: role === 'parent' && athlete.playerUid === uid ? 'player' : role, athlete };
    }
  }
  return { role: 'player', athlete: null };
}

/**
 * Take the coach role. Two documents in ONE batch, because the rules demand it:
 * /coachClaims/{uid} carries the SHA-256 of the team's coach code (the rules check that
 * /coachKeys/{digest} exists), and /coaches/{uid} is only created if that claim exists after the
 * same batch. A wrong code fails the whole batch with permission-denied, and so does an
 * address that has not been verified yet.
 */
export async function claimCoach(uid: string, name: string, email: string, code: string) {
  const batch = writeBatch(db);
  // The app sends the code's SHA-256 (upper-cased, spaces removed, so a coach gets in
  // however they type it); the rules only check that coachKeys/{that digest} exists.
  batch.set(doc(db, 'coachClaims', uid), { key: coachKeyFor(code) });
  batch.set(doc(db, 'coaches', uid), {
    name: name.trim().slice(0, 60),
    email: email.trim().toLowerCase(),
    createdAt: serverTimestamp(),
  });
  await batch.commit();
}

/** Every coach, in the order they claimed the role (the head coach goes first). */
export function subscribeCoaches(cb: (coaches: Coach[]) => void): Unsubscribe {
  return onSnapshot(
    collection(db, 'coaches'),
    (snap) => {
      const list = snap.docs.map(
        (d) => ({ id: d.id, ...d.data({ serverTimestamps: 'estimate' }) }) as Coach
      );
      list.sort((a, b) => (a.createdAt?.toMillis() ?? 0) - (b.createdAt?.toMillis() ?? 0));
      cb(list);
    },
    err('coaches')
  );
}

export function subscribeAthlete(athleteId: string, cb: (a: Athlete | null) => void): Unsubscribe {
  return onSnapshot(
    doc(db, 'athletes', athleteId),
    (snap) => cb(snap.exists() ? ({ id: snap.id, ...snap.data() } as Athlete) : null),
    err('athlete')
  );
}

/**
 * Every athlete this account can see, keyed by id — the coach's whole roster, or the
 * one athlete a family is attached to. Screens label a thread from the athlete named on
 * that thread rather than from "the" athlete, so a second athlete does not inherit the
 * first one's name everywhere.
 */
export function subscribeAthletes(
  role: Role,
  uid: string,
  cb: (byId: Record<string, Athlete>) => void
): Unsubscribe {
  const base = collection(db, 'athletes');
  // Same shape as resolveRole: unconstrained for the coach, matched on the caller's uid
  // otherwise, because rules reject any query that could return a doc they cannot read.
  const q =
    role === 'coach'
      ? query(base)
      : query(base, where(role === 'parent' ? 'guardianUid' : 'playerUid', '==', uid));
  return onSnapshot(
    q,
    (snap) => {
      const byId: Record<string, Athlete> = {};
      snap.docs.forEach((d) => (byId[d.id] = { id: d.id, ...d.data() } as Athlete));
      cb(byId);
    },
    err('athletes')
  );
}

/** One athlete record this address was invited to, and which of its slots are still open. */
export interface Invite {
  athleteId: string;
  /** Every empty slot on that record that names this address, guardian first. A parent or
   *  a player has one; an adult player (invited with no guardian) has both. */
  fields: ('guardianUid' | 'playerUid')[];
}

/**
 * The athlete record this email was invited to, if any slot is still unclaimed.
 *
 * A brand-new account matches none of the uid fields yet, so it cannot be found the
 * usual way. The rules let a VERIFIED account read the one record naming its own
 * address, which is exactly what these two queries ask for.
 */
export async function findInvite(email: string): Promise<Invite | null> {
  const addr = email.toLowerCase();
  const found = new Map<string, Invite>();
  for (const [emailField, uidField] of [
    ['guardianEmail', 'guardianUid'],
    ['playerEmail', 'playerUid'],
  ] as const) {
    try {
      const snap = await getDocs(query(collection(db, 'athletes'), where(emailField, '==', addr)));
      for (const d of snap.docs) {
        if ((d.data() as Athlete)[uidField] !== '') continue;
        const hit = found.get(d.id) ?? { athleteId: d.id, fields: [] };
        hit.fields.push(uidField);
        found.set(d.id, hit);
      }
    } catch (e) {
      // A denial here is normal: an address with no invitation matches nothing.
      console.warn(`[gt] invite lookup on ${emailField} failed:`, e);
    }
  }
  // The first record wins, and the guardian query runs first, as it always has.
  return found.values().next().value ?? null;
}

/**
 * Attach this account to the slot(s) it was invited to. The rules allow it only when the
 * caller's email is verified, matches the invitation, the slot is still empty, and the
 * uid written is the caller's own — so this can be called optimistically.
 *
 * ONE write per slot, in order: `claimsSlot` in the rules allows exactly one uid field to
 * change per write, so an adult player's two slots cannot be claimed together.
 */
export async function claimInvite(invite: Invite, uid: string) {
  for (const field of invite.fields) {
    await updateDoc(doc(db, 'athletes', invite.athleteId), { [field]: uid });
  }
}

export const hasConsent = (a: Athlete | null | undefined): boolean =>
  Boolean(a && a.consentGrantedAt);

/**
 * A player who is their own guardian: a college athlete, 18+, invited with no parent.
 * Both slots then hold one uid, so nobody else reads their thread and there is no
 * consent for anyone else to give. The flag covers a record not yet claimed; the uids
 * cover one written before the flag existed.
 */
export const isAdult = (a: Athlete | null | undefined): boolean =>
  Boolean(a && (a.adult === true || (a.guardianUid && a.guardianUid === a.playerUid)));

/** Only the guardian can call this and have it succeed; the rule enforces it server-side. */
export function setConsent(athleteId: string, granted: boolean) {
  return updateDoc(doc(db, 'athletes', athleteId), {
    consentGrantedAt: granted ? serverTimestamp() : deleteField(),
  });
}

/**
 * Invite a player. Both uid slots start EMPTY: the player (and the parent, for a minor)
 * fill their own in by signing up with the address named here, which is the only way a
 * non-coach ever writes a uid onto this record.
 *
 * Leave the guardian blank for a college player (18+). The record then names the player
 * in both slots and is marked `adult`: they claim both with one address and manage their
 * own consent. A guardian entered means the original model, untouched.
 *
 * Leave playerEmail blank for a player under 13 — they get no login of their own and
 * the family shares the parent's account. That is the cheap COPPA-compliant path, and
 * it is a decision the coach makes per family rather than something the app guesses.
 */
export async function inviteAthlete(input: {
  playerName: string;
  guardianName?: string;
  guardianEmail?: string;
  playerEmail?: string;
  age?: number;
}) {
  const playerName = input.playerName.trim();
  const guardianName = input.guardianName?.trim() ?? '';
  const guardianEmail = input.guardianEmail?.trim().toLowerCase() ?? '';
  const playerEmail = input.playerEmail?.trim().toLowerCase() ?? '';
  const adult = !guardianName && !guardianEmail;
  // Half a guardian is a typo, and an adult with no address of their own can never claim.
  if (!adult && !(guardianName && guardianEmail)) {
    throw new Error('Enter both the parent name and email, or leave both blank.');
  }
  if (adult && !playerEmail) throw new Error('An adult player needs their own email address.');
  return addDoc(collection(db, 'athletes'), {
    playerName,
    guardianName: adult ? playerName : guardianName,
    guardianEmail: adult ? playerEmail : guardianEmail,
    ...(playerEmail ? { playerEmail } : {}),
    ...(adult ? { adult: true } : {}),
    ...(input.age ? { age: input.age } : {}),
    guardianUid: '',
    playerUid: '',
    joinedAt: serverTimestamp(),
    // consentGrantedAt is deliberately absent. The rules reject a coach who sets it.
  });
}

/**
 * Open the threads for a player who has signed up.
 *
 * Cannot run earlier: the create rule demands the guardian's uid be among the readers,
 * and until she claims her slot that uid is the empty string. The player's thread is
 * skipped entirely when there is no player login, which is the under-13 shape.
 *
 * `coachUids` is every coach there is right now, so each of them can post: a thread is
 * immutable once created, and a coach who claims the role later can read it (the rules let
 * any coach) but cannot post in it.
 *
 * An adult player holds both slots (guardianUid === playerUid), so there is no parent to
 * talk to and nobody to monitor: one coach<->player thread, with each uid listed once.
 * The create rule still holds — it asks for the guardian's uid among the readers, and the
 * player's uid is that uid.
 */
export async function createThreadsFor(athlete: Athlete, coachUids: string[]) {
  const uniq = (uids: string[]) => Array.from(new Set(uids.filter(Boolean)));
  const adult = isAdult(athlete);
  const writes: Promise<unknown>[] = [];

  if (!adult) {
    writes.push(
      setDoc(doc(db, 'threads', `${athlete.id}_parent`), {
        athleteId: athlete.id,
        kind: 'coach-parent',
        title: `${COACH_NAME} ↔ ${athlete.guardianName}`,
        participants: uniq([...coachUids, athlete.guardianUid]),
        readers: uniq([...coachUids, athlete.guardianUid]),
      })
    );
  }

  if (athlete.playerUid) {
    writes.push(
      setDoc(doc(db, 'threads', `${athlete.id}_player`), {
        athleteId: athlete.id,
        kind: 'coach-player',
        title: `${COACH_NAME} ↔ ${athlete.playerName}`,
        participants: uniq([...coachUids, athlete.playerUid]),
        // The guardian reads but never posts. This array IS the monitoring guarantee,
        // and the rules refuse to create the thread without her in it. For an adult she
        // is the player, and uniq() keeps the list at [coaches..., player].
        readers: uniq([...coachUids, athlete.playerUid, athlete.guardianUid]),
      })
    );
  }

  await Promise.all(writes);
}

// --- threads and messages --------------------------------------------------

/**
 * One query serves all three roles. Everyone who may see a thread is in `readers` —
 * the coach and the athlete as participants, the guardian as a reader-only — so
 * `array-contains uid` is exactly the set the rule allows, with no per-role branching.
 */
export function subscribeThreads(uid: string, cb: (t: Thread[]) => void): Unsubscribe {
  return onSnapshot(
    query(collection(db, 'threads'), where('readers', 'array-contains', uid)),
    (snap) => {
      const threads = snap.docs.map((d) => ({ id: d.id, ...d.data() }) as Thread);
      // The athlete's own thread first, then the parent thread — the order the preview
      // uses, and the order that puts the thing you came for at the top.
      threads.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'coach-player' ? -1 : 1));
      cb(threads);
    },
    err('threads')
  );
}

/**
 * The most recent `max` messages, oldest-first for rendering.
 *
 * Ordered DESCENDING and reversed rather than ascending, which matters more than it
 * looks: `orderBy('createdAt','asc') + limit(500)` returns the OLDEST 500, so a thread
 * that ever passed 500 messages would freeze — every new message falls outside the
 * window and never arrives.
 *
 * `serverTimestamps: 'estimate'` fills in a local estimate for a message that is still
 * in flight. Without it a just-sent message reads back with createdAt === null, which
 * sorts unpredictably and makes your own message jump around the thread until the
 * server confirms it. The final sort is done here, on the estimates, so the order on
 * screen never depends on how the query treated a pending write.
 */
export function subscribeMessages(
  threadId: string,
  cb: (m: Message[]) => void,
  max = 200
): Unsubscribe {
  return onSnapshot(
    query(collection(db, 'threads', threadId, 'messages'), orderBy('createdAt', 'desc'), limit(max)),
    (snap) => {
      const msgs = snap.docs.map(
        (d) => ({ id: d.id, ...d.data({ serverTimestamps: 'estimate' }) }) as Message
      );
      msgs.sort((a, b) => (a.createdAt?.toMillis() ?? 0) - (b.createdAt?.toMillis() ?? 0));
      cb(msgs);
    },
    err('messages')
  );
}

/**
 * Just the newest message, for a thread row's preview line.
 *
 * The list used to subscribe to every message in every thread and take the last one —
 * up to 500 document reads per thread, per cold start, to draw two lines of text. On
 * Firestore's free tier that was comfortably the largest thing on the bill. This reads
 * exactly one.
 */
export function subscribeLastMessage(
  threadId: string,
  cb: (m: Message | null) => void
): Unsubscribe {
  return onSnapshot(
    query(collection(db, 'threads', threadId, 'messages'), orderBy('createdAt', 'desc'), limit(1)),
    (snap) => {
      const d = snap.docs[0];
      cb(d ? ({ id: d.id, ...d.data({ serverTimestamps: 'estimate' }) } as Message) : null);
    },
    err('lastMessage')
  );
}

/**
 * The rule requires `createdAt == request.time`, which is precisely what
 * serverTimestamp() produces — a client clock can neither backdate a message nor race
 * ahead of one. It also pins the field set, so nothing may be smuggled alongside.
 */
export function sendMessage(threadId: string, senderUid: string, text: string) {
  return addDoc(collection(db, 'threads', threadId, 'messages'), {
    senderUid,
    text: text.trim().slice(0, 4000),
    createdAt: serverTimestamp(),
  });
}

/**
 * Mirrors `canSend()` in the rules. The UI uses this to grey out the composer; the rule
 * is what actually stops the write. If these two ever disagree the rule wins, and the
 * user sees a failure instead of a locked box — which is the right way round.
 */
export function canPostIn(thread: Thread, uid: string, athlete: Athlete | null): boolean {
  if (!thread.participants.includes(uid)) return false;
  if (athlete && uid === athlete.playerUid) return hasConsent(athlete);
  return true;
}

// --- calendar --------------------------------------------------------------

/**
 * The coach's rule branch ignores the document, so he may list the whole collection.
 * Everyone else must constrain by athleteId or the query is rejected outright.
 *
 * ponytail: sorted in memory and unbounded by date. A season is a few hundred events.
 * Add a startsAt range filter — and the composite index it needs — when a roster makes
 * that false.
 */
export function subscribeEvents(
  role: Role,
  athleteId: string | null,
  cb: (e: SessionEvent[]) => void,
  uid?: string
): Unsubscribe {
  const base = collection(db, "events");
  const sort = (list: SessionEvent[]) =>
    list.sort((a, b) => (a.startsAt?.toMillis() ?? 0) - (b.startsAt?.toMillis() ?? 0));

  // The coach reads the collection unconstrained; isCoach() does not look at the
  // document, so no query shape can return something he may not read.
  if (role === "coach" && !athleteId) {
    return onSnapshot(
      query(base),
      (snap) => cb(sort(snap.docs.map((x) => ({ id: x.id, ...x.data() }) as SessionEvent))),
      err("events")
    );
  }

  // A family needs both branches of the read rule, and one query cannot ask both
  // questions: athleteId == theirs covers their own sessions and anything scheduled
  // before they signed up, memberUids array-contains covers every coached session
  // they were written into. Merged by id, because a session they are the primary
  // athlete on satisfies both and would otherwise appear twice.
  const seen = new Map<string, SessionEvent[]>();
  const emit = () => {
    const byId = new Map<string, SessionEvent>();
    for (const e of [...seen.values()].flat()) byId.set(e.id, e);
    cb(sort([...byId.values()]));
  };
  const watch = (key: string, q: Query<DocumentData>) =>
    onSnapshot(
      q,
      (snap) => {
        seen.set(
          key,
          snap.docs.map((x) => ({ id: x.id, ...x.data() }) as SessionEvent)
        );
        emit();
      },
      err("events:" + key)
    );

  const stops = [watch("own", query(base, where("athleteId", "==", athleteId)))];
  if (uid) stops.push(watch("shared", query(base, where("memberUids", "array-contains", uid))));
  return () => stops.forEach((s) => s());
}

// --- the Locker ------------------------------------------------------------

/**
 * The Locker's list: what the coach published, plus the worksheets that ship inside
 * the binary. Merged here, in the one function every consumer reads through, so the
 * screens cannot disagree about whether a built-in exists.
 *
 * A published document with the same id wins, which is the upgrade path: publish
 * `builtin-match-tracker` to Firestore and it replaces the shipped copy everywhere
 * without an app release.
 */
export function subscribeWorkflows(cb: (w: Workflow[]) => void): Unsubscribe {
  return onSnapshot(
    collection(db, 'workflows'),
    (snap) => {
      const published = snap.docs.map((d) => ({ id: d.id, ...d.data() }) as Workflow);
      const ids = new Set(published.map((w) => w.id));
      const list = [...published, ...BUILTIN_WORKFLOWS.filter((w) => !ids.has(w.id))];
      list.sort((a, b) => a.name.localeCompare(b.name));
      cb(list);
    },
    err('workflows')
  );
}

/** A built-in by id, or null. Lets a screen open one without asking Firestore. */
export function builtinWorkflow(id: string): Workflow | null {
  return isBuiltin(id) ? (BUILTIN_WORKFLOWS.find((w) => w.id === id) ?? null) : null;
}

/**
 * Every submission this athlete has made, keyed by SUBMISSION id — which is the
 * workflow id for a one-off and `{workflowId}__{periodKey}` for a repeating one.
 * Callers that want "the submissions for workflow X" should filter on `workflowId`
 * rather than look up by workflow id, or they will miss every repeat.
 */
export function subscribeSubmissions(
  athleteId: string,
  cb: (s: Record<string, SavedWorkflow>) => void
): Unsubscribe {
  return onSnapshot(
    collection(db, 'athletes', athleteId, 'savedWorkflows'),
    (snap) => {
      const out: Record<string, SavedWorkflow> = {};
      snap.docs.forEach((d) => {
        const data = d.data() as SavedWorkflow;
        // Submissions written before workflowId existed as a field carry it in the id.
        out[d.id] = { ...data, ...(data.workflowId ? {} : parseSubmissionId(d.id)) };
      });
      cb(out);
    },
    err('savedWorkflows')
  );
}

/**
 * The coach's view across the roster. One listener per athlete rather than a
 * collection-group query, which would need its own rules block and a composite index.
 * ponytail: fine for one trainer. If the roster reaches the dozens, denormalise a
 * lastSubmissionAt onto the athlete doc and open submissions on demand.
 */
export function subscribeRosterSubmissions(
  athleteIds: string[],
  cb: (byAthlete: Record<string, Record<string, SavedWorkflow>>) => void
): Unsubscribe {
  const acc: Record<string, Record<string, SavedWorkflow>> = {};
  const unsubs = athleteIds.map((aid) =>
    subscribeSubmissions(aid, (subs) => {
      acc[aid] = subs;
      cb({ ...acc });
    })
  );
  return () => unsubs.forEach((u) => u());
}

/**
 * Save one submission. The answers are the athlete's; the coach's HTML is never copied.
 *
 * The cadence decides whether this overwrites or files a new document: a weekly game
 * evaluation saved on two different weeks must not collide, and the same evaluation
 * saved twice in one week must.
 */
export function saveWorkflowAnswers(
  athleteId: string,
  workflow: Pick<Workflow, 'id' | 'cadence'>,
  answers: Record<string, string | boolean | number>,
  now: Date
) {
  const cadence = workflow.cadence ?? 'once';
  const sid = submissionId(workflow.id, cadence, now);
  return setDoc(doc(db, 'athletes', athleteId, 'savedWorkflows', sid), {
    // The rule caps this at 200 keys; truncating here turns a would-be permission
    // error into a save that works, on a document nobody will ever fill that far.
    answers: Object.fromEntries(Object.entries(answers).slice(0, 200)),
    updatedAt: serverTimestamp(),
    // Both are required together: the rule pins the id to these, so a client cannot
    // file this week's evaluation under a different week.
    workflowId: workflow.id,
    periodKey: periodKey(cadence, now),
  });
}

// --- notification preferences ----------------------------------------------

export function subscribePrefs(uid: string, cb: (p: UserPrefs) => void): Unsubscribe {
  return onSnapshot(
    doc(db, 'users', uid),
    (snap) => {
      // A document Firestore has not actually confirmed is absent is not news. On a
      // cold start the SDK answers from cache first, and for a document it has never
      // cached that answer is "does not exist" — which as a UserPrefs is an account
      // with no streak, no colour and no mutes. Reporting that would make every launch
      // flash empty settings for a moment, and anything that wrote back off it would
      // erase the real ones.
      if (!snap.exists() && snap.metadata.fromCache) return;
      cb((snap.data() as UserPrefs) ?? { mutedThreads: [] });
    },
    err('prefs')
  );
}

/**
 * One read, for the once-per-sign-in streak check. Returns `confirmed: false` when all
 * Firestore could offer was a cached miss, which is the caller's signal to do nothing:
 * counting a day against a document that may exist on the server is how a streak gets
 * silently reset to 1.
 */
export async function readPrefsOnce(uid: string): Promise<{ prefs: UserPrefs; confirmed: boolean }> {
  const snap = await getDoc(doc(db, 'users', uid));
  return {
    prefs: (snap.data() as UserPrefs) ?? { mutedThreads: [] },
    confirmed: snap.exists() || !snap.metadata.fromCache,
  };
}

/**
 * Stored under the muter's own uid, so a player cannot clear a mute his guardian set —
 * it is not in a document he is allowed to write.
 */
export function setMuted(uid: string, prefs: UserPrefs, threadId: string, muted: boolean) {
  const next = muted
    ? Array.from(new Set([...(prefs.mutedThreads ?? []), threadId]))
    : (prefs.mutedThreads ?? []).filter((t) => t !== threadId);
  return setDoc(doc(db, 'users', uid), { ...prefs, mutedThreads: next }, { merge: true });
}

/**
 * Everything else that lives in the account's own preferences document: the chat
 * colour, and the reward counters.
 *
 * One writer for all of it, because they share a document and a partial `setDoc`
 * without the merge below would drop the mute list. `patch` is whatever changed;
 * `prefs` is what the session already has loaded, so nothing needs re-reading first.
 */
export function savePrefs(uid: string, prefs: UserPrefs, patch: Partial<UserPrefs>) {
  return setDoc(doc(db, 'users', uid), { ...prefs, ...patch }, { merge: true });
}

/**
 * Delete this account's own preferences document. Called from the account-deletion
 * flow, which App Store Review Guideline 5.1.1(v) requires any app with a signup
 * screen to offer.
 *
 * It is the ONLY Firestore document an account owns outright, so it is the only one
 * deletion can remove. Messages are deliberately permanent — they are the record a
 * guardian is promised, and `allow update, delete: if false` on /threads/{tid}/messages
 * binds the coach too. The athlete record belongs to the coach. The deletion screen
 * says both of those in plain words rather than implying a clean sweep.
 */
export function deletePrefs(uid: string) {
  return deleteDoc(doc(db, 'users', uid));
}

// --- the workout log -------------------------------------------------------

/**
 * One completed session, written by the family, read by the coach.
 *
 * The reward counters in /users are private to the account and the coach cannot read
 * them by design. This is the shared half: a self-report, the same shape of trust as a
 * saved worksheet, filed under the athlete so a coached session (ONE shared /events row
 * for up to eight athletes) still records who actually did it.
 *
 * The document id is the EVENT id, so finishing twice overwrites rather than duplicates.
 */
export function logWorkoutDone(
  athleteId: string,
  event: Pick<SessionEvent, 'id' | 'name'>,
  stats: { minutes: number; blocksDone: number; blocksTotal: number }
) {
  return setDoc(doc(db, 'athletes', athleteId, 'workoutLog', event.id), {
    eventId: event.id,
    // Denormalised so the coach's list reads without a second fetch per row, and so it
    // still says what was done after the session itself is deleted from the calendar.
    name: (event.name ?? 'Workout').slice(0, 140),
    completedAt: serverTimestamp(),
    // The rule pins these to whole numbers in range; clamping here turns a would-be
    // permission error into a save that works.
    minutes: Math.max(0, Math.min(600, Math.round(stats.minutes))),
    blocksDone: Math.max(0, Math.min(60, Math.round(stats.blocksDone))),
    blocksTotal: Math.max(0, Math.min(60, Math.round(stats.blocksTotal))),
  });
}

export function subscribeWorkoutLog(
  athleteId: string,
  cb: (byEvent: Record<string, WorkoutLogEntry>) => void
): Unsubscribe {
  return onSnapshot(
    collection(db, 'athletes', athleteId, 'workoutLog'),
    (snap) => {
      const byEvent: Record<string, WorkoutLogEntry> = {};
      snap.docs.forEach((d) => (byEvent[d.id] = { id: d.id, ...d.data() } as WorkoutLogEntry));
      cb(byEvent);
    },
    err('workout log')
  );
}

/** The whole roster's logs, keyed by athlete. Same shape as subscribeRosterSubmissions. */
export function subscribeRosterWorkoutLogs(
  athleteIds: string[],
  cb: (byAthlete: Record<string, Record<string, WorkoutLogEntry>>) => void
): Unsubscribe {
  const acc: Record<string, Record<string, WorkoutLogEntry>> = {};
  const unsubs = athleteIds.map((aid) =>
    subscribeWorkoutLog(aid, (log) => {
      acc[aid] = log;
      cb({ ...acc });
    })
  );
  return () => unsubs.forEach((u) => u());
}

// --- workout templates ------------------------------------------------------

/**
 * The Workout Builder's library. Coach-only in both directions, so there is no
 * query shape to be careful about here: the rule does not look at the document.
 */
export function subscribeTemplates(cb: (t: WorkoutTemplate[]) => void): Unsubscribe {
  return onSnapshot(
    collection(db, 'workoutTemplates'),
    (snap) => {
      const list = snap.docs.map((d) => ({ id: d.id, ...d.data() }) as WorkoutTemplate);
      list.sort((a, b) => a.name.localeCompare(b.name));
      cb(list);
    },
    err('workoutTemplates')
  );
}

/**
 * How much of a block there is, in one phrase. Every screen that lists blocks prints
 * this, so the reps-or-minutes decision is made once: a block written before reps
 * existed carries no `measure`, and absence means time.
 */
export const blockAmount = (b: WorkoutBlock) =>
  b.measure === 'reps' ? `${b.reps ?? 0} reps` : `${b.minutes} min`;

/** A reps block has no duration, so it adds nothing here. Callers that print this
 *  have to cope with zero: see WorkoutTemplate.totalMinutes. */
export const totalMinutes = (blocks: WorkoutBlock[]) =>
  blocks.reduce((n, b) => n + (b.measure === 'reps' ? 0 : Number(b.minutes) || 0), 0);

/**
 * The stored shape of one block. `measure` and `reps` are written only for a reps
 * block, so a timed one keeps exactly the shape it has had since the builder shipped
 * and absence keeps meaning time.
 */
const blockBody = (b: WorkoutBlock) => ({
  id: b.id,
  name: b.name.trim(),
  minutes: Number(b.minutes) || 0,
  ...(b.measure === 'reps' ? { measure: 'reps' as const, reps: Number(b.reps) || 0 } : {}),
  ...(b.notes?.trim() ? { notes: b.notes.trim() } : {}),
});

/** Create or overwrite. Returns the id so a fresh template can be selected at once. */
export async function saveTemplate(t: Omit<WorkoutTemplate, 'updatedAt'>): Promise<string> {
  const body = {
    name: t.name.trim(),
    type: t.type,
    // Both are written, always. `type` is what the rules and the calendar read, and
    // `types` is the whole set: writing only one of them loses a selection.
    types: t.types?.length ? t.types : [t.type],
    kind: t.kind,
    // Strip undefined: Firestore rejects it, and an empty note is absence, not a value.
    blocks: t.blocks.map(blockBody),
    totalMinutes: totalMinutes(t.blocks),
    updatedAt: serverTimestamp(),
  };
  if (t.id) {
    await setDoc(doc(db, 'workoutTemplates', t.id), body);
    return t.id;
  }
  const ref = await addDoc(collection(db, 'workoutTemplates'), body);
  return ref.id;
}

export function deleteTemplate(id: string) {
  return deleteDoc(doc(db, 'workoutTemplates', id));
}

// --- scheduling -------------------------------------------------------------

/**
 * Firestore commits at most 500 writes in one batch. A coached session projected
 * out is athletes x occurrences, which reaches 500 faster than it looks: six
 * athletes every week for a season is 312. Callers are told the number before they
 * confirm, so this is a backstop rather than the thing that enforces the limit.
 */
export const MAX_SCHEDULED = 480;

/**
 * A unique id, generated on the client. Hermes has no global crypto.randomUUID, so
 * this borrows Firestore's own id generator, which is the one part of the SDK that
 * exists to mint collision-resistant ids offline. The document it names is never
 * created; only its id is taken.
 */
const newId = () => doc(collection(db, "ids")).id;

export interface ScheduleInput {
  /**
   * The athlete records, not just their ids: a shared session has to write each
   * family's uids into memberUids, and the rules check them against these same
   * documents.
   */
  athletes: Athlete[];
  /** The primary category. */
  type: SessionType;
  /** Every category the session covers. Defaults to just the primary one. */
  types?: SessionType[];
  name: string;
  location: string;
  startsAt: Date;
  kind: WorkoutKind;
  blocks: WorkoutBlock[];
  durationMin: number;
  notes?: string;
  templateId?: string;
  /** 1 writes a single session. */
  occurrences: number;
  everyWeeks: number;
}

/** Everyone who may read a session: each athlete's guardian, and the athlete too
 *  where they have a login. An empty uid is a family that has not signed up, and it
 *  is dropped rather than written, because '' in a membership list would match a
 *  document whose own slot is still empty. */
export const audienceOf = (athletes: Athlete[]) =>
  Array.from(
    new Set(athletes.flatMap((a) => [a.guardianUid, a.playerUid]).filter((uid) => !!uid))
  );

/** An athlete nobody has claimed yet cannot be put on a SHARED session: the rules
 *  refuse a membership list that does not carry their guardian, and their guardian
 *  has no uid to carry. Individual sessions are fine, and start resolving the moment
 *  the family signs up. */
export const canShareWith = (a: Athlete) => !!a.guardianUid;

/** The most athletes one shared session can carry. The rules unroll their audience
 *  check to exactly this many (firestore.rules `audienceWritten`), so a ninth is
 *  refused on every write. */
export const MAX_SHARED = 8;

/**
 * The audience as it stands NOW, for any coach write to a shared session.
 *
 * memberUids is written when a session is scheduled, but the rules re-check it
 * against the athlete records on EVERY write. A child who got their own login since
 * would otherwise make the session impossible to move, edit or cancel, and invisible
 * to that child. Rebuilding it on each write fixes both the next time the coach
 * touches the session. An event with no athleteIds predates sharing and needs nothing.
 */
async function freshAudience(ids: string[] | undefined): Promise<{ memberUids?: string[] }> {
  if (!ids?.length) return {};
  const snaps = await Promise.all(ids.map((id) => getDoc(doc(db, 'athletes', id))));
  return { memberUids: audienceOf(snaps.map((s) => ({ id: s.id, ...s.data() }) as Athlete)) };
}

/** freshAudience, read once per distinct group however many sessions share it. */
function audienceReader() {
  const seen = new Map<string, ReturnType<typeof freshAudience>>();
  return (ids: string[] | undefined) => {
    const key = ids?.join('|') ?? '';
    if (!seen.has(key)) seen.set(key, freshAudience(ids));
    return seen.get(key)!;
  };
}

/**
 * Write a workout onto one or more calendars, projected out as far as asked.
 *
 * A coached session is ONE document carrying every athlete on it, and a `memberUids`
 * list saying who may read it. That costs nothing at read time, which is the point:
 * the alternative shape, one copy per athlete, meant a group of six produced six
 * documents to cancel, six to move, and six rows in the coach's own month.
 *
 * The cost moved to write time, where each athlete on the session is one document
 * get inside the rule. Writes therefore go one at a time and NOT in a batch: a
 * batched write shares a single document-access budget across every document in it,
 * so a projected run of twelve would blow through it on the third occurrence.
 * Losing atomicity is the trade, and the caller is told how many landed.
 */
export async function scheduleWorkout(input: ScheduleInput): Promise<number> {
  const dates = projectDates(input.startsAt, input.occurrences, input.everyWeeks);
  const shared = input.kind === 'coached' && input.athletes.length > 1;
  // A coached session is one document per DATE. Individual work is one per athlete
  // per date, because those are separate workouts that happen to have been typed in
  // once.
  const perDate = shared ? 1 : input.athletes.length;
  const total = dates.length * perDate;
  if (total === 0) return 0;
  if (shared && input.athletes.length > MAX_SHARED) {
    throw new Error(`The limit is ${MAX_SHARED} athletes on one coached session.`);
  }
  if (total > MAX_SCHEDULED) {
    throw new Error(`That would write ${total} sessions. The limit is ${MAX_SCHEDULED} in one go.`);
  }

  const seriesId = dates.length > 1 ? newId() : undefined;
  const blocks = input.blocks.map(blockBody);

  const base = (athletes: Athlete[], date: Date) => ({
    athleteId: athletes[0].id,
    athleteIds: athletes.map((a) => a.id),
    memberUids: audienceOf(athletes),
    type: input.type,
    types: input.types?.length ? input.types : [input.type],
    name: input.name.trim(),
    location: input.location.trim(),
    startsAt: Timestamp.fromDate(date),
    timeLabel: clockLabel(date, input.type),
    kind: input.kind,
    blocks,
    durationMin: input.durationMin,
    ...(input.notes?.trim() ? { notes: input.notes.trim() } : {}),
    ...(input.templateId ? { templateId: input.templateId } : {}),
    ...(seriesId ? { seriesId } : {}),
  });

  const writes: Promise<unknown>[] = [];
  for (const date of dates) {
    if (shared) {
      writes.push(setDoc(doc(collection(db, 'events')), base(input.athletes, date)));
    } else {
      for (const a of input.athletes) {
        writes.push(setDoc(doc(collection(db, 'events')), base([a], date)));
      }
    }
  }
  await Promise.all(writes);
  return total;
}

/** Edit one session in place. startsAt is handled by moveEvent, which also has to
 *  rewrite the stored clock label. */
export async function updateEvent(e: SessionEvent, patch: Partial<SessionEvent>) {
  return updateDoc(doc(db, 'events', e.id), {
    ...patch,
    ...(await freshAudience(e.athleteIds)),
  } as Record<string, unknown>);
}

/**
 * Drag and drop, and the time field on the editor, both land here.
 *
 * `keepTime` is what a drag across the month grid means: the same session, a
 * different day. Dropping a 4pm Tuesday onto Thursday must not silently move it to
 * midnight, which is what writing the target day alone would do.
 */
export async function moveEvent(e: SessionEvent, to: Date, keepTime = true) {
  const from = e.startsAt.toDate();
  const next = new Date(to);
  if (keepTime) next.setHours(from.getHours(), from.getMinutes(), 0, 0);
  return updateDoc(doc(db, 'events', e.id), {
    startsAt: Timestamp.fromDate(next),
    timeLabel: clockLabel(next, e.type),
    ...(await freshAudience(e.athleteIds)),
  });
}

/**
 * Edit one session, its time included, in a single write.
 *
 * startsAt and the stored clock label always move together. Two writes could leave a
 * row showing 4:00 PM on a session that is now at 5:00, and the calendar prints the
 * label in preference to the timestamp, so that row would lie until someone noticed.
 */
export async function editEvent(
  e: SessionEvent,
  when: Date,
  patch: Omit<Partial<SessionEvent>, "id" | "startsAt" | "timeLabel"> & { type: SessionType }
) {
  return updateDoc(doc(db, "events", e.id), {
    ...patch,
    startsAt: Timestamp.fromDate(when),
    timeLabel: clockLabel(when, patch.type),
    ...(await freshAudience(e.athleteIds)),
  } as Record<string, unknown>);
}

export function deleteEvent(id: string) {
  return deleteDoc(doc(db, 'events', id));
}

/**
 * Apply one change to every event sharing a field, which is how "this and every
 * following session" works without a second data model. `after` keeps it to the
 * occurrences from this one onward, because moving a whole series backwards in time
 * including the ones already played is never what anyone means.
 */
export async function applyToSeries(
  events: SessionEvent[],
  seriesId: string,
  after: Date | null,
  op: (e: SessionEvent) => Record<string, unknown> | null
): Promise<number> {
  const members = events.filter(
    (e) => e.seriesId === seriesId && (!after || e.startsAt.toDate() >= after)
  );
  if (!members.length) return 0;
  // Updates run the audience check in the rules, which costs a document get per
  // athlete on each session. A batch would share one document-access budget across
  // the whole series and be refused partway through a long run.
  const audience = audienceReader();
  const writes = members
    .slice(0, MAX_SCHEDULED)
    .map((e) => ({ e, patch: op(e) }))
    .filter((x) => x.patch)
    .map(async (x) =>
      updateDoc(doc(db, 'events', x.e.id), {
        ...x.patch,
        ...(await audience(x.e.athleteIds)),
      } as Record<string, unknown>)
    );
  await Promise.all(writes);
  return writes.length;
}

export async function deleteSeries(events: SessionEvent[], seriesId: string, after: Date | null) {
  const members = events.filter(
    (e) => e.seriesId === seriesId && (!after || e.startsAt.toDate() >= after)
  );
  const batch = writeBatch(db);
  members.slice(0, MAX_SCHEDULED).forEach((e) => batch.delete(doc(db, 'events', e.id)));
  await batch.commit();
  return members.length;
}

/**
 * Paste. Copies whole sessions onto another day, keeping each one's time of day and
 * its ordering within the day, so pasting a Tuesday onto a Thursday reproduces
 * Tuesday's shape rather than stacking everything at one hour.
 */
export async function pasteEvents(events: SessionEvent[], onto: Date): Promise<number> {
  if (!events.length) return 0;
  if (events.length > MAX_SCHEDULED) throw new Error('Too many sessions to paste at once.');
  // Not a batch, for the same reason scheduleWorkout is not: each of these spends a
  // document get per athlete inside the rule, and a batched write shares one
  // document-access budget across every document in it.
  const audience = audienceReader();
  const writes = events.map(async (e) => {
    const from = e.startsAt.toDate();
    const next = new Date(onto);
    next.setHours(from.getHours(), from.getMinutes(), 0, 0);
    return setDoc(doc(collection(db, 'events')), {
      athleteId: e.athleteId,
      // The copy carries the original's audience, as it stands today rather than
      // as it was when the original was scheduled. Without it the rules reject the
      // write, and rightly so: a session nobody can read is worse than no session.
      ...(e.athleteIds ? { athleteIds: e.athleteIds } : {}),
      ...(e.athleteIds ? await audience(e.athleteIds) : e.memberUids ? { memberUids: e.memberUids } : {}),
      type: e.type,
      ...(e.types?.length ? { types: e.types } : {}),
      name: e.name,
      location: e.location,
      startsAt: Timestamp.fromDate(next),
      timeLabel: clockLabel(next, e.type),
      ...(e.kind ? { kind: e.kind } : {}),
      ...(e.blocks ? { blocks: e.blocks } : {}),
      ...(e.durationMin ? { durationMin: e.durationMin } : {}),
      ...(e.notes ? { notes: e.notes } : {}),
      ...(e.templateId ? { templateId: e.templateId } : {}),
      // A pasted copy is a new session, not a member of the original's series.
      // Inheriting seriesId would make "cancel the series" reach into a day the
      // coach copied it to by hand, which is not what he asked for.
    });
  });
  await Promise.all(writes);
  return events.length;
}

