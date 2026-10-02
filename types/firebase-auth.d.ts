/**
 * `getReactNativePersistence` exists at runtime but not in the published types.
 *
 * `@firebase/auth`'s exports map lists "types" before the "react-native" condition, so
 * TypeScript resolves `auth-public.d.ts` — the web build's declarations — no matter what
 * `customConditions` says. That file declares `ReactNativeAsyncStorage` but not the
 * function that consumes it, so the correct call fails to compile with TS2305.
 * Open upstream since 2023: firebase-js-sdk#7584, #7615, #8332, #9316.
 *
 * This augments the module with the signature from the real React Native build
 * (`dist/rn/index.rn.d.ts`), so the call is fully typed rather than silenced with a
 * `@ts-ignore` that would also hide a genuine mistake at the call site.
 *
 * Delete this file the day the SDK ships the declaration.
 */
import type { Persistence, ReactNativeAsyncStorage } from 'firebase/auth';

declare module 'firebase/auth' {
  export function getReactNativePersistence(storage: ReactNativeAsyncStorage): Persistence;
}
