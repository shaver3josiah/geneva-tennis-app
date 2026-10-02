import { useState } from 'react';
import {
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
  useWindowDimensions,
} from 'react-native';
import { Link, Redirect } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useSession } from '../src/session';
import { backend, isConfigured } from '../src/firebase';
import { Logo } from '../src/Logo';
import { Button, KeyboardForm } from '../src/ui';
import { color, radius, semantic, type } from '../src/theme';

export default function SignIn() {
  const { user, signIn, resetPassword } = useSession();
  const insets = useSafeAreaInsets();
  // The lockup carries 9% clear space on each side, so the mark itself gets the
  // remaining 1/1.18 of the gutter-to-gutter width.
  const win = useWindowDimensions();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resetSent, setResetSent] = useState(false);

  if (user) return <Redirect href="/(tabs)" />;

  async function forgotPassword() {
    setBusy(true);
    setError(null);
    const out = await resetPassword(email);
    setBusy(false);
    if (out.kind === 'sent') {
      setResetSent(true);
      return;
    }
    setResetSent(false);
    setError(out.message);
  }

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      await signIn(email, password);
    } catch (e: unknown) {
      // Firebase returns auth/invalid-credential for a wrong password AND for an
      // unknown address, deliberately, so an attacker cannot enumerate accounts.
      // The message says the same thing rather than leaking which one it was.
      const code = (e as { code?: string })?.code ?? '';
      setError(
        code === 'auth/invalid-credential' || code === 'auth/wrong-password' || code === 'auth/user-not-found'
          ? 'That email and password do not match an account.'
          : code === 'auth/network-request-failed'
            ? 'No connection. Check your signal and try again.'
            : code === 'auth/too-many-requests'
              ? 'Too many attempts. Wait a minute and try again.'
              : 'Could not sign in. Please try again.'
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <KeyboardForm
      style={s.page}
      contentContainerStyle={[s.inner, { paddingTop: insets.top + 48, paddingBottom: insets.bottom + 24 }]}
    >
        {/* The brand lockup. Keep it a <Logo>, never type set in a Text: the design system
            forbids setting the wordmark in type. */}
        <Logo width={(win.width - 48) / 1.18} />
        <Text style={s.lede}>
          Messages, the practice calendar and match stats for Geneva College tennis. Sign in with the
          email address your coach added.
        </Text>

        {backend.kind === 'emulator' && (
          <View style={s.notice}>
            <Text style={s.noticeText}>
              Pointing at the LOCAL EMULATOR, not your Firebase project. If sign-in fails to
              connect, either start it with `npm run emulators` or run `npm run use-cloud` to
              switch back.
            </Text>
          </View>
        )}

        {!isConfigured && (
          <View style={s.notice}>
            <Text style={s.noticeText}>
              No Firebase project is configured. Copy .env.example to .env and fill it in, or set
              EXPO_PUBLIC_USE_EMULATOR=1 and run the local emulator.
            </Text>
          </View>
        )}

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
          textContentType="password"
          autoComplete="current-password"
          placeholder="••••••••"
          placeholderTextColor={color.textFaint}
          accessibilityLabel="Password"
          onSubmitEditing={submit}
          returnKeyType="go"
        />

        {resetSent ? (
          <View style={s.reset} accessibilityLiveRegion="polite">
            <Text style={s.resetText}>
              If there is an account for {email.trim().toLowerCase()}, a reset link is on
              its way. Open it on this phone, choose a new password, then come back and
              sign in. Check spam if it is not there in a couple of minutes.
            </Text>
          </View>
        ) : (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Email me a password reset link"
            onPress={forgotPassword}
            disabled={busy}
            style={s.forgotRow}
          >
            <Text style={s.forgot}>Forgot your password?</Text>
          </Pressable>
        )}

        {error ? (
          <Text style={s.error} accessibilityLiveRegion="polite">
            {error}
          </Text>
        ) : null}

        <View style={{ height: 18 }} />
        <Button label="Sign in" onPress={submit} busy={busy} disabled={!email || !password} />

        <Link href="/sign-up" asChild>
          <Pressable accessibilityRole="link" style={s.linkRow}>
            <Text style={s.link}>New here? Create your account</Text>
          </Pressable>
        </Link>

        <Text style={s.foot}>
          Trouble getting in? Ask your coach to check the address they added.
        </Text>
    </KeyboardForm>
  );
}

const s = StyleSheet.create({
  page: { flex: 1, backgroundColor: semantic.surfacePage },
  inner: { paddingHorizontal: 24 },
  lede: { ...type.body, marginBottom: 26 },
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
  notice: {
    backgroundColor: color.goldTint,
    borderWidth: 1,
    borderColor: color.gold,
    borderRadius: radius.card,
    padding: 12,
    marginBottom: 8,
  },
  noticeText: { color: color.textBody, fontSize: 12.5, lineHeight: 18 },
  forgotRow: { minHeight: 44, justifyContent: 'center', alignSelf: 'flex-start' },
  forgot: { fontSize: 13.5, fontWeight: '700', color: color.goldHot },
  reset: {
    marginTop: 12,
    padding: 12,
    borderRadius: radius.card,
    borderWidth: 1,
    borderColor: color.blueLine,
    backgroundColor: color.blueTint,
  },
  resetText: { fontSize: 13, lineHeight: 18.5, color: color.chalk },
  linkRow: { minHeight: 44, justifyContent: 'center', alignItems: 'center', marginTop: 18 },
  link: { color: color.goldHot, fontSize: 14, fontWeight: '700' },
  foot: { ...type.meta, marginTop: 14, textAlign: 'center' },
});
