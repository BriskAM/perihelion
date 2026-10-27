import {
  vec, sub, mag, dot, dist, angleOf, fromAngle, add, mul, expSmooth, clamp, PI2,
} from './maths.js';
import {
  MAIN_ENGINE_ACCEL, CRAFT_SPEED_LIMIT, GRAVITATION, SPACECRAFT_MASS, landingSpeedLimit,
} from './universe.js';
import { densityAt, heatSafeSpeed, DRAG_COEFF } from './planets.js';
import { conic } from './predict.js';
import { PERSONALITIES } from './personalities.js';

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
    this.persona = PERSONALITIES.balanced; // how it likes to fly (see personalities.js)
    this.hold = 0;
    this.desiredAngle = null;
    this.landingAltitude = 0;
    this.nextStrategyTime = 0;
    this.brakingDistance = 0;
    this.leadingPos = vec();
    this.strategy = 'NONE';
    this.debug = '';
    this.history = new Map(); // world -> { t, n }: when we were last there and how often
    this.recent = []; // the last few worlds visited, never picked again straight away
    this.wandering = false; // nothing new left in reach: touring instead of charting
    this.via = null; // a gravity assist planned on the way to the target
    this.tour = false; // orbit the target for a while instead of landing
    this.onEvent = null; // ({ kind: 'assist' | 'tour', ... }) => void
  }

  /** What the camera should look at: the slingshot world while one is under way, else the target. */
  get focus() { return this.via?.body ?? this.target; }

  remember(p) {
    const h = this.history.get(p) ?? { t: 0, n: 0 };
    this.history.set(p, { t: this.universe.now, n: h.n + 1 });
    this.recent.push(p);
    if (this.recent.length > 3) this.recent.shift();
  }

  get turn() { return TURN_RATE * this.pace; }
  get landTurn() { return LANDING_TURN_RATE * this.pace; }

  get telemetry() {
    if (!this.enabled) return '';
    const lock = this.strategy === 'ACQUIRING' ? ` ${Math.round(this.lock * 100)}%` : '';
    return [
      '---- AUTOPILOT ENGAGED ----',
      'TGT: ' + (this.target ? this.target.name.toUpperCase() + (this.service ? ` (${this.target.kind === 'distress' ? 'RESCUE' : this.target.kind === 'station' ? 'DOCK' : 'RENDEZVOUS'})` : this.uncharted ? ' (UNCHARTED)' : this.tour ? ' (ORBIT TOUR)' : this.scanPass ? ' (SCAN PASS)' : this.relay ? ' (RELAY)' : this.wandering ? ' (REVISIT)' : '') : 'SELECTING...') +
        (this.via ? `  VIA ${this.via.body.name.toUpperCase()}` : ''),
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
        for (const b of this.universe.belts) if (!b.trojan && Math.abs(r - b.radius) < b.width / 2 + 300) hit.add(b);
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
    // errands first (set by the game for the player's ship): a ship in distress, a station to repair
    // and sell ore at, a comet to meet. These are rendezvous targets: match speed and drift alongside.
    this.service = false;
    if (!this.ai && this.serviceTarget) {
      const s = this.serviceTarget();
      if (s && (this.skip.get(s) ?? 0) <= this.universe.now) {
        Object.assign(this, { service: true, uncharted: false, wandering: false, tour: false, scanPass: false, relay: false });
        return s;
      }
    }
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
      return (GRAVITATION * SPACECRAFT_MASS * p.mass) / (d * d) < 550; // leave room to climb back out (heavier: scan pass)
    };
    // giants too heavy to dip into can still be charted from orbit (an orbit tour counts as a survey)
    // every giant can be charted: light ones by dipping into the cloud tops, heavy ones by a scan pass
    const candidates = u.planets.filter((p) => !this.charted(p) && p !== this.lastTarget && allowed(p) && reachableMoon(p) && clearOfAir(p));
    let pool = f ? candidates.filter(reach) : candidates; // never plan a trip the tank cannot cover
    this.tour = false; this.tourHeld = 0;
    this.scanPass = false;
    this.relay = false;
    if (f && !pool.length && candidates.length) {
      // Uncharted worlds exist but are out of range. Refuel first only if a full tank would actually
      // get us there; otherwise (or if we are already full) hop to a world that brings us closer.
      // Without this check the old autopilot refuelled, took off, still could not reach it, and landed
      // back on the same world forever.
      const fullOk = candidates.filter((p) => this.tripCost(mag(sub(p.pos, ship.pos)), p.pos) * 1.5 + 8 <= f.capacity);
      const nearest = this.nearest(u.planets.filter((p) => !p.isMoon && !p.gas && !this.recent.includes(p)));
      if (fullOk.length && f.level < 0.85 * f.capacity && nearest && reach(nearest)) {
        this.refuelling = true;
        this.uncharted = false;
        return nearest;
      }
      const goal = candidates.slice().sort((a, b) => dist(a.pos, ship.pos) - dist(b.pos, ship.pos))[0];
      const dGoal = dist(goal.pos, ship.pos);
      const stones = u.planets.filter((p) => !p.gas && reachableMoon(p) && p !== this.lastTarget && reach(p) &&
        dist(p.pos, goal.pos) < dGoal - 3000);
      if (stones.length) {
        this.refuelling = true; this.relay = true; this.uncharted = false;
        return stones.sort((a, b) => dist(a.pos, goal.pos) - dist(b.pos, goal.pos))[0];
      }
      for (const p of candidates) this.skip.set(p, now + 240); // nothing gets us closer: leave them for now
    }
    this.uncharted = pool.length > 0;
    this.wandering = !pool.length;
    if (!pool.length) {
      // Everything in reach is charted: wander, but somewhere we have not been lately. Solid worlds
      // and roomy giants both work, since we may just orbit for a while instead of landing.
      const fresh = (p) => !this.recent.includes(p) && p !== this.lastTarget && reachableMoon(p) && clearOfAir(p) && (!f || reach(p));
      pool = u.planets.filter((p) => !p.isMoon && (!p.gas || this.orbitPlan(p, true)) && fresh(p));
      if (!pool.length) pool = u.planets.filter((p) => !p.gas && fresh(p));
      if (!pool.length) pool = u.planets.filter((p) => !p.gas && p !== this.lastTarget);
      if (!pool.length) pool = u.planets;
    }
    const weights = pool.map((p) => {
      const d = mag(sub(p.pos, ship.pos));
      let w = (p.isMoon ? 0.6 : 1) / (1 + (d / (this.wandering ? Math.max(60_000, this.persona.reach) : this.persona.reach)) ** 2);
      if (this.wandering) { // prefer places we have not seen in a long time
        const h = this.history.get(p);
        if (h) w *= (1 - Math.exp(-(now - h.t) / 240)) / (1 + 0.6 * h.n);
      }
      if (f && f.burn * (11 + d / 5000) + 15 > f.level) w *= 0.05;
      if (this.pathBlockedByStar(p)) w *= 0.02; // a route straight through a star is a bad idea; prefer the near side
      return w;
    });
    let x = (this.rng ?? Math.random)() * weights.reduce((a, b) => a + b, 0);
    let pick = pool[pool.length - 1];
    for (let i = 0; i < pool.length; i++) { x -= weights[i]; if (x < 0) { pick = pool[i]; break; } }
    // A heavy giant pulls harder than the engine near its clouds, so instead of dipping in we chart it
    // with a scan pass: a close slingshot swing just above the cloud tops.
    if (pick.gas && !this.charted(pick) && !surveyable(pick)) { this.scanPass = true; return pick; }
    // wandering: often just orbit for a while and move on (gas giants get a high, safe orbit)
    if (this.wandering && this.persona.tour > 0 && this.orbitPlan(pick, true) && (pick.gas || (this.rng ?? Math.random)() < this.persona.tour)) {
      this.tour = true;
      this.tourTime = (this.rng ?? Math.random)() * 15 + 18;
    } else if (this.wandering && pick.gas) {
      this.scanPass = true; // no room for a safe orbit: a swing past it instead
    }
    return pick;
  }

  /**
   * Gravity assist: if a big world sits roughly on the way to the target, plan to swing past it.
   * We aim to one side of it so that its pull bends our path toward the target, coast through the
   * closest approach, and come out faster (or slower) and turned, depending on how it was moving.
   */
  planAssist(target) {
    if (!this.assist) return null;
    const u = this.universe, s = this.ship.pos, rnd = this.rng ?? Math.random;
    const dT = dist(s, target.pos);
    if (dT < 14_000) return null;
    let best = null, bestScore = 0;
    for (const g of u.planets) {
      if (g === target || g.isMoon || g.isAnchor || g === target.parent || g.radius < 650) continue;
      if (g.parent || g.binary) continue; // binary pairs make for messy slingshots
      const dG = dist(s, g.pos), dGT = dist(g.pos, target.pos);
      if (dG < 6000 || dGT < 6000) continue;
      const detour = (dG + dGT) / dT;
      if (detour > this.persona.detour || this.pathBlockedByStar(g)) continue;
      const score = g.mass / detour ** 3;
      if (score > bestScore) { best = g; bestScore = score; }
    }
    if (!best) return null;
    const P = this.persona;
    const chance = this.ai ? 0.25 : this.wandering ? P.assistWander : P.assist;
    if (rnd() > chance) return null;
    const top = best.atmo ? best.atmo.top : 0;
    return { body: best, rp: best.radius + top + Math.max(this.ai ? 220 : 120, best.radius * (this.ai ? 0.3 : P.passAlt)), phase: 'approach', since: u.now, vInf: this.ai ? 800 + rnd() * 350 : P.vInf[0] + rnd() * (P.vInf[1] - P.vInf[0]) };
  }

  /** A scan pass: swing past the target giant itself, low over the clouds. */
  scanVia(target) {
    const top = target.atmo ? target.atmo.top : 0;
    // a binary partner is close by: pass wider, and on the far side from it
    const rp = target.radius + top + Math.max(this.ai ? 200 : 110, target.radius * (target.binary ? 0.9 : this.ai ? 0.22 : this.persona.scanDepth));
    return { body: target, scan: true, rp, phase: 'approach', since: this.universe.now, vInf: 1000, away: target.binary ?? null };
  }

  /** Done with the target without landing (scan pass, tour, or gave up): move on. */
  leave(target, skipFor = 0) {
    if (skipFor) this.skip.set(target, this.universe.now + skipFor);
    else { this.remember(target); this.visited.add(target); }
    this.lastTarget = target;
    this.target = null; this.via = null; this.tour = false; this.scanPass = false; this.service = false;
    this.orbitPhase = null; this.lock = 0;
  }

  /** Fly the planned gravity assist. Returns false once it is over (or abandoned). */
  flyby(ship, sim) {
    const v = this.via, g = v.body, now = sim.now;
    this.progressAt = now; // a detour is not being stuck
    const rel = sub(ship.pos, g.pos), d = mag(rel), relV = sub(ship.velocity, g.velocity);
    const mu = GRAVITATION * SPACECRAFT_MASS * g.mass;
    if (now - v.since > 160 || ship.heat > 0.25 || (ship.heatRate ?? 0) > 0.35) { // going wrong: abandon the swing
      if (v.scan) { this.leave(g, 120); return true; }
      this.via = null; return false;
    }
    if (v.phase === 'approach') {
      const toG = mul(rel, -1);
      const b = v.rp * Math.sqrt(1 + (2 * mu) / (v.rp * v.vInf * v.vInf)); // impact parameter for that periapsis
      const coastR = Math.max(b * 2.2, g.radius * 5);
      if (!v.n || d > coastR * 1.6) { // pick the side that bends us toward the target (fixed once we are close)
        const vin = mag(relV) > 200 ? relV : toG;
        const perp = unit(vec(-vin.y, vin.x));
        // a scan pass goes round whichever side we are already on; an assist, the side that turns us toward the target
        v.n = v.away ? mul(perp, dot(perp, sub(g.pos, v.away.pos)) >= 0 ? 1 : -1)
          : v.scan ? mul(perp, dot(perp, rel) >= 0 ? 1 : -1)
            : mul(perp, dot(perp, sub(this.target.pos, g.pos)) > 0 ? -1 : 1);
      }
      v.b = b;
      if (d < coastR) {
        v.phase = 'coast'; v.entrySpeed = mag(ship.velocity); v.entryDir = angleOf(ship.velocity); v.minD = d;
        v.entryRel = mag(relV);
      } else {
        const aim = add(toG, mul(v.n, b));
        const route = this.routeAroundWells(ship, aim, g);
        const dir = unit(route ?? aim);
        // arrive slowly: the slower the approach, the harder the world bends the path
        let speed = Math.min(Math.sqrt(2 * 380 * Math.max(0, d - coastR)) + v.vInf, 2400 * Math.max(1, this.persona.speed), this.beltSpeedCap(ship, aim) * this.persona.beltNerve);
        const push = this.avoidance(ship, aim, g);
        if (this.avoidActive) speed = Math.min(speed, 1800);
        this.burnToward(ship, add(mul(dir, speed), mul(push, 0.9 * speed)), relV, 300);
        this.strategy = 'ASSIST: LINING UP';
        this.debug = `${g.name} in ${Math.round(d - g.radius)}`;
        return true;
      }
    }
    // coasting through the swing: hands off, unless the pass would clip the world or one of its moons
    v.minD = Math.min(v.minD, d);
    v.coastSince ??= now;
    if (now - v.coastSince > 35) { // trims left us circling instead of swinging past: climb out properly
      if (v.scan) this.leave(g, g.explored ? 0 : 120); else this.via = null;
      this.departFrom = g; this.departUntil = now + 40;
      return true;
    }
    const inbound = dot(rel, relV) < 0;
    const o = inbound ? conic(g, rel.x, rel.y, relV.x, relV.y, 24) : null;
    const floor = g.radius + (g.atmo ? g.atmo.top : 0) + 110;
    const dodge = this.moonDodge(ship, g);
    const sp = mag(relV) || 1, out = unit(sub(rel, mul(relV, dot(rel, relV) / (sp * sp)))); // square to our motion, away from the world
    // corrections stick until they are done (switching heading every frame meant never lining up to burn)
    const pe = o ? o.pe : Infinity;
    if (v.fix === 'out' && (!inbound || pe > floor + 0.25 * (v.rp - floor) + 60)) v.fix = null;
    if (v.fix === 'in' && (!inbound || pe < v.rp * 1.04 || d < v.rp * 1.5)) v.fix = null;
    if (v.fix === 'dodge' && mag(dodge) < 30) v.fix = null;
    if (!v.fix) {
      if (o && pe < floor) v.fix = 'out';
      else if (o && pe > v.rp * 1.15 && d > v.rp * 1.8) v.fix = 'in'; // passing too wide: tuck in for a tighter swing
      else if (mag(dodge) > 60) v.fix = 'dodge';
    }
    if (v.fix === 'out') {
      this.burnToward(ship, add(relV, mul(out, 400)), relV, 200, 8);
      this.strategy = v.scan ? 'SCAN: TRIM' : 'ASSIST: TRIM';
    } else if (v.fix === 'in') {
      this.burnToward(ship, add(relV, mul(out, -250)), relV, 200, 8);
      this.strategy = v.scan ? 'SCAN: TRIM' : 'ASSIST: TRIM';
    } else if (v.fix === 'dodge') {
      this.burnToward(ship, add(relV, dodge), relV, 200, 8);
      this.strategy = v.scan ? 'SCAN: DODGE' : 'ASSIST: DODGE';
    } else {
      ship.thrust = vec(); // coast, holding the heading so a correction can start at once
      this.strategy = v.scan ? (g.explored ? 'SCAN: DONE' : 'SCAN PASS') : 'SLINGSHOT';
    }
    this.debug = `${g.name}  pe ${Math.round(v.minD - g.radius)}  v ${Math.round(mag(relV))}`;
    if (!inbound && d > Math.max(v.b * 1.5, g.radius * 4)) {
      const gain = mag(ship.velocity) - v.entrySpeed;
      const turn = Math.abs(wrap(angleOf(ship.velocity) - v.entryDir)) * (180 / Math.PI);
      if (this.onEvent) this.onEvent({ kind: v.scan ? 'scan' : 'assist', body: g, gain, turn, pe: v.minD - g.radius });
      if (v.scan) { this.leave(g); return true; } // charted on the way past: on to the next world
      this.via = null;
      return false;
    }
    return true;
  }

  finishTour(target) {
    if (!target.explored && !this.ai) this.universe.survey(target); // mapped from orbit
    if (this.onEvent) this.onEvent({ kind: 'tour', body: target });
    this.leave(target);
    this.departFrom = target; // climb out properly before chasing anything else
    this.departUntil = this.universe.now + 40;
    this.strategy = 'DEPARTING';
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
    const belts = this.universe.belts.filter((b) => !b.trojan);
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
    this.remember(target);
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
    const top = Math.min(0.96, Math.min(0.9, 0.72 * (0.85 + 0.15 * this.pace)) * this.persona.speed); // the personality's cruising speed
    approach = Math.min(top * CRAFT_SPEED_LIMIT, this.beltSpeedCap(ship, aim) * this.persona.beltNerve, approach);
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
  orbitPlan(target, tour = this.tour && target === this.target) {
    // (tours may circle gas giants too: they never descend into the air)
    if (!target || !this.assist || (!this.orbitFirst && !tour) || (target.gas && !tour) || target.isMoon || !target.hill) return null;
    if (tour && target.binary) return null; // the partner world keeps tugging a tour off course
    const top = target.atmo ? target.atmo.top : 0;
    // giants: well clear of the air, so a capture that overshoots never dips into it
    const rOrb = target.gas ? target.radius + top * 1.6 + 250 : target.radius + Math.max(top + 60, 0.45 * target.radius, 120);
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
      // in: within 18% of a circular orbit; out: beyond 30% (the gap stops it flickering between the two)
      const k = this.orbitPhase === 'orbit' ? 0.3 : 0.18;
      const circular = Math.abs(r - plan.rOrb) < k * plan.rOrb && Math.abs(vr) < (k - 0.03) * vc && Math.abs(vt - sense * vc) < k * vc;
      if (this.tour && Math.abs(r - plan.rOrb) < 0.35 * plan.rOrb) { // tour time counts whenever we are roughly in orbit
        this.tourHeld = (this.tourHeld ?? 0) + this.universe.dt;
        if (this.tourHeld > this.tourTime) { this.finishTour(target); return true; }
      }
      if (this.orbitPhase === 'capture') {
        if (circular) { this.orbitPhase = 'orbit'; this.orbitSince = now; }
        else if (now - this.orbitSince > 90) { if (this.tour) { this.finishTour(target); return true; } this.orbitPhase = 'descent'; }
      } else if (!circular) this.orbitPhase = 'capture';
      else if (!this.tour && now - this.orbitSince > 1.5 / q) this.orbitPhase = 'descent';
    }

    if (this.orbitPhase === 'capture') {
      this.strategy = 'CAPTURE';
      this.debug = `r ${(r / plan.rOrb).toFixed(2)} of orbit`;
      const vDes = add(add(mul(that, sense * vc), mul(rhat, clamp((plan.rOrb - r) * 0.8 * q, -450 * q, 450 * q))), this.moonDodge(ship, target));
      this.burnToward(ship, vDes, relativeV, 250 / q);
      return true;
    }
    if (this.orbitPhase === 'orbit') {
      this.strategy = this.tour ? 'ORBIT TOUR' : 'ORBITING';
      this.debug = this.tour ? `${Math.max(0, Math.round(this.tourTime - (this.tourHeld ?? 0)))}s left` : `v ${Math.round(vc)}`;
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
      if (this.target && !this.target.isRendezvous) { // (touching down somewhere on an errand is not arriving)
        // just arrived: see the sights
        this.strategy = 'LANDED';
        this.debug = '';
        this.orbitPhase = null;
        this.lastTarget = this.target;
        this.visited.add(this.target);
        this.remember(this.target);
        this.via = null;
        this.target = null;
        this.refuelling = false;
        this.lock = 0;
        this.landingAltitude = 0;
        this.nextStrategyTime = sim.now + (this.ai ? this.rng.range(8, 25) : this.sightseeing / this.pace);
      } else if (this.repairing?.()) {
        this.strategy = 'REPAIRING'; // patch the hull before lifting off
        this.debug = '';
        this.nextStrategyTime = sim.now + 0.5;
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
    if (this.departFrom && !this.target) {
      // leaving an orbit: burn prograde (along our motion round the world) until we are fast enough
      // to escape. That spirals outward, never down into the air the way aiming straight off can.
      const p = this.departFrom, rel = sub(ship.pos, p.pos), d = mag(rel), relV = sub(ship.velocity, p.velocity);
      const vEsc = Math.sqrt((2 * GRAVITATION * SPACECRAFT_MASS * p.mass) / Math.max(d, 1));
      if (mag(relV) > 1.15 * vEsc || d > p.radius * 7 || sim.now > this.departUntil) { this.departFrom = null; ship.thrust = vec(); }
      else {
        this.strategy = 'DEPARTING';
        this.debug = `${Math.round((mag(relV) / vEsc) * 100)}% of escape`;
        this.burnToward(ship, mul(unit(relV), 1.25 * vEsc), relV, 250, 6);
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
      this.via = this.scanPass ? this.scanVia(this.target) : this.planAssist(this.target);
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
      this.via = null; this.tour = false;
      this.lock = 0;
      this.brakingDistance = 0;
    }
    const target = this.target;

    // stuck detector: no real progress for 25 s means something is pinning us; give up on this target
    if (this.assist && this.strategy !== 'ACQUIRING') {
      const dNow = mag(sub(target.pos, ship.pos));
      const rs = mag(ship.pos);
      const belt = this.universe.belts.find((b) => !b.trojan && Math.abs(rs - b.radius) < b.width / 2 + 300);
      if (dNow < this.bestDist - 200) { this.bestDist = dNow; this.progressAt = sim.now; }
      else if (sim.now - this.progressAt > (belt ? 6 : 25)) { // pinned in a rock field gives up much sooner
        if (belt) { // inside a rock field: head straight out through the nearer edge
          const out = rs >= belt.radius ? 1 : -1;
          this.escapeDir = mul(ship.pos, out / rs);
          this.escapeUntil = sim.now + 10;
        }
        this.skip.set(target, sim.now + 180);
        this.via = null;
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

    if (this.assist && this.via && this.flyby(ship, sim)) {
      // swinging past a world on the way
    } else if (this.assist) {
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
