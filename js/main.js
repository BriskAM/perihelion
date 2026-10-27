import {
  clamp, dailySeed, mag, sub, mul, angleOf, fromAngle, vec, dist,
} from './maths.js';
import { Universe, STAR_CLASSES, landingSpeedLimit, SOL_SEED, Spark } from './universe.js';
import { Autopilot } from './autopilot.js';
import { renderUniverse, drawStick, COLORS } from './render.js';
import { themeFor, applyTheme, THEMES } from './themes.js';
import {
  loadSave, writeSave, resetSave, shipStats, UPGRADES, MAX_UPGRADE, MILESTONES,
} from './save.js';
import { makeMissions } from './missions.js';
import { createUI } from './ui.js';
import { makeDesign } from './ships.js';
import { Sound } from './audio.js';
import { Camera } from './camera.js';
import { predict } from './predict.js';
import { WorldEvents, HULL } from './events.js';
import { takePostcard, loadPostcards } from './postcards.js';
import { checkAchievements, ACHIEVEMENTS } from './achievements.js';
import { persona, PERSONALITIES, PERSONALITY_IDS } from './personalities.js';
import { STAGES, nextSignalSeed, systemName, placeBeacon, updateBeacon, reachedBeacon } from './story.js';
import { captainsLine } from './captainlog.js';
import { deployOutpost, rebuildOutposts, outpostIncome, spawnWing, WING_COST, dailyTick, dailyActive, dailyState, dailyShareText } from './outposts.js';
import { Maneuver } from './maneuver.js';
import { Replay } from './replay.js';
import { Wonders } from './wonders.js';
import { createPip } from './pip.js';
import { createHud, cap } from './hud.js';

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
  get here() { return { seed, system }; },
};

// log of things that happened (shown in the floating window and the "while you were away" card)
const log = [];
function logEvent(text, voice = false) {
  log.push({ text, t: performance.now(), voice });
  if (log.length > 40) log.shift();
}
/** The captain says something about it (in the style of the current autopilot personality). */
function say(kind, data = {}) {
  const line = captainsLine(kind, { star: universe?.star.name, ...data }, state.options.persona);
  if (!line) return;
  logEvent(line, true);
  state.captainLog.push({ t: Date.now(), text: line, sys: universe?.star.name });
  if (state.captainLog.length > 80) state.captainLog.shift();
}
const maneuver = new Maneuver();
const replay = new Replay();
// what the feature modules (story, outposts, wingman, daily) can reach
const G = {
  get u() { return universe; }, get ap() { return autopilot; }, get seed() { return seed; }, get system() { return system; }, get seedKey() { return seedKey; },
  state, get ui() { return ui; }, sound, log: (t) => logEvent(t), say: (k, d) => say(k, d), persist: () => persist(),
};

let dirty = false;
const persist = () => { writeSave(state); dirty = false; };

const ui = createUI({
  state, game,
  actions: {
    buy(id) { buyUpgrade(id); ui.render(); },
    option(key, value) {
      state.options[key] = value; applyShip(); if (key === 'theme') setTheme(); persist(); ui.render();
    },
    cruise(on) { setCruise(on); ui.render(); },
    persona(id) { setPersona(id); ui.render(); },
    deploy() { const m = deployOutpost(G); if (m) ui.toast(m); persist(); ui.render(); },
    buyWing() {
      if (state.wing.owned || state.credits < WING_COST) return;
      state.credits -= WING_COST; state.wing.owned = true; state.counts.wing++;
      spawnWing(G); ui.toast(`WINGMAN ${state.wing.name.toUpperCase()} JOINS YOU`, 'good'); persist(); ui.render();
    },
    wingStyle(id) {
      state.wing.persona = id;
      if (universe.wing) { universe.wing.autopilot.persona = persona(id); universe.wing.autopilot.pace = persona(id).pace; }
      persist(); ui.render();
    },
    signal() { if (state.story.target && state.story.target !== seed) { jumpTo(state.story.target); ui.toggle(false); } },
    daily() { jumpTo(dailySeed()); ui.toggle(false); },
    shareDaily() {
      const t = dailyShareText(state);
      navigator.clipboard?.writeText(t).then(() => ui.toast('Result copied')).catch(() => ui.toast(t));
    },
    share() {
      const url = `${location.origin}${location.pathname}${system ? '?system=sol' : `?seed=${seed}`}`;
      if (navigator.share) navigator.share({ title: 'Perihelion', url }).catch(() => {});
      else navigator.clipboard?.writeText(url).then(() => ui.toast('Link copied')).catch(() => ui.toast(url));
    },
    randomSeed() { jumpTo(1 + Math.floor(Math.random() * 9_999_999), null); ui.toggle(false); },
    travel(s, sys) { jumpTo(s, sys ?? null); ui.toggle(false); },
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
  const P = persona(state.options.persona);
  autopilot.persona = P;
  autopilot.orbitFirst = P.orbitFirst ?? state.options.orbit;
  autopilot.pace = state.options.pace * P.pace;
  autopilot.lockTime = 2.5 * P.lock;
  autopilot.sightseeing = 15 * P.dwell;
  cam.style = P; pipCam.style = P;
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
    if (e.kind === 'assist' || e.kind === 'scan') {
      state.counts.slingshots++; score.slings++;
      if (dailyActive(G)) dailyState(state).cur.slings++;
      sound.swell();
      say(e.kind === 'scan' ? 'scan' : 'slingshot', { name: e.body.name, turn: Math.round(e.turn), pe: Math.round(e.pe), gain: Math.round(e.gain) });
      queueReplay(14, e.body, `${e.kind === 'scan' ? 'SCAN PASS' : 'SLINGSHOT'}: ${e.body.name.toUpperCase()}`);
      state.counts.bestTurn = Math.max(state.counts.bestTurn, Math.round(e.turn));
      postcard({ focus: universe.ship.pos, other: e.body, caption: `${e.kind === 'scan' ? 'Scan pass' : 'Slingshot'} round ${e.body.name}`, sub: `turned ${Math.round(e.turn)}°, closest ${Math.round(e.pe)} above the surface` });
    }
    if (e.kind === 'assist') {
      const gain = Math.round(e.gain);
      ui.toast(`SLINGSHOT ${e.body.name.toUpperCase()}: turned ${Math.round(e.turn)}°, ${gain >= 0 ? `+${gain} speed` : `${-gain} slower`}, closest pass ${Math.round(e.pe)}`, gain > 0 ? 'good' : '');
      logEvent(`Slingshot round ${e.body.name}: ${gain >= 0 ? '+' : ''}${gain} speed`);
      cam.addTrauma(0.15);
    } else if (e.kind === 'scan') {
      // the deeper the pass, the better the data; storms double it
      const top = e.body.atmo ? e.body.atmo.top : 0, depth = clamp(1 - (e.pe - top) / (e.body.radius * 0.5), 0, 1);
      const storm = e.body.storm?.on;
      const bonus = Math.round((40 + 160 * depth) * (storm ? 2 : 1));
      state.credits += bonus; state.counts.scans++; if (storm) state.counts.stormScans++;
      ui.toast(`SCAN DATA FROM ${e.body.name.toUpperCase()}: ${Math.round(depth * 100)}% depth${storm ? ', STORM' : ''}  +${bonus} CR`, 'good');
      logEvent(`Scan pass over ${e.body.name}: +${bonus} CR`);
      persist();
    } else if (e.kind === 'tour') {
      state.counts.tours++; say('tour', { name: e.body.name });
      logEvent(`Orbit tour of ${e.body.name}`);
    }
  };
  universe.orbitHeld = {};
  universe.cometsMet = new Set();
  universe.events = new WorldEvents(universe);
  universe.events.onEvent = onWorldEvent;
  autopilot.serviceTarget = serviceTarget;
  autopilot.repairing = () => state.hull < 85;
  // the galaxy log: every system visited, in order
  let entry = state.galaxy.find((g) => g.seed === seed && (g.system ?? null) === system);
  if (!entry) {
    entry = { seed, system, name: universe.star.name, cls: universe.stars.map((s) => (s.isBlackHole ? 'BH' : s.cls)).join('+'), charted: 0, total: universe.planets.length, t: Date.now() };
    state.galaxy.push(entry);
    if (state.galaxy.length > 200) state.galaxy.shift();
    if (universe.blackHoles.length) state.counts.blackHoleSystems++;
    if (universe.systemType === 'binary') state.counts.binarySystems++;
  }
  entry.charted = universe.planets.filter((p) => p.explored).length;
  for (const idx of state.explored[seedKey] ?? []) {
    if (universe.planets[idx]) universe.planets[idx].explored = true;
  }
  missions = makeMissions(universe);
  wire(universe);
  applyShip();
  universe.fuel.level = universe.fuel.capacity;
  nearShips.clear();
  pred = null;
  lastDiscovery = universe.now;
  allChartedAt = 0; wanderingSince = 0;
  if (soundStarted) sound.setPad(universe.star.cls, !!universe.star.isBlackHole);
  cam.snap(universe, w, h); pipCam.snap(universe, 340, 340);
  window.__universe = universe;
  replay.clear(); maneuver.cancel(); usedWormholeExit = false;
  setTheme();
  rebuildOutposts(G);
  spawnWing(G);
  universe.onWingLanded = (ws, planet) => {
    if (planet.explored) return;
    planet.explored = true;
    universe.onLanded(planet, { first: true, wing: true });
    say('wing', { name: planet.name });
  };
  universe.onBeam = (b, dt) => {
    damageHull(b * 30 * dt, 'beam');
    if (performance.now() - (beamToast ?? 0) > 6000) { beamToast = performance.now(); ui.toast('!! PULSAR BEAM !!', 'bad'); sound.alarm(); say('beam'); }
  };
  universe.wonders = new Wonders(universe, params.get('wonder')); // (?wonder=fortress etc. forces one, for testing)
  universe.wonders.onEvent = onWonder;
  if (universe.wonders.list.length) setTimeout(() => ui.toast(`SOMETHING STRANGE IN THIS SYSTEM: ${universe.wonders.list.map((k) => ({ dyson: 'a Dyson swarm', fortress: 'a battle station', wormhole: 'wormholes', whales: 'star whales' })[k]).join(', ')}`, 'good'), 7000);
  if (universe.rare === 'pulsar') state.counts.pulsarSystems++;
  if (universe.rare === 'dwarf') state.counts.dwarfSystems++;
  if (universe.rare === 'young') state.counts.youngSystems++;
  startSignal();
}
let beamToast = 0;

// ---- colour themes: each system has its own (or one you lock in OPTIONS) ----
let themeId = 'violet';
function setTheme() {
  themeId = state.options.theme === 'auto' || !THEMES[state.options.theme] ? themeFor(universe) : state.options.theme;
  applyTheme(themeId, COLORS);
}

// ---- the Signal: a thread across systems ----
function startSignal() {
  const st = state.story;
  if (!st.target && !st.done && state.galaxy.length >= 3 && !system) { // it begins after a few jumps
    st.stage = 1; st.target = seed; st.targetName = universe.star.name;
    setTimeout(() => { ui.toast('FAINT SIGNAL DETECTED. It is coming from somewhere in this system.', 'good'); sound.eerie(); say('signal'); }, 6000);
  }
  placeBeacon(universe, st);
  if (universe.beacon && st.stage > 1) setTimeout(() => { ui.toast(universe.beacon.kind === 'derelict' ? 'THE SIGNAL ENDS HERE. Something huge in the outer dark.' : 'THE SIGNAL IS STRONGEST HERE.', 'good'); sound.eerie(); }, 6000);
}
function signalTick() {
  const b = universe.beacon, st = state.story;
  if (!b) return;
  updateBeacon(universe, b);
  if (!reachedBeacon(universe, b)) return;
  universe.beacon = null;
  if (autopilot.target?.src === b) autopilot.leave(autopilot.target);
  if (b.kind === 'derelict') {
    st.done = true; st.target = null;
    state.credits += 1000; state.counts.derelicts++;
    ui.toast('YOU FOUND THE DERELICT. +1000 CR', 'good'); sound.arrive(); say('derelict');
    postcard({ focus: universe.ship.pos, other: b, caption: 'The Derelict', sub: universe.star.name, force: true });
  } else {
    state.counts.beacons++;
    st.stage++;
    st.target = nextSignalSeed(seed, st.stage);
    st.targetName = systemName(st.target);
    state.credits += 100 * st.stage;
    ui.toast(`BEACON DECODED: +${100 * st.stage} CR. The coordinates point to ${st.targetName.toUpperCase()}${st.stage >= STAGES ? ' (the source)' : ''}.`, 'good');
    sound.eerie(); say('signal');
    postcard({ focus: universe.ship.pos, other: b, caption: 'Signal beacon decoded', sub: `next: ${st.targetName}`, force: true });
  }
  persist();
}

// ---- events from the simulation ----
function wire(u) {
  u.onLanded = (planet, { rescue, first, survey, wing }) => {
    if (first && !rescue) sound.discover(planet.name); else if (!rescue) sound.touchdown();
    if (!rescue) cam.addTrauma(first ? 0.25 : 0.12);
    if (!first || rescue) return;
    postcard({ focus: u.ship.pos, other: planet, caption: `${survey ? 'Surveyed' : 'Charted'} ${planet.name}`, sub: `${cap(planet.description)}${planet.climate ? ` · ${planet.climate}` : ''}` });
    const g = state.galaxy.find((e) => e.seed === seed && (e.system ?? null) === system);
    if (g) g.charted = u.planets.filter((p) => p.explored).length;
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
    lastDiscovery = u.now;
    away.charted++; score.charted++;
    if (dailyActive(G)) dailyState(state).cur.charted++;
    if (!wing) say('charted', { name: planet.name });
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
    const price = sat.isStation ? 8 : 4, ore = state.cargo, sale = ore * price;
    state.credits += 10 + sale; state.cargo = 0; state.counts.oreSold += ore;
    if (sat.isStation) { // full service
      if (u.fuel.on) u.fuel.level = u.fuel.capacity;
      state.hull = 100; state.counts.stationDocks++;
      ui.toast(`DOCKED AT ${sat.name.toUpperCase()}: refuelled, repaired${ore ? `, sold ${ore} ore +${sale} CR` : ''}`, 'good');
      logEvent(`Docked at ${sat.name}`);
      if (state.counts.stationDocks === 1) postcard({ focus: u.ship.pos, other: sat, caption: `Docked at ${sat.name}`, sub: universe.star.name });
    } else {
      state.hull = Math.min(100, state.hull + 20);
      ui.toast(`DOCKED WITH ${sat.name.toUpperCase()}: +10 CR${u.fuel.on ? ', +15 fuel' : ''}, hull +20${ore ? `, sold ${ore} ore +${sale} CR` : ''}`, 'good');
    }
    if (autopilot.target?.src === sat) autopilot.leave(autopilot.target);
    persist();
  };
  // mining: a slow touch scoops a rock into the hold (bigger rocks give more ore)
  u.onMine = (size) => {
    const room = shipStats(state).cargoMax - state.cargo;
    if (room <= 0) return false;
    const ore = Math.min(room, Math.max(1, Math.round(size / 9)));
    state.cargo += ore; dirty = true;
    sound.lockTick(0.8);
    if (state.cargo >= shipStats(state).cargoMax) ui.toast('HOLD FULL: sell ore at a station or satellite');
    return true;
  };
  u.onRockHit = (speed) => {
    cam.addTrauma(Math.min(0.45, speed / 700));
    if (speed > 200) { sound.thud(); buzz(20); }
    damageHull(HULL.rock(speed), 'rock');
  };
  u.onImpact = ({ planet, speed, safe, damage }) => {
    sound.thud(); cam.addTrauma(0.55); buzz(40);
    damageHull(HULL.impact(damage), 'impact', planet);
    ui.toast(`HARD LANDING on ${planet.name.toUpperCase()}: ${Math.round(speed)} (limit ${Math.round(safe)})` +
      (u.fuel.on ? `  -${Math.round(damage)} fuel` : ''), 'bad');
  };
  u.debris.onEvent = ({ kind, item, body, at }) => {
    if (kind === 'comet') { ui.toast(`NEW COMET INBOUND: ${item.name}`); logEvent(`Comet ${item.name} falling in`); return; }
    const d = dist(at, u.ship.pos);
    if (d < 25_000) cam.addTrauma(clamp(0.5 * (1 - d / 25_000) * (item.kind === 'comet' ? 2 : 0.6), 0, 0.8));
    if (item.kind === 'comet') {
      ui.toast(`COMET ${item.name} HIT ${body.name.toUpperCase()}`, 'bad');
      logEvent(`Comet ${item.name} struck ${body.name}`);
      if (d < 60_000) { state.counts.cometStrikes++; say('strike', { name: body.name }); queueReplay(8, { pos: at }, `IMPACT: ${body.name.toUpperCase()}`); postcard({ focus: at, other: body, caption: `Comet ${item.name} strikes ${body.name}`, sub: universe.star.name, force: true }); }
    }
  };
}

function buzz(p) { try { navigator.vibrate?.(p); } catch { /* not allowed */ } }

// ---- hull ----
function damageHull(amount, why, planet = null) {
  if (!(amount > 0) || universe.ship.consumed) return;
  state.hull = Math.max(0, state.hull - amount * shipStats(state).armor);
  dirty = true;
  if (state.hull <= 0) {
    state.hull = 100; // a fresh hull for the respawn
    const p = planet ?? universe.closestPlanet();
    universe.destroyShip(universe.ship, p, mag(universe.ship.velocity), 'hull failure');
  }
}

// ---- postcards: at most one every 25 s unless it is a big moment ----
let lastCard = 0, newCards = 0;
function postcard(opts) {
  const now = performance.now();
  if (!opts.force && now - lastCard < 25_000) return;
  lastCard = now;
  try { takePostcard(universe, opts); } catch (e) { console.warn('postcard failed', e); return; }
  state.counts.postcards++; newCards++;
  pip.flashPip();
}

// ---- errands for the autopilot: rescues, station visits, comet meetings ----
const wrappers = new WeakMap();
function rendezvous(src, kind) {
  let w = wrappers.get(src);
  if (w) return w;
  w = {
    isRendezvous: true, kind, src, mass: 0, explored: true,
    name: kind === 'comet' ? `COMET ${src.name}` : src.name,
    radius: kind === 'station' ? 26 : kind === 'comet' ? src.size : kind === 'derelict' || kind === 'beacon' ? src.radius
      : kind === 'wormhole' ? 60 : kind === 'whales' ? 800 : kind === 'dyson' ? 200 : kind === 'fortress' ? src.radius : 12,
    get pos() { return src.pos; }, get velocity() { return src.velocity ?? src.vel; },
  };
  wrappers.set(src, w);
  return w;
}
// somewhere you cannot follow: inside (or just above) a gas giant's air
const inGiantAir = (u, pos) => u.planets.some((p) => p.gas && dist(p.pos, pos) < p.radius + p.atmo.top * 1.3 + 300);
function serviceTarget() {
  const u = universe, ship = u.ship, f = u.fuel;
  const near = (list, max) => list.filter((x) => dist(x.pos, ship.pos) < max).sort((a, b) => dist(a.pos, ship.pos) - dist(b.pos, ship.pos))[0];
  const sos = near(u.ships.filter((s) => s.distress && !inGiantAir(u, s.pos)), 70_000);
  if (sos) return rendezvous(sos, 'distress');
  if (u.beacon) return rendezvous(u.beacon, u.beacon.kind);
  // wonders worth a detour (more often for the sightseeing styles; the daredevil goes for the fortress)
  const W = u.wonders, P = persona(state.options.persona), keen = P.comet + (P.tour > 0.5 ? 0.2 : 0);
  if (W?.whales && !W.whales.recorded && Math.random() < keen + 0.2) return rendezvous(W.whaleTarget, 'whales');
  if (W?.dyson && !W.dyson.scanned && Math.random() < keen + 0.2) return rendezvous(W.dysonTarget, 'dyson');
  if (W?.fortress && !W.fortress.scanned && state.options.persona === 'daredevil' && Math.random() < 0.5) return rendezvous(W.fortress, 'fortress');
  const max = shipStats(state).cargoMax;
  const needs = state.hull < 45 || state.cargo >= max * 0.8 || (f.on && f.level < 0.3 * f.capacity);
  const st = needs ? near(u.stations ?? [], 90_000) : null;
  if (st) return rendezvous(st, 'station');
  if (state.cruise && Math.random() < persona(state.options.persona).comet) {
    const c = near(u.debris.items.filter((it) => it.kind === 'comet' && !u.cometsMet.has(it.name)), 45_000);
    if (c) return rendezvous(c, 'comet');
  }
  return null;
}

// ---- wonders: Dyson swarms, the fortress and its superlaser, wormholes, star whales ----
let lockToast = 0, hitToast = 0;
function onWonder(e) {
  const u = universe, ship = u.ship;
  if (e.kind === 'dyson') {
    state.credits += 150; state.counts.dysons++;
    ui.toast(`DYSON SWARM SURVEYED: ${Math.round(e.dyson.complete * 100)}% complete. +150 CR`, 'good'); say('dyson');
    postcard({ focus: ship.pos, other: u.star, caption: 'A Dyson swarm', sub: u.star.name, force: true });
  } else if (e.kind === 'fortress-lock') {
    sound.alarm(); cam.addTrauma(0.2);
    if (performance.now() - lockToast > 15_000) { lockToast = performance.now(); ui.toast(`!! ${e.fortress.name.toUpperCase()} IS LOCKING ON !!`, 'bad'); say('lock'); }
  } else if (e.kind === 'fortress-fire') {
    sound.explode();
    const d = dist(e.fortress.pos, ship.pos);
    cam.addTrauma(clamp(0.7 * (1 - d / 40_000), 0.15, 0.7));
    queueReplay(6, e.fortress, `SUPERLASER: ${e.fortress.name.toUpperCase()}`);
  } else if (e.kind === 'beam-hit') {
    damageHull(70 * e.dt, 'superlaser');
    cam.addTrauma(0.5);
    if (performance.now() - hitToast > 4000) { hitToast = performance.now(); ui.toast('HIT BY THE SUPERLASER', 'bad'); say('hit'); buzz([80, 40, 80]); }
  } else if (e.kind === 'fortress-miss') {
    state.counts.dodges++;
    if (dist(e.fortress.pos, ship.pos) < 40_000) { ui.toast('SUPERLASER MISSED', 'good'); say('dodge'); }
  } else if (e.kind === 'fortress-scan') {
    state.credits += 500; state.counts.fortressScans++;
    ui.toast(`INSIDE ${e.fortress.name.toUpperCase()}'S GUARD: weak spot scanned, it has gone quiet. +500 CR`, 'good'); say('weakspot'); sound.fanfare();
    postcard({ focus: ship.pos, other: e.fortress, caption: `Inside the guard of ${e.fortress.name}`, sub: u.star.name, force: true });
    if (autopilot.target?.src === e.fortress) autopilot.leave(autopilot.target);
  } else if (e.kind === 'beam-scar') {
    if (dist(e.at, ship.pos) < 60_000) { ui.toast(`THE SUPERLASER STRUCK ${e.body.name.toUpperCase()}`, 'bad'); logEvent(`Superlaser struck ${e.body.name}`); }
  } else if (e.kind === 'wormhole') {
    state.counts.wormholes++;
    flash.style.transition = ''; flash.style.opacity = '0.8';
    setTimeout(() => { flash.style.transition = 'opacity 0.8s'; flash.style.opacity = '0'; }, 60);
    cam.snap(u, w, h); cam.addTrauma(0.5); sound.swell();
    ui.toast('THROUGH THE WORMHOLE', 'good'); say('wormhole');
    if (autopilot.target?.kind === 'wormhole') autopilot.leave(autopilot.target);
  } else if (e.kind === 'wormhole-out') {
    state.counts.wormholes++;
    ui.toast('THE WORMHOLE LEADS ELSEWHERE...', 'good'); say('wormhole');
    jumpTo(1 + Math.floor(Math.random() * 9_999_999));
  } else if (e.kind === 'whales') {
    state.credits += 120; state.counts.whales++;
    ui.toast(`STAR WHALES: recorded the ${e.whales.name}'s song. +120 CR`, 'good'); say('whales'); sound.whale();
    const c = u.wonders.whaleCenter;
    postcard({ focus: ship.pos, other: c, caption: `Star whales: the ${e.whales.name}`, sub: u.star.name, force: true });
    if (autopilot.target?.kind === 'whales') autopilot.leave(autopilot.target);
  }
  persist();
}

// ---- world events: storms, eruptions, distress calls ----
function onWorldEvent(e) {
  const u = universe, ship = u.ship;
  if (e.kind === 'storm') {
    if (dist(e.body.pos, ship.pos) < 60_000) { // (far-off weather is not news)
      ui.toast(`STORM BREWING ON ${e.body.name.toUpperCase()}: scans pay double`);
      logEvent(`Storm on ${e.body.name}`);
    }
  } else if (e.kind === 'eruption') {
    const d = dist(e.at, ship.pos);
    if (d < 25_000) {
      ui.toast(`ERUPTION ON ${e.body.name.toUpperCase()}`, 'bad');
      cam.addTrauma(clamp(0.4 * (1 - d / 25_000), 0, 0.4));
      state.counts.eruptionsSeen++; say('eruption', { name: e.body.name });
      queueReplay(8, { pos: e.at }, `ERUPTION: ${e.body.name.toUpperCase()}`);
      postcard({ focus: e.at, other: e.body, caption: `Eruption on ${e.body.name}`, sub: u.star.name });
      logEvent(`Eruption on ${e.body.name}`);
    }
  } else if (e.kind === 'distress') {
    ui.toast(`MAYDAY: ${e.ship.name} (${e.ship.role}) adrift near ${e.near.name.toUpperCase()}. Match speed to tow it: +150 CR`, 'bad');
    logEvent(`Mayday from ${e.ship.name}`);
    sound.lockTick(0.2);
  } else if (e.kind === 'rescued') {
    state.credits += 150; state.counts.rescues++; say('rescue', { ship: e.ship.name, cr: 150 });
    ui.toast(`RESCUED ${e.ship.name.toUpperCase()}  +150 CR`, 'good'); sound.fanfare();
    logEvent(`Rescued ${e.ship.name}`);
    postcard({ focus: ship.pos, other: e.ship, caption: `Rescued ${e.ship.name}`, sub: u.star.name, force: true });
    if (autopilot.target?.src === e.ship) autopilot.leave(autopilot.target);
    persist();
  } else if (e.kind === 'lost') {
    logEvent(`Lost contact with ${e.ship.name}`);
    if (autopilot.target?.src === e.ship) autopilot.leave(autopilot.target, 60);
  }
}

// ---- AI ships: announce when one comes close ----
const nearShips = new Set();
function checkContacts() {
  for (const s of universe.ships) {
    if (!s.isAI || s.isWing) continue;
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
  const u = universe;
  const far = (p) => (farFrom.length ? Math.min(...farFrom.map((b) => dist(b.pos, p.pos))) : 0);
  // wake up on solid ground (never a gas giant: there is no ground there), clear of any giant's air
  const solid = (list) => list.filter((p) => !p.gas && !inGiantAir(u, p.pos)).sort((a, b) => far(b) - far(a))[0];
  const planet = solid(u.planets.filter((p) => !p.isMoon)) ?? solid(u.planets);
  u.ship.consumed = null;
  state.credits = Math.floor(state.credits * 0.75);
  if (planet) u.forceLand(planet, true);
  else { // nothing solid in this system: drift on a quiet circular orbit round the star instead
    const r = Math.max(u.minOrbit, 40_000), a = Math.random() * Math.PI * 2;
    u.ship.landing = null;
    u.ship.pos = u.ship.opos = fromAngle(a, r);
    u.ship.velocity = fromAngle(a + Math.PI / 2, u.speedAt(r));
  }
  universe.fuel.level = Math.min(universe.fuel.capacity, 20);
  universe.timeScale = 1;
  autopilot.target = null;
  ui.toast(message, 'bad');
  logEvent(message.split(':')[0].toLowerCase().replace(/^\w/, (c) => c.toUpperCase()));
  persist();
}

const canvas = document.getElementById('space');
const ctx = canvas.getContext('2d');
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
let strandedFor = 0, usedWormholeExit = false;
let lastDiscovery = 0, allChartedAt = 0, wanderingSince = 0; // (sim time, so warp counts properly)
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
  const was = cruiseBtn.classList.contains('on');
  state.cruise = on;
  cruiseBtn.classList.toggle('on', on);
  cam.director = on && state.options.cinematic;
  if (on) { setAuto(true); if (!was) { ui.toast('CRUISE: exploring on its own. Grab the stick any time.'); logEvent('Cruise engaged'); } }
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
  const fort = u.wonders?.fortress;
  if (fort && !fort.scanned && fort.pos && dist(fort.pos, ship.pos) < fort.range * 1.2) return fort.state === 'idle' || fort.state === 'cool' ? 2 : 1;
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
  if (replay.play) { replay.stop(); return; } // a tap skips the replay
  pointers.set(e.pointerId, pos(e));
  try { canvas.setPointerCapture(e.pointerId); } catch { /* synthetic or already-released pointer */ }
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
  // let go after holding a burn preview for a moment: that burn is planned and flown for you
  if (ghostBurn && performance.now() - ghostSince > 700) planBurn();
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
  if (e.key === 'p' || e.key === 'P') pip.openPip();
  if (e.key === '.' || e.key === ']') cycleWarp(1);
  if (e.key === ',' || e.key === '[') cycleWarp(-1);
  if (e.key === '=' || e.key === '+') cam.nudgeZoom(0.35);
  if (e.key === '-' || e.key === '_') cam.nudgeZoom(-0.35);
  if (e.key === '0') cam.resetZoom();
  if (e.key === 'v' || e.key === 'V') { cam.shot = null; pipCam.shot = null; } // next cinematic shot
  if (e.key === 'b' || e.key === 'B') planBurn();
  if (e.key === 'n' || e.key === 'N') { maneuver.cycle(universe); if (maneuver.node) ui.toast(`BURN AT: ${{ now: 'NOW', pe: 'NEXT PERIAPSIS', ap: 'NEXT APOAPSIS' }[maneuver.node.at]}`); }
  if (e.key === 'x' || e.key === 'X') { if (maneuver.node) { maneuver.cancel(); ui.toast('BURN CANCELLED'); } }
  if (e.key === 'r' || e.key === 'R') startReplay(12, null, '');
  if (e.key === 'o' || e.key === 'O') { const m = deployOutpost(G); if (m) ui.toast(m); persist(); }
  if (e.key === 'k' || e.key === 'K') setPersona(PERSONALITY_IDS[(PERSONALITY_IDS.indexOf(state.options.persona) + 1) % PERSONALITY_IDS.length]);
  if (e.key === 'Escape' && ui.open) ui.toggle(false);
});
window.addEventListener('keyup', (e) => {
  keys.delete(e.key.length === 1 ? e.key.toLowerCase() : e.key);
  if (e.key === 'Shift') keys.delete('shift');
  if (FLY_KEYS.includes(e.key) && !keys.size) universe.ship.thrust = vec();
});

const wrapA = (a) => Math.atan2(Math.sin(a), Math.cos(a));
/** Turn the player's inputs into heading and thrust. Returns true while the pilot is flying. */
let ghostBurn = null, ghostPred = null, ghostSince = 0, lastGhost = null;
function planBurn() {
  const g = ghostBurn ?? lastGhost;
  if (!g || universe.ship.landing) { ui.toast('Hold the stick inside its ring to preview a burn, then plan it'); return; }
  maneuver.plan(universe, g.dir, g.dv);
  ui.toast(`BURN PLANNED: ${Math.round(g.dv)} Δv. N: at periapsis/apoapsis instead, X: cancel`, 'good');
}

// ---- personalities: switch with K, and a running scoreboard to compare them ----
const score = { t: 0, charted: 0, fuel: 0, slings: 0, lastFuel: null };
function resetScore() { Object.assign(score, { t: 0, charted: 0, fuel: 0, slings: 0, lastFuel: null }); }
function setPersona(id) {
  state.options.persona = id;
  applyShip(); resetScore(); persist();
  const P = persona(id);
  ui.toast(`AUTOPILOT STYLE: ${P.name.toUpperCase()}. ${P.desc}`);
  logEvent(`Style: ${P.name}`);
}
function scoreLine() {
  const P = persona(state.options.persona), hrs = score.t / 3600;
  if (score.t < 30) return `STYLE: ${P.name.toUpperCase()}`;
  return `STYLE: ${P.name.toUpperCase()}  ${(score.charted / hrs).toFixed(0)} worlds/h  ${score.charted ? (score.fuel / score.charted).toFixed(1) : '-'} fuel/world  ${score.slings} slings`;
}
function pilot(dt) {
  const ship = universe.ship;
  ghostBurn = null;
  const flyingKeys = ['ArrowUp', 'ArrowLeft', 'ArrowRight', 'ArrowDown', 'w', 's', 'd', 'q'].some((k) => keys.has(k));
  if (stick.active && stick.vec) {
    const m = mag(stick.vec), want = angleOf(stick.vec);
    if (!ship.landing) {
      const step = MANUAL_TURN * dt;
      ship.angle = wrapA(ship.angle + clamp(wrapA(want - ship.angle), -step, step));
    } else ship.angle = want;
    const off = Math.abs(wrapA(want - ship.angle));
    const power = m < STICK_MIN ? 0 : clamp((m - STICK_MIN) / (STICK_MAX - STICK_MIN), 0, 1);
    // inside the dead zone the stick previews a burn instead: where would a push this way take you?
    const was = ghostBurn;
    ghostBurn = m > 14 && m < STICK_MIN && !ship.landing ? { dir: want, dv: 1100 * (m / STICK_MIN) } : null;
    if (ghostBurn && !lastGhost) ghostSince = performance.now();
    lastGhost = ghostBurn; void was;
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

// ---- HUD and ship cam: see hud.js ----
const hud = createHud({
  get u() { return universe; }, get ap() { return autopilot; }, state, get system() { return system; }, get seed() { return seed; },
  get pred() { return pred; }, maneuver, get requestedWarp() { return requestedWarp; }, get jump() { return jump; }, cam, scoreLine: () => scoreLine(),
});
const { updateHud, drawShipCam } = hud;

// ---- floating window: see pip.js ----
const pip = createPip({
  get u() { return universe; }, get ap() { return autopilot; }, state, get system() { return system; }, get jump() { return jump; },
  ui, sound, pipCam, log, get theme() { return themeId; }, tick: (ms) => tick(ms), setCruise: (on) => setCruise(on), cycleWarp: (d) => cycleWarp(d), unlockSound: () => unlockSound(),
});

// ---- instant replays ----
const replayCam = { x: 0, y: 0, zoom: 1, starX: 0, starY: 0, streak: { x: 0, y: 0 }, sx: 0, sy: 0 };
let lastReplay = 0;
/** Cruise replays its best moments a couple of seconds after they happen (not too often). */
function queueReplay(seconds, focus, title) {
  if (!state.options.replays || !state.cruise || document.hidden || replay.play || replay.queue) return;
  if (performance.now() - lastReplay < 50_000 || performance.now() - lastManual < 8000) return;
  replay.queue = { at: performance.now() + 2500, seconds, focus, title };
}
function startReplay(seconds, focus, title) {
  if (replay.play) { replay.stop(); return; }
  if (!replay.start(seconds, 1, focus, title)) { ui.toast('Nothing to replay yet'); return; }
  const p = replay.play;
  p.speed = Math.max(0.15, (p.end - p.from) / 7); // about seven seconds of slow motion, whatever the warp was
  p.real = 0;
  lastReplay = performance.now();
  Object.assign(replayCam, { x: cam.x, y: cam.y, zoom: cam.zoom, starX: cam.starX, starY: cam.starY });
  sound.swell();
}
function replayFrame(dt) {
  const p = replay.play;
  p.t += dt * p.speed; p.real += dt;
  if (p.t >= p.end) { replay.stop(); return; }
  const undo = replay.apply(universe, p.t);
  const s = universe.ship.pos, f = p.focus?.pos ?? s;
  const span = Math.max(dist(s, f) + (p.focus?.radius ?? 0) * 2.4, 1600);
  const k = 1 - Math.exp(-dt * 2.5), prog = (p.t - p.from) / (p.end - p.from);
  const zoom = clamp((0.42 * Math.min(w, h)) / span * (1 + 0.35 * prog), 0.0015, 3); // a slow dolly in
  replayCam.x += ((s.x + f.x) / 2 - replayCam.x) * k; replayCam.y += ((s.y + f.y) / 2 - replayCam.y) * k;
  replayCam.zoom = Math.exp(Math.log(replayCam.zoom) + (Math.log(zoom) - Math.log(replayCam.zoom)) * k);
  if (!document.hidden || forceRender) {
    renderUniverse(ctx, universe, replayCam, w, h, dpr, false, { markers: false });
    // letterbox, title and a progress line
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const bar = Math.round(h * 0.09);
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, w, bar); ctx.fillRect(0, h - bar, w, bar);
    ctx.fillStyle = '#ff5a4a'; ctx.beginPath(); ctx.arc(18, bar / 2, 5, 0, Math.PI * 2); if (Math.floor(p.real * 2) % 2 === 0) ctx.fill();
    ctx.font = '600 12px ui-monospace, Menlo, monospace'; ctx.fillStyle = '#e6e6ff'; ctx.textAlign = 'left';
    ctx.fillText(`REPLAY  ${p.title ?? ''}`, 32, bar / 2 + 4);
    ctx.fillStyle = 'rgba(183,183,255,0.6)'; ctx.fillRect(0, h - bar, w * prog, 2);
    ctx.font = '10px ui-monospace, Menlo, monospace'; ctx.textAlign = 'right'; ctx.fillStyle = 'rgba(183,183,255,0.7)';
    ctx.fillText('tap or R to skip', w - 12, h - bar / 2 + 4);
  }
  if (pip.pipWin.active) pip.drawFloating(dt);
  undo();
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
    setTimeout(() => postcard({ focus: universe.star.pos, other: universe.ship.pos, caption: `Arrived at ${universe.star.name}`, sub: `${universe.planets.length} bodies · ${universe.profile.name}`, force: true }), 1500);
    logEvent(`Arrived at ${universe.star.name}`);
    say('arrival');
    void visited;
  }
  if (jump.t > 2.6) {
    flash.style.transition = 'opacity 1.4s ease-out';
    flash.style.opacity = '0';
    setTimeout(() => { flash.style.transition = ''; }, 1500);
    jump = null;
    sound.arrive();
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
  if (all && !allChartedAt) allChartedAt = u.now;
  // wandering = nothing new in reach: give it a minute of tours and slingshots, then move on
  if (autopilot.wandering && !wanderingSince) wanderingSince = u.now;
  if (!autopilot.wandering) wanderingSince = 0;
  const patience = persona(state.options.persona).patience;
  const bored = wanderingSince && u.now - wanderingSince > 150 * patience && !autopilot.via;
  const doneHere = ((all && u.now - allChartedAt > 40 * patience) || bored) && !u.ship.landing;
  const stale = u.now - lastDiscovery > 600 * patience;
  // never leave in the middle of an errand, or with someone calling for help
  if (autopilot.service || u.ships.some((sh) => sh.distress)) return;
  // a wormhole that leads elsewhere is a more spectacular way out than the jump drive
  const out = u.wonders?.wormholes?.find((m) => m.out);
  if ((doneHere || stale) && out && !autopilot.service && !usedWormholeExit) {
    usedWormholeExit = true;
    autopilot.target = rendezvous(out, 'wormhole'); autopilot.service = true; autopilot.lock = 0; autopilot.via = null;
    ui.toast('HEADING FOR THE WORMHOLE'); return;
  }
  if (doneHere || stale) jumpTo(state.story.target && !state.story.done && state.story.target !== seed ? state.story.target : 1 + Math.floor(Math.random() * 9_999_999));
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
    ...(newCards ? [`${newCards} new postcard${newCards === 1 ? '' : 's'} (MENU > POSTCARDS)`] : []),
  ];
  awayCard.replaceChildren(...lines.map((t, i) => { const d = document.createElement('div'); if (!i) d.className = 'head'; d.textContent = t; return d; }));
  awayCard.hidden = false;
  setTimeout(() => { awayCard.hidden = true; }, 9000);
}
awayCard.addEventListener('pointerdown', (e) => { e.stopPropagation(); awayCard.hidden = true; });
function resetAway() { Object.assign(away, { charted: 0, missions: 0, systems: 0, credits: state.credits, since: Date.now() }); newCards = 0; }
resetAway();
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    resetAway();
    if (pip.needTicker()) pip.startTicker();
  } else {
    if (!pip.pipWin.active) pip.stopTicker();
    if (state.cruise) holdWake(true);
    if (Date.now() - away.since > 45_000 && (away.charted || away.systems || away.missions || newCards)) showAway();
    lastMs = performance.now(); // do not count the hidden time as one huge frame
  }
});

// ---- the frame ----
let hudClock = 1000, lastMs = 0, missionClock = 0, lastManual = 0, lockBucket = 0, predClock = 0;
let forceRender = false; // debug: paint even when the page is hidden (see __game.run)
function tick(ms) {
  if (ms - lastMs < 8) return; // the page and the worker can both call this; only run once per frame
  const u = universe;
  const frameDt = Math.min(0.1, Math.max(0, (ms - lastMs) / 1000));
  if (replay.queue && performance.now() > replay.queue.at) { const q = replay.queue; replay.queue = null; startReplay(q.seconds, q.focus, q.title); }
  document.body.classList.toggle('replaying', !!replay.play); // (the HUD steps aside for a replay)
  if (replay.play) { replayFrame(frameDt); lastMs = ms; return; }
  let manual = pilot(frameDt);
  if (!manual && maneuver.node) {
    const r = maneuver.update(universe, frameDt * universe.timeScale);
    if (r === 'done') { ui.toast('BURN COMPLETE', 'good'); state.counts.nodes++; sound.dock(); }
    if (r) manual = true; // the planned burn has the controls (the autopilot stands by)
  }
  if (manual) lastManual = performance.now();
  autopilot.manual = manual;

  // warp: what you asked for, capped by what is safe; cruise picks its own on long coasts
  let wantWarp = requestedWarp;
  const P = persona(state.options.persona);
  if (state.cruise && state.options.cruiseWarp && !manual) wantWarp = Math.max(wantWarp, u.ship.landing ? Math.min(4, P.warp) : P.warp);
  if (manual) wantWarp = Math.min(wantWarp, mag(u.ship.thrust) > 0 ? 1 : wantWarp);
  if (maneuver.node?.burning) wantWarp = 1;
  u.warp = Math.min(wantWarp, warpCeiling());

  // the autopilot dodges a superlaser lock: burn square to the line the fortress is aiming down
  const threat = u.wonders?.threat;
  if (threat && autopilot.enabled && !manual) {
    const away = sub(u.ship.pos, threat.pos), side = fromAngle(angleOf(away) + Math.PI / 2, 1);
    // dodge one way while it tracks; once it commits its aim (the last half second), jink back the other way
    if (!autopilot.evade || autopilot.evade.from !== threat) {
      const sign = side.x * u.ship.velocity.x + side.y * u.ship.velocity.y >= 0 ? 1 : -1; // keep going the way we already drift
      autopilot.evade = { from: threat, sign };
    }
    const jink = threat.timer < 0.6 ? -1 : 1;
    autopilot.evade.dir = angleOf(mul(side, autopilot.evade.sign * jink));
    autopilot.evade.until = u.now + threat.timer + 1.5;
  }
  const fuelBefore = u.fuel.level;
  u.step(ms / 1000);
  updateJump(u.frameDt);
  const simDt = u.frameDt * u.timeScale * u.warp;
  replay.record(u);
  signalTick();
  u.wonders?.update(simDt);
  outpostIncome(G, simDt);
  dailyTick(G, simDt, Math.max(0, fuelBefore - u.fuel.level));
  // the music tenses up when the ship is in trouble
  sound.setTension?.(clamp(Math.max((u.ship.heat ?? 0) * 1.4 - 0.3, u.ship.beam ? 1 : 0, state.hull < 35 ? (35 - state.hull) / 35 : 0, u.tidal), 0, 1));

  // per-frame derived state: prediction, orbit holding, comet rendezvous
  const ship = u.ship;
  if (state.options.predict && (!document.hidden || forceRender) && (predClock += u.frameDt) > 1 / 30) {
    predClock = 0;
    pred = predict(u, ship);
  } else if (!state.options.predict || ship.landing) pred = null;
  ghostPred = maneuver.node && (!document.hidden || forceRender) ? maneuver.ghost(u) : ghostBurn && (!document.hidden || forceRender)
    ? predict(u, { pos: ship.pos, velocity: { x: ship.velocity.x + Math.cos(ghostBurn.dir) * ghostBurn.dv, y: ship.velocity.y + Math.sin(ghostBurn.dir) * ghostBurn.dv }, landing: null, consumed: null }, { steps: 260 })
    : null;
  // scoreboard: sim time flown and fuel burned (refuelling does not count) under this style
  if (autopilot.enabled) {
    score.t += u.frameDt * u.timeScale * u.warp;
    if (score.lastFuel !== null && u.fuel.level < score.lastFuel) score.fuel += score.lastFuel - u.fuel.level;
    score.lastFuel = u.fuel.level;
  }
  // hull: heat cooks it, sitting on the ground (or docking) patches it up
  if (!ship.consumed) {
    damageHull(HULL.heat(ship.heat ?? 0, u.frameDt), 'heat');
    if (ship.landing && state.hull < 100) state.hull = Math.min(100, state.hull + 4 * u.frameDt * u.warp);
  }
  // errands that ended on their own: the comet left, the rescue is over
  const at = autopilot.target;
  if (at?.isRendezvous && ((at.kind === 'comet' && (at.src.dead || u.cometsMet.has(at.src.name))) || (at.kind === 'distress' && !at.src.distress))) autopilot.leave(at);
  else if (at?.isRendezvous && at.kind !== 'station' && inGiantAir(u, at.pos)) autopilot.leave(at, 90); // it fell into a giant: do not follow
  if (pred?.soi) {
    const o = pred.orbit, b = o.body, top = b.atmo ? b.atmo.top : 0;
    const stable = o.e < 1 && !o.end && o.pe > b.radius + top + 10 && o.ap < (b.hill ?? Infinity) * 0.9;
    const held = u.orbitHeld;
    const before = held[b.name] ?? 0;
    held[b.name] = stable ? before + u.frameDt * u.timeScale * u.warp : 0;
    if (before < 30 && held[b.name] >= 30) state.counts.orbitsHeld++;
  }
  for (const c of u.debris.items) {
    if (c.kind !== 'comet' || u.cometsMet.has(c.name)) continue;
    if (dist(c.pos, ship.pos) < 300 && mag(sub(ship.velocity, c.vel)) < 150) {
      u.cometsMet.add(c.name);
      state.credits += 40; state.stats.comets++; state.counts.comets++;
      postcard({ focus: ship.pos, other: c, caption: `Sampled comet ${c.name}`, sub: universe.star.name, force: true });
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

  if (!document.hidden || forceRender) { // nothing to paint in a hidden tab
    const ref = pred?.soi ?? u.closestPlanet();
    renderUniverse(ctx, u, cam, w, h, dpr, false, { pred: jump ? null : pred, ghost: ghostPred, markers: !jump, ref });
    drawStick(ctx, stick, dpr);
    drawShipCam();
  }
  if (pip.pipWin.active) pip.drawFloating(u.frameDt);
  hudClock += ms - lastMs; lastMs = ms;
  if (hudClock > 100) {
    hudClock = 0;
    if (!document.hidden || forceRender) updateHud();
    checkContacts();
  }
  missionClock += Math.max(0, u.frameDt);
  if (missionClock > 0.25) {
    cruiseThink(missionClock); missionClock = 0; checkMissions();
    state.counts.systems = Math.max(state.counts.systems, state.galaxy.length);
    for (const a of checkAchievements(state)) {
      ui.toast(`ACHIEVEMENT: ${a.name.toUpperCase()} — ${a.desc}`, 'good'); sound.fanfare();
      logEvent(`Achievement: ${a.name}`);
      persist();
    }
  }

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
  jumpTo, setCruise, cycleWarp, get pred() { return pred; }, get log() { return log; }, get ghost() { return ghostPred; }, get state() { return state; }, maneuver, replay,
  // debug: step and paint `seconds` of frames right now (for testing in a background page)
  run(seconds = 1) {
    forceRender = true;
    const prevHidden = predClock; void prevHidden;
    let t = lastMs;
    for (let i = 0; i < seconds * 60; i++) tick((t += 1000 / 60));
    forceRender = false;
  },
  // renders the floating window's page into an iframe (for testing where real PiP is not allowed)
  async pipTest() {
    const f = document.createElement('iframe');
    f.style.cssText = 'position:fixed;left:8px;top:8px;width:380px;height:380px;border:1px solid #b7b7ff;z-index:9';
    document.body.append(f);
    await pip.openDocumentPip(f.contentWindow);
    pipCam.snap(universe, 380, 380);
  },
};
void STAR_CLASSES; void dist;
