/**
 * Runs the self-check in src/schedule.ts. Separate from the file itself so schedule.ts
 * stays a pure module: a bottom-of-file `process.argv` guard would ship in the app bundle.
 */
import { demo } from '../src/schedule.ts';
console.log(demo());
