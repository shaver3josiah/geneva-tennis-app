/**
 * Uploads a signed .aab to Google Play and puts it on a track.
 *
 * WHY THIS AND NOT A MARKETPLACE ACTION. The credential this handles can publish to
 * the Play Store under the owner's name, and this repository is public, so the fewer
 * third parties that ever hold it the better. The Play Developer API is four plain
 * HTTP calls, so a marketplace action buys nothing here but a supply chain.
 *
 * WHY NOT `fastlane supply`, which the repo already carries for TestFlight. supply
 * needs Ruby on a job that is otherwise pure Node and Java, and it wraps these same
 * four calls. The iOS job keeps fastlane because `pilot` handles Apple's notarised
 * upload protocol, which is not four HTTP calls.
 *
 * THE EDIT IS A TRANSACTION AND IT LEAKS IF YOU LET IT. Play's model is: open an
 * edit, change things inside it, commit. An edit that is never committed and never
 * deleted stays open and blocks nothing, but it accumulates, and an abandoned one
 * holds the uploaded bundle in limbo where the console will not show it. So every
 * failure path deletes the edit before rethrowing.
 *
 * TRACKS. The default is `internal`, which is live within minutes and needs no
 * review. A first `production` release is refused by Play until the console side is
 * complete (Data Safety, content rating, target audience, app access), and no API
 * fills those in, so promoting is deliberately a human step in the console.
 *
 *   node scripts/play-upload.mjs --aab path/to/app.aab --track internal --name v1.0.5
 *
 * Credentials come from GOOGLE_PLAY_SERVICE_ACCOUNT_JSON, the whole JSON key verbatim.
 * `npm run test:play` runs the offline self-check in scripts/check-play.mjs.
 */
import { createSign } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';

export const PACKAGE = 'com.genevatennis.app';
const SCOPE = 'https://www.googleapis.com/auth/androidpublisher';
const API = 'https://androidpublisher.googleapis.com/androidpublisher/v3';
const UPLOAD = 'https://androidpublisher.googleapis.com/upload/androidpublisher/v3';

const b64u = (b) => Buffer.from(b).toString('base64url');

/**
 * Service-account JWT, exchanged for an access token. Google signs these RS256, where
 * Apple's App Store Connect uses ES256 — same shape, different algorithm, and using
 * the wrong one fails as "invalid_grant" with nothing pointing at the algorithm.
 */
export async function accessToken(key, fetchImpl = fetch, scope = SCOPE) {
  const now = Math.floor(Date.now() / 1000);
  const header = b64u(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64u(JSON.stringify({
    iss: key.client_email,
    scope,
    aud: key.token_uri || 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  }));
  const signer = createSign('RSA-SHA256');
  signer.update(`${header}.${claims}`);
  const jwt = `${header}.${claims}.${b64u(signer.sign(key.private_key))}`;

  const res = await fetchImpl(key.token_uri || 'https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }).toString(),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`token exchange failed: ${res.status} ${JSON.stringify(body)}`);
  return body.access_token;
}

/**
 * One AAB onto one track. Returns the versionCode Play assigned it, which is read
 * back from the upload rather than from app.json, because the CI job stamps the
 * version code into the generated gradle file and this is the only honest witness
 * of what actually shipped.
 */
export async function publish({
  aab, track = 'internal', name, notes, status = 'completed',
  key, fetchImpl = fetch, log = console.log,
}) {
  const token = await accessToken(key, fetchImpl);
  const auth = { authorization: `Bearer ${token}` };

  const call = async (url, { method = 'GET', json, body, type } = {}) => {
    const res = await fetchImpl(url, {
      method,
      headers: { ...auth, ...(json ? { 'content-type': 'application/json' } : {}), ...(type ? { 'content-type': type } : {}) },
      body: json ? JSON.stringify(json) : body,
    });
    const text = await res.text();
    const parsed = text ? JSON.parse(text) : {};
    if (!res.ok) throw new Error(`${method} ${url} -> ${res.status} ${text.slice(0, 600)}`);
    return parsed;
  };

  const app = `${API}/applications/${PACKAGE}`;
  const { id: editId } = await call(`${app}/edits`, { method: 'POST', json: {} });
  log(`edit ${editId}`);

  try {
    const bytes = readFileSync(aab);
    log(`uploading ${(bytes.length / 1e6).toFixed(1)} MB`);
    const bundle = await call(
      `${UPLOAD}/applications/${PACKAGE}/edits/${editId}/bundles?uploadType=media`,
      { method: 'POST', body: bytes, type: 'application/octet-stream' },
    );
    const versionCode = bundle.versionCode;
    if (!versionCode) throw new Error(`upload returned no versionCode: ${JSON.stringify(bundle)}`);
    log(`versionCode ${versionCode}`);

    await call(`${app}/edits/${editId}/tracks/${track}`, {
      method: 'PUT',
      json: {
        track,
        releases: [{
          versionCodes: [String(versionCode)],
          status,
          ...(name ? { name } : {}),
          ...(notes ? { releaseNotes: [{ language: 'en-US', text: notes }] } : {}),
        }],
      },
    });

    // Once an app has had a change reviewed (Play rejected version code 18 on
    // 21 September 2026), Play refuses to send later changes for review on its own
    // and fails the commit with 400 "Changes cannot be sent for review
    // automatically". The edit is still open, so commit it again with the flag
    // Google names. The release is then saved but NOT sent: someone has to press
    // "Send changes for review" in the Play Console, so the log says so loudly.
    let sentForReview = true;
    try {
      await call(`${app}/edits/${editId}:commit`, { method: 'POST' });
    } catch (err) {
      if (!/changesNotSentForReview/.test(err.message)) throw err;
      await call(`${app}/edits/${editId}:commit?changesNotSentForReview=true`, { method: 'POST' });
      sentForReview = false;
      log('::warning title=Send it for review in the Play Console::Uploaded and saved, but Google would not send it for review automatically. Play Console, Publishing overview, Send changes for review.');
    }
    log(`committed to ${track}`);
    return { versionCode, editId, track, sentForReview };
  } catch (err) {
    // Leave no half-open edit behind. A failed delete must not mask the real error.
    await call(`${app}/edits/${editId}`, { method: 'DELETE' }).catch(() => {});
    throw err;
  }
}

const arg = (flag, fallback) => {
  const i = process.argv.indexOf(flag);
  return i === -1 ? fallback : process.argv[i + 1];
};

if (process.argv[1]?.endsWith('play-upload.mjs')) {
  const aab = arg('--aab');
  if (!aab) throw new Error('--aab <path> is required');
  statSync(aab); // fail here, not after a token exchange, if the path is wrong

  const raw = process.env.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error('GOOGLE_PLAY_SERVICE_ACCOUNT_JSON is not set. See docs/SHIPPING.md section 7.');
  const key = JSON.parse(raw);
  if (!key.client_email || !key.private_key) throw new Error('that JSON is not a service account key (no client_email/private_key)');

  const out = await publish({
    aab,
    track: arg('--track', 'internal'),
    name: arg('--name'),
    notes: arg('--notes'),
    status: arg('--status', 'completed'),
    key,
  });
  console.log(JSON.stringify(out));
}
