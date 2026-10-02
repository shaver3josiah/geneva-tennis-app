/**
 * The Geneva Tennis mark: a Geneva-gold ball whose seam is drawn as a bold G, with two
 * tapering wind streaks pulled through the G's mouth (the Golden Tornadoes' swirl, and the
 * pace of a ball in flight). An original mark; the college shield and the athletics tornado
 * are Geneva trademarks and are not used. Geometry matches scripts/brand.mjs, which renders
 * the app icon, splash and store art from the same numbers.
 *
 * The wordmark is GENEVA TENNIS drawn as stroked block letters so it never depends on a font.
 */

// --- the square icon --------------------------------------------------------

/** The icon's own coordinate space. */
export const ICON_VIEW_BOX = '0 0 100 100';

/** The gold disc. */
export const ICON_DISC = { cx: 50, cy: 50, r: 48 } as const;

/** The seam, drawn as a G: an open arc and its crossbar. Stroked, round caps. */
export const ICON_G = 'M 76.3 27.93 A 34.33 34.33 0 1 0 84.33 50 L 57.85 50';
export const ICON_G_STROKE = 8.44;
/** The two wind streaks through the G's mouth: filled, tapering to the right. */
export const ICON_STREAKS = ['M 63.96 36.04 L 93.64 37.36 L 93.64 38.2 L 63.96 39.53 A 1.75 1.75 0 0 1 63.96 36.04 Z', 'M 71.82 43.09 L 96.25 43.92 L 96.25 44.44 L 71.82 45.27 A 1.09 1.09 0 0 1 71.82 43.09 Z'] as const;
/** Kept for anything that imported the old name: the seam is now the G. */
export const ICON_SEAMS = [ICON_G] as const;
export const ICON_SEAM_STROKE = ICON_G_STROKE;

// --- the wordmark -----------------------------------------------------------

/**
 * Block letters, each in a box 80 tall and `w` wide. The coordinates sit 5 inside the box
 * so a stroke of width 10 (WORD_STROKE) fills the box exactly and never spills into the
 * next letter. Only the letters GENEVA TENNIS needs.
 */
const GLYPHS: Record<string, { w: number; d: string }> = {
  E: { w: 50, d: 'M 45 5 L 5 5 L 5 75 L 45 75 M 5 40 L 38 40' },
  N: { w: 54, d: 'M 5 75 L 5 5 L 49 75 L 49 5' },
  V: { w: 56, d: 'M 5 5 L 28 75 L 51 5' },
  A: { w: 56, d: 'M 5 75 L 28 5 L 51 75 M 14 52 L 42 52' },
  T: { w: 54, d: 'M 5 5 L 49 5 M 27 5 L 27 75' },
  I: { w: 10, d: 'M 5 5 L 5 75' },
  G: {
    w: 54,
    d: 'M 49 20 C 44 10 36 5 28 5 C 14 5 5 20 5 40 C 5 60 14 75 28 75 C 42 75 49 66 49 54 L 49 42 L 30 42',
  },
  S: {
    w: 52,
    d: 'M 47 18 C 43 9 36 5 27 5 C 14 5 7 12 7 21 C 7 31 15 35 27 40 C 40 45 47 49 47 59 C 47 69 40 75 27 75 C 17 75 10 71 6 62',
  },
};

export const WORD_STROKE = 10;
/** Glyphs are drawn 80 tall and laid out at this scale, so a letter is 72 tall in the lockup. */
export const WORD_SCALE = 0.9;
const LETTER_GAP = 14;

/** Where the wordmark starts: to the right of the 200 x 200 ball. */
const WORD_X = 232;

/** One letter placed in the lockup box: draw `d` under translate(x y) scale(WORD_SCALE). */
export interface PlacedGlyph {
  d: string;
  x: number;
  y: number;
}

function layout(text: string, y: number): { glyphs: PlacedGlyph[]; right: number } {
  let x = WORD_X;
  const glyphs = [...text].map((ch) => {
    const g = GLYPHS[ch];
    if (!g) throw new Error(`logo-paths: no glyph for "${ch}"`);
    const placed = { d: g.d, x, y };
    x += g.w * WORD_SCALE + LETTER_GAP;
    return placed;
  });
  return { glyphs, right: x - LETTER_GAP };
}

// Two lines, centred on the ball: 72 tall each, 20 apart, from y 18 to y 182.
const top = layout('GENEVA', 18);
const bottom = layout('TENNIS', 110);

export const WORDMARK: readonly PlacedGlyph[] = [...top.glyphs, ...bottom.glyphs];

// --- the lockup -------------------------------------------------------------

/** The lockup's own coordinate space: the 200 x 200 ball, then the wordmark. */
export const LOGO_W = Math.ceil(Math.max(top.right, bottom.right));
export const LOGO_H = 200;
export const VIEW_BOX = `0 0 ${LOGO_W} ${LOGO_H}`;
