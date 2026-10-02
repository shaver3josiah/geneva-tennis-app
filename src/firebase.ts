import { getApp, getApps, initializeApp } from 'firebase/app';
import {
  getAuth,
  initializeAuth,
  getReactNativePersistence,
  connectAuthEmulator,
  type Auth,
} from 'firebase/auth';
import { getFirestore, connectFirestoreEmulator, type Firestore } from 'firebase/firestore';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform } from 'react-native';

/**
 * One Firebase project serves both binaries. The iOS build and the Android .apk are
 * the same JavaScript talking to the same Firestore, so a message sent from an iPhone
 * shows up on an Android phone through a realtime listener with nothing platform-
 * specific in between. That is the whole "they talk to each other" story — there is no
 * second backend and no sync layer to go wrong.
 *
 * Config comes from EXPO_PUBLIC_* env vars, which Expo inlines at build time. These are
 * not secrets: a Firebase web config is public by design, and Firestore Security Rules
 * (firebase/firestore.rules) are what actually keep people out of each other's data.
 */
const firebaseConfig = {
  apiKey: process.env.EXPO_PUBLIC_FIREBASE_API_KEY,
  authDomain: process.env.EXPO_PUBLIC_FIREBASE_AUTH_DOMAIN,
  projectId: process.env.EXPO_PUBLIC_FIREBASE_PROJECT_ID,
  storageBucket: process.env.EXPO_PUBLIC_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.EXPO_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.EXPO_PUBLIC_FIREBASE_APP_ID,
};

const USE_EMULATOR = process.env.EXPO_PUBLIC_USE_EMULATOR === '1';

/**
 * Which backend this build talks to, so the UI can say so.
 *
 * `npm run seed` writes .env.local to point the app at the local emulator, and Expo
 * loads .env.local ahead of .env. Run the seed once on a machine with a real project
 * configured and every later launch silently targets an emulator — which, when it is
 * not running, surfaces only as "connection failed" with nothing naming the cause.
 */
export const backend = USE_EMULATOR
  ? ({ kind: 'emulator', label: 'local emulator' } as const)
  : ({ kind: 'cloud', label: firebaseConfig.projectId ?? 'unconfigured' } as const);

/**
 * What the UI calls the coach: "Coach Smith", "Coach". Display only. Who IS a coach is
 * decided by a /coaches/{uid} document that the rules check (see firebase/firestore.rules
 * and claimCoach in src/data.ts), never by anything in this bundle.
 */
export const COACH_NAME = process.env.EXPO_PUBLIC_COACH_NAME || 'Coach';

/**
 * The privacy policy the You tab links to. Both stores require one, so a release build
 * must set EXPO_PUBLIC_PRIVACY_URL to the real page; until it is set the link is simply
 * not drawn, rather than pointing at somebody else's policy.
 */
export const PRIVACY_URL = process.env.EXPO_PUBLIC_PRIVACY_URL || '';

export const isConfigured = Boolean(firebaseConfig.projectId) || USE_EMULATOR;

export const app = getApps().length
  ? getApp()
  : initializeApp({
      ...firebaseConfig,
      // The emulator ignores these but the SDK still requires them to be present.
      projectId: firebaseConfig.projectId ?? 'geneva-tennis-dev',
      apiKey: firebaseConfig.apiKey ?? 'emulator-placeholder-key',
    });

/**
 * Without an explicit persistence the user is signed out every cold start, and the SDK
 * only warns about it in a console message that is easy to miss.
 * initializeAuth throws `auth/already-initialized` if this module re-executes under Fast
 * Refresh, which getApps() does not guard against — hence the separate try/catch.
 */
let _auth: Auth;
try {
  _auth = initializeAuth(app, { persistence: getReactNativePersistence(AsyncStorage) });
} catch {
  _auth = getAuth(app);
}
export const auth = _auth;

/** getFirestore is sufficient on React Native: experimentalAutoDetectLongPolling has
 *  defaulted to true since v9.22, and the RN entry point already disables fetch streams. */
export const db: Firestore = getFirestore(app);

if (USE_EMULATOR) {
  // The Android emulator reaches the host machine at 10.0.2.2; 127.0.0.1 is the phone
  // itself. iOS simulator and web share the host's loopback. A physical device needs
  // the machine's LAN IP — set EXPO_PUBLIC_EMULATOR_HOST for that case.
  const host =
    process.env.EXPO_PUBLIC_EMULATOR_HOST ?? (Platform.OS === 'android' ? '10.0.2.2' : '127.0.0.1');
  connectAuthEmulator(auth, `http://${host}:9099`, { disableWarnings: true });
  connectFirestoreEmulator(db, host, 8080);
  console.warn(
    `[gt] Using the LOCAL EMULATOR at ${host} (EXPO_PUBLIC_USE_EMULATOR=1). ` +
      'Delete .env.local — or run `npm run use-cloud` — to talk to the real project.'
  );
}
