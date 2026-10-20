import { mountHistoryPage } from './usage-page.js';
import { mountGraphs } from './usage-graphs.js';
import { createUsageDrain, tabSubscription, DRAIN_READ_MS } from './usage-drain.js';
// Desktop UsagePage and LimitWindows / WindowBar adapted from T3 Code 43f8a8de17a7ac1baa7a3cf36d681856de2d8add.
// Copyright (c) 2026 T3 Tools Inc. MIT: apps/code/licenses/T3-Code-MIT.txt.
// Lucide CircleGauge 1.50.0, the icon used by Paseo's SidebarUsageIcon.
// ISC: apps/code/licenses/Lucide-ISC.txt. Original geometry, no Paseo code copied.
const GAUGE = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M15.6 2.7a10 10 0 1 0 5.7 5.7"/><circle cx="12" cy="12" r="2"/><path d="M13.4 10.6 19 5"/></svg>';

export const SUBSCRIPTIONS = {
  claude: { name: 'Claude', missing: 'Claude Code is not signed in to a Claude subscription here' },
  pi: { name: 'ChatGPT', missing: 'Not signed in to ChatGPT here · sign in from Settings (Pi) or with codex login' },
};

export function resetText(at, now = Date.now()) {
  if (!Number.isFinite(at)) return '';
  if (at <= now) return 'resets now';
  const minutes = Math.floor((at - now) / 60000);
  const days = Math.floor(minutes / 1440), hours = Math.floor(minutes % 1440 / 60), mins = minutes % 60;
  return `resets in ${days ? `${days}d ${hours}h` : hours ? `${hours}h ${mins}m` : `${mins}m`}`;
}
// Unknown is not an empty allowance. Only provider-reported finite values make a bar.
export const remainingPercent = used => typeof used === 'number' && Number.isFinite(used) ? Math.round(100 - Math.max(0, Math.min(100, used))) : null;
export function windowTimeLeft(w, now) {
  if (!Number.isFinite(w.resetsAt) || !Number.isFinite(w.windowDurationMins) || w.windowDurationMins <= 0) return null;
  return Math.round(Math.max(0, Math.min(1, (w.resetsAt - now) / (w.windowDurationMins * 60000))) * 100);
}
export function usageSections(answer, now = Date.now()) {
  return (Array.isArray(answer) ? answer : []).filter(row => SUBSCRIPTIONS[row?.agent]).map(row => {
    const { name, missing } = SUBSCRIPTIONS[row.agent];
    const title = row.plan ? `${name} · ${row.plan}` : name;
    if (row.error) return { title, line: 'Limits unavailable · try Refresh' };
    if (!row.signedIn) return { title, line: missing };
    const windows = (Array.isArray(row.windows) ? row.windows : []).map(w => ({
      name: w.name || 'Limit', remaining: remainingPercent(w.used), reset: resetText(w.resetsAt, now),
      resetsAt: Number.isFinite(w.resetsAt) ? w.resetsAt : null, timeLeft: windowTimeLeft(w, now),
      windowDurationMins: Number.isFinite(w.windowDurationMins) && w.windowDurationMins > 0 ? w.windowDurationMins : null,
    }));
    return { ...(windows.length ? { title, windows } : { title, line: 'No limits reported.' }), ...(row.limitsUnavailable ? { line: 'Updated limits unavailable · showing last reported windows · try Refresh' } : {}), ...(row.agent === 'pi' && row.accountId ? { accountId: row.accountId, resetCredits: row.resetCredits, resetAttempt: row.resetAttempt } : {}) };
  });
}

// The sidebar's foot is a line for each subscription's main limits; the
// usage page's Limits opens with a ring for each week, notched where even
// spending would be, and what today used.
const DAY = 86_400_000;
export function shortLeft(ms) {
  if (!Number.isFinite(ms)) return '';
  const minutes = Math.max(0, Math.floor(ms / 60000));
  const days = Math.floor(minutes / 1440), hours = Math.floor(minutes % 1440 / 60);
  return days ? (days < 2 && hours ? `${days}d ${hours}h` : `${days}d`) : hours ? `${hours}h` : `${minutes % 60}m`;
}
// Where even spending would be (the share of the window still to come), and
// what the rate so far comes to: running ahead of it, when it runs out; not,
// how much a day lasts until the reset. Nothing is said of a rate in the
// window's first twentieth.
export function paceOf(w, now = Date.now()) {
  if (w?.remaining == null || !Number.isFinite(w.resetsAt) || !Number.isFinite(w.windowDurationMins) || w.windowDurationMins <= 0) return null;
  const length = w.windowDurationMins * 60000, left = Math.max(0, Math.min(length, w.resetsAt - now));
  const timeLeft = left / length * 100, elapsed = length - left, used = 100 - w.remaining;
  const rate = elapsed >= length * 0.05 && used > 0 ? used / elapsed : 0;
  const ahead = rate > 0 && w.remaining < timeLeft - 1;
  return { timeLeft, ahead, runsOutAt: ahead ? now + w.remaining / rate : null, perDay: left >= DAY ? w.remaining / (left / DAY) : null };
}
// The sidebar's lines: Claude first, then ChatGPT, each one's own windows
// (5h, week), not a model's or a feature's.
const SHORT_WINDOW = name => name.replace(/^(\d+) hours?$/, '$1h').replace(/^hour$/, '1h');
export function footRows(answer, now = Date.now()) {
  const order = { claude: 0, pi: 1 };
  const rows = (Array.isArray(answer) ? answer : []).filter(row => SUBSCRIPTIONS[row?.agent]).sort((a, b) => (order[a.agent] ?? 9) - (order[b.agent] ?? 9));
  return usageSections(rows, now).flatMap(section => {
    const account = section.title.split(' · ')[0];
    return (section.windows ?? []).filter(w => w.remaining !== null && !w.name.includes(' · ')).map(w => ({ ...w, account, short: SHORT_WINDOW(w.name), pace: paceOf(w, now) }));
  });
}
export function usageFoot(answer, now = Date.now()) {
  const rings = [], lines = [];
  for (const section of usageSections(answer, now)) {
    const account = section.title.split(' · ')[0];
    const known = (section.windows ?? []).filter(w => w.remaining !== null);
    if (!known.length) continue;
    const ring = known.find(w => w.name === 'week') ?? known.reduce((a, b) => (b.remaining < a.remaining ? b : a));
    rings.push({ ...ring, account, pace: paceOf(ring, now) });
    for (const w of known) if (w !== ring) lines.push({ ...w, account, label: `${account} ${w.name.replace(/^week · (.+)$/, '$1 week')}`, pace: paceOf(w, now) });
  }
  return { rings, lines };
}
// The last seven days as this window's own days, today last: from the
// computer's hours, or (a computer that does not count hours yet) its UTC days.
export function todayUsage(history, now = Date.now()) {
  if (!history || typeof history !== 'object') return null;
  const midnight = new Date(now); midnight.setHours(0, 0, 0, 0);
  const days = Array.from({ length: 7 }, (_, i) => { const d = new Date(midnight); d.setDate(d.getDate() - (6 - i)); return { at: d.getTime(), tokens: 0, estimatedUSD: 0, responses: 0 }; });
  const add = (i, n) => { if (i < 0) return; days[i].tokens += n.tokens; days[i].estimatedUSD += n.estimatedUSD; days[i].responses += n.responses; };
  const total = n => (typeof n?.tokens === 'number' ? n.tokens : Object.values(n?.tokens ?? {}).reduce((sum, k) => sum + (Number(k) || 0), 0));
  if (Array.isArray(history.hours)) {
    for (const hour of history.hours) if (hour?.at <= now) add(days.findLastIndex(day => hour.at >= day.at), { tokens: total(hour), estimatedUSD: Number(hour.estimatedUSD) || 0, responses: Number(hour.responses) || 0 });
  } else if (Array.isArray(history.days)) {
    const local = at => { const d = new Date(at); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
    const keys = days.map(day => local(day.at));
    for (const day of history.days) add(keys.indexOf(day?.key), { tokens: total(day), estimatedUSD: Number(day.estimatedUSD) || 0, responses: Number(day.responses) || 0 });
  } else return null;
  return { today: days[6], days, weekUSD: days.reduce((sum, day) => sum + day.estimatedUSD, 0) };
}
export function tokenCount(n) {
  if (!Number.isFinite(n)) return '';
  for (const [size, unit] of [[1e9, 'B'], [1e6, 'M'], [1e3, 'k']]) if (n >= size) return `${(n / size).toFixed(n < size * 10 ? 1 : 0).replace(/\.0$/, '')}${unit}`;
  return String(Math.round(n));
}
export const dollars = n => (!Number.isFinite(n) ? '' : n >= 10 ? `$${Math.round(n).toLocaleString('en-US')}` : `$${n.toFixed(2)}`);

// A ring: what is left, clockwise from the top, and a notch where even
// spending would have it.
const SVG_NS = 'http://www.w3.org/2000/svg';
const svgNode = (tag, attributes) => { const node = document.createElementNS(SVG_NS, tag); for (const [k, v] of Object.entries(attributes)) node.setAttribute(k, String(v)); return node; };
function ringDial(w, size) {
  const R = 26, C = 2 * Math.PI * R;
  const dial = svgNode('svg', { viewBox: '0 0 64 64', width: size, height: size, 'aria-hidden': 'true', focusable: 'false' });
  dial.append(svgNode('circle', { class: 'usage-ring-track', cx: 32, cy: 32, r: R }));
  dial.append(svgNode('circle', { class: 'usage-ring-arc', cx: 32, cy: 32, r: R, 'stroke-dasharray': `${(C * w.remaining / 100).toFixed(2)} ${C.toFixed(2)}`, transform: 'rotate(-90 32 32)' }));
  if (w.pace) {
    const a = w.pace.timeLeft / 100 * 2 * Math.PI, at = r => [32 + r * Math.sin(a), 32 - r * Math.cos(a)].map(n => n.toFixed(2));
    const [x1, y1] = at(19.5), [x2, y2] = at(31.5);
    dial.append(svgNode('line', { class: 'usage-pace-gap', x1, y1, x2, y2 }), svgNode('line', { class: 'usage-pace-mark', x1, y1, x2, y2 }));
  }
  return dial;
}
const whenShort = (at, now = Date.now()) => (at - now < DAY ? new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : new Date(at).toLocaleDateString([], { weekday: 'short' }));
const whenLong = at => new Date(at).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' });
// What the pace means, in words: running ahead, when it runs out; not, what a day can take.
export function paceWords(pace) {
  if (!pace) return '';
  if (pace.ahead) return `Faster than even spending · runs out ${whenLong(pace.runsOutAt)}, before it resets`;
  return pace.perDay != null ? `On pace · ${Math.round(pace.perDay)}% a day lasts until it resets` : 'On pace';
}

const PREFERENCE_KEY = 'imperfect:usage-page:v1';
export function readUsagePreferences(storage) {
  try {
    const stored = JSON.parse((storage || globalThis.localStorage)?.getItem(PREFERENCE_KEY) || 'null');
    return { metric: ['cost', 'tokens', 'limits', 'graphs'].includes(stored?.metric) ? stored.metric : 'limits', period: [7, 30, 90].includes(stored?.period) ? stored.period : 30 };
  } catch { return { metric: 'limits', period: 30 }; }
}
function saveUsagePreferences({ metric, period }) {
  try { globalThis.localStorage?.setItem(PREFERENCE_KEY, JSON.stringify({ metric, period })); } catch { /* Storage may be disabled. */ }
}
export function mountUsage({ command, captureCommand = () => command, panel = document.querySelector('.entry-screen'), identity = () => '', ownerLabel = identity, cacheIdentity = identity, scopeLabel = ownerLabel, selectScope = null, tabs = () => [], revalidateMs = 180000, present = () => {}, dismiss = () => {}, showing = () => true, ownsFocus = () => true, canClose = () => true }) {
  const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
  const button = el('button', 'entry-voice entry-usage');
  button.type = 'button'; button.innerHTML = GAUGE;
  button.title = 'Usage'; button.setAttribute('aria-label', 'Usage'); button.setAttribute('aria-expanded', 'false');
  let box = null, body = null, reload = null, generation = 0, key = null, pageCacheKey = null, timer = null, history = null, limits = null;
  const preferences = { metric: 'limits', period: 30, breakdown: 'model' };
  const resetActions = new Map();
  const outcomes = { not_applied: 'Reset not sent: the account or reset could not be validated. Refresh limits, then confirm an available reset again.', reset: 'Reset applied. Refresh limits to check the new windows.', nothing_to_reset: 'Nothing to reset; no reset was applied.', no_credit: 'No reset credit available; refresh limits.', already_redeemed: 'This reset was already redeemed. Refresh limits to check the new windows.', uncertain: 'Result unknown. Refresh to check, or explicitly retry this same reset; never use a new request.' };
  let metricControls = null, periodControls = null, scope = null, localOnly = false, lastRead = 0, reading = false;
  const reflections = new Map();
  let drain = createUsageDrain(), activityKey = '';
  const agentFor = account => Object.keys(SUBSCRIPTIONS).find(agent => SUBSCRIPTIONS[agent].name === account);
  const isDraining = (account, name) => drain.isDraining(agentFor(account), name, tabs());
  const readEvery = () => usageSections(shownLimits).some(section => section.windows?.some(w => w.remaining !== null && isDraining(section.title.split(' · ')[0], w.name))) ? Math.min(revalidateMs, DRAIN_READ_MS) : revalidateMs;
  const cacheKey = () => `imperfect:usage-reflection:v1:${cacheIdentity()}`;
  function reflection(id = cacheKey()) {
    if (!reflections.has(id)) {
      let saved = {};
      try { saved = JSON.parse(localStorage.getItem(id) || '{}'); } catch { /* storage disabled */ }
      if (!saved || typeof saved !== 'object' || Array.isArray(saved)) saved = {};
      for (const field of ['limits', 'history']) {
        const entry = saved[field];
        if (!entry || !Number.isFinite(entry.at) || (field === 'limits' ? !Array.isArray(entry.data) : !entry.data || typeof entry.data !== 'object')) delete saved[field];
        else entry.stale = true;
      }
      reflections.set(id, saved);
    }
    return reflections.get(id);
  }
  const keep = (field, data, id) => {
    const held = reflection(id);
    if (field === 'limits' && id === cacheKey()) drain.observe(data);
    held[field] = { data, at: Date.now(), stale: false };
    try { localStorage.setItem(id, JSON.stringify(held)); } catch { /* memory reflection still works */ }
  };
  function paintScope() {
    const held = reflection()[preferences.metric === 'limits' ? 'limits' : 'history'];
    scope.textContent = `${scopeLabel()}${held?.stale ? ` · not live, as of ${new Date(held.at).toLocaleString()}` : ''}`;
  }
  function controls(options, label, value, select) {
    const group = el('div', 'usage-toggle'); group.setAttribute('role', 'group'); group.setAttribute('aria-label', label);
    for (const [key, text] of options) {
      const b = el('button', '', text); b.type = 'button'; b.dataset.value = key; b.setAttribute('aria-pressed', String(key === value)); b.onclick = () => select(key); group.append(b);
    }
    group.onkeydown = e => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
      const buttons = [...group.querySelectorAll('button:not(:disabled)')]; if (!buttons.length) return;
      e.preventDefault(); const i = buttons.indexOf(document.activeElement);
      buttons[e.key === 'Home' ? 0 : e.key === 'End' ? buttons.length - 1 : (i + (e.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length].focus({ preventScroll: true });
    };
    return group;
  }
  function updateControls() {
    for (const b of metricControls.children) b.setAttribute('aria-pressed', String(b.dataset.value === preferences.metric));
    periodControls.hidden = preferences.metric === 'graphs';
    for (const b of periodControls.children) { b.setAttribute('aria-pressed', String(Number(b.dataset.value) === preferences.period)); b.disabled = preferences.metric === 'limits'; }
    reload.setAttribute('aria-label', preferences.metric === 'limits' ? 'Refresh limits' : 'Refresh usage');
  }
  function show() {
    body.firstChild?.dispose?.(); updateControls(); paintScope();
    if (preferences.metric === 'limits') body.replaceChildren(paint(limits, history ?? reflection().history?.data ?? null));
    else body.replaceChildren(preferences.metric === 'graphs' ? mountGraphs(history, preferences, { el }) : mountHistoryPage(history, preferences, { el }));
  }
  function selectMetric(metric) {
    if (metric === preferences.metric) return;
    ++generation; preferences.metric = metric; saveUsagePreferences(preferences); updateControls();
    if (key === identity() && pageCacheKey === cacheKey() && (metric === 'limits' ? limits !== null : history !== null)) { reload.disabled = false; reload.setAttribute('aria-busy', 'false'); body.setAttribute('aria-busy', 'false'); show(); }
    else void refresh();
  }
  const priorInert = new Map();
  function close({ returnFocus = false } = {}) {
    if (!box) return;
    ++generation; clearInterval(timer); timer = null;
    body.firstChild?.dispose?.(); box.remove(); box = body = reload = metricControls = periodControls = null; history = limits = null;
    panel.classList.remove('usage-open');
    dismiss();
    for (const [child, inert] of priorInert) child.inert = inert;
    priorInert.clear();
    button.setAttribute('aria-expanded', 'false');
    removeEventListener('keydown', onKey, true);
    if (returnFocus) {
      const target = summary.getClientRects().length ? summary : button;
      if (target.getClientRects().length) target.focus({ preventScroll: true });
    }
  }
  function onKey(event) {
    if (event.key !== 'Escape' || !showing() || !ownsFocus()) return;
    const model = body?.firstChild?.dismissModel?.();
    const cancel = body?.querySelector('.usage-reset-confirm .usage-back:not(:disabled)');
    if (!model && !cancel && !canClose()) return;
    event.preventDefault(); event.stopImmediatePropagation();
    if (model) return;
    if (cancel) { cancel.click(); return; }
    close({ returnFocus: true });
  }
  // Limits opens at a glance: each week a ring, and what today used.
  function glance(answer, used) {
    const now = Date.now();
    let rings = [], today = null;
    try { rings = usageFoot(answer, now).rings; } catch { /* unreadable: nothing */ }
    try { today = todayUsage(used, now); } catch { /* likewise */ }
    if (!rings.length && !today) return null;
    const part = el('div', 'usage-glance');
    for (const w of rings) {
      const tile = el('section', 'usage-ring'); tile.setAttribute('aria-label', `${w.account} ${w.name}: ${w.remaining}% left`);
      tile.dataset.pace = w.pace?.ahead ? 'ahead' : 'even'; tile.dataset.low = String(w.remaining <= 15);
      const dial = el('div', 'usage-ring-dial'), value = el('div', 'usage-ring-value');
      value.append(el('span', 'usage-ring-percent', `${w.remaining}%`), el('span', 'usage-ring-left', 'left'));
      dial.append(ringDial(w, 104), value);
      const left = shortLeft(w.resetsAt - now);
      const note = w.pace?.ahead ? `Fast · runs out ${whenShort(w.pace.runsOutAt, now)}`
        : w.pace?.perDay != null ? `${Math.round(w.pace.perDay)}% a day to last` : left ? `resets in ${left}` : '';
      tile.append(dial, el('p', 'usage-ring-name', `${w.account} · ${w.name}`), el('p', 'usage-ring-note', note));
      if (w.resetsAt !== null) tile.append(el('p', 'usage-ring-reset', `resets ${whenLong(w.resetsAt)}`));
      tile.title = paceWords(w.pace);
      markDraining(tile, w.account, w.name, w.remaining);
      part.append(tile);
    }
    if (today) {
      const card = el('section', 'usage-today'); card.setAttribute('aria-label', 'Today');
      const cap = el('p', 'usage-today-cap'); cap.append(el('span', null, 'Today'), el('span', null, `${today.today.responses.toLocaleString()} ${today.today.responses === 1 ? 'reply' : 'replies'}`));
      const big = el('p', 'usage-today-big'); big.append(el('span', 'usage-today-tokens', tokenCount(today.today.tokens)), el('span', 'usage-today-unit', 'tokens'));
      const spark = el('div', 'usage-today-spark'), names = el('div', 'usage-today-days');
      spark.setAttribute('aria-hidden', 'true');
      const most = Math.max(...today.days.map(day => day.tokens));
      for (const [i, day] of today.days.entries()) {
        const bar = el('span', i === 6 ? 'now' : null); bar.style.height = `${day.tokens ? Math.max(6, day.tokens / most * 100) : 0}%`;
        bar.title = `${new Date(day.at).toLocaleDateString([], { weekday: 'long' })}: ${tokenCount(day.tokens)} tokens, ≈ ${dollars(day.estimatedUSD)}`;
        spark.append(bar); names.append(el('span', null, new Date(day.at).toLocaleDateString([], { weekday: 'narrow' })));
      }
      card.append(cap, big, el('p', 'usage-today-sub', `≈ ${dollars(today.today.estimatedUSD)} at API prices · ${dollars(today.weekUSD)} this week`), spark, names);
      card.title = 'What these tokens would have cost on the API, not what the subscription charges.';
      part.append(card);
    }
    return part;
  }
  function paint(answer, used = null) {
    const part = el('div', 'usage-limits');
    const sections = usageSections(answer);
    const top = glance(answer, used);
    if (top) part.append(top);
    if (!sections.length) part.append(el('p', 'usage-line', 'No limits reported.'));
    for (const section of sections) {
      const account = el('section', 'usage-account'); account.setAttribute('aria-label', section.title);
      account.append(el('h2', 'usage-name', section.title));
      if (section.line) account.append(el('p', 'usage-line', section.line));
      for (const w of section.windows ?? []) {
        const row = el('div', 'usage-window'), label = el('div', 'usage-window-label');
        const accountName = section.title.split(' · ')[0];
        row.dataset.account = accountName; row.dataset.window = w.name;
        markDraining(row, accountName, w.name, w.remaining);
        label.append(el('span', 'usage-window-name', w.name), el('span', 'usage-percent', w.remaining === null ? 'Unknown' : `${w.remaining}% left`));
        const bar = el('div', 'usage-bar'), track = el('span', 'usage-track'); bar.append(track);
        if (w.remaining !== null) {
          const fill = el('span', 'usage-fill'); fill.style.width = `${w.remaining}%`;
          const old = [...(body?.querySelectorAll('.usage-window') ?? [])].find(n => n.dataset.account === accountName && n.dataset.window === w.name);
          fill.style.setProperty('--usage-previous', old?.querySelector('.usage-fill')?.style.width ?? `${w.remaining}%`);
          track.append(fill);
          bar.setAttribute('role', 'meter'); bar.setAttribute('aria-valuemin', '0'); bar.setAttribute('aria-valuemax', '100');
          bar.setAttribute('aria-valuenow', String(w.remaining)); bar.setAttribute('aria-valuetext', `${w.remaining}% left${isDraining(accountName, w.name) ? ', being used now' : ''}${w.reset ? `, ${w.reset}` : ''}`);
        } else { bar.setAttribute('role', 'img'); }
        bar.setAttribute('aria-label', `${section.title}, ${w.name}${w.remaining === null ? ': quota unknown' : ''}`);
        bar.tabIndex = 0;
        const detail = [w.remaining === null ? 'Quota unknown' : `${w.remaining}% left`];
        if (w.timeLeft !== null && w.remaining !== null) {
          const marker = el('span', 'usage-time-mark'); marker.style.left = `${w.timeLeft}%`; marker.setAttribute('aria-hidden', 'true'); bar.append(marker);
          detail.push(`${w.timeLeft}% of the window left. The line is where even spending would be.`);
        }
        if (w.resetsAt !== null) detail.push(`Resets ${new Date(w.resetsAt).toLocaleString()} · ${w.reset}`);
        else detail.push('Reset time unavailable');
        // Native tooltip works without stealing taps or mounting a second dialog.
        bar.title = detail.join('\n');
        row.append(label, bar, el('span', 'usage-reset', w.reset || 'Reset unknown')); account.append(row);
        const pace = paceOf(w);
        if (pace) { const note = el('p', 'usage-pace', paceWords(pace)); note.dataset.pace = pace.ahead ? 'ahead' : 'even'; account.append(note); }
      }
      if (section.accountId) {
        const credits = section.resetCredits;
        const label = el('p', 'usage-line', `Codex banked resets · account ${section.accountId} · computer ${ownerLabel()}`);
        account.append(label);
        const count = credits?.availableCount;
        account.append(el('p', 'usage-line', Number.isSafeInteger(count) ? `${count} reset${count === 1 ? '' : 's'} available${credits.nextExpiresAt ? ` · next expires ${new Date(credits.nextExpiresAt).toLocaleString()}` : count > 0 ? ' · expiry unavailable' : ''}` : 'Banked resets unavailable · try Refresh'));
        const actionKey = `${key}:${section.accountId}`;
        const active = section.resetAttempt, local = resetActions.get(actionKey);
        const validOperationId = id => typeof id === 'string' && id.length > 0 && id.length <= 200;
        const invalidActive = active && !validOperationId(active.operationId);
        const resolved = !invalidActive && local?.outcome && local.outcome !== 'uncertain' && local.target.creditId === active?.creditId && local.target.operationId === active?.operationId;
        const action = active && !resolved ? { target: { accountId: section.accountId, creditId: active.creditId, operationId: active.operationId }, busy: active.busy, outcome: active.uncertain || invalidActive ? 'uncertain' : null } : local;
        if (action?.outcome) { const status = el('p', 'usage-line', outcomes[action.outcome]); status.setAttribute('role', 'status'); account.append(status); }
        const retry = action?.outcome === 'uncertain';
        const target = retry ? action.target : { accountId: section.accountId, creditId: credits?.nextCreditId, operationId: crypto.randomUUID() };
        if (!reflection().limits?.stale && validOperationId(target.operationId) && target.creditId && (retry || (count > 0 && credits.nextExpiresAt > Date.now()))) {
          const use = el('button', 'usage-refresh', retry ? 'Retry same reset' : 'Use reset'); use.type = 'button'; use.disabled = Boolean(action?.busy);
          account.append(use);
          use.onclick = () => {
            if (key !== identity() || action?.busy) return;
            const selected = key, mine = generation, send = captureCommand();
            const valid = () => box && mine === generation && selected === identity();
            use.disabled = true;
            const confirm = el('div', 'usage-reset-confirm'); confirm.setAttribute('role', 'group'); confirm.setAttribute('aria-label', 'Confirm Codex reset');
            confirm.append(el('p', 'usage-line', `Use reset ${target.creditId} on account ${target.accountId}, computer ${ownerLabel()}? This consumes one banked subscription reset and cannot be undone. It may refresh the 5-hour and weekly limits and move your weekly reset date. This is not cash or purchased credit.${retry ? ' Retrying the same request only; the previous result is unknown.' : ''}`));
            const cancel = el('button', 'usage-back', 'Cancel'), yes = el('button', 'usage-refresh', retry ? 'Confirm retry' : 'Confirm use reset'); cancel.type = yes.type = 'button';
            cancel.onclick = () => { confirm.remove(); use.disabled = false; use.focus({ preventScroll: true }); };
            yes.onclick = async () => {
              if (!valid() || yes.disabled) return;
              yes.disabled = cancel.disabled = true;
              resetActions.set(actionKey, { target, busy: true });
              try {
                const result = await send('codex-reset-consume', { ...target, confirmed: true });
                resetActions.set(actionKey, { target, outcome: outcomes[result?.outcome] ? result.outcome : 'uncertain' });
              } catch { resetActions.set(actionKey, { target, outcome: 'uncertain' }); }
              if (valid()) await refresh();
            };
            confirm.append(cancel, yes); account.append(confirm);
          };
        } else if (retry || count > 0) account.append(el('p', 'usage-line', 'Reset target unavailable or expired · try Refresh'));
      }
      part.append(account);
    }
    return part;
  }
  async function refresh() {
    if (!box) return;
    syncSummary();
    const mine = ++generation, selected = identity(), id = cacheKey(), metric = preferences.metric;
    const held = reflection(id), field = metric === 'limits' ? 'limits' : 'history';
    if (key !== selected || pageCacheKey !== id) {
      history = limits = null;
      for (const field of ['limits', 'history']) if (held[field]) held[field].stale = true;
    }
    history ??= held.history?.data ?? null; limits ??= held.limits?.data ?? null;
    key = selected; pageCacheKey = id; reading = mine; lastRead = Date.now();
    const valid = () => box && mine === generation && selected === identity() && id === cacheKey();
    reload.disabled = true; reload.setAttribute('aria-busy', 'true'); body.setAttribute('aria-busy', 'true');
    if (held[field]?.data) { held[field].stale = true; show(); }
    else { paintScope(); body.firstChild?.dispose?.(); body.replaceChildren(el('p', 'usage-line', 'Reading usage computer…')); }
    try {
      const answer = await command(metric === 'limits' ? 'usage' : 'usage-history');
      if (valid()) {
        if (metric === 'limits') limits = answer ?? []; else history = answer;
        keep(field, metric === 'limits' ? limits : history, id);
        if (metric === 'limits') {
          // A newer page reading also supersedes an outstanding sidebar reading.
          summaryReading = null; summaryAt = Date.now();
          paintSummary(limits); readToday(selected);
        }
        if (metric !== 'limits' && !history) body.replaceChildren(el('p', 'usage-line', 'Historical usage unavailable · try Refresh'));
        else show();
      }
    } catch {
      if (valid()) {
        if (metric === 'limits' && limits) {
          limits = limits.map(row => row.agent === 'pi' ? { ...row, resetCredits: null, limitsUnavailable: true } : row);
          show();
          body.append(el('p', 'usage-line', 'Updated limits unavailable (computer may be offline) · try Refresh'));
        } else if (metric !== 'limits' && history) {
          show(); body.append(el('p', 'usage-line', 'Updated usage unavailable (computer may be offline) · try Refresh'));
        } else { paintScope(); body.replaceChildren(el('p', 'usage-line', `${metric === 'limits' ? 'Limits' : 'Historical usage'} unavailable (computer may be offline) · try Refresh`)); }
      }
    } finally {
      if (reading === mine) reading = false;
      if (valid()) { reload.disabled = false; reload.setAttribute('aria-busy', 'false'); body.setAttribute('aria-busy', 'false'); }
    }
  }
  // Limits shows what today used too: the history, read after the limits
  // unless what is held is fresh.
  let todayReading = null;
  async function readToday(selected) {
    const mine = generation, id = cacheKey(), held = reflection(id).history;
    if (todayReading?.generation === mine || (held && !held.stale && Date.now() - held.at < revalidateMs)) return;
    const request = { generation: mine }; todayReading = request;
    try {
      const answer = await command('usage-history');
      if (box && mine === generation && selected === identity() && id === cacheKey() && todayReading === request && answer && typeof answer === 'object') {
        history = answer; keep('history', answer, id);
        if (preferences.metric === 'limits') show();
      }
    } catch { /* Limits stand without it */ }
    finally { if (todayReading === request) todayReading = null; }
  }
  function sync() {
    if (document.hidden) return;
    syncSummary(); syncActivity();
    if (!box) return;
    if (key !== identity() || pageCacheKey !== cacheKey() || (reading !== generation && Date.now() - lastRead >= (preferences.metric === 'limits' ? readEvery() : revalidateMs))) void refresh();
  }
  function open() {
    if (box) { present(); sync(); box.querySelector('.usage-back')?.focus({ preventScroll: true }); return; }
    Object.assign(preferences, readUsagePreferences());
    document.querySelector('#entry-input')?.blur();
    box = el('section', 'usage-box'); box.setAttribute('aria-label', 'Usage');
    const header = el('header', 'usage-header'), back = el('button', 'usage-back', 'Back'); reload = el('button', 'usage-refresh', 'Refresh');
    back.setAttribute('aria-label', 'Back to conversation'); reload.setAttribute('aria-label', 'Refresh limits');
    back.type = reload.type = 'button'; back.onclick = () => close({ returnFocus: true }); reload.onclick = () => void refresh();
    const heading = el('div', 'usage-heading'); heading.append(el('h1', 'usage-title', 'Usage'));
    scope = el('p', 'usage-line usage-owner-scope'); heading.append(scope);
    metricControls = controls([['cost', 'Cost'], ['tokens', 'Tokens'], ['limits', 'Limits'], ['graphs', 'Graphs']], 'Usage metric', preferences.metric, selectMetric);
    periodControls = controls([[7, '7 days'], [30, '30 days'], [90, '90 days']], 'Usage period', preferences.period, period => { preferences.period = period; saveUsagePreferences(preferences); updateControls(); if (history) show(); });
    header.append(back, heading, reload); const toolbar = el('div', 'usage-toolbar'); toolbar.append(metricControls, periodControls);
    if (selectScope) toolbar.append(controls([['all', 'All computers'], ['local', 'This computer only']], 'Usage computer', localOnly ? 'local' : 'all', value => {
      localOnly = value === 'local'; selectScope(localOnly);
      for (const b of toolbar.querySelector('[aria-label="Usage computer"]').children) b.setAttribute('aria-pressed', String(b.dataset.value === value));
      void refresh();
    }));
    body = el('div', 'usage-content'); box.append(header, toolbar, body); updateControls();
    for (const child of panel.children) { priorInert.set(child, child.inert); child.inert = true; }
    panel.append(box); panel.classList.add('usage-open'); button.setAttribute('aria-expanded', 'true');
    present();
    addEventListener('keydown', onKey, true); timer = setInterval(sync, 250);
    back.focus({ preventScroll: true });
    void refresh();
  }
  button.addEventListener('pointerdown', event => { event.stopPropagation(); document.querySelector('#entry-input')?.blur(); });
  button.onclick = () => { if (box && showing()) close({ returnFocus: true }); else open(); };
  // The sidebar's foot: a line for each subscription's main limits, what is
  // left and when it resets, orange when spending runs ahead of even. Read
  // as often as the page itself would; pressed, it opens the page.
  const summary = el('button', 'usage-summary');
  summary.type = 'button';
  summary.setAttribute('aria-label', 'Usage');
  summary.addEventListener('pointerdown', event => event.stopPropagation());
  summary.onclick = event => button.onclick(event);
  let summaryAt = 0, summaryReading = null, shownLimits = null, summaryKey = cacheKey();
  function syncSummary() {
    const id = cacheKey();
    if (summaryKey === id) return;
    // Drop the old scope's in-flight token as well as its throttle. Returning
    // A -> B -> A must not revive A's earlier response, even with Usage closed.
    summaryKey = id; summaryReading = null; summaryAt = 0;
    drain = createUsageDrain();
    const held = reflection(id);
    if (held.limits) held.limits.stale = true;
    paintSummary(held.limits?.data ?? null);
    void readSummary(true);
  }
  function paintSummary(answer = shownLimits) {
    shownLimits = answer;
    const now = Date.now();
    let rows = [];
    try { rows = footRows(answer, now); } catch { /* an unreadable answer draws nothing */ }
    const existing = new Map([...summary.querySelectorAll('.usage-row')].map(row => [row.dataset.key, row]));
    const parts = rows.map(w => {
      const id = JSON.stringify([w.account, w.name]);
      const row = existing.get(id) ?? el('span', 'usage-row');
      row.dataset.key = id;
      markDraining(row, w.account, w.name, w.remaining);
      row.dataset.pace = w.pace?.ahead ? 'ahead' : 'even'; row.dataset.low = String(w.remaining <= 15);
      if (!row.firstChild) {
        const name = el('span', 'usage-row-name', w.account); name.append(' ', el('span', 'usage-row-window', w.short));
        const meter = el('span', 'usage-row-meter'); meter.append(el('span', 'usage-row-fill'));
        row.append(name, meter, el('span', 'usage-row-left'), el('span', 'usage-row-reset'));
      }
      row.querySelector('.usage-row-fill').style.width = `${w.remaining}%`;
      row.querySelector('.usage-row-left').textContent = `${w.remaining}%`;
      row.querySelector('.usage-row-reset').textContent = shortLeft(w.resetsAt - now);
      return row;
    });
    if (!parts.length) { const icon = el('span', 'usage-summary-icon'); icon.innerHTML = GAUGE; parts.push(icon, el('span', 'usage-summary-name', 'Usage')); }
    if (parts.length !== summary.childNodes.length || parts.some((part, i) => part !== summary.childNodes[i])) summary.replaceChildren(...parts);
    summary.title = rows.length ? rows.map(w => `${w.account} ${w.name}: ${w.remaining}% left${isDraining(w.account, w.name) ? ', being used now' : ''}${w.reset ? `, ${w.reset}` : ''}${w.pace ? `. ${paceWords(w.pace)}` : ''}`).join('\n') : 'Usage';
    summary.setAttribute('aria-label', summary.title);
  }
  function markDraining(row, account, name, remaining) {
    const active = remaining !== null && isDraining(account, name);
    row.dataset.draining = String(active);
    const text = `${account} ${SHORT_WINDOW(name)}: ${remaining === null ? 'quota unknown' : `${remaining}% left`}${active ? ', being used now' : ''}`;
    row.title = text; row.setAttribute('aria-label', text);
  }
  function paintPageActivity() {
    if (!box || preferences.metric !== 'limits') return;
    for (const row of body.querySelectorAll('.usage-window')) {
      const remaining = row.querySelector('[aria-valuenow]')?.getAttribute('aria-valuenow');
      markDraining(row, row.dataset.account, row.dataset.window, remaining === undefined ? null : Number(remaining));
      const meter = row.querySelector('[aria-valuenow]');
      if (meter) {
        const text = meter.getAttribute('aria-valuetext').replace(', being used now', '');
        meter.setAttribute('aria-valuetext', row.dataset.draining === 'true' ? text.replace('% left', '% left, being used now') : text);
      }
    }
    const rings = usageFoot(limits).rings;
    for (const [i, row] of [...body.querySelectorAll('.usage-ring')].entries()) {
      const w = rings[i]; if (w) markDraining(row, w.account, w.name, w.remaining);
    }
  }
  function syncActivity() {
    const next = JSON.stringify([...new Set(tabs().map(tabSubscription).filter(Boolean))].sort());
    if (activityKey === next) return;
    activityKey = next;
    paintSummary(); paintPageActivity();
  }
  async function readSummary(force = false) {
    if (summaryReading || document.hidden || (box && reading && preferences.metric === 'limits') || (!force && Date.now() - summaryAt < readEvery())) return;
    const id = cacheKey(), request = {}; summaryReading = request; summaryAt = Date.now();
    try {
      const answer = await command('usage');
      if (summaryReading !== request || summaryKey !== id || cacheKey() !== id) return;
      const latest = answer ?? [];
      keep('limits', latest, id);
      // A page may have opened Cost with an earlier limits reflection. Keep
      // its reusable value coherent when this scope's sidebar answer arrives.
      if (box && pageCacheKey === id && key === identity()) {
        limits = latest;
        if (preferences.metric === 'limits' && !reading) { lastRead = summaryAt; show(); }
      }
      paintSummary(latest); paintPageActivity();
    } catch { /* the last reading stays until the computer answers */ }
    finally { if (summaryReading === request) summaryReading = null; }
  }
  try { paintSummary(reflection().limits?.data ?? null); } catch { paintSummary(null); }
  setTimeout(() => { syncSummary(); void readSummary(true); }, 1500);
  // Every half minute: the countdowns move on, and the limits are read when due.
  setInterval(() => { if (document.hidden) return; syncSummary(); paintSummary(); paintPageActivity(); void readSummary(); }, 30000);
  return { button, summary, open, close, sync, syncActivity, keys: () => box?.querySelector('.usage-back')?.focus({ preventScroll: true }), get isOpen() { return Boolean(box) && showing(); } };
}
