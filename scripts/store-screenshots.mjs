/**
 * Captures the store screenshots from the REAL app, and uploads the iPhone set to
 * App Store Connect.
 *
 * WHY THE WEB BUILD AND NOT A PHONE. There is no Mac and no Android emulator on the
 * machine this repo is developed on, and a screenshot taken by hand is a screenshot
 * nobody can take again the same way next release. This renders the same React
 * components, the same stylesheet and the same navigator that ship in the binary,
 * against the local Firebase emulator, at the exact pixel sizes each store demands.
 *
 * WHY THE EMULATOR AND NOT A REAL ACCOUNT. The screenshots of a messaging app used by
 * minors would otherwise be photographs of a real family's conversation. `npm run
 * seed` writes a coach, a parent, a player and a thread that exist nowhere else.
 *
 * WHAT THE PICTURES HAVE TO SHOW. A store listing for this app is a safety claim, so
 * the set leads with the monitoring banner and ends on the consent switch, which are
 * the two things a parent is deciding about.
 *
 * ---------------------------------------------------------------------------
 * RUNNING IT  (four terminals' worth of setup, in order)
 * ---------------------------------------------------------------------------
 *   npx --yes firebase-tools@13 emulators:start --project geneva-tennis-dev \
 *     --only auth,firestore --config firebase/firebase.json
 *   npm run seed
 *   echo EXPO_PUBLIC_FIREBASE_PROJECT_ID=geneva-tennis-dev >> .env.local
 *   npx expo start --web --port 8081
 *   npm run screenshots                   # writes store/screenshots/
 *   npm run screenshots -- --upload       # captures, then sends the iPhone set to Apple
 *   npm run screenshots -- --upload-only  # sends what is already on disk
 *
 * THE PROJECT ID LINE IS NOT OPTIONAL AND ITS ABSENCE IS SILENT. The emulator serves
 * whatever project id a client asks for, so an app still pointing at a real project's
 * id talks to an empty database inside the same emulator and the screen says only
 * "Nearly there".
 *
 * AFTERWARDS, so the app points at the real project again (the seed writes .env.local):
 *   npm run use-cloud
 */
import { spawn } from 'node:child_process';
import { createHash, createSign, createPrivateKey } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BASE = process.env.APP_URL || 'http://localhost:8081';
const OUT = process.env.OUT_DIR || join(process.cwd(), 'store', 'screenshots');
const UPLOAD = process.argv.includes('--upload') || process.argv.includes('--upload-only');
// Re-uploading after a listing change should not mean re-shooting the app, which
// needs the emulator, the seed and the web server all running again.
const SHOOT = !process.argv.includes('--upload-only');
const CHROME = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';

const DEMO = { email: 'parent@genevatennis.test', password: 'geneva123' };

/**
 * Apple takes one 6.9-inch set and scales it to every other iPhone, and `app.json`
 * has supportsTablet false, so there is no iPad set to make. Play wants a phone
 * screenshot whose long edge is at most twice its short edge, which 2868/1320 is not,
 * so the two stores genuinely need two captures rather than one resized.
 */
const DEVICES = {
  ios: { width: 440, height: 956, scale: 3 },      // -> 1320 x 2868
  android: { width: 360, height: 720, scale: 3 },  // -> 1080 x 2160
};

/** Each shot is a route plus whatever has to be true before it is taken. */
// EVERY TAB LABEL IS IN THE DOM ON EVERY SCREEN, so waiting for "Calendar" or "The
// Locker" is satisfied by the tab bar and proves nothing about what is on screen.
// Each wait below names something only its own screen renders.
const SHOTS = [
  { name: '01-messages', path: '/', wait: "'You see everything'" },
  { name: '02-conversation', path: '/thread/thread_coach_riley', wait: "'Riley'" },
  { name: '03-calendar', path: '/calendar', wait: "'Su'" },
  { name: '04-locker', path: '/locker', wait: "'TRAINING WORKFLOWS'" },
  { name: '05-consent', path: '/you', wait: "'Parent / Guardian'", before: 'grantConsent' },
];

// ---------------------------------------------------------------------------------
// A very small Chrome DevTools Protocol client. Node has a global WebSocket, so this
// needs no dependency at all.
// ---------------------------------------------------------------------------------

async function openChrome(port = 9200 + Math.floor(Math.random() * 700)) {
  const profile = mkdtempSync(join(tmpdir(), 'gt-shots-'));
  const proc = spawn(CHROME, [
    '--headless=new',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--disable-extensions',
    '--hide-scrollbars',
    // Ends the celebration animations and the intro on their first frame, so a
    // capture is never a blurred half-transition.
    '--force-prefers-reduced-motion',
    'about:blank',
  ], { stdio: 'ignore' });

  for (let i = 0; i < 80; i++) {
    try { if ((await fetch(`http://127.0.0.1:${port}/json/version`)).ok) break; } catch {}
    await sleep(250);
  }
  return { proc, port };
}

async function newPage(port) {
  const target = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

  let id = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    const p = msg.id && pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    msg.error ? p.rej(new Error(msg.error.message)) : p.res(msg.result);
  };
  const send = (method, params = {}) => new Promise((res, rej) => {
    const i = ++id;
    pending.set(i, { res, rej });
    ws.send(JSON.stringify({ id: i, method, params }));
  });

  await send('Page.enable');
  await send('Runtime.enable');

  const page = {
    close: () => ws.close(),
    async evaluate(body, label = 'script') {
      const r = await send('Runtime.evaluate', {
        expression: `(async () => { ${body} })()`, awaitPromise: true, returnByValue: true,
      });
      if (r.exceptionDetails) {
        throw new Error(`${label}: ${r.exceptionDetails.exception?.description ?? 'evaluate failed'}`);
      }
      return r.result.value;
    },
    async waitFor(expr, { timeout = 30000 } = {}) {
      const end = Date.now() + timeout;
      while (Date.now() < end) {
        try { if (await page.evaluate(`return (${expr});`)) return; } catch {}
        await sleep(200);
      }
      throw new Error(`timed out waiting for: ${expr}`);
    },
    async device({ width, height, scale }) {
      await send('Emulation.setDeviceMetricsOverride', {
        width, height, deviceScaleFactor: scale, mobile: true, screenWidth: width, screenHeight: height,
      });
    },
    async goto(url) { await send('Page.navigate', { url }); },
    async shot() {
      const { data } = await send('Page.captureScreenshot', { format: 'png' });
      return Buffer.from(data, 'base64');
    },
  };
  return page;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------------
// Driving the app
// ---------------------------------------------------------------------------------

/**
 * React Native Web renders a TextInput as a real <input>, but assigning `.value`
 * updates the DOM without telling React, so the form stays empty as far as the app is
 * concerned. Going through the prototype's setter and dispatching `input` is what
 * React's own synthetic event system listens for.
 */
const signIn = ({ email, password }) => `
  const set = (el, v) => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(el, v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  };
  const inputs = [...document.querySelectorAll('input')];
  const user = inputs.find(i => (i.placeholder || '').includes('@')) || inputs[0];
  const pass = inputs.find(i => i.type === 'password') || inputs[1];
  // Without this the setter is called on undefined and the browser answers
  // "Illegal invocation", which names nothing at all.
  if (!user || !pass) throw new Error('no sign-in form on screen');
  set(user, ${JSON.stringify(email)});
  set(pass, ${JSON.stringify(password)});
  await new Promise(r => setTimeout(r, 300));
  const btn = [...document.querySelectorAll('div[role=button],button')]
    .find(b => (b.innerText || '').trim().toLowerCase() === 'sign in');
  if (!btn) throw new Error('no sign in button');
  btn.click();
  return true;
`;

/**
 * The rewards explainer is shown once per device and covers the whole screen. Clicking
 * its button is unreliable to find, so the flag it writes is written first: the app's
 * AsyncStorage is plain localStorage on web. The click stays as a fallback for a
 * session that had already booted past the check.
 */
const DISMISS_INTRO = `
  try { window.localStorage.setItem('gt_seen_rewards_intro', '1'); } catch (e) {}
  const leaves = Array.prototype.slice.call(document.querySelectorAll('div,span'));
  for (const el of leaves) {
    if (el.children.length) continue;
    if ((el.textContent || '').trim().toLowerCase() !== 'got it') continue;
    let hit = el;
    for (let i = 0; i < 5 && hit; i++) {
      if (typeof hit.click === 'function' && (hit.getAttribute('role') === 'button' || hit.tagName === 'BUTTON')) break;
      hit = hit.parentElement;
    }
    if (hit && typeof hit.click === 'function') hit.click();
    else if (typeof el.click === 'function') el.click();
    break;
  }
  await new Promise(r => setTimeout(r, 900));
  return !document.body.innerText.includes('keeps score of the work');
`;

/**
 * The seed deliberately leaves consent OFF, because "nobody has ever granted it" is
 * the honest starting state. The last screenshot is the granted one, so it is granted
 * here through the real switch rather than by writing the field behind the app's back.
 */
const grantConsent = `
  const sw = [...document.querySelectorAll('[role=switch]')][0];
  if (sw && sw.getAttribute('aria-checked') !== 'true') sw.click();
  await new Promise(r => setTimeout(r, 1200));
  return sw ? sw.getAttribute('aria-checked') : 'no switch';
`;

/**
 * THE WEB BUILD HAS NO HOME INDICATOR, so react-native-safe-area-context reports a
 * bottom inset of zero and the tab bar sits flush against the viewport edge with its
 * labels clipped by a few pixels. A real iPhone reserves 34pt there and an Android
 * phone reserves its gesture bar, so padding it back is what makes the capture match
 * the binary rather than a liberty taken with it.
 */
const PAD_TAB_BAR = `
  const list = document.querySelector('[role=tablist]');
  const bar = list && list.parentElement;
  if (!bar) return 'no tab bar';       // a stack screen has none, which is fine
  bar.style.height = 'auto';           // the bar is a fixed 49px without this
  bar.style.paddingBottom = '26px';
  const label = [...document.querySelectorAll('[role=tab] div, [role=tab] span')]
    .filter(e => !e.children.length && e.textContent.trim()).pop();
  return label ? Math.round(innerHeight - label.getBoundingClientRect().bottom) : 'no label';
`;

/** expo-router on web keeps real URLs, so a pushState plus popstate is a navigation. */
const navigate = (path) =>
  `history.pushState({}, '', ${JSON.stringify(path)}); window.dispatchEvent(new PopStateEvent('popstate')); return true;`;

async function capture(page, device, dir) {
  mkdirSync(dir, { recursive: true });
  await page.device(device);

  // The session survives between the two device passes, so the second one lands
  // already signed in and there is no form to fill. Wait for EITHER, or the second
  // pass spends six minutes timing out on a form that will never appear.
  const SIGNED_IN = "document.body.innerText.includes('CONVERSATIONS') || document.querySelector('[role=tablist]')";
  for (let i = 0; i < 12; i++) {
    await page.goto(BASE);
    try {
      await page.waitFor(`document.querySelectorAll('input').length >= 2 || (${SIGNED_IN})`, { timeout: 30000 });
      break;
    } catch { /* a cold Metro bundles on demand, and Chrome's own error page has text */ }
  }

  // Set the flag before signing in, so the explainer never mounts in the first place.
  await page.evaluate(DISMISS_INTRO, 'dismiss intro (pre)');

  if (!(await page.evaluate(`return !!(${SIGNED_IN});`))) {
    await page.evaluate(signIn(DEMO), 'sign in');
    await page.waitFor(`${SIGNED_IN} || document.body.innerText.includes('keeps score')`, { timeout: 60000 });
  }
  await page.evaluate(DISMISS_INTRO, 'dismiss intro (post)');

  // Five identical pictures is what this failure looks like, and it looks like
  // success in every log. Refuse to capture behind the overlay.
  if (await page.evaluate("return document.body.innerText.includes('keeps score of the work');")) {
    throw new Error('the rewards explainer is still covering the screen');
  }

  for (const shot of SHOTS) {
    await page.evaluate(navigate(shot.path), `navigate ${shot.path}`);
    await sleep(900);
    if (shot.before === 'grantConsent') await page.evaluate(grantConsent, 'grant consent');
    if (shot.wait) await page.waitFor(`document.body.innerText.includes(${shot.wait})`, { timeout: 30000 });
    await page.evaluate(PAD_TAB_BAR, 'pad tab bar');
    await sleep(700); // let the reveal settle; reduced motion makes this short
    writeFileSync(join(dir, `${shot.name}.png`), await page.shot());
    console.log(`  ${shot.name}`);
  }
}

// ---------------------------------------------------------------------------------
// Uploading the iPhone set to App Store Connect
// ---------------------------------------------------------------------------------

const b64u = (b) => Buffer.from(b).toString('base64url');

function ascToken() {
  const need = (n) => { const v = process.env[n]; if (!v) throw new Error(`${n} is not set`); return v; };
  const pem = process.env.ASC_KEY_P8 ?? readFileSync(need('ASC_KEY_P8_PATH'), 'utf8');
  const now = Math.floor(Date.now() / 1000);
  const head = b64u(JSON.stringify({ alg: 'ES256', kid: need('ASC_KEY_ID'), typ: 'JWT' }));
  const body = b64u(JSON.stringify({ iss: need('ASC_ISSUER_ID'), iat: now, exp: now + 900, aud: 'appstoreconnect-v1' }));
  const s = createSign('SHA256');
  s.update(`${head}.${body}`);
  return `${head}.${body}.${b64u(s.sign({ key: createPrivateKey(pem), dsaEncoding: 'ieee-p1363' }))}`;
}

async function asc(path, { method = 'GET', body } = {}) {
  const res = await fetch(`https://api.appstoreconnect.apple.com/v1/${path}`, {
    method,
    headers: { authorization: `Bearer ${ascToken()}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}\n${JSON.stringify(json?.errors ?? json, null, 2)}`);
  return json;
}

/**
 * Apple takes an image in three steps: reserve it and be told where to PUT it, PUT
 * the bytes to that URL with the headers it named, then confirm with an md5 of what
 * was sent. Skipping the third step leaves a screenshot that exists and never appears.
 */
async function uploadScreenshots(dir) {
  const { data: [app] } = await asc('apps?filter[bundleId]=com.genevatennis.app');
  const { data: [version] } = await asc(
    `apps/${app.id}/appStoreVersions?filter[appStoreState]=PREPARE_FOR_SUBMISSION&limit=1`,
  );
  const { data: locs } = await asc(`appStoreVersions/${version.id}/appStoreVersionLocalizations`);
  const en = locs.find((l) => l.attributes.locale === 'en-US');

  const { data: sets } = await asc(`appStoreVersionLocalizations/${en.id}/appScreenshotSets`);
  let set = sets.find((s) => s.attributes.screenshotDisplayType === DISPLAY_TYPE);
  if (set) {
    // Replacing rather than appending: a rerun should not leave last run's pictures
    // interleaved with this one's in an order nobody chose.
    const { data: old } = await asc(`appScreenshotSets/${set.id}/appScreenshots`);
    for (const s of old) await asc(`appScreenshots/${s.id}`, { method: 'DELETE' });
  } else {
    ({ data: set } = await asc('appScreenshotSets', {
      method: 'POST',
      body: {
        data: {
          type: 'appScreenshotSets',
          attributes: { screenshotDisplayType: DISPLAY_TYPE },
          relationships: { appStoreVersionLocalization: { data: { type: 'appStoreVersionLocalizations', id: en.id } } },
        },
      },
    }));
  }

  for (const file of readdirSync(dir).filter((f) => f.endsWith('.png')).sort()) {
    const bytes = readFileSync(join(dir, file));
    const { data: shot } = await asc('appScreenshots', {
      method: 'POST',
      body: {
        data: {
          type: 'appScreenshots',
          attributes: { fileName: file, fileSize: bytes.length },
          relationships: { appScreenshotSet: { data: { type: 'appScreenshotSets', id: set.id } } },
        },
      },
    });

    for (const op of shot.attributes.uploadOperations) {
      const headers = Object.fromEntries(op.requestHeaders.map((h) => [h.name, h.value]));
      const part = bytes.subarray(op.offset, op.offset + op.length);
      const put = await fetch(op.url, { method: op.method, headers, body: part });
      if (!put.ok) throw new Error(`upload of ${file} failed: ${put.status}`);
    }

    await asc(`appScreenshots/${shot.id}`, {
      method: 'PATCH',
      body: {
        data: {
          type: 'appScreenshots',
          id: shot.id,
          attributes: { uploaded: true, sourceFileChecksum: createHash('md5').update(bytes).digest('hex') },
        },
      },
    });
    console.log(`  uploaded ${file}`);
  }
}

/** 1320 x 2868. Apple scales this one set down to every smaller iPhone. */
const DISPLAY_TYPE = process.env.ASC_DISPLAY_TYPE || 'APP_IPHONE_67';

// ---------------------------------------------------------------------------------

if (SHOOT) {
  const chrome = await openChrome();
  const page = await newPage(chrome.port);
  try {
    for (const [store, device] of Object.entries(DEVICES)) {
      console.log(`${store} (${device.width * device.scale} x ${device.height * device.scale}):`);
      await capture(page, device, join(OUT, store));
    }
  } finally {
    page.close();
    chrome.proc.kill();
  }
}

if (UPLOAD) {
  console.log('uploading the iPhone set:');
  await uploadScreenshots(join(OUT, 'ios'));
}
console.log(`\nwritten to ${OUT}`);
