import { renderUniverse } from './render.js';
import { clamp, dist } from './maths.js';

// Postcards: when something worth seeing happens (a slingshot, a first landing, a comet strike, a new
// system) the game frames the moment from its own camera, stamps a caption on it and keeps it. They
// pile up while you are away, so coming back means flipping through what you missed.

const KEY = 'perihelion.postcards.v1';
const MAX = 36;
const W = 360, H = 240;
let canvas = null;

export function loadPostcards() {
  try { return JSON.parse(localStorage.getItem(KEY)) ?? []; } catch { return []; }
}

function savePostcards(list) {
  for (let n = list.length; n > 0; n -= 4) { // drop the oldest until it fits the storage quota
    try { localStorage.setItem(KEY, JSON.stringify(list.slice(-n))); return; } catch { /* too big: try fewer */ }
  }
}

/**
 * Snap the scene around `focus` (a point, and something else to keep in frame) with a caption.
 * Returns the stored card.
 */
export function takePostcard(u, { focus, other = null, caption, sub = '' }) {
  canvas ??= document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d');
  const span = other ? dist(focus, other.pos ?? other) + (other.radius ?? 0) * 2.2 : 1200;
  const zoom = clamp((0.8 * H) / Math.max(span, 300), 0.0015, 3);
  const cx = other ? (focus.x + (other.pos ?? other).x) / 2 : focus.x, cy = other ? (focus.y + (other.pos ?? other).y) / 2 : focus.y;
  renderUniverse(ctx, u, { x: cx, y: cy, zoom, starX: cx * 0.02, starY: cy * 0.02 }, W, H, 1, false, { markers: false });
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  const g = ctx.createLinearGradient(0, H - 46, 0, H);
  g.addColorStop(0, 'rgba(22,22,29,0)'); g.addColorStop(1, 'rgba(22,22,29,0.92)');
  ctx.fillStyle = g; ctx.fillRect(0, H - 46, W, 46);
  ctx.font = '600 12px ui-monospace, Menlo, monospace'; ctx.fillStyle = '#e6e6ff'; ctx.textAlign = 'left';
  ctx.fillText(caption.toUpperCase(), 10, H - 22);
  ctx.font = '10px ui-monospace, Menlo, monospace'; ctx.fillStyle = '#b7b7ff';
  ctx.fillText(sub, 10, H - 8);
  const card = { img: canvas.toDataURL('image/jpeg', 0.72), caption, sub, t: Date.now() };
  const list = loadPostcards();
  list.push(card);
  while (list.length > MAX) list.shift();
  savePostcards(list);
  return card;
}
