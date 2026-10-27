import { renderUniverse } from './render.js';
import { persona } from './personalities.js';
import { applyTheme } from './themes.js';
import { COLORS } from './render.js';

// The floating (picture-in-picture) window, split out of main.js. `g` is the game context: getters for
// the current universe and autopilot, plus the few game functions this needs (see main.js).
export function createPip(g) {
  // ---- floating window (picture-in-picture) --------------------------------------------------
  // A small always-on-top window with a full-quality, cinematic view: its own camera cuts between
  // shots, a strip on top shows the g.system and how much of it is charted, the bottom shows what the
  // g.ap is doing, and recent events scroll by. It has its own buttons (next shot, warp, close).
  // Browsers stop animation frames in hidden tabs, so a worker ticks the game while the page is hidden.
  const pipWin = { active: false, win: null, canvas: null, ctx: null, video: null, kind: null, dpr: 1, el: {} };
  let ticker = null;

  function startTicker() {
    if (ticker) return;
    const blob = new Blob(['setInterval(() => postMessage(0), 33)'], { type: 'text/javascript' });
    ticker = new Worker(URL.createObjectURL(blob));
    ticker.onmessage = () => { if (document.hidden) g.tick(performance.now()); };
  }
  function stopTicker() { ticker?.terminate(); ticker = null; }
  const needTicker = () => pipWin.active || g.state.cruise;

  function sizePipCanvas() {
    if (pipWin.kind !== 'document') return;
    const win = pipWin.win;
    pipWin.dpr = Math.min(win.devicePixelRatio || 1, 2);
    pipWin.canvas.width = Math.round(win.innerWidth * pipWin.dpr);
    pipWin.canvas.height = Math.round(win.innerHeight * pipWin.dpr);
  }

  const PIP_CSS = `
    * { box-sizing: border-box; }
    html, body { margin: 0; height: 100%; background: var(--void); overflow: hidden; color: var(--console);
      font: 500 11px/13px ui-monospace, "SF Mono", Menlo, Consolas, monospace; letter-spacing: 1px; user-select: none; }
    canvas { position: fixed; inset: 0; width: 100vw; height: 100vh; display: block; }
    .top { position: fixed; top: 0; left: 0; right: 0; padding: 7px 9px 14px;
      background: linear-gradient(color-mix(in srgb, var(--void) 93%, transparent), color-mix(in srgb, var(--void) 0%, transparent)); pointer-events: none; }
    .name { color: #e6e6ff; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .bar { height: 3px; background: var(--line); margin-top: 5px; }
    .bar > i { display: block; height: 100%; background: var(--autopilot); transition: width .6s; }
    .meta { display: flex; justify-content: space-between; margin-top: 4px; opacity: .75; }
    .log { position: fixed; left: 9px; bottom: 58px; right: 9px; pointer-events: none; }
    .log div { animation: in .4s ease-out; text-shadow: 0 0 6px var(--void); }
    @keyframes in { from { opacity: 0; transform: translateY(4px); } }
    .bottom { position: fixed; left: 0; right: 0; bottom: 0; padding: 14px 9px 7px;
      background: linear-gradient(color-mix(in srgb, var(--void) 0%, transparent), color-mix(in srgb, var(--void) 93%, transparent)); display: flex; align-items: flex-end; gap: 6px; }
    .status { flex: 1; min-width: 0; }
    .status .s { color: var(--autopilot); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .fuel { height: 3px; background: var(--line); margin-top: 4px; width: 100%; }
    .fuel > i { display: block; height: 100%; background: #4ade80; }
    button { font: inherit; color: var(--console); background: color-mix(in srgb, var(--void) 80%, transparent); border: 1px solid var(--console); padding: 5px 7px; cursor: pointer; }
    button:hover { background: var(--autopilot); color: #fff; }
    .shot { position: fixed; top: 46px; right: 9px; opacity: .5; font-size: 9px; pointer-events: none; }
  `;

  async function openDocumentPip(testWin = null) {
    const win = testWin ?? await window.documentPictureInPicture.requestWindow({ width: 380, height: 380 });
    const doc = win.document;
    const style = doc.createElement('style'); style.textContent = PIP_CSS; doc.head.append(style);
    doc.body.innerHTML = `<canvas></canvas>
      <div class="top"><div class="name"></div><div class="bar"><i></i></div><div class="meta"><span class="charted"></span><span class="cr"></span></div></div>
      <div class="shot"></div>
      <div class="log"></div>
      <div class="bottom"><div class="status"><div class="s"></div><div class="fuel"><i></i></div></div>
        <button data-a="shot" title="Next camera shot">VIEW</button><button data-a="warp" title="Time warp">x1</button><button data-a="close" title="Close">×</button></div>`;
    const q = (s) => doc.querySelector(s);
    const canvas = q('canvas');
    pipWin.el = { name: q('.name'), bar: q('.bar > i'), charted: q('.charted'), cr: q('.cr'), log: q('.log'), s: q('.status .s'), fuel: q('.fuel > i'), warp: q('[data-a=warp]'), shot: q('.shot') };
    doc.body.addEventListener('click', (e) => {
      const a = e.target.closest?.('button')?.dataset.a;
      if (a === 'shot') g.pipCam.shot = null;
      if (a === 'warp') g.cycleWarp(1);
      if (a === 'close') closePip();
    });
    Object.assign(pipWin, { active: true, win, canvas, ctx: canvas.getContext('2d'), kind: 'document' });
    sizePipCanvas();
    win.addEventListener('resize', sizePipCanvas);
    win.addEventListener('pagehide', closePip);
    // The floating window stays visible when the game's tab is hidden or another app is in front, so it
    // drives the game with its own animation frames then (smoother than the 30 Hz worker, and it keeps
    // going where a browser throttles background workers).
    const loop = () => {
      if (!pipWin.active || pipWin.win !== win) return;
      if (document.hidden) g.tick(performance.now());
      win.requestAnimationFrame(loop);
    };
    win.requestAnimationFrame(loop);
  }

  async function openVideoPip() {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 480;
    const c2 = canvas.getContext('2d'); // a stream gives no video until the canvas has been painted once
    c2.fillStyle = COLORS.void; c2.fillRect(0, 0, 480, 480);
    const video = document.createElement('video');
    video.muted = true; video.playsInline = true; video.srcObject = canvas.captureStream(30);
    const within = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);
    await within(video.play(), 3000);
    await within(video.requestPictureInPicture(), 3000);
    video.addEventListener('leavepictureinpicture', closePip);
    video.addEventListener('pause', () => { if (pipWin.video === video) video.play().catch(() => {}); }); // some browsers pause hidden media
    Object.assign(pipWin, { active: true, canvas, ctx: canvas.getContext('2d'), video, kind: 'video', dpr: 1 });
  }

  async function openPip() {
    if (pipWin.active) return closePip();
    g.unlockSound();
    if (!g.state.cruise) g.setCruise(true); // the window is for watching: cruise flies
    const attempts = [];
    if ('documentPictureInPicture' in window) attempts.push(openDocumentPip);
    if (document.pictureInPictureEnabled) attempts.push(openVideoPip);
    let lastErr = null;
    for (const attempt of attempts) {
      try { await attempt(); lastErr = null; break; } catch (err) { lastErr = err; console.warn('floating window failed', err); }
    }
    if (!pipWin.active) {
      g.ui.toast(attempts.length ? `Could not open the floating window (${lastErr?.name ?? 'error'})` : 'Floating windows are not supported in this browser');
      return;
    }
    g.pipCam.snap(g.u, 380, 380);
    startTicker();
    g.ui.toast('Floating window open: cruise keeps flying');
  }

  function closePip() {
    if (!pipWin.active) return;
    const { win, video } = pipWin;
    pipWin.active = false;
    if (!needTicker()) stopTicker();
    try { win?.close(); } catch { /* already gone */ }
    if (video) { try { document.exitPictureInPicture(); } catch { /* ignore */ } video.srcObject = null; }
    Object.assign(pipWin, { win: null, canvas: null, ctx: null, video: null, kind: null, el: {} });
  }
  document.getElementById('pipbtn').addEventListener('click', openPip);
  // Chrome can open the floating window by itself when you switch away from a page that asks for it
  // (automatic picture-in-picture); then switching tabs brings it straight back.
  try { navigator.mediaSession?.setActionHandler('enterpictureinpicture', () => { if (!pipWin.active) openPip(); }); } catch { /* not supported */ }

  // a camera flash in the floating window when a postcard is taken
  function flashPip() {
    g.sound.lockTick(1);
    const doc = pipWin.win?.document;
    if (!doc) return;
    const f = doc.createElement('div');
    f.style.cssText = 'position:fixed;inset:0;background:#fff;opacity:.55;transition:opacity .6s;pointer-events:none';
    doc.body.append(f);
    setTimeout(() => { f.style.opacity = '0'; }, 40);
    setTimeout(() => f.remove(), 700);
  }
  document.getElementById('pipbtn').addEventListener('pointerdown', (e) => e.stopPropagation());

  let pipHudClock = 0;
  function drawFloating(frameDt) {
    const u = g.u, { ctx: c, canvas } = pipWin;
    const d = pipWin.dpr, cw = canvas.width / d, ch = canvas.height / d;
    g.pipCam.update(u, frameDt, cw, ch, g.ap, false);
    renderUniverse(c, u, g.pipCam, cw, ch, d, false, { markers: false });
    const tgt = g.ap.target;
    const charted = u.planets.filter((p) => p.explored).length;
    if (pipWin.kind === 'document') {
      if ((pipHudClock += frameDt) < 0.2) return;
      pipHudClock = 0;
      if (pipWin.theme !== g.theme) { pipWin.theme = g.theme; applyTheme(g.theme, {}, pipWin.win.document); } // (match the system's colours)
      const el = pipWin.el, now = performance.now();
      const set = (e, v) => { if (e && e.textContent !== v) e.textContent = v; };
      set(el.name, `${u.star.name}${g.system === 'sol' ? '' : `  ·  ${u.stars.map((s) => (s.isBlackHole ? 'BH' : s.cls)).join('+')}`}`);
      el.bar.style.width = `${Math.round((charted / u.planets.length) * 100)}%`;
      set(el.charted, `${charted}/${u.planets.length} charted${g.state.stats.systems ? `  ·  system ${g.state.stats.systems + 1}` : ''}`);
      set(el.cr, `${g.state.credits} CR`);
      set(el.s, g.jump ? 'JUMPING TO A NEW SYSTEM' : `${persona(g.state.options.persona).name.toUpperCase()} · ${g.ap.strategy}${tgt ? ' > ' + tgt.name.toUpperCase() : ''}`);
      el.fuel.style.width = `${Math.round((u.fuel.level / u.fuel.capacity) * 100)}%`;
      set(el.warp, `x${u.warp}`);
      set(el.shot, g.pipCam.shotName.toUpperCase());
      const recent = g.log.filter((e) => now - e.t < 15_000).slice(-4);
      const html = recent.map((e) => `<div style="opacity:${Math.max(0.25, 1 - (now - e.t) / 15_000).toFixed(2)}${e.voice ? ';font-style:italic;color:#e6e6ff' : ''}">${e.text.replace(/[<&]/g, '')}</div>`).join('');
      if (el.log.innerHTML !== html) el.log.innerHTML = html;
      return;
    }
    // video fallback: no DOM to draw on, so paint the overlay into the frame
    c.setTransform(d, 0, 0, d, 0, 0);
    c.fillStyle = COLORS.void + 'c0';
    c.fillRect(0, ch - 40, cw, 40);
    c.fillStyle = '#b7b7ff';
    c.font = '11px ui-monospace, Menlo, monospace';
    c.textAlign = 'left';
    c.fillText(`${u.star.name}  ${charted}/${u.planets.length} charted  ${g.state.credits} CR`, 8, ch - 25);
    c.fillStyle = '#4c8df6';
    c.fillText(`${g.ap.strategy}${tgt ? ' > ' + tgt.name : ''}${u.warp > 1 ? `  x${u.warp}` : ''}`, 8, ch - 9);
  }

  return { pipWin, openPip, openDocumentPip, closePip, drawFloating, flashPip, startTicker, stopTicker, needTicker };
}
