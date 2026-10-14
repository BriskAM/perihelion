import {
  vec, sub, mag, dot, angleOf, fromAngle, add, mul, expSmooth, clamp, PI2,
} from './maths.js';
import { MAIN_ENGINE_ACCEL, CRAFT_SPEED_LIMIT } from './universe.js';

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
      'TGT: ' + (this.target ? this.target.name.toUpperCase() : 'SELECTING...'),
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

  pickTarget(sim) {
    const u = this.universe, ship = this.ship;
    const f = this.fuelState;
    if (f && f.level < 0.3 * f.capacity) { // running low: go and refuel at the closest world
      this.refuelling = true;
      return this.nearest(u.planets.filter((p) => !p.isMoon));
    }
    // Moons sit deep in their planet's gravity well; the autopilot only flies to planets.
    const worlds = u.planets.filter((p) => !p.isMoon);
    if (this.ai) {
      const options = worlds.filter((p) => p !== this.lastTarget);
      return this.rng.choose(options.length ? options : worlds);
    }
    return worlds
      .slice()
      .sort((a, b) => mag(sub(a.pos, ship.pos)) - mag(sub(b.pos, ship.pos)))
      .find((p) => !p.explored) ?? worlds[Math.floor(Math.random() * worlds.length)];
  }

  /** Bend the course around stars and black holes that sit on the straight line to the target. */
  avoidStar(ship, vector) {
    const len2 = vector.x * vector.x + vector.y * vector.y;
    if (len2 < 1) return vector;
    let best = null, bestT = Infinity;
    for (const w of this.universe.wells) {
      const R = w.isBlackHole ? w.radius * 10 : w.radius * 1.9;
      const toW = sub(w.pos, ship.pos);
      const t = dot(toW, vector) / len2;
      if (t <= 0 || t >= 1 || t >= bestT) continue;
      const off = sub(add(ship.pos, mul(vector, t)), w.pos);
      if (mag(off) >= R || mag(toW) < R * 0.8) continue;
      best = { w, R, off }; bestT = t;
    }
    if (!best) return vector;
    const m = mag(best.off);
    const dir = m > 1 ? mul(best.off, 1 / m) : { x: -vector.y / Math.sqrt(len2), y: vector.x / Math.sqrt(len2) };
    return sub(add(best.w.pos, mul(dir, best.R * 1.15)), ship.pos);
  }

  /**
   * Assisted guidance: steer the *relative velocity* (ship vs target) toward a braking curve
   * (the fastest approach speed we can still stop from). This cancels sideways drift, so the
   * ship neither orbits its target nor wastes fuel; it coasts whenever it is already on course.
   */
  guide(ship, target, targetVector, altitude, relativeV) {
    if (altitude < this.landingAltitude) {
      this.strategy = 'LANDING'; // zero thrust, face away from the ground
      this.setAngle(angleOf(sub(ship.pos, target.pos)), LANDING_TURN_RATE);
      ship.thrust = vec();
      return;
    }
    const aim = this.avoidStar(ship, targetVector);
    const dir = mul(aim, 1 / mag(aim));
    const approach = Math.min(0.97 * CRAFT_SPEED_LIMIT,
      Math.sqrt(MAIN_ENGINE_ACCEL * Math.max(0, altitude - this.landingAltitude)) + 20);
    const dv = sub(mul(dir, approach), relativeV);
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
        this.nextStrategyTime = sim.now + LAUNCH_THRUST_TIME;
      }
      return;
    }

    if (!this.target) {
      if (gated) return;
      this.target = this.pickTarget(sim);
      this.brakingDistance = 0;
      this.lock = 0;
    }
    // fuel check while in flight: if the tank is getting low, divert to the nearest world
    const f = this.fuelState;
    if (f && !this.refuelling && f.level < 0.3 * f.capacity) {
      this.target = this.nearest(this.universe.planets.filter((p) => !p.isMoon));
      this.refuelling = true;
      this.lock = 0;
      this.brakingDistance = 0;
    }
    const target = this.target;

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
      this.setAngle(angleOf(this.assist ? this.avoidStar(ship, leadingVector) : leadingVector), TURN_RATE);
      // in assisted mode, only burn once roughly pointed the right way
      const off = Math.abs(wrap(this.desiredAngle - ship.angle));
      // assisted: coast (save fuel) at top speed, but only while the velocity is already
      // pointing straight at the target; any drift gets corrected by burning again
      const drift = Math.abs(wrap(angleOf(relativeV) - angleOf(targetVector)));
      const cruising = this.assist && relativeSpeed > 0 && mag(ship.velocity) > 0.97 * CRAFT_SPEED_LIMIT && drift < 0.01;
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
