import { PI2, makeRng, vec, add, sub, mul, mag, dist, fromAngle, angleOf, clamp, lerp } from './maths.js';
import { GRAVITATION, SPACECRAFT_MASS, UNIVERSE_RANGE, Spark } from './universe.js';
import { inView } from './view.js';

// Wonders: rare things a system may hold.
// - A Dyson swarm: rings of collectors round the star, dimming the light its worlds get.
// - A fortress: a battle station the size of a small moon. Come within range and it locks on, charges,
//   and fires a superlaser at where it expects you to be. The beam vaporises rock, scars worlds and
//   wrecks ships. Get close enough to scan its weak spot and it falls quiet.
// - Wormholes: two mouths joined through nowhere; some lead out of the system altogether.
// - Star whales: a pod of vast, slow, glowing creatures swimming orbits round the star.
// Positions are closed-form in time wherever possible (so replays and prediction stay exact).

const G = () => GRAVITATION * SPACECRAFT_MASS;
const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
export const WONDER_KINDS = ['dyson', 'fortress', 'wormhole', 'whales'];

export class Wonders {
  constructor(u, force = null) {
    this.u = u;
    this.onEvent = null; // ({ kind, ... }) => void
    this.dysonDim = 1;
    this.list = [];
    if (u.systemId === 'sol' && !force) return;
    const rng = makeRng((u.randomSeed ^ 0xd7e0) >>> 0);
    const want = (k, p) => force === 'all' || force === k || (!force && rng() < p);
    const star = u.star;
    if (want('dyson', 0.12) && !star.isBlackHole && !star.pulsar) this.dyson = this.makeDyson(rng);
    if (want('fortress', 0.1)) this.fortress = this.makeFortress(rng);
    if (want('wormhole', 0.14)) this.wormholes = this.makeWormholes(rng);
    if (want('whales', 0.14)) this.whales = this.makeWhales(rng);
    this.list = WONDER_KINDS.filter((k) => this[k === 'wormhole' ? 'wormholes' : k]);
    // stable things the autopilot can fly to (the game's errands)
    if (this.whales) { const self = this; this.whaleTarget = { radius: 800, get name() { return self.whales.name; }, get pos() { return self.whaleCenter.pos; }, get velocity() { return self.whaleCenter.velocity; } }; }
    if (this.dyson) { const s = this.u.star, ring = this.dyson.rings[0], ship = this.u.ship; this.dysonTarget = { radius: 200, name: 'Dyson swarm', get pos() { const d = sub(ship.pos, s.pos), m = mag(d) || 1; return add(s.pos, mul(d, ring.r / m)); }, get velocity() { return s.velocity; } }; }
    if (this.wormholes) for (const m of this.wormholes) m.name = m.out ? 'Wormhole (leads elsewhere)' : 'Wormhole';
  }

  emit(e) { if (this.onEvent) this.onEvent(e); }

  // ---- Dyson swarm ------------------------------------------------------------------------------
  makeDyson(rng) {
    const s = this.u.star, rings = [];
    const n = rng.int(3, 6), complete = rng.range(0.3, 0.95);
    for (let i = 0; i < n; i++) {
      const r = s.radius * rng.range(2.1, 3.4);
      rings.push({
        r, ry: rng.range(0.12, 1), rot: rng() * PI2, omega: Math.sqrt((G() * s.mass) / r ** 3) * (rng() < 0.5 ? 1 : -1),
        n: Math.round(rng.range(90, 170) * complete), size: rng.range(130, 230), phase: rng() * PI2,
      });
    }
    this.dysonDim = 1 - 0.6 * complete;
    return { rings, complete, scanned: false };
  }

  dysonPanels(t) { // yields [x, y, angle, front] for every collector
    const s = this.u.star, out = [];
    for (const ring of this.dyson.rings) {
      const cr = Math.cos(ring.rot), sr = Math.sin(ring.rot);
      for (let k = 0; k < ring.n; k++) {
        const a = ring.phase + (k / ring.n) * PI2 + ring.omega * t;
        const lx = Math.cos(a) * ring.r, ly = Math.sin(a) * ring.r * ring.ry;
        out.push([s.pos.x + lx * cr - ly * sr, s.pos.y + lx * sr + ly * cr, a, Math.sin(a) > 0, ring.size]);
      }
    }
    return out;
  }

  // ---- fortress ----------------------------------------------------------------------------------
  makeFortress(rng) {
    const u = this.u;
    const hosts = u.planets.filter((p) => !p.isMoon && !p.binary && p.hill > p.radius * 6);
    const host = hosts.length ? hosts[rng.int(0, hosts.length)] : null;
    const orbit = host ? Math.min(host.radius * 3 + 1500, host.hill * 0.4) : rng.range(35_000, 70_000);
    const mass = host ? host.mass : u.totalMass;
    return {
      host, orbit, omega: Math.sqrt((G() * mass) / orbit ** 3), phase: rng() * PI2, t0: u.now,
      radius: 700, aim: rng() * PI2, state: 'idle', timer: 0, target: null, range: 32_000,
      shots: 0, misses: 0, scanned: false, name: `${rng.choose(['Bastion', 'Warden', 'Citadel', 'Sentinel', 'Dread'])} Station`,
      beam: null,
    };
  }

  fortressPos(t) {
    const f = this.fortress, c = f.host ? f.host.posAt(t) : vec();
    return add(c, fromAngle(f.phase + f.omega * (t - f.t0), f.orbit));
  }

  /** Is the straight line from a to b blocked by a world (or star)? Returns the first hit, or null. */
  firstHit(a, dir, len) {
    let best = null;
    for (const b of this.u._bodies) {
      const rel = sub(b.pos, a), along = rel.x * dir.x + rel.y * dir.y;
      if (along < 0 || along > len) continue;
      const off = Math.abs(rel.x * dir.y - rel.y * dir.x);
      if (off > b.radius) continue;
      const t = along - Math.sqrt(b.radius * b.radius - off * off);
      if (t > 0 && (!best || t < best.t)) best = { t, body: b };
    }
    return best;
  }

  updateFortress(dt) {
    const u = this.u, f = this.fortress, ship = u.ship, now = u.now;
    f.pos = this.fortressPos(now);
    const p2 = this.fortressPos(now + 0.05);
    f.velocity = vec((p2.x - f.pos.x) / 0.05, (p2.y - f.pos.y) / 0.05);
    const toShip = sub(ship.pos, f.pos), d = mag(toShip);
    if (!f.scanned && d < f.radius + 2500 && !ship.landing) { // inside its guard: scan the weak spot
      f.scanned = true; f.state = 'dormant'; f.beam = null;
      this.emit({ kind: 'fortress-scan', fortress: f });
      return;
    }
    if (f.state === 'dormant') return;
    f.timer -= dt;
    const seen = d < f.range && !ship.landing && !ship.consumed && !this.firstHit(f.pos, mul(toShip, 1 / d), d - 50);
    if (f.state === 'idle') {
      // the dish idles round slowly until something comes into range and in sight
      f.aim += 0.05 * dt;
      if (seen) { f.state = 'lock'; f.timer = 2.6; this.emit({ kind: 'fortress-lock', fortress: f }); }
    } else if (f.state === 'lock') {
      // track the target, leading it: aim at where it will be when the beam fires
      const lead = add(ship.pos, mul(sub(ship.velocity, f.host ? f.host.velocity : vec()), Math.max(0, f.timer) + 0.3));
      // it commits its aim for the last moment of the charge: that is the window to jink
      if (f.timer > 0.45) {
        const want = angleOf(sub(lead, f.pos));
        f.aim += clamp(wrap(want - f.aim), -1.4 * dt, 1.4 * dt);
        f.target = lead;
      }
      if (f.timer <= 0) {
        f.state = 'fire'; f.timer = 1.3; f.shots++;
        f.hitShip = false;
        this.emit({ kind: 'fortress-fire', fortress: f });
      } else if (!seen && f.timer < 1.5) { f.state = 'idle'; } // lost sight of us
    } else if (f.state === 'fire') {
      const dir = fromAngle(f.aim, 1), start = add(f.pos, mul(dir, f.radius));
      const hit = this.firstHit(start, dir, 70_000);
      const len = hit ? hit.t : 70_000;
      f.beam = { start, dir, len, hit };
      this.beamDamage(f, start, dir, len, dt);
      if (hit && !f.scarred) { f.scarred = true; this.scar(hit.body, add(start, mul(dir, len))); }
      f.aim += 0.06 * dt; // it sweeps a little while it fires
      if (f.timer <= 0) {
        f.state = 'cool'; f.timer = 8; f.beam = null; f.scarred = false;
        if (!f.hitShip) { f.misses++; this.emit({ kind: 'fortress-miss', fortress: f }); }
      }
    } else if (f.state === 'cool' && f.timer <= 0) f.state = 'idle';
  }

  beamDamage(f, start, dir, len, dt) {
    const u = this.u, W = 110;
    const inBeam = (p) => {
      const rel = sub(p, start), along = rel.x * dir.x + rel.y * dir.y;
      return along > 0 && along < len && Math.abs(rel.x * dir.y - rel.y * dir.x) < W;
    };
    for (const s of u.ships) {
      if (s.consumed || s.landing || !inBeam(s.pos)) continue;
      if (s === u.ship) { f.hitShip = true; s.heat = Math.min(1, s.heat + 1.5 * dt); this.emit({ kind: 'beam-hit', dt }); }
      else u.destroyShip(s, u.closestPlanet(s), 3000, 'vaporised'); // AI ships do not survive it
    }
    // rock along the beam turns to glowing dust
    let n = 0;
    for (let along = 0; along < len && n < 30; along += 450) {
      const p = add(start, mul(dir, along));
      u.forRocksNear(p, W, (x, y, size, belt, i) => {
        if (n >= 30) return;
        belt.gone[i] = 1; n++;
        const sp = new Spark({ ttl: 1.2, style: 'glow', color: '255,120,90', size: size * 1.5 });
        sp.pos = sp.opos = vec(x, y); sp.velocity = vec();
        u.sparks.push(sp);
      });
    }
    for (const it of u.debris.items) if (inBeam(it.pos)) it.dead = true;
  }

  scar(body, at) {
    const u = this.u;
    if (!body.isBlackHole && !u.stars.includes(body)) {
      const a = angleOf(sub(at, body.pos));
      (body.impacts ??= []).push({ a: a - (body.spin ?? 0) * u.now, size: Math.min(body.radius * 0.3, 160), t: u.now });
      if (body.impacts.length > 14) body.impacts.shift();
    }
    const g = new Spark({ ttl: 2, style: 'glow', color: '255,90,70', size: 420 });
    g.pos = g.opos = at; g.velocity = body.velocity ?? vec();
    u.sparks.push(g);
    this.emit({ kind: 'beam-scar', body, at });
  }

  /** Something the autopilot should dodge right now: the beam is locking on to the player. */
  get threat() {
    const f = this.fortress;
    return f && f.state === 'lock' && f.timer < 2.4 ? f : null;
  }

  // ---- wormholes ---------------------------------------------------------------------------------
  makeWormholes(rng) {
    const u = this.u, mouths = [];
    const spot = () => {
      for (let i = 0; i < 30; i++) {
        const r = rng.range(Math.max(u.minOrbit, 25_000), UNIVERSE_RANGE * 0.8), a = rng() * PI2;
        const p = fromAngle(a, r);
        if (u.planets.every((q) => dist(q.pos, p) > q.radius * 4 + 4000)) return { r, a };
      }
      return { r: 120_000, a: rng() * PI2 };
    };
    const outward = rng() < 0.35; // one mouth of this pair leads out of the system
    for (let k = 0; k < 2; k++) {
      const { r, a } = spot();
      mouths.push({ r, a0: a, omega: Math.sqrt((G() * u.totalMass) / r ** 3), t0: u.now, radius: 230, pos: vec(), velocity: vec(), out: outward && k === 1, cool: 0, k });
    }
    for (const m of mouths) this.placeMouth(m, u.now);
    return mouths;
  }

  placeMouth(m, t) {
    const a = m.a0 + m.omega * (t - m.t0);
    m.pos = fromAngle(a, m.r);
    m.velocity = fromAngle(a + Math.PI / 2, m.omega * m.r);
  }

  updateWormholes() {
    const u = this.u, ship = u.ship;
    for (const m of this.wormholes) {
      this.placeMouth(m, u.now);
      if (m.cool > u.now || ship.landing || ship.consumed) continue;
      if (dist(ship.pos, m.pos) > m.radius * 0.85) continue;
      if (m.out) { m.cool = u.now + 30; this.emit({ kind: 'wormhole-out', mouth: m }); continue; }
      const other = this.wormholes.find((o) => o !== m);
      const rel = sub(ship.velocity, m.velocity), sp = mag(rel) || 1;
      ship.pos = ship.opos = add(other.pos, mul(rel, (other.radius * 1.6) / sp)); // out the other side, same heading
      ship.velocity = add(other.velocity, rel);
      ship.track.length = 0;
      m.cool = other.cool = u.now + 6;
      this.emit({ kind: 'wormhole', from: m, to: other });
    }
  }

  // ---- star whales -------------------------------------------------------------------------------
  makeWhales(rng) {
    const u = this.u, r = rng.range(Math.max(u.minOrbit, 30_000), 140_000);
    const pod = [];
    for (let k = 0; k < rng.int(3, 8); k++) {
      pod.push({ len: rng.range(260, 620), off: rng.range(-1, 1), lat: rng.range(-1, 1), ph: rng() * PI2, hue: rng.range(170, 300) });
    }
    return { r, a0: rng() * PI2, omega: Math.sqrt((G() * u.totalMass) / r ** 3) * 0.9, t0: u.now, pod, recorded: false, name: `${rng.choose(['Leviathan', 'Choir', 'Drift', 'Lantern'])} pod` };
  }

  /** Each whale's position, heading and swimming phase at time t (all closed-form). */
  whalePoses(t) {
    const w = this.whales, a = w.a0 + w.omega * (t - w.t0);
    return w.pod.map((wh, i) => {
      const along = a + wh.off * 0.02 + Math.sin(t * 0.13 + wh.ph) * 0.004;
      const rr = w.r + wh.lat * 1400 + Math.sin(t * 0.21 + i) * 300;
      const pos = fromAngle(along, rr);
      const ahead = fromAngle(along + 0.001, rr + Math.cos(t * 0.21 + i) * 0.6);
      return { wh, pos, heading: angleOf(sub(ahead, pos)), swim: t * 1.4 + wh.ph };
    });
  }

  get whaleCenter() {
    const w = this.whales, a = w.a0 + w.omega * (this.u.now - w.t0);
    return { pos: fromAngle(a, w.r), velocity: fromAngle(a + Math.PI / 2, w.omega * w.r), radius: 800, name: this.whales.name };
  }

  updateWhales() {
    const w = this.whales, ship = this.u.ship;
    if (w.recorded || ship.landing) return;
    const c = this.whaleCenter;
    if (dist(c.pos, ship.pos) < 2600 && mag(sub(ship.velocity, c.velocity)) < 450) { w.recorded = true; this.emit({ kind: 'whales', whales: w }); }
  }

  // ---- per frame -----------------------------------------------------------------------------------
  update(dt) {
    if (!this.list.length) return;
    if (this.fortress) this.updateFortress(dt);
    if (this.wormholes) this.updateWormholes();
    if (this.whales) this.updateWhales();
    if (this.dyson && !this.dyson.scanned) {
      const s = this.u.star, d = dist(s.pos, this.u.ship.pos), ring = this.dyson.rings[0];
      if (Math.abs(d - ring.r) < 2500) { this.dyson.scanned = true; this.emit({ kind: 'dyson', dyson: this.dyson }); }
    }
  }

  // ---- drawing -------------------------------------------------------------------------------------
  draw(ctx, view, px, now, back) {
    if (!this.list.length) return;
    if (this.dyson) this.drawDyson(ctx, view, px, now, back);
    if (back) return;
    if (this.wormholes) for (const m of this.wormholes) this.drawMouth(ctx, view, px, now, m);
    if (this.whales) this.drawWhales(ctx, view, px, now);
    if (this.fortress) this.drawFortress(ctx, view, px, now);
  }

  drawDyson(ctx, view, px, now, back) {
    const s = this.u.star;
    if (!inView(view, s.pos.x, s.pos.y, s.radius * 3.6)) return;
    ctx.save();
    // the rings themselves, faintly, so the structure reads from afar
    ctx.lineWidth = 1.2 * px;
    for (const ring of this.dyson.rings) {
      ctx.strokeStyle = `rgba(255,214,140,${back ? 0.08 : 0.16})`;
      ctx.beginPath(); ctx.ellipse(s.pos.x, s.pos.y, ring.r, ring.r * ring.ry, ring.rot, back ? Math.PI : 0, back ? PI2 : Math.PI); ctx.stroke();
    }
    ctx.lineWidth = px;
    for (const [x, y, a, front, size] of this.dysonPanels(now)) {
      if (front === back) continue; // the far side of each ring is drawn behind the star
      if (size / px < 1.2) { ctx.fillStyle = `rgba(255,220,150,${front ? 0.7 : 0.3})`; ctx.fillRect(x - px, y - px, 2 * px, 2 * px); continue; }
      ctx.save();
      ctx.translate(x, y); ctx.rotate(a);
      ctx.fillStyle = front ? 'rgba(120,80,30,0.85)' : 'rgba(60,40,20,0.5)'; // lit by the star they ring
      ctx.strokeStyle = front ? 'rgba(255,214,140,0.85)' : 'rgba(255,214,140,0.3)';
      ctx.beginPath();
      for (let k = 0; k < 6; k++) { const q = (k / 6) * PI2; const hx = Math.cos(q) * size * 0.5, hy = Math.sin(q) * size * 0.5; if (k) ctx.lineTo(hx, hy); else ctx.moveTo(hx, hy); }
      ctx.closePath(); ctx.fill(); ctx.stroke();
      ctx.restore();
    }
    ctx.restore();
  }

  drawFortress(ctx, view, px, now) {
    const f = this.fortress;
    const { x, y } = this.fortressPos(now), R = f.radius; // (closed-form, so replays show it where it was)
    // targeting line while it locks on
    if (f.state === 'lock' && f.target) {
      const k = 1 - f.timer / 2.6;
      ctx.save();
      ctx.strokeStyle = `rgba(255,60,60,${0.25 + 0.6 * k * (0.6 + 0.4 * Math.sin(now * 30))})`;
      ctx.lineWidth = (1 + 2 * k) * px; ctx.setLineDash([12 * px, 8 * px]);
      ctx.beginPath(); ctx.moveTo(x + Math.cos(f.aim) * R, y + Math.sin(f.aim) * R); ctx.lineTo(f.target.x, f.target.y); ctx.stroke();
      ctx.setLineDash([]);
      ctx.beginPath(); ctx.arc(f.target.x, f.target.y, (14 + 20 * (1 - k)) * px, 0, PI2); ctx.stroke();
      ctx.restore();
    }
    // the beam
    if (f.beam) {
      const { start, dir, len } = f.beam, ex = start.x + dir.x * len, ey = start.y + dir.y * len;
      const flick = 0.8 + 0.2 * Math.sin(now * 60);
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.lineCap = 'round';
      for (const [w, c] of [[220, 'rgba(255,40,40,0.18)'], [110, 'rgba(255,70,60,0.4)'], [40, 'rgba(255,200,180,0.85)'], [14, 'rgba(255,255,255,0.95)']]) {
        ctx.strokeStyle = c; ctx.lineWidth = Math.max(w * flick, (w / 30) * px);
        ctx.beginPath(); ctx.moveTo(start.x, start.y); ctx.lineTo(ex, ey); ctx.stroke();
      }
      ctx.restore();
    }
    if (!inView(view, x, y, R * 1.6)) return;
    if (R / px < 1.6) { ctx.fillStyle = '#c9c9d2'; ctx.beginPath(); ctx.arc(x, y, 1.3 * px, 0, PI2); ctx.fill(); return; }
    ctx.save();
    ctx.translate(x, y);
    // hull: a grey sphere with an equatorial trench, panel lines and a big concave dish
    const g = ctx.createRadialGradient(-R * 0.35, -R * 0.35, R * 0.1, 0, 0, R);
    g.addColorStop(0, '#9a9aa6'); g.addColorStop(1, '#2b2b33');
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(0, 0, R, 0, PI2); ctx.fill();
    ctx.strokeStyle = 'rgba(20,20,26,0.9)'; ctx.lineWidth = Math.max(px, R * 0.03);
    ctx.beginPath(); ctx.moveTo(-R, 0); ctx.lineTo(R, 0); ctx.stroke();
    ctx.lineWidth = px; ctx.strokeStyle = 'rgba(40,40,50,0.6)';
    for (const k of [-0.6, -0.3, 0.3, 0.6]) { ctx.beginPath(); ctx.moveTo(-Math.sqrt(1 - k * k) * R, k * R); ctx.lineTo(Math.sqrt(1 - k * k) * R, k * R); ctx.stroke(); }
    const dx = Math.cos(f.aim) * R * 0.55, dy = Math.sin(f.aim) * R * 0.55;
    const charge = f.state === 'lock' ? 1 - f.timer / 2.6 : f.state === 'fire' ? 1 : 0;
    ctx.fillStyle = '#1d1d24'; ctx.beginPath(); ctx.arc(dx, dy, R * 0.26, 0, PI2); ctx.fill();
    ctx.strokeStyle = '#55555f'; ctx.lineWidth = Math.max(px, R * 0.015); ctx.beginPath(); ctx.arc(dx, dy, R * 0.26, 0, PI2); ctx.stroke();
    if (charge > 0) {
      ctx.globalCompositeOperation = 'lighter';
      const cg = ctx.createRadialGradient(dx, dy, 0, dx, dy, R * 0.3 * (0.4 + charge));
      cg.addColorStop(0, `rgba(255,220,200,${0.9 * charge})`); cg.addColorStop(1, 'rgba(255,40,40,0)');
      ctx.fillStyle = cg; ctx.beginPath(); ctx.arc(dx, dy, R * 0.3 * (0.4 + charge), 0, PI2); ctx.fill();
      ctx.globalCompositeOperation = 'source-over';
    }
    ctx.restore();
    ctx.save(); ctx.translate(x, y); ctx.scale(px, px);
    ctx.fillStyle = f.state === 'dormant' ? 'rgba(180,180,190,0.7)' : 'rgba(255,120,110,0.9)';
    ctx.font = '10px ui-monospace, Menlo, monospace'; ctx.textAlign = 'center';
    ctx.fillText(`${f.name.toUpperCase()}${f.state === 'dormant' ? ' (quiet)' : f.state === 'lock' ? ' — LOCKING ON' : ''}`, 0, -(R / px) - 10);
    ctx.restore();
  }

  drawMouth(ctx, view, px, now, m) {
    const { x, y } = m.pos, R = m.radius;
    if (!inView(view, x, y, R * 3)) return;
    ctx.save();
    ctx.translate(x, y);
    ctx.globalCompositeOperation = 'lighter';
    const hue = m.out ? 30 : 265;
    const g = ctx.createRadialGradient(0, 0, 0, 0, 0, R * 2.6);
    g.addColorStop(0, `hsla(${hue},90%,80%,0.55)`); g.addColorStop(0.35, `hsla(${hue + 20},90%,60%,0.2)`); g.addColorStop(1, `hsla(${hue},90%,50%,0)`);
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(0, 0, R * 2.6, 0, PI2); ctx.fill();
    // swirling arms falling inward
    ctx.lineWidth = Math.max(px, R * 0.02);
    for (let arm = 0; arm < 5; arm++) {
      ctx.strokeStyle = `hsla(${hue + arm * 8},90%,75%,0.55)`;
      ctx.beginPath();
      for (let t = 0; t <= 40; t++) {
        const r = R * 2.2 * (1 - t / 40), th = (arm / 5) * PI2 + now * 1.2 + t * 0.22;
        if (t) ctx.lineTo(Math.cos(th) * r, Math.sin(th) * r); else ctx.moveTo(Math.cos(th) * r, Math.sin(th) * r);
      }
      ctx.stroke();
    }
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = '#000'; ctx.beginPath(); ctx.arc(0, 0, R * 0.42, 0, PI2); ctx.fill();
    ctx.scale(px, px);
    ctx.fillStyle = `hsla(${hue},80%,80%,0.85)`; ctx.font = '10px ui-monospace, Menlo, monospace'; ctx.textAlign = 'center';
    ctx.fillText(m.out ? 'WORMHOLE (unstable: leads elsewhere)' : 'WORMHOLE', 0, -(R * 2.6) / px - 6);
    ctx.restore();
  }

  drawWhales(ctx, view, px, now) {
    const c = this.whaleCenter;
    if (!inView(view, c.pos.x, c.pos.y, 6000)) return;
    for (const { wh, pos, heading, swim } of this.whalePoses(now)) {
      const L = wh.len;
      if (L / px < 2) { ctx.fillStyle = `hsla(${wh.hue},80%,75%,0.8)`; ctx.beginPath(); ctx.arc(pos.x, pos.y, 1.2 * px, 0, PI2); ctx.fill(); continue; }
      ctx.save();
      ctx.translate(pos.x, pos.y); ctx.rotate(heading);
      // glow
      ctx.globalCompositeOperation = 'lighter';
      const gl = ctx.createRadialGradient(0, 0, 0, 0, 0, L * 0.8);
      gl.addColorStop(0, `hsla(${wh.hue},90%,70%,0.18)`); gl.addColorStop(1, `hsla(${wh.hue},90%,60%,0)`);
      ctx.fillStyle = gl; ctx.beginPath(); ctx.arc(0, 0, L * 0.8, 0, PI2); ctx.fill();
      ctx.globalCompositeOperation = 'source-over';
      // body: a long teardrop that flexes as it swims, with a tail fluke
      const flex = Math.sin(swim) * 0.18;
      ctx.beginPath();
      ctx.moveTo(L * 0.5, 0);
      ctx.bezierCurveTo(L * 0.4, -L * 0.16, -L * 0.1, -L * 0.14, -L * 0.42, flex * L * 0.4 - L * 0.03);
      ctx.lineTo(-L * 0.62, flex * L - L * 0.12);
      ctx.lineTo(-L * 0.55, flex * L * 0.7);
      ctx.lineTo(-L * 0.62, flex * L + L * 0.12);
      ctx.lineTo(-L * 0.42, flex * L * 0.4 + L * 0.03);
      ctx.bezierCurveTo(-L * 0.1, L * 0.14, L * 0.4, L * 0.16, L * 0.5, 0);
      ctx.fillStyle = `hsla(${wh.hue},40%,14%,0.9)`; ctx.fill();
      ctx.strokeStyle = `hsla(${wh.hue},85%,72%,0.9)`; ctx.lineWidth = Math.max(px, L * 0.008); ctx.stroke();
      ctx.fillStyle = `hsla(${wh.hue + 30},95%,80%,0.9)`; // bioluminescent spots
      for (let k = 0; k < 7; k++) {
        const sx = lerp(L * 0.35, -L * 0.35, k / 6), sy = Math.sin(k * 1.7 + swim * 0.5) * L * 0.05;
        ctx.globalAlpha = 0.5 + 0.5 * Math.sin(now * 2 + k);
        ctx.beginPath(); ctx.arc(sx, sy, Math.max(px, L * 0.012), 0, PI2); ctx.fill();
      }
      ctx.globalAlpha = 1;
      ctx.restore();
    }
    ctx.save(); ctx.translate(c.pos.x, c.pos.y); ctx.scale(px, px);
    ctx.fillStyle = 'rgba(190,170,255,0.75)'; ctx.font = '10px ui-monospace, Menlo, monospace'; ctx.textAlign = 'center';
    ctx.fillText(`STAR WHALES: ${this.whales.name.toUpperCase()}`, 0, -40);
    ctx.restore();
  }
}
