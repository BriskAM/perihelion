import { makeRng, mag } from './maths.js';
import { UNIVERSE_RANGE } from './universe.js';

export const ORBIT_HOLD = 30;

// Missions are derived from the system seed (own RNG, so the universe itself is untouched),
// which means everyone visiting the same seed gets the same three jobs.
export function makeMissions(u) {
  const rng = makeRng((u.randomSeed ^ 0x9e3779b9) >>> 0);
  const worlds = u.planets.filter((p) => !p.isMoon);
  const moons = u.planets.filter((p) => p.isMoon);
  const survey = Math.max(1, Math.ceil(worlds.length / 2));
  const target = worlds[rng.int(0, worlds.length)];
  const moon = moons.length ? moons[rng.int(0, moons.length)] : null;
  // The voyage has to take you somewhere: past where you started and past the outermost world,
  // otherwise a ship that spawns far out finishes it on the first frame.
  const outer = Math.max(0, ...worlds.map((p) => mag(p.pos)));
  const floor = Math.max(mag(u.ship.pos), outer) + 15_000;
  const R = Math.round(Math.min(UNIVERSE_RANGE * 0.95, Math.max(floor, rng.range(60_000, 140_000))) / 1000) * 1000;
  const seed = u.randomSeed;
  // later additions draw after the originals, so the first jobs stay the same for a given seed
  const roomy = worlds.filter((p) => p.hill > p.radius * 4 && !p.gas);
  const orbitTarget = roomy.length ? roomy[rng.int(0, roomy.length)] : null;
  const comet = u.debris.items.find((it) => it.kind === 'comet') ?? null;

  return [
    {
      id: `${seed}:survey`,
      title: `Survey ${survey} ${survey === 1 ? 'body' : 'bodies'} in ${u.star.name}`,
      reward: 100 + 30 * survey,
      progress: () => [Math.min(survey, u.planets.filter((p) => p.explored).length), survey], // moons count too
    },
    {
      id: `${seed}:visit`,
      title: `Land on ${target.name}`,
      reward: 120,
      progress: () => [target.explored ? 1 : 0, 1],
    },
    {
      id: `${seed}:voyage`,
      title: `Voyage ${R.toLocaleString('en-US')} units from the star`,
      reward: 150 + Math.round(R / 1000),
      progress: () => [Math.min(R, Math.round(mag(u.ship.pos))), R],
    },
    ...(orbitTarget ? [{
      id: `${seed}:orbit`,
      title: `Hold a stable orbit around ${orbitTarget.name} for ${ORBIT_HOLD} s (no thrust needed: watch the predicted path close)`,
      reward: 200,
      progress: () => [Math.min(ORBIT_HOLD, Math.floor(u.orbitHeld?.[orbitTarget.name] ?? 0)), ORBIT_HOLD],
    }] : []),
    ...(comet ? [{
      id: `${seed}:comet`,
      title: `Rendezvous with comet ${comet.name}: get within 300 at under 150 relative speed`,
      reward: 260,
      progress: () => [u.cometsMet?.has(comet.name) ? 1 : 0, 1],
    }] : []),
    ...(moon ? [{
      id: `${seed}:moon`,
      title: `Land on the moon ${moon.name} (by hand; the autopilot skips moons)`,
      reward: 220,
      progress: () => [moon.explored ? 1 : 0, 1],
    }] : []),
  ];
}
