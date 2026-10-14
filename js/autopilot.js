import {
  vec, sub, mag, dot, angleOf, fromAngle, add, mul, expSmooth, clamp, PI2,
} from './maths.js';
import {
  MAIN_ENGINE_ACCEL, CRAFT_SPEED_LIMIT, GRAVITATION, SPACECRAFT_MASS, landingSpeedLimit,
} from './universe.js';

const BRAKING_TIME = 5;
const LAUNCH_THRUST_TIME = 5;
const STRATEGY_MIN_TIME = 0.5;
const TURN_RATE = 3; // rad/s in assisted mode
const LANDING_TURN_RATE = 8;
const OVERRIDE_HOLD = 1.2; // seconds after you let go of the stick before it re-locks

const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));

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
    return list.slice().sort((a, b) => mag(sub(a.pos, ship.pos)) - mag(sub(b.pos, ship.pos)))[0];
  }

  /** Rough fuel for a trip of `d` units: burn time to get up to speed and to stop, plus cruising. */
  tripCost(d, toPos = null) {
    const burn = this.universe.fuel.burn;
    let cost = burn * (11 + d / 4000);
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
    const reach = (p) => !f || this.tripCost(mag(sub(p.pos, ship.pos)), p.pos) * 1.25 + 8 <= f.level;
    const now = u.now;
    const allowed = (p) => (this.skip.get(p) ?? 0) <= now;
    // moons of heavy planets sit in a well the engine cannot climb out of: leave those to the pilot
    const reachableMoon = (p) => !p.isMoon || p.parent.radius <= 1100;
    let pool = u.planets.filter((p) => !this.charted(p) && p !== this.lastTarget && allowed(p) && reachableMoon(p));
    if (f) pool = pool.filter(reach); // never plan a trip the tank cannot cover
    if (f && !pool.length && u.planets.some((p) => !this.charted(p))) {
      // uncharted worlds exist but are out of range: refuel at the nearest world first
      this.refuelling = true;
      this.uncharted = false;
      return this.nearest(u.planets.filter((p) => !p.isMoon));
    }
    this.uncharted = pool.length > 0;
    if (!pool.length) pool = u.planets.filter((p) => !p.isMoon && p !== this.lastTarget);
    if (!pool.length) pool = u.planets;
    const weights = pool.map((p) => {
      const d = mag(sub(p.pos, ship.pos));
      let w = (p.isMoon ? 0.6 : 1) / (1 + (d / 25_000) ** 2);
      if (f && f.burn * (11 + d / 5000) + 15 > f.level) w *= 0.05;
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
      const R = w.isBlackHole ? w.radius * 10 : isWell ? w.radius * 1.9 : w.radius * 2.2 + 350;
      const toW = sub(w.pos, ship.pos);
      if (isWell && mag(toW) < R) { // already inside a star's corona or a black hole's danger zone: get out
        escape = add(escape, mul(toW, -1 / (mag(toW) || 1)));
        continue;
      }
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

  /**
   * Assisted guidance: steer the *relative velocity* (ship vs target) toward a braking curve
   * (the fastest approach speed we can still stop from). This cancels sideways drift, so the
   * ship neither orbits its target nor wastes fuel; it coasts whenever it is already on course.
   */
  guide(ship, target, targetVector, altitude, relativeV) {
    if (this.universe.now < this.escapeUntil) { // wriggle out of a rock field we are pinned in
      this.strategy = 'ESCAPING';
      const dv = sub(mul(this.escapeDir, 450), relativeV);
      this.setAngle(angleOf(dv), TURN_RATE);
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
    const hover = Math.max(0, Math.sqrt((GRAVITATION * SPACECRAFT_MASS * target.mass) / (0.8 * MAIN_ENGINE_ACCEL)) - target.radius);
    if (altitude < Math.max(this.landingAltitude, hover)) {
      // Final descent: cancel the relative velocity (sideways drift included) until it is well under
      // the limit, then face away from the ground and let gravity finish the job.
      this.strategy = 'LANDING';
      const speed = mag(relativeV);
      const braking = speed > 0.35 * safe;
      const heading = braking ? angleOf(mul(relativeV, -1)) : angleOf(sub(ship.pos, target.pos));
      this.setAngle(heading, LANDING_TURN_RATE);
      const aligned = Math.abs(wrap(heading - ship.angle)) < 0.5;
      ship.thrust = braking && aligned ? fromAngle(ship.angle, clamp((speed - 0.2 * safe) / 150, 0.1, 1)) : vec();
      return;
    }
    const dir = mul(targetVector, 1 / mag(targetVector));
    const approach = Math.min(0.72 * CRAFT_SPEED_LIMIT, this.beltSpeedCap(ship, targetVector),
      Math.sqrt(brake * Math.max(0, altitude - Math.max(this.landingAltitude, hover))) + 0.2 * safe);
    const desired = add(mul(dir, approach), mul(this.avoidance(ship, targetVector, target), 0.6 * approach));
    const dv = sub(add(desired, mul(this.rockPush(ship, dir), 350)), relativeV);
    const dvMag = mag(dv);
    const along = dot(relativeV, dir);
    this.strategy = dvMag < 60 ? 'CRUISING' : along < approach * 0.9 && dot(dv, dir) > 0 ? 'CHASING' : 'APPROACHING';
    if (dvMag < 60) { ship.thrust = vec(); return; } // already on the curve: coast
    this.setAngle(angleOf(dv), TURN_RATE);
    const off = Math.abs(wrap(angleOf(dv) - ship.angle));
    ship.thrust = fromAngle(ship.angle, off < 0.5 ? clamp(dvMag / 300, 0.15, 1) : 0);
  }

  update(sim, dt) {
    if (!this.enabled) return;
    const ship = this.ship;
    if (ship.consumed) { this.target = null; return; }

    if (this.manual) { // you have the stick: hands off
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
    // smooth turning toward the heading the current strategy asked for
    if (this.assist && this.desiredAngle !== null && !ship.landing) {
      const step = (this.turnRate ?? TURN_RATE) * dt;
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
        this.lastTarget = this.target;
        this.visited.add(this.target);
        this.target = null;
        this.refuelling = false;
        this.lock = 0;
        this.landingAltitude = 0;
        this.nextStrategyTime = sim.now + (this.ai ? this.rng.range(8, 25) : this.sightseeing);
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
        if (d >= (w.isBlackHole ? w.radius * 8 : w.radius * 1.7)) continue;
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
      this.brakingDistance = 0;
      this.lock = 0;
    }
    // fuel check while in flight: if the tank is getting low, divert to the nearest world
    const f = this.fuelState;
    if (f && !this.refuelling && this.tripCost(mag(sub(this.target.pos, ship.pos)), this.target.pos) * 1.1 + 5 > f.level) {
      this.target = this.nearest(this.universe.planets.filter((p) => !p.isMoon));
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
      this.setAngle(angleOf(sub(target.pos, ship.pos)), TURN_RATE);
      this.lock = Math.min(1, this.lock + dt / this.lockTime);
      this.leadingPos = target.pos;
      return;
    }
    if (gated && !this.assist) return;

    const targetVector = sub(target.pos, ship.pos);
    const altitude = mag(targetVector) - target.radius;
    this.landingAltitude = Math.min(target.radius, 100);

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
      this.setAngle(angleOf(sub(ship.pos, target.pos)), LANDING_TURN_RATE);
      ship.thrust = vec();
    } else if (relativeSpeed < 0 || altitude > this.brakingDistance) {
      this.strategy = 'CHASING'; // make tracks
      this.setAngle(angleOf(leadingVector), TURN_RATE);
      // in assisted mode, only burn once roughly pointed the right way
      const off = Math.abs(wrap(this.desiredAngle - ship.angle));
      // assisted: coast (save fuel) at top speed, but only while the velocity is already
      // pointing straight at the target; any drift gets corrected by burning again
      const drift = Math.abs(wrap(angleOf(relativeV) - angleOf(targetVector)));
      const cruising = this.assist && relativeSpeed > 0 && mag(ship.velocity) > 0.97 * CRAFT_SPEED_LIMIT && drift < 0.01; // (unused at the lower cruise cap)
      ship.thrust = fromAngle(ship.angle, this.assist ? (off < 0.6 && !cruising ? 1 : 0) : 1);
    } else {
      this.strategy = 'APPROACHING'; // bleed off velocity; gravity does the rest
      this.setAngle(angleOf(mul(ship.velocity, -1)), TURN_RATE);
      const decel = relativeSpeed / timeToTarget;
      const off = this.assist ? Math.abs(wrap(this.desiredAngle - ship.angle)) : 0;
      ship.thrust = fromAngle(ship.angle, off < 0.6 ? (decel / MAIN_ENGINE_ACCEL) * 0.9 : 0);
    }
    this.debug = `DV=${relativeSpeed.toFixed(0)} D=${altitude.toFixed(0)} T${timeToTarget >= 0 ? '+' : ''}${timeToTarget.toFixed(1)}`;
    if (!this.assist && this.strategy !== current) this.nextStrategyTime = sim.now + STRATEGY_MIN_TIME;
  }
}
void PI2;
