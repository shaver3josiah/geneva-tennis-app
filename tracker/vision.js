/* tracker/vision.js — seeing the ball and the two bodies.
 *
 * BALL. A three-frame difference (the ball is where THIS frame differs from BOTH of the two
 * before it, which erases the ghost of where it just was) gated by an optic-yellow colour
 * score, then connected components, then a constant-acceleration track in image space.
 * It is the classical cousin of TrackNet's three-frame input, small enough for a phone.
 *
 * BODIES. Two MediaPipe Pose Landmarker instances. One reads the full frame for the NEAR
 * player; the other reads an up-scaled crop of the far half for the FAR player, who is
 * only ~5% of the frame height through a 0.5x lens. Separate detectors, separate
 * identities: the foreground and background players can never be swapped by the model.
 */

// ------------------------------------------------------------------------------- ball
class BallDetector {
  constructor() { this.prev1 = null; this.prev2 = null; this.w = 0; this.h = 0; this.mask = null; this.lab = null; this.ring = []; this.ri = 0; }
  reset() { this.prev1 = this.prev2 = null; }
  /**
   * img: ImageData at detection size. roi: [x0,y0,x1,y1] in detection px. exclude: boxes
   * (bodies) to ignore. Returns candidates in detection px.
   */
  detect(img, roi, exclude = [], opts = {}) {
    const { width: w, height: h, data } = img;
    if (w !== this.w || h !== this.h) { this.w = w; this.h = h; this.prev1 = this.prev2 = null; this.mask = new Uint8Array(w * h); this.lab = new Int32Array(w * h); this.ring = [0, 1, 2].map(() => new Uint8Array(w * h)); }
    // three grey buffers in rotation: no per-frame allocation
    const gray = this.ring[this.ri]; this.ri = (this.ri + 1) % 3;
    for (let i = 0, j = 0; i < gray.length; i++, j += 4) gray[i] = (data[j] * 77 + data[j + 1] * 150 + data[j + 2] * 29) >> 8;
    const p1 = this.prev1, p2 = this.prev2;
    this.prev2 = this.prev1; this.prev1 = gray;
    if (!p1 || !p2) return [];
    const thr = opts.diff ?? 22, mask = this.mask; mask.fill(0);
    const [x0, y0, x1, y1] = roi.map(Math.round);
    const useColor = opts.color !== false;
    for (let y = Math.max(1, y0); y < Math.min(h - 1, y1); y++) {
      let i = y * w + Math.max(1, x0);
      for (let x = Math.max(1, x0); x < Math.min(w - 1, x1); x++, i++) {
        const g = gray[i], d1 = Math.abs(g - p1[i]), d2 = Math.abs(g - p2[i]);
        const d = d1 < d2 ? d1 : d2;
        if (d < thr) continue;
        if (useColor) {
          const j = i * 4, r = data[j], gg = data[j + 1], b = data[j + 2];
          // optic yellow: green high, red close behind, blue low
          const yel = (gg + r) / 2 - b;
          if (yel < (opts.yellow ?? 38) || gg < r * 0.72 || gg < 90) { if (d < thr * 2.6) continue; }
        }
        mask[i] = 1;
      }
    }
    // connected components (4-neighbour, two-pass with a small union-find)
    const lab = this.lab; lab.fill(0);
    const parent = [0]; let next = 1;
    const find = (a) => { while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; } return a; };
    for (let y = Math.max(1, y0); y < Math.min(h - 1, y1); y++) {
      for (let x = Math.max(1, x0); x < Math.min(w - 1, x1); x++) {
        const i = y * w + x; if (!mask[i]) continue;
        const a = lab[i - 1], b = lab[i - w];
        if (!a && !b) { lab[i] = next; parent.push(next); next++; }
        else if (a && b) { const ra = find(a), rb = find(b); lab[i] = ra < rb ? ra : rb; if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb); }
        else lab[i] = a || b;
        if (next > 4000) break;
      }
    }
    const blobs = new Map();
    for (let y = Math.max(1, y0); y < Math.min(h - 1, y1); y++) {
      for (let x = Math.max(1, x0); x < Math.min(w - 1, x1); x++) {
        const l = lab[y * w + x]; if (!l) continue;
        const r = find(l);
        let B = blobs.get(r); if (!B) { B = { n: 0, sx: 0, sy: 0, x0: x, x1: x, y0: y, y1: y }; blobs.set(r, B); }
        B.n++; B.sx += x; B.sy += y; if (x < B.x0) B.x0 = x; if (x > B.x1) B.x1 = x; if (y < B.y0) B.y0 = y; if (y > B.y1) B.y1 = y;
      }
    }
    const out = [], maxA = opts.maxArea ?? 400;
    for (const B of blobs.values()) {
      if (B.n < (opts.minArea ?? 1) || B.n > maxA) continue;
      const bw = B.x1 - B.x0 + 1, bh = B.y1 - B.y0 + 1, asp = Math.max(bw, bh) / Math.min(bw, bh);
      if (asp > 7) continue;
      const u = B.sx / B.n, v = B.sy / B.n;
      let inside = false;
      for (const e of exclude) if (u > e[0] && u < e[2] && v > e[1] && v < e[3]) { inside = true; break; }
      if (inside) continue;
      out.push({ u, v, area: B.n, w: bw, h: bh });
    }
    return out.sort((a, b) => b.area - a.area).slice(0, 12);
  }
}

/** Constant-acceleration tracks in image space; the longest consistent one is the ball. */
class BallTracker {
  constructor() { this.tracks = []; this.nextId = 1; this.best = null; this.history = []; }
  reset() { this.tracks = []; this.best = null; this.history = []; }
  update(t, cands, scale = 1) {
    const gate0 = 60 * scale;
    for (const T of this.tracks) {
      const dt = t - T.t, p = T.pts;
      let pu = T.u + T.vu * dt, pv = T.v + T.vv * dt + 0.5 * T.av * dt * dt;
      let best = null, bd = gate0 * (1 + T.miss * 0.6) * (p.length < 3 ? 1.8 : 1);
      for (const c of cands) { if (c.used) continue; const d = Math.hypot(c.u - pu, c.v - pv); if (d < bd) { bd = d; best = c; } }
      if (best) {
        best.used = true;
        const nvu = (best.u - T.u) / dt, nvv = (best.v - T.v) / dt;
        T.av = p.length >= 2 ? 0.6 * T.av + 0.4 * ((nvv - T.vv) / dt) : 0;
        T.vu = p.length >= 1 ? 0.5 * T.vu + 0.5 * nvu : nvu; T.vv = p.length >= 1 ? 0.5 * T.vv + 0.5 * nvv : nvv;
        T.u = best.u; T.v = best.v; T.t = t; T.miss = 0; T.hits++;
        p.push({ t, u: best.u, v: best.v, area: best.area });
        if (p.length > 90) p.shift();
      } else { T.miss++; }
    }
    this.tracks = this.tracks.filter((T) => T.miss < 6);
    for (const c of cands) if (!c.used && this.tracks.length < 24) this.tracks.push({ id: this.nextId++, u: c.u, v: c.v, vu: 0, vv: 0, av: 0, t, miss: 0, hits: 1, pts: [{ t, u: c.u, v: c.v, area: c.area }] });
    // the ball: a track that MOVES (players' noise blobs jitter in place) and has lived
    let best = null, bs = 0;
    for (const T of this.tracks) {
      if (T.hits < 3 || T.miss > 2) continue;
      const sp = Math.hypot(T.vu, T.vv), s = T.hits * Math.min(1, sp / (120 * scale)) * (T.id === this.best?.id ? 1.5 : 1);
      if (s > bs) { bs = s; best = T; }
    }
    this.best = best;
    const pt = best && best.miss === 0 ? { t, u: best.u, v: best.v } : null;
    if (pt) { this.history.push(pt); if (this.history.length > 600) this.history.shift(); }
    return pt;
  }
  /** Samples of the ball between two times. */
  between(t0, t1) { return this.history.filter((p) => p.t >= t0 && p.t <= t1); }
}

// ------------------------------------------------------------------------------- pose
const MP_VERSION = '1.0.1';
const MP_CDN = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MP_VERSION}`;
const MP_MODELS = {
  lite: 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task',
  full: 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/1/pose_landmarker_full.task',
};
class PoseManager {
  constructor() { this.near = null; this.far = null; this.vision = null; this.crop = document.createElement('canvas'); this.cctx = this.crop.getContext('2d'); this.lastFar = null; this.ready = false; this.status = 'off'; this.t = 0; this.fails = 0; }
  async load(model = 'full', onStatus = () => {}) {
    if (this.ready) return true;
    const timeout = (ms) => new Promise((_, rej) => setTimeout(() => rej(new Error('The pose model did not load in time. Check the internet connection.')), ms));
    onStatus('Loading pose models (about 9 MB, once)');
    const { FilesetResolver, PoseLandmarker } = await Promise.race([import(MP_CDN), timeout(40000)]);
    this.vision = await Promise.race([FilesetResolver.forVisionTasks(MP_CDN + '/wasm'), timeout(40000)]);
    const make = (delegate, numPoses) => PoseLandmarker.createFromOptions(this.vision, { baseOptions: { modelAssetPath: MP_MODELS[model] || MP_MODELS.full, delegate }, runningMode: 'VIDEO', numPoses, minPoseDetectionConfidence: 0.35, minPosePresenceConfidence: 0.35, minTrackingConfidence: 0.4 });
    let delegate = 'GPU';
    try { this.near = await Promise.race([make('GPU', 2), timeout(40000)]); }
    catch (e) { console.warn('[gt] GPU delegate failed, using CPU', e); delegate = 'CPU'; this.near = await make('CPU', 2); }
    this.far = await make(delegate, 2);
    this.delegate = delegate; this.ready = true; this.status = 'ready';
    onStatus(`Pose ready (${model}, ${delegate})`);
    return true;
  }
  /**
   * Detect both players. Returns { near, far } each { lm: [[x,y,vis]] normalised to the
   * full frame, world: [[x,y,z]] metres hip-centred (MediaPipe convention), box } or null.
   */
  detect(source, w, h, cam, nowMs, which = 'both') {
    if (!this.ready) return { near: null, far: null };
    const ts = Math.max(this.t + 1, Math.round(nowMs)); this.t = ts;
    const out = { near: null, far: null };
    const onCourt = (lm, wantNear) => {
      // feet → ground; the near player stands on y < NET, the far one on y > NET (with run-off)
      if (!cam) return 1;
      const ax = (lm[27][0] + lm[28][0]) / 2 * w, ay = Math.max(lm[27][1], lm[28][1]) * h;
      const g = cam.atHeight(ax, ay, 0); if (!g) return 0;
      const inX = Math.abs(g[0]) < CT.D + 3, inY = wantNear ? g[1] > -6 && g[1] < CT.NET : g[1] > CT.NET && g[1] < CT.L + 7;
      return inX && inY ? 1 : 0;
    };
    try {
      if (which !== 'far') {
        const r = this.near.detectForVideo(source, ts);
        let pick = null, ps = -1;
        (r.landmarks || []).forEach((lm, k) => { const sc = onCourt(lm, true) * (boxOf(lm)[3] - boxOf(lm)[1]); if (sc > ps) { ps = sc; pick = k; } });
        if (pick !== null && ps > 0) out.near = { lm: r.landmarks[pick].map((p) => [p.x, p.y, p.visibility ?? 1]), world: r.worldLandmarks?.[pick]?.map((p) => [p.x, p.y, p.z]) ?? null };
      }
      if (which !== 'near') {
        // crop the far half: from the calibration if we have one, else the band above centre
        let box;
        if (this.lastFar) { const b = this.lastFar; const cx = (b[0] + b[2]) / 2, cy = (b[1] + b[3]) / 2, s = Math.max(b[2] - b[0], b[3] - b[1]) * 2.6; box = [cx - s / 2, cy - s * 0.55, cx + s / 2, cy + s * 0.45]; }
        else if (cam) { const pts = [[-CT.D - 2, CT.NET + 1.5, 0], [CT.D + 2, CT.NET + 1.5, 0], [-CT.D - 2, CT.L + 4, 2.6], [CT.D + 2, CT.L + 4, 2.6], [-CT.D - 2, CT.L + 4, 0], [CT.D + 2, CT.L + 4, 0]].map((p) => cam.project(p)); box = [Math.min(...pts.map((p) => p[0])) / w, Math.min(...pts.map((p) => p[1])) / h, Math.max(...pts.map((p) => p[0])) / w, Math.max(...pts.map((p) => p[1])) / h]; }
        else box = [0.2, 0.1, 0.8, 0.5];
        box = [clamp(box[0], 0, 1), clamp(box[1], 0, 1), clamp(box[2], 0, 1), clamp(box[3], 0, 1)];
        const bw = (box[2] - box[0]) * w, bh = (box[3] - box[1]) * h;
        if (bw > 8 && bh > 8) {
          const S = 512 / Math.max(bw, bh);
          this.crop.width = Math.round(bw * S); this.crop.height = Math.round(bh * S);
          this.cctx.drawImage(source, box[0] * w, box[1] * h, bw, bh, 0, 0, this.crop.width, this.crop.height);
          const r = this.far.detectForVideo(this.crop, ts);
          let pick = null, ps = -1;
          const back = (lm) => lm.map((p) => [box[0] + p.x * (box[2] - box[0]), box[1] + p.y * (box[3] - box[1]), p.visibility ?? 1]);
          (r.landmarks || []).forEach((lm, k) => { const full = back(lm); const sc = onCourt(full, false) * (boxOf(full)[3] - boxOf(full)[1]); if (sc > ps) { ps = sc; pick = k; } });
          if (pick !== null && ps > 0) { const full = back(r.landmarks[pick]); out.far = { lm: full, world: r.worldLandmarks?.[pick]?.map((p) => [p.x, p.y, p.z]) ?? null }; this.lastFar = boxOf(full); }
          else this.lastFar = null;
        }
      }
      this.fails = 0;
    } catch (e) { this.fails++; console.warn('[gt] pose detect failed', e); }
    return out;
  }
}
function boxOf(lm) { let x0 = 1, y0 = 1, x1 = 0, y1 = 0; for (const p of lm) { if ((p[2] ?? 1) < 0.2) continue; if (p[0] < x0) x0 = p[0]; if (p[0] > x1) x1 = p[0]; if (p[1] < y0) y0 = p[1]; if (p[1] > y1) y1 = p[1]; } return [x0, y0, x1, y1]; }

/** One-euro-ish smoothing of a landmark set (keeps fast swings, kills jitter). */
class LmSmoother {
  constructor(a = 0.55) { this.a = a; this.prev = null; }
  push(lm) { if (!lm) { this.prev = null; return null; } if (!this.prev) { this.prev = lm.map((p) => p.slice()); return this.prev; } const a = this.a; this.prev = lm.map((p, i) => { const q = this.prev[i], d = Math.hypot(p[0] - q[0], p[1] - q[1]), k = clamp(a + d * 25, a, 1); return [q[0] + (p[0] - q[0]) * k, q[1] + (p[1] - q[1]) * k, p[2]]; }); return this.prev; }
}

// ------------------------------------------------------------------------------- form
/** Upright 3-D points (index 2 = up). MediaPipe world: y is DOWN and z toward the camera. */
function uprightFromMp(world) { return world ? world.map((p) => [p[0], p[2], -p[1]]) : null; }
function angle3(a, b, c) { const u = V.sub(a, b), w = V.sub(c, b); const d = V.dot(u, w) / ((V.len(u) * V.len(w)) || 1); return Math.acos(clamp(d, -1, 1)) / DEG; }
function kneeAngles(P) { return [angle3(P[23], P[25], P[27]), angle3(P[24], P[26], P[28])]; }
function hipShoulderSep(P) {
  const a1 = Math.atan2(P[12][1] - P[11][1], P[12][0] - P[11][0]), a2 = Math.atan2(P[24][1] - P[23][1], P[24][0] - P[23][0]);
  let d = (a1 - a2) / DEG; while (d > 180) d -= 360; while (d < -180) d += 360; return Math.abs(d);
}
function stanceRatio(P) { const fa = Math.hypot(P[27][0] - P[28][0], P[27][1] - P[28][1]), hw = Math.hypot(P[23][0] - P[24][0], P[23][1] - P[24][1]); return hw > 0.01 ? fa / hw : null; }
function hipHeight(P) { return (P[23][2] + P[24][2]) / 2; }

/**
 * Body-shape numbers for one stroke from a buffer of upright 3-D frames {t, P}.
 * tc = contact time. Serve adds trophy-knee; groundstrokes add load and separation.
 */
function strokeForm(buf, tc, kind, oppContactT) {
  const win = buf.filter((f) => f.t >= tc - 0.75 && f.t <= tc + 0.05 && f.P);
  if (win.length < 2) return null;
  const form = {};
  let kmin = 181, sep = 0;
  for (const f of win) { const [a, b] = kneeAngles(f.P); kmin = Math.min(kmin, a, b); sep = Math.max(sep, hipShoulderSep(f.P)); }
  const atC = win.reduce((best, f) => (Math.abs(f.t - tc) < Math.abs(best.t - tc) ? f : best), win[0]);
  if (kind === 'serve') {
    const pre = win.filter((f) => f.t < tc - 0.08);
    form.trophyKnee = pre.length ? Math.round(Math.min(...pre.map((f) => Math.min(...kneeAngles(f.P))))) : null;
  } else {
    form.kneeMin = Math.round(kmin);
    form.sep = Math.round(sep);
    form.stance = atC ? Math.round(stanceRatio(atC.P) * 10) / 10 : null;
  }
  // split step: a small hop of the hips just before the opponent struck the ball
  if (oppContactT != null) {
    const sw = buf.filter((f) => f.t >= oppContactT - 0.45 && f.t <= oppContactT + 0.25 && f.P);
    if (sw.length >= 3) { const hs = sw.map((f) => hipHeight(f.P)); const base = Math.min(hs[0], hs[hs.length - 1]); form.splitStep = Math.max(...hs) - base > 0.035; }
  }
  return form;
}

// ------------------------------------------------------------------------------- clips
/**
 * Pose history per player, so a trend can be shown as the body moving, not a number.
 * Frames are stored normalised to the frame (x, y in 0..1) at ~15 fps.
 */
class ClipStore {
  constructor() { this.buf = [[], []]; this.shots = new Map(); }
  push(who, t, lm) { const b = this.buf[who]; const last = b[b.length - 1]; if (last && t - last.t < 1 / 16) return; b.push({ t, lm: lm.map((p) => [Math.round(p[0] * 1e4) / 1e4, Math.round(p[1] * 1e4) / 1e4, Math.round((p[2] ?? 1) * 100) / 100]) }); while (b.length && t - b[0].t > 14) b.shift(); }
  /** Keep the frames around a stroke, keyed by point n and shot index. */
  keepShot(n, i, who, tc) { const fr = this.buf[who].filter((f) => f.t >= tc - 0.9 && f.t <= tc + 0.5); if (fr.length >= 4) { this.shots.set(`${n}:${i}`, { who, tc, frames: fr }); if (this.shots.size > 160) this.shots.delete(this.shots.keys().next().value); } }
  /**
   * A clip for a trend: each referenced stroke, re-centred on the hips and scaled by the
   * torso so the body shape (not where on court it happened) is what you see.
   */
  build(refs, title, who) {
    const seqs = refs.map((r) => this.shots.get(`${r.n}:${r.i}`)).filter(Boolean);
    if (!seqs.length) return null;
    const frames = [];
    for (const s of seqs) {
      for (const f of s.frames) {
        const L = f.lm, hx = (L[23][0] + L[24][0]) / 2, hy = (L[23][1] + L[24][1]) / 2, sx = (L[11][0] + L[12][0]) / 2, sy = (L[11][1] + L[12][1]) / 2;
        const torso = Math.hypot(sx - hx, sy - hy) || 0.05, k = 0.22 / torso;
        frames.push(L.map((p) => [Math.round((0.5 + (p[0] - hx) * k) * 1000) / 1000, Math.round((0.58 + (p[1] - hy) * k) * 1000) / 1000, p[2]]));
      }
      frames.push(null); // a beat between strokes
    }
    return { w: 1, h: 1, fps: 15, title, who, frames: frames.map((f) => f || frames[0]) };
  }
}
