import { Platform } from 'react-native';
import { createAudioPlayer, setAudioModeAsync, type AudioPlayer } from 'expo-audio';

/**
 * The celebration sounds. One short effect per celebration, matched to its name.
 *
 * The files are synthesized by `npm run sounds` (scripts/build-sounds.mjs) and bundled, so
 * there is no network fetch, no licence and no attribution to carry. Metro resolves .wav
 * through require() with no extra config.
 *
 * WHY PLAYERS ARE MODULE-LEVEL AND LAZY. `useAudioPlayer` would build a player per mount, and
 * Celebrate mounts on the You tab, the first-run sheet and the workout timer. These are 20 to
 * 60 KB clips that live for the life of the app, so one player per sound, created the first
 * time it is actually needed, is both cheaper and simpler than a release cycle per screen.
 *
 * TWO THINGS THAT WOULD BE HOSTILE AND ARE DELIBERATELY NOT DONE. The audio mode is
 * `mixWithOthers`, so finishing a workout does not stop the music the player is training to.
 * And `playsInSilentMode` is left at its default, so a phone on silent stays silent.
 */

const SOURCES: Record<string, number> = {
  spark: require('../assets/sfx/spark.wav'),
  // The celebrations are named for tennis now; the files keep the names they were
  // generated under (see scripts/build-sounds.mjs), so three keys differ from their files.
  ace: require('../assets/sfx/swish.wav'),
  onfire: require('../assets/sfx/fire.wav'),
  smash: require('../assets/sfx/quake.wav'),
  bolt: require('../assets/sfx/bolt.wav'),
  nova: require('../assets/sfx/nova.wav'),
};

const players: Record<string, AudioPlayer | undefined> = {};
let modeSet = false;

/** Play the effect for a celebration id. Unknown ids fall back to the free one. */
export function playSfx(id: string): void {
  // expo-audio has no native module on web, and a throw here would take down a celebration
  // that is otherwise purely visual.
  if (Platform.OS === 'web') return;
  try {
    if (!modeSet) {
      modeSet = true;
      setAudioModeAsync({ interruptionMode: 'mixWithOthers' }).catch(() => {});
    }
    const key = SOURCES[id] ? id : 'spark';
    let p = players[key];
    if (!p) {
      p = createAudioPlayer(SOURCES[key]);
      players[key] = p;
    }
    // Rewind first: tapping two celebrations in a row on the picker would otherwise play
    // the second one from wherever the first one stopped.
    p.seekTo(0);
    p.play();
  } catch {
    // A phone that will not give us an audio player is not a reason to skip the animation.
  }
}
