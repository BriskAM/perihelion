import { UPGRADES, MAX_UPGRADE, MILESTONES } from './save.js';
import { SHIP_MODELS, MODEL_IDS } from './ships.js';
import { loadPostcards } from './postcards.js';
import { ACHIEVEMENTS } from './achievements.js';
import { STAR_COLORS } from './universe.js';
import { PERSONALITIES } from './personalities.js';
import { dailyGoal, dailyState, DAILY_GOALS, OUTPOST_COST, OUTPOST_PAY, WING_COST } from './outposts.js';
import { STAGES } from './story.js';
import { THEMES } from './themes.js';
void DAILY_GOALS;

const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};

const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);

export function createUI({ state, game, actions }) {
  const menu = document.getElementById('menu');
  const body = el('div', 'body');
  const tabsEl = el('div', 'tabs');
  const toasts = document.getElementById('toasts');
  let tab = 'missions';

  const TABS = [['missions', 'MISSIONS'], ['log', 'LOG'], ['postcards', 'POSTCARDS'], ['galaxy', 'GALAXY'], ['codex', 'CODEX'], ['ship', 'SHIP'], ['options', 'OPTIONS']];
  for (const [id, label] of TABS) {
    const b = el('button', 'tab', label);
    b.dataset.tab = id;
    b.addEventListener('click', () => { tab = id; render(); });
    tabsEl.append(b);
  }
  const close = el('button', 'tab close', '×');
  close.addEventListener('click', () => toggle(false));
  tabsEl.append(close);
  menu.append(tabsEl, body);
  menu.addEventListener('pointerdown', (e) => e.stopPropagation());

  function toggle(open = menu.hidden) {
    menu.hidden = !open;
    if (open) render();
  }

  function toast(msg, kind = '') {
    const t = el('div', 'toast ' + kind, msg);
    toasts.append(t);
    setTimeout(() => t.remove(), 4200);
  }

  function row(label, value, cls) {
    const r = el('div', 'kv ' + (cls || ''));
    r.append(el('span', 'k', label), el('span', 'v', value));
    return r;
  }

  function button(label, onClick, disabled = false) {
    const b = el('button', 'act', label);
    b.disabled = disabled;
    b.addEventListener('click', onClick);
    return b;
  }

  function renderMissions() {
    const { universe, missions } = game;
    // the daily challenge
    const goal = dailyGoal(), d = dailyState(state);
    const daily = el('div', 'card');
    daily.append(el('div', 'title', `DAILY CHALLENGE ${d.date}`), el('div', 'dim', `${goal.text}, in today's system.`));
    daily.append(row(d.cur.done ? 'DONE' : 'PROGRESS', `${d.cur.charted} worlds · ${Math.round(d.cur.t)} s · ${Math.round(d.cur.fuel)} fuel · ${d.cur.slings} slingshots`));
    if (d.best !== null) daily.append(row('BEST', `${d.best} ${goal.unit}${d.style ? ` (${PERSONALITIES[d.style]?.name})` : ''}`));
    const dr = el('div', 'btnrow');
    dr.append(button("GO TO TODAY'S SYSTEM", actions.daily), button('COPY RESULT', actions.shareDaily, d.best === null && !d.cur.done));
    daily.append(dr);
    body.append(daily);
    // the Signal
    const st = state.story;
    if (st.stage > 0) {
      const sig = el('div', 'card' + (st.done ? ' done' : ''));
      sig.append(el('div', 'title', st.done ? 'THE SIGNAL: SOLVED' : `THE SIGNAL: ${Math.min(st.stage, STAGES)}/${STAGES}`));
      sig.append(el('div', 'dim', st.done ? 'You found the derelict at the end of it.'
        : st.target === game.here.seed ? 'The source is in this system: look for the pulsing cyan marker.' : `The last beacon pointed to ${st.targetName}. Cruise will head there on its next jump.`));
      if (!st.done && st.target !== game.here.seed) { const r = el('div', 'btnrow'); r.append(button('FOLLOW THE SIGNAL', actions.signal)); sig.append(r); }
      body.append(sig);
    }
    body.append(el('h2', '', `SYSTEM ${universe.star.name.toUpperCase()}`));
    if (!state.options.missions) {
      body.append(el('p', 'dim', 'Missions are switched off (OPTIONS).'));
      return;
    }
    for (const m of missions) {
      const done = state.done.includes(m.id);
      const [cur, max] = m.progress();
      const card = el('div', 'card' + (done ? ' done' : ''));
      card.append(el('div', 'title', (done ? '[DONE] ' : '') + m.title));
      const bar = el('div', 'bar');
      const fill = el('div', 'fill');
      fill.style.width = `${Math.round((done ? 1 : cur / max) * 100)}%`;
      bar.append(fill);
      card.append(bar, row(done ? 'COMPLETED' : `${cur.toLocaleString('en-US')} / ${max.toLocaleString('en-US')}`, `+${m.reward} CR`));
      body.append(card);
    }
    body.append(el('p', 'dim', 'Same seed, same missions: share the link and a friend gets the same jobs.'));
  }

  function renderCodex() {
    const n = state.codex.length;
    const next = MILESTONES.find(([c]) => c > n);
    body.append(el('h2', '', `CODEX: ${n} DISCOVERED`));
    const earned = MILESTONES.filter(([c]) => c <= n).map(([, t]) => t);
    body.append(el('p', 'dim', (earned.length ? `Rank: ${earned[earned.length - 1]}. ` : '') +
      (next ? `Next rank "${next[1]}" at ${next[0]}.` : 'Top rank reached.')));
    if (!n) body.append(el('p', 'dim', 'Land on a planet to log it here.'));
    for (const c of state.codex.slice().reverse()) {
      const card = el('div', 'card');
      card.append(el('div', 'title', c.name));
      card.append(row('TYPE', cap(c.description)), row('ATMO', cap(c.atmosphere)),
        row('FAUNA', cap(c.fauna)), row('FLORA', cap(c.flora)));
      const link = el('a', 'link', `seed ${c.seed}`);
      link.href = `?seed=${c.seed}`;
      card.append(link);
      body.append(card);
    }
  }

  function renderLog() {
    body.append(el('h2', '', "CAPTAIN'S LOG"));
    if (!state.captainLog.length) body.append(el('p', 'dim', 'Nothing yet. Go somewhere.'));
    for (const e of state.captainLog.slice().reverse()) {
      const c = el('div', 'card');
      c.append(el('div', 'dim', `${new Date(e.t).toLocaleString()}${e.sys ? ` · ${e.sys}` : ''}`), el('div', '', e.text));
      body.append(c);
    }
  }

  function renderShip() {
    body.append(el('h2', '', `CREDITS: ${state.credits}`));
    const out = el('div', 'card');
    out.append(el('div', 'title', `Relays: ${state.outposts.length} deployed`), el('div', 'dim', `Drop a relay into orbit round the nearest world (O). Every relay you own, in any system, pays ${OUTPOST_PAY} CR a minute, and you can dock at it.`));
    out.append(button(`DEPLOY RELAY (${OUTPOST_COST} CR)`, actions.deploy, state.credits < OUTPOST_COST));
    body.append(out);
    const wing = el('div', 'card');
    wing.append(el('div', 'title', state.wing.owned ? `Wingman: ${state.wing.name}` : 'Wingman'), el('div', 'dim', 'A second ship that flies with you and charts worlds for you, in its own style. The cinematic camera checks in on it.'));
    if (!state.wing.owned) wing.append(button(`HIRE (${WING_COST} CR)`, actions.buyWing, state.credits < WING_COST));
    else {
      const wr = el('div', 'btnrow');
      for (const [id, P] of Object.entries(PERSONALITIES)) { const b = button(P.name.toUpperCase(), () => actions.wingStyle(id)); b.classList.toggle('picked', state.wing.persona === id); wr.append(b); }
      wing.append(wr);
    }
    body.append(wing);
    if (!state.options.survival) {
      body.append(el('p', 'dim', 'Survival (fuel and heat) is off, so upgrades have no effect.'));
    }
    const hull = el('div', 'card');
    hull.append(el('div', 'title', 'Hull'));
    const models = el('div', 'btnrow');
    for (const id of MODEL_IDS) {
      const b = button(SHIP_MODELS[id].name + (state.shipModel === id ? ' *' : ''), () => actions.setModel(id));
      b.classList.toggle('picked', state.shipModel === id);
      models.append(b);
    }
    hull.append(models);
    if (SHIP_MODELS[state.shipModel].credit) hull.append(el('div', 'dim', SHIP_MODELS[state.shipModel].credit));
    body.append(hull);
    for (const [id, u] of Object.entries(UPGRADES)) {
      const lvl = state.upgrades[id];
      const maxed = lvl >= MAX_UPGRADE;
      const cost = u.cost(lvl);
      const card = el('div', 'card');
      card.append(el('div', 'title', `${u.name}  LV ${lvl}/${MAX_UPGRADE}`), el('div', 'dim', u.desc));
      card.append(button(maxed ? 'MAXED' : `UPGRADE (${cost} CR)`, () => actions.buy(id),
        maxed || state.credits < cost));
      body.append(card);
    }
  }

  function renderOptions() {
    const toggleRow = (key, label, hint) => {
      const card = el('div', 'card');
      card.append(el('div', 'title', label), el('div', 'dim', hint));
      card.append(button(state.options[key] ? 'ON (tap to turn off)' : 'OFF (tap to turn on)',
        () => actions.option(key, !state.options[key])));
      body.append(card);
    };
    const cruise = el('div', 'card');
    cruise.append(el('div', 'title', 'Cruise (AFK)'), el('div', 'dim', 'Press CRUISE (or C) and leave it: the autopilot explores on its own, warps through long coasts, refuels, buys upgrades and, once a system is charted, jumps to a new one. It keeps going in a background tab, and the PIP window shows it with a cinematic camera.'));
    const crow = el('div', 'btnrow');
    crow.append(button(state.cruise ? 'CRUISE: ON' : 'CRUISE: OFF', () => actions.cruise(!state.cruise)));
    cruise.append(crow);
    body.append(cruise);
    const style = el('div', 'card');
    style.append(el('div', 'title', 'Autopilot style (K)'), el('div', 'dim', PERSONALITIES[state.options.persona]?.desc ?? ''));
    const srow = el('div', 'btnrow');
    for (const [id, P] of Object.entries(PERSONALITIES)) {
      const b = button(P.name.toUpperCase(), () => actions.persona(id));
      b.classList.toggle('picked', state.options.persona === id);
      srow.append(b);
    }
    style.append(srow, el('div', 'dim', 'The HUD keeps score for the current style: worlds charted per hour, fuel per world, slingshots taken.'));
    body.append(style);
    const th = el('div', 'card');
    th.append(el('div', 'title', 'Colours'), el('div', 'dim', 'AUTO lets every system pick its own palette from its star (red dwarfs run warm, hot stars icy, black holes grey). Or lock one.'));
    const trow = el('div', 'btnrow');
    for (const [id, label] of [['auto', 'AUTO'], ...Object.entries(THEMES).map(([k, t]) => [k, t.name.toUpperCase()])]) {
      const b = button(label, () => actions.option('theme', id));
      b.classList.toggle('picked', (state.options.theme ?? 'auto') === id);
      if (THEMES[id]) { b.style.borderColor = THEMES[id].console; b.style.color = THEMES[id].console; b.style.background = (state.options.theme === id ? THEMES[id].autopilot : THEMES[id].void); }
      trow.append(b);
    }
    th.append(trow);
    body.append(th);
    toggleRow('hop', 'Cruise: jump to new systems', 'When everything here is charted (or nothing new has turned up for a while), cruise jumps to a fresh random system.');
    toggleRow('autobuy', 'Cruise: buy upgrades', 'Spend credits on the cheapest ship upgrade whenever cruise can afford one.');
    toggleRow('cruiseWarp', 'Cruise: time warp', 'Speed up long coasts between worlds (2x to 8x), dropping back to normal near anything.');
    toggleRow('cinematic', 'Cinematic camera', 'In cruise, the camera cuts between chase, fly-by, planet and system shots. Grab the stick to fly and it steps aside.');
    toggleRow('replays', 'Instant replays', 'In cruise, slingshots, eruptions and impacts are replayed in slow motion a moment later (tap to skip; R replays the last few seconds any time).');
    toggleRow('smartcam', 'Smart camera', 'Zooms out with speed, frames the nearest world and the autopilot target, leans ahead of the ship. Scroll or pinch to set how close you like it (0 resets). Off = fixed zoom.');
    toggleRow('predict', 'Trajectory prediction', 'Your future path: the orbit around the world you are near (with periapsis and apoapsis), or the path through the system and any encounter ahead.');
    toggleRow('survival', 'Survival', 'Fuel burns when you thrust; the star corona burns it faster. Refuel by landing.');
    toggleRow('missions', 'Missions', 'Three jobs per system, paid in credits.');
    toggleRow('assist', 'Assisted autopilot', 'Takes time to lock on, turns at a limited rate, and hands control back when you grab the stick. Off = classic instant autopilot.');
    toggleRow('pip', 'Ship cam', 'A small fixed close-up of your ship (with velocity and thrust arrows) when the main view is zoomed out.');
    toggleRow('strict', 'Strict landing', 'You must slow down to land: too fast and you bounce and take damage, far too fast and the ship is destroyed. The limit is higher on heavy planets. Off = land at any speed.');
    toggleRow('warp', 'Warped gravity grid', 'The background grid dips into stars, black holes and big planets. Off = flat grid.');
    toggleRow('orbit', 'Orbit-first landings', 'The autopilot captures into a low orbit, then spirals down (using the air where there is some) instead of braking in a straight line. Only for planets with room for a stable orbit.');
    const pace = el('div', 'card');
    pace.append(el('div', 'title', 'Autopilot pace'), el('div', 'dim', 'How briskly it turns, locks on, flies in and drops through orbit. Faster is a bit riskier.'));
    const paceRow = el('div', 'btnrow');
    for (const [label, v] of [['CALM', 0.6], ['NORMAL', 1], ['FAST', 1.6], ['TURBO', 2.2]]) {
      const b = button(label, () => actions.option('pace', v));
      b.classList.toggle('picked', state.options.pace === v);
      paceRow.append(b);
    }
    pace.append(paceRow);
    body.append(pace);
    const vol = el('div', 'card');
    vol.append(el('div', 'title', 'Sound'), el('div', 'dim', 'Procedural: engine, air, a drone for each kind of star, and a little tune for every world you discover.'));
    const volRow = el('div', 'btnrow');
    for (const [label, v] of [['OFF', 0], ['LOW', 0.25], ['MEDIUM', 0.6], ['LOUD', 1]]) {
      const b = button(label, () => actions.option('volume', v));
      b.classList.toggle('picked', state.options.volume === v);
      volRow.append(b);
    }
    vol.append(volRow);
    body.append(vol);
    toggleRow('fancy', 'Fancy trails', 'Fading speed-coloured trails and engine glow. Off = classic dashed trail.');

    const card = el('div', 'card');
    const seed = game.seed;
    card.append(el('div', 'title', typeof seed === 'string' ? seed : `Seed ${seed}`), el('div', 'dim', 'Share this system with a friend.'));
    const r = el('div', 'btnrow');
    r.append(button('SHARE LINK', actions.share), button('NEW RANDOM SYSTEM', actions.randomSeed),
      button('TODAY’S SYSTEM', actions.dailySeed), button('OUR SOLAR SYSTEM', actions.sol));
    card.append(r);
    body.append(card);

    const danger = el('div', 'card');
    danger.append(el('div', 'title', 'Reset progress'), el('div', 'dim', 'Erases codex, credits and upgrades on this device.'));
    danger.append(button('ERASE SAVE', () => {
      if (confirm('Erase all saved progress on this device?')) actions.reset();
    }));
    body.append(danger);
  }

  // every system visited, laid out on a little star map (positions come from the seed), joined in the
  // order you flew them. Tap one to jump back.
  function renderGalaxy() {
    const g = state.galaxy;
    body.append(el('h2', '', `GALAXY: ${g.length} SYSTEM${g.length === 1 ? '' : 'S'} VISITED`));
    const c = el('canvas', 'galaxy');
    const W = 520, H = 340, d = Math.min(window.devicePixelRatio || 1, 2);
    c.width = W * d; c.height = H * d;
    const ctx = c.getContext('2d');
    ctx.scale(d, d);
    ctx.fillStyle = '#101016'; ctx.fillRect(0, 0, W, H);
    const place = (e) => {
      let h = (e.system === 'sol' ? 7 : e.seed) >>> 0;
      h = Math.imul(h ^ (h >>> 16), 2246822519) >>> 0; h = Math.imul(h ^ (h >>> 13), 3266489917) >>> 0;
      const a = (h & 0xffff) / 65536 * Math.PI * 2, r = Math.sqrt((h >>> 16) / 65536);
      return { x: W / 2 + Math.cos(a) * r * (W / 2 - 40), y: H / 2 + Math.sin(a) * r * (H / 2 - 30) * 0.95 };
    };
    const pts = g.map(place);
    ctx.strokeStyle = 'rgba(76,141,246,0.45)'; ctx.lineWidth = 1;
    ctx.beginPath(); pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y))); ctx.stroke();
    const here = game.here;
    g.forEach((e, i) => {
      const p = pts[i], cls = String(e.cls).split('+')[0];
      const done = e.total ? e.charted / e.total : 0;
      ctx.fillStyle = cls === 'BH' ? '#000' : STAR_COLORS[cls] ?? '#fff';
      ctx.strokeStyle = cls === 'BH' ? '#fff4d8' : 'transparent';
      ctx.beginPath(); ctx.arc(p.x, p.y, 3 + 3 * done, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      if (e.seed === here.seed && (e.system ?? null) === here.system) {
        ctx.strokeStyle = '#4ade80'; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.arc(p.x, p.y, 10, 0, Math.PI * 2); ctx.stroke(); ctx.lineWidth = 1;
      }
      if (g.length < 30 || i >= g.length - 8) {
        ctx.fillStyle = 'rgba(183,183,255,0.8)'; ctx.font = '9px ui-monospace, Menlo, monospace';
        ctx.fillText(`${e.name.split(' ')[0]} ${e.charted}/${e.total}`, p.x + 8, p.y + 3);
      }
    });
    c.addEventListener('click', (ev) => {
      const r = c.getBoundingClientRect(), x = ((ev.clientX - r.left) / r.width) * W, y = ((ev.clientY - r.top) / r.height) * H;
      let best = -1, bd = 14;
      pts.forEach((p, i) => { const dd = Math.hypot(p.x - x, p.y - y); if (dd < bd) { bd = dd; best = i; } });
      if (best >= 0) actions.travel(g[best].seed, g[best].system);
    });
    body.append(c, el('p', 'dim', 'Bigger dots are more fully charted. Tap a system to jump back to it.'));
    const got = new Set(state.achievements);
    body.append(el('h2', '', `ACHIEVEMENTS ${got.size}/${ACHIEVEMENTS.length}`));
    for (const [id, name, desc] of ACHIEVEMENTS) {
      const card = el('div', 'card' + (got.has(id) ? '' : ' done'));
      card.append(el('div', 'title', (got.has(id) ? '★ ' : '☆ ') + name), el('div', 'dim', desc));
      body.append(card);
    }
  }

  function renderPostcards() {
    const cards = loadPostcards().slice().reverse();
    body.append(el('h2', '', `POSTCARDS: ${cards.length}`));
    if (!cards.length) body.append(el('p', 'dim', 'Slingshots, first landings, eruptions, rescues and arrivals get snapped automatically. Leave cruise running and come back to a stack of them.'));
    const grid = el('div', 'cards');
    for (const c of cards) {
      const fig = el('figure', 'postcard');
      const img = el('img'); img.src = c.img; img.alt = c.caption;
      const mins = Math.round((Date.now() - c.t) / 60_000);
      fig.append(img, el('figcaption', '', `${c.caption} · ${mins < 1 ? 'just now' : mins < 60 ? `${mins} min ago` : `${Math.round(mins / 60)} h ago`}`));
      fig.addEventListener('click', () => fig.classList.toggle('big'));
      grid.append(fig);
    }
    body.append(grid);
  }

  function render() {
    body.replaceChildren();
    for (const b of tabsEl.querySelectorAll('.tab[data-tab]')) b.classList.toggle('on', b.dataset.tab === tab);
    ({ missions: renderMissions, log: renderLog, postcards: renderPostcards, galaxy: renderGalaxy, codex: renderCodex, ship: renderShip, options: renderOptions })[tab]();
  }

  return { toggle, toast, render, get open() { return !menu.hidden; } };
}
