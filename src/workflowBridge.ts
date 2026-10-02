/**
 * The bridge injected into every Locker WebView.
 *
 * The coach's HTML knows nothing about this. It only has to mark its inputs with
 * `data-k="someKey"`; restore-on-open and save-on-tap are supplied here. That keeps
 * the authoring surface to plain HTML — the day a coach writes a document by hand in a
 * text editor, it saves like the others with no extra work.
 *
 * Runs inside the WebView, so this is a string, not a module. Anything referenced
 * must exist in the page, not in the bundle.
 */

/** Messages the page posts back to React Native. */
export type BridgeMessage =
  | { type: 'wfstate'; answers: Record<string, string | boolean | number> }
  | { type: 'wffields'; count: number }
  | { type: 'wfheight'; height: number };

const RESTORE_AND_LISTEN = `
(function () {
  if (window.__gtBridge) return;          // injectedJavaScript re-runs on some navigations
  window.__gtBridge = true;

  var STATE = __STATE__;

  function nodes() { return document.querySelectorAll('[data-k]'); }

  function restore() {
    nodes().forEach(function (el) {
      var v = STATE[el.dataset.k];
      if (v === undefined) return;
      if (el.type === 'checkbox') el.checked = !!v; else el.value = v;
    });
    // Let the document's own listeners (running totals, etc.) see the restored values.
    document.dispatchEvent(new Event('change', { bubbles: true }));
    // How many answers this document even has. A tool like the Match Tracker keeps its
    // own record on the phone and marks nothing, so Save would write an empty submission
    // and the "your answers save to your account" hint would be a lie. Reporting the
    // count lets the screen hide Save for ANY such page rather than naming one.
    send({ type: 'wffields', count: nodes().length });
  }

  function collect() {
    var out = {};
    nodes().forEach(function (el) {
      var v = el.type === 'checkbox' ? el.checked : el.value;
      // Empty strings and unchecked boxes are absence, not data. Dropping them keeps
      // the document under the 200-key ceiling the security rule enforces.
      if (v !== '' && v !== false) out[el.dataset.k] = v;
    });
    return out;
  }

  function send(msg) {
    if (window.ReactNativeWebView) window.ReactNativeWebView.postMessage(JSON.stringify(msg));
  }

  // React Native asks by injecting \`window.__gtCollect()\`; the page answers over onMessage.
  window.__gtCollect = function () { send({ type: 'wfstate', answers: collect() }); };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', restore);
  } else {
    restore();
  }

  true;   // iOS: a non-null final value or injectedJavaScript logs a warning
})();
`;

/** Build the injected script, pre-seeded with whatever the player saved last time. */
export function bridgeScript(saved: Record<string, unknown> | undefined): string {
  // JSON.stringify output is already valid JS source, so it is spliced in as-is —
  // re-escaping the backslashes would corrupt any answer that contains one. Only the
  // two sequences JSON permits but a script context does not are rewritten.
  const json = JSON.stringify(saved ?? {})
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
  return RESTORE_AND_LISTEN.replace('__STATE__', json);
}

/** Injected on demand when the player taps Save. */
export const COLLECT_SCRIPT = 'window.__gtCollect && window.__gtCollect(); true;';

/**
 * A one-line summary for the Locker list, matching the preview's saved-pill copy.
 *
 * This is what the COACH reads down the roster. Nothing shipped today has a shape worth a
 * line of its own, so this is the generic count, which is honest about knowing nothing
 * rather than inventing a number. The day a worksheet needs a real line, add a
 * summarizer above and try it first: detect it by KEY SHAPE rather than by workflow id,
 * so a submission saved before the id was denormalised onto the document still reads
 * properly. Every value a page saves is a STRING (its set() writes String(v)), which is
 * why the checkbox branch below is useless to a numeric form: nothing is ever `true`.
 */
export function summarize(answers: Record<string, unknown>): string {
  const done = Object.values(answers).filter((v) => v === true).length;
  const filled = Object.keys(answers).length;
  if (done) return `${done} of the blocks done`;
  return `${filled} field${filled === 1 ? '' : 's'} filled`;
}

/** Self-check. `npm run test:bridge`. */
export function demo(): string {
  const eq = (got: unknown, want: unknown, what: string) => {
    if (String(got) !== String(want)) throw new Error(`${what}: got ${got}, wanted ${want}`);
  };

  // Checkbox worksheets: the count of ticked blocks.
  eq(summarize({ Week10: true, Week11: true, notes: 'x' }), '2 of the blocks done', 'checkboxes');
  eq(summarize({ opponent: 'Dillard', pts: '12' }), '2 fields filled', 'a typed form');
  eq(summarize({ opponent: 'Dillard' }), '1 field filled', 'one field is singular');
  eq(summarize({}), '0 fields filled', 'nothing saved');

  // The saved answers are spliced into a script as source. A stray close tag, or a line
  // separator that is legal in JSON and not in a script, must not break out of it.
  const hostile = bridgeScript({ k: '</script><b>\u2028\u2029' });
  if (hostile.includes('</script>') || hostile.includes('\u2028') || hostile.includes('\u2029')) {
    throw new Error('bridgeScript let a close tag or a line separator through');
  }
  // And the state it restores is the state it was given.
  if (!hostile.includes('"k"')) throw new Error('bridgeScript lost the saved answers');

  return 'workflowBridge.ts: all checks passed';
}
