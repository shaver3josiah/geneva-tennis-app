/**
 * Builds scripts/worksheets/match-tracker.html: ONE self-contained page (the Locker's
 * Match Tracker, the in-app live tracker, and the standalone demo are the same file).
 *
 * It inlines, in order: the shared match logic (src/tennis/*.js — the same modules the app
 * imports, so the tracker and the coach's sheet can never disagree about a stat) and the
 * tracker's own modules (tracker/*.js). ES-module syntax is stripped because the page runs
 * them as one classic script: `export ` keywords go, single-line `import { … } from './x.js'`
 * lines go. src/tennis files keep their top-level names unique for exactly this reason.
 *
 *   node scripts/build-tracker.mjs          write the page
 *   node scripts/build-tracker.mjs --check  fail if the committed page is stale (CI)
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'scripts', 'worksheets', 'match-tracker.html');
const SHARED = ['score', 'stats', 'trends', 'xlsx', 'sheets'].map((f) => join(ROOT, 'src', 'tennis', `${f}.js`));
const OWN = ['engine', 'vision', 'app'].map((f) => join(ROOT, 'tracker', `${f}.js`));

const read = (p) => readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
const strip = (src) =>
  src
    .replace(/^import\s+[^;]*?from\s+['"][^'"]+['"];?\s*$/gm, '')
    .replace(/^export\s+(?=(async\s+)?(function|class|const|let|var)\b)/gm, '')
    .replace(/^export\s*\{[^}]*\}\s*(from\s+['"][^'"]+['"])?;?\s*$/gm, '');

export function render() {
  for (const p of [...SHARED, ...OWN]) if (!existsSync(p)) throw new Error(`missing ${p}`);
  const parts = [
    ...SHARED.map((p) => `/* ==== ${p.slice(ROOT.length + 1).replace(/\\/g, '/')} ==== */\n${strip(read(p))}`),
    ...OWN.map((p) => `/* ==== ${p.slice(ROOT.length + 1).replace(/\\/g, '/')} ==== */\n${read(p)}`),
  ];
  // "</script" inside a string would end the inline script early.
  const js = parts.join('\n').replace(/<\/script/gi, '<\\/script');
  const shell = read(join(ROOT, 'tracker', 'shell.html'));
  if (!shell.includes('<!-- @SCRIPTS -->')) throw new Error('tracker/shell.html lost its <!-- @SCRIPTS --> marker');
  return shell.replace('<!-- @SCRIPTS -->', () => `<script>\n"use strict";\n${js}\n</script>`);
}

const html = render();
// Syntax-check the inlined script before writing anything a phone will load.
try {
  const js = html.slice(html.indexOf('<script>\n') + 9, html.lastIndexOf('</script>'));
  new Function(js.replace(/^"use strict";/, ''));
} catch (e) {
  console.error('build-tracker: the inlined script does not parse:', e.message);
  process.exit(1);
}
if (process.argv.includes('--preview')) {
  // The hosted demo page is wrapped in its own document skeleton by the host, so it carries
  // no doctype/html/head/body of its own, and it says it is a preview (no file downloads).
  const body = html
    .replace(/<!doctype html>\s*/i, '').replace(/<html[^>]*>\s*/i, '').replace(/<\/html>\s*$/i, '')
    .replace(/<head>\s*/i, '').replace(/<\/head>\s*/i, '').replace(/<body>\s*/i, '').replace(/<\/body>\s*/i, '')
    .replace(/<meta charset="utf-8">\s*/i, '').replace(/<meta name="viewport"[^>]*>\s*/i, '')
    .replace('<script>\n"use strict";', '<script>\n"use strict";\nwindow.GT_PREVIEW = true;');
  const dist = join(ROOT, 'dist'); mkdirSync(dist, { recursive: true });
  writeFileSync(join(dist, 'match-tracker-preview.html'), body);
  console.log('tracker: wrote dist/match-tracker-preview.html');
}
if (process.argv.includes('--check')) {
  const cur = existsSync(OUT) ? read(OUT) : '';
  if (cur !== html) { console.error('scripts/worksheets/match-tracker.html is stale. Run: npm run tracker'); process.exit(1); }
  console.log('tracker: page is current');
} else {
  writeFileSync(OUT, html);
  console.log(`tracker: wrote ${OUT} (${Buffer.byteLength(html)} bytes)`);
}
