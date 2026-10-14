import {
  PI2, lerp, clamp, vec, add, sub, mul, mag, angleOf, dist, fromAngle, makeRng, hsvToCss,
} from './maths.js';
import { Namer } from './namer.js';
import { makeDesign, randomDesign, makeCallsign } from './ships.js';
import { Autopilot } from './autopilot.js';

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
export const BH_MASS = 4e10; // pull at 4 horizon radii is about what the engine can match
export const CONSUME_TIME = 2.2; // seconds of spaghettification before the ship is lost
const TRACK_LENGTH = 2400; // trail points (one every TRACK_INTERVAL of sim time)
const TRACK_INTERVAL = 0.05;
const AI_TRACK_LENGTH = 240;
const MAX_SPARKS = 400;
const BELT_BINS = 720;

export const STAR_CLASSES = ['O', 'B', 'A', 'F', 'G', 'K', 'M'];
export const STAR_COLORS = {
  O: '#6666ff', B: '#ccccff', A: '#eeeeff', F: '#ffffff', G: '#ffff66', K: '#ffcc33', M: '#ff8800',
};

const keplerSpeed = (orbit, mass) => (PI2 * orbit) / (Math.sqrt(orbit ** 3 / mass) * KEPLER_CONSTANT);

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
  constructor(orbitCenter, radius, pos, speed, color = '#fff', parent = null) {
    super();
    this.parent = parent; // moons and binary-planet members orbit a parent / anchor
    this.isMoon = !!parent;
    this._center = orbitCenter;
    this.radius = radius;
    this.pos = pos;
    this.opos = pos;
    this.speed = speed;
    this.color = color;
    this.atmosphere = ''; this.description = ''; this.flora = ''; this.fauna = '';
    this.explored = false;
    this.orbitRadius = dist(pos, orbitCenter);
    this.mass = (4 / 3) * Math.PI * radius ** 3 * PLANETARY_DENSITY;
    this.seed = Math.floor(radius * 1000) >>> 0; // drives its look
  }
  get orbitCenter() { return this.parent ? this.parent.pos : this._center; }
  update(sim, dt) {
    const a = angleOf(sub(this.pos, this.orbitCenter));
    const tangential = fromAngle(a + Math.PI / 2, this.speed); // constant linear velocity
    this.velocity = this.parent ? add(this.parent.velocity, tangential) : tangential;
    super.update(sim, dt);
  }
  postUpdate(sim, dt) {
    // pin to the orbit, like a constraint (parents are post-updated before their children)
    const a = angleOf(sub(this.pos, this.orbitCenter));
    this.pos = add(this.orbitCenter, fromAngle(a, this.orbitRadius));
    super.postUpdate(sim, dt);
  }
}

/** A star. In a binary both stars carry an `orbit` around the barycentre (the origin). */
export class Star extends Planet {
  constructor(cls, radius, orbit = null) {
    super(vec(), radius, orbit ? fromAngle(orbit.phase, orbit.radius) : vec(), orbit ? orbit.speed : 0);
    this.cls = cls;
    this.mass = (4 / 3) * Math.PI * radius ** 3 * STELLAR_DENSITY;
    this.color = STAR_COLORS[cls];
    this.collides = false;
    this.anim = 0;
  }
  update(sim, dt) { this.anim += dt; if (this.speed) super.update(sim, dt); }
  postUpdate(sim, dt) { if (this.speed) super.postUpdate(sim, dt); }
}

/** A black hole: `radius` is the event horizon. Anything inside it is lost. */
export class BlackHole extends Star {
  constructor(radius, orbit = null, tilt = 0.5) {
    super('X', radius, orbit);
    this.isBlackHole = true;
    this.mass = BH_MASS;
    this.color = '#000';
    this.tilt = tilt;
  }
}

/** A ring of small rocks on rails. Positions are closed-form, so they cost nothing to simulate. */
export class Belt {
  constructor(radius, width, count, omega, rng) {
    this.radius = radius; this.width = width; this.omega = omega; this.count = count;
    this.phase = new Float32Array(count);
    this.r = new Float32Array(count);
    this.size = new Float32Array(count);
    this.shape = new Uint8Array(count);
    this.bins = Array.from({ length: BELT_BINS }, () => []);
    for (let i = 0; i < count; i++) {
      this.phase[i] = rng() * PI2;
      this.r[i] = radius + (rng() - 0.5) * width;
      this.size[i] = 6 + 40 * rng() ** 3;
      this.shape[i] = rng.int(0, 6);
      this.bins[Math.floor((this.phase[i] / PI2) * BELT_BINS) % BELT_BINS].push(i);
    }
  }
  angle(i, now) { return this.phase[i] + this.omega * now; }
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
  constructor(ship, planet, angle, text, player = true) {
    this.ship = ship; this.planet = planet; this.angle = angle; this.text = text; this.player = player;
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
  constructor(design) {
    super('Ship');
    this.design = design;
    this.thrust = vec();
    this.launchClock = 0;
    this.transit = false;
    this.track = [];
    this.trackMax = TRACK_LENGTH;
    this.lastTrack = -1;
    this.landing = null;
    this.autopilot = null;
    this.consumed = null; // set while a black hole is eating the ship
    this.hitCooldown = 0;
    this.isAI = false;
    this.mass = SPACECRAFT_MASS;
    this.radius = 12;
  }
  update(sim, dt) {
    if (this.consumed) { this.thrust = vec(); return; }
    const f = sim.fuel;
    // Optional survival layer (player only): an empty tank means no thrust; thrusting burns fuel.
    const useFuel = f.on && !this.isAI;
    const dry = useFuel && f.level <= 0;
    const thrustMag = dry ? 0 : mag(this.thrust);
    if (useFuel && thrustMag > 0 && !this.landing) {
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
    this.effThrust = thrustMag;
    if (mag(this.velocity) > CRAFT_SPEED_LIMIT) {
      this.velocity = fromAngle(angleOf(this.velocity), CRAFT_SPEED_LIMIT);
    }
    this.hitCooldown = Math.max(0, this.hitCooldown - dt);
    super.update(sim, dt);
  }
  postUpdate(sim, dt) {
    if (this.consumed) return;
    super.postUpdate(sim, dt);
    // trail points; the classic style draws them in pairs (dashes), the fancy one as a fading line
    if (sim.now - this.lastTrack >= TRACK_INTERVAL) {
      this.lastTrack = sim.now;
      this.track.push({ x: this.pos.x, y: this.pos.y, v: mag(this.velocity) });
      if (this.track.length >= this.trackMax) this.track.splice(0, 2);
    }

    const m = this.effThrust ?? mag(this.thrust);
    if (sim.sparks.length < MAX_SPARKS && sim.rng() < m) {
      const back = fromAngle(this.angle + sim.rng.range(-0.2, 0.2), -MAIN_ENGINE_ACCEL * m * 10 * dt);
      const mk = (opts) => {
        const s = new Spark(opts);
        s.pos = this.pos; s.opos = this.pos; s.velocity = add(this.velocity, back);
        sim.sparks.push(s);
      };
      mk({ ttl: sim.rng.range(0.5, 1), collides: true, mass: 1, style: 'ring', size: 1, color: 'rgba(255,255,255,0.25)' });
      if (sim.style.fancy) {
        mk({ ttl: sim.rng.range(0.25, 0.6), style: 'glow', size: 2 + 2 * m, color: '255,150,40' });
      }
    }
  }
}

export class Universe {
  constructor(seed, { shipModel = 'dart' } = {}) {
    this.randomSeed = seed;
    this.rng = makeRng(seed);
    this.namer = new Namer();
    this.now = 0; this.dt = 0; this.frameDt = 0; this._wall = 0;
    this.timeScale = 1; // below 1 near a black hole
    this.tidal = 0; // 0..1 stress on the player's ship near a black hole
    this.planets = []; // planets first (sorted by orbit), then partners and moons
    this.anchors = []; // invisible barycentres of binary planets
    this.stars = []; // the star(s); the primary may be a black hole
    this.blackHoles = [];
    this.wells = []; // stars + black holes: sources of the big gravity wells
    this.belts = [];
    this.systemType = 'normal';
    this.sparks = [];
    this.landings = [];
    this.entities = []; // updaters (autopilots)
    this.ships = [];
    this.latestDiscovery = null;
    // Extras (off by default so the core stays 1:1): fuel and heat.
    this.fuel = { on: false, level: 100, capacity: 100, burn: 1.6, refuelRate: 10, heat: false };
    this.style = { fancy: true, warp: true }; // fancy trails and glow; warped gravity grid
    this.onLanded = null; // (planet, { rescue, first }) => void
    this.onConsumed = null; // (ship) => void; the player's ship was lost to a black hole
    this.initRandom(shipModel);
  }

  // orbital speed around the whole system's mass
  speedAt(orbit) { return keplerSpeed(orbit, this.totalMass); }

  initRandom(shipModel) {
    const rng = this.rng;
    const systemName = this.namer.nameSystem(rng);
    this.star = new Star(rng.choose(STAR_CLASSES), rng.range(...STAR_RADIUS_RANGE));
    this.star.name = systemName;
    const n = rng.int(NUM_PLANETS_RANGE[0], NUM_PLANETS_RANGE[1] + 1);
    const parents = [];
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
      parents.push(p);
    }
    parents.sort((a, b) => dist(a.pos, this.star.pos) - dist(b.pos, this.star.pos));
    parents.forEach((p, i) => { p.name = `${systemName} ${i + 1}`; });

    const ship = new Spacecraft(makeDesign(shipModel));
    ship.name = 'You';
    const shipAngle = rng() * PI2; // same draw order as the first version
    const shipOrbit = rng.range(...PLANET_ORBIT_RANGE);
    ship.angle = rng() * PI2;
    this.ship = ship;
    this.follow = ship;
    this.ships.push(ship);

    // Everything below uses its own RNG streams, so the planets above never change
    // (except that binary / black-hole systems re-space their orbits).
    this.totalMass = this.star.mass;
    this.stars = [this.star];
    const remap = this.makeSystemType(parents, systemName);
    ship.pos = fromAngle(shipAngle, remap(shipOrbit));

    const pairs = this.makeBinaryPlanets(parents);
    this.planets = [...parents, ...pairs, ...this.makeMoons(parents)];
    this.belts = this.makeBelts(parents);
    this.wells = [...this.stars, ...this.blackHoles.filter((b) => !this.stars.includes(b))];
    this._bodies = [...this.planets, ...this.wells];
    this.spawnAI();
  }

  /** Decide binary / black-hole systems and re-space planet orbits. Returns an orbit remapper. */
  makeSystemType(parents, systemName) {
    const hrng = makeRng((this.randomSeed ^ 0xb1ac4001) >>> 0);
    const roll = hrng();
    const [O0, O1] = PLANET_ORBIT_RANGE;
    let minOrbit = O0;
    this.minOrbit = O0;

    if (roll < 0.12) { // the system's centre is a black hole instead of a star
      this.systemType = 'blackhole';
      const bh = new BlackHole(hrng.range(350, 500), null, hrng.range(-0.5, 0.5));
      bh.name = systemName;
      this.star = bh;
      this.stars = [bh];
      this.blackHoles = [bh];
      this.totalMass = bh.mass;
    } else if (roll < 0.37) { // two stars orbiting each other; planets circle the pair
      this.systemType = 'binary';
      const a = this.star, r2 = a.radius * hrng.range(0.4, 0.9);
      const sep = (a.radius + r2) * hrng.range(2.6, 4);
      const m2 = (4 / 3) * Math.PI * r2 ** 3 * STELLAR_DENSITY;
      const M = a.mass + m2;
      const omega = PI2 / (Math.sqrt(sep ** 3 / M) * KEPLER_CONSTANT);
      const phase = hrng() * PI2;
      const d1 = (sep * m2) / M, d2 = (sep * a.mass) / M;
      a.parent = null; a.orbitRadius = d1; a.speed = omega * d1; a.pos = a.opos = fromAngle(phase, d1);
      const b = new Star(hrng.choose(STAR_CLASSES), r2, { radius: d2, speed: omega * d2, phase: phase + Math.PI });
      b.name = `${systemName} B`;
      this.stars = [a, b];
      this.totalMass = M;
      minOrbit = Math.min(sep * 1.9 + a.radius + r2, O1 * 0.8);
    }
    if (!this.blackHoles.length && hrng() < 0.18) { // a lone black hole wandering the outer system
      const orbit = hrng.range(50_000, 130_000);
      const bh = new BlackHole(hrng.range(350, 500),
        { radius: orbit, speed: keplerSpeed(orbit, this.totalMass), phase: hrng() * PI2 }, hrng.range(-0.5, 0.5));
      bh.name = `${systemName} Maw`;
      this.blackHoles = [bh];
    }
    this.minOrbit = minOrbit;

    const remap = (r) => minOrbit + ((r - O0) * (O1 - minOrbit)) / (O1 - O0);
    if (this.systemType !== 'normal') {
      for (const p of parents) {
        const a = angleOf(p.pos);
        p.orbitRadius = remap(p.orbitRadius);
        p.pos = p.opos = fromAngle(a, p.orbitRadius);
        p.speed = this.speedAt(p.orbitRadius);
      }
    }
    return remap;
  }

  /** Some planets are binary: two worlds orbiting a shared point that itself orbits the star. */
  makeBinaryPlanets(parents) {
    const rng = makeRng((this.randomSeed ^ 0xb1a2a2) >>> 0);
    const partners = [];
    const want = rng() < 0.35 ? rng.int(1, 3) : 0; // about a third of systems have a binary planet
    for (const p of parents) {
      p.beltOrbit = p.orbitRadius;
      if (partners.length >= want || p.radius < 300 || rng() > 0.5) continue;
      const r2 = p.radius * rng.range(0.5, 1);
      const m1 = p.mass, m2 = (4 / 3) * Math.PI * r2 ** 3 * PLANETARY_DENSITY;
      const sep = (p.radius + r2) * rng.range(2.6, 3.6);
      const omega = PI2 / (Math.sqrt(sep ** 3 / (m1 + m2)) * KEPLER_CONSTANT);
      const d1 = (sep * m2) / (m1 + m2), d2 = (sep * m1) / (m1 + m2);
      const phase = rng() * PI2;

      const anchor = new Planet(p._center, 0, p.pos, p.speed);
      anchor.mass = 0; anchor.isAnchor = true; anchor.orbitRadius = p.orbitRadius;
      this.anchors.push(anchor);

      p.parent = anchor; p.isMoon = false;
      p.orbitRadius = d1; p.speed = omega * d1;
      p.pos = p.opos = add(anchor.pos, fromAngle(phase, d1));
      const q = new Planet(anchor.pos, r2, add(anchor.pos, fromAngle(phase + Math.PI, d2)), omega * d2,
        hsvToCss((r2 * 3) % 360, 0.7, 1), anchor);
      q.isMoon = false;
      q.name = `${p.name}-B`;
      q.description = this.namer.describePlanet(rng);
      q.atmosphere = this.namer.describeAtmo(rng);
      q.flora = this.namer.describeLife(rng);
      q.fauna = this.namer.describeLife(rng);
      p.binary = q; q.binary = p;
      partners.push(q);
    }
    return partners;
  }

  makeMoons(parents) {
    const rng = makeRng((this.randomSeed ^ 0x6d6f6f6e) >>> 0);
    const moons = [];
    for (const parent of parents) {
      if (parent.radius < 450 || parent.binary) continue;
      const count = Math.min(3, rng.int(0, 2 + Math.floor(parent.radius / 600)));
      let orbit = parent.radius * rng.range(2.3, 2.9);
      for (let i = 0; i < count; i++) {
        const radius = Math.max(30, parent.radius * rng.range(0.06, 0.22));
        const period = Math.sqrt(orbit ** 3 / parent.mass) * KEPLER_CONSTANT;
        const m = new Planet(
          parent.pos, radius, add(parent.pos, fromAngle(rng() * PI2, orbit)), (PI2 * orbit) / period,
          hsvToCss((radius * 7) % 360, 0.45, 0.95), parent);
        m.name = `${parent.name}${'abc'[i]}`;
        m.description = `${this.namer.planetTable.roll(rng).pull(rng)} moon`;
        m.atmosphere = this.namer.describeAtmo(rng);
        m.flora = this.namer.describeLife(rng);
        m.fauna = this.namer.describeLife(rng);
        moons.push(m);
        orbit += parent.radius * rng.range(1.0, 1.6) + radius * 2;
      }
    }
    return moons;
  }

  /** Asteroid belts sit in the gaps between planet orbits. */
  makeBelts(parents) {
    const rng = makeRng((this.randomSeed ^ 0xbe17) >>> 0);
    const edges = [this.minOrbit, ...parents.map((p) => p.beltOrbit).sort((a, b) => a - b), PLANET_ORBIT_RANGE[1] + 10_000];
    const gaps = [];
    for (let i = 0; i + 1 < edges.length; i++) if (edges[i + 1] - edges[i] >= 9000) gaps.push([edges[i], edges[i + 1]]);
    const belts = [];
    const want = rng.int(0, 3);
    for (let i = 0; i < want && gaps.length; i++) {
      const [lo, hi] = gaps.splice(rng.int(0, gaps.length), 1)[0];
      const gap = hi - lo;
      const radius = (lo + hi) / 2 + (rng() - 0.5) * gap * 0.1;
      const width = Math.min(gap * 0.45, rng.range(3000, 7000));
      const omega = PI2 / (Math.sqrt(radius ** 3 / this.totalMass) * KEPLER_CONSTANT);
      // roughly one rock per 240x240 units, so a belt reads as a field rather than a few stones
      const count = clamp(Math.round((width * PI2 * radius) / (240 * 240)), 2000, 20_000);
      belts.push(new Belt(radius, width, count, omega, rng));
    }
    return belts;
  }

  spawnAI() {
    const rng = makeRng((this.randomSeed ^ 0xa11ce) >>> 0);
    this.aiRng = rng;
    const n = rng.int(2, 5);
    for (let i = 0; i < n; i++) {
      const ship = new Spacecraft(randomDesign(rng));
      const { callsign, role } = makeCallsign(rng);
      ship.name = callsign; ship.role = role; ship.isAI = true; ship.trackMax = AI_TRACK_LENGTH;
      ship.pos = this.safeSpot(rng);
      ship.angle = rng() * PI2;
      const ap = new Autopilot(ship, this, { ai: true, rng });
      ap.enabled = true;
      ship.autopilot = ap;
      this.entities.push(ap);
      this.ships.push(ship);
    }
  }

  /** A random point in the orbit band that is not near a black hole. */
  safeSpot(rng) {
    for (let i = 0; i < 20; i++) {
      const p = fromAngle(rng() * PI2, rng.range(this.minOrbit, PLANET_ORBIT_RANGE[1]));
      if (this.blackHoles.every((b) => dist(b.pos, p) > b.radius * 30)) return p;
    }
    return fromAngle(0, PLANET_ORBIT_RANGE[1]);
  }

  // Put the player's ship down on `planet` right where it is (used by rescue and respawn).
  forceLand(planet, rescue = false) {
    const ship = this.ship;
    const a = angleOf(sub(ship.pos, planet.pos));
    ship.pos = add(planet.pos, fromAngle(a, planet.radius + ship.radius));
    ship.angle = a;
    this.beginLanding(ship, planet, a, rescue);
  }

  beginLanding(ship, planet, a, rescue = false) {
    const player = ship === this.ship;
    const text = this.namer.describeActivity(this.rng, planet);
    const landing = new Landing(ship, planet, a, text, player);
    ship.landing = landing;
    ship.velocity = planet.velocity;
    this.landings.push(landing);
    if (!player) return;
    const first = !planet.explored;
    planet.explored = true;
    this.latestDiscovery = planet;
    if (this.onLanded) this.onLanded(planet, { rescue, first });
  }

  get bodies() { return this._bodies; }

  closestPlanet(ship = this.ship) {
    let best = null, bd = Infinity;
    const px = ship.pos.x, py = ship.pos.y;
    for (const b of this._bodies) {
      const d = Math.hypot(b.pos.x - px, b.pos.y - py);
      if (d < bd) { bd = d; best = b; }
    }
    return best;
  }

  nearestBlackHole(pos) {
    let best = null, bd = Infinity;
    for (const b of this.blackHoles) {
      const d = dist(b.pos, pos);
      if (d < bd) { bd = d; best = b; }
    }
    return best && { bh: best, d: bd };
  }

  consume(ship, bh) {
    if (ship.consumed) return;
    ship.landing = null;
    const off = sub(ship.pos, bh.pos);
    ship.consumed = { bh, t: 0, a0: angleOf(off), r0: Math.max(mag(off), bh.radius * 0.5) };
  }

  respawnAI(ship) {
    ship.consumed = null;
    ship.pos = ship.opos = this.safeSpot(this.aiRng);
    ship.velocity = vec();
    ship.track.length = 0;
    ship.autopilot.target = null;
  }

  // frame time in seconds (monotonic)
  step(tSec) {
    const first = this._wall === 0;
    const raw = tSec - this._wall;
    this._wall = tSec;
    if (first || raw <= 0 || raw > MAX_VALID_DT) return false;
    this.frameDt = raw;
    const dt = raw * this.timeScale; // slow motion near a black hole
    this.dt = dt;
    this.now += dt;

    // 1. integrate
    const ship = this.ship;
    const f = this.fuel;
    f.heat = false;
    if (f.on) {
      if (ship.landing) f.level = Math.min(f.capacity, f.level + f.refuelRate * dt);
      // hazard: a star's corona burns fuel
      if (!ship.consumed && this.stars.some((s) => !s.isBlackHole && dist(ship.pos, s.pos) < s.radius * 1.3)) {
        f.heat = true;
        f.level = Math.max(0, f.level - 8 * dt);
      }
    }
    for (const s of this.ships) {
      if (s.consumed) continue;
      s.transit = false;
      for (const body of this._bodies) {
        const vector = sub(body.pos, s.pos);
        const d = mag(vector);
        if (d < body.radius) {
          if (body.isBlackHole) { this.consume(s, body); break; }
          if (!body.parent && this.stars.includes(body)) s.transit = true;
        } else if (this.now > s.launchClock + LAUNCH_MECO) {
          const g = (GRAVITATION * s.mass * body.mass) / (d * d);
          s.velocity = add(s.velocity, mul(fromAngle(angleOf(vector), g), dt));
        }
      }
    }
    for (const e of this.entities) e.update(this, dt);
    for (const a of this.anchors) a.update(this, dt);
    for (const p of this.planets) p.update(this, dt);
    for (const w of this.wells) w.update(this, dt);
    for (const s of this.ships) s.update(this, dt);
    for (const s of this.sparks) s.update(this, dt);

    // 2. constraints
    this.solve(dt);

    // 3. velocities from positions
    for (const a of this.anchors) a.postUpdate(this, dt);
    for (const p of this.planets) p.postUpdate(this, dt);
    for (const w of this.wells) w.postUpdate(this, dt);
    for (const s of this.ships) s.postUpdate(this, dt);
    for (const s of this.sparks) s.postUpdate(this, dt);

    this.sparks = this.sparks.filter((s) => !s.dead);
    this.landings = this.landings.filter((l) => !l.dead);
    this.updateBlackHoleEffects(raw);
    return true;
  }

  // slow motion + tidal stress for the player, and the spiral into the singularity
  updateBlackHoleEffects(raw) {
    const near = this.ship.consumed ? { bh: this.ship.consumed.bh, d: 0 } : this.nearestBlackHole(this.ship.pos);
    let target = 1, stress = 0;
    if (near) {
      const rh = near.bh.radius;
      target = clamp((near.d - rh) / (5 * rh), 0.15, 1);
      stress = clamp(1 - (near.d - rh) / (4 * rh), 0, 1);
    }
    this.timeScale += (target - this.timeScale) * (1 - Math.exp(-6 * raw));
    this.tidal = stress;

    for (const s of this.ships) {
      const c = s.consumed;
      if (!c) continue;
      c.t += raw;
      const k = clamp(c.t / CONSUME_TIME, 0, 1);
      const r = c.r0 * (1 - k) ** 1.5;
      s.pos = s.opos = add(c.bh.pos, fromAngle(c.a0 + c.t * (3 + 6 * k), r));
      s.velocity = vec();
      if (c.t >= CONSUME_TIME) {
        if (s.isAI) this.respawnAI(s);
        else if (this.onConsumed) this.onConsumed(s);
        else s.consumed = null;
      }
    }
  }

  solve(dt) {
    for (const ship of this.ships) {
      if (ship.consumed) continue;
      if (!ship.landing) {
        const planet = this.closestPlanet(ship);
        if (planet.collides) {
          const d = dist(ship.pos, planet.pos) - ship.radius - planet.radius;
          const a = angleOf(sub(ship.pos, planet.pos));
          if (d < 0) {
            // landing or impact? Heading must be within 45 degrees of straight up.
            // (No angle wrap here; same as the original.)
            if (Math.abs(ship.angle - a) < Math.PI / 4) {
              this.beginLanding(ship, planet, a);
            } else {
              const impact = add(planet.pos, fromAngle(a, planet.radius));
              ship.pos = add(planet.pos, fromAngle(a, planet.radius + ship.radius - d));
              for (let i = 0; i < 10 && this.sparks.length < MAX_SPARKS; i++) {
                const s = new Spark({ ttl: this.rng.range(0.5, 2), style: 'dot', color: '#fff', size: 1 });
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
      this.collideBelts(ship);
    }
    for (const l of this.landings) l.solve(this, dt);
    // ringfence
    for (const ship of this.ships) {
      if (mag(ship.pos) + ship.radius > UNIVERSE_RANGE) {
        ship.pos = fromAngle(angleOf(ship.pos), UNIVERSE_RANGE - ship.radius);
      }
    }
  }

  // Rocks are pushed out of the way positionally, which gives a natural bounce.
  collideBelts(ship) {
    if (ship.landing || !this.belts.length) return;
    const rs = mag(ship.pos);
    for (const belt of this.belts) {
      if (Math.abs(rs - belt.radius) > belt.width / 2 + 120) continue;
      const local = (((angleOf(ship.pos) - belt.omega * this.now) % PI2) + PI2) % PI2;
      const margin = (46 + ship.radius + 12) / rs;
      const b0 = Math.floor(((local - margin) / PI2) * BELT_BINS);
      const b1 = Math.floor(((local + margin) / PI2) * BELT_BINS);
      for (let b = b0; b <= b1; b++) {
        for (const i of belt.bins[((b % BELT_BINS) + BELT_BINS) % BELT_BINS]) {
          const a = belt.angle(i, this.now), r = belt.r[i];
          const rx = Math.cos(a) * r, ry = Math.sin(a) * r;
          const dx = ship.pos.x - rx, dy = ship.pos.y - ry;
          const need = belt.size[i] + ship.radius;
          const d2 = dx * dx + dy * dy;
          if (d2 >= need * need) continue;
          const d = Math.sqrt(d2) || 1;
          ship.pos = vec(rx + (dx / d) * need, ry + (dy / d) * need);
          if (ship.hitCooldown <= 0) {
            ship.hitCooldown = 0.4;
            if (!ship.isAI && this.fuel.on) this.fuel.level = Math.max(0, this.fuel.level - 3);
            for (let k = 0; k < 5 && this.sparks.length < MAX_SPARKS; k++) {
              const s = new Spark({ ttl: this.rng.range(0.4, 1.2), style: 'dot', color: '#fff', size: 1 });
              s.pos = s.opos = vec(rx + (dx / d) * belt.size[i], ry + (dy / d) * belt.size[i]);
              s.velocity = add(mul(ship.velocity, 0.5), fromAngle(this.rng.range(0, PI2), this.rng.range(20, 80)));
              this.sparks.push(s);
            }
          }
        }
      }
    }
  }
}
