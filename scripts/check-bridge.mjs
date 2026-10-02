/**
 * Runs the self-check in src/workflowBridge.ts. Separate from the file itself so the
 * module stays free of a process.argv guard that would ship in the app bundle.
 */
import { demo } from '../src/workflowBridge.ts';
console.log(demo());
