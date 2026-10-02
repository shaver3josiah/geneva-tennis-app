/**
 * Writes the celebration sound effects to assets/sfx/*.wav.
 *
 * The files keep the names they were first generated under (swish, fire, quake) even though
 * the celebrations they belong to are now Ace, On Fire and Smash: src/sfx.ts maps one to the
 * other, and renaming a binary changes nothing a player can hear.
 *
 * WHY SYNTHESIS. The app needs six short effects that match six named celebrations, and this
 * project ships nothing it did not make: a stock sound pack is a licence to read, an attribution
 * to carry, and a download. Every effect here is built from raw PCM samples by the functions
 * below, so the repo owns them outright and a change is a number in this file.
 *
 * Mono, 22.05 kHz, 16-bit — a phone speaker resolves nothing finer, and it keeps all six under
 * 200 KB together, which matters because they are bundled into the binary.
 *
 * `npm run sounds` writes them; `npm run check:sounds` fails if they are missing or stale, which
 * CI runs. Metro bundles .wav through require() with no config: it is in the default assetExts.
 */
import { writeFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, '..', 'assets', 'sfx');
const RATE = 22050;

// --- tiny synthesis kit -----------------------------------------------------
// Everything below works on a Float32Array of samples in -1..1 and is deliberately
// simple: no filters, no reverb, just envelopes over oscillators and noise.

const secs = (n) => Math.round(RATE * n);

/** Deterministic noise. Math.random would give a different file on every run, so the
 *  check-mode hash would never match twice. */
function makeNoise(seed) {
  let s = seed >>> 0;
  return () => {
    // xorshift32, mapped to -1..1
    s ^= s << 13; s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5; s >>>= 0;
    return (s / 0xffffffff) * 2 - 1;
  };
}

/** Attack-decay envelope with a shaped tail. `curve` above 1 makes the tail snap shut. */
const env = (t, len, attack, curve = 2) => {
  const x = t / len;
  if (x >= 1) return 0;
  const a = attack / len;
  return x < a ? x / a : Math.pow(1 - (x - a) / (1 - a), curve);
};

/** A pitch that slides from f0 to f1 over the sound. Phase is accumulated rather than
 *  computed from t*f, because f*t with a changing f sweeps the phase discontinuously and
 *  clicks. */
function sweep(buf, { f0, f1, len, attack = 0.005, gain = 0.5, curve = 2, shape = 'sine', at = 0 }) {
  let phase = 0;
  const n = secs(len);
  for (let i = 0; i < n; i++) {
    const x = i / n;
    const f = f0 + (f1 - f0) * x;
    phase += (2 * Math.PI * f) / RATE;
    const raw =
      shape === 'square' ? (Math.sin(phase) >= 0 ? 1 : -1)
      : shape === 'saw' ? ((phase / Math.PI) % 2) - 1
      : Math.sin(phase);
    const j = secs(at) + i;
    if (j < buf.length) buf[j] += raw * env(i, n, secs(attack) / n, curve) * gain;
  }
}

function noiseBurst(buf, { len, gain = 0.4, attack = 0.002, curve = 3, at = 0, seed = 7, tilt = 0 }) {
  const rnd = makeNoise(seed);
  const n = secs(len);
  let last = 0;
  for (let i = 0; i < n; i++) {
    let v = rnd();
    // `tilt` above 0 low-passes by averaging with the previous sample, which turns a hiss
    // into a rumble without needing a real filter.
    if (tilt > 0) { v = v * (1 - tilt) + last * tilt; last = v; }
    const j = secs(at) + i;
    if (j < buf.length) buf[j] += v * env(i, n, secs(attack) / n, curve) * gain;
  }
}

/** Clip softly rather than wrapping: two stacked layers can exceed 1 and a hard clip buzzes. */
const soft = (v) => Math.tanh(v * 1.1);

function wav(buf) {
  const data = Buffer.alloc(buf.length * 2);
  for (let i = 0; i < buf.length; i++) {
    const v = Math.max(-1, Math.min(1, soft(buf[i])));
    data.writeInt16LE(Math.round(v * 32767), i * 2);
  }
  const head = Buffer.alloc(44);
  head.write('RIFF', 0);
  head.writeUInt32LE(36 + data.length, 4);
  head.write('WAVE', 8);
  head.write('fmt ', 12);
  head.writeUInt32LE(16, 16);          // PCM chunk size
  head.writeUInt16LE(1, 20);           // format 1 = PCM
  head.writeUInt16LE(1, 22);           // mono
  head.writeUInt32LE(RATE, 24);
  head.writeUInt32LE(RATE * 2, 28);    // byte rate = rate * channels * bytesPerSample
  head.writeUInt16LE(2, 32);           // block align
  head.writeUInt16LE(16, 34);          // bits per sample
  head.write('data', 36);
  head.writeUInt32LE(data.length, 40);
  return Buffer.concat([head, data]);
}

// --- the six, each built to its own name ------------------------------------

const SOUNDS = {
  /** DONE. A clean two-note pluck. Nothing dramatic: it fires on every block. */
  spark: () => {
    const b = new Float32Array(secs(0.5));
    sweep(b, { f0: 660, f1: 660, len: 0.12, gain: 0.35, curve: 3 });
    sweep(b, { f0: 990, f1: 990, len: 0.26, gain: 0.3, curve: 3, at: 0.08 });
    return b;
  },

  /** ACE (swish.wav). Filtered noise tearing past the returner, then the thud of the ball landing. */
  swish: () => {
    const b = new Float32Array(secs(0.7));
    noiseBurst(b, { len: 0.34, gain: 0.5, curve: 2.2, seed: 11, tilt: 0.55 });
    sweep(b, { f0: 1800, f1: 420, len: 0.3, gain: 0.18, curve: 2.5 });
    sweep(b, { f0: 300, f1: 180, len: 0.22, gain: 0.3, curve: 3, at: 0.2 });
    return b;
  },

  /** ON FIRE (fire.wav). Crackle over a rising tone: something catching. */
  fire: () => {
    const b = new Float32Array(secs(0.9));
    noiseBurst(b, { len: 0.7, gain: 0.3, curve: 1.6, seed: 23, tilt: 0.25 });
    sweep(b, { f0: 220, f1: 880, len: 0.55, gain: 0.3, curve: 1.8 });
    for (let k = 0; k < 5; k++) {
      noiseBurst(b, { len: 0.05, gain: 0.22, curve: 4, at: 0.12 + k * 0.13, seed: 40 + k * 7 });
    }
    return b;
  },

  /** SMASH (quake.wav). An overhead: a hard crack, then a low rumble through the court. */
  quake: () => {
    const b = new Float32Array(secs(1.0));
    noiseBurst(b, { len: 0.18, gain: 0.55, curve: 3.5, seed: 31, tilt: 0.7 });
    sweep(b, { f0: 90, f1: 42, len: 0.7, gain: 0.55, curve: 2.2 });
    sweep(b, { f0: 430, f1: 400, len: 0.5, gain: 0.12, curve: 3, at: 0.06 });
    return b;
  },

  /** LIGHTS OUT. A zap down, then the room drops. */
  bolt: () => {
    const b = new Float32Array(secs(0.9));
    sweep(b, { f0: 2400, f1: 160, len: 0.22, gain: 0.4, curve: 2.5, shape: 'saw' });
    noiseBurst(b, { len: 0.12, gain: 0.45, curve: 4, seed: 57 });
    sweep(b, { f0: 150, f1: 55, len: 0.6, gain: 0.35, curve: 2, at: 0.16 });
    return b;
  },

  /** SUPERNOVA. Charge up, blow out, shimmer away. The only one that earns a full second. */
  nova: () => {
    const b = new Float32Array(secs(1.4));
    sweep(b, { f0: 180, f1: 1400, len: 0.45, gain: 0.3, curve: 0.6 });
    noiseBurst(b, { len: 0.55, gain: 0.55, curve: 2.4, at: 0.42, seed: 71, tilt: 0.4 });
    sweep(b, { f0: 70, f1: 40, len: 0.8, gain: 0.5, curve: 2, at: 0.42 });
    sweep(b, { f0: 1760, f1: 2640, len: 0.6, gain: 0.12, curve: 2.6, at: 0.5 });
    return b;
  },
};

const files = Object.entries(SOUNDS).map(([name, make]) => [`${name}.wav`, wav(make())]);
const sha = (b) => createHash('sha256').update(b).digest('hex').slice(0, 12);

if (process.argv.includes('--check')) {
  let bad = 0;
  for (const [name, buf] of files) {
    const p = join(OUT, name);
    if (!existsSync(p) || !readFileSync(p).equals(buf)) {
      console.error(`stale or missing: assets/sfx/${name}`);
      bad++;
    }
  }
  if (bad) {
    console.error('Run: npm run sounds');
    process.exit(1);
  }
  console.log(`sounds: ${files.length} files current`);
} else {
  mkdirSync(OUT, { recursive: true });
  for (const [name, buf] of files) {
    writeFileSync(join(OUT, name), buf);
    console.log(`${name.padEnd(12)} ${String(buf.length).padStart(7)} bytes  ${sha(buf)}`);
  }
}
