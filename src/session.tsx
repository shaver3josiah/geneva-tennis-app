import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { AppState } from 'react-native';
import {
  onAuthStateChanged,
  sendEmailVerification,
  sendPasswordResetEmail,
  signInWithEmailAndPassword,
  signOut as fbSignOut,
  type User,
} from 'firebase/auth';
import { COACH_NAME, auth } from './firebase';
import {
  resolveRole,
  subscribeAthlete,
  subscribeAthletes,
  subscribeCoaches,
  subscribePrefs,
  readPrefsOnce,
  savePrefs,
  hasConsent,
  isAdult,
  setConsent,
  findInvite,
  claimInvite,
  type Invite,
} from './data';
import { readState, visit, dayKey } from './rewards';
import { ensureMember } from './matches';
import { syncReminders } from './notify';
import { resetOutcome, type ResetOutcome } from './authMessages';
import type { Athlete, Coach, Role, UserPrefs } from './types';

interface Session {
  user: User | null;
  role: Role;
  /** The athlete this account is attached to. For the coach, whoever is first on the
   *  roster — use `athletesById` when the athlete a screen means is a specific one. */
  athlete: Athlete | null;
  /** Every athlete this account can see. One entry for a family, the roster for the coach. */
  athletesById: Record<string, Athlete>;
  /** Every coach, oldest claim first. Only a coach's session fills it. */
  coaches: Coach[];
  /** This account is an adult player (18+, no guardian) and manages their own consent. */
  adult: boolean;
  /** Look the account up again: its role, its athlete and anything still open to claim.
   *  Claiming coach access changes the answer without changing the auth user. */
  refresh: () => Promise<void>;
  prefs: UserPrefs;
  /** False until auth has reported in and the role lookup has finished. */
  ready: boolean;
  consent: boolean;
  /** Signed in, but the address has not been confirmed yet — nothing will resolve. */
  needsVerification: boolean;
  /** Signed in and verified, but no athlete record names this address and it is not a coach. */
  notInvited: boolean;
  resendVerification: () => Promise<void>;
  /** Ask Firebase to email a reset link. Resolves with the outcome to show rather than
   *  throwing, because the one case that must NOT be distinguishable from success is
   *  an error code, and a caller that catches is a caller that can leak it. */
  resetPassword: (email: string) => Promise<ResetOutcome>;
  signIn: (email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
}

const Ctx = createContext<Session | null>(null);

/**
 * Who is this, and is there anything still open for their address to claim?
 *
 * A freshly verified account matches no uid field on any athlete, so the lookup falls back
 * to the invitation naming its address and claims the slot(s) there. An adult player
 * (invited with no guardian) names the same address in BOTH slots, so they are claimed one
 * write at a time, guardian then player — and if the second write never landed, a later
 * lookup finishes the job instead of leaving them half-attached. Once both are theirs, an
 * adult with no consent on record grants it, since there is no guardian to do it.
 *
 * `stale` is asked before each write: a sign-out mid-lookup must not claim anything.
 */
async function lookup(user: User, stale: () => boolean): Promise<{ role: Role; athlete: Athlete | null }> {
  let found = await resolveRole(user.uid);
  if (found.role === 'coach' || !user.emailVerified || stale()) return found;
  const email = (user.email ?? '').toLowerCase();

  let invite: Invite | null = null;
  if (!found.athlete) {
    // A freshly verified account still holds a token minted before verification,
    // and the rules read email_verified off that token — so without refreshing it
    // the claim is denied for a user who has genuinely just clicked the link.
    await user.getIdToken(true).catch(() => {});
    invite = await findInvite(email);
  } else if (found.athlete.adult) {
    const a = found.athlete;
    const fields = (['guardianUid', 'playerUid'] as const).filter(
      (f) => a[f] === '' && (f === 'guardianUid' ? a.guardianEmail : a.playerEmail) === email
    );
    if (fields.length) invite = { athleteId: a.id, fields };
  }
  if (invite && !stale()) {
    await claimInvite(invite, user.uid).catch((e) => console.warn('[gt] claim failed:', e));
    found = await resolveRole(user.uid);
  }

  const a = found.athlete;
  if (a && !stale() && isAdult(a) && a.guardianUid === user.uid && !hasConsent(a)) {
    await setConsent(a.id, true).catch((e) => console.warn('[gt] adult consent failed:', e));
  }
  return found;
}

export function SessionProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [role, setRole] = useState<Role>('player');
  const [athlete, setAthlete] = useState<Athlete | null>(null);
  const [athletesById, setAthletesById] = useState<Record<string, Athlete>>({});
  const [coaches, setCoaches] = useState<Coach[]>([]);
  const [tick, setTick] = useState(0);
  const [prefs, setPrefs] = useState<UserPrefs>({ mutedThreads: [] });
  const [ready, setReady] = useState(false);

  useEffect(() => onAuthStateChanged(auth, (u) => setUser(u)), []);

  // Resolve the role once per sign-in. `cancelled` matters because a fast
  // sign-out during the lookup would otherwise write a stale role back in.
  // `tick` re-runs it on demand: claiming coach access changes the answer, and nothing
  // about the auth user does.
  useEffect(() => {
    let cancelled = false;
    if (!user) {
      setRole('player');
      setAthlete(null);
      setAthletesById({});
      setPrefs({ mutedThreads: [] });
      setReady(true);
      return;
    }
    setReady(false);
    lookup(user, () => cancelled)
      .then(({ role: r, athlete: a }) => {
        if (cancelled) return;
        setRole(r);
        setAthlete(a);
      })
      .catch((e) => console.warn('[gt] role lookup failed:', e))
      .finally(() => !cancelled && setReady(true));
    return () => {
      cancelled = true;
    };
  }, [user, tick]);

  // Every coach, for the roster: a thread names all of them, so each can post in it.
  // Only a coach needs the list, so nobody else pays for the listener.
  useEffect(() => {
    if (!user || role !== 'coach') {
      setCoaches([]);
      return;
    }
    return subscribeCoaches(setCoaches);
  }, [user?.uid, role]);

  // Consent has to be live, not fetched once: when a parent revokes it on her phone,
  // the player's composer should lock on theirs without either of them relaunching.
  useEffect(() => {
    if (!athlete?.id) return;
    return subscribeAthlete(athlete.id, (a) => a && setAthlete(a));
  }, [athlete?.id]);

  // Matches are read by coaches and roster MEMBERS, and the rules know a member by
  // /members/{uid}. Written here the first time the athlete record resolves, a single
  // read on every launch after that. Never throws; see src/matches.ts.
  useEffect(() => {
    if (!user || role === 'coach' || !athlete?.id) return;
    void ensureMember(user.uid, athlete.id);
  }, [user?.uid, role, athlete?.id]);

  useEffect(() => {
    if (!user) return;
    return subscribeAthletes(role, user.uid, setAthletesById);
  }, [user?.uid, role]);

  const refresh = useCallback(async () => setTick((n) => n + 1), []);

  useEffect(() => {
    if (!user) return;
    return subscribePrefs(user.uid, setPrefs);
  }, [user?.uid]);

  /**
   * The daily streak, counted at sign-in and again every time the app comes back to
   * the foreground.
   *
   * It used to run on every prefs snapshot, and that was the bug: Firestore answers a
   * cold listener from cache first, and for a document it has never cached the answer
   * is "does not exist". As a UserPrefs that is an account with no lastDay, which
   * `visit()` reads as a first-ever open and writes `streak: 1`, clobbering the real
   * streak arriving from the server a moment later. Every launch was a coin flip.
   *
   * So: one read, and nothing at all unless Firestore actually confirmed what it found.
   * `visit()` returns null on a day already counted, so a launch on a day already on the
   * board costs one read and no write, and a resume on that day costs nothing at all.
   */
  const streakChecked = useRef<string | null>(null);
  /** The day the last confirmed check settled, so a resume inside it does no work. */
  const checkedDay = useRef('');
  useEffect(() => {
    const uid = user?.uid;
    // Cleared on sign-out so signing back in is a fresh login and checks again.
    if (!uid) {
      streakChecked.current = null;
      checkedDay.current = '';
      return;
    }
    let cancelled = false;

    const check = async () => {
      const { prefs: saved, confirmed } = await readPrefsOnce(uid);
      if (cancelled || !confirmed) return;

      // Stamped only once the read came back confirmed, so a check that found nothing it
      // could trust (offline, cold cache) is retried on the next resume rather than
      // written off for the whole day.
      const now = new Date();
      checkedDay.current = dayKey(now);

      const before = readState(saved);
      const patch = visit(before, now);
      // NOT an empty catch. A permission-denied here is silent and fatal to the whole
      // feature: the streak simply never persists, and the only visible symptom turns up
      // later and somewhere else. That is exactly how a stale deployed ruleset hid for a
      // day. If this ever logs, check that firestore.rules is DEPLOYED, not just correct.
      if (patch)
        await savePrefs(uid, saved, patch).catch((e) =>
          console.warn('[gt] streak write refused:', (e as { code?: string })?.code ?? e)
        );

      // Re-planned here rather than on every snapshot, for the same reason: the streak
      // this is warning about has just been settled, and nothing later in the session
      // changes it. The You tab re-plans when the switch is toggled.
      await syncReminders({ ...before, ...patch }, saved.remind !== false);
    };
    const run = () => check().catch((e) => console.warn('[gt] streak check failed:', e));

    // The ref guards the mount call only, so a teardown and rebuild of this effect on
    // the same account does not read twice.
    if (streakChecked.current !== uid) {
      streakChecked.current = uid;
      run();
    }

    // A phone resumes from the switcher far more often than it cold launches, and this
    // provider is mounted at the root and never remounts, so without this the day was
    // only ever counted on a cold start: the player opened the app, the broken-streak
    // reminder fired at them in the morning anyway, and the next cold launch saw the gap
    // and reset them to 1. This call must NOT go through the ref guard above, which is
    // already spent on the mount call, or it is a silent no-op and the bug is still here.
    const sub = AppState.addEventListener('change', (state) => {
      // Only when the calendar day may have turned over. `visit()` writes nothing on a
      // day already counted and `reminderPlan` dates everything off today, so a second
      // pass inside one day is a read and a full cancel-and-reschedule for an identical
      // result. On Android it is worse than waste: asking for notification permission
      // pauses the app, so a dialog the player swipes away instead of answering leaves
      // `canAskAgain` true, and the resume it causes would ask again, and again.
      if (state === 'active' && checkedDay.current !== dayKey(new Date())) run();
    });

    return () => {
      cancelled = true;
      sub.remove();
    };
  }, [user?.uid]);

  const value = useMemo<Session>(
    () => ({
      user,
      role,
      athlete,
      athletesById,
      coaches,
      adult: isAdult(athlete),
      refresh,
      prefs,
      ready,
      consent: hasConsent(athlete),
      // The coach is exempt. The role is a /coaches document that only a verified account
      // holding the coach code could write, so a second round of verification proves
      // nothing about them — and an account the owner created in the Firebase console is
      // unverified by default, which would otherwise lock a coach out of their own app.
      needsVerification: Boolean(user && !user.emailVerified && role !== 'coach'),
      notInvited: Boolean(user && user.emailVerified && role !== 'coach' && !athlete),
      resendVerification: async () => {
        if (auth.currentUser) await sendEmailVerification(auth.currentUser);
      },
      resetPassword: async (email) => {
        const addr = email.trim().toLowerCase();
        if (!addr) return resetOutcome('auth/missing-email');
        try {
          // Firebase sends the mail and hosts the reset page itself. There is no
          // endpoint to write, no token to store, and no expiry to get wrong.
          await sendPasswordResetEmail(auth, addr);
          return resetOutcome('');
        } catch (e) {
          return resetOutcome((e as { code?: string })?.code ?? 'unknown');
        }
      },
      signIn: async (email, password) => {
        await signInWithEmailAndPassword(auth, email.trim(), password);
      },
      signOut: () => fbSignOut(auth),
    }),
    [user, role, athlete, athletesById, coaches, prefs, ready, refresh]
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSession(): Session {
  const s = useContext(Ctx);
  if (!s) throw new Error('useSession must be used inside <SessionProvider>');
  return s;
}

/**
 * Display names for the three people on a given athlete's threads. Pass the athleteId
 * the screen is actually about — a coach with two athletes must not label both threads
 * with whichever athlete happened to load first. The coach is one label for the whole
 * staff (COACH_NAME), because a thread may name several of them.
 */
export function useNames(athleteId?: string) {
  const { athlete, athletesById } = useSession();
  const a = (athleteId ? athletesById[athleteId] : null) ?? athlete;
  return {
    coach: COACH_NAME,
    parent: a?.guardianName ?? 'Parent',
    player: a?.playerName ?? 'Player',
  };
}

export const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? '')
    .join('');
