/**
 * Geneva Tennis brand assets, generated from one SVG mark.
 *
 * THE MARK. A tennis ball in Geneva gold whose seam is drawn as a bold "G", with two
 * tapering wind streaks pulled through the G's mouth: the Golden Tornadoes' swirl, and the
 * pace of a ball in flight. It is an original mark. The college's shield and the athletics
 * tornado are trademarks; use them only with Geneva's permission (pr@geneva.edu).
 *
 * Colours: Geneva web gold #C99A2C (geneva.edu / athletics.geneva.edu theme colour), New
 * Gold #DAAF48 for highlights, charcoal #232323 for the field, cream #FBF7EE for the seam.
 *
 *   node scripts/brand.mjs            write assets/*.png and store/play/*.png
 *   node scripts/brand.mjs --svg      also write the SVG sources to assets/brand/
 *
 * Needs @resvg/resvg-js (installed on demand into the OS temp dir, not a dependency of
 * the app): npm i --prefix "$TMP/gt-brand" @resvg/resvg-js@2
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const req = createRequire(join(process.env.RESVG_PREFIX || join(tmpdir(), 'gt-brand'), 'node_modules', 'x.js'));
const { Resvg } = req('@resvg/resvg-js');

const GOLD = '#C99A2C', NEW_GOLD = '#DAAF48', CREAM = '#FBF7EE', CHAR = '#232323';

/** The mark, centred on (512,512), ball radius r. `mono` draws a single-colour silhouette. */
function mark({ r = 330, mono = false, id = 'm' } = {}) {
  const k = r / 330;                                        // everything scales off the ball
  const cx = 512, cy = 512, R = 236 * k, sw = 58 * k;
  const a = (-40 * Math.PI) / 180;
  const sx = cx + R * Math.cos(a), sy = cy + R * Math.sin(a);
  const g = `M ${sx.toFixed(1)} ${sy.toFixed(1)} A ${R} ${R} 0 1 0 ${(cx + R).toFixed(1)} ${cy} L ${(cx + 54 * k).toFixed(1)} ${cy}`;
  const streak = (y, x0, x1, w) => `M ${x0} ${y - w / 2} L ${x1} ${y - w * 0.12} L ${x1} ${y + w * 0.12} L ${x0} ${y + w / 2} A ${w / 2} ${w / 2} 0 0 1 ${x0} ${y - w / 2} Z`;
  const s1 = streak(cy - 84 * k, cx + 96 * k, cx + 300 * k, 24 * k), s2 = streak(cy - 40 * k, cx + 150 * k, cx + 318 * k, 15 * k);
  if (mono) {
    // monochrome (Android 13 themed icons use alpha only): ball silhouette with the G cut out
    return `<defs><mask id="${id}k"><rect width="1024" height="1024" fill="#fff"/><path d="${g}" fill="none" stroke="#000" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round"/><path d="${s1}" fill="#000"/><path d="${s2}" fill="#000"/></mask></defs>
      <circle cx="${cx}" cy="${cy}" r="${r}" fill="#fff" mask="url(#${id}k)"/>`;
  }
  return `<defs>
      <radialGradient id="${id}b" cx="38%" cy="32%" r="78%"><stop offset="0" stop-color="#EBC967"/><stop offset=".5" stop-color="${GOLD}"/><stop offset="1" stop-color="#8A6512"/></radialGradient>
      <radialGradient id="${id}s" cx="50%" cy="50%" r="50%"><stop offset=".86" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity=".28"/></radialGradient>
      <filter id="${id}f" x="0" y="0" width="100%" height="100%"><feTurbulence type="fractalNoise" baseFrequency="${(0.9 / k).toFixed(3)}" numOctaves="2" seed="7"/><feColorMatrix values="0 0 0 0 0.35  0 0 0 0 0.25  0 0 0 0 0.05  0 0 0 0.9 0"/><feComposite in2="SourceGraphic" operator="in"/></filter>
    </defs>
    <circle cx="${cx}" cy="${cy + 10 * k}" r="${r + 6 * k}" fill="#000" opacity=".35"/>
    <circle cx="${cx}" cy="${cy}" r="${r}" fill="url(#${id}b)"/>
    <circle cx="${cx}" cy="${cy}" r="${r}" fill="url(#${id}s)"/>
    <circle cx="${cx}" cy="${cy}" r="${r}" fill="#fff" filter="url(#${id}f)" opacity=".22"/>
    <circle cx="${cx}" cy="${cy}" r="${r - 5 * k}" fill="none" stroke="${NEW_GOLD}" stroke-opacity=".55" stroke-width="${5 * k}"/>
    <path d="${g}" fill="none" stroke="#5A420C" stroke-opacity=".35" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round" transform="translate(${4 * k} ${7 * k})"/>
    <path d="${g}" fill="none" stroke="${CREAM}" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round"/>
    <path d="${s1}" fill="${CREAM}" opacity=".92"/>
    <path d="${s2}" fill="${CREAM}" opacity=".62"/>`;
}

const field = (id = 'f') => `<defs><radialGradient id="${id}" cx="50%" cy="40%" r="75%"><stop offset="0" stop-color="#34312C"/><stop offset=".6" stop-color="${CHAR}"/><stop offset="1" stop-color="#141414"/></radialGradient></defs><rect width="1024" height="1024" fill="url(#${id})"/>`;
const svg = (w, h, body, vb = `0 0 ${w} ${h}`) => `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="${vb}">${body}</svg>`;

/** A fence-camera court in gold hairlines, for the feature graphic. */
function courtLines(x0, y0, w, h, op = 0.22) {
  // a simple perspective: near baseline wide at the bottom, far baseline narrow at the top
  const nb = [x0 + w * 0.06, x0 + w * 0.94], fb = [x0 + w * 0.36, x0 + w * 0.64], yN = y0 + h, yF = y0 + h * 0.18;
  const lerp = (a, b, t) => a + (b - a) * t;
  const at = (t, u) => [lerp(lerp(nb[0], fb[0], t), lerp(nb[1], fb[1], t), u), lerp(yN, yF, Math.pow(t, 0.62))];
  const seg = (t1, u1, t2, u2) => { const [a, b] = at(t1, u1), [c, d] = at(t2, u2); return `<line x1="${a.toFixed(1)}" y1="${b.toFixed(1)}" x2="${c.toFixed(1)}" y2="${d.toFixed(1)}"/>`; };
  const net = 0.5, s1 = 0.27, s2 = 0.73;
  return `<g stroke="${NEW_GOLD}" stroke-opacity="${op}" stroke-width="2.2" fill="none">${seg(0, 0, 0, 1)}${seg(1, 0, 1, 1)}${seg(0, 0, 1, 0)}${seg(0, 1, 1, 1)}${seg(s1, 0, s1, 1)}${seg(s2, 0, s2, 1)}${seg(s1, 0.5, s2, 0.5)}</g>
    <g stroke="${CREAM}" stroke-opacity="${op * 1.6}" stroke-width="3">${seg(net, -0.04, net, 1.04)}</g>`;
}

const out = [];
const put = (rel, svgText, w) => {
  const png = new Resvg(svgText, { fitTo: { mode: 'width', value: w }, font: { loadSystemFonts: true, defaultFontFamily: 'Segoe UI' } }).render().asPng();
  const p = join(ROOT, rel); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, png); out.push(`${rel} ${w}px ${png.length} bytes`);
  if (process.argv.includes('--svg')) { const s = join(ROOT, 'assets', 'brand', rel.split('/').pop().replace('.png', '.svg')); mkdirSync(dirname(s), { recursive: true }); writeFileSync(s, svgText); }
};

// iOS / store icon: full bleed, no transparency, a slightly bigger ball
put('assets/icon.png', svg(1024, 1024, field() + mark({ r: 368, id: 'i' })), 1024);
put('store/play/play-icon-512.png', svg(1024, 1024, field() + mark({ r: 368, id: 'p' })), 512);
// Android adaptive: the foreground keeps inside the 66% safe zone (r 330 = 645 px across)
put('assets/android-icon-background.png', svg(1024, 1024, field('ab')), 1024);
put('assets/android-icon-foreground.png', svg(1024, 1024, mark({ r: 318, id: 'a' })), 1024);
put('assets/android-icon-monochrome.png', svg(1024, 1024, mark({ r: 318, mono: true, id: 'n' })), 1024);
// splash: the mark alone on the app's #0B0B0D splash colour (transparent PNG)
put('assets/splash-icon.png', svg(1024, 1024, mark({ r: 420, id: 's' })), 512);
put('assets/favicon.png', svg(1024, 1024, mark({ r: 500, id: 'v' })), 48);

// Play feature graphic, 1024 x 500
const fg = `<defs><linearGradient id="fgb" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#2A2825"/><stop offset="1" stop-color="#121212"/></linearGradient>
  <radialGradient id="glow" cx="24%" cy="50%" r="40%"><stop offset="0" stop-color="${GOLD}" stop-opacity=".28"/><stop offset="1" stop-color="${GOLD}" stop-opacity="0"/></radialGradient></defs>
  <rect width="1024" height="500" fill="url(#fgb)"/>
  ${courtLines(560, 60, 440, 410, 0.15)}
  <rect width="1024" height="500" fill="url(#glow)"/>
  <g transform="translate(36 30) scale(0.43)">${mark({ r: 420, id: 'g' })}</g>
  <text x="500" y="214" fill="${CREAM}" font-family="Segoe UI" font-weight="700" font-size="74" letter-spacing="6">GENEVA</text>
  <text x="500" y="292" fill="${NEW_GOLD}" font-family="Segoe UI" font-weight="700" font-size="74" letter-spacing="6">TENNIS</text>
  <text x="503" y="348" fill="#C9C9D2" font-family="Segoe UI" font-size="22" letter-spacing="1">Match tracker · live coach sheet · team chat</text>
  <rect x="503" y="378" width="72" height="5" rx="2.5" fill="${GOLD}"/>`;
put('store/play/play-feature-graphic-1024x500.png', svg(1024, 500, fg), 1024);

console.log(out.join('\n'));
