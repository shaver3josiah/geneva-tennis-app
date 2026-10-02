import { Platform } from 'react-native';
import * as Notifications from 'expo-notifications';
import { reminderPlan, type RewardState } from './rewards';

/**
 * Streak reminders. Local notifications only: the phone's own clock fires these, so
 * there is no push server, no device token, no FCM or APNs credential, and nothing
 * about an athlete leaves the phone to make one happen.
 *
 * WHY THEY ARE ACCURATE WITHOUT A SERVER. Every reminder is cancelled and re-planned
 * each time the app opens. Open it tomorrow and tomorrow evening's warning is thrown
 * away and replaced with the day after's, so the only way a notification ever fires is
 * that the athlete genuinely did not come back. The plan itself lives in rewards.ts,
 * which has no native imports and is checked by `npm run test:rewards`.
 */

// Shown even while the app is open. A streak warning that only appears when the app is
// closed would arrive at the one moment it is not needed.
//
// Guarded because this runs at import time, and src/session.tsx imports it on every
// screen: on web the handler has no native module behind it, and a throw here would
// take down `npm run web:coach`, which is how this app is looked at on this machine.
if (Platform.OS !== 'web') {
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: false,
      shouldSetBadge: false,
    }),
  });
}

const CHANNEL = 'streaks';

/** True if the phone will actually show these. Asks once; never nags after a refusal. */
async function allowed(): Promise<boolean> {
  const current = await Notifications.getPermissionsAsync();
  if (current.granted) return true;
  // canAskAgain is false once the athlete has said no. Asking anyway does nothing on
  // iOS and is a second dialog on Android, so treat a refusal as final.
  if (!current.canAskAgain) return false;
  const asked = await Notifications.requestPermissionsAsync();
  return asked.granted;
}

/**
 * Re-plan the reminders for this account. Safe to call on every open, and meant to be:
 * that is what keeps them from firing at someone who did come back.
 *
 * `on` is the athlete's own switch on the You tab. Off cancels everything rather than
 * silently keeping a queue the phone would fire later.
 */
export async function syncReminders(state: RewardState, on: boolean, now = new Date()): Promise<void> {
  if (Platform.OS === 'web') return; // web push needs a VAPID key and a service worker
  try {
    await Notifications.cancelAllScheduledNotificationsAsync();
    if (!on) return;
    if (!(await allowed())) return;

    if (Platform.OS === 'android') {
      // Android silently drops notifications posted to no channel.
      await Notifications.setNotificationChannelAsync(CHANNEL, {
        name: 'Training streaks',
        importance: Notifications.AndroidImportance.DEFAULT,
        vibrationPattern: [0, 200],
        lightColor: '#C99A2C',
      });
    }

    for (const r of reminderPlan(state, now)) {
      await Notifications.scheduleNotificationAsync({
        identifier: `streak-${r.kind}`,
        content: { title: r.title, body: r.body, sound: false },
        trigger: {
          type: Notifications.SchedulableTriggerInputTypes.DATE,
          date: r.at,
          ...(Platform.OS === 'android' ? { channelId: CHANNEL } : {}),
        },
      });
    }
  } catch (e) {
    // A phone that refuses to schedule is not a reason to break the app around it.
    console.warn('[gt] reminders not scheduled:', e);
  }
}
