import { makeRng, dist } from './maths.js';

// Missions are derived from the system seed (own RNG, so the universe itself is untouched),
// which means everyone visiting the same seed gets the same three jobs.
export function makeMissions(u) {
  const rng = makeRng((u.randomSeed ^ 0x9e3779b9) >>> 0);
  const n = u.planets.length;
  const survey = Math.max(1, Math.ceil(n / 2));
  const target = u.planets[rng.int(0, n)];
  const R = Math.round(rng.range(60_000, 140_000) / 1000) * 1000;
  const seed = u.randomSeed;

  return [
    {
      id: `${seed}:survey`,
      title: `Survey ${survey} ${survey === 1 ? 'body' : 'bodies'} in ${u.star.name}`,
      reward: 100 + 30 * survey,
      progress: () => [Math.min(survey, u.planets.filter((p) => p.explored).length), survey],
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
      progress: () => [Math.min(R, Math.round(dist(u.ship.pos, u.star.pos))), R],
    },
  ];
}
