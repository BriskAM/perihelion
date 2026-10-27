import { blankCounts } from './achievements.js';
// Progress lives in localStorage, so it survives sessions on one device.
const KEY = 'perihelion.save.v1';

const blank = () => ({
  v: 1,
  credits: 0,
  upgrades: { tank: 0, eff: 0, refuel: 0, armor: 0, hold: 0 },
  hull: 100, // ship condition; 0 means destroyed
  cargo: 0, // ore in the hold
  counts: blankCounts(), // running totals for achievements
  achievements: [],
  galaxy: [], // systems visited: { seed, system, name, cls, charted, total, t }
  explored: {}, // seed -> [planet index]
  codex: [], // full text of every discovery
  done: [], // completed mission ids
  milestones: [],
  options: {
    survival: true, missions: true, assist: true, fancy: true, warp: true, strict: true, pip: true, orbit: true, pace: 1, volume: 0.6,
    predict: true, smartcam: true, hop: true, autobuy: true, cruiseWarp: true, cinematic: true, persona: 'balanced',
  },
  cruise: false, // AFK mode: the ship keeps exploring (and hopping between systems) on its own
  stats: { systems: 0, comets: 0 },
  shipModel: 'dart',
});

export function loadSave() {
  try {
    const s = JSON.parse(localStorage.getItem(KEY));
    if (s && s.v === 1) {
      const b = blank();
      return { ...b, ...s, options: { ...b.options, ...s.options }, upgrades: { ...b.upgrades, ...s.upgrades }, stats: { ...b.stats, ...s.stats }, counts: { ...b.counts, ...s.counts } };
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
  armor: { name: 'Armour plating', desc: '-15% hull damage per level', cost: (l) => 180 * (l + 1) },
  hold: { name: 'Cargo hold', desc: '+10 ore capacity per level', cost: (l) => 140 * (l + 1) },
};
export const MAX_UPGRADE = 5;

export function shipStats(state) {
  const u = state.upgrades;
  return {
    capacity: 100 + 25 * u.tank,
    burn: 1.6 * (1 - 0.12 * u.eff),
    refuelRate: 10 + 5 * u.refuel,
    armor: 1 - 0.15 * (u.armor ?? 0),
    cargoMax: 20 + 10 * (u.hold ?? 0),
  };
}

export const MILESTONES = [
  [5, 'Wanderer'], [15, 'Surveyor'], [30, 'Cartographer'], [60, 'Pathfinder'], [100, 'Stargazer'],
];
