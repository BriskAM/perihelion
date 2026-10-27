import { PI2, makeRng, vec, fromAngle, dist, mag, sub } from './maths.js';
import { Universe, GRAVITATION, SPACECRAFT_MASS, UNIVERSE_RANGE } from './universe.js';

// The Signal: a story thread that runs across systems. After a couple of jumps the ship picks up a
// faint repeating signal. Each beacon you reach decodes the coordinates of the next system; the last
// one leads to a derelict, a vast ring ship drifting in the outer dark. Progress lives in the save
// (state.story); the beacon in the current system lives on the universe (u.beacon).

export const STAGES = 4; // three beacons, then the derelict

export function blankStory() { return { stage: 0, target: null, targetName: '', done: false }; }

/** The next system the signal points to, derived from where you are (so it is stable for a save). */
export function nextSignalSeed(seed, stage) {
  let h = (seed * 2654435761 + stage * 40503) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 2246822519) >>> 0;
  return 1 + (h % 9_999_999);
}

export function systemName(seed) {
  try { return new Universe(seed).star.name; } catch { return `system ${seed}`; }
}

/** Put this system's beacon (or the derelict) on a slow circular orbit somewhere quiet. */
export function placeBeacon(u, story) {
  u.beacon = null;
  if (!story.target || story.done || u.randomSeed !== story.target || u.systemId) return;
  const rng = makeRng((u.randomSeed ^ 0x51a9) >>> 0);
  const derelict = story.stage >= STAGES;
  const r = derelict ? rng.range(UNIVERSE_RANGE * 0.72, UNIVERSE_RANGE * 0.85) : rng.range(Math.max(u.minOrbit, 40_000), 120_000);
  const theta0 = rng() * PI2;
  const omega = Math.sqrt((GRAVITATION * SPACECRAFT_MASS * u.totalMass) / r ** 3);
  const b = {
    kind: derelict ? 'derelict' : 'beacon', stage: story.stage, r, theta0, omega, t0: u.now,
    name: derelict ? 'The Derelict' : `Signal source ${story.stage}/${STAGES - 1}`,
    radius: derelict ? 420 : 14, pos: vec(), velocity: vec(), spin: 0,
  };
  updateBeacon(u, b);
  u.beacon = b;
}

export function updateBeacon(u, b) {
  const a = b.theta0 + b.omega * (u.now - b.t0);
  b.pos = fromAngle(a, b.r);
  b.velocity = fromAngle(a + Math.PI / 2, b.omega * b.r);
  b.spin = u.now * (b.kind === 'derelict' ? 0.02 : 0.6);
}

/** Has the ship reached the beacon? (close, and not tearing past it) */
export function reachedBeacon(u, b) {
  const d = dist(u.ship.pos, b.pos), rel = mag(sub(u.ship.velocity, b.velocity));
  return d < b.radius + (b.kind === 'derelict' ? 300 : 250) && rel < (b.kind === 'derelict' ? 260 : 220);
}
