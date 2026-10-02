/* tracker/engine.js — court geometry, the camera model, ball physics, and the demo match.
 *
 * World frame (metres): x across the court (0 = centre line, + to the camera's right),
 * y down the court from the CAMERA-SIDE baseline (0) to the far baseline (23.77), z up.
 * Image frame: u right, v down, pixels.
 */

const CT = { L: 23.77, S: 4.115, D: 5.485, NET: 11.885, SVC: 6.4, netH: 0.914, postH: 1.07, postX: 5.029 };
CT.nearSvc = CT.NET - CT.SVC;   // 5.485
CT.farSvc = CT.NET + CT.SVC;    // 18.285
const MPH = 2.23694;
const DEG = Math.PI / 180;

// ---------- small vector kit
const V = {
  add: (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]],
  sub: (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]],
  mul: (a, s) => [a[0] * s, a[1] * s, a[2] * s],
  dot: (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
  cross: (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]],
  len: (a) => Math.hypot(a[0], a[1], a[2]),
  norm: (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; },
  lerp: (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t],
};
const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
const lerp = (a, b, t) => a + (b - a) * t;
const smooth = (t) => { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); };

// ---------- camera: a pinhole with the principal point at the image centre
class Camera {
  /** R rows are the camera's right, down and forward axes in world coordinates. */
  constructor(w, h, f, R, C) { this.w = w; this.h = h; this.f = f; this.R = R; this.C = C; this.cx = w / 2; this.cy = h / 2; }
  static lookAt(w, h, hfovDeg, C, target, rollDeg = 0) {
    const f = (w / 2) / Math.tan((hfovDeg / 2) * DEG);
    const fwd = V.norm(V.sub(target, C));
    let right = V.norm(V.cross(fwd, [0, 0, 1]));
    let down = V.cross(fwd, right);
    if (rollDeg) {
      const c = Math.cos(rollDeg * DEG), s = Math.sin(rollDeg * DEG);
      const r2 = V.add(V.mul(right, c), V.mul(down, s)), d2 = V.add(V.mul(down, c), V.mul(right, -s));
      right = r2; down = d2;
    }
    return new Camera(w, h, f, [right, down, fwd], C);
  }
  /** World point → [u, v, depth]. depth <= 0 means behind the camera. */
  project(p) {
    const d = V.sub(p, this.C), R = this.R;
    const x = V.dot(d, R[0]), y = V.dot(d, R[1]), z = V.dot(d, R[2]);
    return [this.cx + (this.f * x) / z, this.cy + (this.f * y) / z, z];
  }
  ray(u, v) {
    const x = (u - this.cx) / this.f, y = (v - this.cy) / this.f, R = this.R;
    return V.norm([R[0][0] * x + R[1][0] * y + R[2][0], R[0][1] * x + R[1][1] * y + R[2][1], R[0][2] * x + R[1][2] * y + R[2][2]]);
  }
  /** Where the pixel's ray meets the plane z = height. */
  atHeight(u, v, z = 0) {
    const d = this.ray(u, v);
    if (Math.abs(d[2]) < 1e-6) return null;
    const s = (z - this.C[2]) / d[2];
    if (s <= 0) return null;
    return [this.C[0] + d[0] * s, this.C[1] + d[1] * s, z];
  }
  /** Pixels per metre for something at world point p (for size gates). */
  scaleAt(p) { const q = this.project(p); return q[2] > 0 ? this.f / q[2] : 0; }
  rescaled(w, h) { const k = w / this.w; return new Camera(w, h, this.f * k, this.R, this.C); }
}

/** The geometry the coach is told to set up: back fence, ~3.2 m behind the baseline,
 *  arm's reach above head height (~2.35 m), 0.5x lens (about 108 degrees across). */
function defaultCamera(w, h) {
  return Camera.lookAt(w, h, 108, [0.15, -3.2, 2.35], [0, 9.2, 0], -0.6);
}

// ---------- homography and calibration from the four singles corners
function solveLinear(A, b) {
  const n = b.length, M = A.map((r, i) => [...r, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c; for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (Math.abs(M[p][c]) < 1e-12) return null;
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const k = M[r][c] / M[c][c];
      for (let j = c; j <= n; j++) M[r][j] -= k * M[c][j];
    }
  }
  return M.map((r, i) => r[n] / r[i]);
}
/** world [x,y] → image [u,v] homography from >= 4 correspondences (least squares). */
function homography(world, img) {
  const AtA = Array.from({ length: 8 }, () => new Array(8).fill(0)), Atb = new Array(8).fill(0);
  const add = (row, rhs) => { for (let i = 0; i < 8; i++) { Atb[i] += row[i] * rhs; for (let j = 0; j < 8; j++) AtA[i][j] += row[i] * row[j]; } };
  for (let i = 0; i < world.length; i++) {
    const [x, y] = world[i], [u, v] = img[i];
    add([x, y, 1, 0, 0, 0, -u * x, -u * y], u);
    add([0, 0, 0, x, y, 1, -v * x, -v * y], v);
  }
  const h = solveLinear(AtA, Atb);
  return h ? [[h[0], h[1], h[2]], [h[3], h[4], h[5]], [h[6], h[7], 1]] : null;
}
function applyH(H, x, y) { const w = H[2][0] * x + H[2][1] * y + H[2][2]; return [(H[0][0] * x + H[0][1] * y + H[0][2]) / w, (H[1][0] * x + H[1][1] * y + H[1][2]) / w]; }

const SINGLES_CORNERS = [[-CT.S, 0], [CT.S, 0], [CT.S, CT.L], [-CT.S, CT.L]];

/**
 * Full camera from the court. The homography of the ground plane carries the camera's
 * rotation, position and focal length (Zhang's constraints with the principal point at the
 * image centre), so four taps are enough to put a ball's pixel back into metres.
 */
const SERVICE_SET = [[-CT.S, CT.nearSvc], [CT.S, CT.nearSvc], [CT.S, CT.L], [-CT.S, CT.L]];
function calibrate(imgPts, w, h, hfovGuess = 108, world = SINGLES_CORNERS) {
  const H = homography(world, imgPts);
  if (!H) return null;
  const cx = w / 2, cy = h / 2;
  const Hp = [0, 1, 2].map((c) => [H[0][c] - cx * H[2][c], H[1][c] - cy * H[2][c], H[2][c]]); // columns, centred
  const [a, b] = Hp;
  const a1 = a[0] * b[0] + a[1] * b[1], b1 = a[2] * b[2];
  const a2 = a[0] * a[0] + a[1] * a[1] - b[0] * b[0] - b[1] * b[1], b2 = a[2] * a[2] - b[2] * b[2];
  const q = -(a1 * b1 + a2 * b2) / (a1 * a1 + a2 * a2 || 1);   // q = 1 / f^2
  let f = q > 0 ? 1 / Math.sqrt(q) : 0;
  const fGuess = (w / 2) / Math.tan((hfovGuess / 2) * DEG);
  if (!(f > 0.25 * w && f < 2.5 * w)) f = fGuess;
  const m = (col) => [col[0] / f, col[1] / f, col[2]];
  let m1 = m(Hp[0]), m2 = m(Hp[1]), m3 = m(Hp[2]);
  let lam = 2 / (V.len(m1) + V.len(m2));
  if (m3[2] * lam < 0) lam = -lam;                           // the court is in front of the camera
  let r1 = V.mul(m1, lam), r2 = V.mul(m2, lam);
  r1 = V.norm(r1); r2 = V.norm(V.sub(r2, V.mul(r1, V.dot(r1, r2)))); // Gram-Schmidt
  const r3 = V.cross(r1, r2), t = V.mul(m3, lam);
  // R (world->camera) has columns r1 r2 r3, so its ROWS are the camera axes in world coords.
  const R = [[r1[0], r2[0], r3[0]], [r1[1], r2[1], r3[1]], [r1[2], r2[2], r3[2]]];
  const C = [-(R[0][0] * t[0] + R[1][0] * t[1] + R[2][0] * t[2]), -(R[0][1] * t[0] + R[1][1] * t[1] + R[2][1] * t[2]), -(R[0][2] * t[0] + R[1][2] * t[1] + R[2][2] * t[2])];
  const cam = new Camera(w, h, f, R, C);
  cam.H = H;
  // Reprojection error of the four taps, in pixels: the honesty number shown after calibrating.
  cam.calErr = imgPts.reduce((s, p, i) => { const q = cam.project([world[i][0], world[i][1], 0]); return s + Math.hypot(q[0] - p[0], q[1] - p[1]); }, 0) / 4;
  return cam;
}

// ---------- ball aerodynamics (Cross & Lindsey; Goodwill, Chin & Haake for Cd/Cl ranges)
const BALL_R = 0.0335, KAERO = (0.5 * 1.21 * Math.PI * BALL_R * BALL_R) / 0.0577; // 1/m
const GRAV = 9.81;
function aeroAccel(v, rpm) {
  const sp = Math.hypot(v[0], v[1], v[2]) || 1e-6;
  const w = (Math.abs(rpm) * 2 * Math.PI) / 60, S = (BALL_R * w) / sp;
  const cd = 0.55 + 0.12 * Math.min(S, 0.5);                    // spin adds a little drag
  const cl = rpm === 0 ? 0 : Math.sign(rpm) / (2 + 1 / Math.max(S, 1e-3));
  const vh = Math.hypot(v[0], v[1]) || 1e-6, hx = v[0] / vh, hy = v[1] / vh;
  // Perpendicular to v in its vertical plane, pointing "down" for topspin.
  const n = [(hx * v[2]) / sp, (hy * v[2]) / sp, -vh / sp];
  const kd = KAERO * cd * sp, kl = KAERO * cl * sp * sp;
  return [-kd * v[0] + kl * n[0], -kd * v[1] + kl * n[1], -GRAV - kd * v[2] + kl * n[2]];
}
function netHeightAt(x) { const ax = Math.min(Math.abs(x), CT.postX); return CT.netH + (CT.postH - CT.netH) * (ax / CT.postX) ** 2; }

/** Integrate a flight until it lands. Records samples every `rec` seconds. */
function fly(p0, v0, rpm, { dt = 0.004, tmax = 4, rec = 1 / 120 } = {}) {
  let p = p0.slice(), v = v0.slice(), t = 0, nextRec = 0;
  const pts = [];
  let netClear = null, hitNet = false;
  const dirY = Math.sign(v0[1]) || 1;
  while (t < tmax) {
    if (t >= nextRec) { pts.push([t, p[0], p[1], p[2]]); nextRec += rec; }
    // RK2 (midpoint) is plenty at 4 ms against drag and lift this size.
    const a1 = aeroAccel(v, rpm);
    const vm = V.add(v, V.mul(a1, dt / 2)), pm = V.add(p, V.mul(v, dt / 2));
    const a2 = aeroAccel(vm, rpm);
    const pn = V.add(p, V.mul(vm, dt)), vn = V.add(v, V.mul(a2, dt));
    // crossing the net plane?
    if ((p[1] - CT.NET) * (pn[1] - CT.NET) <= 0 && p[1] !== pn[1]) {
      const k = (CT.NET - p[1]) / (pn[1] - p[1]), x = lerp(p[0], pn[0], k), z = lerp(p[2], pn[2], k);
      netClear = z - BALL_R - netHeightAt(x);
      if (netClear < 0 && Math.abs(x) < CT.postX + 0.1) { hitNet = true; pts.push([t + dt * k, x, CT.NET - dirY * 0.05, z]); return { pts, land: null, netClear, hitNet, tNet: t + dt * k, pNet: [x, CT.NET, z] }; }
    }
    if (pn[2] <= BALL_R && vn[2] < 0) {
      const k = (p[2] - BALL_R) / (p[2] - pn[2] || 1);
      const tl = t + dt * k, land = [lerp(p[0], pn[0], k), lerp(p[1], pn[1], k), BALL_R];
      pts.push([tl, land[0], land[1], land[2]]);
      return { pts, land: { t: tl, x: land[0], y: land[1], v: V.lerp(v, vn, k) }, netClear, hitNet };
    }
    p = pn; v = vn; t += dt;
  }
  return { pts, land: null, netClear, hitNet };
}

/** Bounce off the court: vertical restitution ~0.75, horizontal friction; topspin kicks. */
function bounce(v, rpm) {
  const vh = Math.hypot(v[0], v[1]) || 1e-6, k = clamp(0.66 + rpm / 26000, 0.5, 0.82);
  return { v: [v[0] * k, v[1] * k, -v[2] * 0.76], rpm: rpm * 0.55 };
}

/** Elevation that lands a ball of this speed and spin on the target (bisection). */
function launchTo(p0, target, speed, rpm, high = false) {
  const dx = target[0] - p0[0], dy = target[1] - p0[1], dist = Math.hypot(dx, dy), hx = dx / dist, hy = dy / dist;
  const reach = (el) => { const r = fly(p0, [hx * speed * Math.cos(el), hy * speed * Math.cos(el), speed * Math.sin(el)], rpm, { rec: 9 }); return r.land ? Math.hypot(r.land.x - p0[0], r.land.y - p0[1]) : (r.hitNet ? 0 : 99); };
  let lo = -0.35, hi = high ? 1.1 : 0.55;
  if (high) lo = 0.45;
  for (let i = 0; i < 26; i++) { const mid = (lo + hi) / 2, r = reach(mid); if ((r < dist) !== high) lo = mid; else hi = mid; }
  const el = (lo + hi) / 2;
  return [hx * speed * Math.cos(el), hy * speed * Math.cos(el), speed * Math.sin(el)];
}

/**
 * Fit one flight (hit → bounce) to what the camera saw, in two stages.
 *  1. PACE from the two events: the launch speed and elevation that carry the ball from
 *     the contact point to the bounce in the observed flight time. Well conditioned even
 *     from straight behind the court, where depth is the hard axis for a camera.
 *  2. ARC: elevation and spin refined against the tracked pixels, with the speed held
 *     close to stage 1. Topspin shows up as a ball that dips faster than drag alone allows.
 * Pixel residuals are truncated at 18 px so a mis-associated blob cannot drag the answer.
 */
function fitShot(cam, obs, hit, bnc, kind = 'ground') {
  const dx = bnc.x - hit.x, dy = bnc.y - hit.y, dist = Math.hypot(dx, dy);
  const T = bnc.t - hit.t;
  if (!(T > 0.12) || dist < 2) return null;
  const hx = dx / dist, hy = dy / dist, p0 = [hit.x, hit.y, hit.z];
  const run = (s, el, rpm, tmax) => fly(p0, [hx * s * Math.cos(el), hy * s * Math.cos(el), s * Math.sin(el)], rpm, { rec: 1 / 240, tmax });
  const land = (r) => (r.land ? ((r.land.x - bnc.x) ** 2 + (r.land.y - bnc.y) ** 2) * 4 + ((r.land.t - T) * 40) ** 2 : 1e8);
  // ---- stage 1: pace (spin at a typical value for the stroke)
  const rpm0 = kind === 'serve' ? 1200 : 1800;
  const c1 = ([s, el]) => (s < 3 || s > 80 || el < -0.6 || el > 1.2 ? 1e9 : land(run(s, el, rpm0, T + 0.5)));
  const s0 = (dist / T) * 1.12, el0 = Math.atan2(GRAV * T * T / 2 - hit.z, dist) * 0.8;
  const st1 = nelderMead(c1, [s0, el0], [3, 0.06], 90);
  // ---- stage 2: arc and spin against the pixels
  const usable = cam ? obs.filter((o) => o.t > hit.t + 0.02 && o.t < bnc.t - 0.02) : [];
  let best = { x: [st1.x[0], st1.x[1], rpm0 / 1000], f: st1.f };
  if (usable.length >= 5) {
    const c2 = ([s, el, rk]) => {
      if (s < 3 || s > 80 || el < -0.6 || el > 1.2 || rk < -4 || rk > 6) return 1e9;
      const r = run(s, el, rk * 1000, T + 0.5); if (!r.land) return 1e8;
      let e = 0;
      for (const o of usable) {
        const i = Math.min(r.pts.length - 1, Math.max(0, Math.round((o.t - hit.t) * 240)));
        const q = cam.project([r.pts[i][1], r.pts[i][2], r.pts[i][3]]);
        e += Math.min(18 * 18, (q[0] - o.u) ** 2 + (q[1] - o.v) ** 2);
      }
      return land(r) + (e / usable.length) * 0.08 + ((s - st1.x[0]) / (0.06 * st1.x[0])) ** 2;
    };
    best = nelderMead(c2, [st1.x[0], st1.x[1], rpm0 / 1000], [1.2, 0.05, 1.2], 140);
  }
  const [s, el, rk] = best.x;
  const r = run(s, el, rk * 1000, 4);
  return { speed: s * MPH, rpm: Math.round(rk * 1000), el: el / DEG, netClear: r.netClear, err: best.f, path: r.pts, n: usable.length };
}
function nelderMead(f, x0, step, iters) {
  const n = x0.length;
  let pts = [x0, ...x0.map((_, i) => x0.map((v, j) => (j === i ? v + step[i] : v)))].map((x) => ({ x, f: f(x) }));
  for (let it = 0; it < iters; it++) {
    pts.sort((a, b) => a.f - b.f);
    const c = new Array(n).fill(0);
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) c[j] += pts[i].x[j] / n;
    const w = pts[n], at = (k) => c.map((v, j) => v + k * (w.x[j] - v));
    const xr = at(-1), fr = f(xr);
    if (fr < pts[0].f) { const xe = at(-2), fe = f(xe); pts[n] = fe < fr ? { x: xe, f: fe } : { x: xr, f: fr }; }
    else if (fr < pts[n - 1].f) pts[n] = { x: xr, f: fr };
    else {
      const xc = at(0.5), fc = f(xc);
      if (fc < w.f) pts[n] = { x: xc, f: fc };
      else pts = pts.map((p, i) => (i === 0 ? p : { x: p.x.map((v, j) => pts[0].x[j] + 0.5 * (v - pts[0].x[j])), f: 0 })).map((p, i) => (i === 0 ? p : { x: p.x, f: f(p.x) }));
    }
  }
  pts.sort((a, b) => a.f - b.f);
  return pts[0];
}

/** Racket-head speed from the impact: v_out = e*v_in + (1+e)*v_racket, e ~ 0.42 near the sweet spot. */
function swingFromImpact(outMph, inMph) { const e = 0.42; return Math.max(0, (outMph - e * (inMph || 0)) / (1 + e)); }

// ---------- court zones used by the stats
function depthOf(by, bounceY, receiverAtFar) {
  // Depth measured from the RECEIVING baseline: deep = within 3 m, short = inside the service line.
  const fromBase = receiverAtFar ? CT.L - bounceY : bounceY;
  if (fromBase < 0) return 'out';
  if (fromBase <= 3.0) return 'deep';
  if (fromBase <= CT.L / 2 - CT.SVC) return 'mid';   // 5.485 m: up to the service line
  return 'short';
}
function directionOf(fromX, toX, hitterAtNear) {
  // Cross-court = across the centre line from the hitter's side; middle third = MID.
  if (Math.abs(toX) < 1.37) return 'MID';
  return Math.sign(toX) !== Math.sign(fromX || 0.001) ? 'CC' : 'DTL';
}
function servePlacement(bx, side, serverAtNear) {
  // Distance from the centre line inside the box: T (inner third), Body, Wide (outer third).
  const a = Math.abs(bx);
  return a < 1.37 ? 'T' : a < 2.74 ? 'Body' : 'Wide';
}
function inServiceBox(x, y, side, serverAtNear) {
  // Near server serves into the far boxes. Deuce side = server's right = +x for the near
  // server, so the target box is the far court's x < 0 half (receiver's right).
  const far = serverAtNear;
  const yOk = far ? y >= CT.NET && y <= CT.farSvc : y <= CT.NET && y >= CT.nearSvc;
  const wantNeg = far ? side === 'deuce' : side === 'ad';
  const xOk = wantNeg ? x <= 0.02 && x >= -CT.S : x >= -0.02 && x <= CT.S;
  return yOk && xOk;
}
function inSingles(x, y) { return Math.abs(x) <= CT.S + 0.02 && y >= -0.02 && y <= CT.L + 0.02; }

// ======================================================================================
// The demo match: a seeded simulation with two articulated players, real ball physics,
// and a coaching story baked into its numbers (a backhand that leaks errors, a serve that
// loses its knee bend as fatigue builds, an opponent who loves the T on the deuce side).
// ======================================================================================
function rng(seed) { let s = seed >>> 0 || 1; return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; }; }

// MediaPipe pose landmark indices, so the demo feeds the same code as the camera.
const LM = { nose: 0, lEar: 7, rEar: 8, lSh: 11, rSh: 12, lEl: 13, rEl: 14, lWr: 15, rWr: 16, lHip: 23, rHip: 24, lKn: 25, rKn: 26, lAn: 27, rAn: 28, lHeel: 29, rHeel: 30, lToe: 31, rToe: 32 };

/** Two-bone IK: the middle joint, bending toward `hint`. */
function ik(a, c, l1, l2, hint) {
  const d = V.sub(c, a), dl = clamp(V.len(d), 0.01, l1 + l2 - 1e-4), dn = V.norm(d);
  const x = (l1 * l1 - l2 * l2 + dl * dl) / (2 * dl), y = Math.sqrt(Math.max(0, l1 * l1 - x * x));
  let pd = V.sub(hint, V.mul(dn, V.dot(hint, dn)));
  pd = V.len(pd) < 1e-6 ? [0, 0, 1] : V.norm(pd);
  return V.add(V.add(a, V.mul(dn, x)), V.mul(pd, y));
}

/**
 * A body pose for player state P → 33 world points. Right-handed players; a two-handed
 * backhand. `P.act` is { kind: 'ready'|'fh'|'bh'|'serve'|'run', ph: 0..1 }.
 */
function bodyPoints(P) {
  const H = P.height || 1.85, k = H / 1.85;
  const f = [Math.sin(P.face), Math.cos(P.face), 0], r = [Math.cos(P.face), -Math.sin(P.face), 0], up = [0, 0, 1];
  const at = (o, fw, rt, z) => [o[0] + f[0] * fw + r[0] * rt, o[1] + f[1] * fw + r[1] * rt, o[2] + z];
  const base = [P.x, P.y, P.hop || 0];
  const act = P.act || { kind: 'ready', ph: 0 };
  let crouch = P.crouch ?? 0.35, turn = 0, lean = 0.05, stance = P.stance ?? 0.32;
  // ---- arms: wrist targets in the body frame (forward, right, height)
  let wR = [0.32, 0.12, 0.95], wL = [0.3, -0.05, 0.98], elHintR = [0, 0.6, -1], elHintL = [0, -0.6, -1];
  const ph = act.ph;
  if (act.kind === 'fh') {
    // unit turn, racket back, then a low-to-high swing through contact at ph 0.55
    if (ph < 0.45) { const t = smooth(ph / 0.45); turn = -1.15 * t; wR = [lerp(0.3, -0.35, t), lerp(0.12, 0.62, t), lerp(0.95, 1.05, t)]; wL = [lerp(0.3, 0.42, t), lerp(-0.05, 0.25, t), 1.2]; crouch = lerp(crouch, 0.62, t); }
    else if (ph < 0.62) { const t = (ph - 0.45) / 0.17; turn = lerp(-1.15, 0.25, t); wR = [lerp(-0.35, 0.55, t), lerp(0.62, 0.38, t), lerp(0.8, 1.05, t)]; wL = [0.25, -0.25, 1.05]; crouch = lerp(0.62, 0.45, t); }
    else { const t = smooth((ph - 0.62) / 0.38); turn = lerp(0.25, 0.85, t); wR = [lerp(0.55, 0.1, t), lerp(0.38, -0.35, t), lerp(1.05, 1.62, t)]; wL = [0.15, -0.3, 1.15]; crouch = lerp(0.45, 0.32, t); }
    stance = 0.42;
  } else if (act.kind === 'bh') {
    if (ph < 0.45) { const t = smooth(ph / 0.45); turn = 1.2 * t; wR = [lerp(0.3, -0.25, t), lerp(0.1, -0.55, t), lerp(0.95, 1.0, t)]; wL = [lerp(0.3, -0.3, t), lerp(-0.05, -0.62, t), lerp(0.98, 1.0, t)]; crouch = lerp(crouch, (P.bhLoad ?? 0.6), t); }
    else if (ph < 0.62) { const t = (ph - 0.45) / 0.17; turn = lerp(1.2, -0.2, t); wR = [lerp(-0.25, 0.5, t), lerp(-0.55, -0.32, t), lerp(0.85, 1.0, t)]; wL = [lerp(-0.3, 0.45, t), lerp(-0.62, -0.42, t), lerp(0.85, 1.0, t)]; crouch = lerp(0.6, 0.45, t); }
    else { const t = smooth((ph - 0.62) / 0.38); turn = lerp(-0.2, -0.85, t); wR = [lerp(0.5, 0.05, t), lerp(-0.32, 0.38, t), lerp(1.0, 1.6, t)]; wL = [lerp(0.45, 0.05, t), lerp(-0.42, 0.3, t), lerp(1.0, 1.55, t)]; crouch = lerp(0.45, 0.32, t); }
    stance = 0.42;
  } else if (act.kind === 'serve') {
    const trophyKnee = P.trophyLoad ?? 0.75;   // 0..1 knee load at the trophy position
    if (ph < 0.3) { const t = smooth(ph / 0.3); wL = [lerp(0.3, 0.25, t), lerp(-0.1, -0.15, t), lerp(1.0, 2.45, t)]; wR = [lerp(0.2, -0.25, t), lerp(0.1, 0.35, t), lerp(1.0, 1.25, t)]; turn = -0.9 * t; crouch = lerp(0.2, trophyKnee * 0.6, t); lean = 0.1; }
    else if (ph < 0.5) { const t = smooth((ph - 0.3) / 0.2); wL = [0.25, -0.15, lerp(2.45, 2.2, t)]; wR = [lerp(-0.25, -0.35, t), lerp(0.35, 0.3, t), lerp(1.25, 1.75, t)]; elHintR = [-0.5, 1, 1]; turn = -0.9; crouch = lerp(trophyKnee * 0.6, trophyKnee, t); lean = -0.05; }
    else if (ph < 0.6) { const t = (ph - 0.5) / 0.1; wL = [lerp(0.25, 0.3, t), lerp(-0.15, -0.1, t), lerp(2.2, 1.3, t)]; wR = [lerp(-0.35, 0.35, t), lerp(0.3, 0.1, t), lerp(1.75, 2.45, t)]; elHintR = [0, 1, 1]; turn = lerp(-0.9, 0.2, t); crouch = lerp(trophyKnee, 0.0, t); lean = lerp(-0.05, 0.12, t); }
    else { const t = smooth((ph - 0.6) / 0.4); wL = [0.2, -0.25, lerp(1.3, 0.9, t)]; wR = [lerp(0.35, 0.25, t), lerp(0.1, -0.45, t), lerp(2.45, 0.85, t)]; turn = lerp(0.2, 0.75, t); crouch = lerp(0.0, 0.35, t); lean = lerp(0.12, 0.3, t); }
    stance = 0.3;
  } else if (act.kind === 'run') {
    const s = Math.sin(ph * Math.PI * 2);
    wR = [0.25 + 0.15 * s, 0.25, 0.95]; wL = [0.25 - 0.15 * s, -0.2, 0.98]; crouch = 0.3; lean = 0.18;
  }
  crouch = clamp(crouch + (P.crouchAdd || 0), 0, 1);
  // ---- legs
  const legLen = 0.93 * k, hipH = (0.95 - 0.2 * crouch) * k;
  const hipC = at(base, -0.05 * crouch, 0, hipH);
  const hr = [Math.cos(P.face + turn * 0.45), -Math.sin(P.face + turn * 0.45), 0];
  const hipL = V.add(hipC, V.mul(hr, -0.13 * k)), hipR = V.add(hipC, V.mul(hr, 0.13 * k));
  const runSwing = act.kind === 'run' ? Math.sin(ph * Math.PI * 2) * 0.32 : 0;
  const footL = at(base, runSwing - 0.04, -stance * k, 0.0 + (act.kind === 'run' ? Math.max(0, Math.sin(ph * Math.PI * 2)) * 0.12 : 0));
  const footR = at(base, -runSwing + 0.04, stance * k, 0.0 + (act.kind === 'run' ? Math.max(0, -Math.sin(ph * Math.PI * 2)) * 0.12 : 0));
  const ankL = [footL[0], footL[1], footL[2] + 0.08 * k], ankR = [footR[0], footR[1], footR[2] + 0.08 * k];
  const kneeL = ik(hipL, ankL, 0.47 * k, 0.45 * k, V.add(f, [0, 0, 0.1])), kneeR = ik(hipR, ankR, 0.47 * k, 0.45 * k, V.add(f, [0, 0, 0.1]));
  void legLen;
  // ---- trunk with rotation (turn) and lean
  const sr = [Math.cos(P.face + turn), -Math.sin(P.face + turn), 0], sf = [Math.sin(P.face + turn), Math.cos(P.face + turn), 0];
  const shC = V.add(hipC, V.add(V.mul(sf, lean * 0.5 * k), [0, 0, 0.55 * k]));
  const shL = V.add(shC, V.mul(sr, -0.2 * k)), shR = V.add(shC, V.mul(sr, 0.2 * k));
  const head = V.add(shC, V.add(V.mul(sf, 0.05 * k), [0, 0, 0.24 * k]));
  // ---- arms (wrist targets are in the HIP frame rotated by the shoulder turn)
  const bodyPt = (q) => V.add([base[0], base[1], 0], V.add(V.add(V.mul(sf, q[0] * k), V.mul(sr, q[1] * k)), [0, 0, q[2] * k + (P.hop || 0)]));
  const wristR = bodyPt(wR), wristL = bodyPt(wL);
  const elbR = ik(shR, wristR, 0.3 * k, 0.28 * k, V.add(V.mul(sr, elHintR[1]), V.add(V.mul(sf, elHintR[0]), [0, 0, elHintR[2]])));
  const elbL = ik(shL, wristL, 0.3 * k, 0.28 * k, V.add(V.mul(sr, elHintL[1]), V.add(V.mul(sf, elHintL[0]), [0, 0, elHintL[2]])));
  const pts = new Array(33);
  const ear = (s) => V.add(head, V.mul(sr, 0.075 * s * k));
  pts[0] = V.add(head, V.mul(sf, 0.09 * k));
  for (let i = 1; i <= 6; i++) pts[i] = V.add(V.add(head, V.mul(sf, 0.08 * k)), V.add(V.mul(sr, (i <= 3 ? -1 : 1) * 0.035 * k), [0, 0, 0.03 * k]));
  pts[7] = ear(-1); pts[8] = ear(1);
  pts[9] = V.add(pts[0], V.add(V.mul(sr, -0.025 * k), [0, 0, -0.05 * k])); pts[10] = V.add(pts[0], V.add(V.mul(sr, 0.025 * k), [0, 0, -0.05 * k]));
  pts[11] = shL; pts[12] = shR; pts[13] = elbL; pts[14] = elbR; pts[15] = wristL; pts[16] = wristR;
  const hand = (w, e, s) => V.add(w, V.mul(V.norm(V.sub(w, e)), 0.07 * k * s));
  pts[17] = hand(wristL, elbL, 1); pts[19] = hand(wristL, elbL, 1.1); pts[21] = hand(wristL, elbL, 0.6);
  pts[18] = hand(wristR, elbR, 1); pts[20] = hand(wristR, elbR, 1.1); pts[22] = hand(wristR, elbR, 0.6);
  pts[23] = hipL; pts[24] = hipR; pts[25] = kneeL; pts[26] = kneeR; pts[27] = ankL; pts[28] = ankR;
  pts[29] = at(footL, -0.08, 0, 0.03); pts[30] = at(footR, -0.08, 0, 0.03);
  pts[31] = at(footL, 0.17, 0, 0.02); pts[32] = at(footR, 0.17, 0, 0.02);
  return { pts, head, racketDir: act.kind === 'serve' && ph > 0.3 && ph < 0.52 ? [0, 0, -1] : V.norm(V.sub(wristR, elbR)) };
}

/** Demo players. P0 = Geneva (ours), P1 = opponent. Each has a profile with the story. */
function makeProfiles() {
  return [
    { name: 'Geneva', s1: 88, s2: 71, s1In: 0.64, ace: 0.08, sw: 0.1, fhErr: 0.07, bhErr: 0.09, win: 0.09, speed: 58, spin: 2100, deepP: 0.45, shirt: '#B8964F', shorts: '#16161A', skin: '#C88B62', height: 1.86, serveT: { deuce: [0.3, 0.3, 0.4], ad: [0.45, 0.25, 0.3] } },
    { name: 'Opponent', s1: 84, s2: 69, s1In: 0.6, ace: 0.06, sw: 0.09, fhErr: 0.08, bhErr: 0.07, win: 0.08, speed: 55, spin: 1800, deepP: 0.4, shirt: '#2F6DB5', shorts: '#F2F2F2', skin: '#8D5B3F', height: 1.83, serveT: { deuce: [0.15, 0.15, 0.7], ad: [0.4, 0.3, 0.3] } },
  ];
}

class DemoMatch {
  constructor({ seed = 7, firstServer = 0, nearAtStart = 0, format, names }) {
    this.rand = rng(seed);
    this.prof = makeProfiles();
    if (names) { this.prof[0].name = names[0]; this.prof[1].name = names[1]; }
    this.score = new MatchScore(format, firstServer, nearAtStart);
    this.t = 0; this.events = []; this.pointNo = 0; this.servesHit = [0, 0];
    this.players = [0, 1].map((i) => ({ i, x: 0, y: 0, face: 0, act: { kind: 'ready', ph: 0 }, hop: 0, crouch: 0.35, vx: 0, vy: 0, target: null, height: this.prof[i].height }));
    this.ball = null; this.shadow = true; this.trail = [];
    this.phase = 'between'; this.phaseT = 0.6; this.plan = null; this.truth = null;
    this.placePlayersForPoint();
  }
  nearOf(p) { return this.score.near === p; }
  /** Server and receiver to their spots for the next point. */
  placePlayersForPoint() {
    const sc = this.score, srv = sc.server, side = sc.side;
    for (const P of this.players) {
      const near = this.nearOf(P.i), sgn = near ? 1 : -1;                // the near player faces +y
      P.face = near ? 0 : Math.PI;
      const isSrv = P.i === srv;
      // The deuce court is each player's OWN right: +x for the near player (facing +y),
      // -x for the far one. Server and receiver both stand on their own deuce/ad half.
      const sideSign = (side === 'deuce' ? 1 : -1) * sgn;
      P.x = sideSign * (isSrv ? 0.75 : 3.0);
      P.y = near ? (isSrv ? -0.15 : -1.2) : (isSrv ? CT.L + 0.15 : CT.L + 1.2);
      P.act = { kind: 'ready', ph: 0 }; P.hop = 0; P.target = null; P.crouch = 0.35;
    }
  }
  /** Decide how the next point goes (truth), with the demo's story baked into the odds. */
  planPoint() {
    const R = this.rand, sc = this.score, srv = sc.server, rcv = 1 - srv, prof = this.prof;
    const n = this.pointNo, story = Math.min(1, n / 40);   // 0 → 1 across the first ~40 points
    const ps = prof[srv];
    const serves = [];
    const s1In = clamp(ps.s1In - (srv === 0 ? 0.12 * story : 0), 0.3, 0.8);
    const first = R() < s1In;
    const placeOf = (side) => { const w = ps.serveT[side], x = R(); return x < w[0] ? 'Wide' : x < w[0] + w[1] ? 'Body' : 'T'; };
    const s1 = { no: 1, speed: ps.s1 + (R() - 0.5) * 9 - (srv === 0 ? 7 * story : 0), place: placeOf(sc.side), rpm: 900 + R() * 700, fault: first ? null : (R() < 0.5 ? 'net' : R() < 0.5 ? 'long' : 'wide') };
    serves.push(s1);
    let df = false;
    if (!first) {
      const in2 = R() < 0.91 - (srv === 0 ? 0.05 * story : 0);
      serves.push({ no: 2, speed: ps.s2 + (R() - 0.5) * 7, place: placeOf(sc.side), rpm: 2400 + R() * 900, fault: in2 ? null : (R() < 0.5 ? 'net' : 'long') });
      df = !in2;
    }
    const inServe = serves[serves.length - 1];
    let outcome, winner, endedBy, rally = [], wing = null, netApproach = null;
    if (df) { outcome = 'df'; winner = rcv; endedBy = srv; }
    else {
      const aceP = inServe.no === 1 ? ps.ace + (srv === 1 && sc.side === 'deuce' && inServe.place === 'T' ? 0.08 : 0) : 0.015;
      const r = R();
      if (r < aceP) { outcome = 'ace'; winner = srv; endedBy = srv; }
      else if (r < aceP + (inServe.no === 1 ? ps.sw : 0.04)) { outcome = 'serviceWinner'; winner = srv; endedBy = srv; rally.push({ who: rcv, fail: true }); }
      else {
        // rally: alternate shots until someone ends it
        let who = rcv, len = 1;
        for (;;) {
          len++;
          const p = prof[who];
          const isBh = R() < (who === 1 ? 0.55 : 0.48);
          const pressure = Math.min(1, len / 14);
          const errP = (isBh ? p.bhErr + (who === 0 ? 0.09 * story : 0) : p.fhErr) * (1 + pressure);
          const winP = p.win * (1 + 0.6 * pressure) * (len > 3 ? 1 : 0.4);
          const x = R();
          const shot = { who, wing: isBh ? 'BH' : 'FH' };
          if (x < errP) { const forced = R() < 0.3; shot.end = forced ? 'fe' : 'ue'; shot.miss = R() < 0.55 ? 'net' : R() < 0.5 ? 'long' : 'wide'; rally.push(shot); outcome = shot.end; winner = 1 - who; endedBy = who; wing = shot.wing; break; }
          if (x < errP + winP || len > 22) { shot.end = 'winner'; rally.push(shot); outcome = 'winner'; winner = who; endedBy = who; wing = shot.wing; if (R() < 0.25) netApproach = who; break; }
          rally.push(shot);
          who = 1 - who;
        }
      }
    }
    this.plan = { serves, rally, outcome, winner, endedBy, wing, netApproach, srv, rcv, df };
  }
}

// The executor and renderer live on the prototype to keep the class body readable.
Object.assign(DemoMatch.prototype, {
  /** Advance the simulation by dt seconds. Returns events that happened. */
  step(dt) {
    const out = [];
    this.t += dt;
    if (this.phase === 'between') {
      this.phaseT -= dt;
      if (this.phaseT <= 0) { this.placePlayersForPoint(); this.planPoint(); this.startPoint(); out.push({ type: 'pointStart', t: this.t }); }
      this.animatePlayers(dt);
      return out;
    }
    // queued scripted events (serve motion, hits)
    while (this.queue.length && this.queue[0].t <= this.t) { const ev = this.queue.shift(); ev.run(out); }
    // ball flight
    if (this.ball) {
      const B = this.ball;
      B.age += dt;
      while (B.k < B.path.length - 1 && B.path[B.k + 1][0] <= B.age) B.k++;
      const a = B.path[B.k], b = B.path[Math.min(B.k + 1, B.path.length - 1)];
      const kk = b[0] > a[0] ? clamp((B.age - a[0]) / (b[0] - a[0]), 0, 1) : 0;
      B.p = [lerp(a[1], b[1], kk), lerp(a[2], b[2], kk), lerp(a[3], b[3], kk)];
      this.trail.push([this.t, ...B.p]); if (this.trail.length > 40) this.trail.shift();
      if (B.onLand && B.age >= B.landAt) { const f = B.onLand; B.onLand = null; f(out); }
      if (B.age > B.path[B.path.length - 1][0] + 0.02 && B.after) { const f = B.after; B.after = null; f(out); }
    }
    this.animatePlayers(dt);
    if (this.phase === 'ending') { this.phaseT -= dt; if (this.phaseT <= 0) this.finishPoint(out); }
    return out;
  },
  startPoint() {
    this.phase = 'point'; this.queue = []; this.ball = null; this.trail = []; this.pointT0 = this.t;
    this.truthShots = []; this.serveIdx = 0;
    this.scheduleServe(this.t + 0.6);
  },
  serverContact(srv) {
    const P = this.players[srv], near = this.nearOf(srv);
    return [P.x + (near ? 0.05 : -0.05), P.y + (near ? 0.35 : -0.35), 2.72 * (P.height / 1.85)];
  },
  scheduleServe(t0) {
    const pl = this.plan, srv = pl.srv, sv = pl.serves[this.serveIdx], P = this.players[srv], prof = this.prof[srv];
    const motion = 1.15;  // toss → contact
    const n = this.servesHit[srv];
    // The fatigue story: our player's trophy-position knee load fades as the match goes on.
    P.trophyLoad = srv === 0 ? clamp(0.95 - n * 0.022, 0.3, 0.95) + (this.rand() - 0.5) * 0.06 : 0.8 + (this.rand() - 0.5) * 0.1;
    this.queue.push({ t: t0, run: () => { P.act = { kind: 'serve', ph: 0, t0, dur: 1.9 }; } });
    this.queue.push({ t: t0 + 0.1, run: () => { // the toss
      const c = this.serverContact(srv), base = [c[0] - (this.nearOf(srv) ? 0 : 0), c[1], 1.5];
      const path = []; for (let i = 0; i <= 60; i++) { const tt = i / 60 * 1.3, z = 1.5 + 4.9 * tt - 4.905 * tt * tt * 1.08; path.push([tt, base[0], base[1], Math.max(0.05, z)]); }
      this.ball = { path, k: 0, age: 0, p: path[0].slice(1), rpm: 0, toss: true };
    } });
    this.queue.push({ t: t0 + motion, run: (out) => this.hitServe(sv, out) });
    this.servesHit[srv]++;
    void prof;
  },
  serveTarget(sv) {
    const sc = this.score, srvNear = this.nearOf(this.plan.srv), side = sc.side, R = this.rand;
    // Target box: near server → far box; deuce = x < 0 for the near server.
    const sgnBox = (srvNear ? (side === 'deuce' ? -1 : 1) : (side === 'deuce' ? 1 : -1));
    const ax = sv.place === 'T' ? 0.35 + R() * 0.6 : sv.place === 'Body' ? 1.6 + R() * 0.7 : 3.0 + R() * 0.8;
    let y = srvNear ? CT.farSvc - 0.6 - R() * 1.6 : CT.nearSvc + 0.6 + R() * 1.6;
    let x = sgnBox * ax;
    if (sv.fault === 'long') y += srvNear ? 0.5 + R() * 0.8 : -(0.5 + R() * 0.8);
    if (sv.fault === 'wide') x = sgnBox * (CT.S + 0.25 + R() * 0.6);
    if (sv.fault === 'net') y = CT.NET + (srvNear ? 0.6 : -0.6);
    return [x, y];
  },
  hitServe(sv, out) {
    const pl = this.plan, srv = pl.srv, c = this.serverContact(srv);
    const tgt = this.serveTarget(sv), speed = sv.speed / MPH;
    let v0 = launchTo(c, tgt, speed, sv.rpm);
    if (sv.fault === 'net') v0 = [v0[0], v0[1], v0[2] - 1.2];
    const r = fly(c, v0, sv.rpm);
    this.lastHitT = this.t;
    out.push({ type: 'hit', t: this.t, who: srv, kind: 'serve', serveNo: sv.no, pos: c, speedTrue: sv.speed, rpmTrue: sv.rpm });
    this.truthShots.push({ i: this.truthShots.length, who: srv, kind: 'serve', wing: null, speed: sv.speed, spin: sv.rpm, t: this.t - this.pointT0 });
    const land = r.land;
    this.ball = { path: r.pts, k: 0, age: 0, p: c, rpm: sv.rpm, landAt: land ? land.t : 99 };
    const rcv = 1 - srv;
    if (sv.fault) {
      this.ball.onLand = (o) => { o.push({ type: 'bounce', t: this.t, x: land.x, y: land.y, fault: true }); };
      this.ball.after = (o) => {
        if (sv.no === 1) { this.serveIdx = 1; this.ball = null; this.queue.push({ t: this.t + 1.2, run: () => { this.placeServerAgain(); this.scheduleServe(this.t + 0.4); } }); o.push({ type: 'fault', t: this.t, serveNo: 1 }); }
        else { o.push({ type: 'fault', t: this.t, serveNo: 2 }); this.endPoint(o); }
      };
      if (r.hitNet) { this.ball.after = this.ball.after; this.ball.path.push([r.pts[r.pts.length - 1][0] + 0.5, r.pNet[0], CT.NET - (this.nearOf(srv) ? 0.4 : -0.4), BALL_R]); }
      return;
    }
    // the serve is in; set up the bounce and what happens after it
    this.ball.onLand = (o) => { o.push({ type: 'bounce', t: this.t, x: land.x, y: land.y, serve: true, placement: sv.place }); this.afterBounce(land, sv.rpm, rcv, o, pl.outcome === 'ace' || pl.outcome === 'serviceWinner', 0); };
    this.serveSpeedIn = sv.speed;
    const P = this.players[rcv]; P.target = this.predictContact(r, land, sv.rpm, rcv);
    this.queue.push({ t: this.t + 0.05, run: () => this.splitStep(rcv) });
  },
  placeServerAgain() { const P = this.players[this.plan.srv]; P.act = { kind: 'ready', ph: 0 }; },
  splitStep(i) { const P = this.players[i]; P.hopT = 0.28; P.splitSeen = i === 0 ? this.rand() > 0.15 + 0.35 * Math.min(1, this.pointNo / 40) : this.rand() > 0.12; },
  /** Where the receiver will meet the ball: after the bounce, descending through ~1 m. */
  predictContact(r, land, rpm, who) {
    if (!land) return null;
    const b = bounce(land.v, rpm), p0 = [land.x, land.y, BALL_R];
    const after = fly(p0, b.v, b.rpm, { rec: 1 / 120, tmax: 3 });
    let best = after.pts[after.pts.length - 1];
    for (let i = 1; i < after.pts.length; i++) { const q = after.pts[i], pq = after.pts[i - 1]; if (q[3] < pq[3] && (pq[3] >= 0.75 || q[3] <= 0.6)) { best = q; break; } }
    return { t: this.t + (land.t - this.ball.age) + best[0], x: best[1], y: best[2], z: best[3], path2: after, rpm2: b.rpm, landV: b.v };
  },
  afterBounce(land, rpm, receiver, out, unreturned, shotIdx) {
    const b = bounce(land.v, rpm), p0 = [land.x, land.y, BALL_R];
    const after = fly(p0, b.v, b.rpm, { rec: 1 / 120, tmax: 3 });
    const P = this.players[receiver];
    if (unreturned || !P.target) {
      // ace / winner: the ball runs on past the player; second bounce ends the point
      this.ball = { path: after.pts, k: 0, age: 0, p: p0, rpm: b.rpm, landAt: after.land ? after.land.t : 99 };
      this.ball.onLand = (o) => { if (after.land) o.push({ type: 'bounce', t: this.t, x: after.land.x, y: after.land.y, second: true }); };
      this.ball.after = (o) => this.endPoint(o);
      if (P.target) P.target.reach = false;
      return;
    }
    // play it: the ball follows the post-bounce path until the receiver's contact time
    const ct = P.target;
    const cut = after.pts.findIndex((q) => q[1] === ct.x && q[2] === ct.y) ;
    const path = cut > 0 ? after.pts.slice(0, cut + 1) : after.pts;
    this.ball = { path, k: 0, age: 0, p: p0, rpm: b.rpm, landAt: 99 };
    const tContact = this.t + (path[path.length - 1][0]);
    this.queue.push({ t: tContact - 0.42, run: () => { P.act = { kind: this.nextWing(receiver) === 'FH' ? 'fh' : 'bh', ph: 0, t0: tContact - 0.42, dur: 0.95 }; } });
    this.queue.push({ t: tContact, run: (o) => this.rallyHit(receiver, [ct.x, ct.y, ct.z], ct.landV, o, shotIdx + 1) });
  },
  nextWing(who) { const sh = this.plan.rally.find((s, k) => k >= (this.rallyIdx || 0) && s.who === who); return sh ? sh.wing : 'FH'; },
  rallyHit(who, pos, vin, out, shotIdx) {
    const pl = this.plan, R = this.rand;
    this.rallyIdx = this.rallyIdx || 0;
    const shot = pl.rally[this.rallyIdx++];
    if (!shot) { this.endPoint(out); return; }
    if (shot.fail) { this.endPoint(out); return; }   // service winner: touched, no reply
    const prof = this.prof[who], near = this.nearOf(who);
    const opp = 1 - who;
    // target: depth and direction by profile; errors aim outside or into the net
    const deep = R() < prof.deepP - (who === 0 ? 0.15 * Math.min(1, this.pointNo / 40) : 0);
    const depthM = deep ? 1.0 + R() * 1.8 : shot.end === 'winner' ? 2 + R() * 3 : 3.2 + R() * 3.2;
    let ty = near ? CT.L - depthM : depthM;
    const dir = R(); let tx = dir < 0.5 ? -Math.sign(pos[0] || 1) * (1.8 + R() * 1.9) : dir < 0.75 ? (R() - 0.5) * 2 : Math.sign(pos[0] || 1) * (1.6 + R() * 2.2);
    if (shot.end === 'winner') tx = Math.sign(tx || 1) * (2.9 + R() * 1.0);
    if (shot.miss === 'long') ty = near ? CT.L + 0.4 + R() * 1.2 : -(0.4 + R() * 1.2);
    if (shot.miss === 'wide') tx = Math.sign(tx || 1) * (CT.S + 0.3 + R() * 0.9);
    const speed = (prof.speed + (R() - 0.4) * 14 + (shot.end === 'winner' ? 10 : 0)) / MPH;
    const rpm = shot.wing === 'BH' && R() < 0.2 ? -(800 + R() * 900) : prof.spin * (0.7 + R() * 0.6);
    let v0 = launchTo(pos, [tx, ty], speed, rpm);
    if (shot.miss === 'net') v0 = [v0[0], v0[1], v0[2] - 2.2];
    const r = fly(pos, v0, rpm);
    const vinMph = vin ? Math.hypot(vin[0], vin[1], vin[2]) * MPH : 0;
    const speedMph = speed * MPH;
    out.push({ type: 'hit', t: this.t, who, kind: 'ground', wing: shot.wing, pos, speedTrue: speedMph, rpmTrue: rpm });
    this.truthShots.push({ i: this.truthShots.length, who, kind: 'ground', wing: shot.wing, speed: speedMph, spin: Math.round(rpm), swing: swingFromImpact(speedMph, vinMph * 0.6), t: this.t - this.pointT0 });
    const land = r.land;
    this.ball = { path: r.pts, k: 0, age: 0, p: pos, rpm, landAt: land ? land.t : 99 };
    const P = this.players[opp];
    if (r.hitNet || !land) { this.ball.after = (o) => { o.push({ type: 'net', t: this.t, who }); this.endPoint(o); }; return; }
    const inCourt = inSingles(land.x, land.y);
    this.queue.push({ t: this.t + 0.08, run: () => this.splitStep(opp) });
    if (!inCourt) {
      P.target = null;
      this.ball.onLand = (o) => o.push({ type: 'bounce', t: this.t, x: land.x, y: land.y, out: true });
      this.ball.after = (o) => this.endPoint(o);
      return;
    }
    P.target = this.predictContact(r, land, rpm, opp);
    const nextShot = pl.rally[this.rallyIdx];
    const unreturned = shot.end === 'winner' || !nextShot;
    if (unreturned && P.target) P.target.reach = false;
    this.ball.onLand = (o) => { o.push({ type: 'bounce', t: this.t, x: land.x, y: land.y }); this.afterBounce(land, rpm, opp, o, unreturned, shotIdx); };
  },
  endPoint(out) {
    if (this.phase !== 'point') return;
    this.phase = 'ending'; this.phaseT = 0.9;
    out.push({ type: 'deadBall', t: this.t });
  },
  /** The truth record for the point (what a perfect charter would write). */
  finishPoint(out) {
    const pl = this.plan, sc = this.score;
    const snap = sc.snapshot();
    const s1 = pl.serves[0], s2 = pl.serves[1];
    const rec = {
      ...snap, n: sc.history.length + 1,
      serve1In: !s1.fault, serveNo: s1.fault ? 2 : 1,
      serve1Speed: Math.round(s1.speed), serve2Speed: s2 ? Math.round(s2.speed) : null,
      placement: (s1.fault ? s2 : s1)?.place ?? null,
      outcome: pl.outcome, winner: pl.winner, endedBy: pl.endedBy, wing: pl.wing,
      finalKind: pl.outcome === 'ace' || pl.outcome === 'df' || pl.outcome === 'serviceWinner' ? 'serve' : 'ground',
      rally: pl.outcome === 'df' ? 0 : pl.outcome === 'ace' ? 1 : pl.outcome === 'serviceWinner' ? 1 : 1 + pl.rally.filter((s) => !s.fail).length,
      netApproach: pl.netApproach, at: Date.now(), src: 'auto', durSec: Math.round((this.t - this.pointT0) * 10) / 10,
    };
    this.pointNo++;
    out.push({ type: 'pointEnd', t: this.t, truth: rec, truthShots: this.truthShots });
    this.phase = 'between'; this.phaseT = 2.2; this.ball = null; this.rallyIdx = 0; this.trail = [];
  },
  animatePlayers(dt) {
    for (const P of this.players) {
      // run toward the contact point (offset to the forehand or backhand side)
      if (P.target && P.target.reach !== false) {
        const near = this.nearOf(P.i), wing = this.nextWing(P.i);
        const side = (wing === 'FH' ? 1 : -1) * (near ? 1 : -1) * 0.62;
        const tx = P.target.x - side, ty = P.target.y + (near ? -0.25 : 0.25);
        const dx = tx - P.x, dy = ty - P.y, d = Math.hypot(dx, dy), vmax = 6.2;
        if (d > 0.05) { const sp = Math.min(vmax, d * 4.5); P.x += (dx / d) * sp * dt; P.y += (dy / d) * sp * dt; if (P.act.kind === 'ready' || P.act.kind === 'run') P.act = { kind: 'run', ph: ((P.act.ph || 0) + dt * 2.4) % 1 }; }
        else if (P.act.kind === 'run') P.act = { kind: 'ready', ph: 0 };
      } else if (P.target && P.target.reach === false) {
        const dx = P.target.x - P.x; P.x += Math.sign(dx) * Math.min(Math.abs(dx), 3.5 * dt);
      }
      if (P.act.t0 !== undefined && P.act.dur) { P.act.ph = clamp((this.t - P.act.t0) / P.act.dur, 0, 1); if (P.act.ph >= 1) P.act = { kind: 'ready', ph: 0 }; }
      if (P.hopT > 0) { P.hopT -= dt; P.hop = P.splitSeen === false ? 0 : Math.max(0, Math.sin((1 - P.hopT / 0.28) * Math.PI)) * 0.09; } else P.hop = 0;
    }
  },
});

// ---------- rendering the demo frame through the fence camera
const SKY = ['#1d2730', '#26323b'];
function drawCourt(ctx, cam) {
  const W = cam.w, Hh = cam.h;
  // surroundings: a dark windscreen band, then the green apron
  const g = ctx.createLinearGradient(0, 0, 0, Hh);
  g.addColorStop(0, SKY[0]); g.addColorStop(0.3, SKY[1]); g.addColorStop(0.31, '#1f4a35'); g.addColorStop(1, '#2a5c40');
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, Hh);
  const poly = (pts, fill, stroke, lw) => {
    ctx.beginPath(); let ok = true;
    pts.forEach((p, i) => { const q = cam.project(p); if (q[2] <= 0.05) ok = false; i ? ctx.lineTo(q[0], q[1]) : ctx.moveTo(q[0], q[1]); });
    if (!ok) return; ctx.closePath(); if (fill) { ctx.fillStyle = fill; ctx.fill(); } if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = lw; ctx.stroke(); }
  };
  // windscreen at the far fence
  poly([[-14, CT.L + 6.5, 0], [14, CT.L + 6.5, 0], [14, CT.L + 6.5, 2.4], [-14, CT.L + 6.5, 2.4]], '#18301f');
  poly([[-12, -2.5, 0], [12, -2.5, 0], [12, CT.L + 6.4, 0], [-12, CT.L + 6.4, 0]], '#2f6b48');
  poly([[-CT.D - 1.2, -2.2, 0], [CT.D + 1.2, -2.2, 0], [CT.D + 1.2, CT.L + 2.2, 0], [-CT.D - 1.2, CT.L + 2.2, 0]], '#2c6a4b');
  poly([[-CT.D, 0, 0], [CT.D, 0, 0], [CT.D, CT.L, 0], [-CT.D, CT.L, 0]], '#2f5f9a');
  // lines (projected as thin quads so they thin with distance)
  const line = (x1, y1, x2, y2, wdt = 0.05) => {
    const dx = x2 - x1, dy = y2 - y1, l = Math.hypot(dx, dy), nx = (-dy / l) * wdt / 2, ny = (dx / l) * wdt / 2;
    poly([[x1 + nx, y1 + ny, 0.001], [x2 + nx, y2 + ny, 0.001], [x2 - nx, y2 - ny, 0.001], [x1 - nx, y1 - ny, 0.001]], '#eef2f5');
  };
  line(-CT.D, 0, CT.D, 0, 0.1); line(-CT.D, CT.L, CT.D, CT.L, 0.1);
  line(-CT.D, 0, -CT.D, CT.L); line(CT.D, 0, CT.D, CT.L); line(-CT.S, 0, -CT.S, CT.L); line(CT.S, 0, CT.S, CT.L);
  line(-CT.S, CT.nearSvc, CT.S, CT.nearSvc); line(-CT.S, CT.farSvc, CT.S, CT.farSvc); line(0, CT.nearSvc, 0, CT.farSvc);
  line(-0.0, 0, 0, 0.15); line(0, CT.L - 0.15, 0, CT.L);
}
function drawNet(ctx, cam) {
  const pts = [], N = 24;
  for (let i = 0; i <= N; i++) { const x = -CT.postX - 0.2 + (i / N) * (2 * CT.postX + 0.4); pts.push([x, CT.NET, netHeightAt(x)]); }
  ctx.beginPath();
  pts.forEach((p, i) => { const q = cam.project(p); i ? ctx.lineTo(q[0], q[1]) : ctx.moveTo(q[0], q[1]); });
  for (let i = N; i >= 0; i--) { const q = cam.project([pts[i][0], CT.NET, 0]); ctx.lineTo(q[0], q[1]); }
  ctx.closePath(); ctx.fillStyle = 'rgba(10,12,14,.55)'; ctx.fill();
  ctx.beginPath(); pts.forEach((p, i) => { const q = cam.project(p); i ? ctx.lineTo(q[0], q[1]) : ctx.moveTo(q[0], q[1]); });
  ctx.strokeStyle = '#f4f4f4'; ctx.lineWidth = Math.max(1.2, cam.scaleAt([0, CT.NET, 1]) * 0.06); ctx.stroke();
  for (const sx of [-1, 1]) { const a = cam.project([sx * (CT.postX + 0.2), CT.NET, 0]), b = cam.project([sx * (CT.postX + 0.2), CT.NET, CT.postH]); ctx.strokeStyle = '#d9d9d9'; ctx.lineWidth = 2.5; ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke(); }
}
function drawPlayer(ctx, cam, P, prof) {
  const body = bodyPoints(P), w = body.pts, pr = (p) => cam.project(p);
  const s = cam.scaleAt([P.x, P.y, 1]);
  const limb = (a, b, wd, col) => { const A = pr(a), B = pr(b); ctx.strokeStyle = col; ctx.lineWidth = Math.max(1.2, wd * s); ctx.lineCap = 'round'; ctx.beginPath(); ctx.moveTo(A[0], A[1]); ctx.lineTo(B[0], B[1]); ctx.stroke(); };
  // shadow
  const sh = pr([P.x, P.y, 0]);
  ctx.fillStyle = 'rgba(0,0,0,.28)'; ctx.beginPath(); ctx.ellipse(sh[0], sh[1], 0.45 * s, 0.14 * s, 0, 0, Math.PI * 2); ctx.fill();
  const far = cam.project([P.x, P.y, 1])[2];
  const shade = (hex, k) => hex; void far;
  // back leg, torso, front leg ordering is approximated by depth of the hips
  const legs = [[23, 25, 27, 31], [24, 26, 28, 32]].sort((a, b) => pr(w[b[0]])[2] - pr(w[a[0]])[2]);
  for (const [h, k, a, t] of legs) { limb(w[h], w[k], 0.15, prof.skin); limb(w[k], w[a], 0.12, prof.skin); limb(w[a], w[t], 0.1, '#f2f2f2'); }
  // shorts
  const S = [pr(w[23]), pr(w[24]), pr(V.lerp(w[24], w[26], 0.35)), pr(V.lerp(w[23], w[25], 0.35))];
  ctx.fillStyle = prof.shorts; ctx.beginPath(); S.forEach((q, i) => (i ? ctx.lineTo(q[0], q[1]) : ctx.moveTo(q[0], q[1]))); ctx.closePath(); ctx.fill();
  // torso
  const T = [pr(w[11]), pr(w[12]), pr(w[24]), pr(w[23])];
  ctx.fillStyle = shade(prof.shirt); ctx.strokeStyle = prof.shirt; ctx.lineWidth = Math.max(1, 0.1 * s); ctx.lineJoin = 'round';
  ctx.beginPath(); T.forEach((q, i) => (i ? ctx.lineTo(q[0], q[1]) : ctx.moveTo(q[0], q[1]))); ctx.closePath(); ctx.fill(); ctx.stroke();
  // arms
  limb(w[11], w[13], 0.1, prof.shirt); limb(w[13], w[15], 0.085, prof.skin);
  limb(w[12], w[14], 0.1, prof.shirt); limb(w[14], w[16], 0.085, prof.skin);
  // head
  const hd = pr(body.head); ctx.fillStyle = prof.skin; ctx.beginPath(); ctx.arc(hd[0], hd[1], Math.max(1.5, 0.11 * s), 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#121212'; ctx.beginPath(); ctx.arc(hd[0], hd[1] - 0.02 * s, Math.max(1.2, 0.105 * s), Math.PI, Math.PI * 2); ctx.fill();
  // racket
  const wr = w[16], dir = body.racketDir, head = V.add(wr, V.mul(dir, 0.5)), throat = V.add(wr, V.mul(dir, 0.24));
  limb(wr, throat, 0.035, '#1a1a1a');
  const rh = pr(head); ctx.strokeStyle = '#111'; ctx.lineWidth = Math.max(1, 0.025 * s);
  ctx.beginPath(); ctx.ellipse(rh[0], rh[1], Math.max(1.5, 0.15 * s), Math.max(1.2, 0.12 * s), 0, 0, Math.PI * 2); ctx.stroke();
  ctx.fillStyle = 'rgba(240,240,240,.25)'; ctx.fill();
  return body;
}
function drawBall(ctx, cam, B, prevP) {
  if (!B) return;
  const p = B.p, q = cam.project(p);
  if (q[2] <= 0) return;
  // Never smaller than 2 px: the demo renders at 720p, a phone films at 1080p-4K.
  const r = Math.max(2.0, (cam.f * BALL_R) / q[2]);
  // shadow on the court
  if (p[2] < 3) { const s = cam.project([p[0], p[1], 0]); ctx.fillStyle = `rgba(0,0,0,${0.35 * (1 - p[2] / 3)})`; ctx.beginPath(); ctx.ellipse(s[0], s[1], r * 1.2, r * 0.5, 0, 0, Math.PI * 2); ctx.fill(); }
  // motion streak (a 1/120 s exposure)
  if (prevP) { const a = cam.project(prevP); ctx.strokeStyle = 'rgba(221,245,74,.75)'; ctx.lineWidth = r * 1.7; ctx.lineCap = 'round'; ctx.beginPath(); ctx.moveTo(lerp(q[0], a[0], 0.35), lerp(q[1], a[1], 0.35)); ctx.lineTo(q[0], q[1]); ctx.stroke(); }
  ctx.fillStyle = '#E4FA55'; ctx.beginPath(); ctx.arc(q[0], q[1], r, 0, Math.PI * 2); ctx.fill();
}
function renderDemo(ctx, cam, sim) {
  drawCourt(ctx, cam);
  // draw the far player first, then the net, then the near player and ball by depth
  const order = [0, 1].sort((a, b) => sim.players[b].y - sim.players[a].y);
  const bodies = [];
  const farIdx = order[0], nearIdx = order[1];
  bodies[farIdx] = drawPlayer(ctx, cam, sim.players[farIdx], sim.prof[farIdx]);
  const ballFar = sim.ball && sim.ball.p[1] > CT.NET;
  if (ballFar) drawBall(ctx, cam, sim.ball, sim.trail.length > 1 ? sim.trail[sim.trail.length - 2].slice(1) : null);
  drawNet(ctx, cam);
  bodies[nearIdx] = drawPlayer(ctx, cam, sim.players[nearIdx], sim.prof[nearIdx]);
  if (!ballFar) drawBall(ctx, cam, sim.ball, sim.trail.length > 1 ? sim.trail[sim.trail.length - 2].slice(1) : null);
  return bodies;
}
