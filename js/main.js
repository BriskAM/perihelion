import {
  clamp, dailySeed, mag, sub, angleOf, fromAngle, vec, dist,
} from './maths.js';
import { Universe, STAR_CLASSES, landingSpeedLimit, SOL_SEED, Spark } from './universe.js';
import { Autopilot } from './autopilot.js';
import { renderUniverse, drawStick } from './render.js';
import {
  loadSave, writeSave, resetSave, shipStats, UPGRADES, MAX_UPGRADE, MILESTONES,
} from './save.js';
import { makeMissions } from './missions.js';
import { createUI } from './ui.js';
import { makeDesign } from './ships.js';
import { Sound } from './audio.js';
import { Camera } from './camera.js';
import { predict } from './predict.js';

const STICK_MIN = 50, STICK_MAX = 100;
const MANUAL_TURN = 9; // rad/s: the hull swings round quickly, but you see it turn
const KEY_TURN = 3.2;
const WARPS = [1, 2, 4, 8, 16];

const params = new URLSearchParams(location.search);
const state = loadSave();
writeSave(state); // persist defaults so they stay stable

// ---- sound (procedural; starts at the first click or key press) ----
const sound = new Sound();
sound.volume = state.options.volume;
let soundStarted = false;
function unlockSound() {
  if (soundStarted || state.options.volume <= 0) return;
  sound.start();
  sound.setPad(universe.star.cls, !!universe.star.isBlackHole);
  soundStarted = true;
}
for (const ev of ['pointerdown', 'keydown']) window.addEventListener(ev, unlockSound);

// ---- the current system. Cruise mode swaps it in place (no reload), so everything reads these. ----
let universe, autopilot, missions, seed, system, seedKey;
let pred = null; // predicted path of the player's ship
const cam = new Camera();
const pipCam = new Camera(); pipCam.director = true;
const game = {
  get universe() { return universe; },
  get missions() { return missions; },
  get seed() { return system === 'sol' ? 'Sol, our solar system' : seed; },
};

// log of things that happened (shown in the floating window and the "while you were away" card)
const log = [];
function logEvent(text) {
  log.push({ text, t: performance.now() });
  if (log.length > 40) log.shift();
}

let dirty = false;
const persist = () => { writeSave(state); dirty = false; };

const ui = createUI({
  state, game,
  actions: {
    buy(id) { buyUpgrade(id); ui.render(); },
    option(key, value) {
      state.options[key] = value; applyShip(); persist(); ui.render();
    },
    cruise(on) { setCruise(on); ui.render(); },
    share() {
      const url = `${location.origin}${location.pathname}${system ? '?system=sol' : `?seed=${seed}`}`;
      if (navigator.share) navigator.share({ title: 'Perihelion', url }).catch(() => {});
      else navigator.clipboard?.writeText(url).then(() => ui.toast('Link copied')).catch(() => ui.toast(url));
    },
    randomSeed() { jumpTo(1 + Math.floor(Math.random() * 9_999_999), null); ui.toggle(false); },
    dailySeed() { location.search = ''; },
    sol() { jumpTo(SOL_SEED, 'sol'); ui.toggle(false); },
    reset() { resetSave(); location.reload(); },
    setModel(id) {
      state.shipModel = id;
      universe.ship.design = makeDesign(id);
      persist(); ui.render();
    },
  },
});

function buyUpgrade(id) {
  const lvl = state.upgrades[id], cost = UPGRADES[id].cost(lvl);
  if (lvl >= MAX_UPGRADE || state.credits < cost) return false;
  state.credits -= cost; state.upgrades[id]++;
  const wasFull = universe.fuel.level >= universe.fuel.capacity;
  applyShip();
  if (wasFull) universe.fuel.level = universe.fuel.capacity;
  persist();
  return true;
}

function applyShip() {
  autopilot.assist = state.options.assist;
  autopilot.orbitFirst = state.options.orbit;
  autopilot.pace = state.options.pace;
  sound.setVolume(state.options.volume);
  if (state.options.volume > 0 && soundStarted) sound.setPad(universe.star.cls, !!universe.star.isBlackHole);
  universe.style.fancy = state.options.fancy;
  universe.style.warp = state.options.warp;
  universe.style.strict = state.options.strict;
  cam.smart = state.options.smartcam;
  const s = shipStats(state), f = universe.fuel;
  f.on = state.options.survival;
  f.capacity = s.capacity; f.burn = s.burn; f.refuelRate = s.refuelRate;
  f.level = Math.min(f.level, f.capacity);
}

function buildSystem(newSeed, newSystem) {
  seed = newSeed; system = newSystem; seedKey = system ?? String(seed);
  universe = new Universe(seed, { shipModel: state.shipModel, system });
  autopilot = new Autopilot(universe.ship, universe);
  universe.ship.autopilot = autopilot;
  universe.entities.push(autopilot);
  autopilot.onEvent = (e) => {
    if (e.kind === 'assist') {
      const gain = Math.round(e.gain);
      ui.toast(`SLINGSHOT ${e.body.name.toUpperCase()}: turned ${Math.round(e.turn)}°, ${gain >= 0 ? `+${gain} speed` : `${-gain} slower`}, closest pass ${Math.round(e.pe)}`, gain > 0 ? 'good' : '');
      logEvent(`Slingshot round ${e.body.name}: ${gain >= 0 ? '+' : ''}${gain} speed`);
      cam.addTrauma(0.15);
    } else if (e.kind === 'scan') {
      logEvent(`Scan pass over ${e.body.name}, turned ${Math.round(e.turn)}°`);
    } else if (e.kind === 'tour') {
      logEvent(`Orbit tour of ${e.body.name}`);
    }
  };
  universe.orbitHeld = {};
  universe.cometsMet = new Set();
  for (const idx of state.explored[seedKey] ?? []) {
    if (universe.planets[idx]) universe.planets[idx].explored = true;
  }
  missions = makeMissions(universe);
  wire(universe);
  applyShip();
  universe.fuel.level = universe.fuel.capacity;
  nearShips.clear();
  pred = null;
  lastDiscovery = performance.now();
  allChartedAt = 0; wanderingSince = 0;
  if (soundStarted) sound.setPad(universe.star.cls, !!universe.star.isBlackHole);
  cam.snap(universe, w, h); pipCam.snap(universe, 340, 340);
  window.__universe = universe;
}

// ---- events from the simulation ----
function wire(u) {
  u.onLanded = (planet, { rescue, first, survey }) => {
    if (first && !rescue) sound.discover(planet.name); else if (!rescue) sound.touchdown();
    if (!rescue) cam.addTrauma(first ? 0.25 : 0.12);
    if (!first || rescue) return;
    // a pulse rolls out from the newly charted world
    const ring = new Spark({ ttl: 2.6, style: 'ring', color: planet.color, size: Math.log(planet.radius * 2.5) });
    ring.pos = ring.opos = { ...planet.pos }; ring.velocity = planet.velocity;
    u.sparks.push(ring);
    const idx = u.planets.indexOf(planet);
    (state.explored[seedKey] ??= []).push(idx);
    state.codex.push({
      seed, idx, name: planet.name, description: planet.description, atmosphere: planet.atmosphere,
      fauna: planet.fauna, flora: planet.flora, t: Date.now(),
    });
    state.credits += 50;
    lastDiscovery = performance.now();
    away.charted++;
    ui.toast(`${survey ? 'SURVEYED' : 'DISCOVERED'} ${planet.name.toUpperCase()}  +50 CR`);
    logEvent(`${survey ? 'Surveyed' : 'Charted'} ${planet.name}`);
    for (const [count, title] of MILESTONES) {
      if (state.codex.length >= count && !state.milestones.includes(title)) {
        state.milestones.push(title);
        ui.toast(`RANK UP: ${title.toUpperCase()}`, 'good'); sound.fanfare();
        logEvent(`Rank up: ${title}`);
      }
    }
    persist();
  };
  u.onConsumed = () => sound.swallowed() || respawnPlayer('LOST TO THE SINGULARITY: -25% credits', u.blackHoles);
  u.onDestroyed = (ship, { planet, speed, reason }) => {
    cam.addTrauma(1); buzz([60, 40, 120]);
    sound.explode();
    respawnPlayer(reason === 'crashed' || !reason
      ? `CRASHED ON ${planet.name.toUpperCase()} AT ${Math.round(speed)}: -25% credits`
      : `${reason.toUpperCase()} AT ${planet.name.toUpperCase()}: -25% credits`, []);
  };
  u.onServiced = (sat) => {
    sound.dock();
    state.credits += 10;
    ui.toast(`DOCKED WITH ${sat.name.toUpperCase()}: +10 CR${u.fuel.on ? ', +15 fuel' : ''}`, 'good');
    persist();
  };
  u.onImpact = ({ planet, speed, safe, damage }) => {
    sound.thud(); cam.addTrauma(0.55); buzz(40);
    ui.toast(`HARD LANDING on ${planet.name.toUpperCase()}: ${Math.round(speed)} (limit ${Math.round(safe)})` +
      (u.fuel.on ? `  -${Math.round(damage)} fuel` : ''), 'bad');
  };
  u.onRockHit = (speed) => { cam.addTrauma(Math.min(0.45, speed / 700)); if (speed > 200) { sound.thud(); buzz(20); } };
  u.debris.onEvent = ({ kind, item, body, at }) => {
    if (kind === 'comet') { ui.toast(`NEW COMET INBOUND: ${item.name}`); logEvent(`Comet ${item.name} falling in`); return; }
    const d = dist(at, u.ship.pos);
    if (d < 25_000) cam.addTrauma(clamp(0.5 * (1 - d / 25_000) * (item.kind === 'comet' ? 2 : 0.6), 0, 0.8));
    if (item.kind === 'comet') {
      ui.toast(`COMET ${item.name} HIT ${body.name.toUpperCase()}`, 'bad');
      logEvent(`Comet ${item.name} struck ${body.name}`);
    }
  };
}

function buzz(p) { try { navigator.vibrate?.(p); } catch { /* not allowed */ } }

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

function checkMissions() {
  if (!state.options.missions) return;
  for (const m of missions) {
    if (state.done.includes(m.id)) continue;
    const [cur, max] = m.progress();
    if (cur >= max) {
      state.done.push(m.id);
      state.credits += m.reward;
      away.missions++;
      ui.toast(`MISSION COMPLETE: ${m.title}  +${m.reward} CR`, 'good'); sound.fanfare();
      logEvent(`Mission done: +${m.reward} CR`);
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
// Rescue: park on the nearest solid world. Free when the game is playing itself (cruise).
function rescue(free = false) {
  const solid = universe.planets.filter((p) => !p.gas);
  const planet = solid.reduce((a, b) => (dist(a.pos, universe.ship.pos) < dist(b.pos, universe.ship.pos) ? a : b));
  if (!free) state.credits = Math.floor(state.credits * 0.75);
  universe.forceLand(planet, true);
  universe.fuel.level = Math.min(universe.fuel.capacity, 20);
  ui.toast(free ? 'AUTO-RESCUE' : 'RESCUED: -25% credits'); persist();
  logEvent(`Towed to ${planet.name}`);
}
rescueBtn.addEventListener('click', () => rescue(false));

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
  logEvent(message.split(':')[0].toLowerCase().replace(/^\w/, (c) => c.toUpperCase()));
  persist();
}

const canvas = document.getElementById('space');
const ctx = canvas.getContext('2d');
const shipCam = document.getElementById('pip');
const shipCamCtx = shipCam.getContext('2d');
const SHIPCAM_SIZE = 160, SHIPCAM_ZOOM = 3.5;
const hudTop = document.getElementById('catalog');
const hudShip = document.getElementById('ship');
const hudAuto = document.getElementById('autotext');
const autoBtn = document.getElementById('auto');
const cruiseBtn = document.getElementById('cruise');
const warpBtn = document.getElementById('warp');
const flash = document.getElementById('flash');
const titleCard = document.getElementById('titlecard');
const awayCard = document.getElementById('away');

let w = 0, h = 0, dpr = 1;
function resize() {
  dpr = Math.min(window.devicePixelRatio || 1, 2); // 3x screens cost 2.25x the pixels for little gain
  w = window.innerWidth; h = window.innerHeight;
  canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
}
window.addEventListener('resize', resize);
resize();

// ---- start ----
let lastDiscovery = performance.now(), allChartedAt = 0, wanderingSince = 0;
const away = { charted: 0, missions: 0, systems: 0, credits: state.credits, since: 0 };
{
  const sys = params.get('system') === 'sol' ? 'sol' : null;
  buildSystem(sys ? SOL_SEED : Math.abs(parseInt(params.get('seed') ?? '', 10)) || dailySeed(), sys);
}

function setAuto(on) {
  autopilot.enabled = on;
  autoBtn.classList.toggle('on', on);
  if (!on) universe.ship.thrust = vec();
}
autoBtn.addEventListener('click', () => { setAuto(!autopilot.enabled); if (!autopilot.enabled && state.cruise) setCruise(false); });
autoBtn.addEventListener('pointerdown', (e) => e.stopPropagation());
setAuto(params.has('auto') || state.cruise);

// ---- cruise (AFK) ----
let wakeLock = null, requestedWarp = 1;
async function holdWake(on) {
  try {
    if (on && !wakeLock && navigator.wakeLock && !document.hidden) wakeLock = await navigator.wakeLock.request('screen');
    if (!on && wakeLock) { await wakeLock.release(); wakeLock = null; }
  } catch { wakeLock = null; }
}
function setCruise(on) {
  state.cruise = on;
  cruiseBtn.classList.toggle('on', on);
  cam.director = on && state.options.cinematic;
  if (on) { setAuto(true); ui.toast('CRUISE: exploring on its own. Grab the stick any time.'); logEvent('Cruise engaged'); }
  else { requestedWarp = 1; cam.director = false; }
  holdWake(on);
  persist();
}
cruiseBtn.addEventListener('click', () => setCruise(!state.cruise));
cruiseBtn.addEventListener('pointerdown', (e) => e.stopPropagation());
if (state.cruise) setCruise(true);

// ---- time warp ----
function cycleWarp(dir = 1) {
  const i = WARPS.indexOf(requestedWarp);
  requestedWarp = dir > 0 ? WARPS[(i + 1) % WARPS.length] : WARPS[Math.max(0, i - 1)];
}
warpBtn.addEventListener('click', () => cycleWarp(1));
warpBtn.addEventListener('pointerdown', (e) => e.stopPropagation());

/** How much warp is safe right now (time warp never runs you into the ground). */
function warpCeiling() {
  const u = universe, ship = u.ship;
  if (ship.consumed || u.tidal > 0.02 || jump) return 1;
  if (ship.landing) return 16;
  if (mag(ship.thrust) > 0 && !autopilot.enabled) return 1;
  if ((ship.heatRate ?? 0) > 0.05 || (ship.atmoRho ?? 0) > 0.002) return 1;
  const ref = u.closestPlanet();
  const dSurf = dist(ref.pos, ship.pos) - ref.radius;
  const speed = mag(sub(ship.velocity, ref.velocity)) + 1;
  const secs = dSurf / speed; // seconds to the nearest surface at this speed
  return secs > 40 && dSurf > 12_000 ? 16 : secs > 20 && dSurf > 6000 ? 8 : secs > 10 && dSurf > 2500 ? 4 : secs > 5 && dSurf > 1000 ? 2 : 1;
}

// ---- input: floating stick, keys, wheel, pinch ----
const stick = { active: false, id: null, origin: vec(), target: vec(), minRadius: STICK_MIN, maxRadius: STICK_MAX, vec: null };
const keys = new Set();
const pointers = new Map();
let pinch = null;
const pos = (e) => vec(e.clientX, e.clientY);
canvas.addEventListener('pointerdown', (e) => {
  pointers.set(e.pointerId, pos(e));
  canvas.setPointerCapture(e.pointerId);
  if (pointers.size === 2) { // second finger: pinch to zoom instead of flying
    stick.active = false; stick.vec = null;
    const [a, b] = [...pointers.values()];
    pinch = { d: dist(a, b), bias: cam.bias };
    return;
  }
  if (stick.active || pointers.size > 2) return;
  stick.active = true; stick.id = e.pointerId;
  stick.origin = pos(e); stick.target = pos(e); stick.vec = null;
});
canvas.addEventListener('pointermove', (e) => {
  if (pointers.has(e.pointerId)) pointers.set(e.pointerId, pos(e));
  if (pinch && pointers.size === 2) {
    const [a, b] = [...pointers.values()];
    cam.bias = clamp(pinch.bias + Math.log(dist(a, b) / pinch.d), -4, 3);
    return;
  }
  if (!stick.active || e.pointerId !== stick.id) return;
  stick.target = pos(e);
  stick.vec = sub(stick.target, stick.origin);
});
const release = (e) => {
  pointers.delete(e.pointerId);
  if (pointers.size < 2) pinch = null;
  if (!stick.active || e.pointerId !== stick.id) return;
  stick.active = false; stick.vec = null;
  universe.ship.thrust = vec();
};
canvas.addEventListener('pointerup', release);
canvas.addEventListener('pointercancel', release);
canvas.addEventListener('lostpointercapture', release);
canvas.addEventListener('wheel', (e) => { e.preventDefault(); cam.nudgeZoom(-e.deltaY * 0.0016); }, { passive: false });
window.addEventListener('blur', () => { stick.active = false; stick.vec = null; keys.clear(); universe.ship.thrust = vec(); });

const FLY_KEYS = ['ArrowUp', 'ArrowLeft', 'ArrowRight', 'ArrowDown', 'w', 'W', 's', 'S', 'd', 'D', 'q', 'Q'];
window.addEventListener('keydown', (e) => {
  if (e.target.closest?.('#menu')) return;
  if (FLY_KEYS.includes(e.key)) { keys.add(e.key.length === 1 ? e.key.toLowerCase() : e.key); e.preventDefault(); return; }
  if (e.key === 'Shift') keys.add('shift');
  if (e.key === 'a' || e.key === 'A') { setAuto(!autopilot.enabled); if (!autopilot.enabled && state.cruise) setCruise(false); }
  if (e.key === 'c' || e.key === 'C') setCruise(!state.cruise);
  if (e.key === 'm' || e.key === 'M') ui.toggle();
  if (e.key === 'p' || e.key === 'P') openPip();
  if (e.key === '.' || e.key === ']') cycleWarp(1);
  if (e.key === ',' || e.key === '[') cycleWarp(-1);
  if (e.key === '=' || e.key === '+') cam.nudgeZoom(0.35);
  if (e.key === '-' || e.key === '_') cam.nudgeZoom(-0.35);
  if (e.key === '0') cam.resetZoom();
  if (e.key === 'v' || e.key === 'V') { cam.shot = null; pipCam.shot = null; } // next cinematic shot
  if (e.key === 'Escape' && ui.open) ui.toggle(false);
});
window.addEventListener('keyup', (e) => {
  keys.delete(e.key.length === 1 ? e.key.toLowerCase() : e.key);
  if (e.key === 'Shift') keys.delete('shift');
  if (FLY_KEYS.includes(e.key) && !keys.size) universe.ship.thrust = vec();
});

const wrapA = (a) => Math.atan2(Math.sin(a), Math.cos(a));
/** Turn the player's inputs into heading and thrust. Returns true while the pilot is flying. */
function pilot(dt) {
  const ship = universe.ship;
  const flyingKeys = ['ArrowUp', 'ArrowLeft', 'ArrowRight', 'ArrowDown', 'w', 's', 'd', 'q'].some((k) => keys.has(k));
  if (stick.active && stick.vec) {
    const m = mag(stick.vec), want = angleOf(stick.vec);
    if (!ship.landing) {
      const step = MANUAL_TURN * dt;
      ship.angle = wrapA(ship.angle + clamp(wrapA(want - ship.angle), -step, step));
    } else ship.angle = want;
    const off = Math.abs(wrapA(want - ship.angle));
    const power = m < STICK_MIN ? 0 : clamp((m - STICK_MIN) / (STICK_MAX - STICK_MIN), 0, 1);
    ship.thrust = fromAngle(ship.angle, power * Math.max(0, Math.cos(off)) ** 2); // no shove the wrong way mid-flip
    return true;
  }
  if (flyingKeys) {
    if (keys.has('ArrowLeft') || keys.has('q')) ship.angle -= KEY_TURN * dt;
    if (keys.has('ArrowRight') || keys.has('d')) ship.angle += KEY_TURN * dt;
    if (keys.has('ArrowDown') || keys.has('s')) { // swing round to retrograde (relative to the nearest world)
      const ref = universe.closestPlanet(), rv = sub(ship.velocity, ref.velocity);
      if (mag(rv) > 5) ship.angle = wrapA(ship.angle + clamp(wrapA(angleOf(rv) + Math.PI - ship.angle), -KEY_TURN * 1.5 * dt, KEY_TURN * 1.5 * dt));
    }
    const up = keys.has('ArrowUp') || keys.has('w');
    ship.thrust = up ? fromAngle(ship.angle, keys.has('shift') ? 0.3 : 1) : vec();
    return true;
  }
  return stick.active;
}

// ---- HUD ----
const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);
const pad = (n, width) => String(n).padStart(width, ' ');
const signed = (n) => pad((n >= 0 ? '+' : '-') + Math.abs(Math.round(n)), 7);
const fmt = (n) => (!isFinite(n) ? '∞' : Math.abs(n) >= 10_000 ? `${Math.round(n / 1000)}k` : Math.abs(n) >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${Math.round(n)}`);

function orbitLine() {
  if (!pred) return null;
  if (pred.soi) {
    const o = pred.orbit, R = o.body.radius, name = o.body.name.toUpperCase();
    if (o.end === 'impact') return `ORB: ${name}  ON COLLISION COURSE`;
    if (o.end === 'escape') return `ORB: ${name}  ESCAPING  PE ${fmt(o.pe - R)}`;
    return `ORB: ${name}  PE ${fmt(o.pe - R)}  AP ${fmt(o.ap - R)}  T ${fmt(o.period)}s${o.end === 'air' ? '  (AIR)' : ''}`;
  }
  if (pred.encounter) {
    const e = pred.encounter, o = e.orbit;
    return `ENC: ${e.body.name.toUpperCase()} in ${Math.round(e.t)}s${o ? (o.end === 'impact' ? '  IMPACT' : `  PE ${fmt(o.pe - e.body.radius)}`) : ''}`;
  }
  if (pred.impact) return `!! IMPACT ${pred.impact.body.name.toUpperCase()} in ${Math.round(pred.impact.t)}s !!`;
  return null;
}

function updateHud() {
  const u = universe, ship = u.ship, star = u.star;
  const explored = u.planets.filter((p) => p.explored);
  const designation = system === 'sol' ? 'SOL' : `PRH-${u.randomSeed % 100_000}`;
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
    ...(state.cruise ? [`SYSTEMS VISITED: ${state.stats.systems + 1}`] : []),
    '',
  ];
  const SHOWN = 5; // the rest live in the CODEX tab
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
  rescueBtn.hidden = !(f.on && f.level <= 0 && !ship.landing) || state.cruise;
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
    `CR:  ${state.credits}`,
    `THR: ${Math.round(mag(ship.thrust) * 100)}%${u.warp > 1 ? `   WARP x${u.warp}` : requestedWarp > 1 ? `   WARP x${requestedWarp} (held: too close)` : ''}`,
    `POS: <${signed(ship.pos.x)},${signed(ship.pos.y)}>`,
    `VEL: ${Math.round(mag(ship.velocity))}`,
  ].filter((x) => x !== null).join('\n');
  if (hudShip.textContent !== text) hudShip.textContent = text;
  const at = autopilot.telemetry;
  if (hudAuto.textContent !== at) hudAuto.textContent = at;
  warpBtn.textContent = `x${u.warp > 1 ? u.warp : requestedWarp}`;
  warpBtn.classList.toggle('on', u.warp > 1);
}

// Ship cam: a fixed close-up of the ship, with its velocity (relative to the nearest world) and thrust.
function drawShipCam() {
  const u = universe, ship = u.ship;
  const overview = cam.zoom >= 0.4;
  const show = state.options.pip && (cam.zoom < 0.4 || autopilot.enabled) && !ship.consumed && !jump;
  shipCam.hidden = !show;
  if (!show) return;
  const d = Math.min(window.devicePixelRatio || 1, 2);
  if (shipCam.width !== SHIPCAM_SIZE * d) { shipCam.width = shipCam.height = SHIPCAM_SIZE * d; }
  const tgt = autopilot.enabled ? autopilot.target : null;
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
    c2.fillText(`${autopilot.strategy}${tgt ? ' > ' + tgt.name.split(' ').pop() : ''}`, c, SHIPCAM_SIZE - 9);
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
  c2.fillText(autopilot.enabled ? `${autopilot.strategy}  ${Math.round(speed)} rel ${ref.name.split(' ').pop()}` : `${Math.round(speed)} rel ${ref.name.split(' ').pop()}`, c, SHIPCAM_SIZE - 9);
  c2.fillStyle = '#4ade80'; c2.textAlign = 'left'; c2.fillText('vel', 14, 14);
  c2.fillStyle = '#ff8800'; c2.fillText('thrust', 14, 25);
}

// ---- floating window (picture-in-picture) --------------------------------------------------
// A small always-on-top window with a full-quality, cinematic view: its own camera cuts between
// shots, a strip on top shows the system and how much of it is charted, the bottom shows what the
// autopilot is doing, and recent events scroll by. It has its own buttons (next shot, warp, close).
// Browsers stop animation frames in hidden tabs, so a worker ticks the game while the page is hidden.
const pipWin = { active: false, win: null, canvas: null, ctx: null, video: null, kind: null, dpr: 1, el: {} };
let ticker = null, strandedFor = 0;

function startTicker() {
  if (ticker) return;
  const blob = new Blob(['setInterval(() => postMessage(0), 33)'], { type: 'text/javascript' });
  ticker = new Worker(URL.createObjectURL(blob));
  ticker.onmessage = () => { if (document.hidden) tick(performance.now()); };
}
function stopTicker() { ticker?.terminate(); ticker = null; }
const needTicker = () => pipWin.active || state.cruise;

function sizePipCanvas() {
  if (pipWin.kind !== 'document') return;
  const win = pipWin.win;
  pipWin.dpr = Math.min(win.devicePixelRatio || 1, 2);
  pipWin.canvas.width = Math.round(win.innerWidth * pipWin.dpr);
  pipWin.canvas.height = Math.round(win.innerHeight * pipWin.dpr);
}

const PIP_CSS = `
  * { box-sizing: border-box; }
  html, body { margin: 0; height: 100%; background: #16161d; overflow: hidden; color: #b7b7ff;
    font: 500 11px/13px ui-monospace, "SF Mono", Menlo, Consolas, monospace; letter-spacing: 1px; user-select: none; }
  canvas { position: fixed; inset: 0; width: 100vw; height: 100vh; display: block; }
  .top { position: fixed; top: 0; left: 0; right: 0; padding: 7px 9px 14px;
    background: linear-gradient(#16161dee, #16161d00); pointer-events: none; }
  .name { color: #e6e6ff; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .bar { height: 3px; background: #2c2c3c; margin-top: 5px; }
  .bar > i { display: block; height: 100%; background: #4c8df6; transition: width .6s; }
  .meta { display: flex; justify-content: space-between; margin-top: 4px; opacity: .75; }
  .log { position: fixed; left: 9px; bottom: 58px; right: 9px; pointer-events: none; }
  .log div { animation: in .4s ease-out; text-shadow: 0 0 6px #16161d; }
  @keyframes in { from { opacity: 0; transform: translateY(4px); } }
  .bottom { position: fixed; left: 0; right: 0; bottom: 0; padding: 14px 9px 7px;
    background: linear-gradient(#16161d00, #16161dee); display: flex; align-items: flex-end; gap: 6px; }
  .status { flex: 1; min-width: 0; }
  .status .s { color: #4c8df6; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .fuel { height: 3px; background: #2c2c3c; margin-top: 4px; width: 100%; }
  .fuel > i { display: block; height: 100%; background: #4ade80; }
  button { font: inherit; color: #b7b7ff; background: #16161dcc; border: 1px solid #b7b7ff; padding: 5px 7px; cursor: pointer; }
  button:hover { background: #4c8df6; color: #fff; }
  .shot { position: fixed; top: 46px; right: 9px; opacity: .5; font-size: 9px; pointer-events: none; }
`;

async function openDocumentPip(testWin = null) {
  const win = testWin ?? await window.documentPictureInPicture.requestWindow({ width: 380, height: 380 });
  const doc = win.document;
  const style = doc.createElement('style'); style.textContent = PIP_CSS; doc.head.append(style);
  doc.body.innerHTML = `<canvas></canvas>
    <div class="top"><div class="name"></div><div class="bar"><i></i></div><div class="meta"><span class="charted"></span><span class="cr"></span></div></div>
    <div class="shot"></div>
    <div class="log"></div>
    <div class="bottom"><div class="status"><div class="s"></div><div class="fuel"><i></i></div></div>
      <button data-a="shot" title="Next camera shot">VIEW</button><button data-a="warp" title="Time warp">x1</button><button data-a="close" title="Close">×</button></div>`;
  const q = (s) => doc.querySelector(s);
  const canvas = q('canvas');
  pipWin.el = { name: q('.name'), bar: q('.bar > i'), charted: q('.charted'), cr: q('.cr'), log: q('.log'), s: q('.status .s'), fuel: q('.fuel > i'), warp: q('[data-a=warp]'), shot: q('.shot') };
  doc.body.addEventListener('click', (e) => {
    const a = e.target.closest?.('button')?.dataset.a;
    if (a === 'shot') pipCam.shot = null;
    if (a === 'warp') cycleWarp(1);
    if (a === 'close') closePip();
  });
  Object.assign(pipWin, { active: true, win, canvas, ctx: canvas.getContext('2d'), kind: 'document' });
  sizePipCanvas();
  win.addEventListener('resize', sizePipCanvas);
  win.addEventListener('pagehide', closePip);
}

async function openVideoPip() {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 480;
  const c2 = canvas.getContext('2d'); // a stream gives no video until the canvas has been painted once
  c2.fillStyle = '#16161d'; c2.fillRect(0, 0, 480, 480);
  const video = document.createElement('video');
  video.muted = true; video.playsInline = true; video.srcObject = canvas.captureStream(30);
  const within = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);
  await within(video.play(), 3000);
  await within(video.requestPictureInPicture(), 3000);
  video.addEventListener('leavepictureinpicture', closePip);
  Object.assign(pipWin, { active: true, canvas, ctx: canvas.getContext('2d'), video, kind: 'video', dpr: 1 });
}

async function openPip() {
  if (pipWin.active) return closePip();
  unlockSound();
  if (!state.cruise) setCruise(true); // the window is for watching: cruise flies
  const attempts = [];
  if ('documentPictureInPicture' in window) attempts.push(openDocumentPip);
  if (document.pictureInPictureEnabled) attempts.push(openVideoPip);
  let lastErr = null;
  for (const attempt of attempts) {
    try { await attempt(); lastErr = null; break; } catch (err) { lastErr = err; console.warn('floating window failed', err); }
  }
  if (!pipWin.active) {
    ui.toast(attempts.length ? `Could not open the floating window (${lastErr?.name ?? 'error'})` : 'Floating windows are not supported in this browser');
    return;
  }
  pipCam.snap(universe, 380, 380);
  startTicker();
  ui.toast('Floating window open: cruise keeps flying');
}

function closePip() {
  if (!pipWin.active) return;
  const { win, video } = pipWin;
  pipWin.active = false;
  if (!needTicker()) stopTicker();
  try { win?.close(); } catch { /* already gone */ }
  if (video) { try { document.exitPictureInPicture(); } catch { /* ignore */ } video.srcObject = null; }
  Object.assign(pipWin, { win: null, canvas: null, ctx: null, video: null, kind: null, el: {} });
}
document.getElementById('pipbtn').addEventListener('click', openPip);
document.getElementById('pipbtn').addEventListener('pointerdown', (e) => e.stopPropagation());

let pipHudClock = 0;
function drawFloating(frameDt) {
  const u = universe, { ctx: c, canvas } = pipWin;
  const d = pipWin.dpr, cw = canvas.width / d, ch = canvas.height / d;
  pipCam.update(u, frameDt, cw, ch, autopilot, false);
  renderUniverse(c, u, pipCam, cw, ch, d, false, { markers: false });
  const tgt = autopilot.target;
  const charted = u.planets.filter((p) => p.explored).length;
  if (pipWin.kind === 'document') {
    if ((pipHudClock += frameDt) < 0.2) return;
    pipHudClock = 0;
    const el = pipWin.el, now = performance.now();
    const set = (e, v) => { if (e && e.textContent !== v) e.textContent = v; };
    set(el.name, `${u.star.name}${system === 'sol' ? '' : `  ·  ${u.stars.map((s) => (s.isBlackHole ? 'BH' : s.cls)).join('+')}`}`);
    el.bar.style.width = `${Math.round((charted / u.planets.length) * 100)}%`;
    set(el.charted, `${charted}/${u.planets.length} charted${state.stats.systems ? `  ·  system ${state.stats.systems + 1}` : ''}`);
    set(el.cr, `${state.credits} CR`);
    set(el.s, jump ? 'JUMPING TO A NEW SYSTEM' : `${autopilot.strategy}${tgt ? ' > ' + tgt.name.toUpperCase() : ''}`);
    el.fuel.style.width = `${Math.round((u.fuel.level / u.fuel.capacity) * 100)}%`;
    set(el.warp, `x${u.warp}`);
    set(el.shot, pipCam.shotName.toUpperCase());
    const recent = log.filter((e) => now - e.t < 15_000).slice(-4);
    const html = recent.map((e) => `<div style="opacity:${Math.max(0.25, 1 - (now - e.t) / 15_000).toFixed(2)}">${e.text.replace(/[<&]/g, '')}</div>`).join('');
    if (el.log.innerHTML !== html) el.log.innerHTML = html;
    return;
  }
  // video fallback: no DOM to draw on, so paint the overlay into the frame
  c.setTransform(d, 0, 0, d, 0, 0);
  c.fillStyle = 'rgba(22,22,29,0.75)';
  c.fillRect(0, ch - 40, cw, 40);
  c.fillStyle = '#b7b7ff';
  c.font = '11px ui-monospace, Menlo, monospace';
  c.textAlign = 'left';
  c.fillText(`${u.star.name}  ${charted}/${u.planets.length} charted  ${state.credits} CR`, 8, ch - 25);
  c.fillStyle = '#4c8df6';
  c.fillText(`${autopilot.strategy}${tgt ? ' > ' + tgt.name : ''}${u.warp > 1 ? `  x${u.warp}` : ''}`, 8, ch - 9);
}

// ---- jumping between systems (cruise) ----
let jump = null; // { t, seed }
function jumpTo(newSeed, newSystem = null) {
  if (jump) return;
  jump = { t: 0, seed: newSeed, system: newSystem, built: false };
  logEvent('Jump drive spooling');
  ui.toast('JUMPING TO A NEW SYSTEM');
}
function updateJump(dt) {
  if (!jump) return;
  jump.t += dt;
  const k = clamp(jump.t / 2.4, 0, 1);
  cam.addTrauma(0.03 + 0.05 * k);
  flash.style.opacity = String(clamp((jump.t - 1.9) / 0.5, 0, 1));
  if (jump.t > 2.45 && !jump.built) {
    jump.built = true;
    const visited = universe.planets.filter((p) => p.explored).length;
    buildSystem(jump.seed, jump.system);
    history.replaceState(null, '', jump.system ? '?system=sol' : `?seed=${jump.seed}`);
    state.stats.systems++; away.systems++;
    setAuto(autopilot.enabled || state.cruise);
    persist();
    ui.render();
    showTitle();
    logEvent(`Arrived at ${universe.star.name}`);
    void visited;
  }
  if (jump.t > 2.6) {
    flash.style.transition = 'opacity 1.4s ease-out';
    flash.style.opacity = '0';
    setTimeout(() => { flash.style.transition = ''; }, 1500);
    jump = null;
    sound.fanfare();
  }
}
function showTitle() {
  const u = universe;
  const cls = u.stars.map((s) => (s.isBlackHole ? 'black hole' : `class ${s.cls}`)).join(' + ');
  titleCard.replaceChildren();
  const a = document.createElement('div'); a.className = 'big'; a.textContent = u.star.name.toUpperCase();
  const b = document.createElement('div');
  const comets = u.debris.items.filter((it) => it.kind === 'comet').length;
  b.textContent = `${cls}  ·  ${u.planets.length} bodies  ·  ${u.belts.length} belts${comets ? `  ·  ${comets} comet${comets > 1 ? 's' : ''}` : ''}  ·  ${u.profile.name}`;
  titleCard.append(a, b);
  titleCard.hidden = false;
  titleCard.classList.remove('show'); void titleCard.offsetWidth; titleCard.classList.add('show');
  setTimeout(() => { titleCard.hidden = true; }, 5200);
}

// ---- cruise brain: runs a few times a second ----
function cruiseThink(dt) {
  if (!state.cruise || jump) return;
  const u = universe;
  if (!autopilot.enabled && !stick.active && !keys.size && performance.now() - lastManual > 5000) setAuto(true);
  if (state.options.autobuy) {
    const cheapest = Object.keys(UPGRADES).filter((id) => state.upgrades[id] < MAX_UPGRADE)
      .sort((a, b) => UPGRADES[a].cost(state.upgrades[a]) - UPGRADES[b].cost(state.upgrades[b]))[0];
    if (cheapest && state.credits >= UPGRADES[cheapest].cost(state.upgrades[cheapest]) + 60 && buyUpgrade(cheapest)) {
      ui.toast(`CRUISE BOUGHT: ${UPGRADES[cheapest].name.toUpperCase()} LV ${state.upgrades[cheapest]}`, 'good');
      logEvent(`Upgraded ${UPGRADES[cheapest].name}`);
    }
  }
  // never stay stranded
  if (u.fuel.on && u.fuel.level <= 0 && !u.ship.landing) {
    strandedFor += dt;
    if (strandedFor > 6) { strandedFor = 0; rescue(true); }
  } else strandedFor = 0;
  if (!state.options.hop) return;
  const all = u.planets.every((p) => p.explored);
  if (all && !allChartedAt) allChartedAt = performance.now();
  // wandering = nothing new in reach: give it a minute of tours and slingshots, then move on
  if (autopilot.wandering && !wanderingSince) wanderingSince = performance.now();
  if (!autopilot.wandering) wanderingSince = 0;
  const bored = wanderingSince && performance.now() - wanderingSince > 75_000 / Math.max(1, u.warp / 2) && !autopilot.via;
  const doneHere = ((all && performance.now() - allChartedAt > 25_000) || bored) && !u.ship.landing;
  const stale = performance.now() - lastDiscovery > 8 * 60_000 / Math.max(1, u.warp);
  if (doneHere || stale) jumpTo(1 + Math.floor(Math.random() * 9_999_999));
}

// "while you were away"
function showAway() {
  const gained = state.credits - away.credits;
  const mins = Math.round((Date.now() - away.since) / 60_000);
  const lines = [
    `WHILE YOU WERE AWAY (${mins < 1 ? 'under a minute' : `${mins} min`})`,
    `${away.charted} world${away.charted === 1 ? '' : 's'} charted`,
    ...(away.systems ? [`${away.systems} new system${away.systems === 1 ? '' : 's'}`] : []),
    ...(away.missions ? [`${away.missions} mission${away.missions === 1 ? '' : 's'} done`] : []),
    `${gained >= 0 ? '+' : ''}${gained} CR`,
  ];
  awayCard.replaceChildren(...lines.map((t, i) => { const d = document.createElement('div'); if (!i) d.className = 'head'; d.textContent = t; return d; }));
  awayCard.hidden = false;
  setTimeout(() => { awayCard.hidden = true; }, 9000);
}
awayCard.addEventListener('pointerdown', (e) => { e.stopPropagation(); awayCard.hidden = true; });
function resetAway() { Object.assign(away, { charted: 0, missions: 0, systems: 0, credits: state.credits, since: Date.now() }); }
resetAway();
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    resetAway();
    if (needTicker()) startTicker();
  } else {
    if (!pipWin.active) stopTicker();
    if (state.cruise) holdWake(true);
    if (Date.now() - away.since > 45_000 && (away.charted || away.systems || away.missions)) showAway();
    lastMs = performance.now(); // do not count the hidden time as one huge frame
  }
});

// ---- the frame ----
let hudClock = 1000, lastMs = 0, missionClock = 0, lastManual = 0, lockBucket = 0, predClock = 0;
function tick(ms) {
  if (ms - lastMs < 8) return; // the page and the worker can both call this; only run once per frame
  const u = universe;
  const frameDt = Math.min(0.1, Math.max(0, (ms - lastMs) / 1000));
  const manual = pilot(frameDt);
  if (manual) lastManual = performance.now();
  autopilot.manual = manual;

  // warp: what you asked for, capped by what is safe; cruise picks its own on long coasts
  let wantWarp = requestedWarp;
  if (state.cruise && state.options.cruiseWarp && !manual) wantWarp = Math.max(wantWarp, u.ship.landing ? 4 : 8);
  if (manual) wantWarp = Math.min(wantWarp, mag(u.ship.thrust) > 0 ? 1 : wantWarp);
  u.warp = Math.min(wantWarp, warpCeiling());

  u.step(ms / 1000);
  updateJump(u.frameDt);

  // per-frame derived state: prediction, orbit holding, comet rendezvous
  const ship = u.ship;
  if (state.options.predict && !document.hidden && (predClock += u.frameDt) > 1 / 30) {
    predClock = 0;
    pred = predict(u, ship);
  } else if (!state.options.predict || ship.landing) pred = null;
  if (pred?.soi) {
    const o = pred.orbit, b = o.body, top = b.atmo ? b.atmo.top : 0;
    const stable = o.e < 1 && !o.end && o.pe > b.radius + top + 10 && o.ap < (b.hill ?? Infinity) * 0.9;
    const held = u.orbitHeld;
    held[b.name] = stable ? (held[b.name] ?? 0) + u.frameDt * u.timeScale * u.warp : 0;
  }
  for (const c of u.debris.items) {
    if (c.kind !== 'comet' || u.cometsMet.has(c.name)) continue;
    if (dist(c.pos, ship.pos) < 300 && mag(sub(ship.velocity, c.vel)) < 150) {
      u.cometsMet.add(c.name);
      state.credits += 40; state.stats.comets++;
      ui.toast(`COMET ${c.name} SAMPLED  +40 CR`, 'good'); sound.dock();
      logEvent(`Sampled comet ${c.name}`);
      persist();
    }
  }

  // camera: a gentle rumble under thrust, then the springs
  const th = mag(ship.effThrust ?? 0);
  if (th > 0 && !ship.landing) cam.trauma = Math.max(cam.trauma, 0.12 * th);
  cam.director = state.cruise && state.options.cinematic;
  cam.update(u, u.frameDt, w, h, autopilot, manual);
  if (jump) { // the stars stretch into lines as the drive spools up
    const k = clamp(jump.t / 2.4, 0, 1), dir = mag(ship.velocity) > 1 ? angleOf(ship.velocity) : ship.angle;
    cam.streak.x = Math.cos(dir) * 60_000 * k * k; cam.streak.y = Math.sin(dir) * 60_000 * k * k;
    cam.starX += cam.streak.x * u.frameDt * 0.05; cam.starY += cam.streak.y * u.frameDt * 0.05;
  }

  if (!document.hidden) { // nothing to paint in a hidden tab
    const ref = pred?.soi ?? u.closestPlanet();
    renderUniverse(ctx, u, cam, w, h, dpr, false, { pred: jump ? null : pred, markers: !jump, ref });
    drawStick(ctx, stick, dpr);
    drawShipCam();
  }
  if (pipWin.active) drawFloating(u.frameDt);
  hudClock += ms - lastMs; lastMs = ms;
  if (hudClock > 100) {
    hudClock = 0;
    if (!document.hidden) updateHud();
    checkContacts();
  }
  missionClock += Math.max(0, u.frameDt);
  if (missionClock > 0.25) { cruiseThink(missionClock); missionClock = 0; checkMissions(); }

  // sound follows what the ship is doing
  sound.update({
    thrust: mag(ship.thrust), speed: mag(ship.velocity), rho: ship.atmoRho || 0, heat: ship.heat,
    tidal: u.tidal, timeScale: u.timeScale, landed: !!ship.landing,
  });
  const lb = autopilot.strategy === 'ACQUIRING' ? Math.floor(autopilot.lock * 8) : 0;
  if (lb !== lockBucket) { if (lb > 0) sound.lockTick(autopilot.lock); lockBucket = lb; }
}
function raf(ms) { tick(ms); requestAnimationFrame(raf); }
requestAnimationFrame(raf);

window.__cam = cam; // handy for poking around in the console
window.__game = {
  jumpTo, setCruise, cycleWarp, get pred() { return pred; },
  // renders the floating window's page into an iframe (for testing where real PiP is not allowed)
  async pipTest() {
    const f = document.createElement('iframe');
    f.style.cssText = 'position:fixed;left:8px;top:8px;width:380px;height:380px;border:1px solid #b7b7ff;z-index:9';
    document.body.append(f);
    await openDocumentPip(f.contentWindow);
    pipCam.snap(universe, 380, 380);
  },
};
void STAR_CLASSES; void dist;
