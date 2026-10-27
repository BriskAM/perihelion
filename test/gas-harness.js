// Test harness (run in the browser console or via the dev tools): sends the autopilot at every gas giant
// in a range of seeds and reports how each attempt ended. Not loaded by the game.
import { Universe } from '../js/universe.js';
import { Autopilot } from '../js/autopilot.js';
import { dist, fromAngle } from '../js/maths.js';

export function runGasHarness({ seeds = 40, from = 1000, simSeconds = 300, fuel = true, fast = false, after = 120 } = {}) {
  const results = [];
  for (let seed = from; seed < from + seeds; seed++) {
    const probe = new Universe(seed);
    probe.planets.forEach((g, gi) => {
      if (!g.gas) return;
      const u = new Universe(seed);
      const target = u.planets[gi];
      const ap = new Autopilot(u.ship, u);
      u.ship.autopilot = ap; u.entities.push(ap);
      ap.enabled = true;
      u.fuel.on = fuel; u.fuel.capacity = 175; u.fuel.level = 175; u.fuel.burn = 1.6;
      // start 30k out, at rest relative to the target
      const a = ((seed * 2654435761 + gi * 40503) % 6283) / 1000; // (deterministic start angle)
      u.ship.pos = u.ship.opos = { x: target.pos.x + Math.cos(a) * 30_000, y: target.pos.y + Math.sin(a) * 30_000 };
      u.ship.velocity = { ...target.velocity };
      // the giant is the only uncharted world, so the real target logic picks it (dip or orbit survey)
      for (const p of u.planets) if (p !== target) p.explored = true;
      if (fast) u.ship.velocity = { x: target.velocity.x - Math.cos(a) * 2200, y: target.velocity.y - Math.sin(a) * 2200 };
      let strategies = [], last = '', crashed = null, lastChange = 0, t = 0, mode = '?';
      const pick = ap.pickTarget.bind(ap);
      ap.pickTarget = (sim) => { const p = pick(sim); if (p === target) mode = ap.scanPass ? 'scan' : ap.tour ? 'orbit' : 'dip'; return p; };
      u.onDestroyed = (s, e) => { crashed = e.reason ?? 'crashed'; };
      u.onConsumed = () => { crashed = 'black hole'; };
      const dt = 1 / 45;
      for (; t < simSeconds && !target.explored && !crashed; t += dt) {
        u.advance(dt);
        if (ap.strategy !== last) { last = ap.strategy; lastChange = t; if (strategies.length < 60) strategies.push(`${Math.round(t)}:${last}`); }
      }
      // then it must get away again: leave the giant's sphere of influence (or land elsewhere)
      let left = false;
      const t1 = t;
      for (; target.explored && !crashed && t < t1 + after; t += dt) {
        u.advance(dt);
        if (ap.strategy !== last) { last = ap.strategy; if (strategies.length < 60) strategies.push(`${Math.round(t)}:${last}`); }
        if (dist(u.ship.pos, target.pos) > Math.min(target.hill, target.radius * 8) || u.ship.landing) { left = true; break; }
      }
      void fromAngle; void lastChange;
      results.push({
        seed, name: target.name, R: Math.round(target.radius), top: Math.round(target.atmo.top),
        g: Math.round((0.1 * target.mass) / (target.radius + target.atmo.top * 0.85) ** 2),
        moons: u.planets.filter((p) => p.parent === target).length, binary: !!target.binary,
        ok: target.explored && left, charted: target.explored, left, mode, crashed, t: Math.round(t), fuel: Math.round(u.fuel.level),
        d: Math.round(dist(u.ship.pos, target.pos) - target.radius), end: last,
        tail: strategies.slice(-8).join(' '),
      });
    });
  }
  return results;
}
