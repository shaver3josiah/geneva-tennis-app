import { useEffect, useMemo, useState } from 'react';
import { StyleSheet, Text, TextInput, View } from 'react-native';
import { Redirect, Stack, useRouter } from 'expo-router';
import { useSession } from '../src/session';
import { createThreadsFor, hasConsent, inviteAthlete, isAdult, subscribeThreads } from '../src/data';
import type { Athlete, Thread } from '../src/types';
import { Banner, Body, Button, Card, CardTitle, Eyebrow, GhostButton, Screen, Tag } from '../src/ui';
import { color, radius, semantic, type } from '../src/theme';

/**
 * The coach's roster: invite a player, watch them sign up, open their threads.
 *
 * All of this used to be hand-entry in the Firebase console — including a `readers`
 * array whose contents are the parent-monitoring guarantee, and which the rules reject
 * if you get it wrong. Typing that by hand for every player was the single most
 * error-prone step in the whole setup.
 *
 * A college player (18+) is invited on their own address with no parent. They hold both
 * slots on the record and manage their own consent; the card shows one row, not two.
 */
export default function Roster() {
  const { role, user, athletesById, coaches } = useSession();
  const [threads, setThreads] = useState<Thread[]>([]);

  useEffect(() => {
    if (!user) return;
    return subscribeThreads(user.uid, setThreads);
  }, [user?.uid]);

  const threadedAthleteIds = useMemo(
    () => new Set(threads.map((t) => t.athleteId)),
    [threads]
  );

  if (role !== 'coach') return <Redirect href="/(tabs)" />;

  const athletes = Object.values(athletesById);
  // Every coach goes on a thread so each can post in it. The signed-in coach is always
  // there even if the coaches listener has not answered yet.
  const coachUids = Array.from(new Set([user?.uid ?? '', ...coaches.map((c) => c.id)].filter(Boolean)));

  return (
    <Screen>
      <Stack.Screen options={{ title: 'Roster' }} />

      <Banner tone="ok" title="How this works">
        Invite a player by email. They create their own account with that address, confirm it, and
        the app connects them automatically. Open their thread once they have. For a player under
        18, add a parent or guardian as well.
      </Banner>

      <Eyebrow>Players</Eyebrow>
      {athletes.length === 0 ? (
        <Body>Nobody yet. Invite your first player below.</Body>
      ) : (
        athletes.map((a) => (
          <AthleteCard
            key={a.id}
            athlete={a}
            hasThreads={threadedAthleteIds.has(a.id)}
            coachUids={coachUids}
          />
        ))
      )}

      <Eyebrow style={{ marginTop: 22 }}>Invite a player</Eyebrow>
      <InviteForm />
    </Screen>
  );
}

function AthleteCard({
  athlete,
  hasThreads,
  coachUids,
}: {
  athlete: Athlete;
  hasThreads: boolean;
  coachUids: string[];
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  const adult = isAdult(athlete);
  const parentIn = Boolean(athlete.guardianUid);
  const playerInvited = Boolean(athlete.playerEmail);
  const playerIn = Boolean(athlete.playerUid);
  // An adult is one person in two slots, so the thread waits for both: opening it half
  // claimed would write a thread nobody can be put on.
  const ready = adult ? parentIn && playerIn : parentIn;

  async function open() {
    setBusy(true);
    setError(null);
    try {
      await createThreadsFor(athlete, coachUids);
    } catch {
      setError('Could not open the threads. Check the rules are deployed, then try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <View style={s.head}>
        <Text style={s.name}>
          {athlete.playerName}
          {athlete.age ? ` · ${athlete.age}` : ''}
        </Text>
        {adult ? (
          // Nobody else gives consent for an adult, so there is no pending state to show.
          <Tag tone="ro">Adult · own consent</Tag>
        ) : (
          <Tag tone={hasConsent(athlete) ? 'mon' : 'ro'}>
            {hasConsent(athlete) ? 'Consent granted' : 'Consent pending'}
          </Tag>
        )}
      </View>

      {adult ? (
        <Row label="Player" who={athlete.playerName} email={athlete.playerEmail} joined={ready} />
      ) : (
        <>
          <Row
            label="Parent"
            who={athlete.guardianName}
            email={athlete.guardianEmail}
            joined={parentIn}
          />
          {playerInvited ? (
            <Row label="Player" who={athlete.playerName} email={athlete.playerEmail} joined={playerIn} />
          ) : (
            <Text style={s.note}>
              No player login. The family uses the parent’s account. That is the right shape under 13.
            </Text>
          )}
        </>
      )}

      <View style={s.foot}>
        {hasThreads ? (
          <View style={s.footRow}>
            <Text style={s.ok}>Threads open</Text>
            <GhostButton
              label="Schedule"
              icon="calendar-outline"
              onPress={() =>
                router.push({ pathname: '/athlete', params: { athleteId: athlete.id } })
              }
            />
          </View>
        ) : ready ? (
          <Button label={busy ? 'Opening…' : 'Open threads'} onPress={open} busy={busy} />
        ) : (
          <Text style={s.waiting}>
            Waiting for {(adult ? athlete.playerName : athlete.guardianName).split(' ')[0]} to sign up.
            Threads need a real account to point at.
          </Text>
        )}
      </View>
      {error ? <Text style={s.error}>{error}</Text> : null}
    </Card>
  );
}

const Row = ({
  label,
  who,
  email,
  joined,
}: {
  label: string;
  who: string;
  email?: string;
  joined: boolean;
}) => (
  <View style={s.row}>
    <View style={{ flex: 1 }}>
      <Text style={s.rowWho}>
        {label}: {who}
      </Text>
      <Text style={type.meta}>{email}</Text>
    </View>
    <Tag tone={joined ? 'mon' : 'ro'}>{joined ? 'Signed up' : 'Invited'}</Tag>
  </View>
);

function InviteForm() {
  const [playerName, setPlayerName] = useState('');
  const [playerEmail, setPlayerEmail] = useState('');
  const [age, setAge] = useState('');
  const [guardianName, setGuardianName] = useState('');
  const [guardianEmail, setGuardianEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  // No parent at all is the college case: the player claims both slots on their own
  // address. Half a parent is a typo, and the button waits until it is fixed.
  const noGuardian = !guardianName.trim() && !guardianEmail.trim();
  const fullGuardian = !!guardianName.trim() && !!guardianEmail.trim();
  const ready =
    !!playerName.trim() && (fullGuardian || (noGuardian && !!playerEmail.trim()));

  async function submit() {
    setBusy(true);
    setError(null);
    setDone(null);
    const n = Number(age);
    try {
      await inviteAthlete({
        playerName,
        guardianName,
        guardianEmail,
        playerEmail,
        age: Number.isFinite(n) && n > 0 ? n : undefined,
      });
      setDone(
        noGuardian
          ? `${playerName.trim()} added. Tell them to sign up with ${playerEmail.trim().toLowerCase()}.`
          : `${playerName.trim()} added. Tell them to sign up with the addresses above.`
      );
      setPlayerName('');
      setPlayerEmail('');
      setAge('');
      setGuardianName('');
      setGuardianEmail('');
    } catch {
      setError('Could not add them. Check the rules are deployed, then try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardTitle>New player</CardTitle>

      <Field label="Player's name" value={playerName} onChange={setPlayerName} placeholder="Jordan Ellis" />
      <Field
        label="Player's email"
        value={playerEmail}
        onChange={setPlayerEmail}
        placeholder="jordan@example.com"
        keyboardType="email-address"
      />
      <Text style={s.hint}>
        Leave this blank only for a player under 13, who uses their parent’s account.
      </Text>
      <Field label="Age (optional)" value={age} onChange={setAge} placeholder="19" keyboardType="number-pad" />

      <Field
        label="Parent's name (optional)"
        value={guardianName}
        onChange={setGuardianName}
        placeholder="Dana Ellis"
      />
      <Field
        label="Parent's email (optional)"
        value={guardianEmail}
        onChange={setGuardianEmail}
        placeholder="dana@example.com"
        keyboardType="email-address"
      />
      <Text style={s.hint}>Leave blank for college players (18+). They manage their own consent.</Text>

      <Text style={s.hint}>
        These addresses are what the player signs up with. A different address creates an account
        that matches nothing, so use the ones they actually gave you.
      </Text>

      {!noGuardian && !fullGuardian ? (
        <Text style={s.error} accessibilityLiveRegion="polite">
          Fill in both parent fields, or leave both blank.
        </Text>
      ) : null}
      {error ? <Text style={s.error}>{error}</Text> : null}
      {done ? (
        <Text style={s.ok} accessibilityLiveRegion="polite">
          {done}
        </Text>
      ) : null}

      <View style={{ height: 14 }} />
      <Button label="Add player" onPress={submit} busy={busy} disabled={!ready} />
    </Card>
  );
}

function Field({
  label,
  value,
  onChange,
  placeholder,
  keyboardType,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  keyboardType?: 'email-address' | 'number-pad';
}) {
  return (
    <View style={{ marginBottom: 10 }}>
      <Text style={s.label}>{label}</Text>
      <TextInput
        style={s.input}
        value={value}
        onChangeText={onChange}
        placeholder={placeholder}
        placeholderTextColor={color.textFaint}
        accessibilityLabel={label}
        autoCapitalize={keyboardType === 'email-address' ? 'none' : 'words'}
        autoCorrect={false}
        keyboardType={keyboardType}
      />
    </View>
  );
}

const s = StyleSheet.create({
  head: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 10 },
  name: { flex: 1, fontSize: 16, fontWeight: '800', color: color.chalk },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 9,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: semantic.border,
  },
  rowWho: { fontSize: 14, fontWeight: '600', color: color.textLede },
  note: { ...type.meta, paddingVertical: 9, lineHeight: 17 },
  footRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10 },
  foot: { marginTop: 12 },
  waiting: { ...type.meta, lineHeight: 17 },
  ok: { color: color.win, fontSize: 13.5, fontWeight: '700', marginTop: 10 },
  error: { color: color.danger, fontSize: 13, marginTop: 10, lineHeight: 18 },
  hint: { ...type.meta, marginTop: 4, lineHeight: 17 },
  label: {
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 1.2,
    textTransform: 'uppercase',
    color: color.textFaint,
    marginBottom: 5,
  },
  input: {
    backgroundColor: semantic.surfaceInput,
    borderWidth: 1,
    borderColor: semantic.borderStrong,
    borderRadius: radius.input,
    color: color.chalk,
    fontSize: 15,
    minHeight: 44,
    paddingHorizontal: 12,
  },
});
