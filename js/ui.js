import { UPGRADES, MAX_UPGRADE, MILESTONES } from './save.js';
import { SHIP_MODELS, MODEL_IDS } from './ships.js';

const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};

const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);

export function createUI({ state, universe, missions, seed, actions }) {
  const menu = document.getElementById('menu');
  const body = el('div', 'body');
  const tabsEl = el('div', 'tabs');
  const toasts = document.getElementById('toasts');
  let tab = 'missions';

  const TABS = [['missions', 'MISSIONS'], ['codex', 'CODEX'], ['ship', 'SHIP'], ['options', 'OPTIONS']];
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

  function renderShip() {
    body.append(el('h2', '', `CREDITS: ${state.credits}`));
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
    toggleRow('survival', 'Survival', 'Fuel burns when you thrust; the star corona burns it faster. Refuel by landing.');
    toggleRow('missions', 'Missions', 'Three jobs per system, paid in credits.');
    toggleRow('assist', 'Assisted autopilot', 'Takes time to lock on, turns at a limited rate, and hands control back when you grab the stick. Off = classic instant autopilot.');
    toggleRow('warp', 'Warped gravity grid', 'The background grid dips into stars, black holes and big planets. Off = flat grid.');
    toggleRow('fancy', 'Fancy trails', 'Fading speed-coloured trails and engine glow. Off = classic dashed trail.');

    const card = el('div', 'card');
    card.append(el('div', 'title', `Seed ${seed}`), el('div', 'dim', 'Share this system with a friend.'));
    const r = el('div', 'btnrow');
    r.append(button('SHARE LINK', actions.share), button('NEW RANDOM SYSTEM', actions.randomSeed),
      button('TODAY’S SYSTEM', actions.dailySeed));
    card.append(r);
    body.append(card);

    const danger = el('div', 'card');
    danger.append(el('div', 'title', 'Reset progress'), el('div', 'dim', 'Erases codex, credits and upgrades on this device.'));
    danger.append(button('ERASE SAVE', () => {
      if (confirm('Erase all saved progress on this device?')) actions.reset();
    }));
    body.append(danger);
  }

  function render() {
    body.replaceChildren();
    for (const b of tabsEl.querySelectorAll('.tab[data-tab]')) b.classList.toggle('on', b.dataset.tab === tab);
    ({ missions: renderMissions, codex: renderCodex, ship: renderShip, options: renderOptions })[tab]();
  }

  return { toggle, toast, render, get open() { return !menu.hidden; } };
}
