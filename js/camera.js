import { clamp, dist, mag, sub, lerp } from './maths.js';

// Camera. Zoom lives in log space and rides a critically damped spring, so zooming in and out by a
// factor of a hundred feels as smooth as zooming by two. The camera centre is an offset from the ship
// on its own spring (look-ahead along the velocity, a lean toward the target or the ground). A
// director can take over and cut between cinematic shots for idle watching.

export const MIN_ZOOM = 250 / 200_000;
export const MAX_ZOOM = 5;

const smoothstep = (e0, e1, x) => { const t = clamp((x - e0) / (e1 - e0), 0, 1); return t * t * (3 - 2 * t); };

// critically damped spring step (stable for any dt we feed it)
function spring(s, target, omega, dt) {
  const x = s.x - target;
  const exp = Math.exp(-omega * dt);
  const v = s.v;
  const temp = (v + omega * x) * dt;
  s.v = (v - omega * temp) * exp;
  s.x = target + (x + temp) * exp;
}

export class Camera {
  constructor() {
    this.x = 0; this.y = 0; this.zoom = 1;
    this.lz = { x: 0, v: 0 }; // log zoom
    this.ox = { x: 0, v: 0 }; this.oy = { x: 0, v: 0 }; // offset from the ship (world units)
    this.bias = 0; // user zoom preference, in log units, on top of the automatic framing
    this.trauma = 0; // 0..1 screen shake
    this.sx = 0; this.sy = 0; // shake offset in css px
    this.starX = 0; this.starY = 0; // starfield parallax accumulator (css px)
    this.streak = { x: 0, y: 0 }; // screen velocity for star streaks (css px / s)
    this.director = false;
    this.shot = null; this.shotUntil = 0; this.shotName = '';
    this.t = 0;
    this.smart = true; this.fixedZoom = 1;
    this.manualUntil = 0;
  }

  addTrauma(t) { this.trauma = Math.min(1, this.trauma + t); }
  nudgeZoom(dLog) { this.bias = clamp(this.bias + dLog, -4, 3); }
  resetZoom() { this.bias = 0; }

  snap(u, w, h) {
    const want = this.frame(u, w, h);
    this.lz.x = Math.log(want.zoom); this.lz.v = 0;
    this.ox.x = want.ox; this.oy.x = want.oy; this.ox.v = this.oy.v = 0;
    this.zoom = want.zoom; this.x = u.ship.pos.x + want.ox; this.y = u.ship.pos.y + want.oy;
  }

  /** The automatic framing: what a good camera operator would want right now. */
  smartFrame(u, w, h, ap) {
    const ship = u.ship, minDim = Math.min(w, h);
    const ref = u.closestPlanet();
    const d = dist(ref.pos, ship.pos), dSurf = Math.max(0, d - ref.radius);
    const inside = ref.hill ? d < ref.hill * 1.2 : true;
    const rv = inside ? sub(ship.velocity, ref.velocity) : ship.velocity;
    const speed = ship.landing ? 0 : mag(rv);

    // speed: see about two seconds ahead; proximity: keep the nearest surface on screen
    let lz = Math.log(0.42 * minDim / (speed * 2.2 + 260));
    const zSpeed = Math.exp(lz);
    const near = Math.log(0.36 * minDim / (dSurf + 110 + ref.radius * 0.04));
    lz = lerp(lz, Math.min(lz, near), smoothstep(34_000, 9_000, dSurf));
    let ox = 0, oy = 0;
    // autopilot target: frame the ship and where it is heading
    const tgt = ap && ap.enabled ? ap.focus : null;
    if (tgt && !ship.landing) {
      const dt = dist(tgt.pos, ship.pos);
      const k = smoothstep(40_000, 12_000, dt - tgt.radius);
      const zt = Math.log(0.4 * minDim / (dt * 0.6 + tgt.radius * 0.7 + 150));
      lz = lerp(lz, Math.min(lz, zt), k);
      ox += (tgt.pos.x - ship.pos.x) * 0.3 * k; oy += (tgt.pos.y - ship.pos.y) * 0.3 * k;
    }
    const z = Math.exp(lz);
    // look ahead along the velocity, capped to a share of the screen
    const lead = 0.55, cap = (0.24 * minDim) / z;
    let lx = rv.x * lead, ly = rv.y * lead;
    const lm = Math.hypot(lx, ly);
    if (lm > cap) { lx *= cap / lm; ly *= cap / lm; }
    ox += lx; oy += ly;
    // close to a surface, lean toward it so the horizon curves across the lower part of the screen
    const lean = smoothstep((0.5 * minDim) / z, (0.12 * minDim) / z, dSurf) * (0.16 * minDim) / z;
    if (lean > 0 && d > 1) { ox += ((ref.pos.x - ship.pos.x) / d) * lean; oy += ((ref.pos.y - ship.pos.y) / d) * lean; }
    return { zoom: z, ox, oy, ref, speed, dSurf, zSpeed: Math.min(zSpeed, Math.exp(near) * 1.5) };
  }

  /** Pick the next cinematic shot for the director. */
  pickShot(u, w, h, ap, base) {
    const ship = u.ship, r = Math.random(), tgt = ap?.focus;
    const moving = !ship.landing && base.speed > 350;
    const options = [['chase', 3]];
    if (moving) options.push(['flyby', 3], ['wide', 2]);
    if (tgt || base.dSurf < 6000) options.push(['planet', ap?.via ? 7 : 3]);
    if (ap?.via && moving) options.push(['flyby', 4]);
    if (!ship.landing && base.dSurf > 9000) options.push(['system', 0.7]);
    if (ship.landing) options.push(['low', 3]);
    if (u.wing && !u.wing.consumed) options.push(['wing', 1.2]);
    for (const o of options) o[1] *= this.style?.shots?.[o[0]] ?? 1; // the personality's taste in shots
    const total = options.reduce((s, o) => s + o[1], 0);
    let x = r * total, name = 'chase';
    for (const [n, wgt] of options) { x -= wgt; if (x < 0) { name = n; break; } }
    if (name === this.shotName && options.length > 1) return this.pickShot(u, w, h, ap, base);
    const shot = { name };
    if (name === 'flyby') { // park the camera ahead of the ship, a little to the side, and let it fly past
      const v = sub(ship.velocity, base.ref.velocity), sp = mag(v) || 1;
      const ahead = Math.min(sp * 2.2, (0.7 * Math.min(w, h)) / base.zoom);
      const side = (Math.random() < 0.5 ? -1 : 1) * (0.14 * Math.min(w, h)) / base.zoom;
      shot.px = ship.pos.x + (v.x / sp) * ahead - (v.y / sp) * side;
      shot.py = ship.pos.y + (v.y / sp) * ahead + (v.x / sp) * side;
      shot.zoom = base.zoom * 0.85;
      shot.dur = 7;
    } else shot.dur = { chase: 14, wide: 10, planet: 12, system: 7, low: 12 }[name] ?? 10;
    shot.dur *= (0.8 + Math.random() * 0.5) * (this.style?.shotLen ?? 1);
    return shot;
  }

  /** What the camera wants this frame: { zoom, ox, oy } (offset from the ship). */
  frame(u, w, h, ap = null) {
    const base = this.smartFrame(u, w, h, ap);
    if (!this.smart && !this.director) return { zoom: this.fixedZoom * Math.exp(this.bias), ox: 0, oy: 0, omega: 3 };
    let want = { zoom: base.zoom, ox: base.ox, oy: base.oy, omega: 2.4 };
    if (this.director && this.t >= this.manualUntil) {
      if (!this.shot || this.t > this.shotUntil) {
        this.shot = this.pickShot(u, w, h, ap, base);
        this.shotName = this.shot.name;
        this.shotUntil = this.t + this.shot.dur;
      }
      const s = this.shot, ship = u.ship, minDim = Math.min(w, h);
      if (s.name === 'wing' && u.wing) { // check in on the wingman
        const wg = u.wing, wd = Math.hypot(wg.pos.x - ship.pos.x, wg.pos.y - ship.pos.y);
        want = { zoom: Math.min(1.2, (0.4 * minDim) / (Math.hypot(wg.velocity.x, wg.velocity.y) * 2.2 + 300)), ox: wg.pos.x - ship.pos.x, oy: wg.pos.y - ship.pos.y, omega: wd > 30_000 ? 0.8 : 1.4 };
      } else if (s.name === 'chase') want = { zoom: Math.max(base.zoom, base.zSpeed) * 1.5, ox: base.ox * 0.35, oy: base.oy * 0.35, omega: 1.6 };
      else if (s.name === 'wide') want = { zoom: base.zoom * 0.3, ox: base.ox * 2, oy: base.oy * 2, omega: 1.1 };
      else if (s.name === 'low') want = { zoom: base.zoom * 0.55, ox: base.ox, oy: base.oy, omega: 1 };
      else if (s.name === 'flyby') {
        want = { zoom: s.zoom, ox: s.px - ship.pos.x, oy: s.py - ship.pos.y, omega: 7 };
        // the ship has left the frame: cut early
        if (dist(ship.pos, { x: s.px, y: s.py }) * s.zoom > minDim * 0.62 && this.t > this.shotUntil - s.dur + 2) this.shotUntil = this.t;
      } else if (s.name === 'planet') {
        const p = ap?.focus ?? base.ref;
        const d = dist(p.pos, ship.pos);
        const span = Math.max(d + p.radius * 1.15, p.radius * 2.6);
        want = { zoom: (0.42 * minDim) / span, ox: (p.pos.x - ship.pos.x) * 0.55, oy: (p.pos.y - ship.pos.y) * 0.55, omega: 1.2 };
      } else if (s.name === 'system') {
        const R = Math.max(mag(ship.pos) * 1.15, 30_000);
        want = { zoom: (0.48 * minDim) / R, ox: -ship.pos.x * 0.8, oy: -ship.pos.y * 0.8, omega: 0.9 };
      }
    }
    want.zoom = clamp(want.zoom * Math.exp(this.bias), MIN_ZOOM, MAX_ZOOM);
    return want;
  }

  update(u, dt, w, h, ap = null, manual = false) {
    dt = clamp(dt, 0, 0.1);
    this.t += dt;
    if (manual && this.director) this.manualUntil = this.t + 6; // the pilot is flying: plain chase cam for a bit
    const want = this.frame(u, w, h, ap);
    const lzT = Math.log(want.zoom);
    // zoom out briskly (you want to see what is coming), zoom in gently
    const om = want.omega * (lzT < this.lz.x ? 1.25 : 0.75);
    spring(this.lz, lzT, om, dt);
    this.lz.x = clamp(this.lz.x, Math.log(MIN_ZOOM), Math.log(MAX_ZOOM));
    spring(this.ox, want.ox, want.omega * 1.2, dt);
    spring(this.oy, want.oy, want.omega * 1.2, dt);
    const px = this.x, py = this.y, pz = this.zoom;
    this.zoom = Math.exp(this.lz.x);
    this.x = u.ship.pos.x + this.ox.x; this.y = u.ship.pos.y + this.oy.x;
    // starfield parallax: integrate the camera's screen motion (zoom changes do not sweep the stars)
    if (dt > 0 && pz) {
      const dx = (this.x - px) * this.zoom, dy = (this.y - py) * this.zoom;
      if (Math.abs(dx) < 4000 && Math.abs(dy) < 4000) {
        this.starX += dx; this.starY += dy;
        this.streak.x = lerp(this.streak.x, dx / dt, 0.2); this.streak.y = lerp(this.streak.y, dy / dt, 0.2);
      }
    }
    // shake: smooth noise, scaled by trauma squared
    this.trauma = Math.max(0, this.trauma - dt * 1.4);
    const k = this.trauma * this.trauma * 16;
    this.sx = k * (Math.sin(this.t * 47.3) * 0.6 + Math.sin(this.t * 91.7 + 1.3) * 0.4);
    this.sy = k * (Math.sin(this.t * 53.1 + 2.1) * 0.6 + Math.sin(this.t * 83.9) * 0.4);
  }
}
