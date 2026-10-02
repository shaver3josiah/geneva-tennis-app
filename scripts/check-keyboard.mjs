/**
 * The keyboard must never cover the field being typed into, on either platform.
 *
 * This is a STATIC check, on purpose: there is no simulator on the machine this repo is
 * developed on, so the next best thing is to pin the things that were actually wrong.
 *
 * THE HISTORY MATTERS, because every wrong fix looked right in a diff.
 *
 * 1. `behavior={Platform.OS === 'ios' ? 'padding' : undefined}` on five screens: no
 *    avoidance at all on Android.
 * 2. `behavior="padding"` on both platforms with a hand-computed header offset: still
 *    nothing, because React Native's own KeyboardAvoidingView cannot work here at all.
 *    From Android 15 (target SDK 35) edge to edge is forced, the window never resizes
 *    under the keyboard, and that component has nothing left to measure. It is
 *    facebook/react-native#49759 and it is still open.
 * 3. react-native-keyboard-controller, but with a 24dp `bottomOffset`. The phone moved
 *    the form and the field was STILL mostly hidden, because `bottomOffset` is the gap
 *    between the keyboard and the CARET, not the bottom of the box. On a multiline
 *    field the caret starts on the first line, so the first line cleared the keyboard
 *    and the other two thirds of the box did not. And the message composer used the
 *    library's KeyboardAvoidingView, whose padding is computed from window height, a
 *    measured frame and a header offset, and on that phone came out short.
 *
 * So the rules below pin the shape that survived all of that:
 *   - Forms scroll their field into view: `Screen` or `KeyboardForm`, both on
 *     KeyboardAwareScrollView, with a caret gap big enough to clear a multiline box.
 *   - The thread's composer sticks to the keyboard with KeyboardStickyView, which moves
 *     by the one number the keyboard actually reports and nothing else.
 *   - Nothing anywhere reaches React Native's KeyboardAvoidingView, and the retired
 *     KeyboardPad wrapper does not come back under either name.
 *   - KeyboardProvider wraps the root, or none of the above moves at all.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const walk = (dir) =>
  readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : p.endsWith('.tsx') ? [p] : [];
  });

const rel = (p) => p.replace(/\\/g, '/');
const screens = walk('app').map(rel);
const problems = [];
const CONTAINERS = /<(KeyboardForm|Screen|KeyboardStickyView)[\s>]/;

/** The smallest caret gap that clears the tallest multiline field in the app (the
 *  88dp notes box on the schedule screen) with the caret on its first line. */
const MIN_GAP = 72;

for (const f of [...screens, 'src/ui.tsx']) {
  const src = readFileSync(f, 'utf8');

  // The built-in component, by any route. Comments name it, so only imports count.
  if (
    /import\s*\{[^}]*\bKeyboardAvoidingView\b[^}]*\}\s*from\s*'react-native'/s.test(src) ||
    /^\s*KeyboardAvoidingView,\s*$/m.test(src)
  ) {
    problems.push(
      `${f}: imports KeyboardAvoidingView from react-native. That one does not work on ` +
        `Android 15 and up. Forms use <KeyboardForm> or <Screen>; a bar over a list uses ` +
        `<KeyboardStickyView>.`
    );
  }
  if (/\bKeyboardPad\b/.test(src.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, ''))) {
    problems.push(`${f}: KeyboardPad is retired. It was a padding wrapper and it came out short on a real phone twice.`);
  }
}

for (const f of screens) {
  const src = readFileSync(f, 'utf8');
  if (/<TextInput[\s>]/.test(src) && !CONTAINERS.test(src)) {
    problems.push(
      `${f}: has a TextInput but no <KeyboardForm>, <Screen> or <KeyboardStickyView>, ` +
        `so the keyboard will cover it.`
    );
  }
}

// The form scrollers, and the one number that decides whether a multiline box clears.
const ui = readFileSync('src/ui.tsx', 'utf8');
if (!/from\s*'react-native-keyboard-controller'/.test(ui)) {
  problems.push('src/ui.tsx: must take KeyboardAwareScrollView from react-native-keyboard-controller.');
}
const gapMatch = ui.match(/const KEYBOARD_GAP = (\d+);/);
const gap = gapMatch ? Number(gapMatch[1]) : 0;
if (gap < MIN_GAP) {
  problems.push(
    `src/ui.tsx: KEYBOARD_GAP is ${gap}; it must be at least ${MIN_GAP}. bottomOffset is ` +
      `measured to the CARET, and below this the notes box on the schedule screen sits ` +
      `mostly under the keyboard while its first line peeks out. That is the bug that was photographed on a real phone.`
  );
}
for (const name of ['Screen', 'KeyboardForm']) {
  const start = ui.indexOf(`export function ${name}(`);
  const body = start === -1 ? '' : ui.slice(start, ui.indexOf('\nexport ', start + 1));
  if (!/<KeyboardAwareScrollView/.test(body)) {
    problems.push(`src/ui.tsx: ${name} must scroll with KeyboardAwareScrollView, or a field low on a long form is never moved out from under the keyboard.`);
  }
  if (!/bottomOffset=\{KEYBOARD_GAP\}/.test(body)) {
    problems.push(`src/ui.tsx: ${name} must pass bottomOffset={KEYBOARD_GAP}, not a literal, so the gap is decided once.`);
  }
}

// The thread: a composer over a list, which is the one shape a scroller cannot serve.
const thread = readFileSync('app/thread/[id].tsx', 'utf8');
if (!/<KeyboardStickyView[\s>]/.test(thread)) {
  problems.push("app/thread/[id].tsx: the composer must sit inside <KeyboardStickyView>. A padding wrapper here came out short on a real phone.");
}
if (!/useReanimatedKeyboardAnimation\(\)/.test(thread) || !/ListFooterComponent=/.test(thread)) {
  problems.push('app/thread/[id].tsx: the list needs a keyboard-height spacer (useReanimatedKeyboardAnimation + ListFooterComponent), or the bar covers the newest messages when it lifts.');
}

const layout = readFileSync('app/_layout.tsx', 'utf8');
if (!/<KeyboardProvider>/.test(layout)) {
  problems.push('app/_layout.tsx: KeyboardProvider must wrap the app. Without it every keyboard-aware component renders normally and simply never moves.');
}

const wrapped = screens.filter((f) => CONTAINERS.test(readFileSync(f, 'utf8')));
if (problems.length) {
  for (const p of problems) console.error(`  ${p}`);
  console.error(`\nkeyboard: ${problems.length} problem(s) across ${screens.length} screens.`);
  process.exit(1);
}
console.log(
  `keyboard: ${wrapped.length} screens go through KeyboardForm/Screen/KeyboardStickyView ` +
    `(caret gap ${gap}dp), none reach the built-in KeyboardAvoidingView`
);
