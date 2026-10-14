import { PI2, lerp, mag, sub, dist } from './maths.js';
import {
  GRAVITATION, SPACECRAFT_MASS, UNIVERSE_RANGE, CRAFT_SPEED_LIMIT,
} from './universe.js';
import { drawPlanetBody } from './planetart.js';
import { drawShip } from './ships.js';

export const COLORS = {
  void: '#16161d',
  grid: '#292936',
  orbit: '#3c3c4f',
  unexplored: '#a7a7ca',
  console: '#b7b7ff',
  autopilot: '#4c8df6',
  track: '#3fb56a',
  flag: '#b8f23a',
};

const STAR_POINTS = 37;

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

function gravitationalField(ctx, body, now, px) {
  const rings = 10;
  for (let i = 0; i < rings; i++) {
    const force = lerp(2000, 0.01, (i - (now % 1)) / rings);
    const r = Math.sqrt((GRAVITATION * body.mass * SPACECRAFT_MASS) / force);
    ctx.strokeStyle = `rgba(255,0,0,${lerp(0.75, 0.1, i / rings)})`;
    ctx.lineWidth = 2 * px;
    ctx.beginPath();
    ctx.arc(body.pos.x, body.pos.y, r, 0, PI2);
    ctx.stroke();
  }
}

function drawPlanet(ctx, p, u, zoom, px) {
  const drawColor = p.explored ? p.color : COLORS.unexplored;
  ctx.strokeStyle = COLORS.orbit;
  ctx.lineWidth = px;
  ctx.beginPath();
  const c = p.orbitCenter;
  ctx.arc(c.x, c.y, p.orbitRadius, 0, PI2);
  ctx.stroke();

  gravitationalField(ctx, p, u.now, px);
  const showTex = p.explored && zoom > 0.05 && dist(p.pos, u.ship.pos) < 10_000;
  drawPlanetBody(ctx, p, px, showTex, drawColor, COLORS.void);
}

function drawStar(ctx, star, now, px) {
  ctx.save();
  ctx.translate(star.pos.x, star.pos.y);
  gravitationalField(ctx, { pos: { x: 0, y: 0 }, mass: star.mass }, now, px);
  ctx.fillStyle = star.color;
  ctx.beginPath();
  ctx.arc(0, 0, star.radius, 0, PI2);
  ctx.fill();
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

function drawTrail(ctx, ship, fancy, px) {
  const t = ship.track;
  if (t.length < 2) return;
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
  const B = ship.isAI ? 5 : 9;
  const per = Math.ceil(t.length / B);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (let b = 0; b < B; b++) {
    const from = Math.max(0, b * per - 1), to = Math.min(t.length, (b + 1) * per);
    if (to - from < 2) continue;
    const f = (b + 1) / B;
    const v = t[to - 1].v;
    const hue = ship.isAI ? ship.design.hue : 140 + 150 * Math.min(1, v / CRAFT_SPEED_LIMIT);
    ctx.strokeStyle = `hsla(${hue},70%,${55 + 20 * f}%,${(ship.isAI ? 0.5 : 0.8) * f * f})`;
    ctx.lineWidth = px * (0.6 + 1.6 * f);
    ctx.beginPath();
    ctx.moveTo(t[from].x, t[from].y);
    for (let i = from + 1; i < to; i++) ctx.lineTo(t[i].x, t[i].y);
    ctx.stroke();
  }
  ctx.lineCap = 'butt';
}

function drawSpacecraft(ctx, ship, px, now, fancy, zoom) {
  drawTrail(ctx, ship, fancy, px);
  ctx.save();
  ctx.translate(ship.pos.x, ship.pos.y);
  ctx.rotate(ship.angle);
  drawShip(ctx, ship.design, {
    thrust: ship.effThrust ?? mag(ship.thrust), now, px, transit: ship.transit,
    landed: !!ship.landing, fancy, void: COLORS.void,
  });
  ctx.restore();
  if (ship.isAI && zoom > 0.25) { // callsign tag
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
    const r = target.radius + 30 * px + (1 - ap.lock) * 60 * px;
    ctx.globalAlpha = 0.9;
    ctx.lineWidth = 2 * px;
    ctx.rotate(now * 2);
    for (let k = 0; k < 4; k++) {
      ctx.beginPath();
      ctx.arc(0, 0, r, (k * Math.PI) / 2 + 0.15, ((k + 1) * Math.PI) / 2 - 0.15);
      ctx.stroke();
    }
    ctx.rotate(-now * 2);
    ctx.globalAlpha = 0.6;
    ctx.beginPath();
    ctx.arc(0, 0, r + 8 * px, -Math.PI / 2, -Math.PI / 2 + ap.lock * PI2);
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
export function renderUniverse(ctx, u, cam, w, h, dpr) {
  const { zoom } = cam;
  const px = 1 / zoom; // one CSS pixel in world units
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = COLORS.void;
  ctx.fillRect(0, 0, w * dpr, h * dpr);

  const s = dpr * zoom;
  ctx.setTransform(s, 0, 0, s, (w * dpr) / 2 - cam.x * s, (h * dpr) / 2 - cam.y * s);

  const halfW = w / 2 / zoom, halfH = h / 2 / zoom;
  const left = cam.x - halfW, right = cam.x + halfW, top = cam.y - halfH, bottom = cam.y + halfH;

  let step = 1000;
  while (step * zoom < 32) step *= 10;
  ctx.strokeStyle = COLORS.grid;
  for (let x = Math.floor(left / step) * step; x < right; x += step) {
    ctx.lineWidth = (x % (step * 10) === 0 ? 3 : 1.5) * px;
    ctx.beginPath(); ctx.moveTo(x, top); ctx.lineTo(x, bottom); ctx.stroke();
  }
  for (let y = Math.floor(top / step) * step; y < bottom; y += step) {
    ctx.lineWidth = (y % (step * 10) === 0 ? 3 : 1.5) * px;
    ctx.beginPath(); ctx.moveTo(left, y); ctx.lineTo(right, y); ctx.stroke();
  }

  for (const l of u.landings) if (l.player) drawLanding(ctx, l, px);

  // ringfence
  ctx.strokeStyle = '#800000';
  ctx.lineWidth = px;
  ctx.setLineDash([8 * px, 8 * px]);
  ctx.beginPath();
  ctx.arc(0, 0, UNIVERSE_RANGE, 0, PI2);
  ctx.stroke();
  ctx.setLineDash([]);

  drawStar(ctx, u.star, u.now, px);
  for (const sp of u.sparks) drawSpark(ctx, sp, px);
  for (const p of u.planets) drawPlanet(ctx, p, u, zoom, px);
  if (u.ship.autopilot) drawAutopilot(ctx, u.ship.autopilot, u.now, px);
  const fancy = u.style.fancy;
  for (const s of u.ships) if (s !== u.ship) drawSpacecraft(ctx, s, px, u.now, fancy, zoom);
  drawSpacecraft(ctx, u.ship, px, u.now, fancy, zoom);
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
