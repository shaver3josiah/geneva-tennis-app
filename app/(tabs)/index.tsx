import { useEffect, useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useSession, useNames } from '../../src/session';
import { subscribeThreads, subscribeLastMessage } from '../../src/data';
import type { Message, Thread } from '../../src/types';
import { Avatar, Banner, Button, Card, CardTitle, Empty, Eyebrow, GhostButton, Screen, Tag } from '../../src/ui';
import { color, radius, semantic, type } from '../../src/theme';

/**
 * A chat cannot be conjured from this screen, so the button does not pretend it can.
 * A thread only exists after the coach invites a player on the Roster, they sign up
 * with that exact address, and the coach taps Open threads on their card. These are
 * those three steps, in the order they actually happen.
 */
const STEPS = [
  'Invite the player by email on the Roster. Use the address they really gave you.',
  'They sign up with that address and confirm it. The app connects them to you.',
  'Tap Open threads on their card. That is the new chat. A player under 18 gets a parent thread too.',
];

export default function Messages() {
  const { user, role, consent, adult, prefs, athletesById } = useSession();
  const names = useNames();
  const router = useRouter();
  const [threads, setThreads] = useState<Thread[] | null>(null);
  const [howTo, setHowTo] = useState(false);

  useEffect(() => {
    if (!user) return;
    return subscribeThreads(user.uid, setThreads);
  }, [user?.uid]);

  const locked = role === 'player' && !consent;
  const isCoach = role === 'coach';

  // Players who signed up but have no thread yet. `guardianUid` is the same gate the
  // Roster puts on its own Open threads button: a thread needs a real account to point
  // at, so an invite nobody has claimed is not something this button can finish.
  const waiting = useMemo(() => {
    if (!isCoach || threads === null) return [];
    const threaded = new Set(threads.map((t) => t.athleteId));
    return Object.values(athletesById).filter((a) => a.guardianUid && !threaded.has(a.id));
  }, [isCoach, threads, athletesById]);

  return (
    <Screen>
      {role === 'parent' && (
        <Banner tone="watch" title="You see everything">
          Every message between {names.coach} and {names.player.split(' ')[0]} appears here. You can
          read it. You cannot post into it.
        </Banner>
      )}
      {role === 'player' && !consent && !adult && (
        <Banner tone="lock" title="Waiting on a parent">
          {names.parent.split(' ')[0]} has not approved messaging yet. Ask them to turn on Training
          consent in their app.
        </Banner>
      )}
      {role === 'player' && !consent && adult && (
        <Banner tone="lock" title="Messaging is not on yet">
          Switching it on needs a connection. Close the app and open it again to try once more.
        </Banner>
      )}
      {role === 'player' && consent && !adult && (
        <Banner tone="watch" title={`${names.parent.split(' ')[0]} can read this`}>
          Your parent sees every message in this thread. That is how the app works for players under
          18.
        </Banner>
      )}
      {role === 'coach' && (
        <Banner tone="ok" title="On the record">
          Every message you send a player under 18 is visible to their parent or guardian. Write
          like it is on the record, because it is.
        </Banner>
      )}

      {/* The eyebrow and the one action share a row so the screen keeps a single
          affordance at the top instead of a stack of competing buttons. */}
      <View style={s.head}>
        {/* The row carries the spacing Eyebrow normally carries itself. Its own 18/8
            margins are part of its margin box, so centring the row against a 44pt
            button would have dropped the label 5px below the button's middle. */}
        <Eyebrow style={{ flex: 1, marginTop: 0, marginBottom: 0 }}>
          {isCoach ? 'Roster threads' : 'Conversations'}
        </Eyebrow>
        {isCoach && (
          <GhostButton
            label={howTo ? 'Close' : 'Add chat'}
            icon={howTo ? 'close' : 'add'}
            onPress={() => setHowTo((v) => !v)}
          />
        )}
      </View>

      {isCoach && howTo && (
        <Card>
          <CardTitle>How a new chat starts</CardTitle>
          {STEPS.map((text, i) => (
            <View key={text} style={s.step}>
              <Text style={s.stepNum}>{i + 1}</Text>
              <Text style={s.stepText}>{text}</Text>
            </View>
          ))}

          {waiting.length > 0 && (
            <Text style={s.waiting} accessibilityLiveRegion="polite">
              {waiting.length === 1
                ? `${waiting[0].playerName} is signed up with no chat yet. Open their thread on the Roster and you can message them today.`
                : `${waiting.length} players are signed up with no chat yet. Open their threads on the Roster and you can message them today.`}
            </Text>
          )}

          <View style={{ height: 14 }} />
          {/* This button navigates, it does not open anything. The Roster has its own
              button literally labelled Open threads, and that is the one that writes the
              thread, so naming this one after that action would be the same words twice
              with only the second one doing it. */}
          <Button
            label="Go to the roster"
            onPress={() => {
              setHowTo(false);
              router.push('/roster');
            }}
          />
        </Card>
      )}

      {threads === null && <Text style={type.meta}>Loading…</Text>}
      {threads?.length === 0 &&
        (isCoach ? (
          <Empty icon="chatbubbles-outline">
            No threads yet.{'\n'}Tap Add chat and it walks you through it.
          </Empty>
        ) : (
          <Empty icon="chatbubbles-outline">
            No conversations yet.{'\n'}{names.coach} opens these.
          </Empty>
        ))}

      {threads?.map((t) => (
        <ThreadRow
          key={t.id}
          thread={t}
          locked={locked}
          muted={(prefs.mutedThreads ?? []).includes(t.id)}
          onPress={() => !locked && router.push(`/thread/${t.id}`)}
        />
      ))}
    </Screen>
  );
}

function ThreadRow({
  thread,
  locked,
  muted,
  onPress,
}: {
  thread: Thread;
  locked: boolean;
  muted: boolean;
  onPress: () => void;
}) {
  const { role, user } = useSession();
  const names = useNames(thread.athleteId);
  const [last, setLast] = useState<Message | null>(null);

  // One listener per thread, reading exactly one document each. If a roster ever makes
  // that dozens of listeners, denormalise a lastMessage field onto the thread doc.
  useEffect(() => subscribeLastMessage(thread.id, setLast), [thread.id]);

  // A parent watching the coach<->player thread is a reader, not a participant.
  const monitoring = role === 'parent' && !thread.participants.includes(user?.uid ?? '');
  const other =
    role === 'coach'
      ? thread.kind === 'coach-player'
        ? { name: names.player, role: 'player' as const }
        : { name: names.parent, role: 'parent' as const }
      : monitoring
        ? { name: names.player, role: 'player' as const }
        : { name: names.coach, role: 'coach' as const };

  const title = monitoring ? `Coach ↔ ${names.player.split(' ')[0]}` : other.name;

  return (
    <Pressable
      onPress={onPress}
      disabled={locked}
      accessibilityRole="button"
      accessibilityLabel={`Open conversation: ${title}`}
      accessibilityState={{ disabled: locked }}
      style={({ pressed }) => [s.row, pressed && !locked && { backgroundColor: color.inkHover }, locked && { opacity: 0.55 }]}
    >
      <Avatar name={other.name} role={other.role} />
      <View style={{ flex: 1 }}>
        <View style={s.rowTop}>
          <Text style={s.rowName} numberOfLines={1}>
            {title}
          </Text>
          <Text style={s.rowTime}>{locked ? '–' : timeOf(last)}</Text>
        </View>
        <Text style={s.rowPrev} numberOfLines={2}>
          {locked ? 'Locked until consent' : (last?.text ?? 'No messages yet.')}
        </Text>
        {(monitoring || muted) && (
          <View style={s.tags}>
            {monitoring && <Tag tone="mon" icon="eye-outline">Monitoring</Tag>}
            {monitoring && <Tag tone="ro">Read only</Tag>}
            {muted && <Tag tone="muted">Muted</Tag>}
          </View>
        )}
      </View>
    </Pressable>
  );
}

function timeOf(m: Message | null): string {
  const d = m?.createdAt?.toDate?.();
  if (!d) return '';
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  return sameDay
    ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    : d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

const s = StyleSheet.create({
  head: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 18, marginBottom: 8 },
  step: { flexDirection: 'row', gap: 10, marginTop: 10 },
  // The number is the label, so the step still reads in order without the colour.
  stepNum: { width: 16, fontSize: 13, fontWeight: '800', color: color.goldHot, lineHeight: 19 },
  stepText: { ...type.body, flex: 1, fontSize: 13.5, lineHeight: 19 },
  waiting: { color: color.courtBlue, fontSize: 13.5, fontWeight: '700', marginTop: 14, lineHeight: 19 },
  row: {
    flexDirection: 'row',
    gap: 12,
    alignItems: 'flex-start',
    backgroundColor: semantic.surfaceCard,
    borderWidth: 1,
    borderColor: semantic.borderStrong,
    borderRadius: radius.cardLg,
    padding: 13,
    marginBottom: 10,
    minHeight: 64,
  },
  rowTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 },
  rowName: { flex: 1, fontSize: 15, fontWeight: '700', color: color.chalk },
  rowTime: { ...type.meta, fontSize: 11.5 },
  rowPrev: { ...type.body, fontSize: 13.5, lineHeight: 19, marginTop: 3 },
  tags: { flexDirection: 'row', gap: 6, marginTop: 8, flexWrap: 'wrap' },
});
