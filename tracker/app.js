/* tracker/app.js — the page: setup, the analysis loop, charting, panels, sync, exports. */

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const IN_APP = !!window.ReactNativeWebView;
const W = 1280, H = 720;          // internal frame size for drawing and overlays
const DW = 640, DH = 360;          // detection size (the ball tracker reads a CPU copy at this size)
const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

const S = {
  mode: null, running: false, speed: 1,
  match: { id: 'local-' + Date.now().toString(36), title: 'Practice match', names: ['Geneva', 'Opponent'], formatId: 'college', format: null, firstServer: 0, nearAtStart: 0, date: today() },
  score: null, points: [], alerts: [], cur: null, pending: null,
  cam: null, calib: [], calibrating: false,
  sim: null, det: new BallDetector(), trk: new BallTracker(), pose: new PoseManager(), sm: [new LmSmoother(), new LmSmoother()],
  formBuf: [[], []], clips: new ClipStore(), lastLm: [null, null], lastShot: null, truthCmp: [],
  bounces: [], unsent: [], removed: [], lastSyncAt: 0, syncState: 'idle', sheets: { url: '', token: '' },
  autoConfirm: true, units: 'mph', fps: 0, frames: 0, fpsAt: 0, simAcc: 0, lastTs: 0, liveEv: null, dirty: true,
};
try { const saved = JSON.parse(localStorage.getItem('gt_sheets') || '{}'); S.sheets = { url: saved.url || '', token: saved.token || '' }; } catch {}

const view = $('view'), overlay = $('overlay'), video = $('video');
view.width = overlay.width = W; view.height = overlay.height = H;
// The frame canvas is CPU-backed on purpose: the ball detector reads it every frame, and a
// GPU canvas pays a full readback (~20 ms) per read. The overlay stays on the GPU.
const vctx = view.getContext('2d', { willReadFrequently: true }), octx = overlay.getContext('2d');
const det = document.createElement('canvas'); det.width = DW; det.height = DH;
const dctx = det.getContext('2d', { willReadFrequently: true });

function post(msg) { if (IN_APP) window.ReactNativeWebView.postMessage(JSON.stringify(msg)); }
function formatOf(id) { return (FORMATS.find((f) => f.id === id) || FORMATS[0]).format; }
function names() { return S.match.names; }

// ---------------------------------------------------------------------------- toasts
let toastTimer = 0;
function toast(t1, t2 = '', actions = [], ms = 3200) {
  $('toT1').textContent = t1; $('toT2').textContent = t2;
  const box = $('toActs'); box.innerHTML = '';
  for (const a of actions) { const b = document.createElement('button'); b.className = 'btn sm ' + (a.cls || ''); b.textContent = a.label; b.onclick = () => { a.run(); hideToast(); }; box.appendChild(b); }
  $('toast').classList.add('show'); clearTimeout(toastTimer);
  if (ms) toastTimer = setTimeout(hideToast, ms);
}
function hideToast() { $('toast').classList.remove('show'); }

// ---------------------------------------------------------------------------- setup
function startSheet() {
  const m = S.match, fm = FORMATS;
  const modes = [
    ['demo', 'Watch the demo match', 'A full simulated match through the fence camera: tracking, stats, trends and the coach sheet, live.', '<path d="M5 3l14 9-14 9V3z"/>'],
    ['camera', 'Track live', 'Phone on the back fence, 0.5x lens, landscape. Follows both players and the ball.', '<path d="M23 7l-7 5 7 5V7z"/><rect x="1" y="5" width="15" height="14" rx="2"/>'],
    ['video', 'Analyse a video', 'Load a match you filmed from behind the baseline.', '<rect x="2" y="2" width="20" height="20" rx="2.5"/><path d="M7 2v20M17 2v20M2 12h20"/>'],
    ['chart', 'Chart by hand', 'No camera. Tap who won each point and how. Same stats, same sheet.', '<path d="M3 3v18h18"/><path d="M7 15l4-4 3 3 5-6"/>'],
  ];
  $('startModal').innerHTML = `<div class="sheetm" role="dialog" aria-labelledby="stTitle">
    <div class="hero"><svg viewBox="0 0 64 64" aria-hidden="true"><use href="#gt-mark"/></svg><div><h1 id="stTitle">Match Tracker</h1><p>Geneva Tennis · ${esc(m.title)}</p></div></div>
    <div class="modes">${modes.map(([k, t, d, ic]) => `<button class="mode" data-mode="${k}" aria-pressed="${k === (IN_APP ? 'camera' : 'demo')}"><b><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">${ic}</svg>${t}</b><span>${d}</span></button>`).join('')}</div>
    <div class="two"><div class="field"><label for="nm0">Our player</label><input id="nm0" value="${esc(m.names[0])}" maxlength="40"></div><div class="field"><label for="nm1">Opponent</label><input id="nm1" value="${esc(m.names[1])}" maxlength="40"></div></div>
    <div class="two"><div class="field"><label for="fmt">Format</label><select id="fmt">${fm.map((f) => `<option value="${f.id}" ${f.id === m.formatId ? 'selected' : ''}>${esc(f.label)}</option>`).join('')}</select></div>
      <div class="field"><label>Serving first</label><div class="seg" id="segSrv"><button data-v="0" aria-pressed="${m.firstServer === 0}">${esc(m.names[0])}</button><button data-v="1" aria-pressed="${m.firstServer === 1}">${esc(m.names[1])}</button></div></div></div>
    <div class="two"><div class="field"><label>On the camera end first</label><div class="seg" id="segNear"><button data-v="0" aria-pressed="${m.nearAtStart === 0}">${esc(m.names[0])}</button><button data-v="1" aria-pressed="${m.nearAtStart === 1}">${esc(m.names[1])}</button></div></div>
      <div class="field"><label for="camSel">Camera</label><select id="camSel"><option value="">Widest back camera (0.5x)</option></select></div></div>
    <p class="note">Mount: back fence, arm's reach above head, about 3 m (10 ft) behind the baseline, landscape, 0.5x. Video never leaves the phone.</p>
    <div class="row2" style="margin-top:14px"><button class="btn gold wide" id="goBtn">Start</button></div>
  </div>`;
  $('startModal').hidden = false;
  let mode = IN_APP ? 'camera' : 'demo';
  $('startModal').querySelectorAll('.mode').forEach((b) => (b.onclick = () => { mode = b.dataset.mode; $('startModal').querySelectorAll('.mode').forEach((x) => x.setAttribute('aria-pressed', x === b)); }));
  for (const id of ['segSrv', 'segNear']) $(id).querySelectorAll('button').forEach((b) => (b.onclick = () => $(id).querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', x === b))));
  listCameras();
  $('goBtn').onclick = async () => {
    m.names = [$('nm0').value.trim() || 'Geneva', $('nm1').value.trim() || 'Opponent'];
    m.formatId = $('fmt').value; m.format = formatOf(m.formatId);
    m.firstServer = +$('segSrv').querySelector('[aria-pressed="true"]').dataset.v;
    m.nearAtStart = +$('segNear').querySelector('[aria-pressed="true"]').dataset.v;
    if (!IN_APP && m.title === 'Practice match') m.title = `${m.names[0]} vs ${m.names[1]}`;
    $('startModal').hidden = true;
    await begin(mode);
  };
}
async function listCameras() {
  try {
    const devs = (await navigator.mediaDevices?.enumerateDevices?.()) || [];
    const sel = $('camSel'); if (!sel) return;
    for (const d of devs.filter((d) => d.kind === 'videoinput')) sel.add(new Option(d.label || 'Camera', d.deviceId));
  } catch {}
}

async function begin(mode) {
  S.mode = mode; S.running = true;
  if (!S.score) S.score = MatchScore.replay(S.match.format, S.match.firstServer, S.points.map((p) => p.winner), S.match.nearAtStart);
  $('stage').dataset.src = mode;
  setChip('chipSrc', { demo: 'Demo match', camera: 'Live camera', video: 'Video', chart: 'Charting' }[mode], 'on');
  S.det.reset(); S.trk.reset(); newPoint();
  if (mode === 'demo') {
    S.cam = defaultCamera(W, H);
    S.sim = new DemoMatch({ seed: 11, firstServer: S.match.firstServer, nearAtStart: S.match.nearAtStart, format: S.match.format, names: S.match.names });
    S.sim.score = S.score;            // the demo plays on the tracker's own scoreboard
    S.autoConfirm = true;
    setChip('chipPose', 'Pose: simulated', 'on');
    toast('Demo match', 'Tracking runs on the rendered pixels. Tap Fast-forward to build up a match.', [], 4200);
  } else if (mode === 'camera') {
    S.autoConfirm = false;
    try { await startCamera(); } catch (e) { toast('Camera did not start', e.name === 'NotAllowedError' ? 'Allow camera access for this app in Settings.' : (e.message || String(e)), [], 7000); }
    loadPose();
    beginCalibration();
  } else if (mode === 'video') {
    S.autoConfirm = false;
    const inp = document.createElement('input'); inp.type = 'file'; inp.accept = 'video/*';
    inp.onchange = async () => { const f = inp.files[0]; if (!f) return; video.srcObject = null; video.src = URL.createObjectURL(f); video.loop = false; video.muted = true; await video.play().catch(() => {}); loadPose(); beginCalibration(); };
    inp.click();
  } else {
    S.autoConfirm = false; setChip('chipPose', 'Pose: off', ''); setChip('chipBall', 'Ball: off', '');
    vctx.fillStyle = '#0b0b0d'; vctx.fillRect(0, 0, W, H);
  }
  renderPad(); renderAll(); requestAnimationFrame(loop);
}

/**
 * The widest lens the platform will hand a web page.
 *  1. iOS 17+: the default back camera is the virtual dual-wide/triple device, which offers
 *     zoom down to 0.5. Apply the minimum and that IS the 0.5x ultra-wide.
 *  2. Otherwise, now that permission is granted the labels are readable: reopen on a device
 *     named ultra-wide (English labels; Samsung lists it as its own camera on some models).
 *  3. Otherwise keep the default and say so; the calibration has a service-line fallback for
 *     a 1x lens that cannot see the near corners.
 */
async function startCamera() {
  const sel = $('camSel')?.value;
  const v = { width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 60, max: 60 } };
  let stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { ...v, ...(sel ? { deviceId: { exact: sel } } : { facingMode: { ideal: 'environment' } }) } });
  let track = stream.getVideoTracks()[0], lens = 'default';
  if (!sel) {
    let z = null; try { z = track.getCapabilities?.().zoom; } catch {}
    if (z && z.min < 1) { try { await track.applyConstraints({ advanced: [{ zoom: z.min }] }); lens = 'zoom ' + z.min + 'x'; } catch {} }
    else {
      const cams = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput');
      const uw = cams.find((d) => /ultra.?wide|0[.,]5/i.test(d.label));
      if (uw && uw.deviceId !== track.getSettings().deviceId) {
        stream.getTracks().forEach((t) => t.stop());
        stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { ...v, deviceId: { exact: uw.deviceId } } });
        track = stream.getVideoTracks()[0]; lens = 'ultra-wide';
      }
    }
  } else lens = 'chosen';
  video.srcObject = stream; await video.play();
  setChip('chipSrc', lens === 'default' ? 'Live · 1x lens' : 'Live · wide lens', lens === 'default' ? 'warn' : 'on');
  if (lens === 'default') toast('Using the standard lens', 'This phone did not offer the 0.5x lens to the page. If the near corners are cut off, calibrate with the service line.', [], 6500);
  try { await navigator.wakeLock?.request?.('screen'); } catch {}
}
function loadPose() {
  setChip('chipPose', 'Pose: loading', 'warn');
  S.pose.load('full', (s) => setChip('chipPose', s.startsWith('Pose ready') ? 'Pose: 2 players' : 'Pose: loading', s.startsWith('Pose ready') ? 'on' : 'warn'))
    .catch((e) => { setChip('chipPose', 'Pose: offline', 'bad'); toast('Pose model unavailable', e.message || String(e), [], 6000); });
}

// ---------------------------------------------------------------------------- calibration
const CAL_SETS = {
  corners: { world: SINGLES_CORNERS, steps: ['near-left corner', 'near-right corner', 'far-right corner', 'far-left corner'], hint: 'where the baseline meets the singles sideline' },
  // A 1x lens (or an iOS WebView that will not hand over the 0.5x) cuts off the near
  // corners. The near service line's ends and the far corners lock the court just as well.
  service: { world: SERVICE_SET, steps: ['near service line, left end', 'near service line, right end', 'far-right corner', 'far-left corner'], hint: 'service line where it meets the singles sideline, then the far baseline corners' },
};
let calSet = 'corners';
function beginCalibration() {
  S.calibrating = true; S.calib = [];
  $('calib').hidden = false; calibCue();
  overlay.style.pointerEvents = 'auto';
}
function calibCue() {
  const k = S.calib.length;
  const set = CAL_SETS[calSet];
  $('caT1').textContent = `Tap the ${set.steps[k]}`;
  $('caT2').textContent = `Point ${k + 1} of 4 · ${set.hint}`;
  $('caSkip').textContent = k === 0 ? (calSet === 'corners' ? 'Near corners hidden?' : 'Use corners') : 'Use default';
}
overlay.addEventListener('pointerdown', (e) => {
  if (!S.calibrating) return;
  const r = overlay.getBoundingClientRect();
  // the canvas is letterboxed (object-fit: contain) — map the tap back into frame pixels
  const k = Math.min(r.width / W, r.height / H), ox = (r.width - W * k) / 2, oy = (r.height - H * k) / 2;
  const u = (e.clientX - r.left - ox) / k, v = (e.clientY - r.top - oy) / k;
  if (u < 0 || v < 0 || u > W || v > H) return;
  S.calib.push([u, v]);
  if (S.calib.length === 4) finishCalibration(); else calibCue();
});
$('caUndo').onclick = () => { S.calib.pop(); calibCue(); };
$('caSkip').onclick = () => {
  if (!S.calib.length) { calSet = calSet === 'corners' ? 'service' : 'corners'; calibCue(); return; }
  S.cam = defaultCamera(W, H); endCalib('Using the standard fence position. Tap the court later for better speeds.');
};
function finishCalibration() {
  const cam = calibrate(S.calib, W, H, 108, CAL_SETS[calSet].world);
  if (!cam || cam.calErr > 25) { S.calib = []; calibCue(); toast('That did not line up', 'Tap the four corners again, in order.', [], 4000); return; }
  S.cam = cam;
  const hfov = 2 * Math.atan(W / 2 / cam.f) / DEG;
  endCalib(`Court locked · ${hfov.toFixed(0)}° lens · camera ${cam.C[2].toFixed(1)} m high, ${(-cam.C[1]).toFixed(1)} m back`);
}
function endCalib(msg) { S.calibrating = false; $('calib').hidden = true; overlay.style.pointerEvents = 'none'; toast('Calibrated', msg, [], 4200); }

// ---------------------------------------------------------------------------- the point in progress
function newPoint() {
  S.cur = { serve1In: null, serveNo: 1, s1: null, s2: null, placement: null, shots: [], startT: null, lastHit: null, lastBounce: null, ended: false };
}
function confirmPoint(rec) {
  if (S.score.matchWinner !== null) return;
  const snap = S.score.snapshot();
  const n = S.score.history.length + 1;
  const full = { ...snap, n, at: Date.now(), ...rec };
  full.n = n; Object.assign(full, snap, { n });
  const res = S.score.pointWon(full.winner);
  S.points.push(full);
  for (const sh of full.shots || []) S.clips.keepShot(n, sh.i, sh.who, sh._tc ?? 0);
  for (const sh of full.shots || []) delete sh._tc;
  S.unsent.push(full);
  // trends: only the ones not raised yet
  const fresh = detectTrends(S.points, names(), S.alerts);
  for (const a of fresh) raiseAlert(a);
  const gameOver = res.gameWon !== null || res.matchWon !== null;
  if (S.unsent.length >= 3 || gameOver) flush(res.matchWon !== null);
  if (res.endsChange) toast('Change ends', `${names()[S.score.near]} is now on the camera end.`, [], 3000);
  if (res.matchWon !== null) toast('Match', `${names()[res.matchWon]} wins ${S.score.setsLabel()}`, [], 0);
  newPoint(); S.dirty = true; renderPad();
  save();
}
function undoPoint() {
  const p = S.points.pop(); if (!p) return;
  S.score.undo(); S.removed.push(p.n); S.unsent = S.unsent.filter((x) => x.n !== p.n);
  flush(false); newPoint(); S.dirty = true; renderPad(); save();
  toast('Point removed', `Point ${p.n} undone. Score ${S.score.setsLabel()} ${S.score.pointLabel()}`);
}

// ---------------------------------------------------------------------------- sync (every 3 points or game end)
function summaryLite() {
  const st = computeStats(S.points);
  return st.players.map((p) => ({ fsPct: pct(p.firstServeIn), winners: p.winners, ue: p.ue, aces: p.aces, dfs: p.dfs }));
}
function scoreLineNow() { return `${S.score.setsLabel()}${S.score.matchWinner === null ? ' ' + S.score.pointLabel() : ''}`.trim(); }
function flush(final) {
  if (!S.unsent.length && !S.removed.length && !final) return;
  const batch = { points: S.unsent.slice(), removed: S.removed.slice(), scoreLine: scoreLineNow(), final: !!final, summary: summaryLite() };
  S.unsent = []; S.removed = [];
  if (IN_APP) { post({ type: 'gt:points', ...batch }); S.lastSyncAt = Date.now(); setSync('on', `Synced · ${S.points.length} pts`); return; }
  S.lastSyncAt = Date.now();
  if (S.sheets.url) pushSheets().catch(() => {});
  else setSync('on', `Saved · ${S.points.length} pts`);
}
async function pushSheets() {
  setSync('warn', 'Sheet: sending');
  const body = { token: S.sheets.token, action: 'pushPoints', match: { id: S.match.id, title: S.match.title, sheetId: S.match.sheetId || null }, header: pointLogRows([], names())[0], rows: pointLogRows(S.points, names()).slice(1).map((r) => r.map(cellV)), summary: summaryRows(computeStats(S.points), names()).map((r) => r.map(cellV)) };
  try {
    const r = await fetch(S.sheets.url, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(body), redirect: 'follow' });
    const j = await r.json();
    if (!j.ok) throw new Error(j.error || 'connector refused');
    if (j.url) S.match.sheetUrl = j.url;
    setSync('on', `Sheet ✓ · ${S.points.length} pts`);
  } catch (e) { setSync('bad', 'Sheet: retrying'); console.warn('[gt] sheets push failed', e); }
}
const cellV = (c) => (c && typeof c === 'object' ? c.v : c ?? '');
function setSync(state, text) { S.syncState = state; setChip('chipSync', text, state); }
function save() { if (IN_APP) return; try { localStorage.setItem('gt_match_' + S.match.id, JSON.stringify({ match: S.match, points: S.points, alerts: S.alerts })); } catch {} }

// ---------------------------------------------------------------------------- alerts and clips
function raiseAlert(a) {
  S.alerts.push(a);
  post({ type: 'gt:alert', alert: a });
  const n = S.alerts.filter((x) => !x.seen).length;
  $('trendN').hidden = !n; $('trendN').textContent = n;
  let clip = null;
  if (a.shotRefs?.length) {
    clip = S.clips.build(a.shotRefs.slice(-5), a.title, a.who);
    if (clip) { a.clipId = 'c' + a.id.replace(/[^a-z0-9]/gi, '').slice(0, 30) + S.points.length; S.clipData = S.clipData || {}; S.clipData[a.clipId] = clip; post({ type: 'gt:clip', clip: { id: a.clipId, alertId: a.id, title: a.title, who: a.who, fps: clip.fps, frames: JSON.stringify(clip) } }); }
  }
  toast(a.title, a.cue, clip ? [{ label: 'Watch body shape', cls: 'gold', run: () => playClip(a.clipId) }] : [], 5200);
  S.dirty = true;
}
const BONES = [[11, 12], [11, 13], [13, 15], [12, 14], [14, 16], [11, 23], [12, 24], [23, 24]];
const LEGS = [[23, 25], [25, 27], [27, 31], [24, 26], [26, 28], [28, 32], [27, 29], [28, 30]];
function drawSkeleton(ctx, lm, w, h, col, legCol, lw = 3, ghost = false) {
  if (!lm) return;
  const P = (i) => [lm[i][0] * w, lm[i][1] * h], vis = (i) => (lm[i][2] ?? 1) > 0.3;
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  ctx.globalAlpha = ghost ? 0.25 : 1;
  for (const [a, b] of BONES) { if (!vis(a) || !vis(b)) continue; const A = P(a), B = P(b); ctx.strokeStyle = col; ctx.lineWidth = lw; ctx.beginPath(); ctx.moveTo(A[0], A[1]); ctx.lineTo(B[0], B[1]); ctx.stroke(); }
  for (const [a, b] of LEGS) { if (!vis(a) || !vis(b)) continue; const A = P(a), B = P(b); ctx.strokeStyle = legCol; ctx.lineWidth = lw * 1.7; ctx.beginPath(); ctx.moveTo(A[0], A[1]); ctx.lineTo(B[0], B[1]); ctx.stroke(); }
  const hd = P(0); ctx.fillStyle = col; ctx.beginPath(); ctx.arc(hd[0], hd[1], lw * 1.8, 0, Math.PI * 2); ctx.fill();
  for (const i of [25, 26, 27, 28]) { if (!vis(i)) continue; const q = P(i); ctx.fillStyle = '#0B0B0D'; ctx.strokeStyle = legCol; ctx.lineWidth = lw * 0.7; ctx.beginPath(); ctx.arc(q[0], q[1], lw * 1.25, 0, Math.PI * 2); ctx.fill(); ctx.stroke(); }
  ctx.globalAlpha = 1;
}
function playClip(id) {
  const clip = S.clipData?.[id]; if (!clip) return;
  const a = S.alerts.find((x) => x.clipId === id);
  const box = $('clipView');
  box.innerHTML = `<div class="clipbox" role="dialog" aria-label="Body shape clip"><h3>${esc(a?.title || 'Body shape')}</h3><canvas id="clipCv" width="720" height="560"></canvas>
    <p class="note" style="margin:8px 0">${esc(a?.detail || '')} Gold: arms and trunk. Optic yellow: legs. Faint figure: the first stroke in the set, for comparison.</p>
    <div class="row2"><button class="btn sm" id="clSlow">0.5x</button><button class="btn sm gold" id="clSave">Save video</button><button class="btn sm" id="clHtml">Save as page</button><button class="btn sm" id="clClose" style="margin-left:auto">Close</button></div></div>`;
  box.hidden = false;
  const cv = $('clipCv'), cx = cv.getContext('2d'); let k = 0, rate = 1, acc = 0, last = performance.now(), on = true;
  const ghost = clip.frames[Math.min(clip.frames.length - 1, Math.floor(clip.frames.length * 0.15))];
  const tick = (now) => { if (!on) return; acc += (now - last) / 1000 * clip.fps * rate; last = now; while (acc >= 1) { k = (k + 1) % clip.frames.length; acc -= 1; }
    cx.fillStyle = '#0d0d10'; cx.fillRect(0, 0, cv.width, cv.height);
    cx.strokeStyle = 'rgba(255,255,255,.06)'; for (let y = 40; y < cv.height; y += 40) { cx.beginPath(); cx.moveTo(0, y); cx.lineTo(cv.width, y); cx.stroke(); }
    const sx = cv.width, sy = cv.height;
    drawSkeleton(cx, ghost, sx, sy, '#DAAF48', '#DDF54A', 5, true);
    drawSkeleton(cx, clip.frames[k], sx, sy, '#DAAF48', '#DDF54A', 6);
    cx.fillStyle = '#9C9CA9'; cx.font = '600 15px Barlow Condensed, sans-serif'; cx.fillText(`${names()[clip.who] || ''} · frame ${k + 1}/${clip.frames.length}`, 14, 24);
    requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
  $('clSlow').onclick = () => { rate = rate === 1 ? 0.5 : 1; $('clSlow').textContent = rate === 1 ? '0.5x' : '1x'; };
  $('clClose').onclick = () => { on = false; box.hidden = true; };
  $('clHtml').onclick = () => download(`GenevaTennis_${(a?.title || 'clip').replace(/\W+/g, '_')}.html`, 'text/html', clipPage(clip, a));
  $('clSave').onclick = () => recordClip(cv, clip);
}
function recordClip(cv, clip) {
  if (!cv.captureStream || typeof MediaRecorder === 'undefined') { toast('Video save not supported here', 'Use "Save as page" instead.'); return; }
  const type = ['video/mp4', 'video/webm;codecs=vp9', 'video/webm'].find((t) => MediaRecorder.isTypeSupported?.(t)) || '';
  const rec = new MediaRecorder(cv.captureStream(30), type ? { mimeType: type } : undefined), chunks = [];
  rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  rec.onstop = () => { const blob = new Blob(chunks, { type: rec.mimeType }); const ext = rec.mimeType.includes('mp4') ? 'mp4' : 'webm'; blobOut(`GenevaTennis_body_shape.${ext}`, blob); };
  rec.start(); toast('Recording the clip', 'One full loop, then it saves.', [], 2500);
  setTimeout(() => rec.stop(), Math.min(15000, (clip.frames.length / clip.fps) * 1000 + 400));
}
function clipPage(clip, a) {
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(a?.title || 'Body shape')}</title><body style="margin:0;background:#0b0b0d;color:#f4f1ea;font:15px system-ui;display:grid;place-items:center;min-height:100vh"><div style="width:min(720px,96vw)"><h2 style="font-weight:700;letter-spacing:.04em">${esc(a?.title || 'Body shape')}</h2><p style="color:#9c9ca9">${esc(a?.detail || '')}</p><canvas id="c" width="720" height="560" style="width:100%;background:#0d0d10;border-radius:12px"></canvas><p style="color:#82828f;font-size:13px">Geneva Tennis Match Tracker · joint positions only, no video.</p></div><script>const C=${JSON.stringify(clip)};const B=${JSON.stringify(BONES)},L=${JSON.stringify(LEGS)};const c=document.getElementById('c'),x=c.getContext('2d');let k=0;function d(f,a,w){x.globalAlpha=a;x.lineCap='round';for(const[p,q]of B){x.strokeStyle='#DAAF48';x.lineWidth=w;x.beginPath();x.moveTo(f[p][0]*720,f[p][1]*560);x.lineTo(f[q][0]*720,f[q][1]*560);x.stroke()}for(const[p,q]of L){x.strokeStyle='#DDF54A';x.lineWidth=w*1.7;x.beginPath();x.moveTo(f[p][0]*720,f[p][1]*560);x.lineTo(f[q][0]*720,f[q][1]*560);x.stroke()}x.globalAlpha=1}setInterval(()=>{x.fillStyle='#0d0d10';x.fillRect(0,0,720,560);d(C.frames[Math.floor(C.frames.length*.15)],.25,5);d(C.frames[k],1,6);k=(k+1)%C.frames.length},1000/C.fps)<\/script>`;
}

// ---------------------------------------------------------------------------- files, email
function download(name, mime, text) { blobOut(name, new Blob([text], { type: mime })); }
function blobOut(name, blob) {
  if (window.GT_PREVIEW) {
    // The hosted demo cannot start a download itself; the viewer's downloads capability can,
    // after the viewer confirms. Without it, say so instead of a button that does nothing.
    if (S.dl) { S.dl.save({ filename: name, data: blob }).then(() => toast('Saved', name)).catch((e) => { if (e?.code !== 'declined') toast('Could not save that file here', e?.message || 'Use Copy for Google Sheets instead.'); }); return; }
    toast('Saving files is off in this view', 'Use Copy for Google Sheets instead: it works here.', [], 5200); return;
  }
  if (IN_APP) { const fr = new FileReader(); fr.onload = () => post({ type: 'gt:file', name, mime: blob.type, base64: String(fr.result).split(',')[1] }); fr.readAsDataURL(blob); return; }
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1500);
}
function meta() { return { title: S.match.title, date: S.match.date, names: names(), formatLabel: (FORMATS.find((f) => f.id === S.match.formatId) || {}).label, chartedBy: 'Geneva Tennis Match Tracker' }; }
function exportXlsx() { const bytes = buildXlsx(matchWorkbook(meta(), S.points, S.alerts)); blobOut(matchFileName(meta(), 'xlsx'), new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })); }
function exportCsv() { download(matchFileName(meta(), 'csv'), 'text/csv', toCSV(pointLogRows(S.points, names()))); }
async function copyTsv() {
  const tsv = toTSV(pointLogRows(S.points, names()));
  try { await navigator.clipboard.writeText(tsv); toast('Copied for Google Sheets', 'Paste into cell A1 of any sheet. Columns land cleanly.'); }
  catch { download('points.txt', 'text/plain', tsv); }
}
function emailStats() {
  const st = computeStats(S.points), rows = summaryRows(st, names());
  const text = `${S.match.title} — ${S.match.date}\nScore: ${scoreLineNow()}\n\n` + rows.map((r) => r.map(cellV).join('  |  ')).join('\n') + `\n\nSent from the Geneva Tennis Match Tracker.`;
  if (IN_APP) { const bytes = buildXlsx(matchWorkbook(meta(), S.points, S.alerts)); post({ type: 'gt:email', subject: `${S.match.title} — stats`, body: text, name: matchFileName(meta(), 'xlsx'), mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', base64: bytesToBase64(bytes) }); return; }
  exportXlsx();
  location.href = `mailto:?subject=${encodeURIComponent(S.match.title + ' — stats')}&body=${encodeURIComponent(text.slice(0, 1800) + '\n\n(The Excel file just downloaded: attach it.)')}`;
}

// ---------------------------------------------------------------------------- the loop
function loop(ts) {
  if (!S.running) return;
  const dtReal = S.lastTs ? Math.min(0.1, (ts - S.lastTs) / 1000) : 1 / 60; S.lastTs = ts;
  S.frames++; if (ts - S.fpsAt > 1000) { S.fps = Math.round((S.frames * 1000) / (ts - S.fpsAt)); S.frames = 0; S.fpsAt = ts; $('chipFps').firstElementChild.textContent = `${S.fps} fps`; }
  if (S.mode === 'demo') demoTick(dtReal);
  else if (S.mode === 'camera' || S.mode === 'video') liveTick(ts);
  drawOverlay();
  if (S.dirty) { S.dirty = false; renderAll(); }
  requestAnimationFrame(loop);
}

// ---- demo: the simulation, the renderer, then the SAME detector the camera uses
function demoTick(dtReal) {
  const sim = S.sim, step = 1 / 60;
  S.simAcc += dtReal * S.speed;
  let n = 0;
  // Stepping the simulation is cheap; rendering and detecting are not, so they happen once
  // per displayed frame however many simulation steps that frame covered.
  while (S.simAcc >= step && n < 16) { S.simAcc -= step; n++; for (const e of sim.step(step)) onSimEvent(e); }
  const bodies = renderDemo(vctx, S.cam, sim);
  S.detTick = (S.detTick || 0) + 1;
  if (S.speed > 1 || S.detTick % 2 === 0) detectBall(sim.t, bodies);   // ~30 Hz at 1x
  feedPose(sim.t, bodies);
}
function feedPose(t, bodies) {
  for (const i of [0, 1]) {
    const b = bodies[i]; if (!b) continue;
    const lm = b.pts.map((p) => { const q = S.cam.project(p); return [q[0] / W, q[1] / H, 1]; });
    S.lastLm[i] = lm;
    S.formBuf[i].push({ t, P: b.pts }); if (S.formBuf[i].length > 240) S.formBuf[i].shift();
    S.clips.push(i, t, lm);
  }
}
function detectBall(t, bodies) {
  dctx.drawImage(view, 0, 0, DW, DH);
  const k = DW / W;
  const roi = [0, DH * 0.08, DW, DH];
  const ex = [];
  for (const b of bodies || []) {
    if (!b) continue;
    // ignore the trunk and legs (big moving blobs), keep the hands and racket area open
    const pts = [11, 12, 23, 24, 25, 26, 27, 28].map((i) => S.cam.project(b.pts[i]));
    const xs = pts.map((p) => p[0] * k), ys = pts.map((p) => p[1] * k);
    ex.push([Math.min(...xs) - 4, Math.min(...ys) - 4, Math.max(...xs) + 4, Math.max(...ys) + 6]);
  }
  const img = dctx.getImageData(0, 0, DW, DH);
  const cands = S.det.detect(img, roi, ex, { minArea: 1, maxArea: 260 });
  const pt = S.trk.update(t, cands.map((c) => ({ ...c, u: c.u / k, v: c.v / k })), 1);
  S.ballPt = pt;
  setChip('chipBall', pt ? 'Ball: locked' : 'Ball: searching', pt ? 'on' : 'warn');
}

/** Simulation truth events → the tracker's own measurement and charting path. */
function onSimEvent(e) {
  const sim = S.sim, near = (who) => S.score.near === who;
  if (e.type === 'pointStart') { newPoint(); S.cur.startT = e.t; S.trk.reset(); return; }
  if (e.type === 'hit') {
    S.cur.lastHit = { t: e.t, who: e.who, kind: e.kind, wing: e.wing, x: e.pos[0], y: e.pos[1], z: e.pos[2], serveNo: e.serveNo, truth: e };
    if (e.kind === 'serve' && e.serveNo === 2) S.cur.serveNo = 2;
    return;
  }
  if (e.type === 'bounce' && S.cur.lastHit && !e.second) {
    const h = S.cur.lastHit;
    if (S.cur.lastBounce && S.cur.lastBounce.hitT === h.t) return;  // already measured this flight
    const obs = S.trk.between(h.t, e.t);
    const fit = fitShot(S.cam, obs, h, { t: e.t, x: e.x, y: e.y }, h.kind);
    const speed = fit ? fit.speed : h.truth.speedTrue;
    const spin = fit ? fit.rpm : Math.round(h.truth.rpmTrue);
    if (fit) S.truthCmp.push({ speed: fit.speed - h.truth.speedTrue, n: obs.length }); if (S.truthCmp.length > 80) S.truthCmp.shift();
    const recvFar = near(h.who);   // the receiver is at the far end when the hitter is near
    const shot = { i: S.cur.shots.length, who: h.who, kind: h.kind === 'serve' ? 'serve' : 'ground', wing: h.wing || null, speed: Math.round(speed), spin: Math.round(spin),
      swing: Math.round(swingFromImpact(speed, S.cur.lastHitIn || 0)), depth: h.kind === 'serve' ? null : depthOf(h.who, e.y, recvFar), dir: h.kind === 'serve' ? null : directionOf(h.x, e.x, near(h.who)),
      bounce: { x: Math.round(e.x * 100) / 100, y: Math.round(e.y * 100) / 100 }, netClear: fit && fit.netClear != null ? Math.round(fit.netClear * 100) / 100 : null, t: Math.round((h.t - S.cur.startT) * 100) / 100, _tc: h.t, measured: !!fit, obs: obs.length };
    if (!inSingles(e.x, e.y) && shot.depth) shot.depth = 'out';
    // form from the body buffer around contact; split step vs the opponent's previous contact
    const prevOpp = [...S.cur.shots].reverse().find((s) => s.who !== h.who);
    const form = strokeForm(S.formBuf[h.who], h.t, shot.kind, prevOpp ? prevOpp._tc : null);
    if (form) shot.form = form;
    if (h.kind === 'serve') {
      if (h.serveNo === 1) S.cur.s1 = shot.speed; else S.cur.s2 = shot.speed;
      const sideNow = S.score.side;
      const inBox = inServiceBox(e.x, e.y, sideNow, near(h.who));
      if (h.serveNo === 1) S.cur.serve1In = inBox;
      if (inBox) S.cur.placement = servePlacement(e.x, sideNow, near(h.who));
      else S.cur.placement = S.cur.placement || servePlacement(e.x, sideNow, near(h.who));
    }
    S.cur.lastHitIn = speed * 0.62;
    S.cur.shots.push(shot);
    S.cur.lastBounce = { hitT: h.t };
    S.lastShot = shot; showSpeed(shot);
    S.bounces.push({ x: e.x, y: e.y, depth: shot.depth || (h.kind === 'serve' ? 'serve' : 'mid'), who: h.who, t: Date.now() }); if (S.bounces.length > 60) S.bounces.shift();
    S.dirty = true;
    return;
  }
  if (e.type === 'pointEnd') {
    const tr = e.truth;
    const shots = S.cur.shots.map((s) => { const c = { ...s }; delete c.measured; delete c.obs; return c; });
    // keep the measured speeds where we have them (that is the point of the demo)
    const s1 = shots.find((s) => s.kind === 'serve');
    const rec = { serve1In: tr.serve1In, serveNo: tr.serveNo, serve1Speed: S.cur.s1 ?? tr.serve1Speed, serve2Speed: S.cur.s2 ?? tr.serve2Speed, placement: tr.placement, outcome: tr.outcome, winner: tr.winner, endedBy: tr.endedBy, wing: tr.wing, finalKind: tr.finalKind, rally: tr.rally, netApproach: tr.netApproach, shots, durSec: tr.durSec, src: 'auto' };
    void s1;
    propose(rec);
  }
}
function showSpeed(shot) {
  $('speed').hidden = false;
  $('spV').textContent = shot.speed ?? '—';
  $('spU').textContent = `mph · ${shot.kind === 'serve' ? 'serve' : (shot.wing === 'BH' ? 'backhand' : shot.wing === 'FH' ? 'forehand' : 'shot')} · ${names()[shot.who]}`;
  $('spS').textContent = [shot.spin ? `${shot.spin > 0 ? 'topspin' : 'slice'} ${Math.abs(shot.spin)} rpm` : '', shot.depth ? `${shot.depth}` : '', shot.netClear != null ? `net +${shot.netClear.toFixed(2)} m` : ''].filter(Boolean).join(' · ');
}

const OUT_WORD = { ace: 'Ace', df: 'Double fault', serviceWinner: 'Service winner', winner: 'Winner', ue: 'Unforced error', fe: 'Forced error' };
/** The tracker's call. Demo confirms itself; live waits for a tap unless hands-free is on. */
function propose(rec) {
  S.pending = rec;
  const who = names()[rec.endedBy];
  const line = `${OUT_WORD[rec.outcome]} · ${who}${rec.wing ? ' · ' + rec.wing : ''}`;
  const sub = `Point to ${names()[rec.winner]} · rally ${rec.rally}${rec.serve1Speed ? ' · 1st serve ' + rec.serve1Speed + ' mph' : ''}`;
  if (S.autoConfirm) { confirmPoint(rec); S.pending = null; toast(line, sub, [{ label: 'Fix', run: () => { undoPoint(); openFix(rec); } }], 1800); }
  else toast(line, sub, [{ label: 'Confirm', cls: 'gold', run: () => { confirmPoint({ ...rec, src: 'confirmed' }); S.pending = null; } }, { label: 'Fix', run: () => openFix(rec) }], 0);
  renderPad();
}

// ---- live camera / video
let liveFrame = 0;
function liveTick(ts) {
  if (video.readyState < 2) return;
  vctx.drawImage(video, 0, 0, W, H);
  if (S.calibrating || !S.cam) return;
  const t = (S.mode === 'video' ? video.currentTime : ts / 1000);
  liveFrame++;
  // ball every frame, pose alternating near / far when the phone is slow
  const which = S.fps && S.fps < 22 ? (liveFrame % 2 ? 'near' : 'far') : 'both';
  if (S.pose.ready) {
    const r = S.pose.detect(view, W, H, S.cam, ts, which);
    for (const [i, key] of [[S.score.near, 'near'], [1 - S.score.near, 'far']]) {
      if (which !== 'both' && which !== key) continue;
      const got = r[key];
      const lm = S.sm[i].push(got ? got.lm : null);
      S.lastLm[i] = lm;
      if (lm) { S.clips.push(i, t, lm); const P = uprightFromMp(got.world); if (P) { S.formBuf[i].push({ t, P }); if (S.formBuf[i].length > 240) S.formBuf[i].shift(); } }
    }
  }
  const ex = [];
  for (const lm of S.lastLm) { if (!lm) continue; const b = boxOf([lm[11], lm[12], lm[23], lm[24], lm[25], lm[26], lm[27], lm[28]]); ex.push([b[0] * DW - 4, b[1] * DH - 4, b[2] * DW + 4, b[3] * DH + 6]); }
  dctx.drawImage(view, 0, 0, DW, DH);
  const cands = S.det.detect(dctx.getImageData(0, 0, DW, DH), [0, DH * 0.05, DW, DH], ex, { minArea: 1, maxArea: 320, diff: 18 });
  const k = DW / W;
  const pt = S.trk.update(t, cands.map((c) => ({ ...c, u: c.u / k, v: c.v / k })), 1);
  S.ballPt = pt;
  setChip('chipBall', pt ? 'Ball: locked' : 'Ball: searching', pt ? 'on' : 'warn');
  liveEvents(t);
}
/**
 * Live event reading, deliberately conservative: a hit is a reversal of the ball's screen
 * motion within reach of a player's racket hand; a bounce is a sharp downward-to-upward
 * kink away from both players. The charter (or hands-free mode) settles the point.
 */
function liveEvents(t) {
  const hst = S.trk.history; if (hst.length < 5) return;
  const a = hst[hst.length - 5], b = hst[hst.length - 3], c = hst[hst.length - 1];
  if (c.t - a.t > 0.35) return;
  const v1 = (b.v - a.v) / (b.t - a.t || 1), v2 = (c.v - b.v) / (c.t - b.t || 1);
  const L = S.liveEv || (S.liveEv = { lastEvT: 0 });
  if (t - L.lastEvT < 0.18) return;
  const hand = (i) => { const lm = S.lastLm[i]; if (!lm) return null; return [lm[16][0] * W, lm[16][1] * H]; };
  for (const i of [0, 1]) {
    const hp = hand(i); if (!hp) continue;
    const reach = 1.1 * (S.cam.scaleAt(S.cam.atHeight(hp[0], hp[1], 1) || [0, 10, 1]) || 40);
    if (Math.hypot(b.u - hp[0], b.v - hp[1]) < reach && Math.sign(v1) !== Math.sign(v2) && Math.abs(v1 - v2) > 120) {
      L.lastEvT = t;
      const g = S.cam.atHeight(b.u, b.v, 1) || [0, S.score.near === i ? 1 : CT.L - 1, 1];
      const isServe = !S.cur.shots.length && i === S.score.server;
      S.cur.lastHit = { t: b.t, who: i, kind: isServe ? 'serve' : 'ground', wing: null, x: g[0], y: g[1], z: isServe ? 2.7 : 1.0, serveNo: S.cur.serveNo, truth: { speedTrue: 0, rpmTrue: 0 } };
      if (!S.cur.startT) S.cur.startT = b.t;
      return;
    }
  }
  if (v1 > 80 && v2 < -40 && S.cur.lastHit) {
    const g = S.cam.atHeight(b.u, b.v, 0);
    if (g && Math.abs(g[0]) < CT.D + 3 && g[1] > -4 && g[1] < CT.L + 5) { L.lastEvT = t; onSimEvent({ type: 'bounce', t: b.t, x: g[0], y: g[1] }); }
  }
}

// ---------------------------------------------------------------------------- overlay
function drawOverlay() {
  octx.clearRect(0, 0, W, H);
  const cam = S.cam;
  if (S.calibrating) {
    S.calib.forEach((p, i) => { octx.fillStyle = '#DDF54A'; octx.beginPath(); octx.arc(p[0], p[1], 9, 0, Math.PI * 2); octx.fill(); octx.fillStyle = '#0B0B0D'; octx.font = '700 12px Oswald, sans-serif'; octx.fillText(i + 1, p[0] - 4, p[1] + 4); });
    return;
  }
  if (!cam || S.mode === 'chart') return;
  // the calibrated court, faint, so the coach can see the lock is right
  if (S.mode !== 'demo') {
    octx.strokeStyle = 'rgba(221,245,74,.45)'; octx.lineWidth = 1.5;
    const seg = (a, b) => { const p = cam.project([a[0], a[1], 0]), q = cam.project([b[0], b[1], 0]); octx.beginPath(); octx.moveTo(p[0], p[1]); octx.lineTo(q[0], q[1]); octx.stroke(); };
    seg([-CT.S, 0], [CT.S, 0]); seg([CT.S, 0], [CT.S, CT.L]); seg([CT.S, CT.L], [-CT.S, CT.L]); seg([-CT.S, CT.L], [-CT.S, 0]); seg([-CT.S, CT.nearSvc], [CT.S, CT.nearSvc]); seg([-CT.S, CT.farSvc], [CT.S, CT.farSvc]); seg([0, CT.nearSvc], [0, CT.farSvc]);
  }
  // bodies: near player gold, far player court blue, legs in optic yellow
  const near = S.score?.near ?? 0;
  for (const i of [0, 1]) drawSkeleton(octx, S.lastLm[i], W, H, i === near ? '#DAAF48' : '#62B0E8', '#DDF54A', i === near ? 3.2 : 2);
  // ball trail
  const hst = S.trk.history, now = hst.length ? hst[hst.length - 1].t : 0;
  for (let i = 1; i < hst.length; i++) {
    const p = hst[i - 1], q = hst[i]; if (now - q.t > 0.7 || q.t - p.t > 0.12) continue;
    octx.strokeStyle = `rgba(221,245,74,${0.15 + 0.8 * (1 - (now - q.t) / 0.7)})`; octx.lineWidth = 3; octx.beginPath(); octx.moveTo(p.u, p.v); octx.lineTo(q.u, q.v); octx.stroke();
  }
  if (S.ballPt) { octx.strokeStyle = '#DDF54A'; octx.lineWidth = 2; octx.beginPath(); octx.arc(S.ballPt.u, S.ballPt.v, 11, 0, Math.PI * 2); octx.stroke(); }
  // recent bounces, coloured AND labelled by depth
  const col = { deep: '#46D68C', mid: '#FFC24D', short: '#FF5A5A', out: '#9C9CA9', serve: '#62B0E8' };
  const nowMs = Date.now();
  for (const b of S.bounces) {
    const age = (nowMs - b.t) / 1000; if (age > 6) continue;
    const p = cam.project([b.x, b.y, 0]); const a = Math.max(0, 1 - age / 6);
    octx.globalAlpha = a; octx.strokeStyle = col[b.depth] || '#fff'; octx.lineWidth = 2.5;
    octx.beginPath(); octx.ellipse(p[0], p[1], 12, 5, 0, 0, Math.PI * 2); octx.stroke();
    if (age < 2.5) { octx.fillStyle = col[b.depth] || '#fff'; octx.font = '700 13px Barlow Condensed, sans-serif'; octx.fillText(b.depth === 'out' ? 'OUT' : b.depth.toUpperCase(), p[0] + 14, p[1] + 4); }
    octx.globalAlpha = 1;
  }
}

// ---------------------------------------------------------------------------- scoreboard and pad
function renderBoard() {
  const sc = S.score; if (!sc) return;
  const nm = names(), sets = sc.sets, sit = sc.situation();
  const pts = sc.points, tb = sc.inTiebreak;
  const ptStr = (i) => { if (sc.matchWinner !== null) return ''; if (tb) return String(pts[i]); const lab = sc.pointLabel(); const parts = lab.split('-'); if (lab === 'Deuce') return '40'; if (parts.length === 2) { const srvFirst = sc.server === i ? parts[0] : parts[1]; return srvFirst; } return lab; };
  const row = (i) => `<div class="row r${i}"><div class="nm"><span class="sv ${sc.server === i && sc.matchWinner === null ? 'on' : ''}" aria-label="${sc.server === i ? 'serving' : ''}"></span>${esc(nm[i])}<span class="end ${sc.near === i ? 'near' : 'far'}">${sc.near === i ? 'NEAR' : 'FAR'}</span></div>
    <div class="sets">${sets.map((s, k) => `<span class="${k === sets.length - 1 ? 'cur' : ''}">${s[i]}</span>`).join('')}</div><div class="pts num">${ptStr(i)}</div></div>`;
  const label = sit.matchPoint ? 'Match point' : sit.setPoint ? 'Set point' : sit.breakPoint ? 'Break point' : sc.inTiebreak ? 'Tiebreak' : sc.pointLabel() === 'Deuce' || sc.pointLabel() === '40-40' ? (sc.format.noAd ? 'Deciding point' : 'Deuce') : '';
  $('board').innerHTML = row(0) + row(1) + (label && sc.matchWinner === null ? `<div class="sit">${label}</div>` : '');
  $('chipLive').hidden = !(S.mode === 'camera');
}
let fixState = null;
function openFix(rec) { fixState = { winner: rec?.winner ?? null, outcome: rec?.outcome ?? null, wing: rec?.wing ?? null, base: rec || null }; renderPad(); }
function renderPad() {
  const pad = $('pad'); if (!S.score) { pad.innerHTML = ''; return; }
  const nm = names(), sc = S.score;
  if (sc.matchWinner !== null) { pad.innerHTML = `<div class="grp"><button class="btn gold" id="pEnd">Match over · send final sheet</button><button class="btn" id="pUndo">Undo last point</button></div>`; $('pEnd').onclick = () => { flush(true); toast('Final sheet sent', 'The coach has every point.'); }; $('pUndo').onclick = undoPoint; return; }
  if (fixState) {
    const f = fixState;
    const outs = f.winner === null ? [] : [['ace', 'Ace'], ['serviceWinner', 'Service winner'], ['winner', 'Winner'], ['fe', 'Forced error by ' + nm[1 - f.winner]], ['ue', 'Unforced error by ' + nm[1 - f.winner]], ['df', 'Double fault by ' + nm[1 - f.winner]]]
      .filter(([k]) => (k === 'ace' || k === 'serviceWinner' ? f.winner === sc.server : k === 'df' ? f.winner !== sc.server : true));
    pad.innerHTML = `<div class="grp"><div class="lbl">Point to</div><button class="btn us ${f.winner === 0 ? 'gold' : ''}" data-w="0">${esc(nm[0])}</button><button class="btn them ${f.winner === 1 ? 'gold' : ''}" data-w="1">${esc(nm[1])}</button></div>
      ${f.winner !== null ? `<div class="sep"></div><div class="grp"><div class="lbl">How</div>${outs.map(([k, l]) => `<button class="btn sm ${f.outcome === k ? 'gold' : ''}" data-o="${k}">${esc(l)}</button>`).join('')}</div>` : ''}
      ${f.outcome && !['ace', 'df', 'serviceWinner'].includes(f.outcome) ? `<div class="sep"></div><div class="grp"><div class="lbl">Shot</div>${['FH', 'BH', 'Volley', 'Overhead'].map((w) => `<button class="btn sm ${f.wing === w ? 'gold' : ''}" data-g="${w}">${w}</button>`).join('')}</div>` : ''}
      <div class="grp" style="margin-left:auto"><button class="btn" id="pCancel">Cancel</button><button class="btn gold" id="pSave" ${f.winner === null || !f.outcome ? 'disabled' : ''}>Save point</button></div>`;
    pad.querySelectorAll('[data-w]').forEach((b) => (b.onclick = () => { f.winner = +b.dataset.w; f.outcome = null; renderPad(); }));
    pad.querySelectorAll('[data-o]').forEach((b) => (b.onclick = () => { f.outcome = b.dataset.o; renderPad(); }));
    pad.querySelectorAll('[data-g]').forEach((b) => (b.onclick = () => { f.wing = b.dataset.g; renderPad(); }));
    $('pCancel').onclick = () => { fixState = null; renderPad(); };
    $('pSave').onclick = () => {
      const o = f.outcome, winner = f.winner, srv = sc.server;
      const endedBy = ['ace', 'serviceWinner', 'winner'].includes(o) ? winner : 1 - winner;
      const base = f.base || {};
      const wing = ['FH', 'BH'].includes(f.wing) ? f.wing : null;
      const rec = { serve1In: o === 'df' ? false : (S.cur.serve1In ?? base.serve1In ?? true), serveNo: o === 'df' ? 2 : (S.cur.serveNo || base.serveNo || 1), serve1Speed: S.cur.s1 ?? base.serve1Speed ?? null, serve2Speed: S.cur.s2 ?? base.serve2Speed ?? null, placement: S.cur.placement ?? base.placement ?? null,
        outcome: o, winner, endedBy, wing, finalKind: ['ace', 'df', 'serviceWinner'].includes(o) ? 'serve' : f.wing === 'Volley' ? 'volley' : f.wing === 'Overhead' ? 'overhead' : 'ground',
        rally: o === 'df' ? 0 : ['ace', 'serviceWinner'].includes(o) ? 1 : Math.max(2, base.rally || S.cur.shots.length || 3), netApproach: f.wing === 'Volley' || f.wing === 'Overhead' ? endedBy : base.netApproach ?? null, shots: base.shots || S.cur.shots.map((s) => ({ ...s })), src: base.src === 'auto' ? 'confirmed' : 'manual' };
      void srv;
      fixState = null; S.pending = null; hideToast(); confirmPoint(rec);
    };
    return;
  }
  const demo = S.mode === 'demo';
  pad.innerHTML = `<div class="grp">${demo ? `<button class="btn ${S.speed === 1 ? 'gold' : ''}" data-sp="1">1x</button><button class="btn ${S.speed === 2 ? 'gold' : ''}" data-sp="2">2x</button><button class="btn ${S.speed === 4 ? 'gold' : ''}" data-sp="4">4x</button><button class="btn" id="pFf">Fast-forward 12 pts</button>`
      : `<button class="btn ${S.cur.serve1In === false ? 'bad' : ''}" id="pFault">${S.cur.serve1In === false ? '2nd serve' : '1st serve fault'}</button>`}</div>
    <div class="sep"></div>
    <div class="grp"><button class="btn us" id="pW0">Point ${esc(nm[0])}</button><button class="btn them" id="pW1">Point ${esc(nm[1])}</button></div>
    <div class="grp" style="margin-left:auto"><button class="btn" id="pUndo" ${S.points.length ? '' : 'disabled'}>Undo</button>${!demo ? `<button class="btn ${S.autoConfirm ? 'gold' : ''}" id="pHands" aria-pressed="${S.autoConfirm}">Hands-free</button>` : ''}</div>`;
  pad.querySelectorAll('[data-sp]').forEach((b) => (b.onclick = () => { S.speed = +b.dataset.sp; renderPad(); }));
  $('pFf') && ($('pFf').onclick = () => fastForward(12));
  $('pFault') && ($('pFault').onclick = () => { if (S.cur.serve1In === false) return; S.cur.serve1In = false; S.cur.serveNo = 2; renderPad(); });
  $('pW0').onclick = () => openFix({ winner: 0 }); $('pW1').onclick = () => openFix({ winner: 1 });
  $('pUndo').onclick = undoPoint;
  $('pHands') && ($('pHands').onclick = () => { S.autoConfirm = !S.autoConfirm; renderPad(); toast(S.autoConfirm ? 'Hands-free on' : 'Hands-free off', S.autoConfirm ? "The tracker's call is saved without a tap. Fix any point from the Sheet tab." : 'Each call waits for Confirm.'); });
}
/** Demo only: play points out of sight to build up a match quickly (truth, no rendering). */
function fastForward(nPts) {
  const sim = S.sim; let done = 0, guard = 0;
  const target = S.points.length + nPts;
  while (S.points.length < target && guard++ < 200000 && S.score.matchWinner === null) {
    const evs = sim.step(1 / 30);
    sim._f = (sim._f || 0) + 1;
    if (sim._f % 2 === 0) { const bodies = []; for (const i of [0, 1]) bodies[i] = bodyPoints(sim.players[i]); feedPose(sim.t, bodies); }
    for (const e of evs) { if (e.type === 'bounce' && S.cur.lastHit) { const h = S.cur.lastHit; S.trk.history = sim.trail.map((p) => { const q = S.cam.project([p[1], p[2], p[3]]); return { t: p[0], u: q[0], v: q[1] }; }); } onSimEvent(e); if (e.type === 'pointEnd') done++; }
  }
  toast('Fast-forwarded', `${done} points played. ${S.alerts.length} trend${S.alerts.length === 1 ? '' : 's'} raised so far.`);
  S.dirty = true;
}

// ---------------------------------------------------------------------------- panels
function setChip(id, text, cls) { const c = $(id); if (!c) return; c.className = 'chip ' + (cls || ''); c.querySelector('span:last-child').textContent = text; }
$('tabs').querySelectorAll('.tab').forEach((t) => (t.onclick = () => {
  $('tabs').querySelectorAll('.tab').forEach((x) => x.setAttribute('aria-selected', x === t));
  $('panes').querySelectorAll('.pane').forEach((p) => p.classList.toggle('on', p.dataset.pane === t.dataset.pane));
  if (t.dataset.pane === 'trends') { S.alerts.forEach((a) => (a.seen = true)); $('trendN').hidden = true; }
  S.dirty = true;
}));
$('btnDrawer').onclick = () => $('side').classList.toggle('open');
$('btnSetup').onclick = () => startSheet();

function renderAll() {
  renderBoard();
  const st = computeStats(S.points), nm = names(), P = st.players;
  const on = (k) => $('panes').querySelector(`.pane[data-pane="${k}"]`).classList.contains('on');
  if (on('live')) renderLive(st);
  if (on('stats')) renderStats(st);
  if (on('trends')) renderTrends();
  if (on('scout')) renderScout(st);
  if (on('sheet')) renderSheet();
  if (on('share')) renderShare();
  void nm; void P;
}
function kpi(label, val, sub, cls = '') { return `<div class="kpi ${cls}"><div class="k">${esc(label)}</div><div class="v num">${val ?? '—'}</div><div class="d">${esc(sub || '')}</div></div>`; }
const pc = (r) => { const x = pct(r); return x === null ? '—' : x + '%'; };
function renderLive(st) {
  const nm = names(), P = st.players, s = S.lastShot;
  const acc = S.truthCmp.length ? Math.sqrt(S.truthCmp.reduce((a, b) => a + b.speed * b.speed, 0) / S.truthCmp.length) : null;
  $('paneLive').innerHTML = `
    <div class="card"><h3>Last shot <small>${s ? esc(nm[s.who]) : ''}</small></h3>
      <div class="kpis">${kpi('Ball pace', s?.speed, 'mph, est.')}${kpi('Spin', s?.spin != null ? Math.abs(s.spin) : null, s?.spin != null ? (s.spin >= 0 ? 'rpm topspin' : 'rpm slice') : 'rpm')}${kpi('Swing', s?.swing, 'mph racket head')}
      ${kpi('Depth', s?.depth ? s.depth.toUpperCase() : s?.kind === 'serve' ? 'SERVE' : null, s?.bounce ? `bounce ${s.bounce.y.toFixed(1)} m` : '')}${kpi('Net', s?.netClear != null ? '+' + s.netClear.toFixed(2) : null, 'metres over tape')}${kpi('Knee', s?.form?.kneeMin ?? s?.form?.trophyKnee ?? null, s?.form ? 'min knee angle °' : 'form')}</div></div>
    <div class="card"><h3>Court <small>last 60 bounces</small></h3><canvas class="mini" id="mini" width="360" height="540"></canvas>
      <div class="legend"><span><i style="background:#46D68C"></i>Deep</span><span><i style="background:#FFC24D"></i>Mid</span><span><i style="background:#FF5A5A"></i>Short</span><span><i style="background:#62B0E8"></i>Serve</span></div></div>
    <div class="card"><h3>This match</h3><div class="kpis">${kpi('1st serve in', pc(P[0].firstServeIn), nm[0], 'us')}${kpi('Winners', P[0].winners, `${P[0].ue} unforced errors`, 'us')}${kpi('Aces', P[0].aces, `${P[0].dfs} double faults`, 'us')}
      ${kpi('1st serve in', pc(P[1].firstServeIn), nm[1], 'them')}${kpi('Winners', P[1].winners, `${P[1].ue} unforced errors`, 'them')}${kpi('Aces', P[1].aces, `${P[1].dfs} double faults`, 'them')}</div></div>
    <div class="card"><h3>Tracker health</h3><p class="note">${S.fps} fps · ${S.trk.best ? 'ball locked' : 'searching for the ball'} · ${S.mode === 'demo' ? 'pose from the simulation' : S.pose.ready ? 'two pose models running (near: full frame, far: up-scaled crop)' : 'pose model not loaded'}${S.cam?.calErr != null ? ` · calibration ±${S.cam.calErr.toFixed(1)} px` : ''}${acc != null ? `<br>Speed vs the simulation's truth: ±${acc.toFixed(1)} mph RMS over ${S.truthCmp.length} measured flights.` : ''}</p></div>`;
  drawMini();
}
function drawMini() {
  const cv = $('mini'); if (!cv) return; const c = cv.getContext('2d'), w = cv.width, h = cv.height;
  const sx = (x) => w / 2 + (x / (CT.D + 1.5)) * (w / 2), sy = (y) => h - ((y + 2) / (CT.L + 4)) * h;
  c.fillStyle = '#1d4f3a'; c.fillRect(0, 0, w, h);
  c.fillStyle = '#2f5f9a'; c.fillRect(sx(-CT.D), sy(CT.L), sx(CT.D) - sx(-CT.D), sy(0) - sy(CT.L));
  c.strokeStyle = 'rgba(255,255,255,.85)'; c.lineWidth = 1.5;
  const L = (a, b, d, e) => { c.beginPath(); c.moveTo(sx(a), sy(b)); c.lineTo(sx(d), sy(e)); c.stroke(); };
  L(-CT.D, 0, CT.D, 0); L(-CT.D, CT.L, CT.D, CT.L); L(-CT.D, 0, -CT.D, CT.L); L(CT.D, 0, CT.D, CT.L); L(-CT.S, 0, -CT.S, CT.L); L(CT.S, 0, CT.S, CT.L);
  L(-CT.S, CT.nearSvc, CT.S, CT.nearSvc); L(-CT.S, CT.farSvc, CT.S, CT.farSvc); L(0, CT.nearSvc, 0, CT.farSvc);
  c.strokeStyle = '#ddd'; c.lineWidth = 3; L(-CT.D - 0.9, CT.NET, CT.D + 0.9, CT.NET);
  const col = { deep: '#46D68C', mid: '#FFC24D', short: '#FF5A5A', out: '#9C9CA9', serve: '#62B0E8' };
  for (const b of S.bounces) { c.fillStyle = col[b.depth] || '#fff'; c.beginPath(); c.arc(sx(b.x), sy(b.y), 4, 0, Math.PI * 2); c.fill(); }
  c.fillStyle = '#9C9CA9'; c.font = '600 11px Barlow Condensed, sans-serif'; c.fillText('CAMERA END', 8, h - 6); c.fillText('FAR END', 8, 14);
}
function renderStats(st) {
  const nm = names(), rows = summaryRows(st, nm);
  const better = (a, b) => { const na = parseFloat(String(a).replace(/.*\(|%\)|[^0-9.\-]/g, '')), nb = parseFloat(String(b).replace(/.*\(|%\)|[^0-9.\-]/g, '')); return [na, nb]; };
  const body = rows.slice(1).map((r) => {
    const cells = r.map(cellV);
    if (cells.length < 3 || (cells[1] === '' && cells[2] === '')) return `<tr class="sec"><td colspan="3">${esc(cells[0])}</td></tr>`;
    const [a, b] = better(cells[1], cells[2]);
    return `<tr><td>${esc(cells[0])}</td><td class="${a > b ? 'best' : ''}">${esc(cells[1])}</td><td class="${b > a ? 'best' : ''}">${esc(cells[2])}</td></tr>`;
  }).join('');
  const mom = st.momentum, mx = Math.max(3, ...mom.map(Math.abs));
  const path = mom.map((m, i) => `${i ? 'L' : 'M'}${(i / Math.max(1, mom.length - 1)) * 340 + 10},${60 - (m / mx) * 48}`).join(' ');
  const rb = (r) => `${pc(r)}`;
  $('paneStats').innerHTML = `<div class="card"><h3>Momentum <small>${st.pointsPlayed} points</small></h3><svg viewBox="0 0 360 120" width="100%" role="img" aria-label="Momentum line"><line x1="10" x2="350" y1="60" y2="60" stroke="rgba(255,255,255,.15)"/><path d="${path}" fill="none" stroke="#DAAF48" stroke-width="2.5"/><text x="12" y="16" fill="#DAAF48" font-size="11" font-family="Barlow Condensed">${esc(nm[0])} ahead</text><text x="12" y="114" fill="#62B0E8" font-size="11" font-family="Barlow Condensed">${esc(nm[1])} ahead</text></svg></div>
    <div class="card"><h3>Rally length <small>% of points won</small></h3><table class="cmp"><tr><th></th><th>${esc(nm[0])}</th><th>${esc(nm[1])}</th></tr>
      <tr><td>0-4 shots</td><td>${rb(st.players[0].rallyShort)}</td><td>${rb(st.players[1].rallyShort)}</td></tr><tr><td>5-8 shots</td><td>${rb(st.players[0].rallyMid)}</td><td>${rb(st.players[1].rallyMid)}</td></tr><tr><td>9+ shots</td><td>${rb(st.players[0].rallyLong)}</td><td>${rb(st.players[1].rallyLong)}</td></tr></table></div>
    <div class="card"><h3>Match stats</h3><table class="cmp"><tr><th></th><th>${esc(nm[0])}</th><th>${esc(nm[1])}</th></tr>${body}</table></div>`;
}
function renderTrends() {
  const list = [...S.alerts].reverse();
  $('paneTrends').innerHTML = list.length ? list.map((a) => `<div class="alert ${a.severity}"><span class="sev">${a.severity === 'fix' ? 'Fix now' : a.severity === 'watch' ? 'Watch' : 'Scouting'}</span><div class="ti">${esc(a.title)}</div><div class="de">${esc(a.detail)}</div><div class="cue"><b>Say at the changeover</b>${esc(a.cue)}</div><div class="meta">After point ${a.at} · ${esc(a.kind)}${a.clipId ? `<button class="btn sm gold" data-clip="${a.clipId}" style="margin-left:auto">Watch body shape</button>` : ''}</div></div>`).join('')
    : `<div class="card"><h3>No trends yet</h3><p class="note">Alerts appear when a pattern holds: first-serve drops, errors piling up on one wing, a serve losing its knee bend, an opponent who keeps serving to one spot. Each comes with the cue to give at the changeover.</p></div>`;
  $('paneTrends').querySelectorAll('[data-clip]').forEach((b) => (b.onclick = () => playClip(b.dataset.clip)));
}
function renderScout(st) {
  const nm = names(), O = st.players[1], U = st.players[0];
  const bar = (obj, side) => { const tot = obj.Wide + obj.Body + obj.T || 1; return ['Wide', 'Body', 'T'].map((k) => `<div style="display:flex;align-items:center;gap:8px;margin:4px 0"><span style="width:44px;font:600 .72rem Barlow Condensed;letter-spacing:.1em;color:#9C9CA9">${k.toUpperCase()}</span><span style="flex:1;height:14px;border-radius:7px;background:rgba(255,255,255,.06);overflow:hidden"><i style="display:block;height:100%;width:${(obj[k] / tot) * 100}%;background:${side === 'them' ? '#62B0E8' : '#C99A2C'}"></i></span><span class="num" style="width:44px;text-align:right;color:#F4F1EA">${Math.round((obj[k] / tot) * 100)}%</span></div>`).join(''); };
  const wingErr = (p) => `${p.ueFH} FH · ${p.ueBH} BH`;
  $('paneScout').innerHTML = `<div class="card"><h3>${esc(nm[1])} serves <small>deuce side</small></h3>${bar(O.placement.deuce, 'them')}</div>
    <div class="card"><h3>${esc(nm[1])} serves <small>ad side</small></h3>${bar(O.placement.ad, 'them')}</div>
    <div class="card"><h3>Where ${esc(nm[1])} breaks down</h3><table class="cmp"><tr><td>Unforced errors</td><td>${wingErr(O)}</td></tr><tr><td>Wins long rallies (9+)</td><td>${pc(O.rallyLong)}</td></tr><tr><td>Second-serve points won</td><td>${pc(O.secondServeWon)}</td></tr><tr><td>Pressure points won</td><td>${pc(O.pressurePoints)}</td></tr><tr><td>Rally ball pace</td><td>${O.shotSpeed.avg ? Math.round(O.shotSpeed.avg) + ' mph' : '—'}</td></tr></table></div>
    <div class="card"><h3>Changeover notes</h3><ol style="padding-left:18px;color:#F4F1EA;font-size:.9rem;line-height:1.5">${changeoverNotes(st).map((t) => `<li>${esc(t)}</li>`).join('')}</ol></div>
    <div class="card"><h3>${esc(nm[0])} serves</h3>${bar(U.placement.deuce, 'us')}<p class="note" style="margin:6px 0">Ad side</p>${bar(U.placement.ad, 'us')}</div>`;
}
function changeoverNotes(st) {
  const nm = names(), O = st.players[1], U = st.players[0], notes = [];
  const fav = (pl) => { const e = Object.entries(pl).sort((a, b) => b[1] - a[1])[0]; const tot = pl.Wide + pl.Body + pl.T; return tot >= 4 ? [e[0], Math.round((e[1] / tot) * 100)] : null; };
  const d = fav(O.placement.deuce), a = fav(O.placement.ad);
  if (d && d[1] >= 50) notes.push(`${nm[1]} goes ${d[0]} on the deuce side ${d[1]}% of the time. Shade that way on return.`);
  if (a && a[1] >= 50) notes.push(`${nm[1]} goes ${a[0]} on the ad side ${a[1]}%. Start a half-step toward it.`);
  if (O.ueBH > O.ueFH + 2) notes.push(`${nm[1]}'s backhand is leaking: ${O.ueBH} unforced errors. Play the backhand corner.`);
  if (O.ueFH > O.ueBH + 2) notes.push(`${nm[1]}'s forehand is breaking down: ${O.ueFH} unforced errors. Make them hit forehands.`);
  if (pct(U.firstServeIn) !== null && pct(U.firstServeIn) < 55) notes.push(`${nm[0]} is making ${pct(U.firstServeIn)}% of first serves. Take pace off, hit spots.`);
  if (pct(U.rallyLong) !== null && U.rallyLong.of >= 4 && pct(U.rallyLong) < 40) notes.push(`${nm[0]} is losing the long rallies. Look to end points earlier.`);
  if (U.ueBH > U.ueFH + 2) notes.push(`${nm[0]}'s backhand errors: ${U.ueBH}. More net clearance, aim deep middle.`);
  if (!notes.length) notes.push('Not enough points for a pattern yet. Keep charting.');
  return notes.slice(0, 5);
}
function renderSheet() {
  const rows = pointLogRows(S.points, names()), hd = rows[0].map(cellV);
  const body = rows.slice(1).reverse().map((r, k) => { const p = S.points[S.points.length - 1 - k]; return `<tr class="${p?.pressure ? 'press' : ''}">${r.map((c) => { const v = cellV(c), s = c && typeof c === 'object' ? c.s : ''; return `<td class="${s === 'good' ? 'good' : s === 'bad' ? 'bad' : ''}">${esc(v)}</td>`; }).join('')}</tr>`; }).join('');
  $('paneSheet').innerHTML = `<div class="card"><h3>Coach sheet <small>${S.points.length} points · updates every 3</small></h3><div class="sheetwrap"><table class="sheet"><thead><tr>${hd.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${body || `<tr><td colspan="${hd.length}" style="padding:18px;color:#82828F">No points yet.</td></tr>`}</tbody></table></div></div>
    <div class="row2"><button class="btn gold" id="shX">Excel (.xlsx)</button><button class="btn" id="shC">CSV</button><button class="btn" id="shT">Copy for Google Sheets</button></div>`;
  $('shX').onclick = exportXlsx; $('shC').onclick = exportCsv; $('shT').onclick = copyTsv;
}
function renderShare() {
  const conn = !!S.sheets.url;
  $('paneShare').innerHTML = `<div class="card"><h3>Send to the coach</h3><div class="list">
      <button class="btn gold" id="sx">Download Excel (.xlsx)</button>
      <button class="btn" id="se">Email the stats</button>
      <button class="btn" id="st">Copy for Google Sheets</button>
      ${window.GT_PREVIEW ? '<a class="btn" id="sn" href="https://sheets.new" target="_blank" rel="noopener">New Google Sheet</a>' : '<button class="btn" id="sn">New Google Sheet</button>'}
      ${S.match.sheetUrl ? `<a class="btn" href="${esc(S.match.sheetUrl)}" target="_blank" rel="noopener">Open the live Google Sheet</a>` : ''}</div>
      <p class="note" style="margin-top:8px">"New Google Sheet" copies every point, then opens a blank sheet: paste into A1.</p></div>
    <div class="card"><h3>Live Google Sheet <small>${conn ? 'connected' : 'optional'}</small></h3>
      <p class="note">With the team's Apps Script connector, this page pushes the sheet every 3 points and at the end of every game. Setup takes 3 minutes: see sheets-connector/README.md.</p>
      <div class="field" style="margin-top:10px"><label for="su">Web app URL</label><input id="su" value="${esc(S.sheets.url)}" placeholder="https://script.google.com/macros/s/…/exec"></div>
      <div class="field"><label for="sk">Token</label><input id="sk" value="${esc(S.sheets.token)}" placeholder="the TOKEN in Code.gs"></div>
      <div class="row2"><button class="btn" id="sv">Save</button><button class="btn" id="sp">Test</button></div></div>
    <div class="card"><h3>Match</h3><p class="note">${esc(S.match.title)} · ${esc(S.match.date)} · ${esc((FORMATS.find((f) => f.id === S.match.formatId) || {}).label || '')}</p>
      <div class="row2" style="margin-top:8px"><button class="btn bad" id="sEnd">End match &amp; send</button></div></div>`;
  $('sx').onclick = exportXlsx; $('se').onclick = emailStats; $('st').onclick = copyTsv;
  $('sn').onclick = async (e) => { if (window.GT_PREVIEW) { copyTsv(); return; } e.preventDefault?.(); await copyTsv(); window.open('https://sheets.new', '_blank', 'noopener'); };
  $('sv').onclick = () => { S.sheets = { url: $('su').value.trim(), token: $('sk').value.trim() }; try { localStorage.setItem('gt_sheets', JSON.stringify(S.sheets)); } catch {} toast('Saved', S.sheets.url ? 'The sheet updates every 3 points.' : 'Connector cleared.'); };
  $('sp').onclick = async () => { try { const r = await fetch($('su').value.trim(), { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify({ token: $('sk').value.trim(), action: 'ping' }) }); const j = await r.json(); toast(j.ok ? 'Connected' : 'Refused', j.ok ? `Writing as ${j.owner || 'the coach'}` : j.error || ''); } catch (e) { toast('Could not reach it', 'Deploy as a Web app with access "Anyone".'); } };
  $('sEnd').onclick = () => { flush(true); toast('Final sheet sent', `${S.points.length} points.`); };
}

// ---------------------------------------------------------------------------- host bridge and boot
window.__gtInit = (cfg) => {
  S.inited = true;
  Object.assign(S.match, { id: cfg.matchId || S.match.id, title: cfg.title || S.match.title, names: cfg.names || S.match.names, formatId: cfg.formatId || S.match.formatId, firstServer: cfg.firstServer ?? 0, nearAtStart: cfg.nearAtStart ?? 0, sheetUrl: cfg.sheetUrl || null });
  S.match.format = cfg.format || formatOf(S.match.formatId);
  const saved = Array.isArray(cfg.points) ? cfg.points.slice().sort((x, y) => x.n - y.n) : [];
  // The host re-sends this after a WebView reload; never drop points charted since.
  if (saved.length >= S.points.length) S.points = saved;
  S.score = MatchScore.replay(S.match.format, S.match.firstServer, S.points.map((p) => p.winner), S.match.nearAtStart);
  S.alerts = detectTrends(S.points, names(), []);  // already raised before: do not re-announce
  if (S.mode) { S.dirty = true; renderPad(); toast('Match loaded', `${S.points.length} points · ${scoreLineNow()}`); return; }
  startSheet();
};
document.addEventListener('visibilitychange', () => { if (document.hidden) flush(false); });
S.match.format = formatOf(S.match.formatId);
if (window.GT_PREVIEW && window.claude?.use) window.claude.use('downloads').then((d) => { S.dl = d; }).catch(() => {});
// In the app the host answers gt:ready with __gtInit. Opened from the Locker there is no match
// to load, so after a few seconds the page starts on its own.
if (IN_APP) { post({ type: 'gt:ready' }); setTimeout(() => { if (!S.inited && !S.mode && $('startModal').hidden) startSheet(); }, 4000); } else startSheet();
