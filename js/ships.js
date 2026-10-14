import { PI2, makeRng, hsvToCss } from './maths.js';

// Procedural hull designs. A design is plain data, so it can be saved by seed.
export function makeDesign(seed) {
  const rng = makeRng(seed >>> 0);
  return {
    seed,
    len: rng.range(13, 17),
    body: rng.range(3.2, 5),
    tail: -rng.range(7, 10),
    wingType: rng.int(0, 3),
    span: rng.range(7, 11.5),
    sweep: rng.range(2, 8),
    rootFront: rng.range(0, 4),
    rootBack: rng.range(-6.5, -3),
    fins: rng.int(0, 3),
    nozzles: rng.int(1, 4),
    cockpit: rng.range(3, 8),
    hue: Math.round(rng.range(0, 360)),
    stripe: rng() < 0.6,
  };
}

const CALLSIGNS = ['Kestrel', 'Marlin', 'Tern', 'Wren', 'Osprey', 'Plover', 'Heron', 'Swift', 'Sparrow', 'Lark', 'Dunlin', 'Curlew'];
const ROLES = ['hauler', 'courier', 'survey skiff', 'tug', 'pilgrim'];
export function makeCallsign(rng) {
  return { callsign: `${rng.choose(CALLSIGNS)}-${rng.int(2, 99)}`, role: rng.choose(ROLES) };
}

const mirror = (path, pts) => {
  path.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) path.lineTo(pts[i][0], pts[i][1]);
  path.closePath();
};

function hullPaths(d) {
  const b = d.body, fuselage = new Path2D(), wings = new Path2D(), fins = new Path2D();
  mirror(fuselage, [
    [d.len, 0], [d.len * 0.45, -b * 0.7], [0, -b], [d.tail * 0.6, -b * 0.9], [d.tail, -b * 0.6],
    [d.tail, b * 0.6], [d.tail * 0.6, b * 0.9], [0, b], [d.len * 0.45, b * 0.7],
  ]);
  for (const s of [-1, 1]) {
    const f = d.rootFront, r = d.rootBack, sw = d.sweep;
    const pts = d.wingType === 0
      ? [[f, s * b], [r - sw, s * d.span], [r, s * b * 0.9]]
      : d.wingType === 1
        ? [[f, s * b], [f - sw - 2, s * d.span], [f - sw - 5, s * d.span], [r, s * b * 0.9]]
        : [[f + 3, s * b], [f + 2, s * d.span], [f - 3, s * d.span], [r, s * b * 0.9]];
    mirror(wings, pts);
    if (d.fins >= 1) mirror(fins, [[d.tail + 2, s * b * 0.6], [d.tail - 3, s * (b + 2.2)], [d.tail + 4, s * b * 0.8]]);
  }
  return { fuselage, wings, fins };
}

function nozzleYs(d) {
  return d.nozzles === 1 ? [0] : d.nozzles === 2 ? [-d.body * 0.35, d.body * 0.35] : [-d.body * 0.45, 0, d.body * 0.45];
}

/**
 * Draw a ship at the origin of the current transform, nose along +x.
 * opts: { thrust 0..1, now, px (one css pixel in world units), transit, landed, fancy }
 */
export function drawShip(ctx, d, { thrust = 0, now = 0, px = 1, transit = false, landed = false, fancy = true, void: voidColor = '#16161d' } = {}) {
  d.paths ??= hullPaths(d);
  const accent = hsvToCss(d.hue, 0.65, 1);
  ctx.lineJoin = 'round';
  ctx.lineWidth = 1.6 * px;

  if (landed) {
    ctx.strokeStyle = '#ccc';
    ctx.beginPath();
    ctx.moveTo(-3, -d.body); ctx.lineTo(-11, -d.body - 6);
    ctx.moveTo(-3, d.body); ctx.lineTo(-11, d.body + 6);
    ctx.stroke();
  }

  const ys = nozzleYs(d);
  if (thrust > 0) {
    const flick = (i) => 0.82 + 0.18 * Math.sin(now * 55 + i * 2.1);
    ys.forEach((y, i) => {
      const len = (3 + 11 * Math.min(1, thrust)) * flick(i) * (1 / Math.sqrt(ys.length) + 0.2);
      ctx.beginPath();
      ctx.moveTo(d.tail - 1, y - 1.3); ctx.lineTo(d.tail - 1 - len, y); ctx.lineTo(d.tail - 1, y + 1.3);
      if (fancy) { ctx.fillStyle = 'rgba(255,136,0,0.35)'; ctx.fill(); }
      ctx.strokeStyle = '#ff8800';
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(d.tail - 1, y - 0.6); ctx.lineTo(d.tail - 1 - len * 0.55, y); ctx.lineTo(d.tail - 1, y + 0.6);
      ctx.strokeStyle = '#fff3c4';
      ctx.stroke();
    });
  }

  const line = transit ? '#000' : '#fff';
  ctx.fillStyle = voidColor;
  for (const part of [d.paths.wings, d.paths.fins, d.paths.fuselage]) {
    ctx.fill(part);
    ctx.strokeStyle = line;
    ctx.stroke(part);
  }
  ctx.strokeStyle = accent;
  for (const y of ys) { // nozzle bells
    ctx.beginPath();
    ctx.moveTo(d.tail, y - 1.2); ctx.lineTo(d.tail - 1.6, y - 1.5); ctx.lineTo(d.tail - 1.6, y + 1.5); ctx.lineTo(d.tail, y + 1.2);
    ctx.stroke();
  }
  ctx.beginPath(); // cockpit canopy
  ctx.ellipse(d.cockpit, 0, 2.6, 1.3, 0, 0, PI2);
  ctx.stroke();
  if (d.stripe) {
    ctx.beginPath();
    ctx.moveTo(d.rootFront - 1, -d.body * 0.95); ctx.lineTo(d.rootBack - d.sweep * 0.5, -d.span * 0.8);
    ctx.moveTo(d.rootFront - 1, d.body * 0.95); ctx.lineTo(d.rootBack - d.sweep * 0.5, d.span * 0.8);
    ctx.stroke();
  }
}
