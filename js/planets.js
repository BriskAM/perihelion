import { clamp } from './maths.js';

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
