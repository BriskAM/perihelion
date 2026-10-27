import { PI2, makeRng, vec, add, sub, mul, mag, fromAngle, angleOf, clamp } from './maths.js';
import { GRAVITATION, SPACECRAFT_MASS, UNIVERSE_RANGE, Spark } from './universe.js';

// Free bodies: comets on long eccentric orbits, and rocks knocked loose from the belts. Unlike the
// planets (which ride rails), these feel the pull of every star, planet and moon, so giants fling
// them around, capture them, or pull them in. When one hits a world it leaves a glowing crater.

// (read lazily: universe.js imports this module, so its constants are not ready at load time)
const gconst = () => GRAVITATION * SPACECRAFT_MASS;
const MAX_ITEMS = 260;
const SUB_DT = 1 / 30;

export class DebrisField {
  constructor(u) {
    this.u = u;
    this.items = [];
    this.rng = makeRng((u.randomSeed ^ 0xc0e7a11) >>> 0);
    this.nextComet = 0;
    this.onEvent = null; // ({ kind: 'impact' | 'comet', item, body }) => void
  }

  /** Comets: perihelion in the inner system, aphelion out near the edge. */
  makeComets(count, baseName) {
    for (let i = 0; i < count; i++) this.spawnComet(`${baseName}-${'ABCDEFGH'[i] ?? i}`, i === 0 ? this.rng() * PI2 : null);
  }

  spawnComet(name, nu = null) {
    const u = this.u, rng = this.rng;
    const M = u.totalMass, mu = gconst() * M;
    const q = rng.range(Math.max(u.minOrbit * 0.55, 9000), 42_000);
    const Q = rng.range(120_000, UNIVERSE_RANGE * 0.9);
    const a = (q + Q) / 2, e = (Q - q) / (Q + q), slr = a * (1 - e * e);
    const argp = rng() * PI2, dir = rng() < 0.75 ? 1 : -1;
    nu ??= Math.PI * rng.range(0.75, 1.05); // new arrivals come in from far out
    const r = slr / (1 + e * Math.cos(nu));
    const ang = argp + dir * nu;
    const h = Math.sqrt(mu * slr);
    const vr = (mu / h) * e * Math.sin(nu), vt = (mu / h) * (1 + e * Math.cos(nu));
    const rx = Math.cos(ang), ry = Math.sin(ang);
    const item = {
      kind: 'comet', name, size: rng.range(28, 55), rot: 0, spin: rng.range(-0.4, 0.4), shape: rng.int(0, 6),
      pos: vec(rx * r, ry * r), vel: vec(rx * vr - ry * vt * dir, ry * vr + rx * vt * dir),
      hue: rng.range(170, 210), tail: [], seen: false,
    };
    this.items.push(item);
    return item;
  }

  /** A belt rock knocked out of line. */
  spawnRock(pos, vel, size, shape) {
    if (this.items.length >= MAX_ITEMS) {
      const i = this.items.findIndex((it) => it.kind === 'rock');
      if (i >= 0) this.items.splice(i, 1); else return null;
    }
    const item = { kind: 'rock', size, shape, rot: this.rng() * PI2, spin: this.rng.range(-3, 3), pos: { ...pos }, vel: { ...vel }, life: 600 };
    this.items.push(item);
    return item;
  }

  update(dt) {
    if (!this.items.length && !this.nextComet) return;
    const u = this.u, bodies = u._bodies, G = gconst();
    const n = Math.max(1, Math.ceil(dt / SUB_DT)), h = dt / n;
    for (let s = 0; s < n; s++) {
      for (const it of this.items) {
        if (it.dead) continue;
        let ax = 0, ay = 0;
        for (const b of bodies) {
          const dx = b.pos.x - it.pos.x, dy = b.pos.y - it.pos.y, d2 = dx * dx + dy * dy, d = Math.sqrt(d2);
          const hitR = b.radius + (b.isBlackHole ? 0 : it.size * 0.4);
          if (d < hitR && (b.collides || b.isBlackHole || u.stars.includes(b) || d < b.radius * 0.75)) {
            this.hit(it, b);
            break;
          }
          const g = (G * b.mass) / Math.max(d2, 100);
          ax += (dx / d) * g; ay += (dy / d) * g;
        }
        if (it.dead) continue;
        it.vel.x += ax * h; it.vel.y += ay * h;
        it.pos.x += it.vel.x * h; it.pos.y += it.vel.y * h;
      }
    }
    for (const it of this.items) {
      if (it.dead) continue;
      it.rot += it.spin * dt;
      if (it.life !== undefined && (it.life -= dt) < 0) it.dead = true;
      if (Math.hypot(it.pos.x, it.pos.y) > UNIVERSE_RANGE * 1.02) { it.dead = true; it.lostToSpace = true; }
      if (it.kind === 'comet') {
        const t = it.tail;
        if (!t.length || Math.hypot(t[t.length - 1].x - it.pos.x, t[t.length - 1].y - it.pos.y) > 120) t.push({ x: it.pos.x, y: it.pos.y });
        if (t.length > 90) t.shift();
      }
    }
    const before = this.items.length;
    const lostComets = this.items.filter((it) => it.dead && it.kind === 'comet').length;
    this.items = this.items.filter((it) => !it.dead);
    if (before !== this.items.length && lostComets) this.nextComet = u.now + this.rng.range(60, 180);
    // the system keeps getting visitors: a new comet falls in a while after one is lost
    if (this.nextComet && u.now > this.nextComet) {
      this.nextComet = 0;
      const c = this.spawnComet(`${u.star.name.split(' ')[0]}-${String.fromCharCode(65 + this.rng.int(0, 26))}${this.rng.int(1, 9)}`);
      if (this.onEvent) this.onEvent({ kind: 'comet', item: c });
    }
  }

  hit(it, b) {
    const u = this.u;
    it.dead = true;
    const a = angleOf(sub(it.pos, b.pos));
    const at = add(b.pos, fromAngle(a, b.radius));
    const hot = it.kind === 'comet' ? '170,220,255' : '255,170,90';
    const rel = mag(sub(it.vel, b.velocity ?? vec()));
    const big = clamp(it.size / 20 + rel / 1500, 0.5, 4);
    if (!b.isBlackHole && !u.stars.includes(b)) {
      b.impacts ??= [];
      // stored in the planet's rotating frame, so the scar turns with the surface
      b.impacts.push({ a: a - (b.spin ?? 0) * u.now, size: clamp(it.size * (0.8 + rel / 2500), 12, b.radius * 0.35), t: u.now });
      if (b.impacts.length > 14) b.impacts.shift();
    }
    for (let k = 0; k < 18 * big && u.sparks.length < 600; k++) {
      const s = new Spark({ ttl: u.rng.range(0.6, 2.4), style: 'dot', color: k % 3 ? '#ffd2a0' : '#fff', size: u.rng.range(1, 2.5) });
      s.pos = s.opos = at;
      s.velocity = add(b.velocity ?? vec(), fromAngle(a + u.rng.range(-1.3, 1.3), u.rng.range(40, 260) * big));
      u.sparks.push(s);
    }
    const g = new Spark({ ttl: 1.1, style: 'glow', color: hot, size: it.size * 1.1 * big });
    g.pos = g.opos = at; g.velocity = b.velocity ?? vec();
    u.sparks.push(g);
    const ring = new Spark({ ttl: 2.2, style: 'ring', color: '#ffe0b0', size: Math.log(it.size * 6 * big + 1) + 1 });
    ring.pos = ring.opos = at; ring.velocity = b.velocity ?? vec();
    u.sparks.push(ring);
    if (this.onEvent) this.onEvent({ kind: 'impact', item: it, body: b, at });
  }

  /** The ship bumps into loose rocks and comet nuclei like into belt rocks. */
  collideShip(ship, dt) {
    if (ship.landing) return;
    for (const it of this.items) {
      const dx = ship.pos.x - it.pos.x, dy = ship.pos.y - it.pos.y;
      const need = it.size * 0.8 + ship.radius;
      if (Math.abs(dx) > need || Math.abs(dy) > need) continue;
      const d = Math.hypot(dx, dy) || 1;
      if (d >= need) continue;
      const nx = dx / d, ny = dy / d;
      ship.pos = vec(it.pos.x + nx * need, it.pos.y + ny * need);
      const rel = sub(ship.velocity, it.vel), into = rel.x * nx + rel.y * ny;
      if (into < 0 && dt > 0) {
        const v = add(it.vel, sub(rel, mul(vec(nx, ny), 1.4 * into)));
        ship.opos = sub(ship.pos, mul(v, dt));
        if (it.kind === 'rock') { it.vel.x += nx * into * 0.5; it.vel.y += ny * into * 0.5; }
      }
    }
  }
}
