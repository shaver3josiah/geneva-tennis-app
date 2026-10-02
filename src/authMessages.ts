/**
 * What a password reset says back, and what it refuses to say.
 *
 * Pure and dependency-free so a plain node script can run its self-check. The check
 * exists for one reason: an unknown address MUST get the same answer as a known one.
 * That is the whole security property of this screen, it is one line away from being
 * "helpfully" improved into a leak, and nothing else in the app would notice.
 */

/** Firebase's own answer decides ours. `sent` means show the confirmation; a string
 *  is an error to put on screen. */
export type ResetOutcome = { kind: 'sent' } | { kind: 'error'; message: string };

const SENT: ResetOutcome = { kind: 'sent' };

/**
 * Map an auth error code from sendPasswordResetEmail onto what the user is told.
 *
 * `auth/user-not-found` maps to SENT on purpose. Saying "no account for that address"
 * turns this screen into a way to ask whether a given family trains here, and this app
 * holds conversations between a coach and other people's children. The reset link
 * simply does not arrive if there is no account, which is the behaviour anyone
 * legitimate needs.
 *
 * (This project's Firebase has email enumeration protection switched on, so the code
 * does not normally arrive at all: Firebase answers success for an unknown address and
 * sends nothing. The branch is kept because that is a console setting somebody could
 * turn off, and the screen should not start leaking if they do.)
 */
export function resetOutcome(code: string): ResetOutcome {
  switch (code) {
    case '':
      return SENT;
    case 'auth/user-not-found':
      return SENT;
    case 'auth/invalid-email':
      return { kind: 'error', message: 'That does not look like an email address.' };
    case 'auth/missing-email':
      return { kind: 'error', message: 'Type your email address first, then tap this again.' };
    case 'auth/too-many-requests':
      return {
        kind: 'error',
        message: 'Too many tries. Wait a few minutes and ask for another link.',
      };
    case 'auth/network-request-failed':
      return { kind: 'error', message: 'No connection. Check your signal and try again.' };
    default:
      // An unexpected code is a real failure and is NOT dressed up as success: telling
      // someone a link is coming when it is not leaves them waiting for an email that
      // will never arrive.
      return { kind: 'error', message: 'Could not send the link. Try again in a moment.' };
  }
}

/** Run by scripts/check-auth-messages.mjs. Kept out of the module's own bottom so no
 *  argv branch ships inside the app bundle. */
export function demo(): string {
  const eq = (got: unknown, want: unknown, what: string) => {
    if (got !== want) throw new Error(`${what}: got ${String(got)}, wanted ${String(want)}`);
  };

  // The property this file exists for. If these two ever differ, the screen has become
  // a way to test whether a given person is on the team.
  const unknown = resetOutcome('auth/user-not-found');
  const success = resetOutcome('');
  eq(unknown.kind, 'sent', 'an unknown address is told a link was sent');
  eq(success.kind, 'sent', 'a known address is told a link was sent');
  eq(
    JSON.stringify(unknown),
    JSON.stringify(success),
    'an unknown address and a known one must be indistinguishable'
  );

  // A real failure is a real failure. Swallowing these would leave someone waiting for
  // an email that is never coming.
  for (const code of [
    'auth/invalid-email',
    'auth/too-many-requests',
    'auth/network-request-failed',
    'auth/internal-error',
    'something-nobody-has-seen',
  ]) {
    eq(resetOutcome(code).kind, 'error', `${code} surfaces as an error`);
  }

  // Every error says what to do next, not just what went wrong.
  for (const code of ['auth/invalid-email', 'auth/too-many-requests', 'auth/network-request-failed']) {
    const out = resetOutcome(code);
    if (out.kind !== 'error' || out.message.length < 20) {
      throw new Error(`${code} needs a message that says what to do`);
    }
  }

  return 'authMessages.ts: all checks passed';
}
