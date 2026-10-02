import { useEffect, useMemo, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import Svg, { Circle, G, Line } from 'react-native-svg';
import { useReducedMotion } from 'react-native-reanimated';
import { GhostButton, Segmented } from '../ui';
import { color, semantic } from '../theme';

/**
 * A trend's body shape, replayed from pose keyframes: no video ever leaves the court.
 *
 * `frames` is the tracker's compact JSON: { w, h, fps, frames }, each frame 33 MediaPipe
 * landmarks as [x, y, visibility], normalised 0..1. The coach asked for leg movement and
 * body shape above all, so the legs are drawn thicker and in optic yellow, the torso and
 * arms in gold, and a faint ghost of the first frame stays put underneath so the change
 * across the clip is visible at a glance.
 */

type Landmark = [number, number, number];
interface PoseData {
  w: number;
  h: number;
  fps: number;
  frames: Landmark[][];
}

// MediaPipe pose indices. 11/12 shoulders, 13/14 elbows, 15/16 wrists, 23/24 hips,
// 25/26 knees, 27/28 ankles, 31/32 foot index; 0 is the nose, used only for the head.
const UPPER: Array<[number, number]> = [
  [11, 12], [11, 23], [12, 24], [23, 24], [11, 13], [13, 15], [12, 14], [14, 16],
];
const LEGS: Array<[number, number]> = [
  [23, 25], [25, 27], [27, 31], [24, 26], [26, 28], [28, 32],
];
const UPPER_JOINTS = [11, 12, 13, 14, 15, 16, 23, 24];
const LEG_JOINTS = [25, 26, 27, 28, 31, 32];
/** Below this the model is guessing, and a guessed knee drawn as fact misleads a coach. */
const SEEN = 0.5;

function parse(raw: string): PoseData | null {
  try {
    const d = JSON.parse(raw) as PoseData;
    if (!Array.isArray(d?.frames) || !d.frames.length) return null;
    return { w: Number(d.w) || 1, h: Number(d.h) || 1, fps: Number(d.fps) || 15, frames: d.frames };
  } catch {
    return null;
  }
}

export function PoseClip({ frames, fps, label }: { frames: string; fps: number; label: string }) {
  const data = useMemo(() => parse(frames), [frames]);
  const reduce = useReducedMotion();
  const [playing, setPlaying] = useState(!reduce);
  const [speed, setSpeed] = useState<'1' | '0.5'>('1');
  const [i, setI] = useState(0);
  const count = data?.frames.length ?? 0;

  useEffect(() => {
    if (!playing || count < 2) return;
    const rate = Math.min(60, Math.max(1, data?.fps || fps || 15)) * Number(speed);
    const t = setInterval(() => setI((k) => (k + 1) % count), 1000 / rate);
    return () => clearInterval(t);
  }, [playing, speed, count, data?.fps, fps]);

  // Frame the body, not the camera: a far-court player is a few percent of the picture,
  // so the view box is the box around every joint the clip ever shows.
  const view = useMemo(() => {
    if (!data) return null;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const f of data.frames)
      for (const p of f ?? []) {
        if (!p || p[2] < SEEN) continue;
        x0 = Math.min(x0, p[0] * data.w);
        x1 = Math.max(x1, p[0] * data.w);
        y0 = Math.min(y0, p[1] * data.h);
        y1 = Math.max(y1, p[1] * data.h);
      }
    if (!Number.isFinite(x0)) return null;
    const pad = Math.max(x1 - x0, y1 - y0) * 0.14 + 1;
    return { x: x0 - pad, y: y0 - pad, w: x1 - x0 + pad * 2, h: y1 - y0 + pad * 2 };
  }, [data]);

  if (!data || !view) {
    return <Text style={s.note}>This clip could not be read. The trend above still stands.</Text>;
  }

  const unit = view.h / 100;
  const pt = (f: Landmark[], k: number) => {
    const p = f?.[k];
    return p && p[2] >= SEEN ? { x: p[0] * data.w, y: p[1] * data.h } : null;
  };

  const body = (f: Landmark[], ghost: boolean) => {
    const seg = (pairs: Array<[number, number]>, stroke: string, width: number) =>
      pairs.map(([a, b]) => {
        const p = pt(f, a);
        const q = pt(f, b);
        return p && q ? (
          <Line key={`${a}-${b}`} x1={p.x} y1={p.y} x2={q.x} y2={q.y} stroke={stroke} strokeWidth={width} strokeLinecap="round" />
        ) : null;
      });
    const dots = (ids: number[], fill: string, r: number) =>
      ids.map((k) => {
        const p = pt(f, k);
        return p ? <Circle key={k} cx={p.x} cy={p.y} r={r} fill={fill} /> : null;
      });
    const nose = pt(f, 0);
    if (ghost) {
      return (
        <G opacity={0.22}>
          {seg(UPPER, color.chalk, unit * 1.4)}
          {seg(LEGS, color.chalk, unit * 2)}
        </G>
      );
    }
    return (
      <G>
        {nose ? <Circle cx={nose.x} cy={nose.y} r={unit * 4.5} stroke={color.gold} strokeWidth={unit * 1.4} fill="none" /> : null}
        {seg(UPPER, color.gold, unit * 2)}
        {seg(LEGS, color.ball, unit * 3.2)}
        {dots(UPPER_JOINTS, color.chalk, unit * 1.5)}
        {dots(LEG_JOINTS, color.ball, unit * 2)}
      </G>
    );
  };

  return (
    <View>
      <View
        style={s.stage}
        accessible
        accessibilityLabel={`${label}. Body-shape animation, ${count} frames. Legs drawn in yellow, torso and arms in gold, the first frame faint underneath.`}
      >
        <Svg width="100%" height="100%" viewBox={`${view.x} ${view.y} ${view.w} ${view.h}`}>
          {body(data.frames[0], true)}
          {body(data.frames[Math.min(i, count - 1)], false)}
        </Svg>
      </View>
      <View style={s.controls}>
        <GhostButton
          label={playing ? 'Pause' : 'Play'}
          icon={playing ? 'pause' : 'play'}
          onPress={() => setPlaying((p) => !p)}
          disabled={count < 2}
        />
        <View style={{ flex: 1 }}>
          <Segmented
            label="Playback speed"
            value={speed}
            onChange={setSpeed}
            options={[
              { value: '0.5', label: '0.5x' },
              { value: '1', label: '1x' },
            ]}
          />
        </View>
      </View>
      <Text style={s.legend}>
        Legs in yellow · torso and arms in gold · faint: the first frame · frame {Math.min(i, count - 1) + 1} of {count}
      </Text>
    </View>
  );
}

const s = StyleSheet.create({
  stage: {
    height: 280,
    backgroundColor: color.night,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: semantic.border,
    overflow: 'hidden',
  },
  controls: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 10 },
  legend: { fontSize: 11.5, color: color.textDim, marginTop: 8, fontVariant: ['tabular-nums'] },
  note: { fontSize: 13, color: color.textDim, marginTop: 8 },
});
