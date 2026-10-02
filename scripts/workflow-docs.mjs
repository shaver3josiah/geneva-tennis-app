/**
 * The sample training documents a coach publishes to the Locker, for `npm run seed`.
 *
 * Plain HTML with `data-k` attributes and nothing else: the restore/collect bridge is
 * injected by the app (src/workflowBridge.ts), so a coach writing HTML in any editor gets
 * saving for free and never has to know the bridge exists.
 *
 * A document may also be a whole file under scripts/worksheets/ instead of a body
 * assembled here. Those skip the shared wrapper entirely, which is the point: a file
 * that brings its own CSS opens in a browser by double-clicking it, so the coach can
 * try a worksheet before it goes anywhere near the app.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const BY = 'Geneva Tennis';

const esc = (s) =>
  String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

const block = (title, items) =>
  `<section><h2>${esc(title)}</h2>` +
  items
    .map(
      (t, i) =>
        `<label class="chk"><input type="checkbox" data-k="${esc(title.slice(0, 6) + i)}"><span>${esc(t)}</span></label>`
    )
    .join('') +
  '</section>';

const field = (k, label, type) => {
  const input =
    type === 'textarea'
      ? `<textarea data-k="${k}" rows="3" placeholder="Type here…"></textarea>`
      : `<input type="number" data-k="${k}" min="1" max="10" placeholder="1–10">`;
  return `<section><h2>${esc(label)}</h2>${input}</section>`;
};

const textInput = (k, label, placeholder) =>
  `<section><h2>${esc(label)}</h2><input type="text" data-k="${k}" placeholder="${esc(placeholder)}"></section>`;

const dateInput = (k, label) =>
  `<section><h2>${esc(label)}</h2><input type="date" data-k="${k}"></section>`;

const numInput = (k, label, min, max, placeholder) =>
  `<section><h2>${esc(label)}</h2>` +
  `<input type="number" data-k="${k}" min="${min}" max="${max}" placeholder="${esc(placeholder)}"></section>`;

/** The one number a document turns on, so it gets its own box. */
const headline = (k, label, hint, max) =>
  `<div class="big"><h2>${esc(label)}</h2>` +
  `<input type="number" data-k="${k}" min="0" max="${max}" placeholder="0">` +
  `<p style="font-size:.8rem;color:#5E4A1F;margin-top:8px">${esc(hint)}</p></div>`;

/** Several 0-10 rows under one heading. */
const ratings = (title, items) =>
  `<section><h2>${esc(title)}</h2>` +
  items
    .map(
      ([k, labelText]) =>
        `<label class="rr"><span>${esc(labelText)}</span>` +
        `<input type="number" data-k="${k}" min="0" max="10" placeholder="0–10"></label>`
    )
    .join('') +
  '</section>';

/** Where the serves went. Keys m0..m5 and a0..a5 are what TOTALS_JS adds up. */
const serveTable = () => {
  const targets = ['Deuce wide', 'Deuce body', 'Deuce T', 'Ad wide', 'Ad body', 'Ad T'];
  return (
    '<section><h2>By target</h2><table><tr><th>Target</th><th>In</th><th>Serves</th></tr>' +
    targets
      .map(
        (s, i) =>
          `<tr><td>${esc(s)}</td>` +
          `<td><input type="number" data-k="m${i}" min="0" placeholder="0"></td>` +
          `<td><input type="number" data-k="a${i}" min="0" placeholder="0"></td></tr>`
      )
      .join('') +
    '</table><p class="tot" id="tot">0 in · 0 serves</p></section>'
  );
};

// These render on a WHITE page inside the Locker, so the brand gold is a fill and a rule
// colour here, and text that has to be read uses old gold (4.5:1 on white) or deep gold.
const CSS = [
  '*{box-sizing:border-box;margin:0;padding:0}',
  'body{font:15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;color:#1a1a20;background:#fff;padding:20px 18px 30px}',
  'h1{font-size:1.32rem;line-height:1.2;color:#0B0B0D;margin-bottom:4px;letter-spacing:-.01em}',
  '.by{font-size:.74rem;text-transform:uppercase;letter-spacing:.14em;color:#89734C;font-weight:700;margin-bottom:14px}',
  '.note{background:#F8F3E6;border-left:3px solid #B8964F;padding:10px 12px;font-size:.85rem;color:#5E4A1F;border-radius:0 6px 6px 0;margin-bottom:20px}',
  'section{margin-bottom:22px}',
  'h2{font-size:.72rem;text-transform:uppercase;letter-spacing:.13em;color:#6C6C78;margin-bottom:10px;padding-bottom:6px;border-bottom:1px solid #E7E3DC}',
  '.chk{display:flex;gap:10px;align-items:flex-start;padding:9px 0;cursor:pointer;font-size:.9rem}',
  '.chk input{width:19px;height:19px;flex:none;margin-top:1px;accent-color:#B8964F;cursor:pointer}',
  '.chk input:checked+span{color:#8a8a95;text-decoration:line-through}',
  'textarea,input[type=number],input[type=text],input[type=date]{width:100%;font:inherit;font-size:.88rem;padding:9px 11px;border:1px solid #d8d4cd;border-radius:7px;background:#FAFAF8;color:#1a1a20}',
  'textarea:focus,input:focus{outline:2px solid #B8964F;outline-offset:1px;border-color:#B8964F}',
  'table{width:100%;border-collapse:collapse}',
  'th{text-align:left;font-size:.68rem;text-transform:uppercase;letter-spacing:.1em;color:#6C6C78;padding:0 0 7px}',
  'th:not(:first-child){width:74px}',
  'td{padding:4px 0;font-size:.86rem;border-top:1px solid #F0EDE8}',
  'td:not(:first-child){padding-left:8px}',
  'td input{padding:7px 9px;text-align:center}',
  '.rr{display:flex;align-items:center;gap:10px;padding:8px 0;border-top:1px solid #F0EDE8}',
  '.rr span{flex:1;font-size:.88rem}',
  '.rr input{width:78px;flex:none;text-align:center;padding:7px 9px}',
  '.big{background:#F8F3E6;border:1px solid #B8964F;border-radius:8px;padding:12px;margin-bottom:20px}',
  '.big h2{border:0;padding:0;margin-bottom:8px;color:#5E4A1F}',
  '.big input{font-size:1.3rem;font-weight:700;text-align:center;width:110px}',
  '.tot{margin-top:12px;font-size:.85rem;font-weight:700;color:#5E4A1F}',
  '.foot{margin-top:26px;padding-top:14px;border-top:1px solid #E7E3DC;font-size:.72rem;color:#9C9CA9;text-align:center}',
].join('');

/** Running totals for the serve log. Content-specific, so it lives in the document. */
const TOTALS_JS = [
  'function gtTotals(){',
  '  var t=document.getElementById("tot"); if(!t) return;',
  '  var m=0,a=0;',
  '  document.querySelectorAll("[data-k]").forEach(function(el){',
  '    if(/^m\\d/.test(el.dataset.k)) m+=(+el.value||0);',
  '    if(/^a\\d/.test(el.dataset.k)) a+=(+el.value||0);',
  '  });',
  '  var pct=a?" \\u00B7 "+Math.round(m/a*100)+"%":"";',
  '  t.textContent=m+" in \\u00B7 "+a+" serves"+pct;',
  '}',
  'gtTotals();',
  'document.addEventListener("input",gtTotals);',
  'document.addEventListener("change",gtTotals);',
].join('\n');

const BODIES = {
  w1: {
    name: '4-Week Serve & Return Block',
    body:
      `<h1>4-Week Serve &amp; Return Block</h1><p class="by">${BY}</p>` +
      '<p class="note">Check a block when the work is done. Not when you started it.</p>' +
      block('Week 1 — Serve foundations', [
        'Toss and trophy position, 3×10 with no ball struck',
        'Second serve, kick to the backhand, 40 balls',
        'First serve to the T, both courts, 30 balls',
      ]) +
      block('Week 2 — Return of serve', [
        'Block returns off a 70% serve, 40 balls',
        'Deep cross-court return, deuce and ad, 30 balls',
        'Return and first-ball patterns, 6 sets of 5',
      ]) +
      block('Week 3 — Serve plus one', [
        'Wide serve into forehand, 25 reps',
        'T serve into open court, 25 reps',
        'Body serve and volley, 20 reps',
      ]) +
      block('Week 4 — Put it live', [
        'Serve games to 4, 6 games',
        'Return games to 4, 6 games',
        'Film review with Coach',
      ]) +
      field('notes', 'What felt hardest this month?', 'textarea'),
    script: '',
  },
  w2: {
    name: 'Pre-Practice Warmup Protocol',
    body:
      `<h1>Pre-Practice Warmup</h1><p class="by">${BY}</p>` +
      '<p class="note">Ten minutes. Every session. No exceptions, no shortcuts.</p>' +
      block('Movement prep', [
        'Leg swings, 10 each direction',
        'Hip 90/90, 8 each side',
        'Ankle rocks, 15 each',
      ]) +
      block('Activation', ['Lateral band walk, 2×12', 'Pogo hops, 3×10', 'Split-step and recover, 3×8']) +
      block('Racket prep', [
        'Shadow strokes, forehand and backhand, 30s each',
        'Mini-tennis, service box to service box, 3 minutes',
        'Serve warm-up from the baseline, 10 balls',
      ]) +
      field('rpe', 'How did the body feel today? (1 dead — 10 fresh)', 'number'),
    script: '',
  },
  w4: {
    name: 'Weekly Match Evaluation',
    cadence: 'weekly',
    body:
      `<h1>Weekly Match Evaluation</h1><p class="by">${BY}</p>` +
      '<p class="note">Fill this in after the match, not on Sunday night from memory. ' +
      'Honest numbers or it is worth nothing to either of us.</p>' +
      headline(
        'firstserve',
        'First serves in (%)',
        'This is the number we are moving. Sixty becoming sixty-five wins sets.',
        100
      ) +
      textInput('opponent', 'Who did you play?', 'Opponent') +
      dateInput('matchdate', 'What day was the match?') +
      textInput('score', 'The score', '6-4, 3-6, 10-7') +
      ratings('The numbers', [
        ['aces', 'Aces'],
        ['dfs', 'Double faults'],
        ['winners', 'Winners'],
        ['ues', 'Unforced errors'],
      ]) +
      ratings('Rate yourself, 0 to 10', [
        ['r_effort', 'Effort — did you empty the tank?'],
        ['r_decisions', 'Decisions — right shot, right time?'],
        ['r_footwork', 'Footwork — first step and recovery'],
        ['r_composure', 'Composure after a lost point'],
      ]) +
      field('coachsaid', 'What did your coach tell you?', 'textarea') +
      field('onething', 'One thing you would do differently', 'textarea'),
    script: '',
  },
  w5: {
    name: 'Quarterly Progress Report',
    cadence: 'quarterly',
    body:
      `<h1>Quarterly Progress Report</h1><p class="by">${BY}</p>` +
      '<p class="note">Three months of work, looked at straight. Write what happened, ' +
      'not what you meant to happen.</p>' +
      numInput('lad_start', 'Singles ladder spot at the start of the quarter', 1, 20, '1–20') +
      numInput('lad_now', 'Where you are now', 1, 20, '1–20') +
      field('goalset', 'What did we set out to fix this quarter?', 'textarea') +
      field('goalmet', 'Did you fix it? Say how you know.', 'textarea') +
      field('improved', 'What got better that you can point to', 'textarea') +
      field('stuck', 'What is still stuck', 'textarea') +
      block('The standards, honestly', [
        'I was on court, ready, 10 minutes early, every session',
        'I brought my journal and filled it in',
        'I did the work between sessions, not just at sessions',
        'I was coachable when the correction was hard to hear',
      ]) +
      field('nextgoal', 'What are we fixing next quarter?', 'textarea'),
    script: '',
  },
  w6: {
    name: 'Session Journal',
    cadence: 'daily',
    body:
      `<h1>Session Journal</h1><p class="by">${BY}</p>` +
      '<p class="note">Two minutes, before you leave the court. While it is still fresh.</p>' +
      textInput('worked', 'What did we work on?', 'Serve toss, footwork…') +
      field('clicked', 'What clicked?', 'textarea') +
      field('didnt', 'What did not?', 'textarea') +
      numInput('effort', 'Your effort today, 1 to 10', 1, 10, '1–10'),
    script: '',
  },
  w3: {
    name: 'Serve Log — 100 Serves',
    body:
      `<h1>Serve Log — 100 Serves</h1><p class="by">${BY}</p>` +
      '<p class="note">Count the serves that landed in, and log every serve honestly — the ratio is the point.</p>' +
      serveTable() +
      field('notes', 'Where did the misses cluster?', 'textarea'),
    script: TOTALS_JS,
  },
  // The key is the seeded document id, and it deliberately matches the id
  // scripts/build-worksheets.mjs gives the same file inside the binary.
  // subscribeWorkflows drops a built-in whose id is already published, so seeding
  // REPLACES the shipped copy. Under any other key the demo Locker listed the Match
  // Tracker twice, once from the binary and once from Firestore.
  'builtin-match-tracker': {
    // The live match tracker: the camera follows the ball and both players, and every
    // point is logged to the team's sheet. Built by scripts/build-tracker.mjs.
    name: 'Match Tracker',
    cadence: 'daily',
    file: 'match-tracker.html',
  },
};

export function workflowDocs() {
  return Object.entries(BODIES).map(([id, { name, body, script, cadence, file }]) => {
    const html = file
      ? readFileSync(fileURLToPath(new URL(`worksheets/${file}`, import.meta.url)), 'utf8')
      :
      '<!doctype html><meta charset="utf-8">' +
      '<meta name="viewport" content="width=device-width,initial-scale=1">' +
      `<title>${esc(name)}</title>` +
      `<style>${CSS}</style><body>${body}` +
      '<p class="foot">Published by your coach · rendered inside Geneva Tennis</p>' +
      (script ? '<script>' + script + '</scr' + 'ipt>' : '') +
      '</body>';
    // Absent cadence means 'once' — the original documents keep one saved copy.
    return { id, name, html, cadence: cadence ?? 'once', sizeBytes: Buffer.byteLength(html, 'utf8') };
  });
}

// Run directly (`node scripts/workflow-docs.mjs`) to print a size report.
if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('workflow-docs.mjs')) {
  for (const d of workflowDocs())
    console.log(`${d.id}  ${d.name.padEnd(30)} ${d.cadence.padEnd(10)} ${d.sizeBytes} bytes`);
}
