import { useEffect, useState } from 'react';
import { StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import Animated, {
  Easing,
  interpolate,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withTiming,
  type SharedValue,
} from 'react-native-reanimated';
import { color } from './theme';
import { playSfx } from './sfx';

/**
 * The thing that goes off when a player marks work done.
 *
 * Six variants, unlocked in src/rewards.ts, all driven by ONE shared value. The whole
 * animation runs on the UI thread: a burst that stutters because JavaScript was busy
 * writing the completion to Firestore would undercut the only moment this screen has.
 *
 * Shards are a fixed 28 components whatever the variant asks for, because hooks cannot
 * be called in a loop whose length changes. The surplus ones render at zero opacity.
 */

interface Spec {
  colors: string[];
  word: string;
  /** How many of the 28 shards this variant actually throws. */
  shards: number;
  /** How far they travel, in points, before gravity takes them. */
  spread: number;
  ms: number;
  /** A long thin streak instead of a round spark. */
  bar?: boolean;
  /** How many shockwave rings. More rings read as more force, so this climbs with the
   *  unlock order: the last one a player earns should not look like the first. */
  rings: number;
  /** A full-screen flash behind everything. */
  flash?: string;
}

export const SPECS: Record<string, Spec> = {
  spark: { colors: [color.gold, color.goldHot, color.ball], word: 'DONE', shards: 14, spread: 150, ms: 850, rings: 1 },
  ace: { colors: [color.ball, '#F4FBB8', color.gold], word: 'ACE', shards: 18, spread: 190, ms: 950, bar: true, rings: 2 },
  onfire: { colors: ['#FF7A18', color.ball, color.gold], word: 'ON FIRE', shards: 22, spread: 220, ms: 1050, bar: true, rings: 3, flash: 'rgba(255,122,24,0.30)' },
  smash: { colors: [color.chalk, color.goldHot, '#8E8E9B'], word: 'SMASH', shards: 16, spread: 260, ms: 1050, rings: 4, flash: 'rgba(244,241,234,0.22)' },
  bolt: { colors: ['#8FD8FF', '#FFFFFF', color.courtBlue], word: 'LIGHTS OUT', shards: 20, spread: 280, ms: 1100, bar: true, rings: 5, flash: 'rgba(143,216,255,0.34)' },
  nova: { colors: ['#FFFFFF', color.ball, color.goldHot], word: 'SUPERNOVA', shards: 28, spread: 320, ms: 1250, rings: 7, flash: 'rgba(255,255,255,0.40)' },
};

const MAX_SHARDS = 28;
/** Same trick as the shards: a fixed component count, because hooks cannot live in a loop
 *  whose length changes between renders. The surplus rings render at zero opacity. */
const MAX_RINGS = 7;

/** Deterministic per-shard jitter. A real random would re-roll on every render and
 *  make the burst twitch mid-flight. */
const rnd = (i: number, salt: number) => {
  const v = Math.sin(i * 12.9898 + salt * 78.233) * 43758.5453;
  return v - Math.floor(v);
};

export function Celebrate({
  id,
  nonce,
  label,
  onDone,
}: {
  /** A key from SPECS. Anything unknown falls back to the free one. */
  id: string;
  /** Bump this to play. Zero plays nothing, which is the mounted-but-idle state. */
  nonce: number;
  /** Optional line under the word, e.g. what was just finished. */
  label?: string;
  onDone?: () => void;
}) {
  const spec = SPECS[id] ?? SPECS.spark;
  const { width, height } = useWindowDimensions();
  const reduce = useReducedMotion();
  const [playing, setPlaying] = useState(false);
  const t = useSharedValue(0);

  useEffect(() => {
    if (!nonce) return;
    setPlaying(true);
    // Sound is not motion, so it plays even under Reduce Motion: someone who has turned
    // animation down has not asked to stop being told the work landed.
    playSfx(id);
    t.value = 0;
    t.value = withTiming(1, { duration: spec.ms, easing: Easing.out(Easing.quad) });
    const done = setTimeout(() => {
      setPlaying(false);
      onDone?.();
    }, spec.ms + 120);
    return () => clearTimeout(done);
    // Deliberately keyed on the nonce alone: re-running this because a parent
    // re-rendered would restart the burst halfway through.
  }, [nonce]);

  const flash = useAnimatedStyle(() => ({
    opacity: interpolate(t.value, [0, 0.08, 0.5, 1], [0, 1, 0.35, 0]),
  }));

  const word = useAnimatedStyle(() => ({
    opacity: interpolate(t.value, [0, 0.08, 0.72, 1], [0, 1, 1, 0]),
    transform: reduce
      ? []
      : [
          { scale: interpolate(t.value, [0, 0.16, 0.8, 1], [1.9, 1, 1, 1.12]) },
          { translateY: interpolate(t.value, [0, 1], [10, -26]) },
        ],
  }));

  if (!playing) return null;

  const cx = width / 2;
  const cy = height / 2;

  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="none" accessibilityElementsHidden>
      {spec.flash ? (
        <Animated.View style={[StyleSheet.absoluteFill, { backgroundColor: spec.flash }, flash]} />
      ) : null}

      {Array.from({ length: MAX_RINGS }, (_, i) => (
        <Ring key={i} i={i} t={t} spec={spec} cx={cx} cy={cy} still={reduce} />
      ))}

      {Array.from({ length: MAX_SHARDS }, (_, i) => (
        <Shard key={i} i={i} t={t} spec={spec} cx={cx} cy={cy} still={reduce} />
      ))}

      <Animated.View style={[s.wordBox, { top: cy - 60, width }, word]}>
        <Text style={[s.word, { color: spec.colors[0] }]}>{spec.word}</Text>
        {label ? <Text style={s.label}>{label}</Text> : null}
      </Animated.View>
    </View>
  );
}

function Shard({
  i,
  t,
  spec,
  cx,
  cy,
  still,
}: {
  i: number;
  t: SharedValue<number>;
  spec: Spec;
  cx: number;
  cy: number;
  still: boolean;
}) {
  const on = i < spec.shards;
  const angle = (i / spec.shards) * Math.PI * 2 + rnd(i, 3) * 0.5;
  const dist = spec.spread * (0.55 + rnd(i, 7) * 0.65);
  const dx = Math.cos(angle) * dist;
  const dy = Math.sin(angle) * dist;
  const spin = (rnd(i, 11) - 0.5) * 720;
  const size = spec.bar ? 4 : 7 + rnd(i, 5) * 5;
  const long = spec.bar ? 22 + rnd(i, 9) * 20 : size;

  const st = useAnimatedStyle(() => {
    if (!on || still) return { opacity: 0 };
    const p = t.value;
    return {
      opacity: interpolate(p, [0, 0.06, 0.75, 1], [0, 1, 0.9, 0]),
      transform: [
        { translateX: dx * p },
        // Gravity: they fly out fast and fall away, rather than drifting outward
        // forever, which is what makes a burst read as explosive rather than as fog.
        { translateY: dy * p + p * p * 120 },
        { rotate: `${angle * 57.3 + spin * p}deg` },
        { scale: interpolate(p, [0, 0.2, 1], [0.4, 1.15, 0.5]) },
      ],
    };
  });

  return (
    <Animated.View
      style={[
        {
          position: 'absolute',
          left: cx - long / 2,
          top: cy - size / 2,
          width: long,
          height: size,
          borderRadius: spec.bar ? 2 : size,
          backgroundColor: spec.colors[i % spec.colors.length],
        },
        st,
      ]}
    />
  );
}

/**
 * One shockwave ring. They are staggered rather than concentric-at-once: each starts a beat
 * after the one before and travels further, so six rings read as a blast wave instead of a
 * dartboard. Under Reduce Motion only the innermost shows, as a fading circle that does not
 * travel.
 */
function Ring({
  i,
  t,
  spec,
  cx,
  cy,
  still,
}: {
  i: number;
  t: SharedValue<number>;
  spec: Spec;
  cx: number;
  cy: number;
  still: boolean;
}) {
  const on = i < spec.rings;
  const start = i * 0.07;
  const reach = 1.9 + i * 0.3;
  const tint = spec.colors[i % spec.colors.length];

  const st = useAnimatedStyle(() => {
    if (!on) return { opacity: 0 };
    if (still) return i === 0 ? { opacity: interpolate(t.value, [0, 0.1, 1], [0, 0.5, 0]) } : { opacity: 0 };
    // Each ring runs its own 0..1 over what is left of the timeline after its start.
    const q = Math.max(0, Math.min(1, (t.value - start) / (1 - start)));
    return {
      opacity: interpolate(q, [0, 0.08, 1], [0, Math.max(0.2, 0.85 - i * 0.09), 0]),
      transform: [{ scale: interpolate(q, [0, 1], [0.12, reach]) }],
    };
  });

  return (
    <Animated.View
      style={[s.ring, { left: cx - 90, top: cy - 90, borderColor: tint }, st]}
      pointerEvents="none"
    />
  );
}

const s = StyleSheet.create({
  ring: { position: 'absolute', width: 180, height: 180, borderRadius: 90, borderWidth: 4 },
  wordBox: { position: 'absolute', alignItems: 'center' },
  word: { fontSize: 34, fontWeight: '900', letterSpacing: 1.5 },
  label: { marginTop: 6, fontSize: 13, fontWeight: '700', color: color.chalk, letterSpacing: 0.4 },
});
