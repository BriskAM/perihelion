// Autopilot personalities. Each one is a set of dials on the same autopilot: how hard it pushes, how
// keen it is on slingshots and side trips, how low it dares to skim, how long it lingers, how much warp
// cruise uses, and what the cinematic camera likes to show. Balanced is the plain autopilot.

export const PERSONALITIES = {
  balanced: {
    name: 'Balanced', desc: 'The plain autopilot: a bit of everything.',
    pace: 1, speed: 1, beltNerve: 1, lock: 1, dwell: 1, orbitFirst: null,
    assist: 0.5, assistWander: 0.85, detour: 1.45, passAlt: 0.3, vInf: [800, 1150],
    scanDepth: 0.22, tour: 0.55, reach: 25_000, comet: 0.25, warp: 8, patience: 1,
    shots: {}, shotLen: 1,
  },
  racer: {
    name: 'Racer', desc: 'As fast as possible: hard burns, straight lines, direct landings, max warp, no sightseeing.',
    pace: 2.2, speed: 1.22, beltNerve: 1.4, lock: 0.35, dwell: 0.15, orbitFirst: false,
    assist: 0.12, assistWander: 0.2, detour: 1.15, passAlt: 0.3, vInf: [1500, 2000],
    scanDepth: 0.3, tour: 0, reach: 14_000, comet: 0, warp: 16, patience: 0.5,
    shots: { chase: 2, flyby: 1.5, system: 0.3, planet: 0.6 }, shotLen: 0.6,
  },
  efficient: {
    name: 'Efficient', desc: 'As little fuel as possible: gentle speeds, coasting, aerobraking, a slingshot whenever one helps.',
    pace: 0.8, speed: 0.62, beltNerve: 1, lock: 1.2, dwell: 1, orbitFirst: true,
    assist: 0.95, assistWander: 0.95, detour: 1.65, passAlt: 0.22, vInf: [700, 950],
    scanDepth: 0.22, tour: 0.2, reach: 20_000, comet: 0.1, warp: 16, patience: 1.2,
    shots: { wide: 1.5, system: 1.5 }, shotLen: 1.2,
  },
  cinematic: {
    name: 'Cinematic', desc: 'As spectacular as possible: tight slingshots, deep scan passes, orbit tours, comet chases, long looks around.',
    pace: 0.75, speed: 0.85, beltNerve: 1, lock: 1.5, dwell: 1.8, orbitFirst: true,
    assist: 1, assistWander: 1, detour: 1.9, passAlt: 0.16, vInf: [600, 850],
    scanDepth: 0.1, tour: 0.9, reach: 40_000, comet: 0.7, warp: 4, patience: 1.8,
    shots: { flyby: 2.5, planet: 2, low: 1.5, system: 1.2, chase: 0.6 }, shotLen: 0.75,
  },
  explorer: {
    name: 'Explorer', desc: 'Chart everything: far worlds as readily as near ones, never revisits, jumps on the moment a system is done.',
    pace: 1.3, speed: 1.05, beltNerve: 1.1, lock: 0.7, dwell: 0.4, orbitFirst: null,
    assist: 0.4, assistWander: 0.4, detour: 1.3, passAlt: 0.3, vInf: [900, 1300],
    scanDepth: 0.25, tour: 0, reach: 90_000, comet: 0.15, warp: 16, patience: 0.35,
    shots: { system: 2, wide: 1.5 }, shotLen: 1,
  },
  daredevil: {
    name: 'Daredevil', desc: 'Skims everything: slingshots and scans just above the clouds, fast through rock belts, hot aerobraking.',
    pace: 1.6, speed: 1.15, beltNerve: 1.9, lock: 0.5, dwell: 0.6, orbitFirst: true,
    assist: 0.9, assistWander: 1, detour: 1.7, passAlt: 0.08, vInf: [700, 1000],
    scanDepth: 0.05, tour: 0.4, reach: 30_000, comet: 0.5, warp: 4, patience: 1,
    shots: { flyby: 3, chase: 1.5, low: 1.5 }, shotLen: 0.6,
  },
};
export const PERSONALITY_IDS = Object.keys(PERSONALITIES);
export const persona = (id) => PERSONALITIES[id] ?? PERSONALITIES.balanced;
