import { useState } from 'react';
import { BrandIcon } from '../src/Logo';
import {
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { Link, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { createUserWithEmailAndPassword, sendEmailVerification, signOut } from 'firebase/auth';
import { auth } from '../src/firebase';
import { Button, KeyboardForm } from '../src/ui';
import { color, radius, semantic, type } from '../src/theme';

/**
 * Creating the account is only half of joining. The security rules identify a parent or
 * a player by matching their uid against an athlete record that ONLY a coach
 * can create — so an account nobody invited signs in to an empty app.
 *
 * Signing up therefore claims the slot the coach already set aside for that email
 * address, and the claim requires a VERIFIED address. Without that, anyone who knew a
 * client's email could take their place and read a minor's conversation. That is why
 * this screen ends at "check your email" rather than dropping straight into the app.
 */
export default function SignUp() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  async function submit() {
    setError(null);
    if (password.length < 8) {
      setError('Use at least 8 characters.');
      return;
    }
    setBusy(true);
    try {
      const cred = await createUserWithEmailAndPassword(auth, email.trim().toLowerCase(), password);
      await sendEmailVerification(cred.user);
      // Firebase signs you in the instant the account exists, which is wrong here: the
      // account cannot reach anything until the address is confirmed, and staying
      // signed in meant "Back to sign in" bounced straight off the auth gate into the
      // pending screen. You are not in until you have clicked the link.
      await signOut(auth);
      setSent(true);
    } catch (e: unknown) {
      const code = (e as { code?: string })?.code ?? '';
      setError(
        code === 'auth/email-already-in-use'
          ? 'There is already an account for that address. Try signing in instead.'
          : code === 'auth/invalid-email'
            ? 'That does not look like an email address.'
            : code === 'auth/weak-password'
              ? 'That password is too easy to guess. Use at least 8 characters.'
              : code === 'auth/network-request-failed'
                ? 'No connection. Check your signal and try again.'
                : 'Could not create the account. Please try again.'
      );
    } finally {
      setBusy(false);
    }
  }

  if (sent) {
    return (
      <View style={[s.page, s.inner, { paddingTop: insets.top + 64 }]}>
        <BrandIcon size={46} />
        <Text style={s.h1}>Check your email</Text>
        <Text style={s.lede}>
          We sent a confirmation link to {email.trim().toLowerCase()}. Open it, then come back and
          sign in.
        </Text>
        <Text style={s.small}>
          Confirming the address is what connects you to the team. Until then the app has
          nothing to show you. If the link has not arrived in a few minutes, check spam.
        </Text>
        <View style={{ height: 22 }} />
        <Button label="Back to sign in" onPress={() => router.replace('/sign-in')} />
      </View>
    );
  }

  return (
    <KeyboardForm
      style={s.page}
      contentContainerStyle={[
        s.inner,
        { paddingTop: insets.top + 44, paddingBottom: insets.bottom + 24 },
      ]}
    >
        <BrandIcon size={46} />
        <Text style={s.h1}>Create your account</Text>
        <Text style={s.lede}>
          Use the same email address you gave your coach. That is how the app knows which player
          you are. Coaches sign up the same way, then claim coach access on the next screen.
        </Text>

        <Text style={s.label}>Email</Text>
        <TextInput
          style={s.input}
          value={email}
          onChangeText={setEmail}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="email-address"
          textContentType="username"
          autoComplete="email"
          placeholder="you@example.com"
          placeholderTextColor={color.textFaint}
          accessibilityLabel="Email"
        />

        <Text style={s.label}>Password</Text>
        <TextInput
          style={s.input}
          value={password}
          onChangeText={setPassword}
          secureTextEntry
          textContentType="newPassword"
          autoComplete="new-password"
          placeholder="At least 8 characters"
          placeholderTextColor={color.textFaint}
          accessibilityLabel="Password"
          onSubmitEditing={submit}
          returnKeyType="go"
        />

        {error ? (
          <Text style={s.error} accessibilityLiveRegion="polite">
            {error}
          </Text>
        ) : null}

        <View style={{ height: 18 }} />
        <Button label="Create account" onPress={submit} busy={busy} disabled={!email || !password} />

        <Text style={s.small}>
          Players under 13 use their parent’s account only. Do not create a separate login for
          them.
        </Text>

        <Link href="/sign-in" asChild>
          <Pressable accessibilityRole="link" style={s.linkRow}>
            <Text style={s.link}>Already have an account? Sign in</Text>
          </Pressable>
        </Link>
    </KeyboardForm>
  );
}

const s = StyleSheet.create({
  page: { flex: 1, backgroundColor: semantic.surfacePage },
  inner: { paddingHorizontal: 24 },
  h1: { fontSize: 30, fontWeight: '900', color: color.bone, letterSpacing: -0.5, marginBottom: 10 },
  lede: { ...type.body, marginBottom: 20 },
  label: {
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 1.4,
    textTransform: 'uppercase',
    color: color.textFaint,
    marginBottom: 6,
    marginTop: 12,
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
  small: { ...type.meta, marginTop: 18, lineHeight: 18 },
  linkRow: { minHeight: 44, justifyContent: 'center', marginTop: 6 },
  link: { color: color.goldHot, fontSize: 14, fontWeight: '700' },
});
