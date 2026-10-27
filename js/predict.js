import { GRAVITATION, SPACECRAFT_MASS } from './universe.js';

// Where is the ship going? Inside a planet's Hill sphere the game already works in that planet's
// frame (see Universe.frameAcceleration), so the path is a clean two-body conic: an exact ellipse
// or hyperbola with periapsis / apoapsis, drawn straight from the orbital elements. Out in the open
// we integrate the ship forward through the moving field of every body (they ride rails, so their
// future positions are known exactly), until it enters some world's sphere of influence; from there
// the rest of the path is that world's conic, drawn around a "ghost" of where the world will be.

// read lazily: autopilot.js imports this module while universe.js is still loading
const gconst = () => GRAVITATION * SPACECRAFT_MASS;

/** Position of a rail body `t` seconds from now. */
export function bodyPosAt(b, t) {
  if (!b.speed || !b.orbitRadius) return b.pos;
  const cNow = b.orbitCenter;
  const cAt = b.parent ? bodyPosAt(b.parent, t) : cNow;
  const a = Math.atan2(b.pos.y - cNow.y, b.pos.x - cNow.x) + (b.speed / b.orbitRadius) * t;
  return { x: cAt.x + Math.cos(a) * b.orbitRadius, y: cAt.y + Math.sin(a) * b.orbitRadius };
}

/** Innermost Hill sphere containing `pos` (the body whose frame the ship is flying in). */
export function soiAt(u, pos) {
  let best = null, bestHill = Infinity;
  for (const p of u.planets) {
    if (!p.hill || p.hill >= bestHill) continue;
    if (Math.hypot(pos.x - p.pos.x, pos.y - p.pos.y) < p.hill) { best = p; bestHill = p.hill; }
  }
  return best;
}

/**
 * Orbital elements of a relative state (r, v) around body p, plus the drawn path.
 * Points are relative to the body's centre.
 */
export function conic(p, rx, ry, vx, vy, maxPts = 160) {
  const mu = gconst() * p.mass;
  const rm = Math.hypot(rx, ry), v2 = vx * vx + vy * vy;
  const h = rx * vy - ry * vx;
  const rv = rx * vx + ry * vy;
  const ex = ((v2 - mu / rm) * rx - rv * vx) / mu, ey = ((v2 - mu / rm) * ry - rv * vy) / mu;
  const e = Math.hypot(ex, ey);
  const slr = (h * h) / mu; // semi-latus rectum
  if (slr < 1e-3) return null; // falling straight in: no useful conic
  const dir = h >= 0 ? 1 : -1;
  const argp = e > 1e-6 ? Math.atan2(ey, ex) : Math.atan2(ry, rx);
  const pe = slr / (1 + e), ap = e < 1 ? slr / (1 - e) : Infinity;
  const a = e < 1 ? slr / (1 - e * e) : -slr / (e * e - 1);
  const period = e < 1 ? 2 * Math.PI * Math.sqrt(a ** 3 / mu) : Infinity;
  const nu0 = dir * (Math.atan2(ry, rx) - argp);
  const atmo = p.atmo ? p.atmo.top : 0;
  const hill = p.hill ?? Infinity;
  const pts = [];
  let end = null; // 'impact' | 'escape' | 'air' | null (closed orbit)
  const span = e < 1 ? 2 * Math.PI : Math.acos(-1 / e) * 2;
  const nuMax = e < 1 ? 2 * Math.PI : Math.acos(-1 / e) - 1e-3;
  const step = span / maxPts;
  let nu = nu0, prevR = rm, endAt = null;
  // start from the current true anomaly, normalised into the hyperbola's legal range
  if (e >= 1) nu = Math.atan2(Math.sin(nu), Math.cos(nu));
  for (let i = 0; i <= maxPts; i++) {
    if (e >= 1 && nu > nuMax) { end = 'escape'; break; }
    const r = slr / (1 + e * Math.cos(nu));
    const ang = argp + dir * nu;
    const x = Math.cos(ang) * r, y = Math.sin(ang) * r;
    if (r < p.radius && (p.collides || r < p.radius * 0.6)) { end = 'impact'; endAt = { x, y }; pts.push({ x, y }); break; }
    if (r > hill) { end = 'escape'; pts.push({ x, y }); break; }
    pts.push({ x, y });
    prevR = r;
    nu += step;
  }
  void prevR;
  if (!end && atmo && pe < p.radius + atmo) end = 'air';
  const peAng = argp, apAng = argp + Math.PI;
  return {
    body: p, e, pe, ap, period, pts, end, endAt, dir,
    peAt: { x: Math.cos(peAng) * pe, y: Math.sin(peAng) * pe },
    apAt: e < 1 ? { x: Math.cos(apAng) * ap, y: Math.sin(apAng) * ap } : null,
    // is periapsis still ahead of us on this pass? (for hyperbolas it may be behind)
    peAhead: e < 1 || ((((dir * (peAng - Math.atan2(ry, rx))) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)) > Math.PI,
  };
}

/**
 * Predict the ship's path. Returns
 * { soi, orbit } when inside a sphere of influence (orbit = conic around soi, relative to its centre), or
 * { pts (world), encounter: { body, t, ghost, orbit }, impact, closest } out in the open.
 */
export function predict(u, ship, { steps = 420, horizon = 420 } = {}) {
  if (ship.landing || ship.consumed) return null;
  const soi = soiAt(u, ship.pos);
  if (soi) {
    const orbit = conic(soi, ship.pos.x - soi.pos.x, ship.pos.y - soi.pos.y,
      ship.velocity.x - soi.velocity.x, ship.velocity.y - soi.velocity.y);
    if (orbit) return { soi, orbit };
  }
  const bodies = u._bodies, G = gconst();
  let x = ship.pos.x, y = ship.pos.y, vx = ship.velocity.x, vy = ship.velocity.y, t = 0;
  const pts = [{ x, y }];
  let encounter = null, impact = null, closest = null;
  const pos = new Array(bodies.length);
  for (let i = 0; i < steps && t < horizon; i++) {
    let ax = 0, ay = 0, dNear = Infinity;
    for (let k = 0; k < bodies.length; k++) {
      const b = bodies[k], bp = (pos[k] = bodyPosAt(b, t));
      const dx = bp.x - x, dy = bp.y - y, d2 = dx * dx + dy * dy, d = Math.sqrt(d2);
      if (d < b.radius) {
        if (b.isBlackHole || b.collides || (b.gas && d < b.radius * 0.6) || u.stars.includes(b)) { impact = { x, y, body: b, t }; break; }
      }
      const g = (G * b.mass) / Math.max(d2, 1);
      ax += (dx / d) * g; ay += (dy / d) * g;
      dNear = Math.min(dNear, d - b.radius);
    }
    if (impact) break;
    const sp = Math.hypot(vx, vy) + 1;
    const dt = Math.min(Math.max((Math.max(dNear, 50) / sp) * 0.06, 0.02), 2.5);
    vx += ax * dt; vy += ay * dt;
    x += vx * dt; y += vy * dt;
    t += dt;
    pts.push({ x, y });
    // entering a sphere of influence: hand over to that world's conic
    for (const p of u.planets) {
      if (!p.hill || p.isMoon) continue;
      const pp = bodyPosAt(p, t);
      const d = Math.hypot(x - pp.x, y - pp.y);
      if (!closest || d - p.radius < closest.d) closest = { body: p, d: d - p.radius, t, ghost: pp };
      if (d < p.hill * 0.95) {
        const p2 = bodyPosAt(p, t + 0.05);
        const pvx = (p2.x - pp.x) / 0.05, pvy = (p2.y - pp.y) / 0.05;
        const orbit = conic(p, x - pp.x, y - pp.y, vx - pvx, vy - pvy);
        encounter = { body: p, t, ghost: pp, orbit };
        break;
      }
    }
    if (encounter) break;
  }
  return { pts, encounter, impact, closest, t };
}
