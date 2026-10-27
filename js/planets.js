import { clamp, makeRng, hsvToCss } from './maths.js';

// Physical character of a world: is it a gas giant, does it have an atmosphere, how fast does it
// spin. Rolled from a dedicated RNG stream so the planets themselves never change.

export const DRAG_COEFF = 0.0015; // deceleration = DRAG_COEFF * density * speed^2
export const HEAT_COEFF = 1e-9; // heating rate  = HEAT_COEFF * density * speed^3
export const HEAT_SAFE = 0.8; // below this heating rate the hull copes forever

/** An atmosphere has a surface density, a scale height and a ceiling (where it fades out). */
export function makeAtmosphere(rho0, H) {
  return { rho0, H, top: H * 4 };
}

export function rollPhysics(p, rng) {
  const R = p.radius;
  p.gas = !p.isMoon && R >= 1300 && rng() < 0.75;
  if (p.gas) {
    p.atmo = makeAtmosphere(0.35, R * 0.1); // density is measured at the cloud tops
    p.collides = false; // no surface to land on
  } else {
    const chance = p.isMoon ? 0.12 : R < 150 ? 0.05 : R < 400 ? 0.35 : 0.55;
    if (rng() < chance) p.atmo = makeAtmosphere(rng.range(0.1, 1), clamp(R * 0.12, 40, 300));
  }
  p.spin = rng.range(0.01, 0.08) * (rng() < 0.2 ? -1 : 1);
}

/** Air density at a given altitude above the surface (above the cloud tops for gas giants). */
export function densityAt(p, alt) {
  const a = p.atmo;
  if (!a || alt > a.top) return 0;
  return a.rho0 * Math.exp(-alt / a.H);
}

/** Hottest speed that stays inside the heating limit at a given density. */
export function heatSafeSpeed(rho) {
  return rho <= 1e-6 ? Infinity : Math.cbrt(HEAT_SAFE / (HEAT_COEFF * rho));
}

const LUMINOSITY = { O: 3, B: 2.2, A: 1.6, F: 1.25, G: 1, K: 0.72, M: 0.45, X: 0.12 };

/**
 * Colour worlds by how much starlight they get: molten and rust-red close in, blue-green where water
 * could be liquid, pale and icy far out; gas giants go from tan to ice blue. Our own solar system
 * keeps its real colours. Uses its own random stream per planet, so nothing else changes.
 */
export function paintByClimate(u) {
  const L = u.stars.reduce((s, st) => s + (LUMINOSITY[st.isBlackHole ? 'X' : st.cls] ?? 1), 0);
  for (const p of u.planets) {
    let top = p;
    while (top.parent) top = top.parent;
    const a = Math.max(top.orbitRadius || 1, 1);
    const x = Math.sqrt(L) * Math.sqrt(50_000 / a);
    const climate = x > 1.55 ? 'molten' : x > 1.18 ? 'hot' : x > 0.86 ? 'temperate' : x > 0.66 ? 'cold' : 'frozen';
    p.climate = climate;
    const r = makeRng((p.seed ^ 0xc11a7e) >>> 0);
    let h, sat, v = 1;
    if (p.gas) {
      [h, sat] = { molten: [r.range(8, 25), 0.6], hot: [r.range(22, 40), 0.5], temperate: [r.range(32, 52), 0.42], cold: [r.range(185, 205), 0.42], frozen: [r.range(200, 230), 0.32] }[climate];
    } else if (climate === 'molten') { h = r.range(0, 22); sat = 0.82; p.lava = true; }
    else if (climate === 'hot') { h = r.range(16, 36); sat = 0.62; }
    else if (climate === 'temperate') {
      if (p.atmo) { h = r.range(140, 215); sat = 0.6; p.living = !p.isMoon && r() < 0.6; } else { h = r.range(20, 45); sat = 0.32; v = 0.92; }
    } else if (climate === 'cold') { h = r() < 0.5 ? r.range(20, 40) : r.range(180, 205); sat = 0.22; v = 0.95; }
    else { h = r.range(185, 205); sat = 0.14; }
    if (p.isMoon) sat *= 0.7;
    p.color = hsvToCss(h, sat, v);
    p.hue = h;
    if (p.atmo) p.haze = hsvToCss(climate === 'temperate' ? 205 : h, 0.45, 1);
  }
}
