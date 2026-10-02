/**
 * Runs the self-check in src/rewards.ts. Separate from the file itself so rewards.ts
 * stays a pure module: a bottom-of-file `process.argv` guard would ship in the app bundle.
 */
import { demo } from '../src/rewards.ts';
console.log(demo());
