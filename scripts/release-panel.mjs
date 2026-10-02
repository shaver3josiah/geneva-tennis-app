/**
 * A page on this machine for releasing the app, so nobody has to remember which
 * workflow to dispatch with which input, or paste a secret into a terminal.
 *
 *   npm run release:panel            (opens the browser)
 *   npm run release:panel -- --no-open --port=8930
 *
 * It shows which repository secrets exist and gives a box for each one that is
 * missing, runs the App Store listing push (a dry run first), tags a release, and
 * lists the recent release runs. Everything goes through the gh CLI you are already
 * signed into; the page holds no credential of its own.
 *
 * WHY IT IS LOCKED DOWN THE WAY IT IS. A server on localhost can be reached by any
 * web page open in the same browser, and this one can set repository secrets and
 * push tags. So it listens on 127.0.0.1 only, refuses any Host header but its own
 * (DNS rebinding), and every API call must carry a random token that only the page
 * it served knows, in a custom header, which a cross-origin page cannot send
 * without a preflight this server never answers.
 *
 * Secret VALUES go from the form straight to `gh secret set` on stdin. They are not
 * logged, not written to disk and never sent back to the page. A secret that is
 * already set cannot be replaced from here: overwriting REVIEW_PASSWORD, say, without
 * changing the account it belongs to is exactly how the demo login broke on Play.
 */
import http from 'node:http';
import { spawn } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { semverLess } from './appstore-metadata.mjs';

const REPO = 'shaver3josiah/geneva-tennis-app';
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PAGE = fileURLToPath(new URL('release-panel.html', import.meta.url));
const RELEASE_WORKFLOWS = ['iOS TestFlight', 'Android APK', 'App Store metadata'];

const filled = (v) => v.length > 0 || 'empty';

/**
 * Every secret a release reads, what it unlocks, and a check that catches the
 * usual wrong paste before GitHub stores it (a secret cannot be read back, so a bad
 * one otherwise surfaces twenty minutes into a build).
 */
export const SECRETS = {
  ASC_KEY_ID: { for: 'iOS builds and the App Store push', ok: (v) => /^[A-Z0-9]{10}$/.test(v) || 'ten capital letters and digits, from the AuthKey_XXXXXXXXXX.p8 filename' },
  ASC_ISSUER_ID: { for: 'iOS builds and the App Store push', ok: (v) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v) || 'the Issuer ID, a UUID printed above the key table in App Store Connect' },
  ASC_KEY_P8: { for: 'iOS builds and the App Store push', multiline: true, ok: (v) => /^-----BEGIN PRIVATE KEY-----[\s\S]+-----END PRIVATE KEY-----$/.test(v) || 'the raw text of the .p8 file, BEGIN to END lines included, not base64' },
  APPLE_TEAM_ID: { for: 'iOS builds', ok: (v) => /^[A-Z0-9]{10}$/.test(v) || 'the 10-character Team ID, top right of developer.apple.com/account' },
  REVIEW_EMAIL: { for: 'the demo login handed to App Review', ok: (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) || 'an email address' },
  REVIEW_PASSWORD: { for: 'the demo login handed to App Review', password: true, ok: (v) => v.length >= 8 || 'at least 8 characters' },
  ENV_FILE: { for: 'the Firebase config baked into both apps', multiline: true, ok: (v) => /^EXPO_PUBLIC_FIREBASE_PROJECT_ID=\S+/m.test(v) || 'the whole .env file, with EXPO_PUBLIC_FIREBASE_PROJECT_ID set' },
  ANDROID_KEYSTORE_BASE64: { for: 'signing Android builds', multiline: true, ok: (v) => (/^[A-Za-z0-9+/=\s]+$/.test(v) && v.length > 1000) || 'the .jks file, base64 encoded' },
  ANDROID_KEYSTORE_PASSWORD: { for: 'signing Android builds', password: true, ok: filled },
  ANDROID_KEY_ALIAS: { for: 'signing Android builds', ok: filled },
  ANDROID_KEY_PASSWORD: { for: 'signing Android builds', password: true, ok: filled },
  GOOGLE_PLAY_SERVICE_ACCOUNT_JSON: {
    for: 'a tag uploading to Google Play by itself (docs/SHIPPING.md 7.2)',
    multiline: true,
    ok: (v) => {
      let j;
      try { j = JSON.parse(v); } catch { return 'not JSON: paste the whole key file Google Cloud downloaded'; }
      // A bare && chain would return the private key itself as the "problem" text,
      // straight back to the page. Every check here returns true or a message.
      return (j.type === 'service_account' && !!j.client_email && !!j.private_key) ||
        'not a service account key: it needs "type": "service_account", client_email and private_key';
    },
  },
};

/** null when `value` may be stored as `name`, else what is wrong with it. */
export function checkSecret(name, value) {
  const s = Object.hasOwn(SECRETS, name) ? SECRETS[name] : null;
  if (!s) return `${name} is not a secret this panel sets`;
  if (typeof value !== 'string') return 'empty';
  const r = s.ok(value.trim());
  return r === true ? null : r;
}

/** Only this panel's own page, on its own host, may call the API. */
export function allowed(headers, port, token) {
  if (headers.host !== `127.0.0.1:${port}`) return false;
  const got = Buffer.from(String(headers['x-panel-token'] ?? ''));
  const want = Buffer.from(token);
  return got.length === want.length && timingSafeEqual(got, want);
}

/** The highest vX.Y.Z tag, without the v, or null. */
export function latestTag(names) {
  let best = null;
  for (const n of names) {
    const m = /^v(\d+\.\d+\.\d+)$/.exec(n.trim());
    if (m && (!best || semverLess(best, m[1]))) best = m[1];
  }
  return best;
}

/** GitHub's skip markers: a push whose head commit carries one starts no workflow. */
export const SKIP_MARKER = /\[(skip ci|ci skip|no ci|skip actions|actions skip)\]|skip-checks:\s*true/i;

export const nextPatch = (v) => (v ? v.replace(/\d+$/, (n) => String(Number(n) + 1)) : '1.0.0');

/**
 * What appstore-metadata.mjs printed, out of `gh run view --log`. Each line is
 * "<job>\t<step>\t<timestamp> <text>", and every step opens with the echoed script
 * and its env inside a ##[group]; the output is what follows the last ##[endgroup].
 */
export function extractOutput(log, steps = ['Push the listing', 'Read it back']) {
  const byStep = new Map();
  for (const line of log.split(/\r?\n/)) {
    const [, step, rest] = line.split('\t');
    if (rest === undefined || !steps.includes(step)) continue;
    if (!byStep.has(step)) byStep.set(step, []);
    byStep.get(step).push(rest.replace(/^\uFEFF?\S+Z ?/, ''));
  }
  const out = [];
  for (const step of steps) {
    const lines = byStep.get(step);
    if (!lines) continue;
    const end = lines.findLastIndex((l) => l.includes('##[endgroup]'));
    out.push(`== ${step}`, ...lines.slice(end + 1).filter((l) => l.trim()).map((l) => l.replace(/^##\[(error|warning)\]/, '$1: ')));
  }
  return out.join('\n');
}

// ---------------------------------------------------------------------------------

function run(cmd, args, input) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { cwd: ROOT, windowsHide: true });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(err.trim() || `${cmd} exited ${code}`))));
    p.stdin.end(input ?? '');
  });
}
const gh = (...args) => run('gh', args);
const ghJson = async (...args) => JSON.parse(await gh(...args));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function secretNames() {
  return new Set((await gh('secret', 'list', '--repo', REPO, '--json', 'name', '--jq', '.[].name')).split(/\r?\n/).filter(Boolean));
}

async function tagNames() {
  return (await gh('api', `repos/${REPO}/tags?per_page=100`, '--jq', '.[].name')).split(/\r?\n/).filter(Boolean);
}

async function status() {
  const [names, tags, runs] = await Promise.all([
    secretNames(),
    tagNames(),
    ghJson('run', 'list', '--repo', REPO, '-L', '40', '--json',
      'databaseId,workflowName,displayTitle,headBranch,event,status,conclusion,createdAt,url'),
  ]);
  const latest = latestTag(tags);
  return {
    repo: REPO,
    secrets: Object.entries(SECRETS).map(([name, s]) => ({
      name, for: s.for, set: names.has(name), multiline: !!s.multiline, password: !!s.password,
    })),
    latestTag: latest,
    nextVersion: nextPatch(latest),
    runs: runs.filter((r) => RELEASE_WORKFLOWS.includes(r.workflowName)).slice(0, 10),
  };
}

async function setSecret(name, value) {
  const problem = checkSecret(name, value);
  if (problem) throw new Error(`${name}: ${problem}`);
  if ((await secretNames()).has(name)) {
    throw new Error(`${name} is already set. This page only fills in missing secrets; replace one with gh secret set if you mean to.`);
  }
  await run('gh', ['secret', 'set', name, '--repo', REPO], value.trim());
  return { ok: true, name };
}

async function dispatchListing(dry) {
  const list = () => ghJson('run', 'list', '--repo', REPO, '-w', 'appstore-metadata.yml', '-L', '10',
    '--json', 'databaseId,url,event');
  const before = new Set((await list()).map((r) => r.databaseId));
  await gh('workflow', 'run', 'appstore-metadata.yml', '--repo', REPO, '--ref', 'main', '-f', `dry=${dry}`);
  for (let i = 0; i < 20; i++) {
    await sleep(2000);
    const fresh = (await list()).find((r) => !before.has(r.databaseId) && r.event === 'workflow_dispatch');
    if (fresh) return { id: fresh.databaseId, url: fresh.url, dry };
  }
  throw new Error('Dispatched, but the run did not show up within 40 seconds. Look in the Actions tab.');
}

async function runInfo(id) {
  if (!/^\d+$/.test(id ?? '')) throw new Error('bad run id');
  const r = await ghJson('run', 'view', id, '--repo', REPO, '--json', 'status,conclusion,url,workflowName,displayTitle');
  if (r.status === 'completed') r.output = extractOutput(await gh('run', 'view', id, '--repo', REPO, '--log').catch(() => ''));
  return r;
}

/**
 * Tag the tip of main and push the tag, which starts both release builds and, once
 * the iOS upload finishes, the listing push. Refuses a version that is not above
 * the latest tag (Apple and Play both refuse a lower one, twenty minutes later) and
 * a commit CI has not passed.
 */
async function tag(version) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('The version must look like 1.0.6.');
  const latest = latestTag(await tagNames());
  if (latest && !semverLess(latest, version)) throw new Error(`v${version} is not above the latest tag, v${latest}.`);
  await run('git', ['fetch', 'origin', 'main']);
  // The FULL ref. A bare "origin/main" resolves a local BRANCH of that name first (gh pr
  // checkout names branches after a PR's head ref), and git only warns about it.
  const sha = (await run('git', ['rev-parse', '--verify', 'refs/remotes/origin/main^{commit}'])).trim();
  // GitHub skips a tag push whose commit message carries a skip marker, so the tag
  // would be spent and nothing would build. Checked BEFORE CI: such a commit never gets
  // a CI run either, and "wait for green" would send the owner waiting for nothing.
  if (SKIP_MARKER.test(await run('git', ['log', '-1', '--format=%B', sha]))) {
    throw new Error(`The tip of main (${sha.slice(0, 7)}) carries a skip marker in its message, so a tag on it would start no build. Push any commit to main first.`);
  }
  const problem = await notGreen(sha);
  if (problem) throw new Error(`CI has not passed on main (${sha.slice(0, 7)}: ${problem}). Tag once it is green.`);
  await run('git', ['push', 'origin', `${sha}:refs/tags/v${version}`]);
  return { ok: true, tag: `v${version}`, sha };
}

/**
 * Why `sha` does not count as green on main, or null. Only a PUSH run on main counts:
 * ci.yml also runs on pull_request, and a PR's run is on the PR's own, editable
 * workflow. The monthly TestFlight keep-alive commits a timestamp through GITHUB_TOKEN,
 * which starts no run, so a tip that differs from the last green commit only by that
 * file is taken as green rather than blocking every release until someone pushes again.
 */
async function notGreen(sha) {
  const ci = (...extra) => ghJson('run', 'list', '--repo', REPO, '-w', 'ci.yml', '--branch', 'main',
    '--event', 'push', ...extra, '-L', '1', '--json', 'status,conclusion,headSha');
  const [own] = await ci('--commit', sha);
  if (own) return own.conclusion === 'success' ? null : `${own.status} ${own.conclusion || ''}`.trim();
  const [green] = await ci('--status', 'success');
  if (!green) return 'no CI run yet';
  const changed = (await run('git', ['diff', '--name-only', green.headSha, sha])).split(/\r?\n/).filter(Boolean);
  return changed.length === 1 && changed[0] === '.github/last-keepalive.txt' ? null : 'no CI run yet';
}

async function readJson(req) {
  let size = 0;
  const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > 256 * 1024) throw new Error('request too large');
    chunks.push(c);
  }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
}

function serve({ open }) {
  const token = randomBytes(24).toString('hex');
  let port = 0;

  const server = http.createServer(async (req, res) => {
    const send = (code, body, type = 'application/json; charset=utf-8') => {
      res.writeHead(code, {
        'content-type': type,
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
        'x-frame-options': 'DENY',
        'referrer-policy': 'no-referrer',
      });
      res.end(type.startsWith('application/json') ? JSON.stringify(body) : body);
    };
    try {
      // Inside the try: a request target Node's parser accepts and URL rejects
      // ("GET http://a:b:c/") would otherwise be an unhandled rejection that exits the
      // panel, sent by anything on this machine, before any token is checked.
      const url = new URL(req.url, 'http://127.0.0.1');
      if (req.method === 'GET' && url.pathname === '/') {
        if (req.headers.host !== `127.0.0.1:${port}` || url.searchParams.get('t') !== token) {
          return send(403, 'Open the link the release panel printed in its terminal.', 'text/plain; charset=utf-8');
        }
        return send(200, readFileSync(PAGE, 'utf8').replace('__TOKEN__', token), 'text/html; charset=utf-8');
      }
      if (!allowed(req.headers, port, token)) return send(403, { error: 'forbidden' });

      const route = `${req.method} ${url.pathname}`;
      if (route === 'GET /api/status') return send(200, await status());
      if (route === 'GET /api/run') return send(200, await runInfo(url.searchParams.get('id')));
      if (req.method === 'POST') {
        const body = await readJson(req);
        if (route === 'POST /api/secret') return send(200, await setSecret(String(body.name), body.value));
        if (route === 'POST /api/listing') return send(200, await dispatchListing(body.dry !== false));
        if (route === 'POST /api/tag') return send(200, await tag(String(body.version ?? '')));
      }
      return send(404, { error: 'not found' });
    } catch (e) {
      return send(400, { error: e.message });
    }
  });

  const fixed = process.argv.find((a) => a.startsWith('--port='))?.slice(7) ?? process.env.PORT;
  server.listen(Number(fixed) || 0, '127.0.0.1', () => {
    port = server.address().port;
    const link = `http://127.0.0.1:${port}/?t=${token}`;
    console.log(`Release panel: ${link}\nCtrl+C stops it.`);
    if (open) {
      const [cmd, args] = process.platform === 'win32' ? ['explorer.exe', [link]]
        : process.platform === 'darwin' ? ['open', [link]] : ['xdg-open', [link]];
      spawn(cmd, args, { detached: true, stdio: 'ignore' }).on('error', () => {}).unref();
    }
  });
}

// An exact path match, not endsWith: check-release-panel.mjs also ends in
// "release-panel.mjs", and importing this from the check started a live server.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  serve({ open: !process.argv.includes('--no-open') });
}
