import { makeRng, mag } from './maths.js';

// Missions are derived from the system seed (own RNG, so the universe itself is untouched),
// which means everyone visiting the same seed gets the same three jobs.
export function makeMissions(u) {
  const rng = makeRng((u.randomSeed ^ 0x9e3779b9) >>> 0);
  const worlds = u.planets.filter((p) => !p.isMoon);
  const moons = u.planets.filter((p) => p.isMoon);
  const survey = Math.max(1, Math.ceil(worlds.length / 2));
  const target = worlds[rng.int(0, worlds.length)];
  const moon = moons.length ? moons[rng.int(0, moons.length)] : null;
  const R = Math.round(rng.range(60_000, 140_000) / 1000) * 1000;
  const seed = u.randomSeed;

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
    ...(moon ? [{
      id: `${seed}:moon`,
      title: `Land on the moon ${moon.name} (by hand; the autopilot skips moons)`,
      reward: 220,
      progress: () => [moon.explored ? 1 : 0, 1],
    }] : []),
  ];
}
