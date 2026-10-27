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

/** 'rgba(r,g,b,a)' or '#rrggbb' -> 'rgba(r,g,b,alpha)' */
const rgbCache = new Map();
export function tint(color, alpha) {
  let rgb = rgbCache.get(color);
  if (!rgb) {
    if (color[0] === '#') {
      const h = color.length === 4 ? color.slice(1).split('').map((c) => c + c).join('') : color.slice(1, 7);
      rgb = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)).join(',');
    } else rgb = color.replace(/^rgba?\(/, '').split(',').slice(0, 3).join(',');
    rgbCache.set(color, rgb);
  }
  return `rgba(${rgb},${alpha})`;
}

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
  else if (p.lava) kind = rng.choose(['cracks', 'cracks', 'craters']);
  else if (p.climate === 'frozen') kind = rng.choose(['cracks', 'craters', 'swirl']);
  else if (p.living) kind = rng.choose(['continents', 'ocean']);
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
  if (rings) { // bands of different density, with a dark division somewhere in the middle
    const n = rng.int(4, 8), gap = rng.int(1, n - 1);
    rings.bands = [];
    for (let i = 0; i < n; i++) {
      if (i === gap) continue;
      rings.bands.push({ k: rings.inner + (rings.width * (i + 0.5)) / n, w: (rings.width / n) * rng.range(0.7, 1), a: rng.range(0.12, 0.42) });
    }
  }
  const major = new Path2D(), minor = new Path2D();
  builders[kind](rng, major, minor);
  // gas giants: soft filled bands and a big storm
  let bands = null, storm = null;
  if (kind === 'gas' || (p.gas && kind === 'swirl')) {
    bands = new Path2D();
    const n = rng.int(3, 7);
    for (let i = 0; i < n; i++) {
      const y = -0.9 + (1.8 * (i + rng.range(0.1, 0.6))) / n, hgt = rng.range(0.05, 0.16);
      bands.rect(-1.1, y, 2.2, hgt);
    }
    if (rng() < 0.7) storm = { x: rng.range(-0.45, 0.45), y: rng.range(-0.55, 0.55), r: rng.range(0.08, 0.2) };
  }
  // clouds for worlds with air (they drift faster than the ground turns)
  let clouds = null;
  if (p.atmo && !p.gas) {
    clouds = new Path2D();
    const n = rng.int(4, 9);
    for (let i = 0; i < n; i++) {
      const y = rng.range(-0.8, 0.8), x0 = rng.range(-0.9, 0.3), len = rng.range(0.25, 0.8);
      for (let k = 0; k <= 12; k++) {
        const x = x0 + (len * k) / 12, yy = y + Math.sin(k * 0.7 + i) * 0.03;
        if (k === 0) clouds.moveTo(x, yy); else clouds.lineTo(x, yy);
      }
    }
  }
  // city lights on the night side of inhabited worlds
  const cities = p.living ? Array.from({ length: rng.int(10, 26) }, () => {
    const a = rng() * PI2, d = Math.sqrt(rng()) * 0.85;
    return [Math.cos(a) * d, Math.sin(a) * d, rng.range(0.008, 0.02)];
  }) : null;
  return (p.vis = { kind, lumpy: small, outline, rings, major, minor, bands, storm, clouds, cities });
}

function drawRings(ctx, p, v, R, color, px, front) {
  const r = v.rings;
  ctx.save();
  ctx.translate(p.pos.x, p.pos.y);
  ctx.rotate(p.seed % 2 ? r.tilt : -r.tilt);
  ctx.scale(1, r.ry);
  const [s, e] = front ? [0, Math.PI] : [Math.PI, PI2];
  if (r.bands) {
    for (const b of r.bands) {
      ctx.strokeStyle = tint(color, b.a * (front ? 1 : 0.7));
      ctx.lineWidth = b.w * R;
      ctx.beginPath(); ctx.arc(0, 0, R * b.k, s, e); ctx.stroke();
    }
  }
  ctx.strokeStyle = tint(color, front ? 0.9 : 0.5);
  ctx.lineWidth = px * 1.2;
  for (const k of [r.inner, r.inner + r.width]) { ctx.beginPath(); ctx.arc(0, 0, R * k, s, e); ctx.stroke(); }
  ctx.restore();
}

/**
 * Draw planet body, surface texture (if `showTex`) and rings. `light` is the position of the star
 * lighting it (day side, night side, a bright rim); `dim` is how strong that light is.
 */
export function drawPlanetBody(ctx, p, view, px, showTex, color, voidColor, now = 0, light = null, explored = true) {
  const v = visual(p), R = p.radius;
  const ringReach = Math.max(v.rings ? v.rings.inner + v.rings.width : 1, p.atmo ? 1 + (p.atmo.top * 1.3) / R : 1);
  if (!inView(view, p.pos.x, p.pos.y, R * ringReach)) return;
  const lumpy = v.lumpy, lite = view.lite;
  const onScreen = R * view.zoom;
  const showRings = v.rings && R * ringReach * view.zoom < 3000; // not worth it when huge on screen
  const la = light ? Math.atan2(light.y - p.pos.y, light.x - p.pos.x) : null;
  ctx.save();

  if (showRings) drawRings(ctx, p, v, R, color, px, false);

  if (p.atmo && !lite) { // atmosphere: a soft glow plus a few fading shells, thicker air = brighter
    const top = p.atmo.top, a = Math.min(0.6, 0.15 + p.atmo.rho0 * 0.5);
    const haze = p.haze ?? color;
    if (onScreen > 6 && onScreen < 4000) {
      const g = ctx.createRadialGradient(p.pos.x, p.pos.y, R * 0.98, p.pos.x, p.pos.y, R + top * 1.25);
      g.addColorStop(0, tint(haze, a * 0.55));
      g.addColorStop(0.35, tint(haze, a * 0.18));
      g.addColorStop(1, tint(haze, 0));
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(p.pos.x, p.pos.y, R + top * 1.25, 0, PI2); ctx.fill();
    }
    ctx.strokeStyle = haze;
    ctx.lineWidth = 1.2 * px;
    for (const k of [0.45, 1]) {
      ctx.globalAlpha = a * (1.05 - k) * 0.6;
      ctx.beginPath();
      if (arcPath(ctx, view, p.pos.x, p.pos.y, R + top * k)) ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  // body: dark disc with a faint wash of the planet's colour
  ctx.lineJoin = 'round';
  const bodyPath = () => {
    ctx.beginPath();
    if (lumpy) { ctx.save(); ctx.translate(p.pos.x, p.pos.y); ctx.scale(R, R); ctx.restore(); }
    return lumpy ? true : discPath(ctx, view, p.pos.x, p.pos.y, R);
  };
  const lumpPath = lumpy ? (() => { const m = new Path2D(); m.addPath(v.outline, new DOMMatrix([R, 0, 0, R, p.pos.x, p.pos.y])); return m; })() : null;
  let visible = true;
  if (lumpy) { ctx.fillStyle = voidColor; ctx.fill(lumpPath); ctx.fillStyle = tint(color, explored ? 0.1 : 0.05); ctx.fill(lumpPath); }
  else {
    visible = bodyPath();
    if (visible) { ctx.fillStyle = voidColor; ctx.fill(); ctx.fillStyle = tint(color, explored ? (p.gas ? 0.13 : 0.09) : 0.04); ctx.fill(); }
  }

  if (visible && !lite && (showTex || light)) {
    ctx.save();
    if (lumpy) ctx.clip(lumpPath); else { bodyPath(); ctx.clip(); }
    if (showTex) {
      ctx.save();
      ctx.translate(p.pos.x, p.pos.y);
      ctx.rotate((p.spin ?? 0) * now);
      ctx.scale(R, R);
      const texA = explored ? 1 : 0.35;
      if (v.bands) { ctx.fillStyle = tint(color, 0.1 * texA); ctx.fill(v.bands); }
      if (v.storm) {
        ctx.fillStyle = tint(color, 0.22 * texA);
        ctx.beginPath(); ctx.ellipse(v.storm.x, v.storm.y, v.storm.r, v.storm.r * 0.6, 0, 0, PI2); ctx.fill();
      }
      if (p.storm?.on) { // an active storm: a churning bright spiral with lightning in it
        const st = p.storm, sx = Math.cos(st.a) * 0.45, sy = Math.sin(st.a) * 0.45;
        ctx.save();
        ctx.translate(sx, sy);
        ctx.rotate(now * 0.6);
        ctx.strokeStyle = tint(color, 0.8); ctx.lineWidth = (1.6 * px) / R;
        ctx.beginPath();
        for (let t = 0; t <= 50; t++) { const r = (t / 50) * st.size, th = t * 0.35; if (t === 0) ctx.moveTo(0, 0); else ctx.lineTo(Math.cos(th) * r, Math.sin(th) * r * 0.7); }
        ctx.stroke();
        if (Math.random() < 0.18) {
          ctx.globalCompositeOperation = 'lighter';
          ctx.fillStyle = 'rgba(220,235,255,0.75)';
          ctx.beginPath(); ctx.arc((Math.random() - 0.5) * st.size, (Math.random() - 0.5) * st.size * 0.6, st.size * 0.35, 0, PI2); ctx.fill();
          ctx.globalCompositeOperation = 'source-over';
        }
        ctx.restore();
      }
      ctx.strokeStyle = color;
      ctx.lineWidth = px / R;
      ctx.globalAlpha = texA;
      ctx.stroke(v.major);
      ctx.globalAlpha = 0.45 * texA;
      ctx.stroke(v.minor);
      if (p.lava && explored) { // molten world: the cracks glow
        ctx.globalCompositeOperation = 'lighter';
        ctx.globalAlpha = 0.55 + 0.2 * Math.sin(now * 1.7 + p.seed);
        ctx.strokeStyle = '#ff7a2a';
        ctx.lineWidth = (2.6 * px) / R;
        ctx.stroke(v.major);
        ctx.globalCompositeOperation = 'source-over';
      }
      ctx.globalAlpha = 1;
      // impact scars: glowing when fresh, then a dark ring that stays
      if (p.impacts) {
        for (const im of p.impacts) {
          const age = now - im.t, x = Math.cos(im.a) * 0.96, y = Math.sin(im.a) * 0.96, r = im.size / R;
          if (age < 45) {
            ctx.globalCompositeOperation = 'lighter';
            ctx.fillStyle = `rgba(255,140,60,${0.7 * (1 - age / 45)})`;
            ctx.beginPath(); ctx.arc(x, y, r * (1 + age / 90), 0, PI2); ctx.fill();
            ctx.globalCompositeOperation = 'source-over';
          }
          ctx.strokeStyle = tint(color, 0.7);
          ctx.lineWidth = (1.4 * px) / R;
          ctx.beginPath(); ctx.arc(x, y, r, 0, PI2); ctx.stroke();
        }
      }
      ctx.restore();
      // ice caps (they do not turn with the ground): bigger in winter, far out on the orbit
      if (!p.gas && explored && ['temperate', 'cold', 'frozen'].includes(p.climate)) {
        const base = p.climate === 'frozen' ? 0.34 : p.climate === 'cold' ? 0.22 : 0.12;
        const cap = Math.min(0.75, Math.max(0.04, base / (p.season ?? 1) ** 2));
        ctx.save();
        ctx.translate(p.pos.x, p.pos.y); ctx.scale(R, R);
        ctx.fillStyle = 'rgba(235,245,255,0.38)';
        ctx.beginPath(); ctx.ellipse(0, -1, 1.05, cap, 0, 0, PI2); ctx.ellipse(0, 1, 1.05, cap * 0.85, 0, 0, PI2); ctx.fill();
        ctx.restore();
      }
      if (p.tideMoon && v.kind === 'ocean' && explored) { // the sea heaps up toward the moon (and away from it)
        const m = p.tideMoon, ta = Math.atan2(m.pos.y - p.pos.y, m.pos.x - p.pos.x);
        ctx.save();
        ctx.translate(p.pos.x, p.pos.y); ctx.rotate(ta);
        ctx.strokeStyle = tint(color, 0.35); ctx.lineWidth = 2 * px;
        ctx.beginPath(); ctx.ellipse(0, 0, R * 1.0, R * 0.93, 0, 0, PI2); ctx.stroke();
        ctx.restore();
      }
      if (v.clouds && explored) { // clouds drift a little faster than the ground
        ctx.save();
        ctx.translate(p.pos.x, p.pos.y);
        ctx.rotate((p.spin ?? 0.02) * now * 1.6 + 0.7);
        ctx.scale(R, R);
        ctx.strokeStyle = 'rgba(255,255,255,0.32)';
        ctx.lineWidth = (2.2 * px) / R;
        ctx.lineCap = 'round';
        ctx.stroke(v.clouds);
        ctx.restore();
      }
    }
    if (light) { // day side glows a little, night side falls into shadow
      const dx = Math.cos(la), dy = Math.sin(la);
      const day = ctx.createLinearGradient(p.pos.x + dx * R, p.pos.y + dy * R, p.pos.x, p.pos.y);
      day.addColorStop(0, tint(color, (explored ? 0.26 : 0.12) * light.k));
      day.addColorStop(1, tint(color, 0));
      ctx.fillStyle = day;
      ctx.fillRect(p.pos.x - R * 1.1, p.pos.y - R * 1.1, R * 2.2, R * 2.2);
      const g = ctx.createLinearGradient(p.pos.x + dx * R * 0.35, p.pos.y + dy * R * 0.35, p.pos.x - dx * R, p.pos.y - dy * R);
      g.addColorStop(0, tint(voidColor, 0));
      g.addColorStop(0.45, tint(voidColor, 0.62 * light.k));
      g.addColorStop(1, tint(voidColor, 0.86 * light.k));
      ctx.fillStyle = g;
      ctx.fillRect(p.pos.x - R * 1.1, p.pos.y - R * 1.1, R * 2.2, R * 2.2);
      if (v.cities && explored && showTex) { // lights in the dark
        const rot = (p.spin ?? 0) * now;
        ctx.fillStyle = '#ffd98a';
        for (const [cx, cy, cr] of v.cities) {
          const x = cx * Math.cos(rot) - cy * Math.sin(rot), y = cx * Math.sin(rot) + cy * Math.cos(rot);
          const night = -(x * dx + y * dy);
          if (night < 0.15) continue;
          ctx.globalAlpha = Math.min(1, (night - 0.15) * 3) * 0.85;
          ctx.beginPath(); ctx.arc(p.pos.x + x * R, p.pos.y + y * R, Math.max(cr * R, 1.2 * px), 0, PI2); ctx.fill();
        }
        ctx.globalAlpha = 1;
      }
    }
    ctx.restore();
  }

  // outline: dim all round, bright on the lit limb
  ctx.strokeStyle = color;
  if (lumpy) {
    ctx.lineWidth = 2 * px;
    ctx.globalAlpha = light ? 0.6 : 1;
    ctx.stroke(lumpPath);
  } else {
    ctx.lineWidth = (p.gas ? 1 : 1.6) * px;
    ctx.globalAlpha = p.gas ? 0.45 : light ? 0.55 : 1;
    ctx.beginPath();
    if (arcPath(ctx, view, p.pos.x, p.pos.y, R)) ctx.stroke();
  }
  ctx.globalAlpha = 1;
  if (light && !lite && onScreen > 3 && onScreen < 6000) {
    ctx.lineWidth = (onScreen > 40 ? 2.6 : 2) * px;
    ctx.strokeStyle = tint(color, 0.95);
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.arc(p.pos.x, p.pos.y, R, la - 1.25, la + 1.25);
    ctx.stroke();
    ctx.lineCap = 'butt';
  }
  ctx.restore();

  if (showRings) drawRings(ctx, p, v, R, color, px, true);
}
