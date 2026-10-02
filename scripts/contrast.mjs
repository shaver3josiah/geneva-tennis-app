#!/usr/bin/env node
/**
 * WCAG 2.1 contrast checker for this app's own source.
 *
 *   npm run contrast            human-readable tables, exit 1 on any FAIL
 *   npm run contrast -- --json  the same findings as JSON
 *
 * It reads the tokens out of src/theme.ts, then walks app/ and src/ pairing every
 * foreground colour it can resolve with the background it actually sits on — worked out
 * from the JSX ancestry where that is possible, and declared "assumed" where it is not.
 *
 * ponytail: no parser dependency. A scanner covers the style shapes this codebase
 * actually uses; anything it cannot see is reported as unresolved rather than silently
 * passing, because a false PASS is the one outcome that makes the report worthless.
 * Swap in @babel/parser the day the unresolved list gets long, not before.
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const AS_JSON = process.argv.includes('--json');
/** --trace <substring>: dump scanner decisions for files whose path matches. */
const TRACE_AT = process.argv.indexOf('--trace');
const TRACE_ARG = TRACE_AT > 0 ? process.argv[TRACE_AT + 1] : null;
let TRACE = false;

/* ------------------------------------------------------------- colour math ---
 * WCAG 2.1 relative luminance and contrast ratio, implemented here rather than
 * imported, so the numbers in this report have no third party in them.        */

const srgbToLin = (c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

const luminance = ([r, g, b]) =>
  0.2126 * srgbToLin(r / 255) + 0.7152 * srgbToLin(g / 255) + 0.0722 * srgbToLin(b / 255);

function contrast(fgRgb, bgRgb) {
  const a = luminance(fgRgb);
  const b = luminance(bgRgb);
  const [hi, lo] = a >= b ? [a, b] : [b, a];
  return (hi + 0.05) / (lo + 0.05);
}

/** '#RGB' | '#RRGGBB' | '#RRGGBBAA' | 'rgb()' | 'rgba()' | 'transparent' -> {rgb,a} */
function parseColor(text) {
  if (typeof text !== 'string') return null;
  const t = text.trim();
  if (t === 'transparent') return { rgb: [0, 0, 0], a: 0 };
  let m = /^#([0-9a-fA-F]{3,8})$/.exec(t);
  if (m) {
    let h = m[1];
    if (h.length === 3 || h.length === 4) h = [...h].map((c) => c + c).join('');
    if (h.length !== 6 && h.length !== 8) return null;
    const n = (i) => parseInt(h.slice(i, i + 2), 16);
    return { rgb: [n(0), n(2), n(4)], a: h.length === 8 ? n(6) / 255 : 1 };
  }
  m = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/.exec(t);
  if (m) return { rgb: [+m[1], +m[2], +m[3]], a: m[4] === undefined ? 1 : +m[4] };
  return null;
}

/** Source-over compositing. Kept unrounded: rounding to 8-bit per layer would add
 *  error the renderer does not, and it never moves a ratio by more than ~0.01. */
const over = (fg, bgRgb) => fg.rgb.map((c, i) => fg.a * c + (1 - fg.a) * bgRgb[i]);

const hex = (rgb) =>
  '#' + rgb.map((c) => Math.round(c).toString(16).padStart(2, '0')).join('').toUpperCase();

const r2 = (n) => Math.round(n * 100) / 100;

/** Source fragments can span lines; labels in a table cannot. */
const oneLine = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

/* --- the sanity check the whole report rests on. If this fails, nothing below is
 *     worth reading, so it runs first and aborts the run.                       */
const SELF_CHECK = [
  ['#E0BF72', '#0B0B0D', 11.11],
  ['#B8964F', '#0B0B0D', 7.04],
  ['#FFFFFF', '#000000', 21.0],
  ['#777777', '#FFFFFF', 4.48],
];
const selfCheck = SELF_CHECK.map(([f, b, want]) => {
  const got = contrast(parseColor(f).rgb, parseColor(b).rgb);
  return { fg: f, bg: b, expected: want, measured: r2(got), ok: Math.abs(got - want) < 0.005 };
});

/* ------------------------------------------------------------ source scanner */

const OPEN = { '{': '}', '[': ']', '(': ')' };
const CLOSERS = new Set(['}', ']', ')']);

function skipString(src, i) {
  const q = src[i];
  i++;
  while (i < src.length) {
    if (src[i] === '\\') { i += 2; continue; }
    if (q === '`' && src[i] === '$' && src[i + 1] === '{') { i = readBalanced(src, i + 1); continue; }
    if (src[i] === q) return i + 1;
    i++;
  }
  return i;
}

/** i points at an opener; returns the index just past its match. */
function readBalanced(src, i) {
  const stack = [OPEN[src[i]]];
  i++;
  while (i < src.length && stack.length) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (c === '/' && src[i + 1] === '*') { const e = src.indexOf('*/', i + 2); i = e < 0 ? src.length : e + 2; continue; }
    if (c === '"' || c === "'" || c === '`') { i = skipString(src, i); continue; }
    if (OPEN[c]) { stack.push(OPEN[c]); i++; continue; }
    if (c === stack[stack.length - 1]) { stack.pop(); i++; continue; }
    i++;
  }
  return i;
}

function skipTrivia(src, i) {
  for (;;) {
    while (i < src.length && /\s/.test(src[i])) i++;
    if (src[i] === '/' && src[i + 1] === '/') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (src[i] === '/' && src[i + 1] === '*') { const e = src.indexOf('*/', i + 2); i = e < 0 ? src.length : e + 2; continue; }
    return i;
  }
}

function newlineIndex(src) {
  const nl = [0];
  for (let i = 0; i < src.length; i++) if (src[i] === '\n') nl.push(i + 1);
  return nl;
}

function lineAt(nl, idx) {
  let lo = 0, hi = nl.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (nl[mid] <= idx) lo = mid; else hi = mid - 1;
  }
  return lo + 1;
}

/** Read one property value: everything up to a top-level ',' or '}'. */
function readValue(src, i) {
  const start = i;
  while (i < src.length) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (c === '/' && src[i + 1] === '*') { const e = src.indexOf('*/', i + 2); i = e < 0 ? src.length : e + 2; continue; }
    if (c === '"' || c === "'" || c === '`') { i = skipString(src, i); continue; }
    if (OPEN[c]) { i = readBalanced(src, i); continue; }
    if (c === ',' || c === '}') break;
    i++;
  }
  return [src.slice(start, i).trim(), i];
}

/** src[i] === '{'. Returns { props:[{key,raw,line,obj?}], start, end, line }. */
function parseObject(src, i, nl) {
  const start = i;
  const props = [];
  i++;
  for (;;) {
    i = skipTrivia(src, i);
    if (i >= src.length) break;
    if (src[i] === '}') { i++; break; }
    if (src[i] === ',') { i++; continue; }
    const line = lineAt(nl, i);
    if (src.startsWith('...', i)) {
      const [raw, next] = readValue(src, i + 3);
      props.push({ key: '...', raw, line });
      i = next;
      continue;
    }
    let key, kEnd;
    if (src[i] === '"' || src[i] === "'") { kEnd = skipString(src, i); key = src.slice(i + 1, kEnd - 1); }
    else if (src[i] === '[') { kEnd = readBalanced(src, i); key = src.slice(i, kEnd); }
    else { let j = i; while (j < src.length && /[\w$]/.test(src[j])) j++; kEnd = j; key = src.slice(i, j); }
    if (kEnd === i) { i++; continue; }
    let j = skipTrivia(src, kEnd);
    if (src[j] === '?') j = skipTrivia(src, j + 1);
    if (src[j] !== ':') { props.push({ key, raw: key, line }); i = j > i ? j : i + 1; continue; }
    j = skipTrivia(src, j + 1);
    const [raw, next] = readValue(src, j);
    const p = { key, raw, line };
    if (raw.startsWith('{')) p.obj = parseObject(src, j, nl);
    props.push(p);
    i = next;
  }
  return { props, start, end: i, line: lineAt(nl, start) };
}

/** Split a fragment on top-level occurrences of a single-char delimiter. */
function splitTop(text, delim) {
  const out = [];
  let start = 0, i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '"' || c === "'" || c === '`') { i = skipString(text, i); continue; }
    if (OPEN[c]) { i = readBalanced(text, i); continue; }
    if (c === delim) { out.push(text.slice(start, i)); start = i + 1; }
    i++;
  }
  out.push(text.slice(start));
  return out.map((s) => s.trim()).filter(Boolean);
}

/** Index of the LAST top-level occurrence of op, or -1. */
function lastTopIndexOf(text, op) {
  let found = -1, i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '"' || c === "'" || c === '`') { i = skipString(text, i); continue; }
    if (OPEN[c]) { i = readBalanced(text, i); continue; }
    if (text.startsWith(op, i)) { found = i; i += op.length; continue; }
    i++;
  }
  return found;
}

function firstTopIndexOf(text, ch, from = 0) {
  let i = from;
  while (i < text.length) {
    const c = text[i];
    if (c === '"' || c === "'" || c === '`') { i = skipString(text, i); continue; }
    if (OPEN[c]) { i = readBalanced(text, i); continue; }
    if (c === ch) return i;
    i++;
  }
  return -1;
}

/* --------------------------------------------------------------- theme scope */

const themeSrc = readFileSync(join(ROOT, 'src/theme.ts'), 'utf8');
const themeNl = newlineIndex(themeSrc);

/** Every `export const NAME = { ... }` in theme.ts, values left as raw source text. */
const THEME = {};
for (const m of themeSrc.matchAll(/export\s+const\s+(\w+)\s*(?::[^=]+)?=\s*\{/g)) {
  const openIdx = m.index + m[0].length - 1;
  THEME[m[1]] = toPlain(parseObject(themeSrc, openIdx, themeNl));
}

function toPlain(obj) {
  const out = {};
  for (const p of obj.props) {
    if (p.key === '...') { (out.__spreads ||= []).push(p.raw); continue; }
    out[p.key] = p.obj ? toPlain(p.obj) : p.raw;
  }
  return out;
}

/** 'color.goldHot' -> raw value text, following the dotted path into THEME. */
function themeLookup(path) {
  let cur = THEME;
  for (const part of path.split('.')) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = cur[part];
  }
  return cur;
}

const stripQuotes = (t) =>
  /^'([^']*)'$/.test(t) || /^"([^"]*)"$/.test(t) || /^`([^`$]*)`$/.test(t) ? t.slice(1, -1) : t;

/**
 * Resolve a raw value expression to {rgb,a} candidates. A ternary yields both arms.
 * `misses` counts arms that could not be resolved at all — a half-resolved ternary
 * must not read as fully checked.
 */
function resolveColors(raw, locals = {}, depth = 0) {
  if (raw == null) return { colors: [], misses: 0 };
  if (depth > 6) return { colors: [], misses: 1 };
  const t = String(raw).trim();
  const direct = parseColor(stripQuotes(t));
  if (direct) return { colors: [direct], misses: 0 };
  const q = firstTopIndexOf(t, '?');
  if (q > 0 && t[q + 1] !== '.' && t[q + 1] !== '?') {
    const c = firstTopIndexOf(t, ':', q + 1);
    if (c > q) {
      const a = resolveColors(t.slice(q + 1, c), locals, depth + 1);
      const b = resolveColors(t.slice(c + 1), locals, depth + 1);
      return { colors: [...a.colors, ...b.colors], misses: a.misses + b.misses };
    }
  }
  if (/^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)*$/.test(t)) {
    if (Object.hasOwn(locals, t)) return resolveColors(locals[t], {}, depth + 1);
    const looked = themeLookup(t);
    if (typeof looked === 'string') return resolveColors(looked, locals, depth + 1);
  }
  return { colors: [], misses: 1 };
}

const colorCandidates = (raw, locals = {}) => resolveColors(raw, locals).colors;

/** Foregrounds only: a fully transparent value paints nothing and is not a finding. */
function resolveForeground(raw, locals = {}) {
  const { colors, misses } = resolveColors(raw, locals);
  return { colors: colors.filter((c) => c.a > 0), misses };
}

function numberOf(raw) {
  if (raw == null) return undefined;
  const t = String(raw).trim();
  return /^-?\d+(\.\d+)?$/.test(t) ? Number(t) : undefined;
}

const SURFACE_PAGE = colorCandidates('semantic.surfacePage')[0] ?? parseColor('#0B0B0D');

/* --------------------------------------------------------------- file walking */

function walk(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(tsx|ts)$/.test(e.name)) out.push(p);
  }
  return out;
}

const FILES = ['app', 'src']
  .map((d) => join(ROOT, d))
  .filter((d) => existsSync(d) && statSync(d).isDirectory())
  .flatMap((d) => walk(d))
  .sort();

const rel = (p) => p.slice(ROOT.length + 1).split('\\').join('/');

/* ------------------------------------------------------------------ JSX scan */

const IDENT_BEFORE = /[\w$)\]]$/;
/** `foo<Bar>` is a generic; `return <View>` is JSX. Only a keyword can precede a tag. */
const KEYWORD_BEFORE = /(^|[^\w$])(return|case|default|typeof|instanceof|in|of|do|else|yield|await|new|extends|render)$/;

/** Inside JSX children, text is text: an apostrophe in "account's" is not a string. */
function skipJsxText(src, i) {
  while (i < src.length && src[i] !== '<' && src[i] !== '{') i++;
  return i;
}

/**
 * Element tree for one file. Deliberately strict: on any tag mismatch the whole file's
 * ancestry is marked untrusted and every background it would have produced downgrades
 * to "assumed". A wrong ancestor is a false PASS waiting to happen.
 */
function scanJsx(src, nl) {
  const elements = [];
  const stack = [];
  const problems = [];
  let ok = true;
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (c === '/' && src[i + 1] === '*') { const e = src.indexOf('*/', i + 2); i = e < 0 ? src.length : e + 2; continue; }
    if (c === '"' || c === "'" || c === '`') { i = skipString(src, i); continue; }
    if (c !== '<') { i++; continue; }

    if (src[i + 1] === '/') {
      const m = /^<\/\s*([\w$.]*)\s*>/.exec(src.slice(i, i + 80));
      if (!m) { i++; continue; }
      const top = stack.pop();
      if (!top || (m[1] && top.tag !== m[1])) {
        ok = false;
        problems.push(`line ${lineAt(nl, i)}: </${m[1]}> closes <${top ? top.tag : 'nothing'}>` +
          (top ? ` opened at line ${top.line}` : ''));
      }
      i = stack.length ? skipJsxText(src, i + m[0].length) : i + m[0].length;
      continue;
    }
    if (src[i + 1] === '>') {
      stack.push({ tag: '', attrs: {}, line: lineAt(nl, i), parent: stack.at(-1) ?? null });
      i = skipJsxText(src, i + 2);
      continue;
    }
    if (!/[A-Za-z_]/.test(src[i + 1] ?? '')) { i++; continue; }

    // A '<' straight after an identifier, ')' or ']' is a TS generic, not JSX.
    const before = src.slice(Math.max(0, i - 40), i).replace(/\s+$/, '');
    if (IDENT_BEFORE.test(before) && !KEYWORD_BEFORE.test(before)) {
      if (TRACE) console.error(`  skip generic line ${lineAt(nl, i)}: ...${JSON.stringify(before.slice(-24))}`);
      i++;
      continue;
    }

    let j = i + 1;
    while (j < src.length && /[\w$.]/.test(src[j])) j++;
    const tag = src.slice(i + 1, j);
    const attrs = {};
    let selfClosing = false;
    for (;;) {
      j = skipTrivia(src, j);
      if (j >= src.length) break;
      if (src[j] === '/' && src[j + 1] === '>') { selfClosing = true; j += 2; break; }
      if (src[j] === '>') { j++; break; }
      if (src[j] === '{') { j = readBalanced(src, j); continue; } // {...spread}
      let k = j;
      while (k < src.length && /[\w$:.-]/.test(src[k])) k++;
      if (k === j) { j++; continue; }
      const name = src.slice(j, k);
      let v = null;
      let a = skipTrivia(src, k);
      if (src[a] === '=') {
        a = skipTrivia(src, a + 1);
        if (src[a] === '{') { const e = readBalanced(src, a); v = src.slice(a + 1, e - 1); j = e; }
        else if (src[a] === '"' || src[a] === "'") { const e = skipString(src, a); v = src.slice(a + 1, e - 1); j = e; }
        else j = a;
      } else j = k;
      attrs[name] = v;
    }
    const el = { tag, attrs, line: lineAt(nl, i), parent: stack.at(-1) ?? null };
    if (/Text$|^Text/.test(tag)) for (let a = el.parent; a; a = a.parent) a.hasText = true;
    elements.push(el);
    if (TRACE) console.error(`  ${selfClosing ? 'self ' : 'open '}<${tag}> line ${el.line} depth ${stack.length}`);
    if (!selfClosing) stack.push(el);
    i = stack.length ? skipJsxText(src, j) : j;
  }
  if (stack.length) {
    ok = false;
    problems.push('unclosed: ' + stack.map((e) => `<${e.tag || 'fragment'}> line ${e.line}`).join(', '));
  }
  return { elements, ok, problems };
}

/* ------------------------------------------------------ per-file style model */

const FG_BORDER = /^border(Top|Bottom|Left|Right|Start|End)?Color$/;
const BORDER_WIDTH = /^border(Top|Bottom|Left|Right|Start|End)?Width$/;

/** Navigation option objects: a foreground key takes its background from a sibling. */
const NAV_PREFIX = [
  ['tabBar', 'tabBarStyle'],
  ['header', 'headerStyle'],
  ['scene', 'sceneStyle'],
  ['content', 'contentStyle'],
];
const NAV_LABEL_STYLE = { tabBar: 'tabBarLabelStyle', header: 'headerTitleStyle' };

/** Wrappers from src/ui.tsx whose own root View carries a known background. */
const COMPONENT_BG = {
  Screen: 'semantic.surfacePage', // ui.tsx s.page
  Card: 'semantic.surfaceCard',   // ui.tsx s.card
};

function buildFile(path) {
  const src = readFileSync(path, 'utf8');
  const nl = newlineIndex(src);
  const sheets = {};
  const locals = {};
  const navObjects = [];

  for (const m of src.matchAll(/(?:const|let|var)\s+(\w+)\s*=\s*StyleSheet\.create\s*\(\s*\{/g)) {
    const obj = parseObject(src, m.index + m[0].length - 1, nl);
    const keys = {};
    for (const p of obj.props) if (p.obj) keys[p.key] = p.obj;
    sheets[m[1]] = keys;
  }

  // Locals that hold a colour, so `backgroundColor: value ? on : '...'` resolves.
  for (const m of src.matchAll(/(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*([^;=][^;]*);/g)) {
    const raw = m[2].trim();
    if (raw.length < 160 && colorCandidates(raw).length) locals[m[1]] = raw;
  }

  for (const m of src.matchAll(/(?:screenOptions|options)\s*=\s*\{\{/g)) {
    navObjects.push(parseObject(src, m.index + m[0].length - 1, nl));
  }

  TRACE = !!TRACE_ARG && rel(path).includes(TRACE_ARG);
  if (TRACE) console.error(`--- ${rel(path)}`);
  const jsx = scanJsx(src, nl);
  if (!jsx.ok) untrustedFiles.push({ file: rel(path), problems: jsx.problems });
  return { path, rel: rel(path), src, nl, sheets, locals, navObjects, jsx };
}

const plainToRaw = (plain) => {
  const out = {};
  for (const [k, v] of Object.entries(plain)) if (typeof v === 'string') out[k] = v;
  return out;
};

/** 's.evType' -> the parsed StyleSheet object for that key. */
function lookupStyleRef(ref, ctx) {
  const [head, key] = ref.split('.');
  return key && ctx.sheets[head]?.[key] ? ctx.sheets[head][key] : null;
}

/** Flatten a parsed style object into prop -> raw, expanding theme spreads. */
function flatten(obj, ctx) {
  const out = {};
  for (const p of obj.props) {
    if (p.key === '...') {
      const ref = p.raw.trim();
      const sheetObj = lookupStyleRef(ref, ctx);
      if (sheetObj) { Object.assign(out, flatten(sheetObj, ctx)); continue; }
      const themed = themeLookup(ref);
      if (themed && typeof themed === 'object') Object.assign(out, plainToRaw(themed));
      else out.__unresolvedSpread = ref;
      continue;
    }
    out[p.key] = p.raw;
  }
  return out;
}

function styleRefProps(ref, ctx) {
  const obj = lookupStyleRef(ref, ctx);
  if (obj) return flatten(obj, ctx);
  const themed = themeLookup(ref);
  if (themed && typeof themed === 'object') return plainToRaw(themed);
  return null;
}

function sourceProps(text, ctx) {
  const t = text.trim();
  if (t.startsWith('{')) return flatten(parseObject(t, 0, newlineIndex(t)), ctx);
  if (/^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)*$/.test(t)) return styleRefProps(t, ctx);
  return null;
}

/**
 * A style expression -> a list of sources, each with the condition that gates it.
 * Handles: s.key | {..} | [a, b && c, x ? y : z] | ({pressed}) => [..]
 */
function styleSources(expr, ctx) {
  if (!expr) return [];
  const t = expr.trim().replace(/^\([^)]*\)\s*=>\s*/, '').trim();
  const items = t.startsWith('[') && t.endsWith(']') ? splitTop(t.slice(1, -1), ',') : [t];
  const out = [];
  for (const item of items) {
    const amp = lastTopIndexOf(item, '&&');
    if (amp > 0) { out.push({ cond: item.slice(0, amp).trim(), text: item.slice(amp + 2).trim() }); continue; }
    const q = firstTopIndexOf(item, '?');
    if (q > 0 && item[q + 1] !== '.' && item[q + 1] !== '?') {
      const c = firstTopIndexOf(item, ':', q + 1);
      if (c > q) {
        const test = item.slice(0, q).trim();
        out.push({ cond: test, text: item.slice(q + 1, c).trim() });
        out.push({ cond: `!(${test})`, text: item.slice(c + 1).trim() });
        continue;
      }
    }
    out.push({ cond: null, text: item });
  }
  return out.map((s) => ({ ...s, props: sourceProps(s.text, ctx) })).filter((s) => s.props);
}

const STYLE_ATTRS = ['style', 'contentContainerStyle'];

function elementSources(el, ctx) {
  const out = [];
  for (const attr of STYLE_ATTRS) if (el.attrs[attr]) out.push(...styleSources(el.attrs[attr], ctx));
  return out;
}

function backgroundsOf(el, ctx) {
  const out = [];
  for (const s of elementSources(el, ctx)) {
    const raw = s.props?.backgroundColor;
    if (raw == null) continue;
    const cands = colorCandidates(raw, ctx.locals);
    if (!cands.length) { out.push({ cond: s.cond, unresolved: true, raw }); continue; }
    for (const c of cands) out.push({ cond: s.cond, color: c, label: String(raw).trim(), raw });
  }
  return out;
}

/**
 * The background an element's content sits on.
 *
 * Walks self-then-ancestors. The first opaque background wins; translucent ones are
 * collected and composited onto it in paint order. `variantKey` selects one conditional
 * background (pressed, today, ...) to treat as active. `source` is one of:
 *   own      - declared in the element's own style
 *   inferred - found on an ancestor element in this file, or a known ui.tsx wrapper
 *   assumed  - nothing in the chain declared one; falls back to semantic.surfacePage
 *   unknown  - a background IS declared but its value cannot be resolved statically
 */
function resolveBackground(el, ctx, variantKey = null, selfStart = true) {
  const layers = [];
  const desc = [];
  let node = el;
  let source = null;
  let base = null;
  let self = selfStart;
  let hops = 0;
  while (node && hops++ < 24) {
    const bgs = backgroundsOf(node, ctx);
    let picked = bgs.find((b) => b.cond === null);
    if (variantKey) {
      const v = bgs.find((b) => b.cond !== null && `${node.line}:${b.cond}` === variantKey);
      if (v) picked = v;
    }
    if (picked) {
      if (picked.unresolved) return { source: 'unknown', desc: `${String(picked.raw).trim()} (runtime value)`, rgb: null };
      layers.unshift(picked.color);
      desc.unshift(picked.label);
      source ||= self ? 'own' : 'inferred';
      if (picked.color.a >= 0.999) { base = picked.color; break; }
    }
    if (COMPONENT_BG[node.tag]) {
      const c = colorCandidates(COMPONENT_BG[node.tag])[0];
      if (c) { layers.unshift(c); desc.unshift(COMPONENT_BG[node.tag]); base = c; source ||= 'inferred'; break; }
    }
    if (!ctx.jsx.ok) {
      return { source: 'assumed', desc: 'semantic.surfacePage (JSX ancestry untrusted in this file)', rgb: SURFACE_PAGE.rgb };
    }
    node = node.parent;
    self = false;
  }
  if (!base) {
    layers.unshift(SURFACE_PAGE);
    desc.unshift('semantic.surfacePage');
    source = 'assumed'; // nothing in the chain pinned it down; this is a fallback, not a finding
  }
  let rgb = layers[0].rgb;
  for (let k = 1; k < layers.length; k++) rgb = over(layers[k], rgb);
  return { source, desc: desc.join(' over '), rgb };
}

/** Distinct conditional backgrounds in an element's own chain, as variant keys. */
function backgroundVariants(el, ctx) {
  const seen = new Set();
  const out = [];
  let node = el;
  let hops = 0;
  while (node && hops++ < 12) {
    for (const b of backgroundsOf(node, ctx)) {
      if (b.cond === null || b.unresolved) continue;
      const key = `${node.line}:${b.cond}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ key, cond: b.cond });
    }
    node = node.parent;
  }
  return out.slice(0, 6);
}

/* ------------------------------------------------------------- thresholds --- */

function isLargeText(size, weight) {
  if (size == null) return false;
  const w = String(weight ?? '400').replace(/['"]/g, '');
  const bold = w === 'bold' || (/^\d+$/.test(w) && Number(w) >= 700);
  return size >= 24 || (bold && size >= 18.66);
}

const thresholdFor = (kind, size, weight) =>
  kind === 'ui' ? 3 : isLargeText(size, weight) ? 3 : 4.5;

/** WCAG 1.4.3 / 1.4.11 do not apply to inactive (disabled) components. */
const INACTIVE = /\b(disabled|busy|locked)\b/;

/* ---------------------------------------------------------------- findings -- */

const rows = [];
const unresolved = [];
const untrustedFiles = [];

/**
 * DECORATIVE HAIRLINES. theme.ts draws the line between two things that need telling
 * apart in one of two tokens: semantic.borderStrong for anything you press or type into
 * (measured at 3:1 below), and semantic.border / color.lineDark for a divider or the
 * outline of a card. The second is 1.25:1 to 1.36:1 on purpose and WCAG 1.4.11 does not ask
 * a separator for more: it is not a component boundary and carries no information. So a
 * hairline token is counted and not measured when it is a one-sided rule (borderTop and
 * friends: a list divider, even inside a pressable row) or sits on a non-interactive element
 * (a card's outline). An all-sides hairline on a Pressable or a TextInput still fails,
 * because that is the exact misuse the split exists to catch.
 */
const HAIRLINE = /^(semantic\.border|color\.lineDark)$/;
const INTERACTIVE = /^(Pressable|TextInput|TouchableOpacity|TouchableHighlight|TouchableWithoutFeedback|Switch)$/;
const SIDE_ONLY = /^border(Top|Bottom|Left|Right|Start|End)Color$/;
let decorative = 0;

/**
 * A fill the scanner cannot see: the calendar's selected day is painted by an animated style
 * (DayCell's useAnimatedStyle), so statically its text sits on the page and reads as night on
 * night. The real pair, night on gold, is measured in the runtime-selected section below, so
 * these source rows are counted and not measured.
 */
const ANIMATED_FILL = (r) =>
  r.file === 'app/(tabs)/calendar.tsx' && (/isSelected/.test(r.state ?? '') || r.key === 's.gridChip');
let animatedSkipped = 0;

/** Two conditions that can never both hold ("pressed && !on" against "on") are not a pairing. */
function contradicts(a, b) {
  const atoms = (c) => String(c ?? '').split('&&').map((x) => x.trim()).filter(Boolean);
  const neg = (x) => (x.startsWith('!') ? x.slice(1).trim().replace(/^\((.*)\)$/, '$1') : null);
  const [A, B] = [atoms(a), atoms(b)];
  return A.some((x) => neg(x) && B.includes(neg(x))) || B.some((x) => neg(x) && A.includes(neg(x)));
}

function addRow(r) {
  if (!r.fg || !r.bgRgb) return;
  if (ANIMATED_FILL(r)) { animatedSkipped++; return; }
  const alpha = r.fg.a * (r.fgAlpha == null ? 1 : r.fgAlpha);
  const fgRgb = alpha < 1 ? over({ rgb: r.fg.rgb, a: alpha }, r.bgRgb) : r.fg.rgb;
  const ratio = contrast(fgRgb, r.bgRgb);
  const threshold = thresholdFor(r.kind, r.size, r.weight);
  rows.push({
    file: r.file, line: r.line, key: r.key, prop: r.prop, kind: r.kind,
    fg: r.fgLabel, fgHex: hex(fgRgb), bg: r.bgLabel, bgHex: hex(r.bgRgb),
    size: r.size ?? null, weight: r.weight ?? null,
    ratio: r2(ratio), threshold, pass: ratio >= threshold - 1e-9,
    bgSource: r.bgSource, state: r.state ?? null,
    exempt: r.state ? INACTIVE.test(r.state) : false,
    note: r.note ?? null,
  });
}

function styleKeyName(sources, el) {
  const named = sources.find((s) => s.cond === null && /^[A-Za-z_$][\w$]*\.[\w$]+$/.test(s.text));
  return named ? named.text : `<${el.tag}> inline`;
}

for (const path of FILES) {
  const ctx = buildFile(path);

  /* ---- JSX element styles ---- */
  for (const el of ctx.jsx.elements) {
    const sources = elementSources(el, ctx);
    if (!sources.length && !el.attrs.placeholderTextColor) continue;

    const base = {};
    for (const s of sources) if (s.cond === null) Object.assign(base, s.props);
    const keyName = styleKeyName(sources, el);

    const bgs = [{ key: null, cond: null }, ...backgroundVariants(el, ctx)];

    // Foreground states: the base style, plus each conditional source that repaints
    // or fades the text.
    const fgStates = [{ cond: null, idx: -1, props: base }];
    sources.forEach((s, idx) => {
      if (s.cond === null) return;
      if (s.props.color == null && s.props.opacity == null) return;
      fgStates.push({ cond: s.cond, idx, props: { ...base, ...s.props } });
    });

    for (const bgv of bgs) {
      const bg = resolveBackground(el, ctx, bgv.key);
      // A border or a small filled shape is judged against what SURROUNDS it, so its
      // backdrop starts at the parent — never at the element's own fill, which would
      // measure the thing against itself and read 1.00.
      const outer = resolveBackground(el.parent, ctx, bgv.key, false);
      const bgLabel = oneLine(bg.desc) + (bgv.cond ? ` [${oneLine(bgv.cond)}]` : '');
      const outerLabel = oneLine(outer.desc) + (bgv.cond ? ` [${oneLine(bgv.cond)}]` : '');
      if (bg.source === 'unknown') {
        if (base.color != null || Object.keys(base).some((k) => FG_BORDER.test(k))) {
          unresolved.push({ file: ctx.rel, line: el.line, what: `${keyName} background`, detail: oneLine(bg.desc) });
        }
        continue;
      }

      // Correlated conditions. If one flag sets both the background and the text
      // colour (isSelected paints the cell red AND the number white), the BASE colour
      // never renders on the variant background, and the variant colour never renders
      // on the base one. Pairing them would invent failures the app cannot produce.
      const bgConds = new Set(bgs.map((b) => b.cond).filter(Boolean));
      // Where the flag that repaints the background also repaints the text, everything
      // the style array applies BEFORE that entry is dead: a later entry wins.
      const cIdx = bgv.cond
        ? Math.max(-1, ...fgStates.filter((f) => f.cond === bgv.cond).map((f) => f.idx))
        : -1;
      const applicable = fgStates.filter((st) => {
        if (!bgv.cond) return !(st.cond && bgConds.has(st.cond));
        if (cIdx < 0) return !contradicts(bgv.cond, st.cond);
        return (st.cond === bgv.cond || st.idx > cIdx) && !contradicts(bgv.cond, st.cond);
      });

      for (const st of applicable) {
        const p = st.props;
        const size = numberOf(p.fontSize);
        const opacity = numberOf(p.opacity);
        const state = oneLine([...new Set([bgv.cond, st.cond].filter(Boolean))].join(' & ')) || null;
        const first = !bgv.key && !st.cond;

        if (p.color != null) {
          const { colors, misses } = resolveForeground(p.color, ctx.locals);
          if (misses && first) {
            unresolved.push({ file: ctx.rel, line: el.line, what: `${keyName} color`, detail: oneLine(p.color) });
          }
          for (const fg of colors) {
            addRow({
              file: ctx.rel, line: el.line, key: keyName, prop: 'color', kind: 'text',
              fg, fgLabel: oneLine(p.color), fgAlpha: opacity,
              bgRgb: bg.rgb, bgLabel, size, weight: p.fontWeight, bgSource: bg.source, state,
            });
          }
        }

        // A border only exists if a width is set alongside it.
        const hasWidth = Object.keys(p).some((k) => BORDER_WIDTH.test(k) && numberOf(p[k]) !== 0);
        if (hasWidth && outer.source !== 'unknown') {
          const ownFill = colorCandidates(p.backgroundColor, ctx.locals)[0];
          const under = ownFill ? over(ownFill, outer.rgb) : outer.rgb;
          for (const [k, raw] of Object.entries(p)) {
            if (!FG_BORDER.test(k)) continue;
            if (HAIRLINE.test(String(raw).trim()) && (SIDE_ONLY.test(k) || !INTERACTIVE.test(el.tag))) { decorative++; continue; }
            const { colors, misses } = resolveForeground(raw, ctx.locals);
            if (misses && first) {
              unresolved.push({ file: ctx.rel, line: el.line, what: `${keyName} ${k}`, detail: oneLine(raw) });
            }
            // A border paints over the element's own fill and delineates it against
            // whatever surrounds it, so it is composited on the fill and measured
            // against the surface outside.
            for (const fg of colors) {
              const painted = fg.a < 1 ? { rgb: over(fg, under), a: 1 } : fg;
              addRow({
                file: ctx.rel, line: el.line, key: keyName, prop: k, kind: 'ui',
                fg: painted, fgLabel: oneLine(raw), bgRgb: outer.rgb, bgLabel: outerLabel,
                bgSource: outer.source, state, note: 'component boundary vs surrounding surface',
              });
            }
          }
        }

        // A fixed-size box with a fill and no text of its own is a graphical object
        // (dot, swatch, switch track, knob, icon tile): 3:1 against its surroundings.
        const w = numberOf(p.width), h = numberOf(p.height);
        // `hasText` excludes filled containers (an icon tile, a button): their label
        // carries the meaning and is measured as text, so the fill is not the signal.
        // An element that declares a border in ANY state is bounded by it (measured as its own
        // row above), so its fill is not what a person has to see: a tinted icon tile, the
        // switch track whose off state takes an outline.
        const ownsBorder = sources.some((x) => Object.keys(x.props).some((k) => FG_BORDER.test(k)));
        if (p.backgroundColor != null && p.color == null && !el.hasText && !ownsBorder &&
            w != null && h != null && w <= 64 && h <= 64 && outer.source !== 'unknown') {
          const { colors, misses } = resolveForeground(p.backgroundColor, ctx.locals);
          if (misses && first) {
            unresolved.push({ file: ctx.rel, line: el.line, what: `${keyName} fill (${w}x${h})`, detail: oneLine(p.backgroundColor) });
          }
          for (const fg of colors) {
            addRow({
              file: ctx.rel, line: el.line, key: keyName, prop: 'backgroundColor', kind: 'ui',
              fg, fgLabel: oneLine(p.backgroundColor), fgAlpha: opacity,
              bgRgb: outer.rgb, bgLabel: outerLabel, bgSource: outer.source, state,
              note: `graphical object ${w}x${h}`,
            });
          }
        }
      }

      // Placeholder text is text (WCAG 1.4.3) and is set by prop, not by style.
      if (el.attrs.placeholderTextColor && !bgv.key) {
        for (const fg of colorCandidates(el.attrs.placeholderTextColor, ctx.locals)) {
          addRow({
            file: ctx.rel, line: el.line, key: `${keyName} placeholder`, prop: 'placeholderTextColor',
            kind: 'text', fg, fgLabel: oneLine(el.attrs.placeholderTextColor),
            bgRgb: bg.rgb, bgLabel, size: numberOf(base.fontSize), weight: base.fontWeight,
            bgSource: bg.source,
          });
        }
      }
    }
  }

  /* ---- navigation option objects (tab bar, headers) ---- */
  for (const obj of ctx.navObjects) {
    const top = {};
    for (const p of obj.props) top[p.key] = p;

    const bgOf = (prefix) => {
      const styleKey = NAV_PREFIX.find(([pre]) => pre === prefix)?.[1];
      const holder = styleKey && top[styleKey]?.obj;
      if (!holder) return null;
      const raw = holder.props.find((q) => q.key === 'backgroundColor')?.raw;
      if (!raw) return null;
      const c = colorCandidates(raw, ctx.locals)[0];
      return c ? { c, label: oneLine(raw) } : null;
    };
    const labelType = (prefix) => {
      const holder = NAV_LABEL_STYLE[prefix] && top[NAV_LABEL_STYLE[prefix]]?.obj;
      if (!holder) return {};
      const g = (k) => holder.props.find((q) => q.key === k)?.raw;
      return { size: numberOf(g('fontSize')), weight: g('fontWeight') };
    };
    const emit = (raw, label, line, prefix, extra) => {
      const bg = bgOf(prefix);
      if (!bg) return;
      const bgRgb = bg.c.a < 1 ? over(bg.c, SURFACE_PAGE.rgb) : bg.c.rgb;
      const t = { ...labelType(prefix), ...(extra ?? {}) };
      for (const fg of colorCandidates(raw, ctx.locals)) {
        addRow({
          file: ctx.rel, line, key: label, prop: 'tintColor', kind: 'text', fg,
          fgLabel: oneLine(raw), bgRgb,
          bgLabel: `${prefix}Style.backgroundColor (${bg.label})`,
          size: t.size, weight: t.weight, bgSource: 'inferred', note: 'navigation chrome',
        });
      }
    };

    for (const p of obj.props) {
      const prefix = NAV_PREFIX.find(([pre]) => p.key.startsWith(pre))?.[0];
      if (!prefix) continue;
      if (/TintColor$/.test(p.key)) { emit(p.raw, p.key, p.line, prefix, null); continue; }
      if (!p.obj) continue;
      const inner = {};
      for (const q of p.obj.props) inner[q.key] = q.raw;
      if (inner.color == null) continue;
      const ownBg = colorCandidates(inner.backgroundColor, ctx.locals)[0];
      if (ownBg) {
        // A badge carries its own fill, so it is self-contained.
        for (const fg of colorCandidates(inner.color, ctx.locals)) {
          addRow({
            file: ctx.rel, line: p.line, key: p.key, prop: 'color', kind: 'text', fg,
            fgLabel: oneLine(inner.color), bgRgb: ownBg.rgb,
            bgLabel: oneLine(inner.backgroundColor),
            size: numberOf(inner.fontSize), weight: inner.fontWeight, bgSource: 'own',
          });
        }
      } else {
        emit(inner.color, `${p.key}.color`, p.line, prefix,
          { size: numberOf(inner.fontSize), weight: inner.fontWeight });
      }
    }
  }
}

/* ------------------------------------------- runtime-selected colour groups --
 * Values chosen at render time from a map, so no single style object holds the pair.
 * SESSION_TYPES and roleTint come straight out of the parsed theme. The tint maps in
 * src/ui.tsx are literals there, so each carries a drift guard.                    */

const dyn = [];
const driftWarnings = [];

function addDyn(group, label, fgRaw, bgRaw, backdropRaw, kind, size, weight, where, note) {
  const fg = colorCandidates(fgRaw)[0];
  const bgc = colorCandidates(bgRaw)[0];
  const back = colorCandidates(backdropRaw)[0];
  if (!fg || !bgc || !back) {
    driftWarnings.push(`could not resolve ${group} / ${label} (${fgRaw} on ${bgRaw} over ${backdropRaw})`);
    return;
  }
  const bgRgb = bgc.a < 1 ? over(bgc, back.rgb) : bgc.rgb;
  const fgRgb = fg.a < 1 ? over(fg, bgRgb) : fg.rgb;
  const ratio = contrast(fgRgb, bgRgb);
  const threshold = thresholdFor(kind, size, weight);
  dyn.push({
    group, label, kind, fg: String(fgRaw), fgHex: hex(fgRgb),
    bg: `${bgRaw} over ${backdropRaw}`, bgHex: hex(bgRgb),
    size: size ?? null, weight: weight ?? null,
    ratio: r2(ratio), threshold, pass: ratio >= threshold - 1e-9, where, note,
  });
}

const uiPath = join(ROOT, 'src/ui.tsx');
const uiSrc = existsSync(uiPath) ? readFileSync(uiPath, 'utf8') : '';
const guard = (needle, what) => {
  if (uiSrc && !uiSrc.includes(needle)) {
    driftWarnings.push(`src/ui.tsx no longer contains ${needle} (${what}) - this checker's copy is stale`);
  }
  return needle;
};

/**
 * SESSION_TYPES: one colour per type, used at several sizes with different criteria.
 * In the calendar it is an Ionicons glyph, a 12x3.5 grid chip, and (if a text label is
 * ever reintroduced) small bold type. The style keys are named so that the guard below
 * shouts when the screen is restyled out from under this list.
 */
const calPath = join(ROOT, 'app/(tabs)/calendar.tsx');
const calSrc = existsSync(calPath) ? readFileSync(calPath, 'utf8') : '';
for (const key of ['evIcon', 'gridChip', 'cellInner', 'legendItem']) {
  if (calSrc && !new RegExp(`\\b${key}\\s*:`).test(calSrc)) {
    driftWarnings.push(`app/(tabs)/calendar.tsx no longer defines s.${key} - the SESSION_TYPES contexts below name it`);
  }
}

for (const [k, v] of Object.entries(THEME.SESSION_TYPES ?? {})) {
  const c = v.color;
  const solid = colorCandidates(c)[0];
  // `${t.color}22` - the type colour at 13% behind its own glyph.
  const tint = solid ? `${hex(solid.rgb)}22` : c;

  addDyn('SESSION_TYPES', `${k} - row icon glyph 16px`, c, tint, 'semantic.surfaceCard',
    'ui', null, null, 'calendar.tsx s.evIcon + <Ionicons size={16}>', 'icon on its own 13% tint');
  addDyn('SESSION_TYPES', `${k} - row icon ring`, c, tint, 'semantic.surfaceCard',
    'ui', null, null, 'calendar.tsx s.evIcon borderColor', 'ring vs the tint it encloses');
  addDyn('SESSION_TYPES', `${k} - legend icon glyph 13px`, c, 'semantic.surfacePage', 'semantic.surfacePage',
    'ui', null, null, 'calendar.tsx Legend <Ionicons size={13}>', 'icon on the page');
  addDyn('SESSION_TYPES', `${k} - grid chip, plain cell`, c, 'semantic.surfacePage', 'semantic.surfacePage',
    'ui', null, null, 'calendar.tsx s.gridChip (12x3.5)', 'graphical object in the month grid');
  addDyn('SESSION_TYPES', `${k} - grid chip, drag-target cell`, c, 'color.blueTint', 'semantic.surfacePage',
    'ui', null, null, 'calendar.tsx s.gridChip on the drop target (DayCell useAnimatedStyle)', 'graphical object on the blue drop target');
  addDyn('SESSION_TYPES', `${k} - grid chip, pressed cell`, c, 'color.ink', 'semantic.surfacePage',
    'ui', null, null, 'calendar.tsx s.gridChip on the pressed cell', 'graphical object while the cell is held');
  // On the selected cell the chip is painted night, not the type colour: the cell fill
  // is gold and every type colour measures under 3:1 on it (down to 1.03). The type is
  // still carried by the icon and the word in the day list below.
  addDyn('SESSION_TYPES', `${k} - grid chip, SELECTED cell`, 'color.night', 'color.gold', 'semantic.surfacePage',
    'ui', null, null, 'calendar.tsx s.gridChip on the selected cell (DayCell useAnimatedStyle)', 'painted night on the selected cell, not the type colour');
  // Reference only: the 11px/800 uppercase label was removed when the row went to
  // icons. Kept so the number is on record if a text label comes back.
  addDyn('SESSION_TYPES', `${k} - as 11px/800 label (reference)`, c, 'semantic.surfaceCard', 'semantic.surfacePage',
    'text', 11, '800', 'not currently rendered as text', 'small bold label on an event card');
}

// roleTint: avatar initials are fontSize size*0.36 - 14.4px at the default 40, and
// 18.72px at the 52 used on the You screen, which crosses the large-text line.
// The selected calendar day. DayCell paints it with an animated style the static scan cannot
// see (see ANIMATED_FILL), so the pairing is measured here instead.
addDyn('Calendar', 'selected day number', 'color.night', 'color.gold', 'semantic.surfacePage',
  'text', 13.5, '600', 'app/(tabs)/calendar.tsx s.cellNum on the selected cell', 'the fill is an animated style');
addDyn('Calendar', 'selected day +N label', 'color.night', 'color.gold', 'semantic.surfacePage',
  'text', 9, '700', 'app/(tabs)/calendar.tsx s.more on the selected cell', 'the fill is an animated style');

for (const [role, t] of Object.entries(THEME.roleTint ?? {})) {
  addDyn('roleTint', `${role} - initials, size 40`, t.fg, t.bg, 'semantic.surfaceCard',
    'text', 14.4, '700', 'src/ui.tsx Avatar', 'default size: 40 * 0.36 = 14.4px');
  addDyn('roleTint', `${role} - initials, size 52`, t.fg, t.bg, 'semantic.surfaceCard',
    'text', 18.72, '700', 'app/(tabs)/you.tsx <Avatar size={52}>', '52 * 0.36 = 18.72px bold = large text');
  addDyn('roleTint', `${role} - avatar ring`, t.border, t.bg, 'semantic.surfaceCard',
    'ui', null, null, 'src/ui.tsx Avatar borderColor', 'boundary vs the avatar fill');
}

// CHAT_COLORS: the colour of an account's own message bubbles. theme.ts promises that every
// one carries chalk body text and textLede stamps at AA, and "add to it only with the ratios
// measured" is a rule nobody keeps by hand, so the whole list is measured here.
for (const [k, v] of Object.entries(THEME.CHAT_COLORS ?? {})) {
  addDyn('CHAT_COLORS', `${k} - message text`, 'color.chalk', v.bg, 'semantic.surfacePage',
    'text', 15, '400', 'app/thread/[id].tsx s.text on a mine bubble', null);
  addDyn('CHAT_COLORS', `${k} - time stamp`, 'color.textLede', v.bg, 'semantic.surfacePage',
    'text', 10.5, '400', 'app/thread/[id].tsx s.stamp on a mine bubble', null);
}

// The switch knob takes the dark token on both tracks: white on gold measures 2.79 and
// on court blue 2.36, which is an invisible knob on the one setting a parent cannot
// turn off.
addDyn('Switch', 'knob on the gold track', 'color.night', 'color.gold', 'semantic.surfaceCard',
  'ui', null, null, 'src/ui.tsx s.knob', 'tone: gold');
addDyn('Switch', 'knob on the blue track', 'color.night', 'color.courtBlue', 'semantic.surfaceCard',
  'ui', null, null, 'src/ui.tsx s.knob', 'tone: blue');
addDyn('Switch', 'off track outline', 'color.textDim', 'rgba(255,255,255,0.14)', 'semantic.surfaceCard',
  'ui', null, null, 'src/ui.tsx s.track when off', 'the fill alone is 1.42, so the outline is the boundary');

// Banner tones (src/ui.tsx). Banners render directly inside <Screen>, i.e. on the page.
const BANNER_LINE = { watch: 'color.courtBlue', lock: 'color.gold', ok: 'color.slate', danger: 'color.danger' };
const BANNERS = [
  ['watch', guard("rgba(98,176,232,0.10)", 'Banner watch bg'), 'color.courtBlue'],
  ['lock', 'color.goldTint', 'color.goldHot'],
  ['ok', guard("rgba(244,241,234,0.06)", 'Banner ok bg'), 'color.chalk'],
  ['danger', guard("rgba(255,90,90,0.10)", 'Banner danger bg'), 'color.danger'],
];
for (const [tone, bg, fg] of BANNERS) {
  addDyn('Banner tones', `${tone} - title`, fg, bg, 'semantic.surfacePage', 'text', 13, '800', 'src/ui.tsx s.bannerTitle', null);
  addDyn('Banner tones', `${tone} - icon glyph`, fg, bg, 'semantic.surfacePage', 'text', 15, '400', 'src/ui.tsx s.bannerIcon', null);
  addDyn('Banner tones', `${tone} - body`, 'color.textBody', bg, 'semantic.surfacePage', 'text', 13, '400', 'src/ui.tsx s.bannerBody', null);
  addDyn('Banner tones', `${tone} - border`, BANNER_LINE[tone], bg, 'semantic.surfacePage', 'ui', null, null, 'src/ui.tsx s.banner borderColor', null);
}

// Tag tones (src/ui.tsx). Tags render inside thread rows and cards.
const TAGS = [
  ['mon', guard("rgba(98,176,232,0.14)", 'Tag mon bg'), 'color.courtBlue', 'color.courtBlue'],
  ['ro', guard("rgba(255,255,255,0.06)", 'Tag ro bg'), 'color.textDim', 'color.chalk2'],
  ['muted', 'rgba(255,255,255,0.06)', 'color.textDim', 'color.chalk2'],
];
for (const [tone, bg, fg, line] of TAGS) {
  addDyn('Tag tones', `${tone} - label`, fg, bg, 'semantic.surfaceCard', 'text', 10.5, '700', 'src/ui.tsx Tag', null);
  addDyn('Tag tones', `${tone} - border`, line, bg, 'semantic.surfaceCard', 'ui', null, null, 'src/ui.tsx s.tag borderColor', null);
}

/* -------------------------------------------------------------- reporting --- */

const dedup = new Map();
for (const r of rows) {
  const k = [r.file, r.key, r.prop, r.fgHex, r.bgHex, r.threshold, r.state].join('|');
  if (!dedup.has(k)) dedup.set(k, { ...r, seen: 1 });
  else dedup.get(k).seen++;
}
const all = [...dedup.values()];

const verified = all.filter((r) => r.bgSource !== 'assumed');
const assumed = all.filter((r) => r.bgSource === 'assumed');
const failing = all.filter((r) => !r.pass && !r.exempt);
const dynFail = dyn.filter((d) => !d.pass);
const badSelfCheck = selfCheck.filter((s) => !s.ok);

if (AS_JSON) {
  console.log(JSON.stringify({
    selfCheck, rows: all, dynamic: dyn, unresolved, driftWarnings,
    summary: {
      checked: all.length, verified: verified.length, assumed: assumed.length,
      failing: failing.length, dynamicFailing: dynFail.length,
      unresolved: unresolved.length, drift: driftWarnings.length,
    },
  }, null, 2));
  process.exit(failing.length + dynFail.length + driftWarnings.length + badSelfCheck.length > 0 ? 1 : 0);
}

const pad = (s, n) => String(s ?? '').padEnd(n).slice(0, n);
const padL = (s, n) => String(s ?? '').padStart(n);
const W = 128;

console.log('WCAG 2.1 contrast check - Geneva Tennis app');
console.log('='.repeat(W));
console.log('\nMATH SELF-CHECK against known values (the rest of this report is void if any is off)');
for (const s of selfCheck) {
  console.log(`  ${s.ok ? 'ok  ' : 'BAD '}${pad(s.fg, 10)} on ${pad(s.bg, 10)} expected ${padL(s.expected.toFixed(2), 6)}   measured ${padL(s.measured.toFixed(2), 6)}`);
}
if (badSelfCheck.length) {
  console.error('\nSELF-CHECK FAILED - the contrast implementation is wrong. No findings printed.');
  process.exit(1);
}

const sortWorst = (a, b) => (a.pass === b.pass ? a.ratio - b.ratio : a.pass ? 1 : -1);

function table(title, list) {
  console.log(`\n${title}  (${list.length})`);
  console.log('-'.repeat(W));
  console.log(
    pad('file:line', 30) + pad('style key', 26) + pad('prop', 14) +
    pad('fg', 9) + pad('bg', 9) + padL('ratio', 7) + padL('need', 6) + '  ' +
    pad('verdict', 8) + 'background'
  );
  for (const r of list) {
    console.log(
      pad(`${r.file}:${r.line}`, 30) + pad(r.key, 26) + pad(r.prop, 14) +
      pad(r.fgHex, 9) + pad(r.bgHex, 9) + padL(r.ratio.toFixed(2), 7) +
      padL(r.threshold.toFixed(1), 6) + '  ' +
      pad(r.exempt ? 'exempt' : r.pass ? 'PASS' : 'FAIL', 8) + r.bgSource
    );
    const tail = [
      `fg ${r.fg}`,
      `bg ${r.bg}`,
      r.size != null ? `${r.size}px/${String(r.weight ?? 400).replace(/['"]/g, '')}` : (r.kind === 'text' ? 'size unknown - treated as normal text' : null),
      r.kind === 'ui' ? r.note : null,
      r.state ? `state: ${r.state}${r.exempt ? ' (inactive control, WCAG-exempt)' : ''}` : null,
      r.seen > 1 ? `${r.seen} sites` : null,
    ].filter(Boolean).join(' | ');
  console.log('      ' + tail);
  }
}

table("RESOLVED PAIRS - background read from the element's own style or its JSX ancestry", verified.sort(sortWorst));

table('ASSUMED BACKGROUND - nothing in the chain declared one, so semantic.surfacePage (#0B0B0D) was used. UNVERIFIED, not "passing".', assumed.sort(sortWorst));

console.log('\nRUNTIME-SELECTED COLOURS - picked from a map at render time, so no style object holds the pair');
console.log('-'.repeat(W));
let lastGroup = null;
for (const d of dyn.sort((a, b) => a.group.localeCompare(b.group) || a.kind.localeCompare(b.kind) || a.ratio - b.ratio)) {
  if (d.group !== lastGroup) { console.log(`\n  [${d.group}]`); lastGroup = d.group; }
  console.log(
    '  ' + pad(d.label, 36) + pad(d.kind === 'ui' ? 'graphic/UI' : 'text', 12) +
    pad(d.fgHex, 9) + ' on ' + pad(d.bgHex, 9) +
    padL(d.ratio.toFixed(2), 7) + padL(d.threshold.toFixed(1), 6) + '  ' + (d.pass ? 'PASS' : 'FAIL')
  );
  console.log('      ' + [d.fg, `on ${d.bg}`, d.size != null ? `${d.size}px/${String(d.weight ?? 400).replace(/['"]/g, '')}` : null, d.where].filter(Boolean).join(' | '));
}

if (unresolved.length) {
  const seen = new Set();
  const list = unresolved.filter((u) => {
    const k = `${u.file}:${u.line}:${u.what}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  console.log(`\nCOULD NOT RESOLVE STATICALLY  (${list.length}) - not checked, and not passing`);
  console.log('-'.repeat(W));
  for (const u of list) console.log(`  ${pad(`${u.file}:${u.line}`, 32)}${pad(u.what, 34)}${u.detail}`);
}

if (untrustedFiles.length) {
  console.log(`\nJSX ANCESTRY NOT TRUSTED  (${untrustedFiles.length} files) - every background in them was forced to "assumed"`);
  console.log('-'.repeat(W));
  for (const u of untrustedFiles) console.log(`  ${u.file}\n      ${u.problems.join('\n      ')}`);
}

if (driftWarnings.length) {
  console.log('\nDRIFT - this checker holds a copy of a value that has changed');
  console.log('-'.repeat(W));
  for (const w of driftWarnings) console.log('  ' + w);
}

console.log('\n' + '='.repeat(W));
console.log(`checked ${all.length} source pairs (${verified.length} resolved background, ${assumed.length} assumed) + ${dyn.length} runtime-selected`);
console.log(`FAIL: ${failing.length} source pairs, ${dynFail.length} runtime-selected` +
  (unresolved.length ? `, plus ${unresolved.length} unresolved (unverified)` : '') +
  (driftWarnings.length ? `, plus ${driftWarnings.length} drift warnings` : ''));
console.log(`not measured: ${decorative} decorative hairlines (hairline tokens: one-sided dividers and non-interactive outlines), ${animatedSkipped} animated-fill rows measured as runtime pairs instead`);
console.log('thresholds: 4.5:1 normal text | 3:1 large text (>=24px, or >=18.66px bold) | 3:1 UI boundaries and graphical objects');
console.log('"exempt" = gated on disabled/busy/locked; WCAG 1.4.3 and 1.4.11 do not apply to inactive components.');

process.exit(failing.length + dynFail.length + driftWarnings.length + badSelfCheck.length > 0 ? 1 : 0);
