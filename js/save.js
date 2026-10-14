// Progress lives in localStorage, so it survives sessions on one device.
const KEY = 'perihelion.save.v1';

const blank = () => ({
  v: 1,
  credits: 0,
  upgrades: { tank: 0, eff: 0, refuel: 0 },
  explored: {}, // seed -> [planet index]
  codex: [], // full text of every discovery
  done: [], // completed mission ids
  milestones: [],
  options: { survival: true, missions: true, assist: true, fancy: true, warp: true, strict: true },
  shipModel: 'dart',
});

export function loadSave() {
  try {
    const s = JSON.parse(localStorage.getItem(KEY));
    if (s && s.v === 1) {
      const b = blank();
      return { ...b, ...s, options: { ...b.options, ...s.options }, upgrades: { ...b.upgrades, ...s.upgrades } };
    }
  } catch { /* storage blocked or corrupt: start fresh */ }
  return blank();
}

export function writeSave(state) {
  try { localStorage.setItem(KEY, JSON.stringify(state)); } catch { /* ignore */ }
}

export function resetSave() {
  try { localStorage.removeItem(KEY); } catch { /* ignore */ }
  return blank();
}

export const UPGRADES = {
  tank: { name: 'Fuel tank', desc: '+25 capacity per level', cost: (l) => 150 * (l + 1) },
  eff: { name: 'Efficient engine', desc: '-12% burn per level', cost: (l) => 200 * (l + 1) },
  refuel: { name: 'Fast refuel', desc: '+5/s refuel per level', cost: (l) => 120 * (l + 1) },
};
export const MAX_UPGRADE = 5;

export function shipStats(state) {
  const u = state.upgrades;
  return {
    capacity: 100 + 25 * u.tank,
    burn: 1.6 * (1 - 0.12 * u.eff),
    refuelRate: 10 + 5 * u.refuel,
  };
}

export const MILESTONES = [
  [5, 'Wanderer'], [15, 'Surveyor'], [30, 'Cartographer'], [60, 'Pathfinder'], [100, 'Stargazer'],
];
