import {
  PI2, lerp, clamp, vec, add, sub, mul, mag, angleOf, dist, fromAngle, makeRng, hsvToCss,
} from './maths.js';
import { Namer } from './namer.js';
import { makeDesign, randomDesign, makeCallsign } from './ships.js';
import { Autopilot } from './autopilot.js';
import { SOL } from './sol.js';
import { rollPhysics, makeAtmosphere, densityAt, DRAG_COEFF, HEAT_COEFF, HEAT_SAFE, paintByClimate } from './planets.js';
import { DebrisField } from './debris.js';

export const UNIVERSE_RANGE = 200_000;
export const NUM_PLANETS_RANGE = [1, 10];
export const STAR_RADIUS_RANGE = [1_000, 8_000];
export const PLANET_RADIUS_RANGE = [50, 2_000];
export const PLANET_ORBIT_RANGE = [STAR_RADIUS_RANGE[1] * 2, UNIVERSE_RANGE * 0.75];

export const GRAVITATION = 1e-2;
export const PLANETARY_DENSITY = 2.5;
export const STELLAR_DENSITY = 0.5;
export const SPACECRAFT_MASS = 10;
// Chosen so that rail orbits move at exactly the speed gravity would give a free-flying ship
// (circular speed = sqrt(G * shipMass * M / r)). The original used 50, which made planets crawl
// compared with a ship in the same field; consistency is what lets ships orbit planets.
export const KEPLER_CONSTANT = (2 * Math.PI) / Math.sqrt(GRAVITATION * SPACECRAFT_MASS);
export const CRAFT_SPEED_LIMIT = 5_000;
export const MAIN_ENGINE_ACCEL = 1000;
export const LAUNCH_MECO = 2; // seconds of no gravity after launch
export const LANDING_REMOVAL_TIME = 60 * 15;
export const MAX_VALID_DT = 1;
export const BH_MASS = 4e10; // pull at 4 horizon radii is about what the engine can match
export const SOL_SEED = 100_000_001;
export const CONSUME_TIME = 2.2; // seconds of spaghettification before the ship is lost
const TRACK_LENGTH = 2400; // trail points (one every TRACK_INTERVAL of sim time)
const TRACK_INTERVAL = 0.05;
const AI_TRACK_LENGTH = 240;
const MAX_SPARKS = 400;
const BELT_BINS = 720;

export const STAR_CLASSES = ['O', 'B', 'A', 'F', 'G', 'K', 'M'];
export const STAR_COLORS = {
  O: '#6666ff', B: '#ccccff', A: '#eeeeff', F: '#ffffff', G: '#ffff66', K: '#ffcc33', M: '#ff8800',
  N: '#d8ecff', D: '#b5523a', // pulsar (neutron star), brown dwarf
};

/**
 * Fastest speed (relative to the planet) at which you can still touch down. Big planets pull
 * harder than the engine can resist near the surface, so they forgive more speed.
 */
export function landingSpeedLimit(p) {
  const surfaceG = (GRAVITATION * SPACECRAFT_MASS * p.mass) / (p.radius * p.radius);
  return (150 + 0.45 * surfaceG) * (1 + 0.6 * (p.atmo?.rho0 ?? 0)); // thick air cushions a landing
}

const keplerOmega = (orbit, mass) => PI2 / (Math.sqrt(orbit ** 3 / mass) * KEPLER_CONSTANT);
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

  /**
   * Put the body on a Keplerian rail: an ellipse with eccentricity e whose closest point (periapsis)
   * points along varpi, with orbitRadius as the semi-major axis. The rail is closed-form, so any
   * moment past or future is exact (the trajectory predictor uses that), and the body moves fast near
   * periapsis and slow near apoapsis, as Kepler's second law says. `theta` is its current angle.
   */
  initRail(now, theta, e = 0, varpi = 0) {
    const n = this.orbitRadius > 0 ? this.speed / this.orbitRadius : 0; // mean motion
    const nu = theta - varpi;
    const E = 2 * Math.atan2(Math.sqrt(1 - e) * Math.sin(nu / 2), Math.sqrt(1 + e) * Math.cos(nu / 2));
    this.rail = { e, varpi, n, M0: E - e * Math.sin(E) - n * now };
    this.pos = this.opos = this.posAt(now);
  }

  /** Where the body is at sim time `time`. */
  posAt(time) {
    const r = this.rail;
    if (!r || !this.orbitRadius) return this.pos;
    const c = this.parent ? this.parent.posAt(time) : this._center;
    const e = r.e, a = this.orbitRadius;
    const M = r.M0 + r.n * time;
    let E = e < 0.8 ? M : Math.PI;
    for (let i = 0; i < 6 && e > 0; i++) E -= (E - e * Math.sin(E) - M) / (1 - e * Math.cos(E)); // Kepler's equation
    const x = a * (Math.cos(E) - e), y = a * Math.sqrt(1 - e * e) * Math.sin(E);
    const cw = Math.cos(r.varpi), sw = Math.sin(r.varpi);
    return { x: c.x + x * cw - y * sw, y: c.y + x * sw + y * cw };
  }

  update(sim, dt) {
    if (this.rail) { this.opos = this.pos; this.pos = this.posAt(sim.now); return; }
    const a = angleOf(sub(this.pos, this.orbitCenter));
    const tangential = fromAngle(a + Math.PI / 2, this.speed); // constant linear velocity
    this.velocity = this.parent ? add(this.parent.velocity, tangential) : tangential;
    super.update(sim, dt);
  }
  postUpdate(sim, dt) {
    if (this.rail) { super.postUpdate(sim, dt); return; } // velocity from the step we just took
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

/**
 * A ring of rocks on rails. Positions are closed-form, so they cost nothing to simulate.
 * Every belt rolls its own character: how thick the field is, whether it is lumpy, how big
 * the rocks are, and whether it is denser in the middle.
 */
export class Belt {
  constructor(radius, width, omega, rng, fixed = {}) {
    this.radius = radius; this.width = width; this.omega = omega;
    this.spacing = fixed.spacing ?? rng.range(130, 520); // typical gap between rocks: small = dense field
    this.sizeScale = fixed.sizeScale ?? rng.range(0.6, 1.7);
    this.clumpy = fixed.clumpy ?? (rng() < 0.5 ? rng.range(0.3, 0.6) : 0); // share of rocks gathered in clumps
    this.peaked = fixed.peaked ?? rng() < 0.5; // denser toward the middle of the band
    this.maxSize = 46 * this.sizeScale;
    // always leave gaps to fly through, even inside the thickest clumps (which are denser than the rest)
    this.spacing = Math.max(this.spacing, (60 + 100 * this.sizeScale) * Math.sqrt(1 + 5 * this.clumpy));
    const count = fixed.count ?? clamp(Math.round((width * PI2 * radius) / (this.spacing * this.spacing)), 600, 28_000);
    this.count = count;
    this.label = `${this.spacing < 200 ? 'dense' : this.spacing < 340 ? 'medium' : 'sparse'}${this.clumpy ? ', clumpy' : ''}`;
    this.phase = new Float32Array(count);
    this.r = new Float32Array(count);
    this.size = new Float32Array(count);
    this.shape = new Uint8Array(count);
    this.gone = new Uint8Array(count); // knocked loose (now a free body in the debris field)
    this.wakes = []; // planets whose pull bends the belt as they pass (see Universe.setupBeltPhysics)
    this.maxWake = 0;
    this.libMax = 0;
    this.bins = Array.from({ length: BELT_BINS }, () => []);
    const clumps = Array.from({ length: rng.int(2, 7) }, () => ({ at: rng() * PI2, sd: rng.range(0.03, 0.14) }));
    const gauss = () => (rng() + rng() + rng() - 1.5) / 1.5; // roughly -1..1, bell-shaped
    for (let i = 0; i < count; i++) {
      let ph;
      if (fixed.phase) ph = fixed.phase(rng, gauss);
      else if (rng() < this.clumpy) { const c = clumps[rng.int(0, clumps.length)]; ph = c.at + gauss() * c.sd * 2; } else ph = rng() * PI2;
      ph = ((ph % PI2) + PI2) % PI2;
      this.phase[i] = ph;
      this.r[i] = radius + (this.peaked ? gauss() * 0.7 : (rng() - 0.5) * 2) * (width / 2);
      this.size[i] = (6 + 40 * rng() ** 3) * this.sizeScale;
      this.shape[i] = rng.int(0, 6);
      this.bins[Math.floor((ph / PI2) * BELT_BINS) % BELT_BINS].push(i);
    }
  }
  angle(i, now) {
    return this.lib ? this.phase[i] + this.omega * now + this.lib[i] * Math.sin(this.libW * now + this.libPh[i]) : this.phase[i] + this.omega * now;
  }

  /** Trojan swarms librate: each rock swings slowly back and forth about its Lagrange point. */
  setLibration(rng, amp, w) {
    this.lib = new Float32Array(this.count); this.libPh = new Float32Array(this.count);
    for (let i = 0; i < this.count; i++) { this.lib[i] = amp * rng() ** 1.5; this.libPh[i] = rng() * PI2; }
    this.libW = w; this.libMax = amp;
  }

  /** Refresh where each perturbing planet is (once per frame). */
  updateWakes() {
    for (const w of this.wakes) w.theta = Math.atan2(w.p.pos.y - (w.p.orbitCenter?.y ?? 0), w.p.pos.x - (w.p.orbitCenter?.x ?? 0));
  }

  /** Radius of rock i at angle a: its own orbit, bent toward any planet passing nearby. */
  rAt(i, a) {
    let r = this.r[i];
    for (const w of this.wakes) {
      let d = a - w.theta;
      d = Math.atan2(Math.sin(d), Math.cos(d));
      // the pull peaks a little behind the planet (the rocks need time to respond), so the bulge trails it
      const s = (d * this.radius + w.lag) / w.L;
      if (s > 4 || s < -4) continue;
      r += w.A * Math.exp(-s * s) * Math.sign(w.a - r) * Math.min(1, Math.abs(w.a - r) / (this.width * 0.5 + 1));
    }
    return r;
  }
}

/**
 * Artificial objects on rails. kind: 'orbiter' circles a planet, 'geostationary' circles at the
 * radius where it keeps pace with the planet's spin (so it hangs over one spot), 'probe' flies
 * between worlds (or out of the system). Ships can dock with a satellite by approaching slowly.
 */
export class Satellite {
  constructor({ name, kind, parent = null, orbit = 0, phase = 0, dir = 1, dest = null, speed = 0, outbound = false }) {
    this.name = name; this.kind = kind; this.parent = parent; this.orbit = orbit; this.dir = dir;
    this.angle = phase; this.dest = dest; this.speed = speed; this.outbound = outbound;
    this.radius = 7;
    this.cooldown = 0; // sim time until it can service a ship again
    this.pos = vec(); this.velocity = vec();
    this.omega = parent ? dir * keplerOmega(orbit, parent.mass) : 0;
    if (kind === 'geostationary') this.omega = parent.spin;
    if (parent) this.update(null, 0);
  }
  update(sim, dt) {
    if (this.cooldown > 0 && sim) this.cooldown -= dt;
    if (this.host) { // a station at a Lagrange point: 60 degrees ahead of (or behind) its world on the same orbit
      const now = sim ? sim.now : this.t0;
      const a = this.host.posAt(now + this.lag), b = this.host.posAt(now + this.lag + 0.05);
      this.pos = a; this.velocity = vec((b.x - a.x) / 0.05, (b.y - a.y) / 0.05);
      this.angle += 0.12 * dt;
      return;
    }
    if (this.parent) {
      this.angle += this.omega * dt;
      const p = this.parent;
      this.pos = add(p.pos, fromAngle(this.angle, this.orbit));
      this.velocity = add(p.velocity, fromAngle(this.angle + (this.omega >= 0 ? Math.PI / 2 : -Math.PI / 2), Math.abs(this.omega) * this.orbit));
      return;
    }
    // probe: coast in a straight line toward the destination, then pick another one
    this.pos = add(this.pos, mul(this.velocity, dt));
    if (this.outbound) {
      if (mag(this.pos) > UNIVERSE_RANGE * 0.97) { // out of the system: start over from the inside
        this.pos = fromAngle(this.angle, 15_000);
        this.velocity = fromAngle(this.angle, this.speed);
      }
    } else if (this.dest && sim && dist(this.pos, this.dest.pos) < this.dest.radius * 1.5 + 250) {
      const choices = sim.planets.filter((q) => !q.isMoon && q !== this.dest);
      this.dest = choices[Math.floor(sim.rng() * choices.length)] ?? this.dest;
      this.velocity = mul(sub(this.dest.pos, this.pos), this.speed / Math.max(1, dist(this.dest.pos, this.pos)));
    }
  }
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
    this.angle += (this.planet.spin ?? 0) * dt; // the surface turns beneath the parked ship
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
    this.heat = 0; // 0..1: reentry heating; at 1 the ship burns up
    this.surveyT = 0;
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
      // The engine always out-pulls the strongest planet or star around (by a third), so nothing but a
      // black hole can hold the ship down; away from heavy worlds it is the usual MAIN_ENGINE_ACCEL.
      const accel = Math.max(MAIN_ENGINE_ACCEL, 1.35 * (this.gLocal ?? 0));
      let deltaV = accel * dt * Math.min(1, thrustMag);
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
  constructor(seed, { shipModel = 'dart', system = null } = {}) {
    this.randomSeed = seed;
    this.rng = makeRng(seed);
    this.namer = new Namer();
    this.now = LAUNCH_MECO + 1; this.dt = 0; this.frameDt = 0; this._wall = 0; // (start past the launch-gravity-off window)
    this.timeScale = 1; // below 1 near a black hole
    this.warp = 1; // time warp: the simulation runs this many times faster (in substeps)
    this.tidal = 0; // 0..1 stress on the player's ship near a black hole
    this.planets = []; // planets first (sorted by orbit), then partners and moons
    this.anchors = []; // invisible barycentres of binary planets
    this.stars = []; // the star(s); the primary may be a black hole
    this.blackHoles = [];
    this.wells = []; // stars + black holes: sources of the big gravity wells
    this.belts = [];
    this.satellites = [];
    this.systemId = system; // 'sol' for our own solar system
    this.systemType = 'normal';
    this.sparks = [];
    this.landings = [];
    this.entities = []; // updaters (autopilots)
    this.ships = [];
    this.latestDiscovery = null;
    // Extras (off by default so the core stays 1:1): fuel and heat.
    this.fuel = { on: false, level: 100, capacity: 100, burn: 1.6, refuelRate: 10, heat: false };
    this.style = { fancy: true, warp: true, strict: true }; // trails, grid warp, speed-limited landings
    this.onLanded = null; // (planet, { rescue, first }) => void
    this.onConsumed = null; // (ship) => void; the player's ship was lost to a black hole
    this.onDestroyed = null; // (ship, { planet, speed }) => void; the player crashed
    this.onImpact = null; // ({ planet, speed, safe, damage }) => void; a hard (survivable) landing
    this.onServiced = null; // (satellite) => void; docked with a satellite
    this.debris = new DebrisField(this);
    if (system === 'sol') this.initSol(shipModel); else this.initRandom(shipModel);
    this.assignOrbits();
    this.setupBeltPhysics();
    const crng = makeRng((this.randomSeed ^ 0xc0e7) >>> 0);
    let comets = system === 'sol' ? 1 : crng() < 0.75 ? crng.int(1, 3) : 0;
    if (this.rare === 'young') comets += 4; // a young system is still full of icy leftovers
    this.debris.makeComets(comets, `C/${(this.star.name ?? 'Sol').split(/[ .]/)[0]}`);
  }

  /**
   * Elliptical orbits. Every rail body gets a Kepler ellipse. Random systems roll mostly gentle
   * eccentricities, capped so no world swings into its neighbours' lanes or out past the edge; our own
   * solar system uses the real values (Pluto's squeezed a little to stay inside the map).
   */
  assignOrbits() {
    const rng = makeRng((this.randomSeed ^ 0xecc0) >>> 0);
    const all = [...this.anchors, ...this.stars.filter((s) => s.speed), ...this.blackHoles.filter((b) => b.speed && !this.stars.includes(b)), ...this.planets];
    const theta = new Map(all.map((b) => [b, angleOf(sub(b.pos, b.orbitCenter))])); // before anything moves
    const tops = all.filter((b) => !b.parent && !this.stars.includes(b) && !b.isBlackHole);
    const lanes = [this.minOrbit * 0.7, ...tops.map((b) => b.orbitRadius), ...this.belts.flatMap((b) => [b.radius - b.width / 2, b.radius + b.width / 2])];
    const SOL_E = { Mercury: [0.206, 77], Venus: [0.007, 131], Earth: [0.017, 103], Mars: [0.093, 336], Jupiter: [0.049, 14], Saturn: [0.057, 93], Uranus: [0.046, 173], Neptune: [0.009, 48] };
    const done = new Set();
    const init = (b) => {
      if (done.has(b)) return;
      if (b.parent) init(b.parent); // parents first: a moon's rail is drawn round where its parent is
      done.add(b);
      let e = 0, varpi = rng() * PI2;
      if (tops.includes(b)) {
        if (this.systemId === 'sol') {
          const name = b.isAnchor ? 'Pluto' : b.name;
          const real = name === 'Pluto' ? [0.249, 224] : SOL_E[name];
          if (real) { e = real[0]; varpi = (real[1] * Math.PI) / 180; }
        } else e = rng() ** 2 * 0.24;
        const a = b.orbitRadius;
        const gap = Math.min(...lanes.filter((l) => Math.abs(l - a) > 1).map((l) => Math.abs(l - a)));
        e = Math.min(e, this.systemId === 'sol' ? 1 : (0.42 * gap) / a, (UNIVERSE_RANGE * 0.96) / a - 1);
        e = Math.max(0, e);
      }
      b.initRail(this.now, theta.get(b), e, varpi);
    };
    for (const b of all) init(b);
  }

  /**
   * Planets shape the belts. Big worlds clear resonance gaps (rocks whose period is a simple fraction
   * of the planet's get pumped out of line, like the Kirkwood gaps behind Jupiter), raise a travelling
   * bulge as they pass (the belt sags toward them), and giants herd trojan swarms 60 degrees ahead of
   * and behind themselves.
   */
  setupBeltPhysics() {
    const rng = makeRng((this.randomSeed ^ 0x4b17) >>> 0);
    const M = this.totalMass;
    const worlds = this.planets.filter((p) => !p.isMoon && !(p.parent && p.parent.isAnchor));
    const tops = [...this.planets.filter((p) => !p.isMoon && !(p.parent && !p.parent.isAnchor)).map((p) => (p.parent && p.parent.isAnchor ? p.parent : p))];
    const uniq = [...new Set(tops)];
    const massOf = (p) => (p.isAnchor ? this.planets.filter((q) => q.parent === p).reduce((s, q) => s + q.mass, 0) : p.mass);
    for (const belt of this.belts) {
      // resonance gaps from the heaviest world
      const heavy = uniq.slice().sort((a, b) => massOf(b) - massOf(a))[0];
      if (heavy) {
        const aP = heavy.orbitRadius, inside = belt.radius < aP;
        const ratios = inside ? [[2, 1], [3, 1], [5, 2], [7, 3], [3, 2], [5, 3]] : [[1, 2], [2, 3], [1, 3], [3, 5]];
        const hw = clamp(belt.width * 0.035 * Math.cbrt(massOf(heavy) / M) * 3, 90, 420);
        belt.gaps = [];
        for (const [j, k] of ratios) {
          const rr = aP * (k / j) ** (2 / 3);
          if (Math.abs(rr - belt.radius) > belt.width / 2 - hw) continue;
          belt.gaps.push(rr);
          for (let i = 0; i < belt.count; i++) {
            const d = belt.r[i] - rr;
            if (Math.abs(d) < hw && rng() < 0.92) belt.r[i] = rr + Math.sign(d || 1) * (hw + rng() * hw * 0.6);
          }
        }
      }
      // travelling bulges from the nearest heavy neighbours
      const cands = uniq.map((p) => {
        const da = Math.abs(p.orbitRadius - belt.radius);
        return { p, da, k: Math.cbrt(massOf(p) / (3 * M)) * p.orbitRadius / Math.max(da, 1) };
      }).sort((a, b) => b.k - a.k).slice(0, 2);
      for (const c of cands) {
        if (c.k < 0.25) continue;
        const A = Math.min(belt.width * 0.45, belt.width * 0.24 * c.k);
        const L = clamp(c.da * 0.7, 2500, 16_000);
        belt.wakes.push({ p: c.p, a: c.p.orbitRadius, A, L, lag: L * 0.35 * (c.p.orbitRadius < belt.radius ? 1 : -1), theta: 0 });
        belt.maxWake += A;
      }
    }
    // trojan swarms around the giants (not in our own solar system: Jupiter's are too small to see here)
    if (this.systemId !== 'sol') {
      for (const p of worlds) {
        if (p.radius < 1100 || p.parent || rng() > 0.6 || (p.rail?.e ?? 0) > 0.06) continue; // (trojans need a near-circular orbit)
        const theta0 = angleOf(sub(p.pos, p.orbitCenter)), omega = p.speed / p.orbitRadius, now0 = this.now;
        const width = clamp(p.hill * 0.08, 1200, 4500);
        const belt = new Belt(p.orbitRadius, width, omega, rng, {
          spacing: 260, sizeScale: rng.range(0.6, 1.1), clumpy: 0, peaked: true,
          count: rng.int(260, 520),
          phase: (r, gauss) => theta0 - omega * now0 + (r() < 0.5 ? 1 : -1) * Math.PI / 3 + gauss() * 0.16,
        });
        belt.setLibration(rng, 0.22, rng.range(0.004, 0.009));
        belt.trojan = p;
        belt.label = `trojans of ${p.name}`;
        this.belts.push(belt);
      }
    }    for (const b of this.belts) b.updateWakes();
    this.makeStations(rng);
  }

  /** Trading stations at L4/L5: refuel, repair, buy ore. One per trojan host, or one at the biggest world. */
  makeStations(rng) {
    const hosts = this.belts.filter((b) => b.trojan).map((b) => b.trojan);
    if (!hosts.length) {
      const big = this.planets.filter((p) => !p.parent && p.rail && p.rail.e < 0.12).sort((a, b) => b.mass - a.mass)[0];
      if (big) hosts.push(big);
    }
    for (const h of hosts) {
      const P = PI2 / h.rail.n, lead = rng() < 0.5 ? 1 : -1;
      const st = new Satellite({ name: `${h.name} ${lead > 0 ? 'L4' : 'L5'} Station`, kind: 'station' });
      st.host = h; st.lag = (lead * P) / 6; st.t0 = this.now;
      st.radius = 26; st.dockR = 95; st.isStation = true;
      st.update(null, 0);
      this.satellites.push(st);
    }
    this.stations = this.satellites.filter((s) => s.isStation);
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
    this.profile = this.makeProfile();
    for (const p of parents) p.ringMul = this.profile.ringMul;
    const remap = this.makeSystemType(parents, systemName);
    this.makeRare();
    ship.pos = fromAngle(shipAngle, remap(shipOrbit));

    const pairs = this.makeBinaryPlanets(parents);
    this.planets = [...parents, ...pairs, ...this.makeMoons(parents)];
    this.belts = this.makeBelts(parents);
    if (this.rare === 'young') this.addDebrisDisk(parents);
    ship.pos = this.outsideBelts(ship.pos);
    this.wells = [...this.stars, ...this.blackHoles.filter((b) => !this.stars.includes(b))];
    this._bodies = [...this.planets, ...this.wells];
    const prng = makeRng((this.randomSeed ^ 0xa7305) >>> 0);
    for (const p of this.planets) rollPhysics(p, prng);
    paintByClimate(this);
    this.computeHillSpheres();
    this.satellites = this.makeSatellites();
    this.spawnAI();
  }

  /**
   * Planets ride rails, so they never feel each other's pull while ships do. Near a planet that
   * shows up as constant nudges from Jupiter and friends that no real orbit would suffer (the star's
   * own pull is already matched by the rail speeds). Inside a planet's Hill sphere we work in the
   * planet's frame: subtract the field everything else makes at the planet, add back what the rail
   * really accelerates it at, and fade that out toward the edge of the sphere.
   */
  computeHillSpheres() {
    for (const p of this.planets) {
      const group = p.parent && p.parent.isAnchor;
      const a = group ? p.parent.orbitRadius : p.orbitRadius;
      const central = group || !p.parent ? this.totalMass : p.parent.mass;
      const m = group && p.binary ? p.mass + p.binary.mass : p.mass;
      p.hill = a * Math.cbrt(m / (3 * central));
    }
  }

  /** Acceleration of each rail body (centripetal, plus its parent's), refreshed every step. */
  updateRailAccelerations() {
    const centripetal = (p) => {
      if (!p.speed) return vec();
      const c = p.orbitCenter, d = dist(c, p.pos) || 1;
      if (p.rail) { // inverse square toward the focus; mu = n^2 a^3 (equal to v^2/r on a circle)
        const mu = p.rail.n * p.rail.n * p.orbitRadius ** 3;
        return mul(sub(c, p.pos), mu / (d * d * d));
      }
      return mul(sub(c, p.pos), (p.speed * p.speed) / (d * d));
    };
    for (const a of this.anchors) a.acc = centripetal(a);
    for (const p of this.planets) p.acc = p.parent ? add(p.parent.acc ?? vec(), centripetal(p)) : centripetal(p);
  }

  /** What to subtract from a ship's acceleration at `pos` (null outside every Hill sphere). */
  frameAcceleration(pos) {
    let best = null, bestHill = Infinity;
    for (const p of this.planets) {
      if (p.hill >= bestHill) continue;
      if (Math.hypot(pos.x - p.pos.x, pos.y - p.pos.y) < p.hill * 1.2) { best = p; bestHill = p.hill; }
    }
    if (!best) return null;
    const d = Math.hypot(pos.x - best.pos.x, pos.y - best.pos.y);
    const w = d < best.hill * 0.9 ? 1 : clamp(1 - (d - best.hill * 0.9) / (best.hill * 0.3), 0, 1);
    let ax = 0, ay = 0;
    for (const b of this._bodies) {
      if (b === best) continue;
      const dx = b.pos.x - best.pos.x, dy = b.pos.y - best.pos.y, r2 = dx * dx + dy * dy;
      if (r2 < 1) continue;
      const g = (GRAVITATION * SPACECRAFT_MASS * b.mass) / r2, r = Math.sqrt(r2);
      ax += (dx / r) * g; ay += (dy / r) * g;
    }
    const rail = best.acc ?? vec();
    return vec((ax - rail.x) * w, (ay - rail.y) * w);
  }

  /** Our own solar system, hand-made (see sol.js). */
  initSol(shipModel) {
    const rng = this.rng;
    const star = new Star(SOL.star.cls, SOL.star.radius);
    star.name = 'Sol';
    this.star = star; this.stars = [star]; this.totalMass = star.mass;
    this.systemType = 'sol';
    this.profile = { name: 'ordinary', moonChance: 1, ringMul: 1, beltChance: 1, pairChance: 0, satChance: 0.3, ai: [3, 3] };
    this.minOrbit = 14_000;

    const give = (p, spec) => {
      p.name = spec.name; p.description = spec.description; p.atmosphere = spec.atmosphere;
      p.fauna = spec.fauna; p.flora = spec.flora; p.spec = spec.spec; p.haze = spec.haze;
      p.spin = spec.spin ?? 0.03;
      p.isMoon = !!p.parent;
      if (spec.gas) { p.gas = true; p.collides = false; p.atmo = makeAtmosphere(0.35, spec.R * 0.1); }
      else if (spec.atmo) p.atmo = makeAtmosphere(spec.atmo[0], spec.atmo[1]);
    };
    const parents = [], moons = [], partners = [];
    for (const spec of SOL.planets) {
      const phase = rng() * PI2;
      const p = new Planet(star.pos, spec.R, add(star.pos, fromAngle(phase, spec.orbit)), keplerSpeed(spec.orbit, star.mass), spec.color);
      give(p, spec);
      p.beltOrbit = spec.orbit;
      if (spec.geo) p.spin = keplerOmega(p.radius * spec.geo, p.mass); // geostationary radius fixes the day
      parents.push(p);
      for (const m of spec.moons ?? []) {
        const mm = new Planet(p.pos, m.R, add(p.pos, fromAngle(rng() * PI2, m.orbit)), keplerSpeed(m.orbit, p.mass), m.color, p);
        give(mm, m);
        moons.push(mm);
      }
      if (spec.pair) { // Pluto and Charon: two worlds circling a point that circles the Sun
        const q = spec.pair, r2 = q.R, m1 = p.mass, m2 = (4 / 3) * Math.PI * r2 ** 3 * PLANETARY_DENSITY;
        const omega = keplerOmega(q.sep, m1 + m2), d1 = (q.sep * m2) / (m1 + m2), d2 = (q.sep * m1) / (m1 + m2), ph = rng() * PI2;
        const anchor = new Planet(star.pos, 0, p.pos, p.speed);
        anchor.mass = 0; anchor.isAnchor = true; anchor.orbitRadius = p.orbitRadius;
        this.anchors.push(anchor);
        p.parent = anchor; p.isMoon = false; p.orbitRadius = d1; p.speed = omega * d1; p.pos = p.opos = add(anchor.pos, fromAngle(ph, d1));
        const c = new Planet(anchor.pos, r2, add(anchor.pos, fromAngle(ph + Math.PI, d2)), omega * d2, q.color, anchor);
        give(c, q); c.isMoon = false; c.parent = anchor;
        p.binary = c; c.binary = p;
        partners.push(c);
      }
    }
    this.planets = [...parents, ...partners, ...moons];
    const byName = (n) => this.planets.find((p) => p.name === n);

    const ship = new Spacecraft(makeDesign(shipModel));
    ship.name = 'You';
    const earth = byName('Earth');
    const alt = 330, r = earth.radius + alt; // a low parking orbit
    const orbitV = Math.sqrt((GRAVITATION * SPACECRAFT_MASS * earth.mass) / r);
    const ea = angleOf(sub(earth.pos, star.pos));
    ship.pos = ship.opos = add(earth.pos, fromAngle(ea, r));
    ship.velocity = add(fromAngle(ea + Math.PI / 2, earth.speed), fromAngle(ea + Math.PI / 2, orbitV)); // a circular parking orbit
    ship.angle = ea + Math.PI / 2;
    this.ship = ship; this.follow = ship; this.ships.push(ship);

    this.belts = SOL.belts.map((b) => new Belt(b.radius, b.width, keplerOmega(b.radius, star.mass), rng, b.fixed));
    this.wells = [star];
    this._bodies = [...this.planets, star];

    for (const s of SOL.satellites) {
      let sat;
      if (s.kind === 'probe') {
        sat = new Satellite({ name: s.name, kind: 'probe', outbound: !!s.outbound, speed: s.speed, phase: s.angle ?? 0, dest: s.dest ? byName(s.dest) : null });
        if (s.outbound) { sat.pos = fromAngle(s.angle, 20_000 + rng() * 30_000); sat.velocity = fromAngle(s.angle, s.speed); }
        else { const from = byName(s.from); sat.pos = add(from.pos, fromAngle(1, from.radius + 200)); sat.velocity = mul(sub(sat.dest.pos, sat.pos), s.speed / dist(sat.dest.pos, sat.pos)); }
      } else {
        const p = byName(s.at), top = p.atmo ? p.atmo.top : 0;
        const orbit = s.kind === 'geostationary' ? p.radius * SOL.planets.find((q) => q.name === s.at).geo : p.radius + Math.max(s.alt, top + 60);
        sat = new Satellite({ name: s.name, kind: s.kind, parent: p, orbit, phase: s.phase });
      }
      this.satellites.push(sat);
    }
    this.computeHillSpheres();
    this.spawnAI();
  }

  /** Artificial objects: orbiters, geostationary relays and probes heading somewhere. */
  makeSatellites() {
    const chance = this.profile.satChance;
    if (!chance) return [];
    const rng = makeRng((this.randomSeed ^ 0x5a7e111) >>> 0);
    const sats = [];
    const name = () => `${rng.choose(['Relay', 'Beacon', 'Watcher', 'Survey', 'Link'])}-${rng.int(2, 99)}`;
    for (const p of this.planets) {
      if (p.radius < 100 || rng() > chance) continue;
      const count = rng.int(1, 4);
      const top = p.atmo ? p.atmo.top : 0;
      const geoR = Math.max(p.radius + top + 120, p.radius * rng.range(1.5, 2.1));
      let geo = false;
      for (let k = 0; k < count; k++) {
        if (p.atmo && !p.gas && !geo && rng() < 0.35) { // park one over a fixed spot of this world
          geo = true;
          p.spin = keplerOmega(geoR, p.mass) * (p.spin < 0 ? -1 : 1);
          sats.push(new Satellite({ name: name(), kind: 'geostationary', parent: p, orbit: geoR, phase: rng() * PI2 }));
          continue;
        }
        const orbit = p.radius + top + rng.range(70, p.gas ? p.radius * 0.6 : Math.max(120, p.radius * 0.9));
        sats.push(new Satellite({ name: name(), kind: 'orbiter', parent: p, orbit, phase: rng() * PI2, dir: rng() < 0.2 ? -1 : 1 }));
      }
    }
    const worlds = this.planets.filter((q) => !q.isMoon);
    for (let k = rng.int(0, 3); k > 0 && worlds.length; k--) {
      const start = this.safeSpot(rng), speed = rng.range(350, 900);
      if (rng() < 0.35) {
        const a = angleOf(start);
        sats.push(new Satellite({ name: `Probe-${rng.int(2, 99)}`, kind: 'probe', outbound: true, speed, phase: a }));
        sats[sats.length - 1].pos = start; sats[sats.length - 1].velocity = fromAngle(a, speed);
      } else {
        const dest = rng.choose(worlds), sat = new Satellite({ name: `Probe-${rng.int(2, 99)}`, kind: 'probe', dest, speed });
        sat.pos = start; sat.velocity = mul(sub(dest.pos, start), speed / Math.max(1, dist(dest.pos, start)));
        sats.push(sat);
      }
    }
    return sats;
  }

  /** Each system has a character, so not every feature shows up in every system. */
  makeProfile() {
    const rng = makeRng((this.randomSeed ^ 0x9f0f11e) >>> 0);
    const kinds = [
      [20, { name: 'barren', moonChance: 0.25, ringMul: 0.3, beltChance: 0.2, pairChance: 0.15, satChance: 0.1, ai: [0, 2] }],
      [40, { name: 'ordinary', moonChance: 0.75, ringMul: 1, beltChance: 0.6, pairChance: 0.35, satChance: 0.3, ai: [2, 4] }],
      [20, { name: 'crowded', moonChance: 1, ringMul: 1.4, beltChance: 0.9, pairChance: 0.5, satChance: 0.6, ai: [3, 6] }],
      [20, { name: 'deserted', moonChance: 0.5, ringMul: 0.6, beltChance: 0.5, pairChance: 0.3, satChance: 0, ai: [0, 0] }],
    ];
    let x = rng() * 100;
    for (const [w, k] of kinds) { x -= w; if (x < 0) return k; }
    return kinds[1][1];
  }

  /**
   * Rare systems (own random stream, so ordinary systems are unchanged): a pulsar, whose two radio
   * beams sweep round and scorch anything they cross; a brown dwarf, too dim to warm anything; or a
   * young system still wrapped in a dense debris disk and swarming with comets.
   */
  makeRare() {
    this.rare = null;
    if (this.systemType === 'blackhole') return;
    const rng = makeRng((this.randomSeed ^ 0x7a7e) >>> 0);
    const roll = rng(), s = this.star;
    if (roll < 0.07) {
      this.rare = 'pulsar';
      s.cls = 'N'; s.color = STAR_COLORS.N; s.radius = 520;
      s.pulsar = { period: rng.range(4, 9), phase: rng() * PI2, reach: 75_000 };
      s.name = `${s.name} Pulsar`;
    } else if (roll < 0.14) {
      this.rare = 'dwarf';
      s.cls = 'D'; s.color = STAR_COLORS.D; s.radius *= 0.45;
    } else if (roll < 0.22) {
      this.rare = 'young';
    }
  }

  /** A pulsar beam's angle right now (there are two, opposite). */
  beamAngle(s) { return s.pulsar.phase + (PI2 * this.now) / s.pulsar.period; }

  /** Is `pos` inside a pulsar beam? Returns its strength 0..1. */
  inBeam(pos) {
    for (const s of this.stars) {
      if (!s.pulsar) continue;
      const dx = pos.x - s.pos.x, dy = pos.y - s.pos.y, d = Math.hypot(dx, dy);
      if (d > s.pulsar.reach || d < s.radius) continue;
      const off = Math.atan2(dy, dx) - this.beamAngle(s);
      const k = Math.abs(Math.sin(off)); // distance from either beam (they point both ways)
      const width = 0.035 + 300 / d;
      if (k < width) return (1 - k / width) * (1 - d / s.pulsar.reach);
    }
    return 0;
  }

  /** A young system's dense debris disk in its widest gap. */
  addDebrisDisk(parents) {
    const rng = makeRng((this.randomSeed ^ 0xd15c) >>> 0);
    const edges = [this.minOrbit, ...parents.map((p) => p.orbitRadius).sort((a, b) => a - b), PLANET_ORBIT_RANGE[1] + 10_000];
    let best = null;
    for (let i = 0; i + 1 < edges.length; i++) {
      const gap = edges[i + 1] - edges[i];
      if (gap > 12_000 && !this.belts.some((b) => b.radius > edges[i] && b.radius < edges[i + 1]) && (!best || gap > best[1] - best[0])) best = [edges[i], edges[i + 1]];
    }
    if (!best) return;
    const radius = (best[0] + best[1]) / 2, width = Math.min((best[1] - best[0]) * 0.6, 14_000);
    const omega = PI2 / (Math.sqrt(radius ** 3 / this.totalMass) * KEPLER_CONSTANT);
    const disk = new Belt(radius, width, omega, rng, { spacing: 150, sizeScale: 0.8, clumpy: 0.5, peaked: true });
    disk.label = 'debris disk';
    this.belts.push(disk);
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
    const want = rng() < this.profile.pairChance ? rng.int(1, 3) : 0;
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
      const roll = Math.min(3, rng.int(0, 2 + Math.floor(parent.radius / 600)));
      const count = rng() < this.profile.moonChance ? roll : 0;
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
    const want = rng() < this.profile.beltChance ? rng.int(1, 3) : 0;
    for (let i = 0; i < want && gaps.length; i++) {
      const [lo, hi] = gaps.splice(rng.int(0, gaps.length), 1)[0];
      const gap = hi - lo;
      const radius = (lo + hi) / 2 + (rng() - 0.5) * gap * 0.1;
      const width = Math.min(gap * 0.45, rng.range(3000, 7000));
      const omega = PI2 / (Math.sqrt(radius ** 3 / this.totalMass) * KEPLER_CONSTANT);
      belts.push(new Belt(radius, width, omega, rng));
    }
    return belts;
  }

  spawnAI() {
    const rng = makeRng((this.randomSeed ^ 0xa11ce) >>> 0);
    this.aiRng = rng;
    const n = rng.int(this.profile.ai[0], this.profile.ai[1] + 1);
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

  /** Nudge a point out of any belt (nobody should spawn inside a rock field). */
  outsideBelts(pos) {
    const r = mag(pos);
    for (const b of this.belts) {
      if (Math.abs(r - b.radius) < b.width / 2 + 600) return fromAngle(angleOf(pos), b.radius + b.width / 2 + 900);
    }
    return pos;
  }

  /** A random point in the orbit band that is not near a black hole. */
  safeSpot(rng) {
    for (let i = 0; i < 20; i++) {
      const p = fromAngle(rng() * PI2, rng.range(this.minOrbit, PLANET_ORBIT_RANGE[1]));
      if (this.blackHoles.every((b) => dist(b.pos, p) > b.radius * 30)) return this.outsideBelts(p);
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
    if (!player) {
      if (ship.isWing && this.onWingLanded) this.onWingLanded(ship, planet); // your wingman charts for you
      return;
    }
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
    if (ship.distress) { ship.distress = null; ship.autopilot.enabled = true; }
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
    // time warp runs extra substeps; each one stays short so orbits and collisions remain exact
    const total = raw * this.timeScale * this.warp; // slow motion near a black hole
    const n = Math.max(1, Math.ceil(total / (1 / 45)));
    for (let k = 0; k < n; k++) this.advance(total / n);
    for (const b of this.belts) b.updateWakes();
    this.updateBlackHoleEffects(raw);
    return true;
  }

  advance(dt) {
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
    this.updateRailAccelerations();
    for (const s of this.ships) {
      if (s.consumed) continue;
      s.transit = false;
      s.gLocal = 0; // the strongest pull on the ship right now (black holes excepted): the engine scales to beat it
      const frame = this.now > s.launchClock + LAUNCH_MECO ? this.frameAcceleration(s.pos) : null;
      if (frame) s.velocity = sub(s.velocity, mul(frame, dt));
      for (const body of this._bodies) {
        const vector = sub(body.pos, s.pos);
        const d = mag(vector);
        if (d < body.radius) {
          if (body.isBlackHole) { this.consume(s, body); break; }
          if (!body.parent && this.stars.includes(body)) s.transit = true;
        } else if (this.now > s.launchClock + LAUNCH_MECO) {
          const g = (GRAVITATION * s.mass * body.mass) / (d * d);
          s.velocity = add(s.velocity, mul(fromAngle(angleOf(vector), g), dt));
          if (!body.isBlackHole && g > s.gLocal) s.gLocal = g;
        }
      }
    }
    for (const s of this.ships) if (!s.consumed) this.atmosphere(s, dt);
    this.events?.update(dt);
    if (!ship.consumed && !ship.landing) this.scanGiants(ship, dt);
    if (this.rare === 'pulsar' && !ship.consumed && !ship.landing) {
      const b = this.inBeam(ship.pos);
      ship.beam = b;
      if (b > 0) { ship.heat = Math.min(1, ship.heat + b * 1.6 * dt); if (this.onBeam) this.onBeam(b, dt); }
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

    for (const sat of this.satellites) sat.update(this, dt);
    this.debris.update(dt);
    this.sparks = this.sparks.filter((s) => !s.dead);
    this.landings = this.landings.filter((l) => !l.dead);
  }

  /**
   * Air resistance and reentry heating. Drag grows with density (which rises steeply toward the
   * surface) and with the square of the speed relative to the rotating air; heating grows with
   * the cube. Gas giants have no surface: the air just keeps getting thicker until you burn up.
   */
  atmosphere(ship, dt) {
    let heatRate = 0;
    ship.atmoRho = 0;
    for (const p of this.planets) {
      const a = p.atmo;
      if (!a) continue;
      const dx = ship.pos.x - p.pos.x, dy = ship.pos.y - p.pos.y, d = Math.hypot(dx, dy) || 1;
      const alt = d - p.radius;
      if (alt > a.top) continue;
      if (p.gas && alt < -p.radius * 0.5) { this.destroyShip(ship, p, mag(ship.velocity), 'crushed'); return; }
      if (ship.landing) { ship.heat = 0; continue; }
      const rho = a.rho0 * Math.exp(-alt / a.H);
      const spin = (p.spin ?? 0) * d; // the air turns with the planet
      const wind = add(p.velocity, vec((-dy / d) * spin, (dx / d) * spin));
      const rel = sub(ship.velocity, wind), v = mag(rel);
      if (v > 1e-6) {
        const decel = Math.min(DRAG_COEFF * rho * v * v * dt, v);
        ship.velocity = sub(ship.velocity, mul(rel, decel / v));
      }
      heatRate = Math.max(heatRate, HEAT_COEFF * rho * v ** 3);
      ship.atmoRho = rho; ship.atmoPlanet = p;
      // a gas giant survey: skim its upper air for a moment
      if (p.gas && !ship.isAI && alt < a.top * 0.9 && ship.heat < 0.6) {
        ship.surveyT += dt;
        if (ship.surveyT > 0.4 && !p.explored) this.survey(p);
      } else if (p.gas) ship.surveyT = 0;
    }
    const over = Math.max(0, heatRate - HEAT_SAFE);
    ship.heat = clamp(ship.heat + (over * 0.8 - (over > 0 ? 0 : 0.25)) * dt, 0, 1);
    ship.heatRate = heatRate;
    if (ship.heat >= 1) this.destroyShip(ship, ship.atmoPlanet ?? this.planets[0], mag(ship.velocity), 'burned up');
  }

  /**
   * Scan range: passing low over a gas giant's clouds (within half a radius of the cloud tops) for a
   * moment charts it, so even giants too heavy to dip into can be mapped with a close swing past.
   */
  scanGiants(ship, dt) {
    for (const p of this.planets) {
      if (!p.gas || p.explored) continue;
      const alt = dist(ship.pos, p.pos) - p.radius;
      // (binary giants are scanned from further out: their partner leaves no room to swing in close)
      if (alt < p.atmo.top + p.radius * (p.binary ? 1.15 : 0.5)) {
        p.scanT = (p.scanT ?? 0) + dt;
        if (p.scanT > 0.6) this.survey(p);
      } else p.scanT = 0;
    }
  }

  // a gas giant has no surface to land on: flying through its upper air counts as visiting
  survey(planet) {
    planet.explored = true;
    this.latestDiscovery = planet;
    if (this.onLanded) this.onLanded(planet, { rescue: false, first: true, survey: true });
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
            // Landing needs the nose pointing away from the ground (within 45 degrees; no angle
            // wrap, same as the original) and, in strict mode, a low enough speed relative to the
            // planet. Too fast: you bounce and take damage; much too fast: the ship is destroyed.
            const vRel = mag(sub(ship.velocity, planet.velocity));
            const safe = landingSpeedLimit(planet);
            const strict = this.style.strict;
            const headingOk = Math.abs(ship.angle - a) < Math.PI / 4;
            if (strict && vRel > safe * 4 + 400) {
              this.destroyShip(ship, planet, vRel);
            } else if (headingOk && (!strict || vRel <= safe)) {
              this.beginLanding(ship, planet, a);
            } else {
              const impact = add(planet.pos, fromAngle(a, planet.radius));
              ship.pos = add(planet.pos, fromAngle(a, planet.radius + ship.radius - d));
              if (strict && vRel > safe && ship.hitCooldown <= 0) this.hardImpact(ship, planet, vRel, safe);
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
      this.collideBelts(ship, dt);
      this.debris.collideShip(ship, dt);
      this.dockWithSatellites(ship, dt);
    }
    for (const l of this.landings) l.solve(this, dt);
    // ringfence
    for (const ship of this.ships) {
      if (mag(ship.pos) + ship.radius > UNIVERSE_RANGE) {
        ship.pos = fromAngle(angleOf(ship.pos), UNIVERSE_RANGE - ship.radius);
      }
    }
  }

  // a hard but survivable landing: bounce, shake, and (player, survival mode) lose some fuel
  hardImpact(ship, planet, speed, safe) {
    ship.hitCooldown = 0.6;
    const damage = Math.min(12, (speed - safe) / 80);
    if (!ship.isAI && this.fuel.on) this.fuel.level = Math.max(0, this.fuel.level - damage);
    if (!ship.isAI && this.onImpact) this.onImpact({ planet, speed, safe, damage });
  }

  destroyShip(ship, planet, speed, reason = 'crashed') {
    ship.heat = 0;
    const at = ship.pos;
    for (let k = 0; k < 30 && this.sparks.length < MAX_SPARKS; k++) {
      const s = new Spark({ ttl: this.rng.range(0.6, 2.2), style: 'dot', color: '#ffb060', size: 1.5 });
      s.pos = s.opos = at;
      s.velocity = add(planet.velocity, fromAngle(this.rng.range(0, PI2), this.rng.range(50, 500)));
      this.sparks.push(s);
    }
    if (ship.isAI) this.respawnAI(ship);
    else if (this.onDestroyed) this.onDestroyed(ship, { planet, speed, reason });
    else ship.velocity = vec();
  }

  // Approach a satellite slowly to dock (refuel + credits, then it needs a while to recharge);
  // hit one fast and you just bounce off.
  dockWithSatellites(ship, dt) {
    if (ship.landing) return;
    for (const sat of this.satellites) {
      const dx = ship.pos.x - sat.pos.x, dy = ship.pos.y - sat.pos.y;
      const reach = sat.dockR ?? 45;
      if (Math.abs(dx) > reach + 80 || Math.abs(dy) > reach + 80) continue;
      const d = Math.hypot(dx, dy), rel = mag(sub(ship.velocity, sat.velocity));
      if (d < reach && rel < 90 && sat.cooldown <= 0 && !ship.isAI) {
        sat.cooldown = sat.isStation ? 40 : 90;
        if (this.fuel.on) this.fuel.level = Math.min(this.fuel.capacity, this.fuel.level + 15);
        if (this.onServiced) this.onServiced(sat);
      } else if (d < sat.radius + ship.radius && rel >= 90) {
        const n = d || 1, nx = dx / n, ny = dy / n;
        ship.pos = vec(sat.pos.x + nx * (sat.radius + ship.radius), sat.pos.y + ny * (sat.radius + ship.radius));
        const rv = sub(ship.velocity, sat.velocity), into = rv.x * nx + rv.y * ny; // bounce, softly
        if (into < 0 && dt > 0) ship.opos = sub(ship.pos, mul(add(sat.velocity, sub(rv, mul(vec(nx, ny), 1.4 * into))), dt));
      }
    }
  }

  /** Call fn(x, y, size, belt, index) for every belt rock within `range` of `pos`. */
  forRocksNear(pos, range, fn) {
    if (!this.belts.length) return;
    const rs = mag(pos);
    for (const belt of this.belts) {
      if (Math.abs(rs - belt.radius) > belt.width / 2 + range + belt.maxSize + belt.maxWake) continue;
      const local = (((angleOf(pos) - belt.omega * this.now) % PI2) + PI2) % PI2;
      const margin = (range + belt.maxSize) / Math.max(rs, 1) + belt.libMax;
      const b0 = Math.floor(((local - margin) / PI2) * BELT_BINS);
      const b1 = Math.floor(((local + margin) / PI2) * BELT_BINS);
      for (let b = b0; b <= b1; b++) {
        for (const i of belt.bins[((b % BELT_BINS) + BELT_BINS) % BELT_BINS]) {
          if (belt.gone[i]) continue;
          const a = belt.angle(i, this.now), r = belt.rAt(i, a);
          fn(Math.cos(a) * r, Math.sin(a) * r, belt.size[i], belt, i);
        }
      }
    }
  }

  // Rocks are pushed out of the way and the ship bounces off them (so it never gets glued to one).
  collideBelts(ship, dt) {
    if (ship.landing || !this.belts.length) return;
    this.forRocksNear(ship.pos, ship.radius + 12, (rx, ry, size, belt, i) => {
      const dx = ship.pos.x - rx, dy = ship.pos.y - ry;
      const need = size + ship.radius;
      const d2 = dx * dx + dy * dy;
      if (d2 >= need * need) return;
      const d = Math.sqrt(d2) || 1;
      const nx = dx / d, ny = dy / d;
      if (!ship.isAI && this.onMine) { // a slow touch: scoop the rock into the hold
        const a0 = belt.angle(i, this.now), sp0 = belt.omega * belt.r[i];
        const rv = sub(ship.velocity, vec(-Math.sin(a0) * sp0, Math.cos(a0) * sp0));
        if (mag(rv) < 75 && this.onMine(size, vec(rx, ry))) { belt.gone[i] = 1; return; }
      }
      ship.pos = vec(rx + nx * need, ry + ny * need);
      // bounce: reflect the velocity relative to the rock (restitution 0.4), then re-encode it in
      // opos because velocities are rebuilt from positions after the constraints
      const a = belt.angle(i, this.now), spin = belt.omega * belt.r[i];
      const rock = vec(-Math.sin(a) * spin, Math.cos(a) * spin);
      const rel = sub(ship.velocity, rock);
      const into = rel.x * nx + rel.y * ny;
      if (into < 0 && dt > 0) {
        const v = add(rock, sub(rel, mul(vec(nx, ny), 1.4 * into)));
        ship.opos = sub(ship.pos, mul(v, dt));
        // a solid knock sends the rock tumbling out of the belt as a free body
        if (into < -70 && !ship.isAI) {
          belt.gone[i] = 1;
          const kick = mul(vec(-nx, -ny), -into * 0.75);
          this.debris.spawnRock(vec(rx, ry), add(rock, add(kick, fromAngle(this.rng() * PI2, 15))), size, belt.shape[i]);
          if (this.onRockHit) this.onRockHit(-into, vec(rx, ry));
        }
      }
      if (ship.hitCooldown > 0) return;
      ship.hitCooldown = 0.4;
      if (!ship.isAI && this.fuel.on) this.fuel.level = Math.max(0, this.fuel.level - 1);
      for (let k = 0; k < 5 && this.sparks.length < MAX_SPARKS; k++) {
        const s = new Spark({ ttl: this.rng.range(0.4, 1.2), style: 'dot', color: '#fff', size: 1 });
        s.pos = s.opos = vec(rx + nx * size, ry + ny * size);
        s.velocity = add(mul(ship.velocity, 0.5), fromAngle(this.rng.range(0, PI2), this.rng.range(20, 80)));
        this.sparks.push(s);
      }
    });
  }
}
