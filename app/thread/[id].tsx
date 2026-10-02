import { useEffect, useRef, useState } from 'react';
import {
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Animated, { useAnimatedStyle } from 'react-native-reanimated';
import { KeyboardStickyView, useReanimatedKeyboardAnimation } from 'react-native-keyboard-controller';
import { doc, onSnapshot } from 'firebase/firestore';
import { db } from '../../src/firebase';
import { useSession, useNames } from '../../src/session';
import { canPostIn, isAdult, sendMessage, subscribeMessages } from '../../src/data';
import type { Athlete, Message, Thread } from '../../src/types';
import { Banner } from '../../src/ui';
import { bubbleColor, color, radius, semantic, type } from '../../src/theme';

export default function ThreadScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { user, role, athlete, athletesById, consent, prefs } = useSession();
  const [thread, setThread] = useState<Thread | null>(null);
  const names = useNames(thread?.athleteId);
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const listRef = useRef<FlatList<Message>>(null);

  // The composer below the list rides the keyboard up by exactly its height, and in
  // doing so covers the bottom of the list. This spacer grows the list by the same
  // amount on the same frames, so the newest message stays above the bar; the list's
  // own scrollToEnd on content-size change is what carries it there. The library's
  // `height` is a translateY, negative while the keyboard is open, hence the sign.
  const keyboard = useReanimatedKeyboardAnimation();
  const spacer = useAnimatedStyle(() => ({ height: -keyboard.height.value }));

  // The athlete this THREAD is about, which for a coach with more than one on the
  // roster is not the same as "the" athlete on the session.
  const threadAthlete = (thread && athletesById[thread.athleteId]) ?? athlete;
  // An adult player is their own guardian: no parent reads this, and no parent grants consent.
  const adultThread = isAdult(threadAthlete);
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;
    return onSnapshot(doc(db, 'threads', id), (snap) =>
      setThread(snap.exists() ? ({ id: snap.id, ...snap.data() } as Thread) : null)
    );
  }, [id]);

  useEffect(() => {
    if (!id) return;
    return subscribeMessages(id, setMessages);
  }, [id]);

  // The account's own bubble colour, picked on the You tab. Everyone else's stays
  // the neutral card, so a thread never turns into two people shouting in colour.
  const mineBg = bubbleColor(prefs.chatColor);
  const monitoring = !!thread && !!user && !thread.participants.includes(user.uid);
  // A coach who claimed the role after this thread was opened can read it (the rules let
  // any coach) but is not on its participant list, and threads are immutable. They are not
  // "monitoring" anyone; they just cannot post here.
  const lateCoach = monitoring && role === 'coach';
  const canPost = !!thread && !!user && canPostIn(thread, user.uid, threadAthlete);
  const title = monitoring
    ? `Coach ↔ ${names.player.split(' ')[0]}`
    : role === 'coach'
      ? thread?.kind === 'coach-player'
        ? names.player
        : names.parent
      : names.coach;

  async function send() {
    const text = draft.trim();
    if (!text || !user || !id) return;
    setSending(true);
    setError(null);
    // Clear optimistically: the listener puts the real message back within a frame or
    // two, and leaving the text in the box after a successful send feels broken.
    setDraft('');
    try {
      await sendMessage(id, user.uid, text);
    } catch {
      setDraft(text);
      setError('That message did not send. Check your connection and try again.');
    } finally {
      setSending(false);
    }
  }

  return (
    <View style={s.page}>
      <Stack.Screen
        options={{
          title,
          // The coach schedules from inside the conversation, because that is where he
          // decides to. Everyone else has no profile to open: a family sees one athlete,
          // their own, and the calendar tab already shows them everything about them.
          headerRight:
            role === 'coach' && thread?.athleteId
              ? () => (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="Open this player and schedule a workout"
                    onPress={() =>
                      router.push({ pathname: '/athlete', params: { athleteId: thread.athleteId } })
                    }
                    hitSlop={8}
                    style={{ paddingHorizontal: 4, minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' }}
                  >
                    <Ionicons name="calendar-outline" size={21} color={color.chalk} />
                  </Pressable>
                )
              : undefined,
        }}
      />
      <FlatList
        ref={listRef}
        data={messages}
        keyExtractor={(m) => m.id}
        contentContainerStyle={s.list}
        ListFooterComponent={<Animated.View style={spacer} />}
        onContentSizeChange={() => listRef.current?.scrollToEnd({ animated: false })}
        // Send without dismissing first: a tap on the button while the keyboard is
        // open would otherwise be swallowed closing it.
        keyboardShouldPersistTaps="handled"
        ListHeaderComponent={
          <View>
            {monitoring && !lateCoach && (
              <Banner tone="watch" title="Monitored thread">
                Read-only for you. {names.player.split(' ')[0]} and {names.coach} both know you can
                see it.
              </Banner>
            )}
            {role === 'player' && consent && !adultThread && (
              <Banner tone="watch" title="Your parent can see this conversation">
                {names.parent.split(' ')[0]} reads every message here.
              </Banner>
            )}
          </View>
        }
        renderItem={({ item, index }) => (
          <Bubble
            message={item}
            previous={messages[index - 1]}
            mine={item.senderUid === user?.uid}
            mineBg={mineBg}
            showAuthor={monitoring || role === 'coach'}
            athlete={threadAthlete}
            names={names}
          />
        )}
      />

      {/*
        The composer sticks to the top of the keyboard. This is the library's own
        KeyboardStickyView, which translates the bar by the keyboard height it measures
        natively, and nothing else: no window height, no frame measurement, no header
        offset. The earlier KeyboardAvoidingView here computed its padding from all
        three, and on a real phone that came out short. A bar that moves by the one
        number the keyboard actually reports cannot come out short by any of them.
      */}
      <KeyboardStickyView>
        {error ? (
          <Text style={s.error} accessibilityLiveRegion="polite">
            {error}
          </Text>
        ) : null}

        {/*
          The conversation is where a session gets agreed, so it is where the calendar
          should be one tap away. The coach lands on the scheduler with this athlete
          already chosen; a family cannot write events, so theirs opens the calendar.
        */}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={role === 'coach' ? 'Add a session to the calendar' : 'Open the calendar'}
          onPress={() =>
            role === 'coach' && thread?.athleteId
              ? router.push({ pathname: '/schedule', params: { athleteId: thread.athleteId } })
              : router.push('/calendar')
          }
          style={({ pressed }) => [s.calBar, pressed && { backgroundColor: color.inkHover }]}
        >
          <Ionicons name="calendar-outline" size={16} color={color.goldHot} />
          <Text style={s.calText}>
            {role === 'coach' ? 'Add a session to the calendar' : 'Open the calendar'}
          </Text>
          <Ionicons name="chevron-forward" size={15} color={color.textDim} />
        </Pressable>

        {canPost ? (
          <View style={[s.composer, { paddingBottom: Math.max(insets.bottom, 10) }]}>
            <TextInput
              style={s.input}
              value={draft}
              onChangeText={setDraft}
              placeholder="Message…"
              placeholderTextColor={color.textFaint}
              accessibilityLabel="Message"
              multiline
              maxLength={4000}
              onSubmitEditing={send}
            />
            <Pressable
              onPress={send}
              disabled={!draft.trim() || sending}
              accessibilityRole="button"
              accessibilityLabel="Send"
              style={({ pressed }) => [
                s.send,
                { backgroundColor: pressed ? color.goldHot : color.gold },
                (!draft.trim() || sending) && { opacity: 0.4 },
              ]}
            >
              <Text style={s.sendIcon}>↑</Text>
            </Pressable>
          </View>
        ) : (
          <View style={[s.lockStrip, { paddingBottom: Math.max(insets.bottom, 12) }]}>
            <Text style={s.lockText}>
              {lateCoach
                ? 'Read-only. This thread was opened before you became a coach, so only the coaches on it can post.'
                : monitoring
                  ? `Read-only. To reach ${names.coach}, use your own thread with them.`
                  : adultThread
                    ? 'Messaging is not on yet. Close the app and open it again to try once more.'
                    : `Locked until ${names.parent.split(' ')[0]} grants training consent.`}
            </Text>
          </View>
        )}
      </KeyboardStickyView>
    </View>
  );
}

function Bubble({
  message,
  previous,
  mine,
  mineBg,
  showAuthor,
  athlete,
  names,
}: {
  message: Message;
  previous?: Message;
  mine: boolean;
  mineBg: string;
  showAuthor: boolean;
  athlete: Athlete | null;
  names: { coach: string; parent: string; player: string };
}) {
  const d = message.createdAt?.toDate?.();
  const prevD = previous?.createdAt?.toDate?.();
  const newDay = d && (!prevD || prevD.toDateString() !== d.toDateString());

  const who =
    message.senderUid === athlete?.playerUid
      ? names.player.split(' ')[0]
      : message.senderUid === athlete?.guardianUid
        ? names.parent.split(' ')[0]
        : names.coach;

  return (
    <View>
      {newDay && <Text style={s.daySep}>{dayLabel(d!)}</Text>}
      <View style={[s.bubble, mine ? [s.mine, { backgroundColor: mineBg }] : s.theirs]}>
        {showAuthor && !mine && <Text style={s.who}>{who}</Text>}
        <Text style={s.text}>{message.text}</Text>
        <Text style={s.stamp}>
          {d ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : 'Sending…'}
        </Text>
      </View>
    </View>
  );
}

function dayLabel(d: Date): string {
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return 'Today';
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return d.toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' });
}

const s = StyleSheet.create({
  page: { flex: 1, backgroundColor: semantic.surfacePage },
  list: { padding: 14, paddingBottom: 20 },

  daySep: {
    alignSelf: 'center',
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 1,
    textTransform: 'uppercase',
    color: color.textFaint,
    marginVertical: 14,
  },
  bubble: { maxWidth: '84%', borderRadius: 16, paddingHorizontal: 13, paddingVertical: 10, marginBottom: 8 },
  // The background is painted at render time from the account's pick; this is the
  // fallback for anyone who has never opened the picker.
  mine: { alignSelf: 'flex-end', backgroundColor: color.goldDeep, borderBottomRightRadius: 5 },
  theirs: {
    alignSelf: 'flex-start',
    backgroundColor: semantic.surfaceCard,
    borderWidth: 1,
    borderColor: semantic.border,
    borderBottomLeftRadius: 5,
  },
  who: { fontSize: 11, fontWeight: '800', color: color.goldHot, marginBottom: 3, letterSpacing: 0.4 },
  text: { fontSize: 15, lineHeight: 21, color: color.chalk },
  stamp: { fontSize: 10.5, color: color.textLede, marginTop: 5, alignSelf: 'flex-end' },

  calBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 9,
    minHeight: 44,
    paddingHorizontal: 14,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: semantic.border,
    backgroundColor: semantic.surfaceBand,
  },
  calText: { flex: 1, fontSize: 13.5, fontWeight: '700', color: color.chalk },

  composer: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 8,
    paddingHorizontal: 12,
    paddingTop: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: semantic.border,
    backgroundColor: semantic.surfaceBand,
  },
  input: {
    flex: 1,
    minHeight: 44,
    maxHeight: 120,
    backgroundColor: semantic.surfaceInput,
    borderWidth: 1,
    borderColor: semantic.borderStrong,
    borderRadius: radius.pill,
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 12,
    color: color.chalk,
    fontSize: 15,
  },
  send: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center' },
  // night on gold: 7.0:1. White on gold is 2.8:1 and fails.
  sendIcon: { color: color.night, fontSize: 20, fontWeight: '800' },

  lockStrip: {
    paddingHorizontal: 16,
    paddingTop: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: semantic.border,
    backgroundColor: semantic.surfaceBand,
  },
  lockText: { ...type.meta, textAlign: 'center', lineHeight: 18 },
  error: { color: color.danger, fontSize: 13, paddingHorizontal: 16, paddingBottom: 6 },
});
