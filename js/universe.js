import {
  PI2, lerp, vec, add, sub, mul, mag, angleOf, dist, fromAngle, makeRng, hsvToCss,
} from './maths.js';
import { Namer } from './namer.js';

export const UNIVERSE_RANGE = 200_000;
export const NUM_PLANETS_RANGE = [1, 10];
export const STAR_RADIUS_RANGE = [1_000, 8_000];
export const PLANET_RADIUS_RANGE = [50, 2_000];
export const PLANET_ORBIT_RANGE = [STAR_RADIUS_RANGE[1] * 2, UNIVERSE_RANGE * 0.75];

export const GRAVITATION = 1e-2;
export const KEPLER_CONSTANT = 50;
export const PLANETARY_DENSITY = 2.5;
export const STELLAR_DENSITY = 0.5;
export const SPACECRAFT_MASS = 10;
export const CRAFT_SPEED_LIMIT = 5_000;
export const MAIN_ENGINE_ACCEL = 1000;
export const LAUNCH_MECO = 2; // seconds of no gravity after launch
export const LANDING_REMOVAL_TIME = 60 * 15;
export const MAX_VALID_DT = 1;
export const TRACK_LENGTH = 10_000;

export const STAR_CLASSES = ['O', 'B', 'A', 'F', 'G', 'K', 'M'];
export const STAR_COLORS = {
  O: '#6666ff', B: '#ccccff', A: '#eeeeff', F: '#ffffff', G: '#ffff66', K: '#ffcc33', M: '#ff8800',
};

class Body {
  constructor(name = 'Unknown') {
    this.name = name;
    this.pos = vec(); this.opos = vec(); this.velocity = vec();
    this.mass = 0; this.angle = 0; this.radius = 0; this.collides = true;
  }
  update(sim, dt) {
    if (dt <= 0) return;
    this.opos = this.pos;
    this.pos = add(this.pos, mul(this.velocity, dt));
  }
  postUpdate(sim, dt) {
    if (dt <= 0) return;
    this.velocity = mul(sub(this.pos, this.opos), 1 / dt);
  }
}

export class Planet extends Body {
  constructor(orbitCenter, radius, pos, speed, color = '#fff') {
    super();
    this.orbitCenter = orbitCenter;
    this.radius = radius;
    this.pos = pos;
    this.speed = speed;
    this.color = color;
    this.atmosphere = ''; this.description = ''; this.flora = ''; this.fauna = '';
    this.explored = false;
    this.orbitRadius = dist(pos, orbitCenter);
    this.mass = (4 / 3) * Math.PI * radius ** 3 * PLANETARY_DENSITY;
    this.seed = Math.floor(radius * 1000) >>> 0; // drives its surface texture
  }
  update(sim, dt) {
    const a = angleOf(sub(this.pos, this.orbitCenter));
    this.velocity = fromAngle(a + Math.PI / 2, this.speed); // constant linear velocity
    super.update(sim, dt);
  }
  postUpdate(sim, dt) {
    // pin to the orbit, like a constraint
    const a = angleOf(sub(this.pos, this.orbitCenter));
    this.pos = add(this.orbitCenter, fromAngle(a, this.orbitRadius));
    super.postUpdate(sim, dt);
  }
}

export class Star extends Planet {
  constructor(cls, radius) {
    super(vec(), radius, vec(), 0);
    this.cls = cls;
    this.mass = (4 / 3) * Math.PI * radius ** 3 * STELLAR_DENSITY;
    this.color = STAR_COLORS[cls];
    this.collides = false;
    this.anim = 0;
  }
  update(sim, dt) { this.anim += dt; }
  postUpdate() {}
}

export class Spark extends Body {
  constructor({ ttl, style = 'line', color = '#888', size = 2, collides = false, mass = 0 }) {
    super('Spark');
    this.ttl = ttl; this.life = ttl; this.style = style;
    this.color = color; this.size = size; this.collides = collides; this.mass = mass;
  }
  update(sim, dt) { super.update(sim, dt); this.life -= dt; }
  get dead() { return this.life < 0; }
}

export class Landing {
  constructor(ship, planet, angle, text) {
    this.ship = ship; this.planet = planet; this.angle = angle; this.text = text;
    this.life = LANDING_REMOVAL_TIME;
  }
  solve(sim, dt) {
    const ship = this.ship;
    if (ship) {
      const desired = add(this.planet.pos, fromAngle(this.angle, ship.radius + this.planet.radius));
      ship.pos = add(mul(ship.pos, 0.5), mul(desired, 0.5));
      ship.angle = this.angle;
    }
    this.life -= dt;
  }
  get dead() { return this.life < 0; }
}

export class Spacecraft extends Body {
  constructor() {
    super('Ship');
    this.thrust = vec();
    this.launchClock = 0;
    this.transit = false;
    this.track = [];
    this.landing = null;
    this.autopilot = null;
    this.mass = SPACECRAFT_MASS;
    this.radius = 12;
  }
  update(sim, dt) {
    const f = sim.fuel;
    // Optional survival layer: an empty tank means no thrust; thrusting burns fuel.
    const dry = f.on && f.level <= 0;
    const thrustMag = dry ? 0 : mag(this.thrust);
    if (f.on && thrustMag > 0 && !this.landing) {
      f.level = Math.max(0, f.level - Math.min(1, thrustMag) * f.burn * dt);
    }
    if (thrustMag > 0) {
      let deltaV = MAIN_ENGINE_ACCEL * dt * Math.min(1, thrustMag);
      if (this.landing) {
        if (this.launchClock === 0) this.launchClock = sim.now + 1;
        if (sim.now > this.launchClock) {
          this.landing.ship = null; // detach from the landing site
          this.landing = null;
        } else {
          deltaV = 0;
        }
      }
      this.velocity = add(this.velocity, fromAngle(this.angle, deltaV));
    } else if (this.launchClock !== 0) {
      this.launchClock = 0;
    }
    if (mag(this.velocity) > CRAFT_SPEED_LIMIT) {
      this.velocity = fromAngle(angleOf(this.velocity), CRAFT_SPEED_LIMIT);
    }
    super.update(sim, dt);
  }
  postUpdate(sim, dt) {
    super.postUpdate(sim, dt);
    // pairs of points: the trail renders as dashes, as in the original
    this.track.push(this.pos);
    if (this.track.length >= TRACK_LENGTH - 1) this.track.splice(0, 2);

    const m = mag(this.thrust);
    if (sim.rng() < m) {
      const s = new Spark({
        ttl: sim.rng.range(0.5, 1), collides: true, mass: 1, style: 'ring', size: 1,
        color: 'rgba(255,255,255,0.25)',
      });
      s.pos = this.pos; s.opos = this.pos;
      s.velocity = add(this.velocity,
        fromAngle(this.angle + sim.rng.range(-0.2, 0.2), -MAIN_ENGINE_ACCEL * m * 10 * dt));
      sim.sparks.push(s);
    }
  }
}

export class Universe {
  constructor(seed) {
    this.randomSeed = seed;
    this.rng = makeRng(seed);
    this.namer = new Namer();
    this.now = 0; this.dt = 0; this._wall = 0;
    this.planets = [];
    this.sparks = [];
    this.landings = [];
    this.entities = []; // extra updaters (autopilot)
    this.latestDiscovery = null;
    // Extras (off by default so the core stays 1:1): fuel and heat.
    this.fuel = { on: false, level: 100, capacity: 100, burn: 1.6, refuelRate: 10, heat: false };
    this.onLanded = null; // (planet, { rescue }) => void
    this.initRandom();
  }

  // Put the ship down on `planet` right where it is (used by the rescue button).
  forceLand(planet, rescue = false) {
    const ship = this.ship;
    const a = angleOf(sub(ship.pos, planet.pos));
    ship.pos = add(planet.pos, fromAngle(a, planet.radius + ship.radius));
    ship.angle = a;
    this.beginLanding(planet, a, rescue);
  }

  beginLanding(planet, a, rescue = false) {
    const ship = this.ship;
    const landing = new Landing(ship, planet, a, this.namer.describeActivity(this.rng, planet));
    ship.landing = landing;
    ship.velocity = planet.velocity;
    this.landings.push(landing);
    const first = !planet.explored;
    planet.explored = true;
    this.latestDiscovery = planet;
    if (this.onLanded) this.onLanded(planet, { rescue, first });
  }

  initRandom() {
    const rng = this.rng;
    const systemName = this.namer.nameSystem(rng);
    this.star = new Star(rng.choose(STAR_CLASSES), rng.range(...STAR_RADIUS_RANGE));
    this.star.name = systemName;
    const n = rng.int(NUM_PLANETS_RANGE[0], NUM_PLANETS_RANGE[1] + 1);
    for (let i = 0; i < n; i++) {
      const radius = rng.range(...PLANET_RADIUS_RANGE);
      const orbitRadius = lerp(PLANET_ORBIT_RANGE[0], PLANET_ORBIT_RANGE[1], rng());
      const period = Math.sqrt(orbitRadius ** 3 / this.star.mass) * KEPLER_CONSTANT;
      const speed = (PI2 * orbitRadius) / period;
      const p = new Planet(
        this.star.pos, radius, add(this.star.pos, fromAngle(rng() * PI2, orbitRadius)),
        speed, hsvToCss(radius % 360, 0.75, 1));
      p.description = this.namer.describePlanet(rng);
      p.atmosphere = this.namer.describeAtmo(rng);
      p.flora = this.namer.describeLife(rng);
      p.fauna = this.namer.describeLife(rng);
      this.planets.push(p);
    }
    this.planets.sort((a, b) => dist(a.pos, this.star.pos) - dist(b.pos, this.star.pos));
    this.planets.forEach((p, i) => { p.name = `${systemName} ${i + 1}`; });

    const ship = new Spacecraft();
    ship.pos = add(this.star.pos, fromAngle(rng() * PI2, rng.range(...PLANET_ORBIT_RANGE)));
    ship.angle = rng() * PI2;
    this.ship = ship;
    this.follow = ship;
  }

  get bodies() { return [...this.planets, this.star]; }

  closestPlanet() {
    let best = null, bd = Infinity;
    for (const b of this.bodies) {
      const d = dist(b.pos, this.ship.pos);
      if (d < bd) { bd = d; best = b; }
    }
    return best;
  }

  // frame time in seconds (monotonic)
  step(tSec) {
    const first = this._wall === 0;
    this.dt = tSec - this._wall;
    this._wall = tSec;
    if (first || this.dt <= 0 || this.dt > MAX_VALID_DT) return false;
    const dt = this.dt;
    this.now += dt;

    // 1. integrate
    const ship = this.ship;
    ship.transit = false;
    const f = this.fuel;
    f.heat = false;
    if (f.on) {
      if (ship.landing) f.level = Math.min(f.capacity, f.level + f.refuelRate * dt);
      // hazard: the corona burns fuel
      if (dist(ship.pos, this.star.pos) < this.star.radius * 1.3) {
        f.heat = true;
        f.level = Math.max(0, f.level - 8 * dt);
      }
    }
    for (const body of this.bodies) {
      const vector = sub(body.pos, ship.pos);
      const d = mag(vector);
      if (d < body.radius) {
        if (body === this.star) ship.transit = true;
      } else if (this.now > ship.launchClock + LAUNCH_MECO) {
        const g = (GRAVITATION * ship.mass * body.mass) / (d * d);
        ship.velocity = add(ship.velocity, mul(fromAngle(angleOf(vector), g), dt));
      }
    }
    for (const e of this.entities) e.update(this, dt);
    for (const p of this.planets) p.update(this, dt);
    this.star.update(this, dt);
    ship.update(this, dt);
    for (const s of this.sparks) s.update(this, dt);

    // 2. constraints
    this.solve(dt);

    // 3. velocities from positions
    for (const p of this.planets) p.postUpdate(this, dt);
    ship.postUpdate(this, dt);
    for (const s of this.sparks) s.postUpdate(this, dt);

    this.sparks = this.sparks.filter((s) => !s.dead);
    this.landings = this.landings.filter((l) => !l.dead);
    return true;
  }

  solve(dt) {
    const ship = this.ship;
    if (!ship.landing) {
      const planet = this.closestPlanet();
      if (planet.collides) {
        const d = dist(ship.pos, planet.pos) - ship.radius - planet.radius;
        const a = angleOf(sub(ship.pos, planet.pos));
        if (d < 0) {
          // landing or impact? Heading must be within 45 degrees of straight up.
          // (No angle wrap here; same as the original.)
          if (Math.abs(ship.angle - a) < Math.PI / 4) {
            this.beginLanding(planet, a);
          } else {
            const impact = add(planet.pos, fromAngle(a, planet.radius));
            ship.pos = add(planet.pos, fromAngle(a, planet.radius + ship.radius - d));
            for (let i = 0; i < 10; i++) {
              const s = new Spark({
                ttl: this.rng.range(0.5, 2), style: 'dot', color: '#fff', size: 1,
              });
              s.pos = add(impact, fromAngle(this.rng.range(0, PI2), this.rng.range(0.1, 0.5)));
              s.opos = s.pos;
              s.velocity = add(mul(ship.velocity, 0.8),
                fromAngle(this.rng.range(0, PI2), this.rng.range(0.1, 0.5)));
              this.sparks.push(s);
            }
          }
        }
      }
    }
    for (const l of this.landings) l.solve(this, dt);
    // ringfence
    if (mag(ship.pos) + ship.radius > UNIVERSE_RANGE) {
      ship.pos = fromAngle(angleOf(ship.pos), UNIVERSE_RANGE - ship.radius);
    }
  }
}
