import { PI2, lerp, clamp, mag, sub, dist, angleOf, makeRng } from './maths.js';
import {
  GRAVITATION, SPACECRAFT_MASS, UNIVERSE_RANGE, CRAFT_SPEED_LIMIT, CONSUME_TIME,
} from './universe.js';
import { drawPlanetBody, tint } from './planetart.js';
import { drawShip } from './ships.js';
import { makeView, arcPath, discPath, inView } from './view.js';

export const COLORS = {
  void: '#16161d',
  grid: '#292936',
  orbit: '#3c3c4f',
  unexplored: '#a7a7ca',
  console: '#b7b7ff',
  autopilot: '#4c8df6',
  track: '#3fb56a',
  flag: '#b8f23a',
  rock: '#8f8fae',
};

const STAR_POINTS = 37;
const BINS = 720; // must match the belt bins in universe.js

function starPoints(r1, r2, n) {
  const step = PI2 / n, pts = [];
  for (let i = 0; i < n; i++) {
    pts.push([r1 * Math.cos(step * i), r1 * Math.sin(step * i)]);
    pts.push([r2 * Math.cos(step * (i + 0.5)), r2 * Math.sin(step * (i + 0.5))]);
  }
  return pts;
}

// closed path with softened corners (stand-in for a corner path effect)
function roundedClosedPath(ctx, pts) {
  const n = pts.length;
  const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  const start = mid(pts[n - 1], pts[0]);
  ctx.beginPath();
  ctx.moveTo(start[0], start[1]);
  for (let i = 0; i < n; i++) {
    const m = mid(pts[i], pts[(i + 1) % n]);
    ctx.quadraticCurveTo(pts[i][0], pts[i][1], m[0], m[1]);
  }
  ctx.closePath();
}

function gravitationalField(ctx, view, body, now, px, rgb = '255,0,0') {
  if (view.lite) return;
  const rings = 10;
  for (let i = 0; i < rings; i++) {
    const force = lerp(2000, 0.01, (i - (now % 1)) / rings);
    const r = Math.sqrt((GRAVITATION * body.mass * SPACECRAFT_MASS) / force);
    if (r * view.zoom < 2) continue;
    ctx.strokeStyle = `rgba(${rgb},${lerp(0.75, 0.1, i / rings)})`;
    ctx.lineWidth = 2 * px;
    ctx.beginPath();
    if (arcPath(ctx, view, body.pos.x, body.pos.y, r)) ctx.stroke();
  }
}

function lightFor(u, p) {
  let best = null, bd = Infinity;
  for (const s of u.stars) {
    if (s.isBlackHole) continue;
    const d = dist(s.pos, p.pos);
    if (d < bd) { bd = d; best = s; }
  }
  if (best) return { x: best.pos.x, y: best.pos.y, k: 1 };
  const bh = u.blackHoles[0]; // only an accretion disk to see by
  return bh ? { x: bh.pos.x, y: bh.pos.y, k: 0.7 } : null;
}

function drawPlanet(ctx, view, p, u, px) {
  const drawColor = p.explored ? p.color : COLORS.unexplored;
  ctx.strokeStyle = COLORS.orbit;
  ctx.lineWidth = px;
  ctx.beginPath();
  const c = p.orbitCenter;
  if (arcPath(ctx, view, c.x, c.y, p.orbitRadius)) ctx.stroke();

  gravitationalField(ctx, view, p, u.now, px);
  const showTex = !view.lite && p.radius * view.zoom > 12;
  drawPlanetBody(ctx, p, view, px, showTex, drawColor, COLORS.void, u.now, view.lite ? null : lightFor(u, p), p.explored);
}

function drawStar(ctx, view, star, now, px) {
  const { x, y } = star.pos;
  gravitationalField(ctx, view, star, now, px);
  if (!inView(view, x, y, star.radius + 300)) return;
  ctx.fillStyle = star.color;
  ctx.beginPath();
  if (discPath(ctx, view, x, y, star.radius)) ctx.fill();
  if (view.lite) return;
  ctx.save();
  ctx.translate(x, y);
  ctx.strokeStyle = star.color;
  ctx.lineWidth = 3 * px;
  ctx.rotate((star.anim / 23) * PI2);
  roundedClosedPath(ctx, starPoints(star.radius + 80, star.radius + 250, STAR_POINTS));
  ctx.stroke();
  ctx.rotate((star.anim / -19) * PI2 - (star.anim / 23) * PI2);
  roundedClosedPath(ctx, starPoints(star.radius + 20, star.radius + 200, STAR_POINTS + 1));
  ctx.stroke();
  ctx.restore();
}

// ---- black hole -------------------------------------------------------------------------
// Looks nothing like a planet: a pure-black horizon, a thin bright photon ring, a tilted
// glowing accretion disk whose far side is bent over and under the hole (gravitational
// lensing), orbiting hot specks, a faint glow, and violet instead of red gravity rings.
const DISK_RINGS = 14, DISK_TILT_RATIO = 0.26;
const diskColor = (t, a) => `hsla(${lerp(48, 14, t)},100%,${lerp(88, 52, t)}%,${a})`;

function diskHalf(ctx, rh, back, px) {
  const inner = rh * 1.7, outer = rh * 4.6;
  const [s, e] = back ? [Math.PI, PI2] : [0, Math.PI];
  const [bs, be] = back ? [PI2 * 0.75, PI2] : [0, PI2 * 0.25]; // the side moving toward us is brighter
  for (let i = 0; i < DISK_RINGS; i++) {
    const t = i / (DISK_RINGS - 1), r = lerp(inner, outer, t), a = lerp(0.9, 0.25, t);
    ctx.lineWidth = px * lerp(1.8, 1, t);
    ctx.strokeStyle = diskColor(t, a * 0.55);
    ctx.beginPath();
    ctx.ellipse(0, 0, r, r * DISK_TILT_RATIO, 0, s, e);
    ctx.stroke();
    ctx.strokeStyle = diskColor(t, a);
    ctx.beginPath();
    ctx.ellipse(0, 0, r, r * DISK_TILT_RATIO, 0, bs, be);
    ctx.stroke();
  }
}

function diskSpecks(ctx, rh, now, front, px) {
  ctx.fillStyle = '#fff4d8';
  for (let i = 0; i < 64; i++) {
    const t = (i * 0.6180339) % 1, r = lerp(rh * 1.7, rh * 4.6, t ** 0.8);
    const a = i * 2.399 + now * 1.6 / (r / rh) ** 1.5;
    const sy = Math.sin(a);
    if ((sy > 0) !== front) continue;
    ctx.globalAlpha = 0.9 - t * 0.5;
    ctx.beginPath();
    ctx.arc(Math.cos(a) * r, sy * r * DISK_TILT_RATIO, 1.6 * px, 0, PI2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}

function drawBlackHole(ctx, view, bh, now, px) {
  const rh = bh.radius, { x, y } = bh.pos;
  gravitationalField(ctx, view, bh, now, px, '170,120,255');
  if (!inView(view, x, y, rh * 7)) return;
  ctx.save();
  ctx.translate(x, y);
  if (view.lite) { // just the black disc and its bright rim
    ctx.fillStyle = '#000'; ctx.strokeStyle = '#fff4d8'; ctx.lineWidth = 2 * px;
    ctx.beginPath(); ctx.arc(0, 0, rh, 0, PI2); ctx.fill(); ctx.stroke();
    ctx.restore();
    return;
  }
  if (rh * 6 * view.zoom < 3500) { // soft glow
    const g = ctx.createRadialGradient(0, 0, rh * 0.9, 0, 0, rh * 6);
    g.addColorStop(0, 'rgba(255,170,70,0.30)');
    g.addColorStop(0.35, 'rgba(255,120,30,0.10)');
    g.addColorStop(1, 'rgba(255,100,20,0)');
    ctx.globalCompositeOperation = 'lighter';
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(0, 0, rh * 6, 0, PI2);
    ctx.fill();
    ctx.globalCompositeOperation = 'source-over';
  }
  ctx.rotate(bh.tilt);
  const showDisk = rh * 4.6 * view.zoom < 6000;
  if (showDisk) { diskHalf(ctx, rh, true, px); diskSpecks(ctx, rh, now, false, px); }

  // lensed image of the far side of the disk, bent over the top and under the bottom
  if (showDisk) {
    for (let i = 0; i < 4; i++) {
      const t = i / 3;
      ctx.lineWidth = px * lerp(2, 1, t);
      ctx.strokeStyle = diskColor(t * 0.5, lerp(0.85, 0.3, t));
      ctx.beginPath();
      ctx.arc(0, 0, rh * lerp(1.18, 1.75, t), Math.PI + 0.22, PI2 - 0.22);
      ctx.stroke();
      ctx.strokeStyle = diskColor(t * 0.5, lerp(0.5, 0.15, t));
      ctx.beginPath();
      ctx.arc(0, 0, rh * lerp(1.1, 1.4, t), 0.5, Math.PI - 0.5);
      ctx.stroke();
    }
  }

  ctx.fillStyle = '#000';
  ctx.beginPath();
  ctx.arc(0, 0, rh, 0, PI2);
  ctx.fill();
  ctx.strokeStyle = '#fff4d8'; // photon ring
  ctx.lineWidth = 2.2 * px;
  ctx.beginPath();
  ctx.arc(0, 0, rh * 1.03, 0, PI2);
  ctx.stroke();
  ctx.strokeStyle = 'rgba(255,220,160,0.35)';
  ctx.lineWidth = 5 * px;
  ctx.beginPath();
  ctx.arc(0, 0, rh * 1.09, 0, PI2);
  ctx.stroke();

  if (showDisk) { diskHalf(ctx, rh, false, px); diskSpecks(ctx, rh, now, true, px); }
  ctx.restore();
}

// ---- asteroid belts ---------------------------------------------------------------------
let rockShapes = null;
function getRockShapes() {
  if (rockShapes) return rockShapes;
  const rng = makeRng(77);
  rockShapes = Array.from({ length: 6 }, () => {
    const p = new Path2D(), n = 7 + rng.int(0, 3);
    for (let i = 0; i < n; i++) {
      const a = (PI2 * i) / n, r = rng.range(0.6, 1);
      if (i === 0) p.moveTo(Math.cos(a) * r, Math.sin(a) * r); else p.lineTo(Math.cos(a) * r, Math.sin(a) * r);
    }
    p.closePath();
    return p;
  });
  return rockShapes;
}

function drawBelt(ctx, view, belt, now, px) {
  const rr = Math.hypot(view.cx, view.cy);
  if (Math.abs(rr - belt.radius) > belt.width / 2 + belt.maxWake + view.h + 50) return;
  const shapes = getRockShapes();
  ctx.strokeStyle = belt.trojan ? '#a9a0c8' : COLORS.rock;
  ctx.fillStyle = ctx.strokeStyle;
  const dots = new Path2D();
  const lx = view.halfW + 50, ly = view.halfH + 50;
  // only walk the angular bins that can be on screen
  let b0 = 0, b1 = BINS - 1;
  if (rr > view.h + 60) {
    const half = Math.asin(Math.min(1, (view.h + 60) / rr)) + belt.libMax, centre = Math.atan2(view.cy, view.cx) - belt.omega * now;
    b0 = Math.floor(((centre - half) / PI2) * BINS); b1 = Math.floor(((centre + half) / PI2) * BINS);
  }
  for (let b = b0; b <= b1; b++) {
    for (const i of belt.bins[((b % BINS) + BINS) % BINS]) {
      if (belt.gone[i]) continue;
      const a = belt.angle(i, now), r = belt.rAt(i, a), s = belt.size[i];
      const x = Math.cos(a) * r, y = Math.sin(a) * r;
      if (Math.abs(x - view.cx) > lx + s || Math.abs(y - view.cy) > ly + s) continue;
      if (view.lite || s * view.zoom < 1.8) { dots.rect(x - px, y - px, 2 * px, 2 * px); continue; }
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(a * 3 + i);
      ctx.scale(s, s);
      ctx.lineWidth = (1.4 * px) / s;
      ctx.stroke(shapes[belt.shape[i]]);
      ctx.restore();
    }
  }
  ctx.fill(dots);
}

// ---- comets and loose rocks ---------------------------------------------------------------
function drawDebris(ctx, u, view, px) {
  const shapes = getRockShapes();
  for (const it of u.debris.items) {
    const { x, y } = it.pos;
    if (it.kind === 'comet') {
      // the tail points away from the star and grows as the comet falls inward
      let sx = 0, sy = 0, sd = Infinity;
      for (const s of u.stars) { const d = dist(s.pos, it.pos); if (d < sd) { sd = d; sx = s.pos.x; sy = s.pos.y; } }
      const k = Math.min(4, (55_000 / Math.max(sd, 1)) ** 2);
      const len = 500 + 2600 * k, ax = (x - sx) / sd, ay = (y - sy) / sd;
      if (!inView(view, x, y, len + 200)) continue;
      if (!view.lite) {
        // dust tail: the curved path it has followed
        const t = it.tail;
        if (t.length > 2) {
          ctx.lineCap = 'round';
          for (let i = Math.max(1, t.length - 40); i < t.length; i++) {
            const f = (i - (t.length - 40)) / 40;
            ctx.strokeStyle = `rgba(255,236,200,${0.22 * f * Math.min(1, k)})`;
            ctx.lineWidth = Math.max(px, it.size * (0.4 + f));
            ctx.beginPath(); ctx.moveTo(t[i - 1].x, t[i - 1].y); ctx.lineTo(t[i].x, t[i].y); ctx.stroke();
          }
          ctx.lineCap = 'butt';
        }
        // ion tail: straight, blue, anti-sunward
        const g = ctx.createLinearGradient(x, y, x + ax * len, y + ay * len);
        g.addColorStop(0, `hsla(${it.hue},90%,80%,${0.55 * Math.min(1, 0.3 + k)})`);
        g.addColorStop(1, `hsla(${it.hue},90%,70%,0)`);
        ctx.fillStyle = g;
        const wdt = it.size * (1.2 + k * 0.6);
        ctx.beginPath();
        ctx.moveTo(x - ay * wdt * 0.5, y + ax * wdt * 0.5);
        ctx.lineTo(x + ax * len - ay * wdt * 2, y + ay * len + ax * wdt * 2);
        ctx.lineTo(x + ax * len + ay * wdt * 2, y + ay * len - ax * wdt * 2);
        ctx.lineTo(x + ay * wdt * 0.5, y - ax * wdt * 0.5);
        ctx.fill();
        // coma
        const cr = it.size * (3 + k);
        const c = ctx.createRadialGradient(x, y, 0, x, y, cr);
        c.addColorStop(0, `hsla(${it.hue},80%,90%,0.55)`);
        c.addColorStop(1, `hsla(${it.hue},80%,80%,0)`);
        ctx.fillStyle = c;
        ctx.beginPath(); ctx.arc(x, y, cr, 0, PI2); ctx.fill();
      }
      ctx.save();
      ctx.translate(x, y); ctx.rotate(it.rot);
      const s = Math.max(it.size, 3 * px);
      ctx.scale(s, s);
      ctx.fillStyle = COLORS.void; ctx.fill(shapes[it.shape]);
      ctx.strokeStyle = `hsl(${it.hue},60%,85%)`; ctx.lineWidth = (1.6 * px) / s; ctx.stroke(shapes[it.shape]);
      ctx.restore();
      if (!view.lite && view.zoom > 0.008) {
        ctx.save(); ctx.translate(x, y); ctx.scale(px, px);
        ctx.fillStyle = `hsla(${it.hue},70%,85%,0.75)`; ctx.font = '10px ui-monospace, Menlo, monospace'; ctx.textAlign = 'center';
        ctx.fillText(`COMET ${it.name}`, 0, -Math.max(16, it.size * view.zoom + 10));
        ctx.restore();
      }
      continue;
    }
    if (!inView(view, x, y, it.size + 10)) continue;
    const s = it.size;
    if (s * view.zoom < 1.8) { ctx.fillStyle = '#d8b48a'; ctx.fillRect(x - px, y - px, 2 * px, 2 * px); continue; }
    ctx.save();
    ctx.translate(x, y); ctx.rotate(it.rot); ctx.scale(s, s);
    ctx.strokeStyle = '#d8b48a'; ctx.lineWidth = (1.4 * px) / s;
    ctx.globalAlpha = Math.min(1, (it.life ?? 60) / 20);
    ctx.stroke(shapes[it.shape]);
    ctx.restore();
  }
}

// ---- predicted path ------------------------------------------------------------------------
const PRED = '#7fe3ff';
const fmtD = (n) => (n >= 10_000 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${Math.round(n)}`);

function label(ctx, x, y, px, text, color, dy = -12) {
  ctx.save(); ctx.translate(x, y); ctx.scale(px, px);
  ctx.fillStyle = color; ctx.font = '10px ui-monospace, Menlo, monospace'; ctx.textAlign = 'center';
  ctx.fillText(text, 0, dy);
  ctx.restore();
}

function polyline(ctx, pts, ox, oy, px, alphaFrom, alphaTo) {
  const n = pts.length;
  if (n < 2) return;
  const B = 6;
  for (let b = 0; b < B; b++) {
    const i0 = Math.floor((n * b) / B), i1 = Math.min(n - 1, Math.floor((n * (b + 1)) / B));
    if (i1 <= i0) continue;
    ctx.strokeStyle = tint(PRED, lerp(alphaFrom, alphaTo, b / (B - 1)));
    ctx.beginPath();
    ctx.moveTo(pts[i0].x + ox, pts[i0].y + oy);
    for (let i = i0 + 1; i <= i1; i++) ctx.lineTo(pts[i].x + ox, pts[i].y + oy);
    ctx.stroke();
  }
}

function cross(ctx, x, y, px, color) {
  ctx.strokeStyle = color; ctx.lineWidth = 2 * px;
  const s = 6 * px;
  ctx.beginPath(); ctx.moveTo(x - s, y - s); ctx.lineTo(x + s, y + s); ctx.moveTo(x + s, y - s); ctx.lineTo(x - s, y + s); ctx.stroke();
}

function drawOrbit(ctx, o, cx, cy, px) {
  ctx.lineWidth = 1.6 * px;
  ctx.setLineDash(o.end === 'impact' ? [10 * px, 6 * px] : []);
  polyline(ctx, o.pts, cx, cy, px, 0.85, o.e < 1 && !o.end ? 0.35 : 0.12);
  ctx.setLineDash([]);
  const R = o.body.radius;
  if (o.end !== 'impact' && o.pe > R) {
    const x = cx + o.peAt.x, y = cy + o.peAt.y;
    ctx.fillStyle = PRED; ctx.beginPath(); ctx.arc(x, y, 3 * px, 0, PI2); ctx.fill();
    label(ctx, x, y, px, `Pe ${fmtD(o.pe - R)}`, PRED);
  }
  if (o.apAt && !o.end) {
    const x = cx + o.apAt.x, y = cy + o.apAt.y;
    ctx.strokeStyle = PRED; ctx.lineWidth = 1.4 * px; ctx.beginPath(); ctx.arc(x, y, 3.5 * px, 0, PI2); ctx.stroke();
    label(ctx, x, y, px, `Ap ${fmtD(o.ap - R)}`, PRED);
  }
  if (o.end === 'impact' && o.endAt) cross(ctx, cx + o.endAt.x, cy + o.endAt.y, px, '#ff6a55');
}

function drawPrediction(ctx, pred, px) {
  if (!pred) return;
  if (pred.soi) { drawOrbit(ctx, pred.orbit, pred.soi.pos.x, pred.soi.pos.y, px); return; }
  ctx.lineWidth = 1.5 * px;
  polyline(ctx, pred.pts, 0, 0, px, 0.75, pred.encounter ? 0.5 : 0.04);
  const ghost = (g, body, text) => {
    ctx.strokeStyle = tint(PRED, 0.45); ctx.lineWidth = 1.2 * px; ctx.setLineDash([6 * px, 6 * px]);
    ctx.beginPath(); ctx.arc(g.x, g.y, body.radius, 0, PI2); ctx.stroke(); ctx.setLineDash([]);
    label(ctx, g.x, g.y, px, text, tint(PRED, 0.85), -Math.max(14, body.radius / px + 8));
  };
  if (pred.encounter) {
    const e = pred.encounter;
    ghost(e.ghost, e.body, `${e.body.name.toUpperCase()} in ${Math.round(e.t)}s`);
    if (e.orbit) drawOrbit(ctx, e.orbit, e.ghost.x, e.ghost.y, px);
  } else if (pred.closest && pred.closest.d < 25_000) {
    const c = pred.closest;
    ghost(c.ghost, c.body, `closest ${fmtD(Math.max(0, c.d))} in ${Math.round(c.t)}s`);
  }
  if (pred.impact) cross(ctx, pred.impact.x, pred.impact.y, px, '#ff6a55');
}

// prograde / retrograde markers on a ring round the ship, relative to the world you are flying near
function drawShipMarkers(ctx, u, px, ref) {
  const ship = u.ship;
  if (ship.landing || ship.consumed || !ref) return;
  const rv = sub(ship.velocity, ref.velocity ?? { x: 0, y: 0 }), sp = mag(rv);
  if (sp < 15) return;
  const a = Math.atan2(rv.y, rv.x), R = 34 * px;
  const pxp = ship.pos.x + Math.cos(a) * R, pyp = ship.pos.y + Math.sin(a) * R;
  const rxp = ship.pos.x - Math.cos(a) * R, ryp = ship.pos.y - Math.sin(a) * R;
  ctx.lineWidth = 1.4 * px;
  ctx.strokeStyle = 'rgba(74,222,128,0.8)';
  ctx.beginPath(); ctx.arc(pxp, pyp, 4.5 * px, 0, PI2); ctx.stroke();
  ctx.fillStyle = 'rgba(74,222,128,0.8)'; ctx.beginPath(); ctx.arc(pxp, pyp, 1.4 * px, 0, PI2); ctx.fill();
  ctx.strokeStyle = 'rgba(255,200,90,0.7)';
  ctx.beginPath(); ctx.arc(rxp, ryp, 4.5 * px, 0, PI2);
  const s = 3.2 * px;
  ctx.moveTo(rxp - s, ryp - s); ctx.lineTo(rxp + s, ryp + s); ctx.moveTo(rxp + s, ryp - s); ctx.lineTo(rxp - s, ryp + s);
  ctx.stroke();
}

// ---- parallax starfield (screen space) -----------------------------------------------------
const STAR_LAYERS = [
  { f: 0.012, n: 34, size: 0.7, a: 0.3 },
  { f: 0.035, n: 18, size: 1, a: 0.45 },
  { f: 0.085, n: 8, size: 1.4, a: 0.7 },
];
const TILE = 420;
function hash(a, b, c) {
  let h = Math.imul(a, 374761393) + Math.imul(b, 668265263) + Math.imul(c, 1274126177);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return (h ^ (h >>> 16)) >>> 0;
}
function drawStarfield(ctx, cam, w, h, dpr) {
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const sx0 = cam.starX ?? 0, sy0 = cam.starY ?? 0, stx = cam.streak?.x ?? 0, sty = cam.streak?.y ?? 0;
  for (let l = 0; l < STAR_LAYERS.length; l++) {
    const L = STAR_LAYERS[l];
    const ox = sx0 * L.f, oy = sy0 * L.f;
    // motion streaks: how far the layer moves in a short exposure
    let qx = stx * L.f * 0.05, qy = sty * L.f * 0.05;
    const ql = Math.hypot(qx, qy);
    if (ql > 70) { qx *= 70 / ql; qy *= 70 / ql; }
    const streaky = ql > 1.2;
    ctx.strokeStyle = `rgba(200,205,255,${L.a})`; ctx.fillStyle = ctx.strokeStyle; ctx.lineWidth = L.size;
    ctx.beginPath();
    const tx0 = Math.floor(ox / TILE), ty0 = Math.floor(oy / TILE);
    for (let tx = tx0; tx * TILE < ox + w; tx++) {
      for (let ty = ty0; ty * TILE < oy + h; ty++) {
        let s = hash(tx, ty, l + 1);
        for (let i = 0; i < L.n; i++) {
          s = Math.imul(s ^ (s >>> 15), 2246822519) >>> 0;
          s = Math.imul(s ^ (s >>> 13), 3266489917) >>> 0;
          const fx = (s & 0xffff) / 65536, fy = (s >>> 16) / 65536;
          const x = tx * TILE + fx * TILE - ox, y = ty * TILE + fy * TILE - oy;
          if (streaky) { ctx.moveTo(x, y); ctx.lineTo(x - qx, y - qy); } else ctx.rect(x, y, L.size, L.size);
        }
      }
    }
    if (streaky) ctx.stroke(); else ctx.fill();
  }
}

// ---- warped gravity grid ----------------------------------------------------------------
function gridWells(u, view) {
  const out = [];
  const add = (b, R, s) => {
    if (Math.hypot(b.pos.x - view.cx, b.pos.y - view.cy) - R * 6 <= view.h) out.push({ x: b.pos.x, y: b.pos.y, R, s });
  };
  for (const w of u.wells) add(w, w.isBlackHole ? w.radius * 5 : w.radius * 3, w.isBlackHole ? 0.9 : 0.22);
  for (const p of u.planets) if (p.radius > 900) add(p, p.radius * 3, 0.1);
  return out;
}

const warped = { x: 0, y: 0 };
function warp(x, y, wells) {
  for (const w of wells) {
    const dx = w.x - x, dy = w.y - y, d = Math.hypot(dx, dy);
    if (d < 1e-6 || d > w.R * 6) continue;
    const f = w.s * (w.R / (d + w.R)) ** 2; // pull points toward the mass: the grid dips into a well
    x += dx * f; y += dy * f;
  }
  warped.x = x; warped.y = y;
}

function drawGrid(ctx, u, view, px) {
  const { cx, cy, halfW, halfH } = view;
  const left = cx - halfW, right = cx + halfW, top = cy - halfH, bottom = cy + halfH;
  let step = 1000;
  while (step * view.zoom < 32) step *= 10;
  const wells = u.style.warp ? gridWells(u, view) : [];
  ctx.strokeStyle = COLORS.grid;
  const SEG = 56;
  const padX = wells.length ? halfW * 0.5 : 0, padY = wells.length ? halfH * 0.5 : 0;
  for (let x = Math.floor(left / step) * step; x < right; x += step) {
    ctx.lineWidth = (x % (step * 10) === 0 ? 3 : 1.5) * px;
    ctx.beginPath();
    if (!wells.length) { ctx.moveTo(x, top); ctx.lineTo(x, bottom); } else {
      for (let i = 0; i <= SEG; i++) {
        warp(x, top - padY + ((bottom - top + 2 * padY) * i) / SEG, wells);
        if (i === 0) ctx.moveTo(warped.x, warped.y); else ctx.lineTo(warped.x, warped.y);
      }
    }
    ctx.stroke();
  }
  for (let y = Math.floor(top / step) * step; y < bottom; y += step) {
    ctx.lineWidth = (y % (step * 10) === 0 ? 3 : 1.5) * px;
    ctx.beginPath();
    if (!wells.length) { ctx.moveTo(left, y); ctx.lineTo(right, y); } else {
      for (let i = 0; i <= SEG; i++) {
        warp(left - padX + ((right - left + 2 * padX) * i) / SEG, y, wells);
        if (i === 0) ctx.moveTo(warped.x, warped.y); else ctx.lineTo(warped.x, warped.y);
      }
    }
    ctx.stroke();
  }
}

// ---- satellites ---------------------------------------------------------------------------
const SAT_COLORS = { orbiter: '#8fc4ff', geostationary: '#ff9ad0', probe: '#a6f0a0' };

function drawSatellites(ctx, u, view, px) {
  const ship = u.ship;
  for (const sat of u.satellites) {
    const { x, y } = sat.pos;
    if (sat.parent && view.zoom > 0.2 && !view.lite) { // faint orbit track
      ctx.strokeStyle = SAT_COLORS[sat.kind];
      ctx.globalAlpha = 0.14;
      ctx.lineWidth = px;
      ctx.beginPath();
      if (arcPath(ctx, view, sat.parent.pos.x, sat.parent.pos.y, sat.orbit)) ctx.stroke();
      ctx.globalAlpha = 1;
    }
    if (!inView(view, x, y, 60)) continue;
    const s = Math.max(sat.radius, 4 * px);
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(sat.kind === 'probe' ? angleOf(sat.velocity) : sat.angle);
    ctx.strokeStyle = SAT_COLORS[sat.kind];
    ctx.lineWidth = 1.4 * px;
    ctx.beginPath(); // body and two solar panels
    ctx.rect(-s * 0.35, -s * 0.35, s * 0.7, s * 0.7);
    ctx.moveTo(0, -s * 0.35); ctx.lineTo(0, -s * 1.4);
    ctx.moveTo(0, s * 0.35); ctx.lineTo(0, s * 1.4);
    ctx.moveTo(-s * 0.55, -s * 1.4); ctx.lineTo(s * 0.55, -s * 1.4); ctx.lineTo(s * 0.55, -s * 0.9); ctx.lineTo(-s * 0.55, -s * 0.9); ctx.closePath();
    ctx.moveTo(-s * 0.55, s * 1.4); ctx.lineTo(s * 0.55, s * 1.4); ctx.lineTo(s * 0.55, s * 0.9); ctx.lineTo(-s * 0.55, s * 0.9); ctx.closePath();
    if (sat.kind === 'probe') { ctx.moveTo(s * 0.35, 0); ctx.lineTo(s * 1.2, 0); } // dish
    ctx.stroke();
    ctx.restore();
    if (!view.lite && (view.zoom > 0.3 || dist(sat.pos, ship.pos) < 500)) {
      ctx.save();
      ctx.translate(x, y);
      ctx.scale(px, px);
      ctx.fillStyle = SAT_COLORS[sat.kind];
      ctx.globalAlpha = sat.cooldown > 0 ? 0.4 : 0.85;
      ctx.font = '10px ui-monospace, Menlo, monospace';
      ctx.textAlign = 'center';
      ctx.fillText(sat.name + (sat.kind === 'geostationary' ? ' (geo)' : ''), 0, -22);
      ctx.restore();
    }
  }
}

// ---- sparks, ships, trails ----------------------------------------------------------------
function drawSpark(ctx, s, px) {
  if (s.life < 0) return;
  const life = 1 - s.life / s.ttl;
  ctx.strokeStyle = s.color;
  ctx.fillStyle = s.color;
  if (s.style === 'dot') {
    ctx.beginPath();
    ctx.arc(s.pos.x, s.pos.y, s.size, 0, PI2);
    ctx.fill();
  } else if (s.style === 'glow') {
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.fillStyle = `rgba(${s.color},${0.55 * (1 - life)})`;
    ctx.beginPath();
    ctx.arc(s.pos.x, s.pos.y, s.size * (1 + life), 0, PI2);
    ctx.fill();
    ctx.restore();
  } else if (s.style === 'ring') {
    ctx.globalAlpha = 1 - life;
    ctx.lineWidth = px;
    ctx.beginPath();
    ctx.arc(s.pos.x, s.pos.y, Math.exp(lerp(s.size, 3 * s.size, life)) - 1, 0, PI2);
    ctx.stroke();
    ctx.globalAlpha = 1;
  }
}

function drawTrail(ctx, ship, fancy, px, lite = false) {
  const t = ship.track;
  if (t.length < 2) return;
  if (lite) { // one cheap faint line
    ctx.strokeStyle = ship.isAI ? 'rgba(180,180,255,0.3)' : 'rgba(120,230,160,0.6)';
    ctx.lineWidth = px;
    ctx.beginPath();
    for (let i = Math.max(0, t.length - 500); i < t.length; i += 4) {
      if (i === 0 || i === Math.max(0, t.length - 500)) ctx.moveTo(t[i].x, t[i].y); else ctx.lineTo(t[i].x, t[i].y);
    }
    ctx.stroke();
    return;
  }
  if (!fancy) { // classic: consecutive pairs, so it reads as dashes
    ctx.strokeStyle = COLORS.track;
    ctx.lineWidth = px;
    ctx.beginPath();
    for (let i = 0; i + 1 < t.length; i += 2) {
      ctx.moveTo(t[i].x, t[i].y);
      ctx.lineTo(t[i + 1].x, t[i + 1].y);
    }
    ctx.stroke();
    return;
  }
  // fancy: a fading, tapering line coloured by speed (or by hull colour for other ships)
  const B = ship.isAI ? 4 : 8;
  const per = Math.ceil(t.length / B);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (let b = 0; b < B; b++) {
    const from = Math.max(0, b * per - 1), to = Math.min(t.length, (b + 1) * per);
    if (to - from < 2) continue;
    const f = (b + 1) / B;
    const v = t[to - 1].v;
    const hue = ship.isAI ? ship.design.hue ?? 200 : 140 + 150 * Math.min(1, v / CRAFT_SPEED_LIMIT);
    ctx.strokeStyle = `hsla(${hue},70%,${55 + 20 * f}%,${(ship.isAI ? 0.5 : 0.8) * f * f})`;
    ctx.lineWidth = px * (0.6 + 1.6 * f);
    ctx.beginPath();
    ctx.moveTo(t[from].x, t[from].y);
    for (let i = from + 1; i < to; i++) ctx.lineTo(t[i].x, t[i].y);
    ctx.stroke();
  }
  ctx.lineCap = 'butt';
}

function drawSpacecraft(ctx, u, ship, view, px, fancy) {
  if (!inView(view, ship.pos.x, ship.pos.y, 80) && !ship.track.length) return;
  drawTrail(ctx, ship, fancy, px, view.lite);
  if (!inView(view, ship.pos.x, ship.pos.y, 80)) return;
  if ((ship.heatRate ?? 0) > 0.15 && mag(ship.velocity) > 50) { // reentry plasma streaming behind the ship
    const k = Math.min(2.5, ship.heatRate);
    ctx.save();
    ctx.translate(ship.pos.x, ship.pos.y);
    ctx.rotate(angleOf(ship.velocity) + Math.PI);
    ctx.globalCompositeOperation = 'lighter';
    for (let i = 0; i < 3; i++) {
      const len = (14 + 40 * k) * (1 - i * 0.28) * (0.9 + 0.1 * Math.sin(u.now * 40 + i));
      ctx.fillStyle = `rgba(255,${150 + i * 40},${60 + i * 50},${0.35 * Math.min(1, k)})`;
      ctx.beginPath();
      ctx.moveTo(6, -(10 - i * 2)); ctx.lineTo(len, 0); ctx.lineTo(6, 10 - i * 2);
      ctx.fill();
    }
    ctx.restore();
  }
  ctx.save();
  ctx.translate(ship.pos.x, ship.pos.y);
  // tidal stretching toward a nearby black hole (and the final fade)
  let alpha = 1;
  for (const bh of u.blackHoles) {
    const d = dist(bh.pos, ship.pos), rh = bh.radius;
    const s = clamp(1 - (d - rh) / (4 * rh), 0, 1);
    if (s <= 0) continue;
    ctx.rotate(angleOf(sub(bh.pos, ship.pos)));
    ctx.scale(1 + 3.5 * s, 1 / (1 + 2.2 * s));
    ctx.rotate(-angleOf(sub(bh.pos, ship.pos)));
  }
  if (ship.consumed) alpha = 1 - clamp(ship.consumed.t / CONSUME_TIME, 0, 1) ** 2;
  ctx.globalAlpha = alpha;
  ctx.rotate(ship.angle);
  // true scale, with just a tiny floor so your ship never vanishes into a sub-pixel speck
  const k = view.lite ? 1 : Math.max(1, ((ship.isAI ? 2.5 : 4) * px) / 12);
  ctx.scale(k, k);
  drawShip(ctx, ship.design, {
    thrust: ship.effThrust ?? mag(ship.thrust), now: u.now, px: px / k, transit: ship.transit,
    landed: !!ship.landing, fancy, void: COLORS.void,
  });
  ctx.restore();
  if (ship.isAI && view.zoom > 0.25 && !view.lite) { // callsign tag
    ctx.save();
    ctx.translate(ship.pos.x, ship.pos.y);
    ctx.scale(px, px);
    ctx.fillStyle = 'rgba(183,183,255,0.7)';
    ctx.font = '10px ui-monospace, Menlo, monospace';
    ctx.textAlign = 'center';
    ctx.fillText(ship.name, 0, 28);
    ctx.restore();
  }
}

function drawAutopilot(ctx, ap, now, px) {
  const target = ap.target;
  if (!target) return;
  ctx.strokeStyle = COLORS.autopilot;
  ctx.globalAlpha = 0.5;
  ctx.lineWidth = px;
  ctx.save();
  ctx.translate(target.pos.x, target.pos.y);
  ctx.rotate((now * PI2) / 10);
  const r = target.radius + ap.brakingDistance;
  ctx.beginPath();
  for (let i = 0; i < 15; i++) {
    const a = (PI2 / 15) * i;
    if (i === 0) ctx.moveTo(r * Math.cos(a), r * Math.sin(a));
    else ctx.lineTo(r * Math.cos(a), r * Math.sin(a));
  }
  ctx.closePath();
  ctx.stroke();
  ctx.globalAlpha = 0.25;
  ctx.lineWidth = Math.max(ap.landingAltitude, px);
  ctx.beginPath();
  ctx.arc(0, 0, target.radius + ap.landingAltitude / 2, 0, PI2);
  ctx.stroke();
  ctx.restore();
  if (ap.assist && ap.strategy === 'ACQUIRING') { // lock-on reticle
    ctx.save();
    ctx.translate(target.pos.x, target.pos.y);
    const rr = target.radius + 30 * px + (1 - ap.lock) * 60 * px;
    ctx.globalAlpha = 0.9;
    ctx.lineWidth = 2 * px;
    ctx.rotate(now * 2);
    for (let k = 0; k < 4; k++) {
      ctx.beginPath();
      ctx.arc(0, 0, rr, (k * Math.PI) / 2 + 0.15, ((k + 1) * Math.PI) / 2 - 0.15);
      ctx.stroke();
    }
    ctx.rotate(-now * 2);
    ctx.globalAlpha = 0.6;
    ctx.beginPath();
    ctx.arc(0, 0, rr + 8 * px, -Math.PI / 2, -Math.PI / 2 + ap.lock * PI2);
    ctx.stroke();
    ctx.restore();
  }
  ctx.globalAlpha = 0.5;
  ctx.lineWidth = px;
  ctx.beginPath();
  ctx.moveTo(ap.ship.pos.x, ap.ship.pos.y);
  ctx.lineTo(ap.leadingPos.x, ap.leadingPos.y);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(ap.leadingPos.x, ap.leadingPos.y, 5 * px, 0, PI2);
  ctx.stroke();
  ctx.globalAlpha = 1;
}

function drawLanding(ctx, l, px) {
  const p = l.planet;
  const x = p.pos.x + Math.cos(l.angle) * p.radius;
  const y = p.pos.y + Math.sin(l.angle) * p.radius;
  const h = 80;
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(l.angle);
  ctx.strokeStyle = COLORS.flag;
  ctx.lineWidth = 2 * px;
  ctx.beginPath();
  ctx.moveTo(0, 0); ctx.lineTo(h, 0); ctx.lineTo(h * 0.875, h * 0.25); ctx.lineTo(h * 0.75, 0);
  ctx.closePath();
  ctx.stroke();
  ctx.restore();
}

/**
 * Draw the whole scene. `cam` = { x, y, zoom } in world units; w/h are CSS pixels.
 */
export function renderUniverse(ctx, u, cam, w, h, dpr, lite = false, extra = {}) {
  const { zoom } = cam;
  const px = 1 / zoom; // one CSS pixel in world units
  const view = makeView(cam.x, cam.y, w, h, zoom);
  view.lite = lite; // lite: less detail (no grid, gravity rings, textures, glow or labels)
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = COLORS.void;
  ctx.fillRect(0, 0, w * dpr, h * dpr);
  if (!lite || extra.stars) drawStarfield(ctx, cam, w, h, dpr);

  const s = dpr * zoom;
  const shake = u.tidal > 0.15 ? u.tidal * 6 * dpr : 0; // the whole screen trembles near a black hole
  const sx = (shake ? (Math.random() - 0.5) * shake : 0) + (cam.sx ?? 0) * dpr;
  const sy = (shake ? (Math.random() - 0.5) * shake : 0) + (cam.sy ?? 0) * dpr;
  ctx.setTransform(s, 0, 0, s, (w * dpr) / 2 - cam.x * s + sx, (h * dpr) / 2 - cam.y * s + sy);

  if (!lite) drawGrid(ctx, u, view, px);

  for (const l of u.landings) if (l.player) drawLanding(ctx, l, px);

  // ringfence
  if (!lite) {
  ctx.strokeStyle = '#800000';
  ctx.lineWidth = px;
  ctx.setLineDash([8 * px, 8 * px]);
  ctx.beginPath();
  if (arcPath(ctx, view, 0, 0, UNIVERSE_RANGE)) ctx.stroke();
  ctx.setLineDash([]);
  }

  for (const belt of u.belts) drawBelt(ctx, view, belt, u.now, px);
  for (const wl of u.wells) {
    if (wl.isBlackHole) drawBlackHole(ctx, view, wl, u.now, px);
    else drawStar(ctx, view, wl, u.now, px);
  }
  drawSatellites(ctx, u, view, px);
  drawDebris(ctx, u, view, px);
  if (!lite) for (const sp of u.sparks) drawSpark(ctx, sp, px);
  for (const p of u.planets) drawPlanet(ctx, view, p, u, px);
  if (extra.pred) drawPrediction(ctx, extra.pred, px);
  if (!lite && u.ship.autopilot) drawAutopilot(ctx, u.ship.autopilot, u.now, px);
  const fancy = u.style.fancy;
  for (const sh of u.ships) if (sh !== u.ship) drawSpacecraft(ctx, u, sh, view, px, fancy);
  drawSpacecraft(ctx, u, u.ship, view, px, fancy);
  if (!lite && extra.markers) drawShipMarkers(ctx, u, px, extra.ref);
}

export function drawStick(ctx, stick, dpr) {
  if (!stick.active) return;
  const { origin, target, minRadius, maxRadius } = stick;
  const d = sub(target, origin);
  const m = Math.min(maxRadius, mag(d));
  const r = Math.max(minRadius, m);
  const a = Math.atan2(d.y, d.x);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.strokeStyle = '#4ade80';
  ctx.lineWidth = 2;
  ctx.setLineDash(m < minRadius ? [1, 2] : []);
  ctx.beginPath();
  ctx.arc(origin.x, origin.y, r, 0, PI2);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.beginPath();
  ctx.moveTo(origin.x, origin.y);
  ctx.lineTo(origin.x + Math.cos(a) * m, origin.y + Math.sin(a) * m);
  ctx.stroke();
}
