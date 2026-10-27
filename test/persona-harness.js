// Test harness: flies each autopilot personality through the same systems (no rendering) and reports
// worlds charted, fuel burned per world, slingshots, tours and crashes. Run from the browser console:
//   const { runPersonas } = await import('/test/persona-harness.js'); runPersonas()
import { Universe } from '../js/universe.js';
import { Autopilot } from '../js/autopilot.js';
import { PERSONALITIES } from '../js/personalities.js';

export function runPersonas({ seeds = [1000, 1003, 1007, 1011, 1018, 1024], minutes = 15 } = {}) {
  const out = {};
  for (const [id, P] of Object.entries(PERSONALITIES)) {
    const r = { charted: 0, fuel: 0, slings: 0, tours: 0, crashes: 0, minutes: 0 };
    for (const seed of seeds) {
      const u = new Universe(seed);
      const ap = new Autopilot(u.ship, u);
      u.ship.autopilot = ap; u.entities.push(ap);
      Object.assign(ap, { enabled: true, persona: P, pace: P.pace, lockTime: 2.5 * P.lock, sightseeing: 15 * P.dwell, orbitFirst: P.orbitFirst ?? true });
      Object.assign(u.fuel, { on: true, capacity: 175, level: 175, burn: 1.6, refuelRate: 15 });
      ap.onEvent = (e) => { if (e.kind === 'assist' || e.kind === 'scan') r.slings++; if (e.kind === 'tour') r.tours++; };
      u.onLanded = (p, { first, rescue }) => { if (first && !rescue) r.charted++; };
      u.onDestroyed = () => { r.crashes++; u.forceLand(u.planets.find((p) => !p.gas) ?? u.planets[0], true); u.fuel.level = 60; };
      u.onConsumed = () => { r.crashes++; u.ship.consumed = null; u.forceLand(u.planets.find((p) => !p.gas), true); };
      let last = u.fuel.level;
      const dt = 1 / 45;
      for (let t = 0; t < minutes * 60; t += dt) {
        u.advance(dt);
        if (u.fuel.level < last) r.fuel += last - u.fuel.level;
        last = u.fuel.level;
        if (u.fuel.level <= 0 && !u.ship.landing) { u.forceLand(u.planets.find((p) => !p.gas), true); u.fuel.level = 40; }
      }
      r.minutes += minutes;
    }
    out[id] = {
      worldsPerHour: Math.round((r.charted / r.minutes) * 60), fuelPerWorld: r.charted ? +(r.fuel / r.charted).toFixed(1) : null,
      slingsPerHour: Math.round((r.slings / r.minutes) * 60), tours: r.tours, crashes: r.crashes,
    };
  }
  return out;
}
