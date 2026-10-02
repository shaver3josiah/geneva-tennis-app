import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  measure,
  runOnJS,
  useAnimatedRef,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withSpring,
  withTiming,
  type SharedValue,
} from 'react-native-reanimated';
import * as Haptics from 'expo-haptics';
import { useRouter } from 'expo-router';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useSession } from '../../src/session';
import { deleteEvent, moveEvent, pasteEvents, subscribeEvents } from '../../src/data';
import type { SessionEvent } from '../../src/types';
import { Empty, Eyebrow, GhostButton } from '../../src/ui';
import { SESSION_TYPES, color, radius, semantic, type, typesOf } from '../../src/theme';

const DOW = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];
const sameDay = (a: Date, b: Date) =>
  a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());

/** One day cell's box, in grid coordinates. Kept in a shared value so the drag can
 *  hit-test on the UI thread without asking React where anything is. */
interface CellRect {
  d: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * The calendar, and for the coach the place the week is run from.
 *
 * The one authored interaction is the drag. Press and hold a session in the day list
 * and it lifts off the page, follows your thumb up into the month grid, and the day
 * under it swells and lights up. Let go and it moves.
 *
 * All of that runs on the UI thread: the gesture is react-native-gesture-handler, the
 * movement is Reanimated shared values, and the hit-test is a worklet reading the cell
 * boxes out of a shared value. Dragging across thirty cells re-renders no React at
 * all. The only hops back to JS are the write itself and the haptics.
 */
export default function CalendarScreen() {
  const { user, role, athlete, athletesById } = useSession();
  const router = useRouter();
  const isCoach = role === 'coach';

  const [events, setEvents] = useState<SessionEvent[] | null>(null);
  const [cursor, setCursor] = useState(() => startOfDay(new Date()));
  const [selected, setSelected] = useState(() => startOfDay(new Date()));
  const [filter, setFilter] = useState<string>('all');
  const [clipboard, setClipboard] = useState<{ from: Date; events: SessionEvent[] } | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  /** Which card is armed for deletion. One at a time, deliberately: a list of sessions
   *  each showing its own confirm row is a list nobody can read. */
  const [confirmId, setConfirmId] = useState<string | null>(null);

  // Direct manipulation is never decoration, so the drag itself always works. What
  // Reduce Motion turns off is the spring: the card snaps home instead of overshooting.
  const reduceMotion = useReducedMotion();

  useEffect(() => {
    if (!isCoach && !athlete?.id) return;
    // The uid is what lets a family also see the coached sessions they were written
    // into, which live on another athlete's athleteId.
    return subscribeEvents(role, isCoach ? null : (athlete?.id ?? null), setEvents, user?.uid);
  }, [role, athlete?.id, isCoach, user?.uid]);

  const visible = useMemo(
    () =>
      (events ?? []).filter(
        (e) => filter === 'all' || e.athleteId === filter || e.athleteIds?.includes(filter)
      ),
    [events, filter]
  );

  const month = cursor.getMonth();
  const year = cursor.getFullYear();
  const today = startOfDay(new Date());

  const byDay = useMemo(() => {
    const m = new Map<number, SessionEvent[]>();
    for (const e of visible) {
      const d = e.startsAt?.toDate?.();
      if (!d || d.getMonth() !== month || d.getFullYear() !== year) continue;
      m.set(d.getDate(), [...(m.get(d.getDate()) ?? []), e]);
    }
    return m;
  }, [visible, month, year]);

  const dayEvents = useMemo(
    () => visible.filter((e) => e.startsAt?.toDate && sameDay(e.startsAt.toDate(), selected)),
    [visible, selected]
  );

  // --- drag plumbing, all of it on the UI thread ----------------------------
  const gridRef = useAnimatedRef<View>();
  const gridOrigin = useSharedValue({ x: 0, y: 0 });
  const cellRects = useSharedValue<CellRect[]>([]);
  const hoverDay = useSharedValue(-1);
  // Cells report their box one at a time as they lay out, so they are collected in a
  // plain ref and published to the shared value as each one lands.
  const rectsRef = useRef(new Map<number, CellRect>());

  const publishRect = useCallback(
    (r: CellRect) => {
      rectsRef.current.set(r.d, r);
      cellRects.value = [...rectsRef.current.values()];
    },
    [cellRects]
  );

  // A new month means last month's boxes are stale. Clearing rather than keeping them
  // means a drag during the first frame of a new month hits nothing, which is better
  // than hitting the wrong day.
  useEffect(() => {
    rectsRef.current.clear();
    cellRects.value = [];
  }, [month, year, cellRects]);

  const buzz = useCallback((kind: 'pick' | 'move' | 'drop') => {
    // expo-haptics has nothing to drive on the web and throws rather than no-opping.
    if (Platform.OS === 'web') return;
    if (kind === 'pick') Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    else if (kind === 'move') Haptics.selectionAsync();
    else Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
  }, []);

  const drop = useCallback(
    async (e: SessionEvent, day: number) => {
      if (day < 1) return;
      const target = new Date(year, month, day);
      if (sameDay(e.startsAt.toDate(), target)) return;
      setError(null);
      try {
        await moveEvent(e, target);
        buzz('drop');
        setSelected(target);
        setFlash(`Moved to ${target.toLocaleDateString([], { weekday: 'short', day: 'numeric' })}`);
      } catch {
        setError('That did not move. Check your connection and try again.');
      }
    },
    [year, month, buzz]
  );

  async function paste() {
    if (!clipboard) return;
    setError(null);
    try {
      const n = await pasteEvents(clipboard.events, selected);
      setFlash(`${n} ${n === 1 ? 'session' : 'sessions'} pasted`);
    } catch {
      setError('That did not paste. Try again.');
    }
  }

  useEffect(() => {
    if (!flash) return;
    const t = setTimeout(() => setFlash(null), 2600);
    return () => clearTimeout(t);
  }, [flash]);

  const roster = Object.values(athletesById);
  const namesOn = (e: SessionEvent) =>
    (e.athleteIds ?? [e.athleteId])
      .map((id) => athletesById[id]?.playerName)
      .filter((n): n is string => !!n);

  return (
    <ScrollView
      style={s.page}
      contentContainerStyle={s.pad}
      // A drag that also scrolls the page is a drag that lands somewhere else.
      scrollEnabled={!dragging}
    >
      <View style={s.calHead}>
        <View style={{ flex: 1 }}>
          <Text style={s.month}>{cursor.toLocaleDateString([], { month: 'long' })}</Text>
          <Text style={s.year}>{year}</Text>
        </View>
        <NavBtn
          icon="chevron-back"
          label="Previous month"
          onPress={() => setCursor(new Date(year, month - 1, 1))}
        />
        <NavBtn
          icon="chevron-forward"
          label="Next month"
          onPress={() => setCursor(new Date(year, month + 1, 1))}
        />
      </View>

      {isCoach && roster.length > 1 && (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.filterRow}>
          <FilterChip label="Everyone" on={filter === 'all'} onPress={() => setFilter('all')} />
          {roster.map((a) => (
            <FilterChip
              key={a.id}
              label={a.playerName.split(' ')[0]}
              on={filter === a.id}
              onPress={() => setFilter(a.id)}
            />
          ))}
        </ScrollView>
      )}

      <View style={s.dow}>
        {DOW.map((d) => (
          <Text key={d} style={s.dowLabel}>
            {d}
          </Text>
        ))}
      </View>

      <View style={s.grid} ref={gridRef} collapsable={false}>
        {Array.from({ length: new Date(year, month, 1).getDay() }, (_, i) => (
          <View key={`blank${i}`} style={s.cell} />
        ))}
        {Array.from({ length: new Date(year, month + 1, 0).getDate() }, (_, i) => {
          const day = i + 1;
          const date = new Date(year, month, day);
          return (
            <DayCell
              key={day}
              day={day}
              events={byDay.get(day) ?? []}
              isToday={sameDay(date, today)}
              isSelected={sameDay(date, selected)}
              hoverDay={hoverDay}
              onPress={() => setSelected(date)}
              onRect={publishRect}
            />
          );
        })}
      </View>

      <Legend />

      {error ? (
        <Text style={s.error} accessibilityLiveRegion="polite">
          {error}
        </Text>
      ) : null}
      {flash ? (
        <View style={s.flash} accessibilityLiveRegion="polite">
          <Ionicons name="checkmark-circle" size={15} color={color.win} />
          <Text style={s.flashText}>{flash}</Text>
        </View>
      ) : null}

      {clipboard && isCoach && (
        <View style={s.clip}>
          <Ionicons name="copy-outline" size={16} color={color.chalk} />
          <Text style={s.clipText}>
            {clipboard.events.length} {clipboard.events.length === 1 ? 'session' : 'sessions'} copied
            from {clipboard.from.toLocaleDateString([], { weekday: 'short', day: 'numeric' })}
          </Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Clear the copied sessions"
            onPress={() => setClipboard(null)}
            style={s.clipClear}
          >
            <Ionicons name="close" size={16} color={color.textDim} />
          </Pressable>
        </View>
      )}

      <View style={s.dayHead}>
        <Text style={s.dayTitle}>
          {selected.toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' })}
        </Text>
        {sameDay(selected, today) ? null : (
          // A bare gold word "Today" beside the date read as a LABEL for the day on screen,
          // which is the opposite of what it means: it only appears when the day shown is
          // NOT today. It says what it does now, inside a control that looks like one.
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Go to today"
            onPress={() => {
              setCursor(today);
              setSelected(today);
            }}
            style={({ pressed }) => [s.todayBtn, pressed && { backgroundColor: color.inkHover }]}
          >
            <Ionicons name="return-up-back" size={14} color={color.goldHot} />
            <Text style={s.todayLink}>Go to today</Text>
          </Pressable>
        )}
      </View>

      {isCoach && (
        <View style={s.dayTools}>
          <GhostButton
            label="Add a session"
            icon="add"
            onPress={() =>
              router.push({
                pathname: '/schedule',
                params: {
                  date: selected.toISOString(),
                  ...(filter !== 'all' ? { athleteId: filter } : {}),
                },
              })
            }
          />
          <GhostButton
            label="Copy day"
            icon="copy-outline"
            disabled={dayEvents.length === 0}
            onPress={() => {
              setClipboard({ from: selected, events: dayEvents });
              setFlash(`${dayEvents.length} copied`);
            }}
          />
          <GhostButton label="Paste here" icon="clipboard-outline" disabled={!clipboard} onPress={paste} />
        </View>
      )}

      {events === null && <Text style={type.meta}>Loading…</Text>}
      {events !== null && dayEvents.length === 0 && (
        <Empty icon="calendar-outline">
          {isCoach
            ? 'Nothing on this day.\nAdd a session, or drag one here from another day.'
            : 'Nothing on this day.'}
        </Empty>
      )}

      {dayEvents.map((e) => (
        <SessionCard
          key={e.id}
          event={e}
          names={isCoach && filter === 'all' ? namesOn(e) : []}
          draggable={isCoach}
          reduceMotion={reduceMotion}
          gridRef={gridRef}
          gridOrigin={gridOrigin}
          cellRects={cellRects}
          hoverDay={hoverDay}
          // The coach opens a session to change it. Everyone else opens it to do it.
          onOpen={() =>
            router.push(
              isCoach
                ? { pathname: '/schedule', params: { eventId: e.id } }
                : { pathname: '/train/[id]', params: { id: e.id } }
            )
          }
          onCopy={() => {
            setClipboard({ from: selected, events: [e] });
            setFlash('Session copied');
          }}
          onDelete={() => setConfirmId(confirmId === e.id ? null : e.id)}
          confirming={confirmId === e.id}
          onConfirmDelete={async () => {
            setError(null);
            try {
              await deleteEvent(e.id);
              setConfirmId(null);
              setFlash('Session deleted');
            } catch {
              setError('That did not delete. Check your connection and try again.');
            }
          }}
          onCancelDelete={() => setConfirmId(null)}
          onDragState={setDragging}
          onBuzz={buzz}
          onDrop={(day) => drop(e, day)}
        />
      ))}

      {isCoach && dayEvents.length > 0 && (
        <Text style={s.hint}>
          Press and hold a session to pick it up, then drop it on any day above.
        </Text>
      )}
    </ScrollView>
  );
}

// --- the month grid ---------------------------------------------------------

function DayCell({
  day,
  events,
  isToday,
  isSelected,
  hoverDay,
  onPress,
  onRect,
}: {
  day: number;
  events: SessionEvent[];
  isToday: boolean;
  isSelected: boolean;
  hoverDay: SharedValue<number>;
  onPress: () => void;
  onRect: (r: CellRect) => void;
}) {
  const label = events.length
    ? `${day}, ${events.length} ${events.length === 1 ? 'session' : 'sessions'}: ${events
        .map(
          (e) =>
            `${typesOf(e)
              .map((k) => SESSION_TYPES[k]?.label ?? k)
              .join(' and ')}, ${e.name}`
        )
        .join('. ')}`
    : `${day}, nothing scheduled`;

  // Reads hoverDay on the UI thread, so the drop target lights up mid-drag without
  // React hearing about it. A ring AND a swell: on a grid of small cells a tint change
  // alone is easy to miss with a thumb over it.
  const drop = useAnimatedStyle(() => {
    const over = hoverDay.value === day;
    return {
      borderColor: over ? color.courtBlue : 'transparent',
      backgroundColor: over ? color.blueTint : isSelected ? color.gold : 'transparent',
      transform: [{ scale: withSpring(over ? 1.1 : 1, { damping: 13, stiffness: 220 }) }],
    };
  }, [day, isSelected]);

  return (
    <Animated.View
      style={[s.cell, drop]}
      onLayout={(e) => {
        const { x, y, width, height } = e.nativeEvent.layout;
        onRect({ d: day, x, y, w: width, h: height });
      }}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityState={{ selected: isSelected }}
        onPress={onPress}
        style={s.cellInner}
      >
        <Text style={[s.cellNum, isToday && s.cellNumToday, isSelected && { color: color.night }]}>
          {day}
        </Text>
        <View style={s.chips}>
          {events.slice(0, 2).map((e) => {
            // On the selected cell the fill is gold, and a type colour on top of it
            // measures as low as 1.03:1. Night is 7.0:1 on gold, and the type is still
            // carried by the icon and the word in the day list below.
            const tint = isSelected ? color.night : (SESSION_TYPES[e.type]?.color ?? color.slate);
            return (
              <View
                key={e.id}
                style={[
                  s.gridChip,
                  { backgroundColor: e.canceled ? 'transparent' : tint, borderColor: tint },
                ]}
              />
            );
          })}
          {events.length > 2 && (
            <Text style={[s.more, isSelected && { color: color.night }]}>+{events.length - 2}</Text>
          )}
        </View>
      </Pressable>
    </Animated.View>
  );
}

function Legend() {
  return (
    <>
      <Eyebrow>Legend</Eyebrow>
      <View style={s.legend}>
        {Object.entries(SESSION_TYPES).map(([k, v]) => (
          <View key={k} style={s.legendItem}>
            <Ionicons name={v.icon} size={13} color={v.color} />
            <Text style={s.legendText}>{v.label}</Text>
          </View>
        ))}
        <View style={s.legendItem}>
          <Ionicons name="close-circle-outline" size={13} color={color.slate} />
          <Text style={s.legendText}>Canceled</Text>
        </View>
      </View>
    </>
  );
}

// --- a session in the day list, and the drag that lifts it ------------------

function SessionCard({
  event,
  names,
  draggable,
  reduceMotion,
  gridRef,
  gridOrigin,
  cellRects,
  hoverDay,
  onOpen,
  onCopy,
  onDelete,
  confirming,
  onConfirmDelete,
  onCancelDelete,
  onDragState,
  onBuzz,
  onDrop,
}: {
  event: SessionEvent;
  names: string[];
  draggable: boolean;
  reduceMotion: boolean;
  gridRef: ReturnType<typeof useAnimatedRef<View>>;
  gridOrigin: SharedValue<{ x: number; y: number }>;
  cellRects: SharedValue<CellRect[]>;
  hoverDay: SharedValue<number>;
  onOpen: () => void;
  /** Coach only. Arms the confirm row below the card rather than deleting on the tap:
   *  one stray thumb should never remove a family's session. */
  onDelete: () => void;
  confirming: boolean;
  onConfirmDelete: () => void;
  onCancelDelete: () => void;
  onCopy: () => void;
  onDragState: (on: boolean) => void;
  onBuzz: (kind: 'pick' | 'move' | 'drop') => void;
  onDrop: (day: number) => void;
}) {
  // A session can cover several things at once. The first is the primary one, which
  // is what the badge draws and what the grid tints the day with; the rest are spelled
  // out in the row so a coach sees at a glance that Tuesday is footwork AND serving.
  const cats = typesOf(event);
  const t = SESSION_TYPES[cats[0]] ?? {
    label: event.type,
    icon: 'ellipse-outline' as const,
    color: color.slate,
  };
  const extra = cats.slice(1).map((k) => SESSION_TYPES[k]).filter(Boolean);
  const d = event.startsAt.toDate();

  const tx = useSharedValue(0);
  const ty = useSharedValue(0);
  const lift = useSharedValue(0);

  // The parent re-renders the instant a drag begins, because scrollEnabled is React
  // state. That hands this component three fresh callbacks, and without the ref the
  // gesture would be rebuilt underneath a gesture that is already running. One stable
  // entry point, read through a ref, so the gesture object is built exactly once.
  const cb = useRef({ onDragState, onBuzz, onDrop });
  cb.current = { onDragState, onBuzz, onDrop };
  const notify = useCallback((what: 'on' | 'off' | 'pick' | 'move' | 'drop', day = 0) => {
    const c = cb.current;
    if (what === 'on') c.onDragState(true);
    else if (what === 'off') c.onDragState(false);
    else if (what === 'drop') c.onDrop(day);
    else c.onBuzz(what);
  }, []);

  const pan = useMemo(
    () =>
      Gesture.Pan()
        .enabled(draggable)
        // A press and hold, not a swipe. The card sits inside a scroll view, and a pan
        // that claimed the touch immediately would make the page unscrollable.
        .activateAfterLongPress(220)
        .onStart(() => {
          'worklet';
          // Measured here, synchronously on the UI thread, so the origin is whatever
          // it is right now. Measuring asynchronously at drag start means hit-testing
          // against a stale origin for the first few frames.
          const m = measure(gridRef);
          if (m) gridOrigin.value = { x: m.pageX, y: m.pageY };
          lift.value = withTiming(1, { duration: 120 });
          runOnJS(notify)('on');
          runOnJS(notify)('pick');
        })
        .onUpdate((e) => {
          'worklet';
          tx.value = e.translationX;
          ty.value = e.translationY;

          const gx = e.absoluteX - gridOrigin.value.x;
          const gy = e.absoluteY - gridOrigin.value.y;
          let found = -1;
          const rects = cellRects.value;
          for (let i = 0; i < rects.length; i++) {
            const r = rects[i];
            if (gx >= r.x && gx <= r.x + r.w && gy >= r.y && gy <= r.y + r.h) {
              found = r.d;
              break;
            }
          }
          // One tick per day crossed, not one per frame.
          if (found !== hoverDay.value) {
            hoverDay.value = found;
            if (found > 0) runOnJS(notify)('move');
          }
        })
        .onEnd(() => {
          'worklet';
          const day = hoverDay.value;
          if (day > 0) runOnJS(notify)('drop', day);
        })
        .onFinalize(() => {
          'worklet';
          // Runs on a cancel as well as a normal end, so a gesture the system takes
          // away still puts the card back rather than leaving it stranded mid-flight.
          hoverDay.value = -1;
          lift.value = withTiming(0, { duration: reduceMotion ? 0 : 140 });
          if (reduceMotion) {
            tx.value = 0;
            ty.value = 0;
          } else {
            tx.value = withSpring(0, { damping: 15, stiffness: 180 });
            ty.value = withSpring(0, { damping: 15, stiffness: 180 });
          }
          runOnJS(notify)('off');
        }),
    // Every one of these is stable for the life of the card, so the gesture is
    // constructed once and never swapped mid-drag.
    [draggable, reduceMotion, gridRef, gridOrigin, cellRects, hoverDay, tx, ty, lift, notify]
  );

  const card = useAnimatedStyle(() => ({
    transform: [{ translateX: tx.value }, { translateY: ty.value }, { scale: 1 + lift.value * 0.03 }],
    zIndex: lift.value > 0 ? 20 : 0,
  }));

  // The lifted look is its own layer so it can fade in rather than snap on, and so
  // the resting card keeps a flat, cheap style.
  const heldStyle = useAnimatedStyle(() => ({ opacity: lift.value }));

  return (
    <GestureDetector gesture={pan}>
      <Animated.View style={[s.ev, card]}>
        <Animated.View style={[StyleSheet.absoluteFill, s.evHeld, heldStyle]} pointerEvents="none" />

        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${cats.map((k) => SESSION_TYPES[k]?.label ?? k).join(' and ')}, ${event.name}, ${event.timeLabel || d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}${event.canceled ? ', canceled' : ''}`}
          accessibilityHint={
            draggable ? 'Opens the session. Press and hold to move it to another day.' : undefined
          }
          onPress={onOpen}
          style={s.evInner}
        >
          <View style={[s.evIcon, { backgroundColor: `${t.color}22`, borderColor: t.color }]}>
            <Ionicons name={t.icon} size={16} color={t.color} />
          </View>

          <View style={{ flex: 1 }}>
            <View style={s.evTop}>
              <Text style={[s.evClock, event.canceled && s.struck]}>
                {event.timeLabel || d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
              </Text>
              {event.durationMin ? <Text style={s.evDur}>{event.durationMin} min</Text> : null}
              {event.kind === 'coached' ? (
                <View style={s.coached}>
                  <Ionicons name="people-outline" size={11} color={color.courtBlue} />
                  <Text style={s.coachedText}>
                    {(event.athleteIds?.length ?? 1) > 1
                      ? `Coached, ${event.athleteIds?.length} players`
                      : 'Coached'}
                  </Text>
                </View>
              ) : null}
              {extra.map((x) => (
                <View key={x.label} style={s.evType}>
                  <Ionicons name={x.icon} size={11} color={x.color} />
                  <Text style={[s.evTypeText, { color: x.color }]}>{x.label}</Text>
                </View>
              ))}
            </View>

            <Text style={[s.evName, event.canceled && s.struck]}>{event.name}</Text>
            <Text style={s.evMeta}>
              {names.length ? `${names.join(', ')} · ` : ''}
              {event.location}
              {event.canceled ? ' · Canceled' : ''}
            </Text>

            {event.blocks?.length ? (
              <Text style={s.evBlocks} numberOfLines={1}>
                {event.blocks.map((b) => b.name).join(' · ')}
              </Text>
            ) : null}
          </View>

          {draggable && (
            <View style={s.evActions}>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Copy ${event.name}`}
                onPress={onCopy}
                hitSlop={6}
                style={s.evCopy}
              >
                <Ionicons name="copy-outline" size={16} color={color.textDim} />
              </Pressable>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Delete ${event.name}`}
                accessibilityState={{ expanded: confirming }}
                onPress={onDelete}
                hitSlop={6}
                style={s.evCopy}
              >
                <Ionicons
                  name={confirming ? 'close' : 'trash-outline'}
                  size={16}
                  color={confirming ? color.chalk : color.textDim}
                />
              </Pressable>
            </View>
          )}
        </Pressable>

        {confirming && (
          <View style={s.evConfirm}>
            <Text style={s.evConfirmText}>
              Delete this session? Everyone on it loses it from their calendar too.
            </Text>
            <View style={s.evConfirmRow}>
              <GhostButton label="Delete it" icon="trash-outline" tone="danger" onPress={onConfirmDelete} />
              <GhostButton label="Keep it" onPress={onCancelDelete} />
            </View>
          </View>
        )}
      </Animated.View>
    </GestureDetector>
  );
}

function NavBtn({
  icon,
  label,
  onPress,
}: {
  icon: React.ComponentProps<typeof Ionicons>['name'];
  label: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={({ pressed }) => [s.navBtn, pressed && { backgroundColor: color.inkHover }]}
    >
      <Ionicons name={icon} size={20} color={color.chalk} />
    </Pressable>
  );
}

function FilterChip({ label, on, onPress }: { label: string; on: boolean; onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityState={{ selected: on }}
      accessibilityLabel={label}
      onPress={onPress}
      style={({ pressed }) => [s.filter, on && s.filterOn, pressed && !on && { backgroundColor: color.inkHover }]}
    >
      <Text style={[s.filterText, on && { color: color.night }]}>{label}</Text>
    </Pressable>
  );
}

const s = StyleSheet.create({
  page: { flex: 1, backgroundColor: semantic.surfacePage },
  pad: { padding: 16, paddingBottom: 40 },

  calHead: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 12 },
  month: { fontSize: 24, fontWeight: '900', color: color.chalk, letterSpacing: -0.4 },
  year: { fontSize: 13, fontWeight: '700', color: color.textDim, marginTop: 1 },
  navBtn: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center', borderRadius: radius.chip },

  filterRow: { gap: 6, paddingBottom: 12 },
  filter: {
    minHeight: 44,
    justifyContent: 'center',
    paddingHorizontal: 14,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: semantic.borderStrong,
    backgroundColor: semantic.surfaceCard,
  },
  filterOn: { backgroundColor: color.gold, borderColor: color.gold },
  filterText: { fontSize: 12.5, fontWeight: '700', color: color.textBody },

  dow: { flexDirection: 'row', marginBottom: 4 },
  dowLabel: {
    flex: 1,
    textAlign: 'center',
    fontSize: 10.5,
    fontWeight: '700',
    letterSpacing: 0.8,
    color: color.textDim,
  },

  grid: { flexDirection: 'row', flexWrap: 'wrap' },
  cell: {
    width: `${100 / 7}%`,
    aspectRatio: 0.84,
    borderRadius: radius.chip,
    borderWidth: 1,
    borderColor: 'transparent',
  },
  cellInner: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  cellNum: { fontSize: 13.5, fontWeight: '600', color: color.textBody },
  cellNumToday: { color: color.goldHot, fontWeight: '900' },
  chips: { flexDirection: 'row', alignItems: 'center', gap: 2, height: 9, marginTop: 4 },
  gridChip: { width: 12, height: 3.5, borderRadius: 2, borderWidth: 1 },
  more: { fontSize: 9, fontWeight: '700', color: color.textDim, marginLeft: 1 },

  legend: { flexDirection: 'row', flexWrap: 'wrap', gap: 12, columnGap: 14 },
  legendItem: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  legendText: { fontSize: 12, color: color.textBody },

  dayHead: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    marginTop: 22,
    marginBottom: 10,
  },
  dayTitle: { fontSize: 17, fontWeight: '800', color: color.chalk },
  todayBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    minHeight: 44,
    paddingHorizontal: 11,
    borderWidth: 1,
    borderColor: semantic.borderStrong,
    borderRadius: radius.pill,
  },
  todayLink: { fontSize: 13, fontWeight: '700', color: color.goldHot },
  dayTools: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 14 },

  clip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: color.blueTint,
    borderWidth: 1,
    borderColor: color.blueLine,
    borderRadius: radius.card,
    paddingVertical: 10,
    paddingLeft: 12,
    paddingRight: 4,
    marginTop: 14,
  },
  clipText: { flex: 1, fontSize: 13, color: color.chalk, lineHeight: 18 },
  clipClear: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },

  ev: {
    backgroundColor: semantic.surfaceCard,
    borderWidth: 1,
    borderColor: semantic.borderStrong,
    borderRadius: radius.card,
    marginBottom: 8,
  },
  // An offset and a real blur, so the card reads as lifted off the page rather than
  // ringed. A zero-offset glow is decoration; this is depth.
  evHeld: {
    borderRadius: radius.card,
    borderWidth: 1,
    borderColor: color.courtBlue,
    backgroundColor: color.inkHover,
    boxShadow: '0 10px 22px rgba(0,0,0,0.45)',
  },
  evInner: { flexDirection: 'row', gap: 11, padding: 12, alignItems: 'flex-start' },
  evIcon: {
    width: 34,
    height: 34,
    borderRadius: radius.chip,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  evTop: { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  evClock: { fontSize: 15, fontWeight: '800', color: color.chalk },
  evDur: { fontSize: 11.5, fontWeight: '700', color: color.textDim },
  coached: { flexDirection: 'row', alignItems: 'center', gap: 3 },
  coachedText: { fontSize: 10.5, fontWeight: '800', letterSpacing: 0.6, color: color.courtBlue },
  evType: { flexDirection: 'row', alignItems: 'center', gap: 3 },
  evTypeText: { fontSize: 10.5, fontWeight: '800', letterSpacing: 0.6 },
  evName: { fontSize: 15, fontWeight: '600', color: color.chalk, marginTop: 3 },
  evMeta: { ...type.meta, marginTop: 2 },
  evBlocks: { fontSize: 12, color: color.textDim, marginTop: 5 },
  evActions: { flexDirection: 'row', alignItems: 'center', gap: 2 },
  evConfirm: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: semantic.border,
    paddingHorizontal: 13,
    paddingTop: 10,
    paddingBottom: 12,
    gap: 10,
  },
  evConfirmText: { ...type.meta, lineHeight: 18 },
  evConfirmRow: { flexDirection: 'row', gap: 8, flexWrap: 'wrap' },
  evCopy: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center', marginTop: -4, marginRight: -6 },
  struck: { textDecorationLine: 'line-through', color: color.textDim },

  flash: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 12 },
  flashText: { fontSize: 13, fontWeight: '600', color: color.win },
  error: { marginTop: 12, color: color.danger, fontSize: 13.5, lineHeight: 19 },
  hint: { ...type.meta, marginTop: 6, lineHeight: 17 },
});
