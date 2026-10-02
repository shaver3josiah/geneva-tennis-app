/**
 * Set the team's coach code on the real Firebase project.
 *
 *   npm run set-coach-code -- "<the code>"
 *   npm run set-coach-code -- --dry "<the code>"     print what would be written, send nothing
 *
 * WHAT THE CODE IS FOR. A coach is whoever has a /coaches/{uid} document, and the only way
 * to write one is to present this code (firebase/firestore.rules, "Coaches"). Hand it to the
 * head coach and the assistant by hand; they type it on the "Nearly there" screen after they
 * sign up. Nothing in the app bundle holds it.
 *
 * WHAT GETS STORED. Only its SHA-256, as lowercase hex, in config/coachCode {sha256}. The
 * rules hash what a claimant sends and compare it with that field, and no client can read
 * the document, so the code cannot be recovered from the database. It CAN be guessed: a
 * rules-evaluated guess has no rate limit, so make it long and random (a password manager's
 * 20 characters, not a team slogan). Run this again to rotate it; coaches already claimed
 * keep their role.
 *
 * HOW IT TALKS TO FIRESTORE. Writes to config/ are denied to every client, on purpose, so
 * this uses an admin credential: the access token firebase-tools already holds for you.
 * `firebase login` stores a refresh token in ~/.config/configstore/firebase-tools.json; this
 * exchanges it for a short-lived access token and PATCHes the document over the REST API.
 * No new dependency, no service-account key to download or leak.
 *
 * The client id and secret below are firebase-tools' own. They are the "installed app"
 * credentials Google publishes inside that CLI and are not secret; they only identify the
 * tool, and the refresh token is what proves who you are.
 *
 * The project is the one in .env (EXPO_PUBLIC_FIREBASE_PROJECT_ID). The local emulator needs
 * none of this: `npm run seed` writes the demo code, GENEVA-DEMO, straight into it.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const CLIENT_ID = '563584335869-fgrhgmd47bqnekij5i8b5pr03ho849e6.apps.googleusercontent.com';
const CLIENT_SECRET = 'j9iVZfS8kkCEFUPaAeJV0sAi';

/** The rules compare against lowercase hex, so this must be lowercase hex. */
export const sha256Hex = (code) => createHash('sha256').update(code, 'utf8').digest('hex');

/** Where firebase-tools keeps its login. configstore honours XDG_CONFIG_HOME, else ~/.config
 *  (which on Windows is %USERPROFILE%\.config). */
export const storePath = () =>
  join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'configstore', 'firebase-tools.json');

/** EXPO_PUBLIC_FIREBASE_PROJECT_ID from the environment, else from .env. */
export function readProjectId(envFile = join(ROOT, '.env')) {
  if (process.env.EXPO_PUBLIC_FIREBASE_PROJECT_ID) return process.env.EXPO_PUBLIC_FIREBASE_PROJECT_ID.trim();
  if (!existsSync(envFile)) return '';
  return readFileSync(envFile, 'utf8').match(/^EXPO_PUBLIC_FIREBASE_PROJECT_ID=(.*)$/m)?.[1]?.trim() ?? '';
}

export const docUrl = (project) =>
  `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(project)}` +
  '/databases/(default)/documents/config/coachCode';

/** Trade firebase-tools' stored refresh token for a short-lived access token. */
async function accessToken() {
  const file = storePath();
  if (!existsSync(file)) {
    throw new Error(`${file} not found. Run \`npx firebase login\` first, as an owner of the project.`);
  }
  const refresh = JSON.parse(readFileSync(file, 'utf8'))?.tokens?.refresh_token;
  if (!refresh) throw new Error(`No refresh token in ${file}. Run \`npx firebase login\` again.`);

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refresh,
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.access_token) {
    throw new Error(
      `Google would not refresh the login (${res.status} ${body.error ?? ''}). ` +
        'Run `npx firebase login --reauth` and try again.'
    );
  }
  return body.access_token;
}

async function main() {
  const args = process.argv.slice(2);
  const dry = args.includes('--dry');
  // Same normalisation as claimCoach in src/data.ts: no spaces, capitals. A coach then gets
  // in however they type it.
  const code = args.filter((a) => a !== '--dry').join('').replace(/\s+/g, '').toUpperCase();

  if (!code) {
    console.error('usage: npm run set-coach-code -- [--dry] "<the code>"');
    process.exit(2);
  }
  const project = readProjectId();
  if (!project) {
    console.error('EXPO_PUBLIC_FIREBASE_PROJECT_ID is not set in .env. Copy .env.example to .env first.');
    process.exit(2);
  }
  if (code.length < 12) {
    console.error(
      `warning: that code is ${code.length} characters. Anyone with a verified email can guess at it ` +
        'without limit, so 12 is a floor and 20 random characters is the point.'
    );
  }

  const sha256 = sha256Hex(code);
  console.log(`project  ${project}`);
  console.log(`document coachKeys/${sha256.slice(0, 8)}…`);
  console.log(`sha256   ${sha256.slice(0, 8)}… (the code itself is never sent or stored)`);
  if (dry) {
    console.log('\n--dry: nothing was sent.');
    return;
  }

  const token = await accessToken();
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  const base = `https://firestore.googleapis.com/v1/projects/${project}/databases/(default)/documents/coachKeys`;

  // The new key: a document NAMED by the digest. The rules only check that it exists.
  const put = await fetch(`${base}/${sha256}`, {
    method: 'PATCH',
    headers,
    body: JSON.stringify({ fields: { createdAt: { timestampValue: new Date().toISOString() } } }),
  });
  if (!put.ok) {
    throw new Error(
      `Firestore refused the write (${put.status}): ${(await put.text()).slice(0, 300)}\n` +
        'Is the Firestore database created, and is the logged-in account an owner of the project?'
    );
  }
  // Rotation: every OTHER key stops working. Coaches who already claimed keep the role.
  const list = await fetch(`${base}?pageSize=100`, { headers }).then((r) => r.json()).catch(() => ({}));
  for (const d of list.documents ?? []) {
    const id = d.name.split('/').pop();
    if (id !== sha256) await fetch(`${base}/${id}`, { method: 'DELETE', headers });
  }
  const back = await fetch(`${base}/${sha256}`, { headers });
  if (!back.ok) throw new Error('Wrote the key but could not read it back.');
  console.log('\nset. Coaches can now claim the role with that code on the "Nearly there" screen.');
}

// Importing this file (the tests do) must not run it.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(`set-coach-code: ${e.message}`);
    process.exit(1);
  });
}
