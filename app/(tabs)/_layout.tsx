import { Redirect } from 'expo-router';
import { Tabs } from 'expo-router/js-tabs';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useEffect, useState } from 'react';
import { StyleSheet } from 'react-native';
import { useSession } from '../../src/session';
import { subscribeThreads } from '../../src/data';
import { color, semantic } from '../../src/theme';
import { Loading } from '../../src/ui';
import { Pending } from '../../src/Pending';
import { RewardsIntro } from '../../src/RewardsIntro';
import { readState } from '../../src/rewards';

/** Unread is approximated by "threads you can see" until read receipts exist.
 *  ponytail: a real per-thread lastRead pointer is a schema change and a rules change.
 *  Add it when someone complains the badge is wrong, not before. */
function useThreadCount() {
  const { user } = useSession();
  const [n, setN] = useState(0);
  useEffect(() => {
    if (!user) return;
    return subscribeThreads(user.uid, (t) => setN(t.length));
  }, [user?.uid]);
  return n;
}

export default function TabsLayout() {
  const { user, ready, needsVerification, notInvited, role, prefs } = useSession();
  const threads = useThreadCount();

  if (!ready) return <Loading />;
  if (!user) return <Redirect href="/sign-in" />;
  // Signed in, but nothing will resolve: the address is unconfirmed, or the coach has
  // not invited it. Showing empty tabs here reads as a broken app.
  if (needsVerification || notInvited) return <Pending />;

  return (
    <>
    {/* Once per device, and never for the coach: the streak is the player's. */}
    {role !== 'coach' && <RewardsIntro state={readState(prefs)} />}
    <Tabs
      screenOptions={{
        headerStyle: { backgroundColor: semantic.surfaceBand },
        headerTintColor: color.chalk,
        headerTitleStyle: { color: color.chalk, fontWeight: '800' },
        headerShadowVisible: false,
        sceneStyle: { backgroundColor: semantic.surfacePage },
        tabBarStyle: {
          backgroundColor: semantic.surfaceBand,
          borderTopColor: semantic.border,
          borderTopWidth: StyleSheet.hairlineWidth,
        },
        // goldHot (10.4:1 on the tab bar) rather than the canonical gold (6.6:1): both
        // pass AA, but the brighter step is what reads as "selected" at label size.
        tabBarActiveTintColor: color.goldHot,
        // textMute measured 4.04 on the tab bar. textFaint is 4.85 and is the next
        // token up, so the inactive label clears AA without going near the active gold.
        tabBarInactiveTintColor: color.textFaint,
        tabBarLabelStyle: { fontSize: 10.5, fontWeight: '700', letterSpacing: 0.8 },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: 'Messages',
          tabBarIcon: ({ color: c, size }) => <Ionicons name="chatbubble-outline" size={size} color={c} />,
          tabBarBadge: threads > 0 ? threads : undefined,
          // night on gold is 7.0:1; white on gold is 2.8:1 and fails.
          tabBarBadgeStyle: { backgroundColor: color.gold, color: color.night, fontSize: 10 },
        }}
      />
      <Tabs.Screen
        name="calendar"
        options={{
          title: 'Calendar',
          tabBarIcon: ({ color: c, size }) => <Ionicons name="calendar-outline" size={size} color={c} />,
        }}
      />
      <Tabs.Screen
        name="matches"
        options={{
          // Everyone's tab: a student charts from the fence, a parent follows live, and
          // the coach reads the sheet. The rules decide who reads, via /members.
          title: 'Matches',
          tabBarIcon: ({ color: c, size }) => <Ionicons name="tennisball-outline" size={size} color={c} />,
        }}
      />
      <Tabs.Screen
        name="builder"
        options={{
          title: 'Workout Builder',
          tabBarLabel: 'Workouts',
          tabBarIcon: ({ color: c, size }) => <Ionicons name="barbell-outline" size={size} color={c} />,
          // Only the coach has a workout library, and the rules say so too: a read of
          // /workoutTemplates from a family account is denied. href null removes the
          // tab without removing the route, so a stale deep link still resolves and
          // the screen itself redirects.
          href: role === 'coach' ? undefined : null,
        }}
      />
      <Tabs.Screen
        name="locker"
        options={{
          title: 'The Locker',
          tabBarLabel: 'Locker',
          tabBarIcon: ({ color: c, size }) => <Ionicons name="document-text-outline" size={size} color={c} />,
        }}
      />
      <Tabs.Screen
        name="you"
        options={{
          title: 'You',
          tabBarIcon: ({ color: c, size }) => <Ionicons name="person-outline" size={size} color={c} />,
        }}
      />
    </Tabs>
    </>
  );
}
