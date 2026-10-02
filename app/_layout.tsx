import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { KeyboardProvider } from 'react-native-keyboard-controller';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { SessionProvider } from '../src/session';
import { lockPortrait } from '../src/orientation';
import { useEffect } from 'react';
import { color, semantic } from '../src/theme';

export default function RootLayout() {
  // Portrait everywhere; the tracker screens unlock rotation for themselves (src/orientation.ts).
  useEffect(lockPortrait, []);
  return (
    // react-native-gesture-handler needs this at the root or every gesture below it
    // silently does nothing. The calendar drag is the only consumer today.
    <GestureHandlerRootView style={{ flex: 1 }}>
    {/* Every keyboard-aware component below reads the keyboard through this provider,
        and without it they render but never move. It replaces React Native's own
        KeyboardAvoidingView, which cannot work on this app: Android 15 and up force
        edge to edge, the window no longer resizes under the keyboard, and the built-in
        component has nothing left to measure. See src/ui.tsx KeyboardPad. */}
    <KeyboardProvider>
    <SafeAreaProvider>
      <SessionProvider>
        {/* Light glyphs: every screen sits on night, in both system themes. */}
        <StatusBar style="light" />
        <Stack
          screenOptions={{
            headerStyle: { backgroundColor: semantic.surfaceBand },
            headerTintColor: color.goldHot,
            headerTitleStyle: { color: color.chalk, fontWeight: '800' },
            headerShadowVisible: false,
            contentStyle: { backgroundColor: semantic.surfacePage },
          }}
        >
          <Stack.Screen name="index" options={{ headerShown: false }} />
          <Stack.Screen name="sign-in" options={{ headerShown: false }} />
          <Stack.Screen name="sign-up" options={{ headerShown: false }} />
          <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
          <Stack.Screen name="roster" options={{ title: 'Roster' }} />
          <Stack.Screen name="delete-account" options={{ title: 'Delete account' }} />
          <Stack.Screen name="schedule" options={{ title: 'Add to the calendar' }} />
          <Stack.Screen name="athlete" options={{ title: 'Player' }} />
          <Stack.Screen name="thread/[id]" options={{ title: 'Messages' }} />
          <Stack.Screen name="workflow/[id]" options={{ title: 'Workflow' }} />
          <Stack.Screen name="train/[id]" options={{ title: 'Session' }} />
          <Stack.Screen name="match/new" options={{ title: 'New match' }} />
          <Stack.Screen name="match/[id]" options={{ title: 'Match' }} />
          <Stack.Screen name="match/sheets" options={{ title: 'Google Sheets' }} />
          {/* Full screen from the first frame, and no edge swipe: the phone is being handled
              as it goes onto the fence, and a stray swipe would close the camera mid-match. */}
          <Stack.Screen name="match/track/[id]" options={{ headerShown: false, gestureEnabled: false }} />
        </Stack>
      </SessionProvider>
    </SafeAreaProvider>
    </KeyboardProvider>
    </GestureHandlerRootView>
  );
}
