import { predict, soiAt, conic } from './predict.js';
import { GRAVITATION, SPACECRAFT_MASS, MAIN_ENGINE_ACCEL } from './universe.js';
import { clamp, fromAngle } from './maths.js';

// Planned burns. Preview a burn with the stick's dead zone, then lock it in (release after holding the
// preview, or press B): the ship flies that exact change of velocity for you, either right away or at
// the next periapsis / apoapsis of the orbit you are on (N cycles). The burn is stored as prograde and
// radial parts, so it keeps its meaning however the orbit turns before the node comes round.

const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));

export class Maneuver {
  constructor() { this.node = null; }

  /** Lock a burn: `dir` (world angle) and `dv` from the stick preview. */
  plan(u, dir, dv) {
    const ship = u.ship, ref = soiAt(u, ship.pos) ?? u.closestPlanet();
    const vx = ship.velocity.x - ref.velocity.x, vy = ship.velocity.y - ref.velocity.y, va = Math.atan2(vy, vx);
    const off = wrap(dir - va);
    this.node = { pro: Math.cos(off) * dv, rad: Math.sin(off) * dv, dv, at: 'now', done: 0, armed: true, burning: false };
    return this.node;
  }

  /** now -> periapsis -> apoapsis -> now (pe/ap only on a closed orbit). */
  cycle(u) {
    const n = this.node;
    if (!n || n.burning) return;
    const o = this.orbit(u);
    const order = o && o.e < 1 && !o.end ? ['now', 'pe', 'ap'] : ['now'];
    n.at = order[(order.indexOf(n.at) + 1) % order.length];
  }

  cancel() { this.node = null; }

  orbit(u) {
    const ship = u.ship, b = soiAt(u, ship.pos);
    if (!b) return null;
    const o = conic(b, ship.pos.x - b.pos.x, ship.pos.y - b.pos.y, ship.velocity.x - b.velocity.x, ship.velocity.y - b.velocity.y);
    return o && { ...o, body: b };
  }

  /** Where the node is and the ship's velocity there (relative to the world), or null. */
  nodeState(u) {
    const n = this.node, ship = u.ship;
    if (!n) return null;
    if (n.at === 'now' || n.burning) {
      const ref = soiAt(u, ship.pos) ?? u.closestPlanet();
      return { pos: ship.pos, rel: { x: ship.velocity.x - ref.velocity.x, y: ship.velocity.y - ref.velocity.y }, ref };
    }
    const o = this.orbit(u);
    if (!o || o.e >= 1) { n.at = 'now'; return this.nodeState(u); }
    const at = n.at === 'pe' ? o.peAt : o.apAt, r = Math.hypot(at.x, at.y);
    const mu = GRAVITATION * SPACECRAFT_MASS * o.body.mass, a = (o.pe + o.ap) / 2;
    const sp = Math.sqrt(Math.max(0, mu * (2 / r - 1 / a)));
    const ang = Math.atan2(at.y, at.x) + (o.dir > 0 ? Math.PI / 2 : -Math.PI / 2);
    return { pos: { x: o.body.pos.x + at.x, y: o.body.pos.y + at.y }, rel: fromAngle(ang, sp), ref: o.body };
  }

  burnVector(rel) {
    const n = this.node, a = Math.atan2(rel.y, rel.x);
    const px = Math.cos(a), py = Math.sin(a); // prograde
    return { x: px * n.pro - py * n.rad, y: py * n.pro + px * n.rad };
  }

  /** The path after the planned burn, for drawing. */
  ghost(u) {
    const s = this.nodeState(u);
    if (!s) return null;
    const b = this.burnVector(s.rel), left = 1 - this.node.done / this.node.dv;
    const v = { x: s.ref.velocity.x + s.rel.x + b.x * left, y: s.ref.velocity.y + s.rel.y + b.y * left };
    const g = predict(u, { pos: s.pos, velocity: v, landing: null, consumed: null }, { steps: 260 });
    if (g) g.node = s.pos;
    return g;
  }

  /** Fly the node. Returns true while it is steering the ship. */
  update(u, dt) {
    const n = this.node, ship = u.ship;
    if (!n || ship.landing) return false;
    if (!n.burning) {
      if (n.at === 'now') n.burning = true;
      else {
        const o = this.orbit(u);
        if (!o || o.e >= 1) { n.at = 'now'; return false; }
        const nu = wrap(o.dir * (Math.atan2(ship.pos.y - o.body.pos.y, ship.pos.x - o.body.pos.x) - Math.atan2(o.peAt.y, o.peAt.x)));
        const target = n.at === 'pe' ? 0 : Math.PI;
        const lead = Math.min(0.5, (n.dv / MAIN_ENGINE_ACCEL) * 0.5 * (Math.hypot(ship.velocity.x - o.body.velocity.x, ship.velocity.y - o.body.velocity.y) / Math.max(1, Math.hypot(o.peAt.x, o.peAt.y)))); // start half a burn early
        if (Math.abs(wrap(nu - target + lead)) < 0.04) n.burning = true;
        else {
          // coast to the node, already pointing the right way
          const s = this.nodeState(u), b = this.burnVector(s.rel);
          turnToward(ship, Math.atan2(b.y, b.x), dt);
          ship.thrust = { x: 0, y: 0 };
          return true;
        }
      }
    }
    const ref = soiAt(u, ship.pos) ?? u.closestPlanet();
    const b = this.burnVector({ x: ship.velocity.x - ref.velocity.x, y: ship.velocity.y - ref.velocity.y });
    const want = Math.atan2(b.y, b.x);
    const off = Math.abs(wrap(want - ship.angle));
    turnToward(ship, want, dt);
    const left = n.dv - n.done;
    const accel = Math.max(MAIN_ENGINE_ACCEL, 1.35 * (ship.gLocal ?? 0)); // (the engine beats local gravity)
    const thr = off < 0.12 ? clamp(left / (accel * Math.max(dt, 1e-3)), 0, 1) : 0;
    ship.thrust = fromAngle(ship.angle, thr);
    n.done += accel * dt * thr;
    if (n.done >= n.dv - 1) { this.node = null; ship.thrust = { x: 0, y: 0 }; return 'done'; }
    return true;
  }
}

function turnToward(ship, want, dt) {
  const step = 9 * dt;
  ship.angle = wrap(ship.angle + clamp(wrap(want - ship.angle), -step, step));
}
