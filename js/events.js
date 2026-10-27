import { PI2, makeRng, vec, add, sub, mul, mag, dist, fromAngle } from './maths.js';
import { GRAVITATION, SPACECRAFT_MASS, Spark } from './universe.js';

// Things that happen in a system while you watch: storms brew on gas giants, molten worlds erupt
// (the rock they throw is a real free body that falls back or escapes), and now and then an AI ship
// runs dry and calls for help. Each event reports through `onEvent` so the game can toast it, log it
// and take a postcard.

export class WorldEvents {
  constructor(u) {
    this.u = u;
    this.rng = makeRng((u.randomSeed ^ 0xe7e7) >>> 0);
    this.onEvent = null; // ({ kind, body?, ship?, ... }) => void
    this.nextDistress = u.now + this.rng.range(90, 240);
    for (const p of u.planets) {
      if (p.gas) p.storm = { on: false, next: u.now + this.rng.range(30, 200), until: 0 };
      if (p.lava || p.name === 'Io') p.vent = { next: u.now + this.rng.range(10, 60) }; // (Io: the real volcanic moon)
    }
  }

  emit(e) { if (this.onEvent) this.onEvent(e); }

  update(dt) {
    const u = this.u, now = u.now, rng = this.rng;
    for (const p of u.planets) {
      const s = p.storm;
      if (s) {
        if (!s.on && now > s.next) {
          s.on = true; s.until = now + rng.range(60, 140); s.a = rng() * PI2; s.size = rng.range(0.16, 0.3);
          this.emit({ kind: 'storm', body: p });
        } else if (s.on && now > s.until) { s.on = false; s.next = now + rng.range(120, 300); }
      }
      if (p.vent && now > p.vent.next) { p.vent.next = now + rng.range(70, 200); this.erupt(p); }
    }
    this.updateDistress(dt);
  }

  /** A molten world throws rock: some falls back (leaving a scar), some escapes into orbit around the star. */
  erupt(p) {
    const u = this.u, rng = this.rng;
    const a = rng() * PI2;
    const at = add(p.pos, fromAngle(a, p.radius));
    const vEsc = Math.sqrt((2 * GRAVITATION * SPACECRAFT_MASS * p.mass) / p.radius);
    for (let i = 0; i < rng.int(4, 9); i++) {
      const dir = a + rng.range(-0.5, 0.5), sp = vEsc * rng.range(0.55, 1.08);
      u.debris.spawnRock(add(at, fromAngle(dir, 8)), add(p.velocity, fromAngle(dir, sp)), rng.range(6, 18), rng.int(0, 6));
    }
    const g = new Spark({ ttl: 2.5, style: 'glow', color: '255,120,40', size: p.radius * 0.18 });
    g.pos = g.opos = at; g.velocity = p.velocity;
    u.sparks.push(g);
    this.emit({ kind: 'eruption', body: p, at });
  }

  /** Every few minutes an AI ship runs dry and drifts. Reach it slowly to tow it back to life. */
  updateDistress() {
    const u = this.u, now = u.now;
    for (const s of u.ships) {
      if (!s.distress) continue;
      const d = dist(s.pos, u.ship.pos), rel = mag(sub(s.velocity, u.ship.velocity));
      if (d < 170 && rel < 140) { this.endDistress(s); this.emit({ kind: 'rescued', ship: s }); }
      else if (now > s.distress.until) { this.endDistress(s); this.emit({ kind: 'lost', ship: s }); }
    }
    if (now < this.nextDistress) return;
    this.nextDistress = now + this.rng.range(240, 480);
    const ai = u.ships.filter((s) => s.isAI && !s.isWing && !s.distress && !s.landing && !s.consumed && dist(s.pos, u.ship.pos) > 8000);
    if (!ai.length) return;
    const s = ai[this.rng.int(0, ai.length)];
    s.distress = { since: now, until: now + 300 };
    s.autopilot.enabled = false;
    s.thrust = vec();
    const near = u.closestPlanet(s);
    this.emit({ kind: 'distress', ship: s, near });
  }

  endDistress(s) {
    s.distress = null;
    s.autopilot.enabled = true;
    s.autopilot.target = null;
  }
}

/** Hull damage numbers in one place. */
export const HULL = {
  rock: (speed) => Math.max(0, (speed - 160) / 45),
  impact: (fuelDamage) => fuelDamage * 2.5,
  heat: (heat, dt) => (heat > 0.6 ? (heat - 0.6) * 30 * dt : 0), // (normal aerobraking stays below 0.6)
};
void mul; void vec;
