import {
  vec, sub, mag, dot, angleOf, fromAngle, add, mul, expSmooth,
} from './maths.js';
import { MAIN_ENGINE_ACCEL } from './universe.js';

const BRAKING_TIME = 5;
const SIGHTSEEING_TIME = 15;
const LAUNCH_THRUST_TIME = 5;
const STRATEGY_MIN_TIME = 0.5;

export class Autopilot {
  constructor(ship, universe) {
    this.ship = ship;
    this.universe = universe;
    this.enabled = false;
    this.target = null;
    this.landingAltitude = 0;
    this.nextStrategyTime = 0;
    this.brakingDistance = 0;
    this.leadingPos = vec();
    this.strategy = 'NONE';
    this.debug = '';
  }

  get telemetry() {
    if (!this.enabled) return '';
    return [
      '---- AUTOPILOT ENGAGED ----',
      'TGT: ' + (this.target ? this.target.name.toUpperCase() : 'SELECTING...'),
      'EXE: ' + this.strategy + (this.debug ? ` (${this.debug})` : ''),
    ].join('\n');
  }

  update(sim, dt) {
    if (!this.enabled) return;
    if (sim.now < this.nextStrategyTime) return;
    const ship = this.ship;
    const current = this.strategy;

    if (ship.landing) {
      if (this.target) {
        // just arrived: see the sights
        this.strategy = 'LANDED';
        this.debug = '';
        this.target = null;
        this.landingAltitude = 0;
        this.nextStrategyTime = sim.now + SIGHTSEEING_TIME;
      } else {
        ship.thrust = fromAngle(ship.angle, 1); // full power until we blast off
        this.strategy = 'LAUNCHING';
        this.debug = '';
        this.nextStrategyTime = sim.now + LAUNCH_THRUST_TIME;
      }
      return;
    }

    if (!this.target) {
      const u = this.universe;
      this.target = u.planets
        .slice()
        .sort((a, b) => mag(sub(a.pos, ship.pos)) - mag(sub(b.pos, ship.pos)))
        .find((p) => !p.explored) ?? u.planets[Math.floor(Math.random() * u.planets.length)];
      this.brakingDistance = 0;
    }

    const target = this.target;
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

    if (altitude < this.landingAltitude) {
      this.strategy = 'LANDING'; // zero thrust, face away from the ground
      ship.angle = angleOf(sub(ship.pos, target.pos));
      ship.thrust = vec();
    } else if (relativeSpeed < 0 || altitude > this.brakingDistance) {
      this.strategy = 'CHASING'; // make tracks
      ship.angle = angleOf(leadingVector);
      ship.thrust = fromAngle(ship.angle, 1);
    } else {
      this.strategy = 'APPROACHING'; // bleed off velocity; gravity does the rest
      ship.angle = angleOf(mul(ship.velocity, -1));
      const decel = relativeSpeed / timeToTarget;
      ship.thrust = fromAngle(ship.angle, (decel / MAIN_ENGINE_ACCEL) * 0.9);
    }
    this.debug = `DV=${relativeSpeed.toFixed(0)} D=${altitude.toFixed(0)} T${timeToTarget >= 0 ? '+' : ''}${timeToTarget.toFixed(1)}`;
    if (this.strategy !== current) this.nextStrategyTime = sim.now + STRATEGY_MIN_TIME;
  }
}
