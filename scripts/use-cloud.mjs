/**
 * Point the app back at the real Firebase project.
 *
 * `npm run seed` writes .env.local so the demo talks to the local emulator, and Expo
 * loads .env.local ahead of .env. That file therefore outlives the emulator: run the
 * seed once, stop the emulator, and every later launch fails to connect with nothing
 * on screen naming the cause. Deleting one file is the whole fix, so it gets a command
 * rather than a paragraph in a runbook.
 */
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const LOCAL = join(ROOT, '.env.local');
const ENV = join(ROOT, '.env');

if (existsSync(LOCAL)) {
  unlinkSync(LOCAL);
  console.log('removed .env.local (the emulator override)');
} else {
  console.log('.env.local was not there — nothing to remove');
}

if (!existsSync(ENV)) {
  console.error('\n.env is MISSING, so there is no project to fall back to.');
  console.error('Copy .env.example to .env and fill in the Firebase config first.');
  process.exit(1);
}

const env = readFileSync(ENV, 'utf8');
const read = (k) => env.match(new RegExp(`^${k}=(.*)$`, 'm'))?.[1]?.trim() ?? '';
const project = read('EXPO_PUBLIC_FIREBASE_PROJECT_ID');
const coachName = read('EXPO_PUBLIC_COACH_NAME');

console.log(`\nthe app now uses: ${project || '(no project id set!)'}`);
console.log(`the coach is called: ${coachName || 'Coach (EXPO_PUBLIC_COACH_NAME is not set)'}`);
console.log('Coaches take the role in the app, with the team code: npm run set-coach-code');
if (!project) process.exitCode = 1;
console.log('\nRestart the dev server so the new values are bundled in.');
