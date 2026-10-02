/**
 * Runs the self-check in src/period.ts. Separate from the file itself so period.ts stays
 * a pure module — a bottom-of-file `process.argv` guard would run inside the app bundle.
 */
import { demo } from '../src/period.ts';
console.log(demo());
