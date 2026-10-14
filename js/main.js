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
import { Sound } from './audio.js';

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

function applyShip() {
  autopilot.assist = state.options.assist;
  autopilot.orbitFirst = state.options.orbit;
  autopilot.pace = state.options.pace;
  sound.setVolume(state.options.volume);
  if (state.options.volume > 0) unlockSound();
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
  if (first && !rescue) sound.discover(planet.name); else if (!rescue) sound.touchdown();
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
      ui.toast(`RANK UP: ${title.toUpperCase()}`, 'good'); sound.fanfare();
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
      ui.toast(`MISSION COMPLETE: ${m.title}  +${m.reward} CR`, 'good'); sound.fanfare();
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
// Rescue: park on the nearest solid world. Free when the game is playing itself (see idle mode).
function rescue(free = false) {
  const solid = universe.planets.filter((p) => !p.gas);
  const planet = solid.reduce((a, b) => (dist(a.pos, universe.ship.pos) < dist(b.pos, universe.ship.pos) ? a : b));
  if (!free) state.credits = Math.floor(state.credits * 0.75);
  universe.forceLand(planet, true);
  universe.fuel.level = Math.min(universe.fuel.capacity, 20);
  ui.toast(free ? 'AUTO-RESCUE' : 'RESCUED: -25% credits'); persist();
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
  persist();
}
universe.onConsumed = () => sound.swallowed() || respawnPlayer('LOST TO THE SINGULARITY: -25% credits', universe.blackHoles);
universe.onDestroyed = (ship, { planet, speed, reason }) => sound.explode() ||
  respawnPlayer(reason === 'crashed' || !reason
    ? `CRASHED ON ${planet.name.toUpperCase()} AT ${Math.round(speed)}: -25% credits`
    : `${reason.toUpperCase()} AT ${planet.name.toUpperCase()}: -25% credits`, []);
universe.onServiced = (sat) => {
  sound.dock();
  state.credits += 10;
  ui.toast(`DOCKED WITH ${sat.name.toUpperCase()}: +10 CR${universe.fuel.on ? ', +15 fuel' : ''}`, 'good');
  persist();
};
universe.onImpact = ({ planet, speed, safe, damage }) => sound.thud() ||
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
  // ship close-up when the main view is zoomed out; while the autopilot idles it is always up, and
  // when the main view is zoomed in it switches to a wide overview of the trip instead
  const overview = cam.zoom >= 0.4;
  const show = state.options.pip && (cam.zoom < 0.4 || autopilot.enabled) && !ship.consumed;
  pip.hidden = !show;
  if (!show) return;
  const d = Math.min(window.devicePixelRatio || 1, 2);
  if (pip.width !== PIP_SIZE * d) { pip.width = pip.height = PIP_SIZE * d; }
  const tgt = autopilot.enabled ? autopilot.target : null;
  const span = tgt ? Math.max(1500, dist(tgt.pos, ship.pos)) : 20_000;
  const zoomNow = overview ? clamp(62 / span, 0.0008, 0.3) : PIP_ZOOM;
  renderUniverse(pipCtx, u, { x: ship.pos.x, y: ship.pos.y, zoom: zoomNow }, PIP_SIZE, PIP_SIZE, d);
  pipCtx.setTransform(d, 0, 0, d, 0, 0);
  const c = PIP_SIZE / 2, ref = u.closestPlanet();
  if (overview) { // wide view: mark the ship and the target it is flying to
    pipCtx.strokeStyle = '#fff'; pipCtx.lineWidth = 1.5;
    pipCtx.beginPath(); pipCtx.arc(c, c, 4, 0, Math.PI * 2); pipCtx.stroke();
    if (tgt) {
      const tx = c + (tgt.pos.x - ship.pos.x) * zoomNow, ty = c + (tgt.pos.y - ship.pos.y) * zoomNow;
      pipCtx.strokeStyle = '#4c8df6'; pipCtx.setLineDash([3, 3]);
      pipCtx.beginPath(); pipCtx.moveTo(c, c); pipCtx.lineTo(tx, ty); pipCtx.stroke(); pipCtx.setLineDash([]);
      pipCtx.beginPath(); pipCtx.arc(tx, ty, 6, 0, Math.PI * 2); pipCtx.stroke();
    }
    pipCtx.fillStyle = '#b7b7ff'; pipCtx.font = '9px ui-monospace, Menlo, monospace'; pipCtx.textAlign = 'center';
    pipCtx.fillText(`${autopilot.strategy}${tgt ? ' > ' + tgt.name.split(' ').pop() : ''}`, c, PIP_SIZE - 9);
    return;
  }
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
  pipCtx.fillText(autopilot.enabled ? `${autopilot.strategy}  ${Math.round(speed)} rel ${ref.name.split(' ').pop()}` : `${Math.round(speed)} rel ${ref.name.split(' ').pop()}`, c, PIP_SIZE - 9);
  pipCtx.fillStyle = '#4ade80'; pipCtx.textAlign = 'left'; pipCtx.fillText('vel', 14, 14);
  pipCtx.fillStyle = '#ff8800'; pipCtx.fillText('thrust', 14, 25);
}

// ---- floating window (picture-in-picture) --------------------------------------------------
// Opens a small always-on-top window showing the autopilot flying a low-detail view, so you can keep
// watching while you use other tabs. It uses the Document Picture-in-Picture API where there is one
// (Chrome/Edge) and a video PiP of a canvas stream elsewhere. Browsers stop animation frames in a
// hidden tab, so while the window is open a worker ticks the game instead, and idle mode keeps it going.
const pipWin = { active: false, win: null, canvas: null, ctx: null, video: null, kind: null, dpr: 1 };
let ticker = null, strandedFor = 0;

function startTicker() {
  if (ticker) return;
  const blob = new Blob(['setInterval(() => postMessage(0), 33)'], { type: 'text/javascript' });
  ticker = new Worker(URL.createObjectURL(blob));
  ticker.onmessage = () => { if (document.hidden) tick(performance.now()); };
}
function stopTicker() { ticker?.terminate(); ticker = null; }

function sizePipCanvas() {
  if (pipWin.kind !== 'document') return;
  const win = pipWin.win;
  pipWin.dpr = Math.min(win.devicePixelRatio || 1, 2);
  pipWin.canvas.width = Math.round(win.innerWidth * pipWin.dpr);
  pipWin.canvas.height = Math.round(win.innerHeight * pipWin.dpr);
}

async function openDocumentPip() {
  const win = await window.documentPictureInPicture.requestWindow({ width: 340, height: 340 });
  win.document.body.style.cssText = 'margin:0;background:#16161d;overflow:hidden';
  const canvas = win.document.createElement('canvas');
  canvas.style.cssText = 'width:100vw;height:100vh;display:block';
  win.document.body.append(canvas);
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
  setAuto(true); // the window is for watching: the autopilot flies
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
  startTicker();
  ui.toast('Floating window open: the autopilot keeps flying');
}

function closePip() {
  if (!pipWin.active) return;
  const { win, video } = pipWin;
  pipWin.active = false;
  stopTicker();
  try { win?.close(); } catch { /* already gone */ }
  if (video) { try { document.exitPictureInPicture(); } catch { /* ignore */ } video.srcObject = null; }
  Object.assign(pipWin, { win: null, canvas: null, ctx: null, video: null, kind: null });
}
document.getElementById('pipbtn').addEventListener('click', openPip);
document.getElementById('pipbtn').addEventListener('pointerdown', (e) => e.stopPropagation());
window.addEventListener('keydown', (e) => { if (e.key === 'p' || e.key === 'P') openPip(); });

// the low-detail picture for the floating window
function drawFloating() {
  const u = universe, ship = u.ship, { ctx: c, canvas } = pipWin;
  const d = pipWin.dpr, cw = canvas.width / d, ch = canvas.height / d;
  renderUniverse(c, u, { x: ship.pos.x, y: ship.pos.y, zoom: cam.zoom }, cw, ch, d, true);
  c.setTransform(d, 0, 0, d, 0, 0);
  c.fillStyle = 'rgba(22,22,29,0.75)';
  c.fillRect(0, ch - 40, cw, 40);
  c.fillStyle = '#b7b7ff';
  c.font = '11px ui-monospace, Menlo, monospace';
  c.textAlign = 'left';
  const tgt = autopilot.target;
  c.fillText(`${u.star.name}  ${u.planets.filter((p) => p.explored).length}/${u.planets.length} charted`, 8, ch - 25);
  c.fillStyle = '#4c8df6';
  c.fillText(`${autopilot.strategy}${tgt ? ' > ' + tgt.name : ''}`, 8, ch - 9);
}

let lockBucket = 0;
function tick(ms) {
  if (ms - lastMs < 8) return; // the page and the worker can both call this; only run once per frame
  const u = universe;
  u.step(ms / 1000);

  const closest = u.closestPlanet();
  const distToSurf = Math.max(0, dist(u.ship.pos, closest.pos) - closest.radius * 1.2);
  const target = dynamicZoom ? clamp(500 / distToSurf, MIN_ZOOM, MAX_ZOOM) : DEFAULT_ZOOM;
  cam.zoom = expSmooth(cam.zoom, target, u.frameDt, 1.5);
  cam.x = u.ship.pos.x; cam.y = u.ship.pos.y;

  if (!document.hidden) { // nothing to paint in a hidden tab
    renderUniverse(ctx, u, cam, w, h, dpr);
    drawStick(ctx, stick, dpr);
    drawShipCam();
  }
  if (pipWin.active) drawFloating();
  autopilot.manual = stick.active;
  hudClock += ms - lastMs; lastMs = ms;
  if (hudClock > 100) {
    hudClock = 0;
    if (!document.hidden) updateHud();
    checkContacts();
  }
  missionClock += Math.max(0, u.frameDt);
  if (missionClock > 0.25) { missionClock = 0; checkMissions(); }

  // sound follows what the ship is doing
  sound.update({
    thrust: mag(u.ship.thrust), speed: mag(u.ship.velocity), rho: u.ship.atmoRho || 0, heat: u.ship.heat,
    tidal: u.tidal, timeScale: u.timeScale, landed: !!u.ship.landing,
  });
  const lb = autopilot.strategy === 'ACQUIRING' ? Math.floor(autopilot.lock * 8) : 0;
  if (lb !== lockBucket) { if (lb > 0) sound.lockTick(autopilot.lock); lockBucket = lb; }

  // idle mode (floating window open): never stay stranded
  if (pipWin.active && u.fuel.on && u.fuel.level <= 0 && !u.ship.landing) {
    strandedFor += u.frameDt;
    if (strandedFor > 6) { strandedFor = 0; rescue(true); }
  } else strandedFor = 0;
}
function raf(ms) { tick(ms); requestAnimationFrame(raf); }
requestAnimationFrame(raf);

window.__universe = universe;
window.__cam = cam; // handy for poking around in the console
void STAR_CLASSES;
