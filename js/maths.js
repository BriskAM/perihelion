export const PI2 = Math.PI * 2;

export const lerp = (a, b, t) => a + (b - a) * t;
export const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
export const lexp = (start, end, p) => (p - start) / (end - start);
export const expSmooth = (cur, target, dt = 1 / 60, speed = 5) =>
  cur + (target - cur) * (1 - Math.exp(-dt * speed));

export const vec = (x = 0, y = 0) => ({ x, y });
export const add = (a, b) => ({ x: a.x + b.x, y: a.y + b.y });
export const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y });
export const mul = (a, f) => ({ x: a.x * f, y: a.y * f });
export const mag = (a) => Math.hypot(a.x, a.y);
export const angleOf = (a) => Math.atan2(a.y, a.x);
export const dot = (a, b) => a.x * b.x + a.y * b.y;
export const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
export const fromAngle = (a, m) => ({ x: m * Math.cos(a), y: m * Math.sin(a) });

// mulberry32: small, fast, seedable
export function makeRng(seed) {
  let s = seed >>> 0;
  const next = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  next.range = (a, b) => a + (b - a) * next();
  next.int = (a, b) => a + Math.floor(next() * (b - a)); // [a, b)
  next.choose = (arr) => arr[Math.floor(next() * arr.length)];
  return next;
}

export function dailySeed() {
  const d = new Date();
  return d.getFullYear() * 10000 + d.getMonth() * 100 + d.getDate();
}

export function hsvToCss(h, s, v, a = 1) {
  h = ((h % 360) + 360) % 360;
  const f = (n) => {
    const k = (n + h / 60) % 6;
    return v - v * s * Math.max(0, Math.min(k, 4 - k, 1));
  };
  return `rgba(${Math.round(f(5) * 255)},${Math.round(f(3) * 255)},${Math.round(f(1) * 255)},${a})`;
}
