import { PI2, makeRng } from './maths.js';
import { arcPath, discPath, inView } from './view.js';

// Procedural planet looks. Everything is derived from the planet's own seed, so a given
// planet always looks the same. Collision stays circular; lumps and rings are cosmetic.

function roundedBlob(path, pts) {
  const n = pts.length;
  const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  const s = mid(pts[n - 1], pts[0]);
  path.moveTo(s[0], s[1]);
  for (let i = 0; i < n; i++) {
    const m = mid(pts[i], pts[(i + 1) % n]);
    path.quadraticCurveTo(pts[i][0], pts[i][1], m[0], m[1]);
  }
  path.closePath();
}

function blob(rng, cx, cy, r, jag, n = 12) {
  const pts = [];
  for (let i = 0; i < n; i++) {
    const a = (PI2 * i) / n, rr = r * (1 + rng.range(-jag, jag));
    pts.push([cx + Math.cos(a) * rr, cy + Math.sin(a) * rr]);
  }
  return pts;
}

function wavy(path, y, amp, freq, phase) {
  for (let i = 0; i <= 40; i++) {
    const x = -1.1 + (2.2 * i) / 40, yy = y + Math.sin(x * freq * Math.PI + phase) * amp;
    if (i === 0) path.moveTo(x, yy); else path.lineTo(x, yy);
  }
}

function polarCaps(rng, minor) {
  for (const sign of [-1, 1]) {
    if (rng() < 0.6) wavy(minor, sign * rng.range(0.72, 0.85), 0.025, rng.range(2, 5), rng() * PI2);
  }
}

const builders = {
  gas(rng, major, minor) {
    const n = rng.int(6, 13);
    for (let i = 0; i < n; i++) {
      const y = -0.95 + (1.9 * (i + rng.range(0.2, 0.8))) / n;
      wavy(i % 3 === 0 ? major : minor, y, rng.range(0.005, 0.045), rng.range(1.5, 4), rng() * PI2);
    }
    if (rng() < 0.75) {
      const x = rng.range(-0.4, 0.4), y = rng.range(-0.5, 0.5), rx = rng.range(0.12, 0.3);
      for (let k = 0; k < 3; k++) {
        major.moveTo(x + rx * (1 - k * 0.3), y);
        major.ellipse(x, y, rx * (1 - k * 0.3), rx * 0.6 * (1 - k * 0.3), 0, 0, PI2);
      }
    }
  },
  swirl(rng, major, minor) {
    const arms = rng.int(2, 5), dir = rng() < 0.5 ? 1 : -1, turns = rng.range(0.6, 1.4);
    for (let a = 0; a < arms; a++) {
      const off = (PI2 * a) / arms;
      for (let t = 0; t <= 60; t++) {
        const r = (t / 60) * 1.1, th = off + dir * r * turns * PI2;
        const x = Math.cos(th) * r, y = Math.sin(th) * r;
        if (t === 0) major.moveTo(x, y); else major.lineTo(x, y);
      }
    }
    polarCaps(rng, minor);
  },
  craters(rng, major, minor) {
    const n = rng.int(10, 26);
    for (let i = 0; i < n; i++) {
      const a = rng() * PI2, d = Math.sqrt(rng()) * 0.92, r = rng.range(0.03, 0.18) * (0.5 + rng());
      const x = Math.cos(a) * d, y = Math.sin(a) * d;
      major.moveTo(x + r, y);
      major.arc(x, y, r, 0, PI2);
      minor.moveTo(x + r * 0.55, y);
      minor.arc(x, y, r * 0.55, Math.PI * 0.9, Math.PI * 1.9);
    }
  },
  cracks(rng, major, minor) {
    const m = rng.int(7, 14);
    const walkers = [];
    for (let i = 0; i < m; i++) walkers.push({ x: rng.range(-0.9, 0.9), y: rng.range(-0.9, 0.9), a: rng() * PI2, k: rng.int(6, 14) });
    while (walkers.length) {
      const w = walkers.pop();
      const path = rng() < 0.5 ? major : minor;
      path.moveTo(w.x, w.y);
      for (let s = 0; s < w.k; s++) {
        w.a += rng.range(-0.7, 0.7);
        w.x += Math.cos(w.a) * 0.09; w.y += Math.sin(w.a) * 0.09;
        path.lineTo(w.x, w.y);
        if (rng() < 0.12 && walkers.length < 40) walkers.push({ x: w.x, y: w.y, a: w.a + rng.range(-1, 1), k: rng.int(3, 7) });
      }
    }
    polarCaps(rng, minor);
  },
  continents(rng, major, minor, waves = 0) {
    const m = rng.int(3, 7);
    for (let i = 0; i < m; i++) {
      const a = rng() * PI2, d = Math.sqrt(rng()) * 0.7, r = rng.range(0.15, 0.4);
      const cx = Math.cos(a) * d, cy = Math.sin(a) * d;
      roundedBlob(major, blob(rng, cx, cy, r, 0.35));
      roundedBlob(minor, blob(rng, cx, cy, r * 0.55, 0.3));
    }
    for (let i = 0; i < waves; i++) wavy(minor, rng.range(-0.9, 0.9), 0.02, rng.range(3, 7), rng() * PI2);
    polarCaps(rng, minor);
  },
};
builders.ocean = (rng, major, minor) => builders.continents(rng, major, minor, rng.int(5, 10));

export function visual(p) {
  if (p.vis) return p.vis;
  const rng = makeRng((p.seed ^ 0x5bd1e995) >>> 0);
  const R = p.radius;
  const small = R < 260;
  const spec = p.spec ?? {}; // hand-made worlds (our solar system) pin their look here
  let kind;
  if (spec.kind) kind = spec.kind;
  else if (p.gas) kind = rng.choose(['gas', 'gas', 'swirl']);
  else if (small) kind = rng.choose(['craters', 'craters', 'cracks']);
  else kind = rng.choose(['continents', 'craters', 'ocean', 'cracks', 'swirl']);

  const outline = new Path2D();
  if (small) roundedBlob(outline, Array.from({ length: 14 }, (_, i) => {
    const a = (PI2 * i) / 14, r = rng.range(0.82, 1);
    return [Math.cos(a) * r, Math.sin(a) * r];
  }));
  else outline.arc(0, 0, 1, 0, PI2);

  const rolled = !p.isMoon && R > 600 && rng() < 0.45 * (p.ringMul ?? 1)
    ? { inner: rng.range(1.35, 1.6), width: rng.range(0.25, 0.7), ry: rng.range(0.18, 0.38), tilt: rng.range(-0.6, 0.6) }
    : null;
  const rings = spec.rings !== undefined ? spec.rings : rolled;
  const major = new Path2D(), minor = new Path2D();
  builders[kind](rng, major, minor);
  return (p.vis = { kind, lumpy: small, outline, rings, major, minor });
}

function ringEllipse(ctx, rings, R, start, end) {
  for (const k of [rings.inner, rings.inner + rings.width * 0.45, rings.inner + rings.width]) {
    ctx.beginPath();
    ctx.ellipse(0, 0, R * k, R * k * rings.ry, 0, start, end);
    ctx.stroke();
  }
}

/** Draw planet body, surface texture (if `showTex`) and rings. */
export function drawPlanetBody(ctx, p, view, px, showTex, color, voidColor, now = 0) {
  const v = visual(p), R = p.radius;
  const ringReach = Math.max(v.rings ? v.rings.inner + v.rings.width : 1, p.atmo ? 1 + p.atmo.top / R : 1);
  if (!inView(view, p.pos.x, p.pos.y, R * ringReach)) return;
  const lumpy = v.lumpy;
  const drawRings = v.rings && R * ringReach * view.zoom < 3000; // not worth it when huge on screen
  ctx.save();

  if (drawRings) {
    ctx.save();
    ctx.translate(p.pos.x, p.pos.y);
    ctx.rotate(p.seed % 2 ? v.rings.tilt : -v.rings.tilt);
    ctx.strokeStyle = color;
    ctx.globalAlpha = 0.55;
    ctx.lineWidth = px;
    ringEllipse(ctx, v.rings, R, 0, PI2);
    ctx.restore();
  }

  if (p.atmo && !view.lite) { // atmosphere: a few fading shells above the surface, thicker air = brighter
    const top = p.atmo.top, a = Math.min(0.6, 0.15 + p.atmo.rho0 * 0.5);
    ctx.strokeStyle = p.haze ?? color;
    ctx.lineWidth = 1.5 * px;
    for (const k of [0.2, 0.45, 0.75, 1]) {
      ctx.globalAlpha = a * (1.05 - k) * 0.7;
      ctx.beginPath();
      if (arcPath(ctx, view, p.pos.x, p.pos.y, R + top * k)) ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }
  ctx.fillStyle = voidColor;
  ctx.strokeStyle = color;
  ctx.lineJoin = 'round';
  if (lumpy) {
    ctx.translate(p.pos.x, p.pos.y);
    ctx.scale(R, R);
    ctx.fill(v.outline);
    if (showTex) {
      ctx.save();
      ctx.clip(v.outline);
      ctx.rotate((p.spin ?? 0) * now);
      ctx.lineWidth = px / R;
      ctx.stroke(v.major);
      ctx.globalAlpha = 0.45;
      ctx.stroke(v.minor);
      ctx.restore();
    }
    ctx.lineWidth = (2 * px) / R;
    ctx.stroke(v.outline);
  } else {
    ctx.beginPath();
    if (discPath(ctx, view, p.pos.x, p.pos.y, R)) {
      ctx.fill();
      if (showTex) {
        ctx.save();
        ctx.clip();
        ctx.translate(p.pos.x, p.pos.y);
        ctx.rotate((p.spin ?? 0) * now);
        ctx.scale(R, R);
        ctx.lineWidth = px / R;
        ctx.stroke(v.major);
        ctx.globalAlpha = 0.45;
        ctx.stroke(v.minor);
        ctx.restore();
      }
    }
    ctx.lineWidth = (p.gas ? 1 : 2) * px; // gas giants have no hard edge
    ctx.globalAlpha = p.gas ? 0.6 : 1;
    ctx.beginPath();
    if (arcPath(ctx, view, p.pos.x, p.pos.y, R)) ctx.stroke();
    ctx.globalAlpha = 1;
  }
  ctx.restore();

  if (drawRings) { // front half of the rings passes in front of the planet
    ctx.save();
    ctx.translate(p.pos.x, p.pos.y);
    ctx.rotate(p.seed % 2 ? v.rings.tilt : -v.rings.tilt);
    ctx.strokeStyle = color;
    ctx.globalAlpha = 0.9;
    ctx.lineWidth = px * 1.5;
    ringEllipse(ctx, v.rings, R, 0, Math.PI);
    ctx.restore();
  }
}
