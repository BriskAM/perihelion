import { PI2, hsvToCss, makeRng } from './maths.js';
import { CLASSIC_HULL_PATH } from './classic-hull.js';

// Minimal line-art hulls, nose along +x, about 12 units of radius. `tail` is where the flame
// starts. Everything but "classic" is our own drawing.
const poly = (pts) => {
  const p = new Path2D();
  p.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) p.lineTo(pts[i][0], pts[i][1]);
  p.closePath();
  return p;
};

export const SHIP_MODELS = {
  dart: { name: 'Dart', tail: -3, path: () => poly([[12, 0], [-6, -7], [-3, 0], [-6, 7]]) },
  classic: {
    name: 'Classic', tail: -5, credit: 'Outline from the Android Easter egg (Apache 2.0)',
    path: () => new Path2D(CLASSIC_HULL_PATH),
  },
  needle: { name: 'Needle', tail: -8, path: () => poly([[14, 0], [-4, -2.6], [-8, -2.6], [-8, 2.6], [-4, 2.6]]) },
  kite: { name: 'Kite', tail: -8, path: () => poly([[13, 0], [-2, -7], [-8, 0], [-2, 7]]) },
  hopper: { name: 'Hopper', tail: -7, path: () => poly([[8, -5], [11, -2], [11, 2], [8, 5], [-7, 5], [-7, -5]]) },
  pod: {
    name: 'Pod', tail: -10,
    path: () => { const p = new Path2D(); p.ellipse(0, 0, 10, 5.5, 0, 0, PI2); return p; },
  },
};
export const MODEL_IDS = Object.keys(SHIP_MODELS);
export const DEFAULT_MODEL = 'dart';

export function makeDesign(model, hue = null) {
  return { model: SHIP_MODELS[model] ? model : DEFAULT_MODEL, hue };
}

export function randomDesign(rng) {
  return makeDesign(rng.choose(MODEL_IDS), Math.round(rng.range(0, 360)));
}

const CALLSIGNS = ['Kestrel', 'Marlin', 'Tern', 'Wren', 'Osprey', 'Plover', 'Heron', 'Swift', 'Sparrow', 'Lark', 'Dunlin', 'Curlew'];
const ROLES = ['hauler', 'courier', 'survey skiff', 'tug', 'pilgrim'];
export function makeCallsign(rng) {
  return { callsign: `${rng.choose(CALLSIGNS)}-${rng.int(2, 99)}`, role: rng.choose(ROLES) };
}

/**
 * Draw a ship at the origin of the current transform, nose along +x.
 * opts: { thrust 0..1, now, px (one css pixel in world units), transit, landed, fancy }
 */
export function drawShip(ctx, d, { thrust = 0, now = 0, px = 1, transit = false, landed = false, fancy = true, void: voidColor = '#16161d' } = {}) {
  const m = SHIP_MODELS[d.model] ?? SHIP_MODELS[DEFAULT_MODEL];
  m.cached ??= m.path();
  ctx.lineJoin = 'round';
  ctx.lineWidth = 1.8 * px;

  if (landed) {
    ctx.strokeStyle = '#ccc';
    ctx.beginPath();
    ctx.moveTo(m.tail + 3, -3); ctx.lineTo(m.tail - 4, -9);
    ctx.moveTo(m.tail + 3, 3); ctx.lineTo(m.tail - 4, 9);
    ctx.stroke();
  }
  if (thrust > 0) {
    const len = (3 + 10 * Math.min(1, thrust)) * (0.85 + 0.15 * Math.sin(now * 55));
    ctx.beginPath();
    ctx.moveTo(m.tail + 1, -2.4); ctx.lineTo(m.tail - len, 0); ctx.lineTo(m.tail + 1, 2.4);
    if (fancy) { ctx.fillStyle = 'rgba(255,136,0,0.3)'; ctx.fill(); }
    ctx.strokeStyle = '#ff8800';
    ctx.stroke();
  }
  ctx.fillStyle = voidColor;
  ctx.fill(m.cached);
  ctx.strokeStyle = transit ? '#000' : d.hue === null ? '#fff' : hsvToCss(d.hue, 0.35, 1);
  ctx.stroke(m.cached);
}
void makeRng;
