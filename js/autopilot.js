import {
  vec, sub, mag, dot, dist, angleOf, fromAngle, add, mul, expSmooth, clamp, PI2,
} from './maths.js';
import {
  MAIN_ENGINE_ACCEL, CRAFT_SPEED_LIMIT, GRAVITATION, SPACECRAFT_MASS, landingSpeedLimit,
} from './universe.js';
import { densityAt, heatSafeSpeed, DRAG_COEFF } from './planets.js';

const BRAKING_TIME = 5;
const LAUNCH_THRUST_TIME = 5;
const STRATEGY_MIN_TIME = 0.5;
const TURN_RATE = 3; // rad/s in assisted mode
const LANDING_TURN_RATE = 8;
const OVERRIDE_HOLD = 1.2; // seconds after you let go of the stick before it re-locks

const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const unit = (v) => mul(v, 1 / (mag(v) || 1));

/**
 * Autopilot. In "classic" mode (assist = false) it is the original behaviour: it snaps its
 * heading instantly. In assisted mode it turns at a limited rate, takes time to lock onto a
 * target, and lets you take over with the stick; it re-locks shortly after you let go.
 */
export class Autopilot {
  constructor(ship, universe, { ai = false, rng = null } = {}) {
    this.ship = ship;
    this.universe = universe;
    this.ai = ai;
    this.rng = rng;
    this.enabled = false;
    this.assist = true;
    this.pace = 1; // 0.6 calm .. 2.2 turbo: turning, lock-on, sightseeing and the orbit phases all scale with it
    this.orbitFirst = true; // land via a captured orbit rather than a straight braking burn
    this.manual = false; // set by the input layer while the stick is held
    this.target = null;
    this.lastTarget = null;
    this.visited = new Set(); // AI ships remember where they have been
    this.skip = new Map(); // targets we gave up on -> time we may try them again
    this.bestDist = Infinity;
    this.progressAt = 0;
    this.escapeUntil = 0;
    this.escapeDir = vec();
    this.uncharted = false;
    this.lock = 0; // 0..1
    this.lockTime = ai ? rng.range(1.2, 3) : 2.5;
    this.sightseeing = 15;
    this.hold = 0;
    this.desiredAngle = null;
    this.landingAltitude = 0;
    this.nextStrategyTime = 0;
    this.brakingDistance = 0;
    this.leadingPos = vec();
    this.strategy = 'NONE';
    this.debug = '';
  }

  get turn() { return TURN_RATE * this.pace; }
  get landTurn() { return LANDING_TURN_RATE * this.pace; }

  get telemetry() {
    if (!this.enabled) return '';
    const lock = this.strategy === 'ACQUIRING' ? ` ${Math.round(this.lock * 100)}%` : '';
    return [
      '---- AUTOPILOT ENGAGED ----',
      'TGT: ' + (this.target ? this.target.name.toUpperCase() + (this.uncharted ? ' (UNCHARTED)' : '') : 'SELECTING...'),
      'EXE: ' + this.strategy + lock + (this.debug ? ` (${this.debug})` : ''),
    ].join('\n');
  }

  setAngle(angle, rate) {
    this.desiredAngle = angle;
    this.turnRate = rate;
    if (!this.assist) this.ship.angle = angle;
  }

  get fuelState() {
    const f = this.universe.fuel;
    return !this.ai && f.on ? f : null;
  }

  nearest(list) {
    const ship = this.ship;
    if (!list.length) list = this.universe.planets.filter((p) => !p.gas).concat(this.universe.planets);
    return list.slice().sort((a, b) => mag(sub(a.pos, ship.pos)) - mag(sub(b.pos, ship.pos)))[0];
  }

  /** Rough fuel for a trip of `d` units: burn time to get up to speed and to stop, plus cruising. */
  tripCost(d, toPos = null) {
    const burn = this.universe.fuel.burn;
    let cost = burn * (14 + d / 3200);
    if (toPos) { // crossing a rock belt means slow, twisty flying and the odd knock
      const from = this.ship.pos, hit = new Set();
      for (let k = 0; k <= 16; k++) {
        const r = mag(add(from, mul(sub(toPos, from), k / 16)));
        for (const b of this.universe.belts) if (Math.abs(r - b.radius) < b.width / 2 + 300) hit.add(b);
      }
      for (const b of hit) cost += burn * (b.width / 350 + 8);
    }
    return cost;
  }

  charted(p) { return this.ai ? this.visited.has(p) : p.explored; }

  /**
   * Chart a course to somewhere new. Every uncharted world (moons included) is a candidate;
   * nearer ones are likelier, moons a bit less so, and with survival on, trips the tank cannot
   * cover are very unlikely. If everything is charted it wanders between planets instead.
   */
  pickTarget() {
    const u = this.universe, ship = this.ship;
    const f = this.fuelState;
    const reach = (p) => !f || this.tripCost(mag(sub(p.pos, ship.pos)), p.pos) * 1.5 + 8 <= f.level;
    const now = u.now;
    const allowed = (p) => (this.skip.get(p) ?? 0) <= now;
    // moons of heavy planets sit in a well the engine cannot climb out of: leave those to the pilot
    const reachableMoon = (p) => !p.isMoon || p.parent.radius <= 1100;
    // a world sitting inside a giant's thick air (a binary partner, say) cannot be approached without burning up
    const clearOfAir = (p) => !u.planets.some((q) => q !== p && q !== p.parent && q.atmo && q.gas && dist(q.pos, p.pos) < (q.radius + q.atmo.top) * 1.8 + 600);
    // gas giants are surveyed by hovering in their top air, which only works where gravity is gentle enough
    const surveyable = (p) => {
      if (!p.gas) return true;
      const d = p.radius + p.atmo.top * 0.85;
      return (GRAVITATION * SPACECRAFT_MASS * p.mass) / (d * d) < 800;
    };
    let pool = u.planets.filter((p) => !this.charted(p) && p !== this.lastTarget && allowed(p) && reachableMoon(p) && surveyable(p) && clearOfAir(p));
    if (f) pool = pool.filter(reach); // never plan a trip the tank cannot cover
    if (f && !pool.length && u.planets.some((p) => !this.charted(p))) {
      // uncharted worlds exist but are out of range: refuel at the nearest world first
      this.refuelling = true;
      this.uncharted = false;
      return this.nearest(u.planets.filter((p) => !p.isMoon && !p.gas));
    }
    this.uncharted = pool.length > 0;
    // everything is charted: wander between solid planets (gas giants are costly to leave again)
    if (!pool.length) pool = u.planets.filter((p) => !p.isMoon && !p.gas && p !== this.lastTarget);
    if (!pool.length) pool = u.planets.filter((p) => !p.gas && reachableMoon(p));
    if (!pool.length) pool = u.planets;
    const weights = pool.map((p) => {
      const d = mag(sub(p.pos, ship.pos));
      let w = (p.isMoon ? 0.6 : 1) / (1 + (d / 25_000) ** 2);
      if (f && f.burn * (11 + d / 5000) + 15 > f.level) w *= 0.05;
      if (this.pathBlockedByStar(p)) w *= 0.02; // a route straight through a star is a bad idea; prefer the near side
      return w;
    });
    let x = (this.rng ?? Math.random)() * weights.reduce((a, b) => a + b, 0);
    for (let i = 0; i < pool.length; i++) { x -= weights[i]; if (x < 0) return pool[i]; }
    return pool[pool.length - 1];
  }

  /**
   * A sideways push (zero when clear) away from stars, black holes and other planets sitting on
   * the line to the target. It nudges the desired velocity sideways rather than re-aiming at a
   * waypoint, so avoiding something never means throwing away the speed we have built up.
   */
  avoidance(ship, vector, target = null) {
    const len2 = vector.x * vector.x + vector.y * vector.y;
    if (len2 < 1) return vec();
    let best = null, bestT = Infinity, escape = vec();
    const wells = this.universe.wells;
    for (const w of [...wells, ...this.universe.planets]) {
      if (w === target) continue;
      const isWell = wells.includes(w);
      const R = w.isBlackHole ? w.radius * 10 : isWell ? w.radius * 3.2 : Math.max(w.radius * 2.2 + 350, this.moonZone(w), w.atmo ? (w.radius + w.atmo.top) * 1.6 + 200 : 0);
      const toW = sub(w.pos, ship.pos);
      if (isWell && mag(toW) < (w.isBlackHole ? R : w.radius * 1.9)) { // already inside a star's corona or a black hole's danger zone: get out
        escape = add(escape, mul(toW, -1 / (mag(toW) || 1)));
        continue;
      }
      if (isWell) continue; // stars and black holes are routed around instead (see routeAroundWells)
      const t = dot(toW, vector) / len2;
      if (t <= 0 || t >= 1 || t >= bestT) continue;
      const off = sub(add(ship.pos, mul(vector, t)), w.pos);
      if (mag(off) >= R || mag(toW) < R * 0.8) continue;
      best = { R, off }; bestT = t;
    }
    let push = escape;
    if (best) {
      const m = mag(best.off);
      const dir = m > 1 ? mul(best.off, 1 / m) : { x: -vector.y / Math.sqrt(len2), y: vector.x / Math.sqrt(len2) };
      push = add(push, mul(dir, clamp(1.4 - m / best.R, 0.2, 1)));
    }
    this.avoidActive = mag(push) > 0.05;
    return mag(push) > 1 ? mul(push, 1 / mag(push)) : push;
  }

  /**
   * Push away from belt rocks right around the ship. A rock dead ahead would just cancel our
   * forward velocity and pin us, so the push is mostly sideways: dodge to the side the rock is on.
   */
  rockPush(ship, dir) {
    let px = 0, py = 0;
    this.universe.forRocksNear(ship.pos, 420, (x, y, size) => {
      const rx = x - ship.pos.x, ry = y - ship.pos.y;
      const ahead = rx * dir.x + ry * dir.y; // how far along our course the rock is
      if (ahead < 0 || ahead > 400) return;
      const side = rx * dir.y - ry * dir.x; // signed distance off our course line
      const clear = size + ship.radius + 70;
      if (Math.abs(side) >= clear) return; // not actually in our way
      const f = (1 - ahead / 400) * (1 - Math.abs(side) / clear + 0.2);
      const away = side >= 0 ? -1 : 1; // dodge to the side that is already clearer
      px += -dir.y * away * f * -1; py += dir.x * away * f * -1;
    });
    const m = Math.hypot(px, py);
    return m > 1 ? vec(px / m, py / m) : vec(px, py);
  }

  /**
   * Collision guard for coasting phases: if we are closing on a body (other than the target) faster
   * than we could stop in the distance left, return the relative velocity to cancel.
   */
  emergencyBrake(ship, target) {
    const wells = this.universe.wells;
    let worst = null, worstScore = 0;
    for (const b of [...this.universe.planets, ...wells]) {
      if (b === target) continue;
      const toB = sub(b.pos, ship.pos), d = mag(toB);
      const rel = sub(ship.velocity, b.velocity);
      const closing = dot(rel, toB) / (d || 1);
      const isWell = wells.includes(b);
      if (closing <= 150 || (!isWell && closing < 0.7 * landingSpeedLimit(b))) continue; // slow drift and gentle touches are harmless
      const r = b.radius * (b.isBlackHole ? 8 : isWell ? 1.15 : 1);
      const gap = d - r - ship.radius;
      const stop = (closing * closing) / (2 * 700) + closing * 0.3 + 150;
      if (gap < stop && stop - gap > worstScore) { worst = rel; worstScore = stop - gap; }
    }
    return worst;
  }

  /**
   * If the straight line to the target crosses a star's or black hole's danger zone, return a vector
   * to a waypoint on the zone's edge instead (go around, not through). Null when the way is clear.
   */
  routeAroundWells(ship, vector, target) {
    const len2 = vector.x * vector.x + vector.y * vector.y;
    if (len2 < 1) return null;
    let best = null, bestT = Infinity;
    for (const w of this.universe.wells) {
      const R = w.isBlackHole ? w.radius * 10 : w.radius * 3.2;
      const toW = sub(w.pos, ship.pos);
      if (mag(toW) < R * 0.9) continue; // already inside: the escape logic handles it
      if (target && mag(sub(target.pos, w.pos)) < R * 1.05) continue; // the target itself lives in that zone
      const t = dot(toW, vector) / len2;
      if (t <= 0 || t >= 1 || t >= bestT) continue;
      const off = sub(add(ship.pos, mul(vector, t)), w.pos), m = mag(off);
      if (m >= R) continue;
      const dir = m > 1 ? mul(off, 1 / m) : { x: -vector.y / Math.sqrt(len2), y: vector.x / Math.sqrt(len2) };
      best = sub(add(w.pos, mul(dir, R * 1.2)), ship.pos); bestT = t;
    }
    return best;
  }

  /** Does the straight line from the ship to `p` pass through a star's or black hole's danger zone? */
  pathBlockedByStar(p) {
    const from = this.ship.pos, v = sub(p.pos, from), len2 = v.x * v.x + v.y * v.y;
    if (len2 < 1) return false;
    for (const w of this.universe.wells) {
      const R = w.isBlackHole ? w.radius * 10 : w.radius * 3.2;
      const t = dot(sub(w.pos, from), v) / len2;
      if (t <= 0 || t >= 1) continue;
      if (mag(sub(add(from, mul(v, t)), w.pos)) < R) return true;
    }
    return false;
  }

  /** Radius of the swarm of moons around a planet (0 if it has none). */
  moonZone(p) {
    if (p.moonZoneR === undefined) {
      const orbits = this.universe.planets.filter((m) => m.parent === p && !p.isAnchor).map((m) => m.orbitRadius);
      p.moonZoneR = orbits.length ? Math.max(...orbits) * 1.15 + 100 : 0;
    }
    return p.moonZoneR;
  }

  /** Belts are rock walls at speed: slow down before the path enters one, and stay slow inside. */
  beltSpeedCap(ship, vector) {
    const belts = this.universe.belts;
    if (!belts.length) return Infinity;
    const L = mag(vector), steps = 32;
    for (let k = 0; k <= steps; k++) {
      const r = mag(add(ship.pos, mul(vector, k / steps)));
      for (const b of belts) {
        if (Math.abs(r - b.radius) < b.width / 2 + 350) return Math.sqrt(2 * 250 * ((L * k) / steps)) + 450;
      }
    }
    return Infinity;
  }

  // Done surveying a gas giant: log it as visited and burn straight out of the atmosphere.
  arriveAtGas(ship, target) {
    this.dwell = 0;
    this.visited.add(target);
    this.lastTarget = target;
    this.target = null;
    this.refuelling = false;
    this.lock = 0;
    this.strategy = 'LAUNCHING';
    this.setAngle(angleOf(sub(ship.pos, target.pos)), 6);
    ship.thrust = fromAngle(ship.angle, 1);
    this.nextStrategyTime = this.universe.now + 15;
    if (!target.explored && !this.ai) this.universe.survey(target);
  }

  /**
   * Assisted guidance: steer the *relative velocity* (ship vs target) toward a braking curve
   * (the fastest approach speed we can still stop from). This cancels sideways drift, so the
   * ship neither orbits its target nor wastes fuel; it coasts whenever it is already on course.
   */
  guide(ship, target, targetVector, altitude, relativeV) {
    if (this.universe.now < this.escapeUntil) { // wriggle out of a rock field we are pinned in
      this.strategy = 'ESCAPING';
      const dv = sub(mul(this.escapeDir, 450), relativeV);
      this.setAngle(angleOf(dv), this.turn);
      const off = Math.abs(wrap(angleOf(dv) - ship.angle));
      ship.thrust = fromAngle(ship.angle, off < 0.5 ? clamp(mag(dv) / 300, 0.2, 1) : 0);
      return;
    }
    // Heavy planets out-pull the engine near the surface, so the braking curve has to assume
    // less stopping power there, and touchdown speed has to stay under the planet's limit.
    const safe = landingSpeedLimit(target);
    const surfaceG = (GRAVITATION * SPACECRAFT_MASS * target.mass) / (target.radius * target.radius);
    const brake = Math.max(250, MAIN_ENGINE_ACCEL - 0.6 * surfaceG);
    // Where gravity out-pulls 80% of the engine you can no longer brake, so slow down *before*
    // that point and let a full retro burn soften the rest of the fall.
    const hover = target.gas ? 0 : Math.max(0, Math.sqrt((GRAVITATION * SPACECRAFT_MASS * target.mass) / (0.8 * MAIN_ENGINE_ACCEL)) - target.radius);
    const plan = this.orbitPlan(target);
    if (plan && this.guideOrbit(ship, target, targetVector, altitude, relativeV, plan, { safe, brake, hover })) return;
    if (target.gas && altitude < this.landingAltitude) {
      // Gas giant: there is nothing to land on. Hover in the top of the air for a few seconds (that
      // counts as a survey), then climb back out.
      this.strategy = 'SURVEYING';
      const away = angleOf(sub(ship.pos, target.pos)), d = mag(targetVector) + 0;
      const g = (GRAVITATION * SPACECRAFT_MASS * target.mass) / (d * d);
      const closing = dot(relativeV, mul(targetVector, 1 / d));
      this.setAngle(away, this.landTurn);
      const aligned = Math.abs(wrap(away - ship.angle)) < 0.5;
      ship.thrust = aligned ? fromAngle(ship.angle, clamp(g / MAIN_ENGINE_ACCEL + closing / 300, 0, 1)) : vec();
      this.dwell = (this.dwell ?? 0) + this.universe.dt;
      if (this.dwell > 2.5) this.arriveAtGas(ship, target);
      return;
    }
    if (altitude < Math.max(this.landingAltitude, hover)) {
      // Final descent: cancel the relative velocity (sideways drift included) until it is well under
      // the limit, then face away from the ground and let gravity finish the job.
      this.strategy = 'LANDING';
      const speed = mag(relativeV);
      const braking = speed > 0.35 * safe;
      const heading = braking ? angleOf(mul(relativeV, -1)) : angleOf(sub(ship.pos, target.pos));
      this.setAngle(heading, this.landTurn);
      const aligned = Math.abs(wrap(heading - ship.angle)) < 0.5;
      ship.thrust = braking && aligned ? fromAngle(ship.angle, clamp((speed - 0.2 * safe) / 150, 0.1, 1)) : vec();
      return;
    }
    const stopAlt = Math.max(this.landingAltitude, hover);
    let approach = Math.sqrt(brake * Math.max(0, altitude - stopAlt)) + 0.2 * safe;
    if (target.atmo && !target.gas) {
      // Aerobraking: thick air does part of the braking for free, so the autopilot is allowed to arrive
      // faster than a pure engine burn would permit, as long as the heating stays inside the limit.
      const rhoMid = densityAt(target, Math.min(altitude, target.atmo.top) * 0.5);
      const aero = DRAG_COEFF * rhoMid * approach * approach * 0.6;
      approach = Math.sqrt((brake + aero) * Math.max(0, altitude - stopAlt)) + 0.2 * safe;
      approach = Math.min(approach, 0.9 * heatSafeSpeed(densityAt(target, altitude - approach * 1.0)));
    }
    this.cruise(ship, target, targetVector, targetVector, approach, relativeV);
  }

  /**
   * One step of cruising toward `aim` (a vector from the ship) at up to `approach` speed relative to the
   * target: caps for rock belts and moon swarms, a detour around stars, sideways nudges around planets
   * and rocks, then a thrust toward the wanted relative velocity. `targetVector` is the vector to the
   * target itself (for the swarm and belt caps).
   */
  cruise(ship, target, aim, targetVector, approach, relativeV) {
    const route = this.routeAroundWells(ship, aim, target);
    const dir = mul(route ?? aim, 1 / mag(route ?? aim));
    // moons sweep through at hundreds of units a second: be slow while crossing a planet's moon swarm
    const zone = this.moonZone(target);
    if (zone) approach = Math.min(approach, Math.sqrt(2 * 600 * Math.max(0, mag(targetVector) - zone)) + 300);
    approach = Math.min(Math.min(0.9, 0.72 * (0.85 + 0.15 * this.pace)) * CRAFT_SPEED_LIMIT, this.beltSpeedCap(ship, aim), approach);
    const push = this.avoidance(ship, aim, target);
    if (this.avoidActive || route) approach = Math.min(approach, route ? 2200 : 1800); // stay agile enough to steer around the obstacle
    const desired = add(mul(dir, approach), mul(push, 0.9 * approach));
    const dv = sub(add(desired, mul(this.rockPush(ship, dir), 350)), relativeV);
    const dvMag = mag(dv);
    const along = dot(relativeV, dir);
    this.strategy = dvMag < 60 ? 'CRUISING' : along < approach * 0.9 && dot(dv, dir) > 0 ? 'CHASING' : 'APPROACHING';
    if (dvMag < 60) { ship.thrust = vec(); return; } // already on the curve: coast
    this.setAngle(angleOf(dv), this.turn);
    const off = Math.abs(wrap(angleOf(dv) - ship.angle));
    ship.thrust = fromAngle(ship.angle, off < 0.5 ? clamp(dvMag / 300, 0.15, 1) : 0);
  }

  /**
   * Sidestep for fast-moving moons of the target: predict the closest approach (both on straight
   * lines for the next few seconds) and, if it would be a hit, return a velocity nudge away from it.
   */
  moonDodge(ship, target) {
    let nx = 0, ny = 0;
    for (const m of this.universe.planets) {
      if (m.parent !== target) continue;
      const p = sub(m.pos, ship.pos), v = sub(m.velocity, ship.velocity), v2 = v.x * v.x + v.y * v.y;
      if (v2 < 1) continue;
      const tca = clamp(-(p.x * v.x + p.y * v.y) / v2, 0, 6);
      const miss = sub(add(p, mul(v, tca)), vec());
      const dist = mag(miss), reach = m.radius + 90 + 0.4 * Math.sqrt(v2) * 0.1;
      if (dist >= reach) continue;
      const away = dist > 1 ? mul(miss, -1 / dist) : unit(vec(-v.y, v.x));
      const w = (1 - dist / reach) * (1 - tca / 8);
      nx += away.x * w; ny += away.y * w;
    }
    return vec(nx * 700, ny * 700);
  }

  /** Burn toward the wanted velocity `vDes` (relative to the target), but only once pointed that way. */
  burnToward(ship, vDes, relativeV, gain = 250, turn = this.turn) {
    const dv = sub(vDes, relativeV), m = mag(dv);
    if (m < 25) { ship.thrust = vec(); return m; }
    this.setAngle(angleOf(dv), turn);
    ship.thrust = fromAngle(ship.angle, Math.abs(wrap(angleOf(dv) - ship.angle)) < 0.5 ? clamp(m / gain, 0.1, 1) : 0);
    return m;
  }

  /**
   * Orbit-first arrival. Instead of killing all speed in a straight suicide burn, aim to pass the planet
   * at a chosen low altitude, circularise there with one burn at the lowest point (CAPTURE), hold
   * ORBITING briefly, then spiral down (DESCENT): the sideways speed is shaved off gradually, with
   * thick air doing the work for free where there is some. Below the hover height (or the landing
   * height) the old final-landing logic takes over. Returns null when this target is not a good fit
   * (moons, gas giants, worlds whose gravity zone is too small for a stable orbit).
   */
  orbitPlan(target) {
    if (!this.assist || !this.orbitFirst || target.gas || target.isMoon || !target.hill) return null;
    const top = target.atmo ? target.atmo.top : 0;
    const rOrb = target.radius + Math.max(top + 60, 0.45 * target.radius, 120);
    if (rOrb > 0.3 * target.hill) return null;
    // big moons that cross the capture path make orbit-first risky (a coplanar orbit meets them head-on)
    let risk = 0;
    for (const m of this.universe.planets) if (m.parent === target) risk += (m.radius + 30) / (Math.PI * m.orbitRadius);
    if (risk > 0.015) return null;
    const rCap = Math.min(0.7 * target.hill, Math.max(4 * rOrb, 6 * target.radius));
    if (rCap < rOrb * 1.8) return null;
    return { rOrb, rCap, mu: GRAVITATION * SPACECRAFT_MASS * target.mass };
  }

  /** Returns true when it handled this frame; false to let the direct-landing code run. */
  guideOrbit(ship, target, targetVector, altitude, relativeV, plan, { safe, brake, hover }) {
    const now = this.universe.now;
    const q = this.pace ** 1.3; // the orbit phases speed up a little more than everything else
    const r = mag(targetVector), rhat = mul(targetVector, -1 / (r || 1)), that = vec(-rhat.y, rhat.x);
    const vr = dot(relativeV, rhat), vt = dot(relativeV, that), vc = Math.sqrt(plan.mu / r);
    const sense = vt >= 0 ? 1 : -1; // keep whichever way round we are already going
    this.orbitPhase ??= 'far';
    this.progressAt = now; // slow, deliberate flying is not "stuck"
    if (this.orbitPhase !== 'far' && r > plan.rCap * 1.6) this.orbitPhase = 'far'; // flung back out: start again
    if (this.orbitPhase === 'far' && r < plan.rCap) { this.orbitPhase = 'capture'; this.orbitSince = now; }

    if (this.orbitPhase === 'far') {
      // aim to one side of the planet, so gravity bends the path into a low pass instead of a dive
      const vArr = (1.05 * Math.sqrt((2 * plan.mu) / plan.rCap) + 60) * (1 + 0.35 * (this.pace - 1));
      const eps = (vArr * vArr) / 2 - plan.mu / plan.rCap;
      const vPeri = Math.sqrt(2 * (eps + plan.mu / plan.rOrb));
      const b = plan.rCap * clamp((plan.rOrb * vPeri) / (plan.rCap * vArr), 0, 0.85);
      const u = mul(targetVector, 1 / r), aim = add(targetVector, mul(vec(-u.y, u.x), b));
      const approach = Math.sqrt(2 * Math.min(950, 700 * this.pace) * Math.max(0, r - plan.rCap)) + vArr;
      this.cruise(ship, target, aim, targetVector, approach, relativeV);
      return true;
    }

    const stopAlt = Math.max(this.landingAltitude, hover);
    const alt = r - target.radius;
    if (this.orbitPhase === 'capture' || this.orbitPhase === 'orbit') {
      const circular = Math.abs(r - plan.rOrb) < 0.18 * plan.rOrb && Math.abs(vr) < 0.15 * vc && Math.abs(vt - sense * vc) < 0.18 * vc;
      if (this.orbitPhase === 'capture') {
        if (circular) { this.orbitPhase = 'orbit'; this.orbitSince = now; }
        else if (now - this.orbitSince > 90) { this.orbitPhase = 'descent'; }
      } else if (!circular) this.orbitPhase = 'capture';
      else if (now - this.orbitSince > 1.5 / q) this.orbitPhase = 'descent';
    }

    if (this.orbitPhase === 'capture') {
      this.strategy = 'CAPTURE';
      this.debug = `r ${(r / plan.rOrb).toFixed(2)} of orbit`;
      const vDes = add(add(mul(that, sense * vc), mul(rhat, clamp((plan.rOrb - r) * 0.8 * q, -450 * q, 450 * q))), this.moonDodge(ship, target));
      this.burnToward(ship, vDes, relativeV, 250 / q);
      return true;
    }
    if (this.orbitPhase === 'orbit') {
      this.strategy = 'ORBITING';
      this.debug = `v ${Math.round(vc)}`;
      ship.thrust = vec();
      return true;
    }

    // descent
    if (alt <= stopAlt) return false; // close enough: the final-landing code takes it from here
    this.strategy = 'DESCENT';
    this.debug = `alt ${Math.round(alt)}`;
    const s = clamp((alt - stopAlt) / Math.max(1, plan.rOrb - target.radius - stopAlt), 0, 1);
    const vDes = add(add(mul(that, sense * vc * 0.9 * s), mul(rhat, -clamp(0.4 * q * Math.sqrt(2 * brake * (alt - stopAlt)), 30 * q, 260 * q))), this.moonDodge(ship, target));
    const rho = densityAt(target, alt);
    if (rho > 0.02 && mag(relativeV) >= mag(vDes) * 0.9 && ship.heat < 0.5) { // let the air do the braking
      ship.thrust = vec();
      this.strategy = 'AEROBRAKE';
      return true;
    }
    this.burnToward(ship, vDes, relativeV, 200 / q, this.landTurn);
    return true;
  }

  update(sim, dt) {
    if (!this.enabled) return;
    const ship = this.ship;
    if (ship.consumed) { this.target = null; return; }

    if (this.manual) { // you have the stick: hands off
      this.orbitPhase = null;
      this.strategy = 'MANUAL';
      this.debug = 'override';
      this.lock = 0;
      this.hold = sim.now + OVERRIDE_HOLD;
      this.desiredAngle = null;
      return;
    }
    if (this.assist && sim.now < this.hold) {
      this.strategy = 'RELEASED';
      this.debug = '';
      return;
    }
    // reentry emergency: heating well above the comfort level means slow down and climb, whatever the plan said
    if (this.assist && ship.heatRate > 0.55 && ship.atmoPlanet && !ship.landing) {
      const p = ship.atmoPlanet, away = unit(sub(ship.pos, p.pos));
      this.strategy = 'HEAT!';
      this.burnToward(ship, mul(away, 400), sub(ship.velocity, p.velocity), 200, 6);
      return;
    }
    // smooth turning toward the heading the current strategy asked for
    if (this.assist && this.desiredAngle !== null && !ship.landing) {
      const step = (this.turnRate ?? this.turn) * dt;
      ship.angle = wrap(ship.angle + clamp(wrap(this.desiredAngle - ship.angle), -step, step));
    }

    const current = this.strategy;
    const gated = sim.now < this.nextStrategyTime;

    if (ship.landing) {
      // just touched down mid-burn: cut the engine, or we would lift straight off again
      if (this.target) ship.thrust = vec();
      if (gated) return;
      this.desiredAngle = null;
      if (this.target) {
        // just arrived: see the sights
        this.strategy = 'LANDED';
        this.debug = '';
        this.orbitPhase = null;
        this.lastTarget = this.target;
        this.visited.add(this.target);
        this.target = null;
        this.refuelling = false;
        this.lock = 0;
        this.landingAltitude = 0;
        this.nextStrategyTime = sim.now + (this.ai ? this.rng.range(8, 25) : this.sightseeing / this.pace);
      } else if (this.fuelState && this.fuelState.level < 0.9 * this.fuelState.capacity) {
        this.strategy = 'REFUELLING'; // wait for a full tank before lifting off
        this.debug = `${Math.round((this.fuelState.level / this.fuelState.capacity) * 100)}%`;
        this.nextStrategyTime = sim.now + 0.5;
      } else {
        ship.thrust = fromAngle(ship.angle, 1); // full power until we blast off
        this.strategy = 'LAUNCHING';
        this.debug = '';
        this.nextStrategyTime = sim.now + (this.assist ? 15 : LAUNCH_THRUST_TIME); // assisted: burn until clear
      }
      return;
    }

    if (this.assist) { // inside a star's corona or a black hole's danger zone: leave first, think later
      for (const w of this.universe.wells) {
        const away = sub(ship.pos, w.pos), d = mag(away);
        // start turning away early enough to actually stop: braking distance grows with the square of the closing speed
        const closing = Math.max(0, -dot(sub(ship.velocity, w.velocity), away) / (d || 1));
        const danger = (w.isBlackHole ? w.radius * 8 : w.radius * 1.5) + (closing * closing) / (2 * 650) + 300;
        if (d >= danger) continue;
        this.strategy = 'ESCAPING';
        const dv = sub(mul(away, 900 / (d || 1)), sub(ship.velocity, w.velocity));
        this.setAngle(angleOf(dv), 6);
        ship.thrust = Math.abs(wrap(angleOf(dv) - ship.angle)) < 0.5 ? fromAngle(ship.angle, 1) : vec();
        return;
      }
    }
    if (this.assist && (!this.target || this.lock < 1)) { // only while coasting blind, not under guidance
      const rel = this.emergencyBrake(ship, this.target);
      if (rel) {
        this.strategy = 'BRAKING';
        const heading = angleOf(mul(rel, -1));
        this.setAngle(heading, 6);
        ship.thrust = Math.abs(wrap(heading - ship.angle)) < 0.5 ? fromAngle(ship.angle, 1) : vec();
        return;
      }
    }
    if (!this.target) {
      // assisted: cut the launch burn as soon as we are clear of the world we left, instead of
      // blasting blindly for five seconds (that used to fly moon launches into their planet)
      const from = this.lastTarget;
      // (and fast enough to escape: heavy planets pull harder than the engine, so cutting the burn
      // early would just drop us back onto the surface)
      let clear = false;
      if (this.assist && this.strategy === 'LAUNCHING' && from) {
        const d = mag(sub(ship.pos, from.pos));
        const vEsc = Math.sqrt((2 * GRAVITATION * SPACECRAFT_MASS * from.mass) / Math.max(d, 1));
        clear = d - from.radius > Math.max(500, from.radius * 1.2) &&
          mag(sub(ship.velocity, from.velocity)) > 1.15 * vEsc;
      }
      if (gated && !clear) return;
      if (clear) { ship.thrust = vec(); this.nextStrategyTime = 0; }
      this.target = this.pickTarget(sim);
      this.bestDist = Infinity;
      this.progressAt = sim.now;
      this.dwell = 0;
      this.orbitPhase = null;
      this.brakingDistance = 0;
      this.lock = 0;
    }
    // fuel check while in flight: if the tank is getting low, divert to the nearest world
    const f = this.fuelState;
    if (f && !this.refuelling && this.tripCost(mag(sub(this.target.pos, ship.pos)), this.target.pos) * 1.2 + 8 > f.level) {
      this.target = this.nearest(this.universe.planets.filter((p) => !p.isMoon && !p.gas));
      this.refuelling = true;
      this.lock = 0;
      this.brakingDistance = 0;
    }
    const target = this.target;

    // stuck detector: no real progress for 25 s means something is pinning us; give up on this target
    if (this.assist && this.strategy !== 'ACQUIRING') {
      const dNow = mag(sub(target.pos, ship.pos));
      const rs = mag(ship.pos);
      const belt = this.universe.belts.find((b) => Math.abs(rs - b.radius) < b.width / 2 + 300);
      if (dNow < this.bestDist - 200) { this.bestDist = dNow; this.progressAt = sim.now; }
      else if (sim.now - this.progressAt > (belt ? 6 : 25)) { // pinned in a rock field gives up much sooner
        if (belt) { // inside a rock field: head straight out through the nearer edge
          const out = rs >= belt.radius ? 1 : -1;
          this.escapeDir = mul(ship.pos, out / rs);
          this.escapeUntil = sim.now + 10;
        }
        this.skip.set(target, sim.now + 180);
        this.target = null; this.lock = 0; this.bestDist = Infinity; this.progressAt = sim.now;
        return;
      }
    }

    // assisted: take a moment to lock on, turning toward the target with the engine idle
    if (this.assist && this.lock < 1) {
      this.strategy = 'ACQUIRING';
      this.debug = '';
      ship.thrust = vec();
      this.setAngle(angleOf(sub(target.pos, ship.pos)), this.turn);
      this.lock = Math.min(1, this.lock + (dt * this.pace) / this.lockTime);
      this.leadingPos = target.pos;
      return;
    }
    if (gated && !this.assist) return;

    const targetVector = sub(target.pos, ship.pos);
    const altitude = mag(targetVector) - target.radius;
    this.landingAltitude = target.gas ? target.atmo.top * 0.85 : Math.min(target.radius, 100);

    const relativeV = sub(ship.velocity, target.velocity);
    const projection = dot(relativeV, mul(targetVector, 1 / mag(targetVector)));
    const relativeSpeed = mag(relativeV) * Math.sign(projection);
    const timeToTarget = relativeSpeed !== 0 ? altitude / relativeSpeed : 1000;

    const newBraking = BRAKING_TIME * (relativeSpeed > 0 ? relativeSpeed : MAIN_ENGINE_ACCEL);
    this.brakingDistance = expSmooth(this.brakingDistance, newBraking, sim.dt, 5);

    this.leadingPos = add(target.pos,
      fromAngle(angleOf(target.velocity), Math.min(altitude / 2, mag(target.velocity))));
    const leadingVector = sub(this.leadingPos, ship.pos);

    if (this.assist) {
      this.guide(ship, target, targetVector, altitude, relativeV);
    } else if (altitude < this.landingAltitude) {
      this.strategy = 'LANDING'; // zero thrust, face away from the ground
      this.setAngle(angleOf(sub(ship.pos, target.pos)), this.landTurn);
      ship.thrust = vec();
    } else if (relativeSpeed < 0 || altitude > this.brakingDistance) {
      this.strategy = 'CHASING'; // make tracks
      this.setAngle(angleOf(leadingVector), this.turn);
      // in assisted mode, only burn once roughly pointed the right way
      const off = Math.abs(wrap(this.desiredAngle - ship.angle));
      // assisted: coast (save fuel) at top speed, but only while the velocity is already
      // pointing straight at the target; any drift gets corrected by burning again
      const drift = Math.abs(wrap(angleOf(relativeV) - angleOf(targetVector)));
      const cruising = this.assist && relativeSpeed > 0 && mag(ship.velocity) > 0.97 * CRAFT_SPEED_LIMIT && drift < 0.01; // (unused at the lower cruise cap)
      ship.thrust = fromAngle(ship.angle, this.assist ? (off < 0.6 && !cruising ? 1 : 0) : 1);
    } else {
      this.strategy = 'APPROACHING'; // bleed off velocity; gravity does the rest
      this.setAngle(angleOf(mul(ship.velocity, -1)), this.turn);
      const decel = relativeSpeed / timeToTarget;
      const off = this.assist ? Math.abs(wrap(this.desiredAngle - ship.angle)) : 0;
      ship.thrust = fromAngle(ship.angle, off < 0.6 ? (decel / MAIN_ENGINE_ACCEL) * 0.9 : 0);
    }
    this.debug = `DV=${relativeSpeed.toFixed(0)} D=${altitude.toFixed(0)} T${timeToTarget >= 0 ? '+' : ''}${timeToTarget.toFixed(1)}`;
    if (!this.assist && this.strategy !== current) this.nextStrategyTime = sim.now + STRATEGY_MIN_TIME;
  }
}
void PI2;
