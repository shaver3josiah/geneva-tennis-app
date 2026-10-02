import { useState } from 'react';
import { BrandIcon } from './Logo';
import { Platform, StyleSheet, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useSession } from './session';
import { COACH_NAME, backend } from './firebase';
import { claimCoach } from './data';
import { Button, KeyboardForm } from './ui';
import { color, radius, semantic, type } from './theme';

/** Shown on a refused claim. Wrong code, or an address Firebase has not marked verified. */
const WRONG_CODE = 'That code is not right. Ask the head coach or the app admin.';

/**
 * The two ways an account can be real and still have nothing to show.
 *
 * Both were previously invisible: you signed in successfully and landed on an app with
 * no threads, no calendar and no explanation, which reads as "the app is broken" rather
 * than "you have one step left". Saying which of the two it is, and what to do, is the
 * whole job of this screen.
 *
 * The second one is also where a coach lands. Nobody invites a coach by email: a coach
 * signs up like anyone else, confirms the address, and claims the role here with the
 * team's coach code.
 */
export function Pending() {
  const { user, needsVerification, resendVerification, signOut, refresh } = useSession();
  const insets = useSafeAreaInsets();
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState(user?.displayName ?? '');
  const [code, setCode] = useState('');
  const [claiming, setClaiming] = useState(false);
  const [claimError, setClaimError] = useState<string | null>(null);
  const email = user?.email ?? 'your address';

  async function resend() {
    setBusy(true);
    try {
      await resendVerification();
      setSent(true);
    } catch {
      // Firebase rate-limits this. Saying "sent" anyway would be a lie, so say nothing
      // changed and let them try again.
      setSent(false);
    } finally {
      setBusy(false);
    }
  }

  async function claim() {
    if (!user || !name.trim() || !code.trim()) return;
    setClaiming(true);
    setClaimError(null);
    try {
      await claimCoach(user.uid, name, user.email ?? '', code);
      // The role changed without the auth user changing, so ask the session to look again.
      // It swaps this screen for the coach's tabs.
      await refresh();
    } catch (e) {
      // The rules refuse a wrong code with permission-denied and say nothing more, which
      // is the point: the screen cannot tell a near miss from a stranger.
      setClaimError(
        (e as { code?: string })?.code === 'permission-denied'
          ? WRONG_CODE
          : 'Could not claim coach access. Check your connection and try again.'
      );
    } finally {
      setClaiming(false);
    }
  }

  return (
    <KeyboardForm
      style={s.page}
      contentContainerStyle={[
        s.inner,
        { paddingTop: insets.top + 72, paddingBottom: insets.bottom + 24, flexGrow: 1 },
      ]}
    >
      <BrandIcon size={46} />

      {needsVerification ? (
        <>
          <Text style={s.h1}>Confirm your email</Text>
          <Text style={s.body}>
            We sent a link to {email}. Open it, then sign in again.
          </Text>
          <Text style={s.small}>
            Confirming the address is what connects you to the team. It is also what stops
            someone else claiming your place using an address that is not theirs. There is no
            way past this step.
          </Text>
          <View style={{ height: 20 }} />
          <Button
            label={sent ? 'Sent, check your inbox' : 'Resend the link'}
            onPress={resend}
            busy={busy}
            disabled={sent}
          />
        </>
      ) : (
        <>
          <Text style={s.h1}>Nearly there</Text>
          <Text style={s.body}>
            Your account works, but {COACH_NAME} has not added {email} to the roster yet.
          </Text>
          <Text style={s.small}>
            The coach connects each player by email address. If you signed up with a different
            address from the one you gave them, sign out and create your account with that one
            instead.
          </Text>

          {/* Coaches are not invited. They arrive here like everyone else and claim the role. */}
          <View style={s.coach}>
            <Text style={s.coachTitle}>I’m a coach</Text>
            <Text style={s.small}>
              Coaches do not wait for an invite. Enter your name and the coach code to take coach
              access on this account.
            </Text>

            <Text style={s.label}>Your name</Text>
            <TextInput
              style={s.input}
              value={name}
              onChangeText={setName}
              maxLength={60}
              autoCapitalize="words"
              autoCorrect={false}
              textContentType="name"
              autoComplete="name"
              placeholder="Coach Smith"
              placeholderTextColor={color.textFaint}
              accessibilityLabel="Your name"
            />

            <Text style={s.label}>Coach code</Text>
            <TextInput
              style={s.input}
              value={code}
              onChangeText={setCode}
              autoCapitalize="none"
              autoCorrect={false}
              placeholder="Ask the head coach"
              placeholderTextColor={color.textFaint}
              accessibilityLabel="Coach code"
              onSubmitEditing={claim}
              returnKeyType="go"
            />

            {claimError ? (
              <Text style={s.error} accessibilityLiveRegion="polite">
                {claimError}
              </Text>
            ) : null}

            <View style={{ height: 14 }} />
            <Button
              label="Claim coach access"
              onPress={claim}
              busy={claiming}
              disabled={!name.trim() || !code.trim()}
            />
          </View>
        </>
      )}

      <View style={{ flex: 1, minHeight: 24 }} />

      {/* The account's own id. This screen is where someone lands when the app cannot
          work out who they are, and that is exactly when the id is worth showing: a player
          can read it out for support. Without it the only way to find a uid is the
          Firebase console. */}
      <View style={s.diag}>
        <Text style={s.diagLabel}>Your account id</Text>
        <Text selectable style={s.diagValue}>
          {user?.uid ?? '–'}
        </Text>
        <Text style={s.diagNote}>Backend: {backend.label}</Text>
      </View>

      <Button label="Sign out" onPress={signOut} />
    </KeyboardForm>
  );
}

const s = StyleSheet.create({
  page: { flex: 1, backgroundColor: semantic.surfacePage },
  inner: { paddingHorizontal: 24 },
  h1: { fontSize: 30, fontWeight: '900', color: color.bone, letterSpacing: -0.5, marginBottom: 12 },
  body: { ...type.body, fontSize: 16, lineHeight: 23, marginBottom: 16 },
  small: { ...type.meta, lineHeight: 18 },
  coach: {
    marginTop: 28,
    backgroundColor: semantic.surfaceCard,
    borderWidth: 1,
    borderColor: semantic.border,
    borderRadius: radius.cardLg,
    padding: 16,
  },
  coachTitle: { fontSize: 17, fontWeight: '800', color: color.chalk, marginBottom: 6 },
  label: {
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 1.4,
    textTransform: 'uppercase',
    color: color.textDim,
    marginBottom: 6,
    marginTop: 14,
  },
  input: {
    backgroundColor: semantic.surfaceInput,
    borderWidth: 1,
    borderColor: semantic.borderStrong,
    borderRadius: radius.input,
    color: color.chalk,
    fontSize: 16,
    minHeight: 48,
    paddingHorizontal: 14,
  },
  error: { marginTop: 14, color: color.danger, fontSize: 13.5, lineHeight: 19 },
  diag: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: semantic.border,
    paddingTop: 14,
    marginBottom: 16,
  },
  diagLabel: {
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 1.2,
    textTransform: 'uppercase',
    color: color.textFaint,
    marginBottom: 4,
  },
  diagValue: {
    fontSize: 12.5,
    color: color.textDim,
    fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' }),
  },
  diagNote: { ...type.meta, fontSize: 11.5, lineHeight: 16, marginTop: 8 },
});
