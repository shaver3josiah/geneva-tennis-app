import { useEffect, useMemo, useRef, useState } from 'react';
import { Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Stack, useLocalSearchParams } from 'expo-router';
import Ionicons from '@expo/vector-icons/Ionicons';
import * as Haptics from 'expo-haptics';
import Animated, {
  Easing,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';
import { doc, onSnapshot } from 'firebase/firestore';
import { db } from '../../src/firebase';
import { useNames, useSession } from '../../src/session';
import { blockAmount, logWorkoutDone, savePrefs } from '../../src/data';
import { Celebrate } from '../../src/Celebrate';
import {
  CELEBRATIONS,
  activeCelebration,
  finishWorkout,
  isUnlocked,
  readState,
} from '../../src/rewards';
import type { SessionEvent, WorkoutBlock } from '../../src/types';
import { Button, GhostButton, Loading, TypeChip } from '../../src/ui';
import { color, radius, semantic, type, typesOf } from '../../src/theme';

/** Only the timer pays out. A workout marked done without it is bookkeeping, not work. */
const MIN_TIMED_SECONDS = 60;

/**
 * The session a player actually runs: one block at a time, a clock on each, and a
 * celebration when the last one falls.
 *
 * The clock counts down to a DEADLINE rather than by decrementing a number every tick.
 * A phone that throttles timers in the background, or a dropped frame under a burst,
 * would otherwise make a 10 minute block quietly take 11.
 */
export default function Train() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { user, role, athlete, prefs } = useSession();
  const names = useNames();
  const reduceMotion = useReducedMotion();

  const [event, setEvent] = useState<SessionEvent | null | undefined>(undefined);
  const [idx, setIdx] = useState(0);
  const [done, setDone] = useState<Record<string, boolean>>({});
  const [running, setRunning] = useState(false);
  const [left, setLeft] = useState(0);
  const [burst, setBurst] = useState(0);
  const [note, setNote] = useState<string | null>(null);
  const [finished, setFinished] = useState(false);
  /** Seconds the clock has actually run on this screen. The gate on logging a workout. */
  const [timedSec, setTimedSec] = useState(0);

  const deadline = useRef(0);
  const timedBase = useRef(0);
  /** The clock's remaining seconds, mirrored out of state so the timer effect and the
   *  block-change effect can agree inside a single commit. State alone cannot: the
   *  reset is not visible to the effect that starts the countdown until a render later,
   *  which is how a 2 minute block ends up running for however long the last one had. */
  const leftRef = useRef(0);
  const doneRef = useRef<Record<string, boolean>>({});

  useEffect(() => {
    if (!id) return;
    return onSnapshot(doc(db, 'events', id), (snap) =>
      setEvent(snap.exists() ? ({ id: snap.id, ...snap.data() } as SessionEvent) : null)
    );
  }, [id]);

  // A session written before the workout builder existed has no blocks. It is still a
  // workout, so it gets one block covering its whole length rather than an empty list.
  const blocks: WorkoutBlock[] = useMemo(() => {
    if (event?.blocks?.length) return event.blocks;
    return [{ id: 'all', name: event?.name ?? 'Workout', minutes: event?.durationMin ?? 30 }];
  }, [event?.blocks, event?.name, event?.durationMin]);

  const block = blocks[Math.min(idx, blocks.length - 1)];
  // A reps block is counted, not timed, so there is no clock to run on it: the panel
  // becomes a target to tick off instead. Absence of `measure` means time, which is
  // every block written before reps existed.
  const isReps = block?.measure === 'reps';
  const blockSeconds = Math.max(1, Math.round((block?.minutes ?? 1) * 60));
  const allDone = blocks.every((b) => done[b.id]);
  /** Whether this workout has a clock anywhere in it. A reps-only session is finished
   *  by ticking every block, which is the other half of the rule the Finish gate has
   *  always enforced. */
  const anyTimed = blocks.some((b) => b.measure !== 'reps');

  const state = readState(prefs);
  const celebration = activeCelebration(state);
  const counted = !!id && state.doneEvents.includes(id);

  // Declared BEFORE the timer effect on purpose: effects run in order inside one
  // commit, so the clock is already loaded with this block's length by the time the
  // countdown below reads it.
  useEffect(() => {
    leftRef.current = blockSeconds;
    setLeft(blockSeconds);
  }, [block?.id, blockSeconds]);

  useEffect(() => {
    // isReps is a guard, not a new condition: tapping a reps block clears `running`
    // through onOpen. It is here so a future caller cannot start a countdown on a
    // block that has no duration to count.
    if (!running || isReps) return;
    const startedAt = Date.now();
    deadline.current = startedAt + leftRef.current * 1000;
    const iv = setInterval(() => {
      const ms = deadline.current - Date.now();
      const secs = Math.max(0, Math.ceil(ms / 1000));
      leftRef.current = secs;
      setLeft(secs);
      setTimedSec(timedBase.current + Math.round((Date.now() - startedAt) / 1000));
      if (ms <= 0) {
        setRunning(false);
        buzz('end');
        markDone(block.id, true);
      }
    }, 200);
    return () => {
      clearInterval(iv);
      timedBase.current += Math.round((Date.now() - startedAt) / 1000);
      setTimedSec(timedBase.current);
    };
    // The remaining time is read once, off the ref, when the clock starts. Putting it
    // in the deps would rebuild the deadline on every tick: the classic drifting timer.
  }, [running, block?.id, isReps]);

  function buzz(kind: 'tap' | 'end' | 'win') {
    if (Platform.OS === 'web') return; // expo-haptics throws on web rather than no-opping
    if (kind === 'win') Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
    else if (kind === 'end') Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy).catch(() => {});
    else Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
  }

  /**
   * Marking a block done fires the player's own celebration. That is the reward.
   *
   * The done map is mirrored in a ref because this is also called from inside the
   * countdown, whose closure holds whatever `done` was when the clock started. Off
   * stale state it would jump to a block already finished.
   */
  function markDone(blockId: string, advance: boolean) {
    doneRef.current = { ...doneRef.current, [blockId]: true };
    setDone(doneRef.current);
    setBurst((n) => n + 1);
    if (!advance) return;
    const next = blocks.findIndex((b) => !doneRef.current[b.id]);
    if (next >= 0) setIdx(next);
  }

  /**
   * Close the session out. TWO records are written, and they are deliberately independent.
   *
   * 1. /athletes/{aid}/workoutLog/{eventId} — the shared one. This is what the coach reads,
   *    so it is the record that matters, and it is written even if the private counters fail.
   * 2. /users/{uid} — the player's own streak and workout count. A private scoreboard.
   *
   * The previous version ran one write with `.catch(() => setNote('...check your connection'))`,
   * which had two faults that together produced the reported bug: it THREW THE REAL ERROR AWAY,
   * so nobody could see what actually failed, and a single failure claimed the whole workout
   * was lost. Now each write is settled on its own, the real error code reaches both the console
   * and the note, and the note says exactly which half did not land.
   */
  async function finish() {
    setRunning(false);
    setFinished(true);
    buzz('win');
    setBurst((n) => n + 1);

    // useLocalSearchParams types this as string, but a router that ever hands back an array
    // would put an array inside doneEvents, and Firestore rejects a nested array — a whole
    // class of "it did not save" that costs one line to make impossible.
    const eventId = Array.isArray(id) ? id[0] : id;
    if (!user || !eventId || !event) return;

    const patch = finishWorkout(state, eventId);
    const minutes = Math.round(timedSec / 60);
    const blocksDone = blocks.filter((b) => doneRef.current[b.id]).length;

    const [logged, scored] = await Promise.allSettled([
      // The coach's copy. Only a family writes it: the coach opening his own athlete's
      // session must not be able to mark it done for them, and the rules say so too.
      role === 'coach' || !athlete?.id
        ? Promise.resolve('skipped')
        : logWorkoutDone(
            athlete.id,
            { id: eventId, name: event.name },
            { minutes, blocksDone, blocksTotal: blocks.length }
          ),
      // finishWorkout returns null when this session already paid out, so re-finishing
      // does not double-count. That is not a failure.
      patch ? savePrefs(user.uid, prefs, patch) : Promise.resolve('already'),
    ]);

    for (const r of [logged, scored]) {
      if (r.status === 'rejected') console.warn('[gt] finish() write failed:', r.reason);
    }

    const why = (r: PromiseSettledResult<unknown>) =>
      r.status === 'rejected' ? String((r.reason as { code?: string })?.code ?? r.reason) : '';

    if (logged.status === 'rejected') {
      // The half the coach needs is the half that failed, so say that and nothing cheerier.
      setNote(`That did not reach ${names.coach} (${why(logged)}). Your work is done, try Finish again when you have signal.`);
      setFinished(false);
      return;
    }
    if (scored.status === 'rejected') {
      setNote(`Logged for ${names.coach}. Your streak did not update (${why(scored)}); it will next time you open the app.`);
      return;
    }
    if (!patch) {
      setNote(`Already counted. Logged for ${names.coach} again anyway.`);
      return;
    }

    const after = { ...state, ...patch };
    const fresh = CELEBRATIONS.find((c) => !isUnlocked(c, state) && isUnlocked(c, after));
    setNote(
      fresh
        ? `Workout ${after.workouts} logged. You unlocked ${fresh.label}. Pick it on the You tab.`
        : `Workout ${after.workouts} logged, and ${names.coach} can see it. Day ${state.streak} of your streak.`
    );
  }

  if (event === undefined) return <Loading label="Opening the session…" />;
  if (event === null) {
    return (
      <View style={s.missing}>
        <Stack.Screen options={{ title: 'Session' }} />
        <Text style={type.body}>That session is no longer on the calendar.</Text>
      </View>
    );
  }

  const canFinish = timedSec >= MIN_TIMED_SECONDS || allDone;

  return (
    <View style={s.page}>
      <Stack.Screen options={{ title: event.name }} />

      <ScrollView contentContainerStyle={s.pad}>
        <View style={s.head}>
          {typesOf({ type: event.type ?? 'skills', types: event.types }).map((k) => (
            <TypeChip key={k} type={k} />
          ))}
          <Text style={type.meta}>
            {event.location}
            {event.durationMin ? ` · ${event.durationMin} min` : ''}
          </Text>
        </View>

        {isReps ? (
          <RepsPanel
            reps={block?.reps ?? 0}
            done={!!done[block.id]}
            title={block?.name ?? 'Workout'}
            step={`Block ${Math.min(idx + 1, blocks.length)} of ${blocks.length}`}
          />
        ) : (
          <Clock
            seconds={left}
            total={blockSeconds}
            running={running}
            reduceMotion={reduceMotion}
            title={block?.name ?? 'Workout'}
            step={`Block ${Math.min(idx + 1, blocks.length)} of ${blocks.length}`}
          />
        )}

        <View style={s.controls}>
          {isReps ? (
            <View style={{ flex: 1 }}>
              <Button
                label={done[block.id] ? 'Counted' : 'Got them all'}
                disabled={!!done[block.id]}
                onPress={() => {
                  buzz('tap');
                  markDone(block.id, true);
                }}
              />
            </View>
          ) : (
            <>
              <View style={{ flex: 1 }}>
                <Button
                  label={running ? 'Pause' : left === blockSeconds ? 'Start the clock' : 'Resume'}
                  onPress={() => {
                    buzz('tap');
                    setRunning((r) => !r);
                  }}
                />
              </View>
              <GhostButton
                label="Reset"
                icon="refresh-outline"
                onPress={() => {
                  setRunning(false);
                  leftRef.current = blockSeconds;
                  setLeft(blockSeconds);
                }}
              />
            </>
          )}
        </View>

        <Text style={s.eyebrow}>The work</Text>
        {blocks.map((b, i) => (
          <BlockRow
            key={b.id}
            block={b}
            current={i === idx}
            done={!!done[b.id]}
            onOpen={() => {
              setRunning(false);
              setIdx(i);
            }}
            onDone={() => {
              buzz('tap');
              markDone(b.id, true);
            }}
          />
        ))}

        <View style={s.finishBox}>
          <Text style={s.finishHint}>
            {counted && !finished
              ? 'You already logged this one. Run it again any time, it pays once.'
              : canFinish
                ? allDone
                  ? 'Every block is down. Close it out.'
                  : 'The clock has run. Close it out when you are done.'
                : anyTimed
                  ? `Run the clock for at least a minute to log this workout. ${MIN_TIMED_SECONDS - Math.min(timedSec, MIN_TIMED_SECONDS)}s to go.`
                  : 'Tick every block off to log this workout.'}
          </Text>
          <Button
            label={finished ? 'Logged' : 'Finish the workout'}
            disabled={finished || !canFinish}
            onPress={finish}
          />
          {note ? (
            <Text style={s.note} accessibilityLiveRegion="polite">
              {note}
            </Text>
          ) : null}
        </View>
      </ScrollView>

      <Celebrate id={celebration} nonce={burst} label={finished ? event.name : block?.name} />
    </View>
  );
}

/** The clock. The ring is a plain bar because a real arc needs SVG stroke maths for a
 *  number nobody reads off the curve anyway; the digits are the information. */
function Clock({
  seconds,
  total,
  running,
  reduceMotion,
  title,
  step,
}: {
  seconds: number;
  total: number;
  running: boolean;
  reduceMotion: boolean;
  title: string;
  step: string;
}) {
  const pulse = useSharedValue(0);
  useEffect(() => {
    if (running && !reduceMotion) {
      pulse.value = withRepeat(withTiming(1, { duration: 1000, easing: Easing.inOut(Easing.quad) }), -1, true);
    } else {
      pulse.value = withTiming(0, { duration: 200 });
    }
  }, [running, reduceMotion]);

  const live = useAnimatedStyle(() => ({ opacity: 0.35 + pulse.value * 0.65 }));

  const mm = Math.floor(seconds / 60);
  const ss = seconds % 60;
  const pct = Math.max(0, Math.min(100, ((total - seconds) / total) * 100));

  return (
    <View style={s.clock}>
      <View style={s.clockTop}>
        <Animated.View style={[s.dot, { backgroundColor: running ? color.courtBlue : color.textFaint }, live]} />
        <Text style={s.step}>{step}</Text>
      </View>
      <Text style={s.digits} accessibilityLabel={`${mm} minutes ${ss} seconds left`}>
        {mm}:{String(ss).padStart(2, '0')}
      </Text>
      <Text style={s.blockName} numberOfLines={2}>
        {title}
      </Text>
      <View style={s.track}>
        <View style={[s.fill, { width: `${pct}%` }]} />
      </View>
    </View>
  );
}

/**
 * A reps block in place of the clock. There is nothing to count down, so the number is
 * the target and the player says when it is met. No progress bar either: a bar that
 * cannot move is furniture.
 */
function RepsPanel({
  reps,
  done,
  title,
  step,
}: {
  reps: number;
  done: boolean;
  title: string;
  step: string;
}) {
  return (
    <View style={s.clock}>
      <View style={s.clockTop}>
        <Ionicons
          name={done ? 'checkmark-circle' : 'repeat-outline'}
          size={13}
          color={done ? color.win : color.textFaint}
        />
        <Text style={s.step}>{step}</Text>
      </View>
      <Text style={s.digits} accessibilityLabel={`${reps} reps${done ? ', counted' : ''}`}>
        {reps}
      </Text>
      <Text style={s.repsUnit}>{reps === 1 ? 'rep' : 'reps'}</Text>
      <Text style={s.blockName} numberOfLines={2}>
        {title}
      </Text>
    </View>
  );
}

function BlockRow({
  block,
  current,
  done,
  onOpen,
  onDone,
}: {
  block: WorkoutBlock;
  current: boolean;
  done: boolean;
  onOpen: () => void;
  onDone: () => void;
}) {
  return (
    <View style={[s.row, current && s.rowOn, done && { opacity: 0.6 }]}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={
          block.measure === 'reps' ? `Work on ${block.name}` : `Put the clock on ${block.name}`
        }
        onPress={onOpen}
        style={{ flex: 1 }}
      >
        <Text style={[s.rowName, done && s.struck]}>{block.name}</Text>
        <Text style={type.meta}>
          {blockAmount(block)}{block.notes ? ` · ${block.notes}` : ''}
        </Text>
      </Pressable>
      <Pressable
        accessibilityRole="checkbox"
        accessibilityState={{ checked: done }}
        accessibilityLabel={`Mark ${block.name} complete`}
        onPress={onDone}
        disabled={done}
        hitSlop={8}
        style={({ pressed }) => [s.check, done && s.checkOn, pressed && !done && { borderColor: color.goldHot }]}
      >
        <Ionicons
          name={done ? 'checkmark-sharp' : 'ellipse-outline'}
          size={done ? 20 : 18}
          color={done ? color.night : color.textFaint}
        />
      </Pressable>
    </View>
  );
}

const s = StyleSheet.create({
  page: { flex: 1, backgroundColor: semantic.surfacePage },
  pad: { padding: 16, paddingBottom: 40 },
  missing: { flex: 1, backgroundColor: semantic.surfacePage, padding: 24, justifyContent: 'center' },

  head: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 14, flexWrap: 'wrap' },

  clock: {
    backgroundColor: semantic.surfaceCard,
    borderWidth: 1,
    borderColor: semantic.border,
    borderRadius: radius.cardLg,
    padding: 18,
    alignItems: 'center',
  },
  clockTop: { flexDirection: 'row', alignItems: 'center', gap: 7 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  step: { ...type.eyebrow, fontSize: 10.5, color: color.textDim },
  digits: {
    fontSize: 62,
    fontWeight: '900',
    color: color.chalk,
    letterSpacing: -2,
    marginTop: 6,
    fontVariant: ['tabular-nums'],
  },
  blockName: { fontSize: 15, fontWeight: '700', color: color.textLede, textAlign: 'center', marginTop: 2 },
  repsUnit: { ...type.eyebrow, fontSize: 11, marginTop: 2, color: color.textDim },
  track: { height: 6, borderRadius: 4, backgroundColor: color.night, width: '100%', marginTop: 14, overflow: 'hidden' },
  fill: { height: '100%', backgroundColor: color.gold },

  controls: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 14 },

  eyebrow: { ...type.eyebrow, marginTop: 24, marginBottom: 8 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    backgroundColor: semantic.surfaceCard,
    borderWidth: 1,
    // A block row is something you press, so it takes the stronger outline the rest
    // of the app gives its controls. `npm run contrast` is the reason that matters.
    borderColor: semantic.borderStrong,
    borderRadius: radius.card,
    padding: 13,
    marginBottom: 8,
    minHeight: 60,
  },
  rowOn: { borderColor: color.gold },
  rowName: { fontSize: 15, fontWeight: '700', color: color.chalk, marginBottom: 2 },
  struck: { textDecorationLine: 'line-through', color: color.textDim },
  check: {
    width: 44,
    height: 44,
    borderRadius: 22,
    borderWidth: 1,
    borderColor: semantic.borderStrong,
    alignItems: 'center',
    justifyContent: 'center',
  },
  checkOn: { backgroundColor: color.gold, borderColor: color.gold },

  finishBox: { marginTop: 22 },
  finishHint: { ...type.meta, lineHeight: 18, marginBottom: 10 },
  note: { ...type.body, color: color.courtBlue, marginTop: 10, fontWeight: '700' },
});
