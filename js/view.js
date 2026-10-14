import { PI2 } from './maths.js';

// Viewport helpers. The big cost in the first version was stroking circles that are far larger
// than the screen (gravity rings, orbits, planet outlines when you are parked on a planet): the
// browser tessellates the whole circle. These helpers only build the part that is on screen.

/** cx, cy: camera centre in world units; w, h: CSS pixels; zoom: CSS pixels per world unit. */
export function makeView(cx, cy, w, h, zoom) {
  const halfW = w / 2 / zoom, halfH = h / 2 / zoom;
  return { cx, cy, halfW, halfH, h: Math.hypot(halfW, halfH) * 1.05, zoom, tol: 0.6 / zoom };
}

export const inView = (view, x, y, r) => Math.hypot(x - view.cx, y - view.cy) - r <= view.h;

/**
 * Add a circle (or an arc of it) to the current path, but only the visible part for big ones.
 * Returns false when nothing is visible.
 */
export function arcPath(ctx, view, cx, cy, r) {
  if (r * view.zoom < 140) { // small on screen: a normal arc is fine
    if (!inView(view, cx, cy, r)) return false;
    ctx.moveTo(cx + r, cy);
    ctx.arc(cx, cy, r, 0, PI2);
    return true;
  }
  const dx = view.cx - cx, dy = view.cy - cy, d = Math.hypot(dx, dy), h = view.h;
  if (Math.abs(d - r) > h) return false;
  let from = 0, to = PI2;
  if (d > 1e-6) {
    const base = Math.atan2(dy, dx);
    const c = Math.max(-1, Math.min(1, (r * r + d * d - h * h) / (2 * r * d)));
    const phi = Math.acos(c) + 0.01;
    from = base - phi; to = base + phi;
  }
  const step = 2 * Math.acos(Math.max(0, 1 - view.tol / r));
  const n = Math.max(2, Math.ceil((to - from) / step));
  ctx.moveTo(cx + Math.cos(from) * r, cy + Math.sin(from) * r);
  for (let i = 1; i <= n; i++) {
    const a = from + ((to - from) * i) / n;
    ctx.lineTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
  }
  return true;
}

/** Add a filled-disc path (the visible sector only for big discs). Returns false if invisible. */
export function discPath(ctx, view, cx, cy, r) {
  if (r * view.zoom < 140) {
    if (!inView(view, cx, cy, r)) return false;
    ctx.moveTo(cx + r, cy);
    ctx.arc(cx, cy, r, 0, PI2);
    return true;
  }
  const dx = view.cx - cx, dy = view.cy - cy, d = Math.hypot(dx, dy), h = view.h;
  if (d - h > r) return false;
  if (d + h < r) { // the whole screen is inside the disc
    ctx.rect(view.cx - h, view.cy - h, 2 * h, 2 * h);
    return true;
  }
  const base = Math.atan2(dy, dx);
  const span = d > h ? Math.min(Math.PI, Math.asin(h / d) + 0.02) : Math.PI;
  const step = 2 * Math.acos(Math.max(0, 1 - view.tol / r));
  const n = Math.max(2, Math.ceil((2 * span) / step));
  ctx.moveTo(cx, cy);
  for (let i = 0; i <= n; i++) {
    const a = base - span + ((2 * span) * i) / n;
    ctx.lineTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
  }
  ctx.closePath();
  return true;
}
