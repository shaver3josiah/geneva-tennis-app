/**
 * Expo's own dependencies (@expo/log-box) import CSS modules from TypeScript source.
 * Their package ships no .d.ts, so tsc resolves the raw .tsx and then cannot find the
 * stylesheet imports. Declaring the wildcard module makes `npm run typecheck` — and
 * therefore CI — report only OUR errors instead of drowning them in library noise.
 */
declare module '*.module.css' {
  const classes: Record<string, string>;
  export default classes;
}
