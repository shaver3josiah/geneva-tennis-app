import { useEffect, useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Celebrate, SPECS } from './Celebrate';
import { CELEBRATIONS, isUnlocked, readState, type RewardState } from './rewards';
import { Button } from './ui';
import { color, radius, semantic, type, type IconName } from './theme';

/**
 * Shown once, the first time a player or a guardian opens the app, to explain what
 * the streak is for before they have one.
 *
 * Every celebration is playable here, locked ones included. That is deliberate: a grid
 * of padlocks tells you nothing about what you are chasing, and the thing being sold is
 * the animation itself. Seeing Supernova go off is the reason to go and earn it.
 *
 * Seen-ness is per DEVICE (AsyncStorage), not per account, so it is not another key in
 * the preferences document and not another rule to widen. The cost of being wrong is
 * that a second phone shows the intro once, which is the right failure.
 */

const SEEN_KEY = 'gt_seen_rewards_intro';

const HOW: { icon: IconName; title: string; body: string }[] = [
  {
    icon: 'flame-outline',
    title: 'Come back tomorrow',
    body: 'Opening the app counts the day. Miss one and the run starts over, so the streak is the honest number.',
  },
  {
    icon: 'stopwatch-outline',
    title: 'Run the clock',
    body: 'Open a session on your calendar and work through it on the timer. Finishing one logs the workout.',
  },
  {
    icon: 'sparkles-outline',
    title: 'Unlock the celebrations',
    body: 'Workouts and streaks both unlock them. Pick the one that goes off every time you mark work done.',
  },
];

export function RewardsIntro({ state }: { state: RewardState }) {
  const insets = useSafeAreaInsets();
  const [open, setOpen] = useState(false);
  const [preview, setPreview] = useState({ id: 'spark', nonce: 0 });

  useEffect(() => {
    let cancelled = false;
    AsyncStorage.getItem(SEEN_KEY)
      .then((seen) => !cancelled && !seen && setOpen(true))
      // A storage that will not answer is not a reason to block the app; it just means
      // the intro waits for the next launch.
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  function close() {
    setOpen(false);
    AsyncStorage.setItem(SEEN_KEY, '1').catch(() => {});
  }

  if (!open) return null;

  return (
    <Modal visible animationType="slide" onRequestClose={close} statusBarTranslucent>
      <View style={[s.page, { paddingTop: insets.top + 18 }]}>
        <ScrollView contentContainerStyle={s.pad} showsVerticalScrollIndicator={false}>
          <Text style={s.h1}>The app keeps score of the work</Text>
          <Text style={s.lede}>
            Not of your matches. Of whether you showed up and put the reps in, which is the part
            nobody sees.
          </Text>

          {HOW.map((h) => (
            <View key={h.title} style={s.how}>
              <View style={s.howIcon}>
                <Ionicons name={h.icon} size={19} color={color.goldHot} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={s.howTitle}>{h.title}</Text>
                <Text style={s.howBody}>{h.body}</Text>
              </View>
            </View>
          ))}

          <Text style={s.eyebrow}>What you are playing for</Text>
          <Text style={s.howBody}>
            Tap any of them to watch it now, locked or not. Then go and earn the one you want.
          </Text>

          <View style={s.grid}>
            {CELEBRATIONS.map((c) => {
              const unlocked = isUnlocked(c, state);
              const need = [
                c.needWorkouts !== undefined ? `${c.needWorkouts} workouts` : '',
                c.needStreak !== undefined ? `${c.needStreak} day streak` : '',
              ]
                .filter(Boolean)
                .join(' or ');
              return (
                <Pressable
                  key={c.id}
                  accessibilityRole="button"
                  accessibilityLabel={`Play ${c.label}. ${unlocked ? 'Unlocked.' : `Unlocks at ${need}.`}`}
                  onPress={() => setPreview({ id: c.id, nonce: preview.nonce + 1 })}
                  style={({ pressed }) => [s.tile, pressed && { backgroundColor: color.inkHover }]}
                >
                  <View style={s.tileTop}>
                    <Text style={[s.tileWord, { color: SPECS[c.id]?.colors[0] ?? color.goldHot }]}>
                      {SPECS[c.id]?.word ?? c.label}
                    </Text>
                    <Ionicons
                      name={unlocked ? 'play-circle' : 'lock-closed'}
                      size={16}
                      color={unlocked ? color.goldHot : color.textFaint}
                    />
                  </View>
                  <Text style={s.tileName}>{c.label}</Text>
                  <Text style={s.tileNeed}>{unlocked ? 'Yours now' : need}</Text>
                </Pressable>
              );
            })}
          </View>
        </ScrollView>

        <View style={[s.foot, { paddingBottom: Math.max(insets.bottom, 14) }]}>
          <Button label="Got it" onPress={close} />
          <Text style={s.footNote}>You can change which one plays any time, on the You tab.</Text>
        </View>

        <Celebrate id={preview.id} nonce={preview.nonce} />
      </View>
    </Modal>
  );
}

/** Convenience for screens that hold prefs rather than a RewardState. */
export const introStateFrom = readState;

const s = StyleSheet.create({
  page: { flex: 1, backgroundColor: semantic.surfacePage },
  pad: { paddingHorizontal: 20, paddingBottom: 28 },

  h1: { fontSize: 27, fontWeight: '900', color: color.chalk, letterSpacing: -0.6, lineHeight: 31 },
  lede: { ...type.body, marginTop: 10, marginBottom: 22 },

  how: { flexDirection: 'row', gap: 13, marginBottom: 18 },
  howIcon: {
    width: 38,
    height: 38,
    borderRadius: 19,
    // Same treatment as the streak badge on the You tab: the gold tint measured 1.12
    // against night, so the disc was invisible and the outline did the work.
    backgroundColor: semantic.surfaceCard,
    borderWidth: 1,
    borderColor: semantic.borderStrong,
    alignItems: 'center',
    justifyContent: 'center',
  },
  howTitle: { fontSize: 15, fontWeight: '800', color: color.chalk, marginBottom: 3 },
  howBody: { fontSize: 13.5, lineHeight: 19, color: color.textBody },

  eyebrow: { ...type.eyebrow, marginTop: 10, marginBottom: 8 },

  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginTop: 14 },
  tile: {
    width: '47.5%',
    flexGrow: 1,
    minHeight: 84,
    backgroundColor: semantic.surfaceCard,
    borderWidth: 1,
    borderColor: semantic.borderStrong,
    borderRadius: radius.card,
    padding: 12,
    justifyContent: 'center',
  },
  tileTop: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  tileWord: { flex: 1, fontSize: 13, fontWeight: '900', letterSpacing: 0.6 },
  tileName: { fontSize: 14.5, fontWeight: '700', color: color.chalk, marginTop: 7 },
  tileNeed: { fontSize: 12, color: color.textDim, marginTop: 2 },

  foot: {
    paddingHorizontal: 20,
    paddingTop: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: semantic.border,
    backgroundColor: semantic.surfaceBand,
  },
  footNote: { ...type.meta, textAlign: 'center', marginTop: 10 },
});
