import { useEffect, useMemo, useState } from 'react';
import Ionicons from '@expo/vector-icons/Ionicons';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Stack, useRouter } from 'expo-router';
import { useSession } from '../../src/session';
import { FORMATS, type FormatPreset, type PlayerIdx } from '../../src/tennis';
import {
  connectorPost,
  createMatch,
  dateLabel,
  dayKey,
  fullTitle,
  hasConnector,
  matchTitle,
  newMatchId,
  subscribeTeamSettings,
  type NewMatch,
} from '../../src/matches';
import { useMatchAccess } from '../../src/match/useMatchAccess';
import { Chip, Field, FieldLabel } from '../../src/match/form';
import type { TeamSettings } from '../../src/types';
import { Body, Button, Card, CardTitle, GhostButton, Loading, Screen, Segmented, Setting } from '../../src/ui';
import { color, radius, semantic, type } from '../../src/theme';

const SINGLES = [1, 2, 3, 4, 5, 6].map((n) => `#${n} Singles`);
const DOUBLES = [1, 2, 3].map((n) => `#${n} Doubles`);

/** A first name for a two-way toggle; the whole name would not fit beside the other one. */
const short = (name: string, fallback: string) => name.trim().split(/\s+/)[0] || fallback;

export default function NewMatchScreen() {
  const router = useRouter();
  const { user, role, athletesById } = useSession();
  const { access, retry } = useMatchAccess();

  const [ours, setOurs] = useState('');
  const [theirs, setTheirs] = useState('');
  const [school, setSchool] = useState('');
  const [position, setPosition] = useState(SINGLES[0]);
  const [formatId, setFormatId] = useState<FormatPreset['id']>('college');
  // Picking a doubles line moves the format to college doubles, unless the format was
  // chosen by hand: then it is left alone.
  const [formatPicked, setFormatPicked] = useState(false);
  const [firstServer, setFirstServer] = useState<PlayerIdx>(0);
  const [nearAtStart, setNearAtStart] = useState<PlayerIdx>(0);
  const [date, setDate] = useState(dayKey());
  const [settings, setSettings] = useState<TeamSettings>({});
  const [makeSheet, setMakeSheet] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sheetError, setSheetError] = useState<string | null>(null);

  useEffect(() => {
    if (access !== 'ready') return;
    return subscribeTeamSettings(setSettings);
  }, [access]);

  const roster = useMemo(
    () => Object.values(athletesById).sort((a, b) => a.playerName.localeCompare(b.playerName)),
    [athletesById]
  );
  const kind = position.includes('Doubles') ? 'doubles' : 'singles';
  const offerSheet = role === 'coach' && hasConnector(settings);
  const ready = !!ours.trim() && !!theirs.trim();
  const names: [string, string] = [short(ours, 'Geneva'), short(theirs, 'Opponent')];

  function pickPosition(p: string) {
    setPosition(p);
    if (!formatPicked) setFormatId(p.includes('Doubles') ? 'doubles' : 'college');
  }

  /** Singles: the tapped name. Doubles: tap two, and they join as a team. */
  function pickPlayer(name: string) {
    if (kind === 'singles') return setOurs(name);
    const team = ours.split('/').map((n) => n.trim()).filter(Boolean);
    const next = team.includes(name) ? team.filter((n) => n !== name) : [...team, name].slice(-2);
    setOurs(next.join(' / '));
  }

  function shiftDay(by: number) {
    const [y, m, d] = date.split('-').map(Number);
    setDate(dayKey(new Date(y, m - 1, d + by)));
  }

  async function create(withSheet: boolean) {
    if (!user || !ready) return;
    setError(null);
    setSheetError(null);
    const format = FORMATS.find((f) => f.id === formatId) ?? FORMATS[0];
    // The roster record is whoever is named in the box, typed or tapped: a name typed by
    // hand that matches the roster still links the match to that athlete.
    const athlete = roster.find((a) => ours.includes(a.playerName));
    const input: NewMatch = {
      names: [ours.trim(), theirs.trim()],
      athleteId: athlete?.id,
      opponentSchool: school.trim() || undefined,
      position,
      kind,
      formatId: format.id,
      format: format.format,
      firstServer,
      nearAtStart,
      date,
    };
    const id = newMatchId();

    let sheet: { url: string; sheetId: string } | undefined;
    if (withSheet) {
      setBusy('Making the Google Sheet…');
      try {
        const reply = await connectorPost(settings.sheetsUrl!, settings.sheetsToken!, 'createMatch', {
          match: { id, title: fullTitle({ position, title: matchTitle(input.opponentSchool, theirs) }), date, names: input.names },
        });
        if (reply.url && reply.sheetId) sheet = { url: reply.url, sheetId: reply.sheetId };
      } catch (e) {
        setBusy(null);
        setSheetError((e as Error).message);
        return;
      }
    }

    setBusy('Creating the match…');
    // Firestore applies the write on this phone at once and sends it when it can. At a
    // court with one bar that can take a while, and nothing after this screen needs to
    // wait for it, so the wait is capped. A refusal inside the cap is still caught.
    const write = createMatch(id, input, user.uid, sheet);
    const outcome = await Promise.race([
      write.then(() => null),
      new Promise<null>((done) => setTimeout(() => done(null), 2500)),
    ]).catch((e: unknown) => e);
    write.catch((e) => console.warn('[gt] match create failed after the screen moved on:', e));
    setBusy(null);
    if (outcome) {
      setError('The match was not saved. Check signal and try again. If it keeps failing, the coach needs to deploy the latest rules.');
      return;
    }
    router.replace({ pathname: '/match/[id]', params: { id } });
  }

  if (access === 'checking') return <Loading label="Checking your team access…" />;
  if (access === 'failed') {
    return (
      <Screen>
        <Stack.Screen options={{ title: 'New match' }} />
        <Body>This phone could not confirm you are on the team, so it cannot start a match yet. Check signal.</Body>
        <View style={{ marginTop: 14, alignSelf: 'flex-start' }}>
          <GhostButton label="Try again" icon="refresh" onPress={retry} />
        </View>
      </Screen>
    );
  }

  return (
    <Screen>
      <Stack.Screen options={{ title: 'New match' }} />

      <Card>
        <CardTitle>Players</CardTitle>
        <FieldLabel>{kind === 'doubles' ? 'Our team' : 'Our player'}</FieldLabel>
        {roster.length > 0 && (
          <View style={s.wrap} accessibilityRole="radiogroup" accessibilityLabel="Pick from the roster">
            {roster.map((a) => (
              <Chip
                key={a.id}
                label={a.playerName}
                selected={ours.split('/').map((n) => n.trim()).includes(a.playerName)}
                onPress={() => pickPlayer(a.playerName)}
              />
            ))}
          </View>
        )}
        <Field
          label={roster.length ? 'Or type a name' : 'Name'}
          value={ours}
          onChangeText={setOurs}
          placeholder={kind === 'doubles' ? 'Ana Ruiz / Mia Chen' : 'Ana Ruiz'}
          autoCapitalize="words"
        />
        <Field label="Opponent" value={theirs} onChangeText={setTheirs} placeholder="Kate Doe" autoCapitalize="words" />
        <Field
          label="Opponent's school"
          value={school}
          onChangeText={setSchool}
          placeholder="Westminster"
          autoCapitalize="words"
        />
      </Card>

      <Card>
        <CardTitle>Match</CardTitle>
        <FieldLabel>Singles</FieldLabel>
        <View style={s.wrap} accessibilityRole="radiogroup" accessibilityLabel="Singles position">
          {SINGLES.map((p) => (
            <Chip key={p} label={p.split(' ')[0]} spoken={p} selected={position === p} onPress={() => pickPosition(p)} />
          ))}
        </View>
        <FieldLabel>Doubles</FieldLabel>
        <View style={s.wrap} accessibilityRole="radiogroup" accessibilityLabel="Doubles position">
          {DOUBLES.map((p) => (
            <Chip key={p} label={p.split(' ')[0]} spoken={p} selected={position === p} onPress={() => pickPosition(p)} />
          ))}
        </View>

        <FieldLabel>Format</FieldLabel>
        <View accessibilityRole="radiogroup" accessibilityLabel="Format" style={{ gap: 8, marginBottom: 14 }}>
          {FORMATS.map((f) => {
            const on = f.id === formatId;
            return (
              <Pressable
                key={f.id}
                accessibilityRole="radio"
                accessibilityState={{ selected: on }}
                accessibilityLabel={`${f.label}. ${f.hint}`}
                onPress={() => {
                  setFormatId(f.id);
                  setFormatPicked(true);
                }}
                style={({ pressed }) => [s.format, on && s.formatOn, pressed && !on && { backgroundColor: color.inkHover }]}
              >
                <Ionicons
                  name={on ? 'radio-button-on' : 'radio-button-off'}
                  size={20}
                  color={on ? color.goldHot : color.textDim}
                />
                <View style={{ flex: 1 }}>
                  <Text style={s.formatLabel}>{f.label}</Text>
                  <Text style={s.formatHint}>{f.hint}</Text>
                </View>
              </Pressable>
            );
          })}
        </View>

        <FieldLabel>Date</FieldLabel>
        <View style={s.date}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="The day before"
            onPress={() => shiftDay(-1)}
            style={({ pressed }) => [s.dayBtn, pressed && { backgroundColor: color.inkHover }]}
          >
            <Ionicons name="chevron-back" size={20} color={color.chalk} />
          </Pressable>
          <View style={{ flex: 1, alignItems: 'center' }} accessibilityLiveRegion="polite">
            <Text style={s.dateMain}>{dateLabel(date)}</Text>
            <Text style={s.dateSub}>{date}</Text>
          </View>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="The day after"
            onPress={() => shiftDay(1)}
            style={({ pressed }) => [s.dayBtn, pressed && { backgroundColor: color.inkHover }]}
          >
            <Ionicons name="chevron-forward" size={20} color={color.chalk} />
          </Pressable>
        </View>
      </Card>

      <Card>
        <CardTitle>At the court</CardTitle>
        <FieldLabel>Serves first</FieldLabel>
        <Segmented
          label="Serves first"
          value={String(firstServer) as '0' | '1'}
          onChange={(v) => setFirstServer(v === '1' ? 1 : 0)}
          options={[
            { value: '0', label: names[0] },
            { value: '1', label: names[1] },
          ]}
        />
        <View style={{ height: 16 }} />
        <FieldLabel>Starts on the camera end</FieldLabel>
        <Segmented
          label="Starts on the camera end"
          value={String(nearAtStart) as '0' | '1'}
          onChange={(v) => setNearAtStart(v === '1' ? 1 : 0)}
          options={[
            { value: '0', label: names[0] },
            { value: '1', label: names[1] },
          ]}
        />
        <Text style={s.hint}>The phone is behind this baseline.</Text>
      </Card>

      {offerSheet && (
        <Card>
          <Setting
            first
            title="Create a Google Sheet for this match"
            description="Made in your Drive now, so the link is on the match before the first point. Tracking keeps it up to date every 3 points."
            value={makeSheet}
            onChange={setMakeSheet}
          />
        </Card>
      )}

      {sheetError ? (
        <Card style={{ borderColor: 'rgba(255,90,90,0.5)' }}>
          <CardTitle>The Google Sheet was not made</CardTitle>
          <Body>{sheetError}</Body>
          <View style={s.choices}>
            <GhostButton label="Try again" icon="refresh" onPress={() => create(true)} />
            <GhostButton label="Create without it" onPress={() => create(false)} />
          </View>
        </Card>
      ) : null}

      {error ? (
        <Text style={s.error} accessibilityLiveRegion="polite">
          {error}
        </Text>
      ) : null}

      <Button label="Create match" onPress={() => create(offerSheet && makeSheet)} busy={!!busy} disabled={!ready} />
      <Text style={[s.hint, { textAlign: 'center' }]} accessibilityLiveRegion="polite">
        {busy ?? (ready ? 'Next: the match page, with Track live at the top.' : 'Add both players to create the match.')}
      </Text>
    </Screen>
  );
}

const s = StyleSheet.create({
  wrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 14 },
  format: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    minHeight: 56,
    padding: 12,
    borderRadius: radius.card,
    borderWidth: 1,
    borderColor: semantic.borderStrong,
    backgroundColor: semantic.surfaceInput,
  },
  formatOn: { borderColor: color.gold, backgroundColor: color.goldTint },
  formatLabel: { fontSize: 14.5, fontWeight: '700', color: color.chalk },
  formatHint: { fontSize: 12.5, lineHeight: 17, color: color.textDim, marginTop: 2 },
  date: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: semantic.surfaceInput,
    borderWidth: 1,
    borderColor: semantic.borderStrong,
    borderRadius: radius.card,
    padding: 3,
  },
  dayBtn: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center', borderRadius: radius.chip },
  dateMain: { fontSize: 15, fontWeight: '800', color: color.chalk },
  dateSub: { fontSize: 11.5, color: color.textDim, fontVariant: ['tabular-nums'], marginTop: 1 },
  hint: { ...type.meta, lineHeight: 17, marginTop: 8 },
  choices: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginTop: 12 },
  error: { color: color.danger, fontSize: 13.5, lineHeight: 19, marginBottom: 12 },
});
