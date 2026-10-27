import { makeRng } from './maths.js';

// Colour themes. Each system picks one (from its star and its seed), so every jump looks a little
// different: the default violet void, an emerald one, amber, crimson, ice, a nebula magenta, graphite.
// Planets, ships and effects keep their own colours; the theme is the space around them and the HUD.

export const THEMES = {
  violet: { name: 'Violet', void: '#16161d', grid: '#292936', orbit: '#3c3c4f', unexplored: '#a7a7ca', console: '#b7b7ff', autopilot: '#4c8df6', star: '200,205,255' },
  emerald: { name: 'Emerald', void: '#0e1915', grid: '#1c2f27', orbit: '#2b4a3e', unexplored: '#9ccab5', console: '#a3f2cc', autopilot: '#36c98a', star: '195,255,228' },
  amber: { name: 'Amber', void: '#1a140d', grid: '#33281a', orbit: '#4e3d27', unexplored: '#d5bf98', console: '#ffd69c', autopilot: '#e89a3a', star: '255,232,195' },
  crimson: { name: 'Crimson', void: '#1a0e11', grid: '#33191f', orbit: '#502831', unexplored: '#d4a4ae', console: '#ffb6c3', autopilot: '#f0566f', star: '255,208,218' },
  ice: { name: 'Ice', void: '#0d1520', grid: '#1a2a3b', orbit: '#2a4259', unexplored: '#a8c8de', console: '#b8e4ff', autopilot: '#42b0f5', star: '208,236,255' },
  nebula: { name: 'Nebula', void: '#160e1c', grid: '#2c1b37', orbit: '#442b53', unexplored: '#c5a8d6', console: '#e4b8ff', autopilot: '#a96bf2', star: '236,212,255' },
  graphite: { name: 'Graphite', void: '#131313', grid: '#262626', orbit: '#3a3a3a', unexplored: '#b4b4b4', console: '#e2e2e2', autopilot: '#8f9cff', star: '232,232,232' },
};
export const THEME_IDS = Object.keys(THEMES);

/** The theme a system would pick for itself. */
export function themeFor(u) {
  if (u.systemId === 'sol') return 'violet';
  const rng = makeRng((u.randomSeed ^ 0x7e3e) >>> 0);
  const cls = u.star.isBlackHole ? 'X' : u.star.cls;
  const options = {
    O: ['ice', 'violet'], B: ['ice', 'violet'], N: ['ice', 'graphite'], A: ['violet', 'nebula', 'ice'], F: ['violet', 'nebula', 'emerald'],
    G: ['violet', 'emerald', 'violet'], K: ['amber', 'emerald', 'violet'], M: ['crimson', 'amber'], D: ['crimson', 'amber'], X: ['graphite', 'nebula'],
  }[cls] ?? ['violet'];
  if (u.rare === 'young') return rng() < 0.6 ? 'nebula' : options[0];
  return options[Math.floor(rng() * options.length)];
}

/** Paint the page (CSS variables) and the renderer's palette with a theme. */
export function applyTheme(id, COLORS, doc = document) {
  const t = THEMES[id] ?? THEMES.violet;
  Object.assign(COLORS, { void: t.void, grid: t.grid, orbit: t.orbit, unexplored: t.unexplored, console: t.console, autopilot: t.autopilot, star: t.star });
  const root = doc.documentElement.style;
  root.setProperty('--void', t.void);
  root.setProperty('--console', t.console);
  root.setProperty('--autopilot', t.autopilot);
  root.setProperty('--line', t.orbit);
  if (doc === document) doc.querySelector('meta[name=theme-color]')?.setAttribute('content', t.void);
  return t;
}
