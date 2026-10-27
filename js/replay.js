// Instant replays. The worlds ride closed-form rails, so any past moment can be recomputed exactly from
// the clock; only the free things (ships, loose rocks, comets, satellites) need recording. We keep the
// last ~30 s of sim time at 15 frames a second, and a replay temporarily poses the universe at a past
// moment, draws it, and puts everything back.

const EVERY = 1 / 15, KEEP = 30;

export class Replay {
  constructor() { this.frames = []; this.last = -1; this.play = null; this.queue = null; }

  clear() { this.frames = []; this.last = -1; this.play = null; this.queue = null; }

  record(u) {
    if (u.now - this.last < EVERY) return;
    this.last = u.now;
    this.frames.push({
      now: u.now,
      ships: u.ships.map((s) => [s, s.pos.x, s.pos.y, s.angle, s.effThrust ?? 0, !!s.landing, s.consumed ? 1 : 0]),
      debris: u.debris.items.map((d) => [d, d.pos.x, d.pos.y, d.rot]),
      sats: u.satellites.map((s) => [s, s.pos.x, s.pos.y, s.angle]),
    });
    while (this.frames.length && this.frames[0].now < u.now - KEEP) this.frames.shift();
  }

  get span() { return this.frames.length > 1 ? this.frames[this.frames.length - 1].now - this.frames[0].now : 0; }

  /** Start replaying the last `seconds` (sim) at `speed` x, framed on `focus` (something with a pos). */
  start(seconds, speed, focus, title) {
    if (this.frames.length < 10) return false;
    const end = this.frames[this.frames.length - 1].now, from = Math.max(this.frames[0].now, end - seconds);
    this.play = { t: from, from, end, speed, focus, title, cam: null };
    return true;
  }

  stop() { this.play = null; }

  frameAt(t) {
    const f = this.frames;
    let i = f.findIndex((x) => x.now >= t);
    if (i <= 0) return [f[Math.max(0, i)], f[Math.max(0, i)], 0];
    const a = f[i - 1], b = f[i];
    return [a, b, (t - a.now) / Math.max(1e-6, b.now - a.now)];
  }

  /** Pose the universe at time t. Returns a function that undoes it. */
  apply(u, t) {
    const [a, b, k] = this.frameAt(t);
    const lerp = (x, y) => x + (y - x) * k;
    const saved = {
      now: u.now, sparks: u.sparks, items: u.debris.items,
      bodies: [...u.planets, ...u.anchors, ...u.wells].map((p) => [p, p.pos]),
      ships: u.ships.map((s) => [s, s.pos, s.angle, s.effThrust, s.track]),
      sats: u.satellites.map((s) => [s, s.pos, s.angle]),
      beacon: u.beacon ? u.beacon.pos : null,
    };
    u.now = t;
    for (const [p] of saved.bodies) if (p.rail) p.pos = p.posAt(t);
    const later = new Map(b.ships.map((r) => [r[0], r]));
    for (const r of a.ships) {
      const s = r[0], r2 = later.get(s) ?? r;
      s.pos = { x: lerp(r[1], r2[1]), y: lerp(r[2], r2[2]) };
      s.angle = r[3] + Math.atan2(Math.sin(r2[3] - r[3]), Math.cos(r2[3] - r[3])) * k;
      s.effThrust = r[4];
      // the trail is rebuilt from the recording: the last few seconds before this moment
      const trail = [];
      for (const f of this.frames) {
        if (f.now > t) break;
        if (f.now < t - 6) continue;
        const q = f.ships.find((x) => x[0] === s);
        if (q) trail.push({ x: q[1], y: q[2], v: 0 });
      }
      s.track = trail;
    }
    const laterD = new Map(b.debris.map((r) => [r[0], r]));
    u.debris.items = a.debris.map((r) => {
      const d = r[0], r2 = laterD.get(d) ?? r;
      return { ...d, pos: { x: lerp(r[1], r2[1]), y: lerp(r[2], r2[2]) }, rot: r[3], tail: d.tail };
    });
    const laterS = new Map(b.sats.map((r) => [r[0], r]));
    for (const r of a.sats) { const s = r[0], r2 = laterS.get(s) ?? r; s.pos = { x: lerp(r[1], r2[1]), y: lerp(r[2], r2[2]) }; s.angle = r[3]; }
    u.sparks = [];
    return () => {
      u.now = saved.now; u.sparks = saved.sparks; u.debris.items = saved.items;
      for (const [p, pos] of saved.bodies) p.pos = pos;
      for (const [s, pos, ang, thr, track] of saved.ships) { s.pos = pos; s.angle = ang; s.effThrust = thr; s.track = track; }
      for (const [s, pos, ang] of saved.sats) { s.pos = pos; s.angle = ang; }
    };
  }
}
