import { useEffect, useState } from 'react';
import { useSession } from '../session';
import { ensureMember } from '../matches';

export type MatchAccess = 'ready' | 'checking' | 'failed';

/**
 * Whether this account may read /matches yet.
 *
 * The coach always may. Anyone else needs a /members document, which the session writes
 * the first time their athlete record resolves. A screen that subscribed before that
 * write landed would be refused, and a refused Firestore listener never recovers on its
 * own: the list would sit empty until the next launch. So every match screen waits on
 * this first. ensureMember is memoised, so it costs nothing after the first ask.
 */
export function useMatchAccess(): { access: MatchAccess; retry: () => void } {
  const { role, user, athlete } = useSession();
  const [access, setAccess] = useState<MatchAccess>(role === 'coach' ? 'ready' : 'checking');
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (role === 'coach') return setAccess('ready');
    if (!user || !athlete?.id) return setAccess('failed');
    let live = true;
    setAccess('checking');
    ensureMember(user.uid, athlete.id).then((ok) => live && setAccess(ok ? 'ready' : 'failed'));
    return () => {
      live = false;
    };
  }, [role, user?.uid, athlete?.id, attempt]);

  return { access, retry: () => setAttempt((n) => n + 1) };
}
