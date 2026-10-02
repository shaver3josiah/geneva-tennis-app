import { useEffect } from 'react';
import { StyleSheet, View } from 'react-native';
import Animated, {
  Easing,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withDelay,
  withTiming,
} from 'react-native-reanimated';
import Svg, { Circle, ClipPath, Defs, G, Path, RadialGradient, Stop } from 'react-native-svg';
import {
  ICON_DISC,
  ICON_G,
  ICON_G_STROKE,
  ICON_STREAKS,
  ICON_VIEW_BOX,
  LOGO_H,
  LOGO_W,
  VIEW_BOX,
  WORDMARK,
  WORD_SCALE,
  WORD_STROKE,
} from './brand/logo-paths';
import { color } from './theme';

/**
 * The Geneva Tennis lockup: a gold ball with two white seams, and GENEVA TENNIS beside it.
 *
 * The ball is the brand mark: its seam is a bold G with two wind streaks through the mouth
 * (src/brand/logo-paths.ts; scripts/brand.mjs renders the app icon from the same geometry).
 *
 * The wordmark is stroked paths rather than a Text, so it renders identically on every
 * platform and never waits on a font. Each animated part is its own Svg layer, stacked
 * absolutely and sharing one viewBox, so they register exactly and every part moves with
 * an ordinary Reanimated view transform.
 */

const OUT = Easing.out(Easing.cubic);

const pct = (v: number, of: number) => `${((v / of) * 100).toFixed(2)}%`;
/** The ball's centre in the lockup box, so it grows from itself and not from the corner. */
const BALL_ORIGIN = [pct(100, LOGO_W), pct(100, LOGO_H), 0];

/** The design system's floor: below this the lockup is not legible and the square
 *  icon is the correct mark instead. Nothing in this app lays out narrower than this,
 *  so it is a guard rather than a branch. */
export const LOCKUP_MIN_WIDTH = 250;

/** The ball, in the icon's 100 x 100 space: lit gold, the G seam, the two streaks. */
function Ball({ fill, id }: { fill: string; id: string }) {
  // The lit gradient belongs to the brand gold. Any other fill (a monochrome use) is flat.
  const lit = fill === color.gold;
  return (
    <>
      <Defs>
        <ClipPath id={id}>
          <Circle {...ICON_DISC} />
        </ClipPath>
        {lit && (
          <RadialGradient id={`${id}Lit`} cx="38%" cy="32%" r="78%">
            <Stop offset="0" stopColor="#EBC967" />
            <Stop offset="0.5" stopColor={fill} />
            <Stop offset="1" stopColor="#8A6512" />
          </RadialGradient>
        )}
      </Defs>
      <Circle {...ICON_DISC} fill={lit ? `url(#${id}Lit)` : fill} />
      <G clipPath={`url(#${id})`}>
        <Path d={ICON_G} fill="none" stroke={CREAM} strokeWidth={ICON_G_STROKE} strokeLinecap="round" strokeLinejoin="round" />
        <Path d={ICON_STREAKS[0]} fill={CREAM} opacity={0.92} />
        <Path d={ICON_STREAKS[1]} fill={CREAM} opacity={0.62} />
      </G>
    </>
  );
}

/** The seam's cream: warmer than bone, so the mark reads as a ball and not a badge. */
const CREAM = '#FBF7EE';

export function Logo({
  width,
  fill = color.gold,
  play = true,
}: {
  /** Rendered width in points. The lockup's aspect ratio decides the height. */
  width: number;
  fill?: string;
  /** False renders the finished lockup with no animation at all. */
  play?: boolean;
}) {
  const w = Math.max(LOCKUP_MIN_WIDTH, width);
  const h = (w * LOGO_H) / LOGO_W;
  // The design system asks for clear space of 9% of the mark's width on every side.
  // It is the rule most easily lost when a logo is dropped into somebody's layout.
  const pad = w * 0.09;

  const ball = useSharedValue(0);
  const word = useSharedValue(0);
  const reduceMotion = useReducedMotion();

  useEffect(() => {
    if (!play || reduceMotion) {
      ball.value = 1;
      word.value = 1;
      return;
    }
    ball.value = 0;
    word.value = 0;
    ball.value = withTiming(1, { duration: 520, easing: OUT });
    word.value = withDelay(180, withTiming(1, { duration: 520, easing: OUT }));
  }, [play, reduceMotion, ball, word]);

  // The ball grows out of its own centre; the wordmark slides in from behind it.
  const ballStyle = useAnimatedStyle(() => ({
    opacity: ball.value,
    transformOrigin: BALL_ORIGIN,
    transform: [{ scale: 0.7 + 0.3 * ball.value }],
  }));
  const wordStyle = useAnimatedStyle(() => ({
    opacity: word.value,
    transform: [{ translateX: (1 - word.value) * -0.04 * w }],
  }));

  return (
    <View
      style={{ width: w + pad * 2, height: h + pad * 2, padding: pad }}
      accessibilityRole="image"
      accessibilityLabel="Geneva Tennis"
    >
      <View style={{ width: w, height: h }}>
        <Animated.View style={[StyleSheet.absoluteFill, ballStyle]} pointerEvents="none">
          <Svg width={w} height={h} viewBox={VIEW_BOX}>
            {/* The icon is drawn in a 100 x 100 box; the lockup's ball is 200 x 200. */}
            <G transform="scale(2)">
              <Ball fill={fill} id="gtLockupBall" />
            </G>
          </Svg>
        </Animated.View>
        <Animated.View style={[StyleSheet.absoluteFill, wordStyle]} pointerEvents="none">
          <Svg width={w} height={h} viewBox={VIEW_BOX}>
            {WORDMARK.map((g, i) => (
              <G key={i} transform={`translate(${g.x} ${g.y}) scale(${WORD_SCALE})`}>
                <Path
                  d={g.d}
                  fill="none"
                  stroke={fill}
                  strokeWidth={WORD_STROKE}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </G>
            ))}
          </Svg>
        </Animated.View>
      </View>
    </View>
  );
}

/**
 * The square mark, static.
 *
 * This is the correct brand asset below the lockup's 250px floor, and the design
 * system says so in as many words: the lockup is not legible small, and stretching it
 * down there is worse than not using it at all.
 */
export function BrandIcon({ size = 44, fill = color.gold }: { size?: number; fill?: string }) {
  return (
    <View
      style={{ width: size, height: size }}
      accessibilityRole="image"
      accessibilityLabel="Geneva Tennis"
    >
      <Svg width={size} height={size} viewBox={ICON_VIEW_BOX}>
        <Ball fill={fill} id="gtIconBall" />
      </Svg>
    </View>
  );
}
