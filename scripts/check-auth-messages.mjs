/**
 * Runs the self-check in src/authMessages.ts. Separate from the file itself so it stays
 * a pure module: a bottom-of-file `process.argv` guard would ship in the app bundle.
 */
import { demo } from '../src/authMessages.ts';
console.log(demo());
