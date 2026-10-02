/**
 * Does App Store Connect have an app record for our bundle id yet, and any builds?
 *
 * The App Store Connect API can register a bundle id but cannot create an app record
 * ("The resource 'apps' does not allow 'CREATE'"), so the very first record is made by a
 * person in the web UI. CI uses this to stop BEFORE a 20-minute archive that could only
 * fail at upload, and the watcher workflow uses it to start the first TestFlight build the
 * moment the record appears.
 *
 * Env: ASC_KEY_ID, ASC_ISSUER_ID, and ASC_KEY_P8 (the raw .p8 text) or ASC_KEY_PATH.
 * Prints GitHub-output lines: exists=true|false, app_id=..., builds=N
 *   node scripts/asc-app.mjs [bundleId]
 */
import { readFileSync } from 'node:fs';
import { createPrivateKey, sign } from 'node:crypto';

const BUNDLE = process.argv[2] || 'com.genevatennis.app';
const { ASC_KEY_ID, ASC_ISSUER_ID } = process.env;
const pem = process.env.ASC_KEY_P8 || (process.env.ASC_KEY_PATH ? readFileSync(process.env.ASC_KEY_PATH, 'utf8') : '');
if (!ASC_KEY_ID || !ASC_ISSUER_ID || !pem) {
  console.error('asc-app: ASC_KEY_ID, ASC_ISSUER_ID and ASC_KEY_P8 (or ASC_KEY_PATH) are required');
  process.exit(2);
}
const key = createPrivateKey(pem);
const b64u = (b) => Buffer.from(b).toString('base64url');
function jwt() {
  const now = Math.floor(Date.now() / 1000);
  const head = b64u(JSON.stringify({ alg: 'ES256', kid: ASC_KEY_ID, typ: 'JWT' }));
  const body = b64u(JSON.stringify({ iss: ASC_ISSUER_ID, iat: now, exp: now + 600, aud: 'appstoreconnect-v1' }));
  return `${head}.${body}.${b64u(sign('sha256', Buffer.from(`${head}.${body}`), { key, dsaEncoding: 'ieee-p1363' }))}`;
}
async function get(path) {
  const r = await fetch('https://api.appstoreconnect.apple.com' + path, { headers: { authorization: 'Bearer ' + jwt() } });
  if (!r.ok) throw new Error(`${path} -> HTTP ${r.status}: ${(await r.text()).slice(0, 300)}`);
  return r.json();
}

const apps = await get(`/v1/apps?filter[bundleId]=${encodeURIComponent(BUNDLE)}&fields[apps]=name,bundleId`);
const app = (apps.data || []).find((a) => a.attributes.bundleId === BUNDLE);
if (!app) {
  console.log('exists=false');
  console.log('builds=0');
  process.exit(0);
}
const builds = await get(`/v1/builds?filter[app]=${app.id}&limit=1&fields[builds]=version`);
console.log('exists=true');
console.log(`app_id=${app.id}`);
console.log(`builds=${(builds.data || []).length}`);
