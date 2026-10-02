/**
 * node scripts/prune-dev-certs.mjs           list what would be revoked (default)
 * node scripts/prune-dev-certs.mjs --revoke  revoke them
 *
 * Every cloud-signed iOS archive on a fresh CI runner mints a new "Created via API"
 * Apple Development certificate, because the previous one's private key was destroyed
 * with its runner and can never be used again. The team has a small cap on these, so
 * after enough releases the archive fails with "Your account has reached the maximum
 * number of certificates" -- which is what stopped v1.0.5 on 22 September 2026.
 *
 * Revoking them breaks nothing: no private key for any of them exists anywhere. The
 * filter is deliberately narrow, and a cert survives if EITHER test fails:
 *   - type is a Development type (never a Distribution cert, which ships the app), and
 *   - its name says "Created via API" (never one a person made on a real Mac).
 */
import { asc } from './appstore-metadata.mjs';

const REVOKE = process.argv.includes('--revoke');
const DEV_TYPES = new Set(['DEVELOPMENT', 'IOS_DEVELOPMENT', 'MAC_APP_DEVELOPMENT']);

export const isThrowaway = (a) =>
  DEV_TYPES.has(a.certificateType) &&
  /created via api/i.test(`${a.displayName ?? ''} ${a.name ?? ''}`);

const { data } = await asc('certificates?limit=200');
const all = data.map((c) => ({ id: c.id, ...c.attributes }));
const doomed = all.filter(isThrowaway);

console.log(`${all.length} certificates on the team; ${doomed.length} are CI throwaways.\n`);
for (const c of all) {
  const mark = isThrowaway(c) ? (REVOKE ? 'REVOKE' : 'would revoke') : 'keep';
  console.log(`  ${mark.padEnd(12)} ${c.certificateType.padEnd(22)} ${String(c.displayName ?? c.name).slice(0, 40).padEnd(40)} expires ${String(c.expirationDate).slice(0, 10)}`);
}

if (!REVOKE) {
  console.log('\nDry run. Nothing was changed. Re-run with --revoke to revoke the rows marked above.');
} else {
  for (const c of doomed) await asc(`certificates/${c.id}`, { method: 'DELETE' });
  console.log(`\nRevoked ${doomed.length}. Apple emails one notice per certificate; nothing on any device is affected.`);
}
