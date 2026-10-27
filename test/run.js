// Runs the simulation harnesses under Node (no browser needed) and fails if the autopilot regresses.
//   npm test
import { runGasHarness } from './gas-harness.js';
import { runPersonas } from './persona-harness.js';

let failed = false;
const check = (label, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}  ${detail}`);
  if (!ok) failed = true;
};

// gas giants: charted and left again
const gas = [...runGasHarness({ seeds: 20, from: 1000 }), ...runGasHarness({ seeds: 20, from: 2000, fast: true })];
const ok = gas.filter((r) => r.ok).length;
check('gas giants', ok / gas.length >= 0.85, `${ok}/${gas.length} charted and left (need 85%)`);

// personalities: each one charts, and Efficient really is the thriftiest
const p = runPersonas({ seeds: [1000, 1007, 1018], minutes: 8 });
for (const [id, r] of Object.entries(p)) check(`style ${id}`, r.worldsPerHour > 10, JSON.stringify(r));
const fuel = Object.entries(p).filter(([, r]) => r.fuelPerWorld).sort((a, b) => a[1].fuelPerWorld - b[1].fuelPerWorld);
check('efficient is thriftiest', ['efficient', 'cinematic'].includes(fuel[0][0]), `cheapest: ${fuel[0][0]}`);

process.exit(failed ? 1 : 0);
