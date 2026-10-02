import { useEffect } from 'react';
import { Platform } from 'react-native';
import * as ScreenOrientation from 'expo-screen-orientation';

/**
 * The app is portrait, except where the phone is hung on the back fence sideways.
 *
 * app.json allows every orientation (so the OS will rotate at all), the root layout locks
 * portrait at launch, and the tracker screens call useAnyOrientation() to let the screen
 * follow the phone while they are open. Leaving them puts the lock back.
 */
export function lockPortrait() {
  if (Platform.OS === 'web') return;
  ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.PORTRAIT_UP).catch(() => {});
}

export function useAnyOrientation(enabled = true) {
  useEffect(() => {
    if (!enabled || Platform.OS === 'web') return;
    ScreenOrientation.unlockAsync().catch(() => {});
    return lockPortrait;
  }, [enabled]);
}
