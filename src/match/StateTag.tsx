import { useEffect } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import Animated, {
  cancelAnimation,
  Easing,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';
import { STATE_WORD, type MatchState } from '../matches';
import { color, radius } from '../theme';

/**
 * A match's state as a word, always. "Live" also gets the pulsing optic-yellow dot,
 * because a coach scanning six courts' worth of rows should find the live ones without
 * reading, but the word is still there for anyone who cannot see the dot or the colour.
 */
export function StateTag({ state }: { state: MatchState }) {
  if (state === 'live') return <LiveBadge />;
  return (
    <View style={[s.tag, state === 'final' && s.final]}>
      <Text style={[s.tagText, state === 'final' && { color: color.chalk }]}>{STATE_WORD[state]}</Text>
    </View>
  );
}

function LiveBadge() {
  const reduce = useReducedMotion();
  const o = useSharedValue(1);
  useEffect(() => {
    if (reduce) return;
    o.value = withRepeat(withTiming(0.2, { duration: 850, easing: Easing.inOut(Easing.quad) }), -1, true);
    return () => cancelAnimation(o);
  }, [reduce, o]);
  const pulse = useAnimatedStyle(() => ({ opacity: o.value }));

  return (
    <View style={[s.tag, s.live]} accessible accessibilityLabel="Live now">
      <Animated.View style={[s.dot, pulse]} />
      <Text style={[s.tagText, { color: color.ball }]}>LIVE</Text>
    </View>
  );
}

const s = StyleSheet.create({
  tag: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    alignSelf: 'flex-start',
    borderWidth: 1,
    borderColor: color.slate,
    borderRadius: radius.badge,
    paddingHorizontal: 7,
    paddingVertical: 2,
  },
  live: { borderColor: 'rgba(221,245,74,0.55)', backgroundColor: 'rgba(221,245,74,0.10)' },
  final: { borderColor: color.textFaint },
  dot: { width: 7, height: 7, borderRadius: 4, backgroundColor: color.ball },
  tagText: { fontSize: 10.5, fontWeight: '800', letterSpacing: 0.9, textTransform: 'uppercase', color: color.textDim },
});
