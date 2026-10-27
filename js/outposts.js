import { Satellite, Spacecraft } from './universe.js';
import { Autopilot } from './autopilot.js';
import { makeDesign } from './ships.js';
import { persona } from './personalities.js';
import { dist, angleOf, sub, makeRng, clamp, dailySeed } from './maths.js';

// Things you build and own: relays you drop into orbit (they pay a trickle of credits from every
// system you have left them in), a wingman ship that charts worlds for you, and the daily challenge.

// ---- outposts ----------------------------------------------------------------------------------
export const OUTPOST_COST = 300;
export const OUTPOST_PAY = 4; // credits per outpost per sim minute

/** Drop a relay into orbit around the nearest world. Returns a message (or null if not possible). */
export function deployOutpost(G) {
  const { u, state } = G, ship = u.ship;
  if (state.credits < OUTPOST_COST) return `Need ${OUTPOST_COST} CR to deploy a relay`;
  const p = u.planets.filter((q) => !q.isAnchor).sort((a, b) => dist(a.pos, ship.pos) - dist(b.pos, ship.pos))[0];
  if (!p || dist(p.pos, ship.pos) > p.radius * 6 + 3000) return 'Get closer to a world to deploy a relay';
  const top = p.atmo ? p.atmo.top : 0;
  const orbit = clamp(dist(p.pos, ship.pos), p.radius + top + 120, p.radius * 3 + top);
  const n = state.outposts.length + 1;
  const rec = { seedKey: G.seedKey, idx: u.planets.indexOf(p), orbit, phase: angleOf(sub(ship.pos, p.pos)), name: `Relay ${n}` };
  state.outposts.push(rec);
  state.credits -= OUTPOST_COST; state.counts.outposts++;
  addRelay(u, rec);
  G.say('outpost', { name: p.name });
  return `RELAY ${n} DEPLOYED OVER ${p.name.toUpperCase()}: +${OUTPOST_PAY} CR a minute from now on`;
}

function addRelay(u, rec) {
  const p = u.planets[rec.idx];
  if (!p) return;
  const sat = new Satellite({ name: rec.name, kind: 'orbiter', parent: p, orbit: rec.orbit, phase: rec.phase });
  sat.own = true;
  u.satellites.push(sat);
}

/** Recreate this system's relays after arriving (they are saved per system). */
export function rebuildOutposts(G) {
  for (const rec of G.state.outposts) if (rec.seedKey === G.seedKey) addRelay(G.u, rec);
}

let payClock = 0, paidSince = 0, toastClock = 0;
/** Every sim minute, every relay you own (in any system) pays. */
export function outpostIncome(G, simDt) {
  const n = Math.min(G.state.outposts.length, 60);
  if (!n) return;
  payClock += simDt; toastClock += simDt;
  if (payClock >= 60) { payClock -= 60; G.state.credits += n * OUTPOST_PAY; paidSince += n * OUTPOST_PAY; }
  if (toastClock >= 300 && paidSince) { G.ui.toast(`RELAYS PAID +${paidSince} CR`); toastClock = 0; paidSince = 0; }
}

// ---- wingman -----------------------------------------------------------------------------------
export const WING_COST = 2000;

export function spawnWing(G) {
  const { u, state } = G, w = state.wing;
  if (!w?.owned) return;
  const ship = new Spacecraft(makeDesign(w.model ?? 'kite', 150));
  Object.assign(ship, { name: w.name, role: 'wingman', isAI: true, isWing: true, trackMax: 400 });
  ship.pos = ship.opos = { x: u.ship.pos.x + 400, y: u.ship.pos.y + 250 };
  ship.velocity = { ...u.ship.velocity };
  const ap = new Autopilot(ship, u, { ai: true, rng: makeRng((u.randomSeed ^ 0x3171) >>> 0) });
  ap.enabled = true;
  ap.persona = persona(w.persona);
  ap.pace = ap.persona.pace;
  ap.charted = (p) => p.explored; // it charts for you, so it goes where you have not been
  ap.onEvent = (e) => { if (e.kind === 'scan' && !e.body.explored) { e.body.explored = true; u.onLanded?.(e.body, { first: true, survey: true, wing: true }); } };
  ship.autopilot = ap;
  u.entities.push(ap);
  u.ships.push(ship);
  u.wing = ship;
}

// ---- daily challenge ---------------------------------------------------------------------------
export const DAILY_GOALS = [
  { id: 'fuel', text: 'Chart 6 worlds using as little fuel as you can', unit: 'fuel', done: (c) => c.charted >= 6, score: (c) => Math.round(c.fuel), lower: true },
  { id: 'speed', text: 'Chart 6 worlds as fast as you can', unit: 's', done: (c) => c.charted >= 6, score: (c) => Math.round(c.t), lower: true },
  { id: 'slings', text: 'Take as many slingshots as you can in 10 minutes', unit: 'slingshots', done: (c) => c.t >= 600, score: (c) => c.slings, lower: false },
];
export const todayKey = () => new Date().toISOString().slice(0, 10);
export const dailyGoal = () => DAILY_GOALS[dailySeed() % DAILY_GOALS.length];
export const dailyActive = (G) => !G.system && G.seed === dailySeed();

export function dailyState(state) {
  if (!state.daily || state.daily.date !== todayKey()) state.daily = { date: todayKey(), cur: { t: 0, fuel: 0, charted: 0, slings: 0, done: false }, best: null, style: null };
  return state.daily;
}

/** Called every frame with the sim time and fuel burned since the last call. */
export function dailyTick(G, simDt, fuelBurned) {
  if (!dailyActive(G)) return;
  const d = dailyState(G.state), c = d.cur;
  if (c.done) return;
  c.t += simDt; c.fuel += fuelBurned;
  const goal = dailyGoal();
  if (!goal.done(c)) return;
  c.done = true; G.state.counts.dailies++;
  const score = goal.score(c);
  const better = d.best === null || (goal.lower ? score < d.best : score > d.best);
  if (better) { d.best = score; d.style = G.state.options.persona; }
  G.ui.toast(`DAILY CHALLENGE DONE: ${score} ${goal.unit}${better ? ' (personal best!)' : ` (best ${d.best})`}`, 'good');
  G.sound.fanfare();
  G.log(`Daily challenge: ${score} ${goal.unit}`);
  G.persist();
}

export function dailyShareText(state) {
  const d = dailyState(state), goal = dailyGoal();
  const s = d.best ?? goal.score(d.cur);
  return `Perihelion daily ${d.date}: ${goal.text}. My best: ${s} ${goal.unit}${d.style ? ` (${persona(d.style).name} style)` : ''}. ${location.origin}${location.pathname}`;
}
