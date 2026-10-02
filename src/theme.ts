/**
 * Geneva Tennis design system: a night-court ground, Geneva gold for action, and one
 * cool court blue for the "somebody is watching" signals. Nothing in here is allowed
 * to drift from these values; `npm run contrast` audits every pairing they appear in.
 */

import Ionicons from '@expo/vector-icons/Ionicons';

export const color = {
  night: '#0B0B0D',
  ink: '#141416',
  inkLift: '#1C1C20',
  inkHover: '#232329',

  gold: '#B8964F',
  goldHot: '#E0BF72',
  goldDeep: '#5E4A1F',
  /** Geneva College's official old gold. A brand reference; it is only 3.4:1 to 4.3:1
   *  on the dark surfaces, so it never carries small text here. */
  oldGold: '#89734C',

  bone: '#FFFFFF',
  chalk: '#F4F1EA',
  chalk2: '#E7E3DC',
  slate: '#6C6C78',

  courtBlue: '#62B0E8',
  /** Optic yellow, the colour of the ball. Highlights and live match marks. */
  ball: '#DDF54A',
  /** Errors and destructive actions. 5.1:1 to 6.4:1 on every surface. */
  danger: '#FF5A5A',
  /** A won point, a finished workout. 8.4:1 to 10.5:1 on every surface. */
  win: '#46D68C',

  lineDark: 'rgba(255,255,255,0.10)',
  goldTint: 'rgba(184,150,79,0.10)',
  goldLine: 'rgba(184,150,79,0.40)',
  blueTint: 'rgba(98,176,232,0.12)',
  blueLine: 'rgba(98,176,232,0.5)',

  textLede: '#C9C9D2',
  textBody: '#B4B4C0',
  textDim: '#9C9CA9',
  textFaint: '#82828F',
  textMute: '#75757F',
  /**
   * MEASURED FAILING. 3.92:1 on the page, 3.38:1 on a card, 3.11:1 on a pressed row.
   * There is no surface in this app where it clears AA as normal text, so nothing
   * uses it. Kept only because the DS carries it; reach for textFaint instead on the
   * page, or textDim on anything that also renders on a card or a pressed row.
   * `npm run contrast`.
   */
  textLabel: '#6E6E7C',
} as const;

/** Semantic aliases. Fills use gold; text drawn ON a gold fill is always `night`. */
export const semantic = {
  surfacePage: color.night,
  surfaceBand: color.ink,
  surfaceCard: color.inkLift,
  surfaceInput: '#0C0C11',
  action: color.gold,
  /**
   * Gold on night is already 7.0:1, so the canonical gold clears AA as small text on
   * the page. goldHot (11.1:1) is the brighter step for text that has to hold up on a
   * card (gold is 6.1:1 there) or a pressed row (5.6:1), and it is the hover and
   * focus-ring colour, so this is a swap inside the system rather than a new colour.
   *
   * The reverse is the rule that matters: WHITE on gold is 2.8:1 and fails. Anything
   * drawn on a gold fill (the primary button, the selected chip, the tab badge) is
   * `night`, which is 7.0:1.
   */
  actionText: color.goldHot,
  focusRing: color.goldHot,
  border: color.lineDark,
  /**
   * The outline of anything you can press or type into. semantic.border measures
   * 1.25 to 1.36 against every surface here, which is fine for a divider and not
   * fine for the only thing marking where a text field is. slate is the dimmest
   * token that clears 1.4.11 on all five surfaces (3.02 to 3.80).
   */
  borderStrong: color.slate,
} as const;

export const radius = {
  pill: 100,
  cardLg: 18,
  card: 14,
  badge: 11,
  chip: 10,
  input: 9,
} as const;

export const space = (n: number) => n * 4;

/** Every icon in the app comes from Ionicons, which ships with @expo/vector-icons and
 *  already draws the tab bar. Unicode glyphs used to stand in here; they render at the
 *  mercy of whichever font the platform substitutes, which is not an icon system. */
export type IconName = keyof typeof Ionicons.glyphMap;

/**
 * Session types. Color is NEVER the only signal — every consumer must render the
 * label and the icon too (WCAG 1.4.1). Four of the six sit on one light-grey ramp, so
 * the word and the glyph are what actually tell them apart.
 *
 * The KEYS are stored on every event and template, and firebase/firestore.rules
 * validates them by name (typesOk). Relabel and re-icon freely; never rename a key.
 */
export const SESSION_TYPES = {
  skills: { label: 'Technique', icon: 'flash-outline', color: color.goldHot },
  shoot: { label: 'Serve & Return', icon: 'tennisball-outline', color: color.courtBlue },
  // Gold and blue are the only two hues this palette has, and both were already spent,
  // so these two take steps off the same light-grey ramp as Match Play and Rest.
  // Measured on every surface they are drawn on: textLede is 12.0:1 on the page and
  // 10.3:1 on a card, textBody 9.6:1 and 8.3:1, both well past the 7.3:1 Rest has
  // shipped with. The icon and the word are what actually tell them apart.
  handle: { label: 'Footwork', icon: 'footsteps-outline', color: color.textLede },
  cond: { label: 'Conditioning', icon: 'pulse-outline', color: color.textBody },
  team: { label: 'Match Play', icon: 'people-outline', color: color.chalk },
  rest: { label: 'Rest / Film', icon: 'film-outline', color: '#9C9CA9' },
} as const satisfies Record<string, { label: string; icon: IconName; color: string }>;

export type SessionType = keyof typeof SESSION_TYPES;

/**
 * Every category a workout covers. One session is often two things at once, footwork
 * and serving, so `types` carries the whole set.
 *
 * `type` stays the primary one and is never dropped: firebase/firestore.rules
 * validates documents by field name, the calendar tints a day with a single colour,
 * and there is real data in Firestore that predates the set. A document written
 * before today has no `types` at all, and falling back to the single field is the
 * whole reason it still renders. Read a category through here, never off `.type`
 * directly, or a second selection silently disappears from wherever you forgot.
 */
export const typesOf = (x: { type: SessionType; types?: SessionType[] }): SessionType[] =>
  x.types?.length ? x.types : [x.type];

/**
 * The DS display faces are not bundled — shipping extra webfont families would add
 * megabytes to the binary for chrome the phone already draws well. Weight and
 * tracking carry the brand instead.
 * ponytail: add expo-font + the woff2 files the day a screenshot looks wrong, not before.
 */
export const type = {
  display: { fontSize: 26, fontWeight: '800' as const, letterSpacing: 0.4 },
  title: { fontSize: 17, fontWeight: '700' as const, letterSpacing: 0.2 },
  eyebrow: {
    fontSize: 11,
    fontWeight: '700' as const,
    letterSpacing: 1.6,
    textTransform: 'uppercase' as const,
    color: color.textFaint,
  },
  body: { fontSize: 15, lineHeight: 21, color: color.textBody },
  meta: { fontSize: 12, color: color.textDim },
  label: { fontSize: 13, fontWeight: '600' as const, color: color.textLede },
} as const;

/**
 * The colour an account's own message bubbles are painted in, picked on the You tab.
 *
 * Every one of these is dark enough to carry `chalk` body text and `textLede` stamps
 * at AA (measured: 6.9:1 to 10.0:1 and 4.7:1 to 6.8:1). That is the whole constraint
 * on the list — a picker offering a colour the text cannot be read on is not a choice,
 * it is a trap. Add to it only with the ratios measured, not guessed.
 */
export const CHAT_COLORS = {
  gold: { label: 'Geneva gold', bg: color.goldDeep },
  ember: { label: 'Ember', bg: '#8A3A0C' },
  forest: { label: 'Forest', bg: '#1B5630' },
  court: { label: 'Court blue', bg: '#0B4A6E' },
  ocean: { label: 'Ocean', bg: '#17407A' },
  violet: { label: 'Violet', bg: '#4A2A73' },
} as const satisfies Record<string, { label: string; bg: string }>;

export type ChatColor = keyof typeof CHAT_COLORS;

/** Unknown or unset falls back to the brand gold the app shipped with. */
export const bubbleColor = (key?: string): string =>
  (CHAT_COLORS as Record<string, { bg: string }>)[key ?? '']?.bg ?? CHAT_COLORS.gold.bg;

/** Avatar tint per role — matches the preview's .av.coach / .parent / .player. */
export const roleTint = {
  coach: { bg: color.goldTint, fg: color.goldHot, border: color.gold },
  parent: { bg: color.blueTint, fg: color.courtBlue, border: color.courtBlue },
  player: { bg: 'rgba(244,241,234,0.12)', fg: color.chalk, border: color.chalk2 },
} as const;
