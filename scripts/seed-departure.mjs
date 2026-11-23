/**
 * `npm run seed:departure` — build the departure demo in Node and check it holds together.
 *
 * The seed is deterministic given `now`, and every cut-off is relative to it (the demo must open
 * with flights still ahead of their window), so there is nothing to freeze into a file: this
 * script builds the same state the browser builds, runs shared/seed/validate.js over it, prints
 * what it holds, and exits non-zero on the first broken invariant.
 *
 *   --now=<iso>   build as if it were this moment (default: now)
 *   --json=<path> also write the built state to a file (for inspection, not for the app)
 */
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createStore } from '../shared/store.js';
import { seedDeparture, SEED_VERSION } from '../shared/seed/departure.js';
import { validateState, summarise } from '../shared/seed/validate.js';

const arg = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=').slice(1).join('=');

const nowArg = arg('now');
const now = nowArg ? new Date(nowArg).getTime() : Date.now();
if (!Number.isFinite(now)) {
  console.error(`seed:departure — "${nowArg}" is not a date.`);
  process.exit(1);
}

const state = createStore({ storage: null, baseAccounts: false }).get();
seedDeparture(state, { now });

const problems = validateState(state);
const s = summarise(state);

console.log(`seed:departure — version ${SEED_VERSION}, built at ${new Date(now).toISOString()}`);
console.log(`  ${s.airlines} airlines · ${s.flights} flights · ${s.travelers} travelers · ${s.residences} residences`);
console.log(`  ${s.areas} collection areas · ${s.slots} slots · ${s.assignments} booked collections`);
console.log(`  ${s.bags} bags · ${s.bagTags} tags · ${s.users} users · ${s.drivers} drivers · ${s.trucks} trucks`);
for (const [status, n] of Object.entries(s.bagsByStatus)) console.log(`    ${String(n).padStart(3)} ${status}`);
for (const f of state.flights.filter((x) => x.cut_off_at)) {
  console.log(`  ${String(f.code).padEnd(8)} ${String(f.status).padEnd(10)} cut-off ${f.cut_off_at}`);
}

const jsonPath = arg('json');
if (jsonPath) {
  const out = resolve(process.cwd(), jsonPath);
  writeFileSync(out, JSON.stringify(state, null, 2));
  console.log(`  wrote ${out}`);
}

if (problems.length) {
  console.error(`\nseed:departure FAILED — ${problems.length} problem(s):`);
  for (const x of problems) console.error(`  • ${x}`);
  process.exit(1);
}
console.log('\nseed:departure OK — every invariant holds.');
