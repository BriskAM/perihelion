import { renderUniverse } from './render.js';
import { landingSpeedLimit } from './universe.js';
import { shipStats } from './save.js';
import { persona } from './personalities.js';
import { clamp, dist, mag, sub } from './maths.js';

// The heads-up display and the round ship cam, split out of main.js. `g` is the game context.
export const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);
const hudTop = document.getElementById('catalog');
const hudShip = document.getElementById('ship');
const hudAuto = document.getElementById('autotext');
const warpBtn = document.getElementById('warp');
const rescueBtn = document.getElementById('rescue');
const shipCam = document.getElementById('pip');
const shipCamCtx = shipCam.getContext('2d');
const SHIPCAM_SIZE = 160, SHIPCAM_ZOOM = 3.5;

export function createHud(g) {
  // ---- HUD ----
  const pad = (n, width) => String(n).padStart(width, ' ');
  const signed = (n) => pad((n >= 0 ? '+' : '-') + Math.abs(Math.round(n)), 7);
  const fmt = (n) => (!isFinite(n) ? '∞' : Math.abs(n) >= 10_000 ? `${Math.round(n / 1000)}k` : Math.abs(n) >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${Math.round(n)}`);

  function orbitLine() {
    if (!g.pred) return null;
    if (g.pred.soi) {
      const o = g.pred.orbit, R = o.body.radius, name = o.body.name.toUpperCase();
      if (o.end === 'impact') return `ORB: ${name}  ON COLLISION COURSE`;
      if (o.end === 'escape') return `ORB: ${name}  ESCAPING  PE ${fmt(o.pe - R)}`;
      return `ORB: ${name}  PE ${fmt(o.pe - R)}  AP ${fmt(o.ap - R)}  T ${fmt(o.period)}s${o.end === 'air' ? '  (AIR)' : ''}`;
    }
    if (g.pred.encounter) {
      const e = g.pred.encounter, o = e.orbit;
      return `ENC: ${e.body.name.toUpperCase()} in ${Math.round(e.t)}s${o ? (o.end === 'impact' ? '  IMPACT' : `  PE ${fmt(o.pe - e.body.radius)}`) : ''}`;
    }
    if (g.pred.impact) return `!! IMPACT ${g.pred.impact.body.name.toUpperCase()} in ${Math.round(g.pred.impact.t)}s !!`;
    return null;
  }

  function updateHud() {
    const u = g.u, ship = u.ship, star = u.star;
    const explored = u.planets.filter((p) => p.explored);
    const designation = g.system === 'sol' ? 'SOL' : `PRH-${u.randomSeed % 100_000}`;
    const cls = u.stars.map((s) => (s.isBlackHole ? 'BH' : s.cls)).join(' + ');
    const belts = u.belts.filter((b) => !b.trojan), trojans = u.belts.length - belts.length;
    const comets = u.debris.items.filter((it) => it.kind === 'comet').length;
    const lines = [
      `  STAR: ${star.name} (${designation})`,
      ` CLASS: ${cls}${u.systemType === 'binary' ? ' (binary)' : ''}`,
      `RADIUS: ${u.stars.map((s) => Math.trunc(s.radius)).join(' + ')}`,
      `  MASS: ${u.totalMass.toPrecision(3)}`,
      ...(u.blackHoles.length && !star.isBlackHole ? [`  HOLE: ${u.blackHoles[0].name}`] : []),
      ...(belts.length ? [` BELTS: ${belts.length}${belts.some((b) => b.gaps?.length) ? ` (${belts.reduce((s, b) => s + (b.gaps?.length ?? 0), 0)} resonance gaps)` : ''}`] : []),
      ...(trojans ? [`TROJAN: ${trojans} swarm${trojans > 1 ? 's' : ''}`] : []),
      ...(comets ? [`COMETS: ${comets}`] : []),
      `BODIES: ${explored.length} / ${u.planets.length}`,
      ...(g.state.cruise ? [`SYSTEMS VISITED: ${g.state.stats.systems + 1}`] : []),
      ...(u.wonders?.list.length ? [`WONDERS: ${u.wonders.list.map((k) => ({ dyson: 'Dyson swarm', fortress: 'a fortress (it shoots)', wormhole: 'wormholes', whales: 'star whales' })[k]).join(', ')}`] : []),
      ...(u.rare ? [`  RARE: ${{ pulsar: 'pulsar (mind the beams)', dwarf: 'brown dwarf (everything frozen)', young: 'young system (debris disk)' }[u.rare]}`] : []),
      ...(g.state.story.target && !g.state.story.done ? [`SIGNAL: ${g.state.story.target === g.seed ? (u.beacon ? 'source in this system' : '...') : `points to ${g.state.story.targetName}`}`] : []),
      ...(u.wing ? [`  WING: ${u.wing.name} (${persona(g.state.wing.persona).name})`] : []),
      '',
    ];
    const SHOWN = innerWidth < 520 ? 1 : 5; // the rest live in the CODEX tab (phones get just the latest)
    for (const p of explored.slice(-SHOWN)) {
      lines.push(`  BODY: ${p.name}`, `  TYPE: ${cap(p.description)}${p.climate ? ` (${p.climate})` : ''}`, `  ATMO: ${cap(p.atmosphere)}`,
        ` FAUNA: ${cap(p.fauna)}`, ` FLORA: ${cap(p.flora)}`, '');
    }
    if (explored.length > SHOWN) lines.push(`(+${explored.length - SHOWN} more: MENU > CODEX)`);
    const catalog = lines.join('\n');
    if (hudTop.textContent !== catalog) {
      hudTop.textContent = catalog;
      hudTop.classList.remove('small');
      if (hudTop.scrollHeight > hudTop.clientHeight + 1) hudTop.classList.add('small');
    }

    const closest = u.closestPlanet();
    const alt = Math.trunc(dist(closest.pos, ship.pos) - closest.radius);
    const rel = Math.round(mag(sub(ship.velocity, closest.velocity)));
    const safe = Math.round(landingSpeedLimit(closest));
    const tooFast = u.style.strict && closest.collides && alt < 2500 && rel > safe;
    const first = ship.landing
      ? `LND: ${ship.landing.planet.name.toUpperCase()}\nJOB: ${ship.landing.text.toUpperCase()}`
      : alt < 10_000
        ? `ALT: ${alt}${closest.collides && u.style.strict && alt < 4000 ? `  REL: ${rel}/${safe}${tooFast ? '  !! TOO FAST !!' : ''}` : ''}`
        : null;
    const f = u.fuel;
    const dv = f.on ? Math.round((f.level / Math.max(f.burn, 1e-6)) * 1000) : null; // seconds of full burn x engine
    const fuelLine = f.on
      ? `FUEL: ${Math.round((f.level / f.capacity) * 100)}%  ΔV ${fmt(dv)}${f.heat ? '  !! HEAT !!' : f.level <= 0 ? '  EMPTY' : ''}`
      : null;
    const near = u.nearestBlackHole(ship.pos);
    const holeLine = u.tidal > 0.02
      ? `!! TIDAL ${Math.round(u.tidal * 100)}%  TIME x${u.timeScale.toFixed(2)} !!`
      : near && near.d < near.bh.radius * 14 ? `HOLE: ${Math.round(near.d - near.bh.radius)} TO HORIZON` : null;
    rescueBtn.hidden = !(f.on && f.level <= 0 && !ship.landing) || g.state.cruise;
    const reentry = ship.heatRate > 0.08
      ? `REENTRY: ${Math.round(ship.heat * 100)}%  (${Math.round((ship.heatRate / 0.8) * 100)}% of the safe heating)`
      : ship.atmoRho > 0.005 ? `AIR: ${ship.atmoRho.toFixed(2)}${ship.atmoPlanet && ship.atmoPlanet.gas ? '  (gas giant)' : ''}` : null;
    let satLine = null, bestSat = 400;
    for (const s of u.satellites) {
      const d = dist(s.pos, ship.pos);
      if (d < bestSat) {
        bestSat = d;
        const r = Math.round(mag(sub(ship.velocity, s.velocity)));
        satLine = `SAT: ${s.name} ${Math.round(d)}  REL ${r}${r < 90 && d < 120 ? (s.cooldown > 0 ? '  (recharging)' : '  DOCK!') : ''}`;
      }
    }
    let cometLine = null;
    for (const c of u.debris.items) {
      if (c.kind !== 'comet') continue;
      const d = dist(c.pos, ship.pos);
      if (d < 6000) cometLine = `COMET ${c.name}: ${Math.round(d)}  REL ${Math.round(mag(sub(ship.velocity, c.vel)))}${u.cometsMet.has(c.name) ? '  (met)' : ''}`;
    }
    const text = [
      first,
      orbitLine(),
      reentry,
      satLine,
      cometLine,
      holeLine,
      fuelLine,
      g.maneuver.node ? `BURN: ${Math.round(g.maneuver.node.dv - g.maneuver.node.done)} Δv ${g.maneuver.node.burning ? 'FIRING' : `at ${{ now: 'once aligned', pe: 'periapsis', ap: 'apoapsis' }[g.maneuver.node.at]}`}  (X cancels)` : null,
      ship.beam > 0 ? '!! PULSAR BEAM !!' : null,
      `HULL: ${Math.round(g.state.hull)}%${g.state.hull < 35 ? '  !! DAMAGED !!' : ''}   HOLD: ${g.state.cargo}/${shipStats(g.state).cargoMax}`,
      `CR:  ${g.state.credits}`,
      `THR: ${Math.round(mag(ship.thrust) * 100)}%${u.warp > 1 ? `   WARP x${u.warp}` : g.requestedWarp > 1 ? `   WARP x${g.requestedWarp} (held: too close)` : ''}`,
      `POS: <${signed(ship.pos.x)},${signed(ship.pos.y)}>`,
      `VEL: ${Math.round(mag(ship.velocity))}`,
    ].filter((x) => x !== null).join('\n');
    if (hudShip.textContent !== text) hudShip.textContent = text;
    const at = g.ap.enabled ? `${g.ap.telemetry}\n${g.scoreLine()}` : '';
    if (hudAuto.textContent !== at) hudAuto.textContent = at;
    warpBtn.textContent = `x${u.warp > 1 ? u.warp : g.requestedWarp}`;
    warpBtn.classList.toggle('on', u.warp > 1);
  }

  // Ship cam: a fixed close-up of the ship, with its velocity (relative to the nearest world) and thrust.
  function drawShipCam() {
    const u = g.u, ship = u.ship;
    const overview = g.cam.zoom >= 0.4;
    const show = g.state.options.pip && (g.cam.zoom < 0.4 || g.ap.enabled) && !ship.consumed && !g.jump;
    shipCam.hidden = !show;
    if (!show) return;
    const d = Math.min(window.devicePixelRatio || 1, 2);
    if (shipCam.width !== SHIPCAM_SIZE * d) { shipCam.width = shipCam.height = SHIPCAM_SIZE * d; }
    const tgt = g.ap.enabled ? g.ap.target : null;
    const span = tgt ? Math.max(1500, dist(tgt.pos, ship.pos)) : 20_000;
    const zoomNow = overview ? clamp(62 / span, 0.0008, 0.3) : SHIPCAM_ZOOM;
    const c2 = shipCamCtx;
    renderUniverse(c2, u, { x: ship.pos.x, y: ship.pos.y, zoom: zoomNow }, SHIPCAM_SIZE, SHIPCAM_SIZE, d, true);
    c2.setTransform(d, 0, 0, d, 0, 0);
    const c = SHIPCAM_SIZE / 2, ref = u.closestPlanet();
    c2.font = '9px ui-monospace, Menlo, monospace'; c2.textAlign = 'center';
    if (overview) { // wide view: mark the ship and the target it is flying to
      c2.strokeStyle = '#fff'; c2.lineWidth = 1.5;
      c2.beginPath(); c2.arc(c, c, 4, 0, Math.PI * 2); c2.stroke();
      if (tgt) {
        const tx = c + (tgt.pos.x - ship.pos.x) * zoomNow, ty = c + (tgt.pos.y - ship.pos.y) * zoomNow;
        c2.strokeStyle = '#4c8df6'; c2.setLineDash([3, 3]);
        c2.beginPath(); c2.moveTo(c, c); c2.lineTo(tx, ty); c2.stroke(); c2.setLineDash([]);
        c2.beginPath(); c2.arc(tx, ty, 6, 0, Math.PI * 2); c2.stroke();
      }
      c2.fillStyle = '#b7b7ff';
      c2.fillText(`${g.ap.strategy}${tgt ? ' > ' + tgt.name.split(' ').pop() : ''}`, c, SHIPCAM_SIZE - 9);
      return;
    }
    const rel = sub(ship.velocity, ref.velocity), speed = mag(rel);
    const arrow = (vx, vy, len, color, width) => {
      c2.strokeStyle = color; c2.fillStyle = color; c2.lineWidth = width;
      const a = Math.atan2(vy, vx), x = c + Math.cos(a) * len, y = c + Math.sin(a) * len;
      c2.beginPath(); c2.moveTo(c, c); c2.lineTo(x, y); c2.stroke();
      c2.beginPath();
      c2.moveTo(x, y); c2.lineTo(x - Math.cos(a - 0.45) * 7, y - Math.sin(a - 0.45) * 7);
      c2.lineTo(x - Math.cos(a + 0.45) * 7, y - Math.sin(a + 0.45) * 7); c2.fill();
    };
    if (speed > 5) arrow(rel.x, rel.y, Math.min(c - 12, 14 + Math.log10(1 + speed) * 16), '#4ade80', 1.5);
    const th = mag(ship.thrust);
    if (th > 0) arrow(-Math.cos(ship.angle), -Math.sin(ship.angle), 10 + th * 30, '#ff8800', 2);
    c2.fillStyle = '#b7b7ff';
    c2.fillText(g.ap.enabled ? `${g.ap.strategy}  ${Math.round(speed)} rel ${ref.name.split(' ').pop()}` : `${Math.round(speed)} rel ${ref.name.split(' ').pop()}`, c, SHIPCAM_SIZE - 9);
    c2.fillStyle = '#4ade80'; c2.textAlign = 'left'; c2.fillText('vel', 14, 14);
    c2.fillStyle = '#ff8800'; c2.fillText('thrust', 14, 25);
  }

  return { updateHud, drawShipCam };
}
