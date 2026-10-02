import { useEffect, useRef, useState } from 'react';
import Ionicons from '@expo/vector-icons/Ionicons';
import { Share, StyleSheet, Text, View } from 'react-native';
import { Redirect, Stack } from 'expo-router';
import * as Clipboard from 'expo-clipboard';
import { useSession } from '../../src/session';
import { CONNECTOR_SOURCE, CONNECTOR_VERSION } from '../../src/tennis/connectorSource';
import { connectorPost, hasConnector, saveTeamSettings, subscribeTeamSettings } from '../../src/matches';
import { Field } from '../../src/match/form';
import type { TeamSettings } from '../../src/types';
import { Body, Button, Card, CardTitle, Eyebrow, GhostButton, Screen } from '../../src/ui';
import { color, radius } from '../../src/theme';

const STEPS = [
  'On a computer, open script.new signed in to the Google account that should own the sheets. Delete the sample code and paste the script.',
  'Near the top, change TOKEN to a secret of your own. Keep the quotes, then save.',
  'Deploy, then New deployment, type Web app. Execute as: Me. Who has access: Anyone. Click Deploy.',
  'Authorize. When Google says it has not verified the app, click Advanced, then Go to Geneva Tennis, then Allow. You pasted this script yourself, and it only touches spreadsheets in your Drive.',
  'Copy the Web app URL, the one ending in /exec. Paste it below with the same token and tap Test connection.',
];

/** Anything else is a typo, or the /dev test URL that only works while signed in. */
const EXEC_URL = /^https:\/\/script\.google\.com\/.+\/exec\/?$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * The coach's one-time setup for the Google Sheets connector (sheets-connector/Code.gs).
 * Coach only: team/settings is his to write, and the rules say so too.
 */
export default function SheetsSetup() {
  const { role } = useSession();
  const [settings, setSettings] = useState<TeamSettings | null>(null);
  const [url, setUrl] = useState('');
  const [token, setToken] = useState('');
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const seeded = useRef(false);

  useEffect(() => {
    if (role !== 'coach') return;
    return subscribeTeamSettings((s) => {
      setSettings(s);
      // Seed the fields once. Doing it on every snapshot would wipe whatever he is typing.
      if (seeded.current) return;
      seeded.current = true;
      setUrl(s.sheetsUrl ?? '');
      setToken(s.sheetsToken ?? '');
      setEmail(s.coachEmail ?? '');
    });
  }, [role]);

  if (role !== 'coach') return <Redirect href="/matches" />;

  async function run(key: string, job: () => Promise<string>) {
    setBusy(key);
    setResult(null);
    try {
      setResult({ ok: true, text: await job() });
    } catch (e) {
      setResult({ ok: false, text: (e as Error)?.message || 'That did not work. Try again.' });
    } finally {
      setBusy(null);
    }
  }

  function check(needConnector: boolean): string | null {
    const u = url.trim();
    if (u && /\/dev\/?$/.test(u)) return 'That is the test URL, which works only while you are signed in. Use the Web app URL that ends in /exec.';
    if (u && !EXEC_URL.test(u)) return 'That does not look like a web app URL. It starts with https://script.google.com/ and ends in /exec.';
    if ((u || needConnector) && !token.trim()) return 'Type the token you set in the script.';
    if (needConnector && !u) return 'Paste the web app URL first.';
    if (email.trim() && !EMAIL.test(email.trim())) return 'That email address is missing something.';
    return null;
  }

  const test = () =>
    run('test', async () => {
      const bad = check(true);
      if (bad) throw new Error(bad);
      const reply = await connectorPost(url, token, 'ping');
      const old = (reply.version ?? 0) < CONNECTOR_VERSION;
      return (
        (reply.owner ? `Connected to ${reply.owner}. New sheets go to that account's Drive.` : 'Connected.') +
        (old ? ' This script is older than the app: copy it again, paste it over the old one, and deploy a new version.' : ' Tap Save to switch it on.')
      );
    });

  const save = () =>
    run('save', async () => {
      const bad = check(false);
      if (bad) throw new Error(bad);
      await saveTeamSettings({ sheetsUrl: url, sheetsToken: token, coachEmail: email });
      return url.trim()
        ? 'Saved. Every match tracked live now syncs to its own sheet in your Drive.'
        : 'Saved. No connector, so matches stay in the app until someone exports them.';
    });

  const connected = hasConnector(settings);

  return (
    <Screen>
      <Stack.Screen options={{ title: 'Google Sheets' }} />

      <View style={[s.status, connected && s.statusOn]}>
        <Ionicons
          name={connected ? 'checkmark-circle' : 'ellipse-outline'}
          size={18}
          color={connected ? color.win : color.textDim}
        />
        <Text style={s.statusText}>
          {settings === null
            ? 'Checking…'
            : connected
              ? 'Connected. Matches tracked live write to your Drive every 3 points.'
              : 'Not set up yet. About five minutes on a computer, once.'}
        </Text>
      </View>

      <Body>
        Every match tracked live gets its own spreadsheet in your Google Drive, filled in point by point
        with a formatted summary. It runs on a small script you own, so no data goes anywhere but your
        account.
      </Body>

      <Eyebrow style={{ marginTop: 20 }}>Set it up</Eyebrow>
      <Card>
        {STEPS.map((step, i) => (
          <View key={i} style={s.step}>
            <Text style={s.stepNo}>{i + 1}</Text>
            <Text style={s.stepText}>{step}</Text>
          </View>
        ))}
        <View style={s.row}>
          <GhostButton
            label="Copy script"
            icon="copy-outline"
            disabled={!!busy}
            onPress={() =>
              run('copy', async () => {
                await Clipboard.setStringAsync(CONNECTOR_SOURCE);
                return 'Copied. Paste it into the script editor.';
              })
            }
          />
          <GhostButton
            label="Send to my computer"
            icon="share-outline"
            disabled={!!busy}
            // The share sheet reaches AirDrop, Mail, Notes and Drive: whichever way the
            // script gets from his phone to the computer he is setting it up on.
            onPress={() =>
              run('send', async () => {
                await Share.share({ message: CONNECTOR_SOURCE, title: 'Geneva Tennis connector script' });
                return 'Open it on the computer and copy everything into the script editor.';
              })
            }
          />
        </View>
      </Card>

      <Eyebrow style={{ marginTop: 20 }}>Connect</Eyebrow>
      <Card>
        <Field
          label="Web app URL"
          value={url}
          onChangeText={setUrl}
          placeholder="https://script.google.com/macros/s/…/exec"
          autoCapitalize="none"
          keyboardType="url"
        />
        <Field
          label="Token"
          value={token}
          onChangeText={setToken}
          placeholder="The secret you set as TOKEN"
          autoCapitalize="none"
          hint="Anyone with the URL and the token can make sheets in your Drive. Keep the pair to yourself."
        />
        <Field
          label="Coach email for student reports"
          value={email}
          onChangeText={setEmail}
          placeholder="coach@geneva.edu"
          autoCapitalize="none"
          keyboardType="email-address"
          hint="Where Email stats sends a match from a student's phone. Works with or without the connector."
        />
        <View style={s.row}>
          <GhostButton label={busy === 'test' ? 'Testing…' : 'Test connection'} icon="pulse-outline" disabled={!!busy} onPress={test} />
        </View>
        {result ? (
          <View style={[s.result, !result.ok && s.resultBad]} accessibilityLiveRegion="polite">
            <Ionicons
              name={result.ok ? 'checkmark-circle' : 'alert-circle'}
              size={16}
              color={result.ok ? color.win : color.danger}
            />
            <Text style={s.resultText}>{result.text}</Text>
          </View>
        ) : null}
        <View style={{ height: 14 }} />
        <Button label="Save" onPress={save} busy={busy === 'save'} disabled={!!busy && busy !== 'save'} />
      </Card>

      <Eyebrow style={{ marginTop: 20 }}>No setup at all</Eyebrow>
      <Card>
        <Body>
          Open any match, go to Export and tap New Google Sheet. It copies the point log and opens a blank
          sheet: paste into cell A1. Copy for Google Sheets does the same for a sheet you already have.
        </Body>
      </Card>
    </Screen>
  );
}

const s = StyleSheet.create({
  status: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    padding: 12,
    marginBottom: 14,
    borderRadius: radius.card,
    borderWidth: 1,
    borderColor: color.slate,
  },
  statusOn: { borderColor: 'rgba(70,214,140,0.45)', backgroundColor: 'rgba(70,214,140,0.07)' },
  statusText: { flex: 1, fontSize: 14, lineHeight: 19, fontWeight: '700', color: color.chalk },
  step: { flexDirection: 'row', gap: 12, marginBottom: 12 },
  stepNo: {
    width: 26,
    height: 26,
    borderRadius: 13,
    overflow: 'hidden',
    textAlign: 'center',
    lineHeight: 26,
    fontSize: 13,
    fontWeight: '800',
    color: color.night,
    backgroundColor: color.gold,
  },
  stepText: { flex: 1, fontSize: 14, lineHeight: 20, color: color.textBody },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginTop: 4 },
  result: {
    flexDirection: 'row',
    gap: 8,
    alignItems: 'flex-start',
    marginTop: 12,
    padding: 12,
    borderRadius: radius.card,
    borderWidth: 1,
    borderColor: 'rgba(70,214,140,0.45)',
    backgroundColor: 'rgba(70,214,140,0.08)',
  },
  resultBad: { borderColor: 'rgba(255,90,90,0.5)', backgroundColor: 'rgba(255,90,90,0.08)' },
  resultText: { flex: 1, fontSize: 13.5, lineHeight: 19, color: color.chalk },
});
