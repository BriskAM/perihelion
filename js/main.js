import {
  clamp, expSmooth, lexp, dailySeed, mag, sub, angleOf, fromAngle, vec, dist,
} from './maths.js';
import { Universe, STAR_CLASSES, landingSpeedLimit, SOL_SEED } from './universe.js';
import { Autopilot } from './autopilot.js';
import { renderUniverse, drawStick } from './render.js';
import {
  loadSave, writeSave, resetSave, shipStats, UPGRADES, MAX_UPGRADE, MILESTONES,
} from './save.js';
import { makeMissions } from './missions.js';
import { createUI } from './ui.js';
import { makeDesign } from './ships.js';

const DEFAULT_ZOOM = 1;
const MIN_ZOOM = 250 / 200_000;
const MAX_ZOOM = 5;
const STICK_MIN = 50, STICK_MAX = 100;

const params = new URLSearchParams(location.search);
const system = params.get('system') === 'sol' ? 'sol' : null; // our own solar system
const seed = system ? SOL_SEED : Math.abs(parseInt(params.get('seed') ?? '', 10)) || dailySeed();

const state = loadSave();
writeSave(state); // persist defaults so they stay stable
const universe = new Universe(seed, { shipModel: state.shipModel, system });
const autopilot = new Autopilot(universe.ship, universe);
universe.ship.autopilot = autopilot;
universe.entities.push(autopilot);
if (params.has('auto')) autopilot.enabled = true;

// ---- extras: saved progress, fuel, missions, codex ----
const seedKey = system ?? String(seed);
for (const idx of state.explored[seedKey] ?? []) {
  if (universe.planets[idx]) universe.planets[idx].explored = true;
}
const missions = makeMissions(universe);

function applyShip() {
  autopilot.assist = state.options.assist;
  autopilot.orbitFirst = state.options.orbit;
  universe.style.fancy = state.options.fancy;
  universe.style.warp = state.options.warp;
  universe.style.strict = state.options.strict;
  const s = shipStats(state), f = universe.fuel;
  f.on = state.options.survival;
  f.capacity = s.capacity; f.burn = s.burn; f.refuelRate = s.refuelRate;
  f.level = Math.min(f.level, f.capacity);
}
applyShip();
universe.fuel.level = universe.fuel.capacity;

let dirty = false;
const persist = () => { writeSave(state); dirty = false; };

const ui = createUI({
  state, universe, missions, seed: system === 'sol' ? 'Sol, our solar system' : seed,
  actions: {
    buy(id) {
      const lvl = state.upgrades[id], cost = UPGRADES[id].cost(lvl);
      if (lvl >= MAX_UPGRADE || state.credits < cost) return;
      state.credits -= cost; state.upgrades[id]++;
      const wasFull = universe.fuel.level >= universe.fuel.capacity;
      applyShip();
      if (wasFull) universe.fuel.level = universe.fuel.capacity;
      persist(); ui.render();
    },
    option(key, value) {
      state.options[key] = value; applyShip(); persist(); ui.render();
    },
    share() {
      const url = `${location.origin}${location.pathname}${system ? '?system=sol' : `?seed=${seed}`}`;
      if (navigator.share) navigator.share({ title: 'Perihelion', url }).catch(() => {});
      else navigator.clipboard?.writeText(url).then(() => ui.toast('Link copied')).catch(() => ui.toast(url));
    },
    randomSeed() { location.search = `?seed=${1 + Math.floor(Math.random() * 9_999_999)}`; },
    dailySeed() { location.search = ''; },
    sol() { location.search = '?system=sol'; },
    reset() { resetSave(); location.reload(); },
    setModel(id) {
      state.shipModel = id;
      universe.ship.design = makeDesign(id);
      persist(); ui.render();
    },
  },
});

universe.onLanded = (planet, { rescue, first, survey }) => {
  if (!first || rescue) return;
  const idx = universe.planets.indexOf(planet);
  (state.explored[seedKey] ??= []).push(idx);
  state.codex.push({
    seed, idx, name: planet.name, description: planet.description, atmosphere: planet.atmosphere,
    fauna: planet.fauna, flora: planet.flora, t: Date.now(),
  });
  state.credits += 50;
  ui.toast(`${survey ? 'SURVEYED' : 'DISCOVERED'} ${planet.name.toUpperCase()}  +50 CR`);
  for (const [count, title] of MILESTONES) {
    if (state.codex.length >= count && !state.milestones.includes(title)) {
      state.milestones.push(title);
      ui.toast(`RANK UP: ${title.toUpperCase()}`, 'good');
    }
  }
  persist();
};

// ---- AI ships: announce when one comes close ----
const nearShips = new Set();
function checkContacts() {
  for (const s of universe.ships) {
    if (!s.isAI) continue;
    const d = dist(s.pos, universe.ship.pos);
    if (d < 3500 && !nearShips.has(s)) {
      nearShips.add(s);
      ui.toast(`CONTACT: ${s.name} (${s.role})`);
    } else if (d > 9000) nearShips.delete(s);
  }
}

let missionClock = 0;
function checkMissions() {
  if (!state.options.missions) return;
  for (const m of missions) {
    if (state.done.includes(m.id)) continue;
    const [cur, max] = m.progress();
    if (cur >= max) {
      state.done.push(m.id);
      state.credits += m.reward;
      ui.toast(`MISSION COMPLETE: ${m.title}  +${m.reward} CR`, 'good');
      persist();
    }
  }
}

setInterval(() => { if (dirty) persist(); }, 10_000);
window.addEventListener('pagehide', persist);
document.getElementById('menubtn').addEventListener('click', () => ui.toggle());
document.getElementById('menubtn').addEventListener('pointerdown', (e) => e.stopPropagation());
const rescueBtn = document.getElementById('rescue');
rescueBtn.addEventListener('pointerdown', (e) => e.stopPropagation());
rescueBtn.addEventListener('click', () => {
  const planet = universe.planets.reduce((a, b) =>
    (dist(a.pos, universe.ship.pos) < dist(b.pos, universe.ship.pos) ? a : b));
  state.credits = Math.floor(state.credits * 0.75);
  universe.forceLand(planet, true);
  universe.fuel.level = Math.min(universe.fuel.capacity, 20);
  ui.toast('RESCUED: -25% credits'); persist();
});

// the player's ship is lost (black hole or crash): wake up parked on the safest planet
function respawnPlayer(message, farFrom) {
  const far = (p) => (farFrom.length ? Math.min(...farFrom.map((b) => dist(b.pos, p.pos))) : 0);
  const planet = universe.planets.filter((p) => !p.isMoon).sort((a, b) => far(b) - far(a))[0];
  universe.ship.consumed = null;
  state.credits = Math.floor(state.credits * 0.75);
  universe.forceLand(planet, true);
  universe.fuel.level = Math.min(universe.fuel.capacity, 20);
  universe.timeScale = 1;
  autopilot.target = null;
  ui.toast(message, 'bad');
  persist();
}
universe.onConsumed = () => respawnPlayer('LOST TO THE SINGULARITY: -25% credits', universe.blackHoles);
universe.onDestroyed = (ship, { planet, speed, reason }) =>
  respawnPlayer(reason === 'crashed' || !reason
    ? `CRASHED ON ${planet.name.toUpperCase()} AT ${Math.round(speed)}: -25% credits`
    : `${reason.toUpperCase()} AT ${planet.name.toUpperCase()}: -25% credits`, []);
universe.onServiced = (sat) => {
  state.credits += 10;
  ui.toast(`DOCKED WITH ${sat.name.toUpperCase()}: +10 CR${universe.fuel.on ? ', +15 fuel' : ''}`, 'good');
  persist();
};
universe.onImpact = ({ planet, speed, safe, damage }) =>
  ui.toast(`HARD LANDING on ${planet.name.toUpperCase()}: ${Math.round(speed)} (limit ${Math.round(safe)})` +
    (universe.fuel.on ? `  -${Math.round(damage)} fuel` : ''), 'bad');

const canvas = document.getElementById('space');
const ctx = canvas.getContext('2d');
const pip = document.getElementById('pip');
const pipCtx = pip.getContext('2d');
const PIP_SIZE = 160, PIP_ZOOM = 3.5;
const hudTop = document.getElementById('catalog');
const hudShip = document.getElementById('ship');
const hudAuto = document.getElementById('autotext');
const autoBtn = document.getElementById('auto');

let w = 0, h = 0, dpr = 1;
function resize() {
  dpr = Math.min(window.devicePixelRatio || 1, 2); // 3x screens cost 2.25x the pixels for little gain
  w = window.innerWidth; h = window.innerHeight;
  canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
}
window.addEventListener('resize', resize);
resize();

let dynamicZoom = autopilot.enabled;
function setAuto(on) {
  autopilot.enabled = on;
  dynamicZoom = on;
  autoBtn.classList.toggle('on', on);
  if (!on) universe.ship.thrust = vec();
}
autoBtn.addEventListener('click', () => setAuto(!autopilot.enabled));
autoBtn.addEventListener('pointerdown', (e) => e.stopPropagation());
window.addEventListener('keydown', (e) => {
  if (e.key === 'a' || e.key === 'A') setAuto(!autopilot.enabled);
  if (e.key === 'm' || e.key === 'M') ui.toggle();
  if (e.key === 'Escape' && ui.open) ui.toggle(false);
});
setAuto(autopilot.enabled);

// floating flight stick
const stick = { active: false, id: null, origin: vec(), target: vec(), minRadius: STICK_MIN, maxRadius: STICK_MAX };
function stickChanged(vector) {
  const ship = universe.ship;
  if (!vector) { ship.thrust = vec(); return; }
  const a = angleOf(vector), m = mag(vector);
  ship.angle = a;
  ship.thrust = m < STICK_MIN ? vec()
    : fromAngle(a, clamp(lexp(STICK_MIN, STICK_MAX, m), 0, 1));
}
const pos = (e) => vec(e.clientX, e.clientY);
canvas.addEventListener('pointerdown', (e) => {
  if (stick.active) return;
  stick.active = true; stick.id = e.pointerId;
  stick.origin = pos(e); stick.target = pos(e);
  canvas.setPointerCapture(e.pointerId);
});
canvas.addEventListener('pointermove', (e) => {
  if (!stick.active || e.pointerId !== stick.id) return;
  stick.target = pos(e);
  stickChanged(sub(stick.target, stick.origin));
});
const release = (e) => {
  if (!stick.active || e.pointerId !== stick.id) return;
  stick.active = false;
  stickChanged(null);
};
canvas.addEventListener('pointerup', release);
canvas.addEventListener('pointercancel', release);
canvas.addEventListener('lostpointercapture', release);
window.addEventListener('blur', () => { stick.active = false; stickChanged(null); });

// camera
const cam = { x: 0, y: 0, zoom: DEFAULT_ZOOM };

const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);
const pad = (n, width) => String(n).padStart(width, ' ');
const signed = (n) => pad((n >= 0 ? '+' : '-') + Math.abs(Math.round(n)), 7);

function updateHud() {
  const u = universe, ship = u.ship, star = u.star;
  const explored = u.planets.filter((p) => p.explored);
  const designation = `PRH-${u.randomSeed % 100_000}`;
  const cls = u.stars.map((s) => (s.isBlackHole ? 'BH' : s.cls)).join(' + ');
  const lines = [
    `  STAR: ${star.name} (${designation})`,
    ` CLASS: ${cls}${u.systemType === 'binary' ? ' (binary)' : ''}`,
    `RADIUS: ${u.stars.map((s) => Math.trunc(s.radius)).join(' + ')}`,
    `  MASS: ${u.totalMass.toPrecision(3)}`,
    ...(u.blackHoles.length && !star.isBlackHole ? [`  HOLE: ${u.blackHoles[0].name}`] : []),
    ...(u.belts.length ? [` BELTS: ${u.belts.length}`] : []),
    `BODIES: ${explored.length} / ${u.planets.length}`,
    '',
  ];
  const SHOWN = 5; // the rest live in the CODEX tab
  for (const p of explored.slice(-SHOWN)) {
    lines.push(`  BODY: ${p.name}`, `  TYPE: ${cap(p.description)}`, `  ATMO: ${cap(p.atmosphere)}`,
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
  const fuelLine = f.on
    ? `FUEL: ${Math.round((f.level / f.capacity) * 100)}%${f.heat ? '  !! HEAT !!' : f.level <= 0 ? '  EMPTY' : ''}`
    : null;
  const near = u.nearestBlackHole(ship.pos);
  const holeLine = u.tidal > 0.02
    ? `!! TIDAL ${Math.round(u.tidal * 100)}%  TIME x${u.timeScale.toFixed(2)} !!`
    : near && near.d < near.bh.radius * 14 ? `HOLE: ${Math.round(near.d - near.bh.radius)} TO HORIZON` : null;
  rescueBtn.hidden = !(f.on && f.level <= 0 && !ship.landing);
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
  const text = [
    first,
    reentry,
    satLine,
    holeLine,
    fuelLine,
    `CR:  ${state.credits}`,
    `THR: ${Math.round(mag(ship.thrust) * 100)}%`,
    `POS: <${signed(ship.pos.x)},${signed(ship.pos.y)}>`,
    `VEL: ${Math.round(mag(ship.velocity))}`,
  ].filter((x) => x !== null).join('\n');
  if (hudShip.textContent !== text) hudShip.textContent = text;
  const at = autopilot.telemetry;
  if (hudAuto.textContent !== at) hudAuto.textContent = at;
}

let hudClock = 1000, lastMs = 0;
// Ship cam: a fixed close-up of the ship, with its velocity (relative to the nearest world) and thrust.
function drawShipCam() {
  const u = universe, ship = u.ship;
  const show = state.options.pip && cam.zoom < 0.4 && !ship.consumed;
  pip.hidden = !show;
  if (!show) return;
  const d = Math.min(window.devicePixelRatio || 1, 2);
  if (pip.width !== PIP_SIZE * d) { pip.width = pip.height = PIP_SIZE * d; }
  renderUniverse(pipCtx, u, { x: ship.pos.x, y: ship.pos.y, zoom: PIP_ZOOM }, PIP_SIZE, PIP_SIZE, d);
  pipCtx.setTransform(d, 0, 0, d, 0, 0);
  const c = PIP_SIZE / 2, ref = u.closestPlanet();
  const rel = sub(ship.velocity, ref.velocity), speed = mag(rel);
  const arrow = (vx, vy, len, color, width) => {
    pipCtx.strokeStyle = color; pipCtx.fillStyle = color; pipCtx.lineWidth = width;
    const a = Math.atan2(vy, vx), x = c + Math.cos(a) * len, y = c + Math.sin(a) * len;
    pipCtx.beginPath(); pipCtx.moveTo(c, c); pipCtx.lineTo(x, y); pipCtx.stroke();
    pipCtx.beginPath();
    pipCtx.moveTo(x, y); pipCtx.lineTo(x - Math.cos(a - 0.45) * 7, y - Math.sin(a - 0.45) * 7);
    pipCtx.lineTo(x - Math.cos(a + 0.45) * 7, y - Math.sin(a + 0.45) * 7); pipCtx.fill();
  };
  if (speed > 5) arrow(rel.x, rel.y, Math.min(c - 12, 14 + Math.log10(1 + speed) * 16), '#4ade80', 1.5); // velocity
  const th = mag(ship.thrust);
  if (th > 0) arrow(-Math.cos(ship.angle), -Math.sin(ship.angle), 10 + th * 30, '#ff8800', 2); // push (opposite the flame)
  pipCtx.fillStyle = '#b7b7ff';
  pipCtx.font = '9px ui-monospace, Menlo, monospace';
  pipCtx.textAlign = 'center';
  pipCtx.fillText(`${Math.round(speed)} rel ${ref.name.split(' ').pop()}`, c, PIP_SIZE - 9);
  pipCtx.fillStyle = '#4ade80'; pipCtx.textAlign = 'left'; pipCtx.fillText('vel', 14, 14);
  pipCtx.fillStyle = '#ff8800'; pipCtx.fillText('thrust', 14, 25);
}

function frame(ms) {
  const u = universe;
  u.step(ms / 1000);

  const closest = u.closestPlanet();
  const distToSurf = Math.max(0, dist(u.ship.pos, closest.pos) - closest.radius * 1.2);
  const target = dynamicZoom ? clamp(500 / distToSurf, MIN_ZOOM, MAX_ZOOM) : DEFAULT_ZOOM;
  cam.zoom = expSmooth(cam.zoom, target, u.frameDt, 1.5);
  cam.x = u.ship.pos.x; cam.y = u.ship.pos.y;

  renderUniverse(ctx, u, cam, w, h, dpr);
  drawStick(ctx, stick, dpr);
  drawShipCam();
  autopilot.manual = stick.active;
  hudClock += ms - lastMs; lastMs = ms;
  if (hudClock > 100) { hudClock = 0; updateHud(); checkContacts(); } // the HUD does not need 60 fps
  missionClock += Math.max(0, u.frameDt);
  if (missionClock > 0.25) { missionClock = 0; checkMissions(); }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

window.__universe = universe;
window.__cam = cam; // handy for poking around in the console
void STAR_CLASSES;
