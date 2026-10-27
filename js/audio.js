// Procedural sound: nothing is sampled. Everything is synthesised with Web Audio from the game state,
// so it never repeats exactly and every system gets its own key.

const PENTATONIC = [0, 2, 4, 7, 9, 12, 14];
const ROOTS = { O: 196, B: 220, A: 247, F: 262, G: 294, K: 330, M: 349 }; // by star class

const hash = (str) => {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
};
const semis = (root, n) => root * 2 ** (n / 12);

export class Sound {
  constructor() { this.ctx = null; this.volume = 0.6; this.padKey = ''; }

  get ready() { return !!this.ctx && this.ctx.state === 'running'; }

  /** Call from a user gesture (browsers keep audio silent until then). */
  start() {
    if (this.ctx) { this.ctx.resume?.(); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    const ctx = (this.ctx = new AC());
    this.master = ctx.createGain();
    this.master.gain.value = this.volume * 0.5;
    this.master.connect(ctx.destination);

    const len = ctx.sampleRate * 2, buf = ctx.createBuffer(1, len, ctx.sampleRate), d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    this.noiseBuf = buf;

    const loop = (type, freq, q = 0.7) => { // a looping noise source through a filter and a gain
      const src = ctx.createBufferSource(); src.buffer = buf; src.loop = true;
      const filter = ctx.createBiquadFilter(); filter.type = type; filter.frequency.value = freq; filter.Q.value = q;
      const gain = ctx.createGain(); gain.gain.value = 0;
      src.connect(filter).connect(gain).connect(this.master);
      src.start();
      return { filter, gain };
    };
    const osc = (type, freq, filterFreq = 0) => {
      const o = ctx.createOscillator(); o.type = type; o.frequency.value = freq;
      const gain = ctx.createGain(); gain.gain.value = 0;
      if (filterFreq) {
        const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = filterFreq;
        o.connect(f).connect(gain);
      } else o.connect(gain);
      gain.connect(this.master);
      o.start();
      return { o, gain };
    };
    this.engine = loop('lowpass', 300);
    this.sub = osc('sawtooth', 50, 140);
    this.air = loop('highpass', 1200, 0.5);
    this.drone = [osc('sine', 38), osc('sine', 41.5)];
    this.pad = [osc('sine', 220), osc('sine', 277), osc('sine', 330), osc('triangle', 110)];
    this.padLfo = ctx.createOscillator(); this.padLfo.frequency.value = 0.07;
    const lfoGain = ctx.createGain(); lfoGain.gain.value = 3;
    this.padLfo.connect(lfoGain);
    for (const p of this.pad) lfoGain.connect(p.o.detune);
    this.padLfo.start();
    this.setPad('G', false);
  }

  setVolume(v) {
    this.volume = v;
    if (this.master) this.master.gain.setTargetAtTime(v * 0.5, this.ctx.currentTime, 0.1);
  }

  /** Each star class gets its own root; black holes get a low, dark chord. */
  setPad(cls, blackHole) {
    if (!this.ctx) return;
    const key = blackHole ? 'X' : cls;
    if (key === this.padKey) return;
    this.padKey = key;
    const root = blackHole ? 82 : ROOTS[cls] ?? (cls === 'N' ? 330 : cls === 'D' ? 98 : 262);
    const minor = blackHole || cls === 'M' || cls === 'K' || cls === 'D';
    const notes = [0, minor ? 3 : 4, 7, -12];
    this.pad.forEach((p, i) => p.o.frequency.setTargetAtTime(semis(root, notes[i]), this.ctx.currentTime, 2));
  }

  /** state: { thrust, speed, rho, tidal, timeScale, heat, landed } every frame. */
  update(s) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime, to = (param, v, k = 0.08) => param.setTargetAtTime(v, t, k);
    const thr = Math.min(1, s.thrust);
    to(this.engine.gain.gain, thr * (s.landed ? 0.07 : 0.2));
    to(this.engine.filter.frequency, 160 + thr * 800);
    to(this.sub.gain.gain, thr * (s.landed ? 0.04 : 0.15));
    to(this.sub.o.frequency, 45 + thr * 30);
    const wind = Math.min(1, (s.rho * s.speed) / 1400);
    to(this.air.gain.gain, wind * 0.22 + s.heat * 0.2);
    to(this.air.filter.frequency, 700 + s.speed * 0.6 + s.heat * 2500);
    this.drone.forEach((d, i) => { to(d.gain.gain, s.tidal * 0.22); to(d.o.frequency, (i ? 41.5 : 38) * (0.5 + 0.5 * s.timeScale), 0.3); });
    this.pad.forEach((p, i) => to(p.gain.gain, (i === 3 ? 0.05 : 0.025) * (1 - 0.7 * s.tidal), 0.6));
  }

  // ---- one-shot events ----
  tone(freq, dur = 0.25, { type = 'sine', gain = 0.18, delay = 0, to = null } = {}) {
    if (!this.ctx) return;
    const ctx = this.ctx, t0 = ctx.currentTime + delay;
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = type; o.frequency.setValueAtTime(freq, t0);
    if (to) o.frequency.exponentialRampToValueAtTime(to, t0 + dur);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(gain, t0 + 0.015);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g).connect(this.master);
    o.start(t0); o.stop(t0 + dur + 0.05);
  }

  burst(dur = 0.3, { freq = 600, to = 100, gain = 0.3, type = 'lowpass' } = {}) {
    if (!this.ctx) return;
    const ctx = this.ctx, t0 = ctx.currentTime;
    const src = ctx.createBufferSource(); src.buffer = this.noiseBuf;
    const f = ctx.createBiquadFilter(); f.type = type; f.frequency.setValueAtTime(freq, t0);
    f.frequency.exponentialRampToValueAtTime(to, t0 + dur);
    const g = ctx.createGain(); g.gain.setValueAtTime(gain, t0); g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    src.connect(f).connect(g).connect(this.master);
    src.start(t0); src.stop(t0 + dur + 0.05);
  }

  /** A little melody that belongs to a world: the same name always plays the same tune. */
  discover(name) {
    const h = hash(name), root = semis(220, h % 12);
    for (let i = 0; i < 5; i++) {
      const n = PENTATONIC[(h >>> (i * 3 + 4)) % PENTATONIC.length];
      this.tone(semis(root, n), 0.7, { delay: i * 0.13, gain: 0.13, type: i % 2 ? 'triangle' : 'sine' });
    }
  }
  touchdown() { this.burst(0.35, { freq: 500, to: 60, gain: 0.25 }); this.tone(70, 0.3, { to: 38, gain: 0.3 }); }
  thud() { this.burst(0.25, { freq: 400, to: 50, gain: 0.4 }); this.tone(60, 0.25, { to: 30, gain: 0.35 }); }
  dock() { this.tone(880, 0.12, { gain: 0.14 }); this.tone(1320, 0.2, { delay: 0.12, gain: 0.14 }); }
  explode() { this.burst(1.1, { freq: 2000, to: 40, gain: 0.5 }); this.tone(90, 0.8, { to: 25, type: 'sawtooth', gain: 0.25 }); }
  swallowed() { this.tone(300, 2.2, { to: 24, type: 'sawtooth', gain: 0.22 }); this.burst(2.2, { freq: 900, to: 30, gain: 0.2 }); }
  lockTick(progress) { this.tone(500 + progress * 900, 0.05, { type: 'square', gain: 0.05 }); }
  // music cues: the score follows the story
  swell() { [0, 7, 12, 16, 19, 24].forEach((n, i) => this.tone(semis(196, n), 0.9 - i * 0.08, { delay: i * 0.09, gain: 0.07, type: 'triangle' })); }
  arrive() { [[0, 4, 7], [5, 9, 12], [7, 11, 14], [0, 4, 7, 12]].forEach((ch, k) => ch.forEach((n) => this.tone(semis(131, n), 1.1, { delay: k * 0.55, gain: 0.05, type: 'sine' }))); }
  eerie() { [0, 1, 0, 1, 6].forEach((n, i) => this.tone(semis(440, n), 0.35, { delay: i * 0.32, gain: 0.05, type: 'sine' })); }
  whale() { [[0, -5], [7, 2], [-2, -9]].forEach(([a, b], i) => this.tone(semis(110, a), 2.2, { to: semis(110, b), delay: i * 1.1, gain: 0.08, type: 'sine' })); }
  alarm() { this.tone(880, 0.12, { type: 'square', gain: 0.06 }); this.tone(660, 0.12, { type: 'square', gain: 0.06, delay: 0.14 }); }
  /** 0..1: how much danger the ship is in (heat, a hull close to failing, a pulsar beam). The pad sags and wavers. */
  setTension(k) {
    if (!this.ctx || Math.abs((this.tension ?? 0) - k) < 0.05) return;
    this.tension = k;
    for (const p of this.pad) p.o.detune.setTargetAtTime(-60 * k, this.ctx.currentTime, 0.8);
  }
  fanfare() { [0, 4, 7, 12].forEach((n, i) => this.tone(semis(392, n), 0.5, { delay: i * 0.1, gain: 0.14, type: 'triangle' })); }
}
