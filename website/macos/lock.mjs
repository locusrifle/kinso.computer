// This view accepts counts and results. Only the website adapter below ever has an input.
import { MACOS, clamp, ease, metrics, motionClock } from './timings.mjs?v=sequoia-4';

export const LOCK_USER = Object.freeze({ name: 'imperfect', picture: new URL('../mac/icons/dock-imperfect.webp', import.meta.url).href });
export function clockText(date = new Date(), locale) {
  const dateFormat = new Intl.DateTimeFormat(locale, { weekday: 'long', day: 'numeric', month: 'long' });
  const timeFormat = new Intl.DateTimeFormat(locale, { hour: 'numeric', minute: '2-digit' });
  const time = timeFormat.formatToParts(date).filter(part => part.type !== 'dayPeriod').map(part => part.value).join('').trim();
  const formatted = dateFormat.format(date), resolved = dateFormat.resolvedOptions().locale;
  // The day-first English lock template omits the weekday comma. The US template keeps it.
  const day = /^en-(?:AU|GB|NZ)\b/i.test(resolved) ? formatted.replace(/^(\p{L}+), /u, '$1 ') : formatted;
  return { date: day, time };
}
export const shakeAt = (elapsed, reduced = false) => reduced ? 0
  : MACOS.wrongTravel * Math.sin(clamp(elapsed / MACOS.wrongMs) * Math.PI * 8) * (1 - clamp(elapsed / MACOS.wrongMs));
const node = (tag, cls, text) => { const el = document.createElement(tag); if (cls) el.className = cls; if (text != null) el.textContent = text; return el; };
const svg = body => `<svg viewBox="0 0 24 20" aria-hidden="true">${body}</svg>`;
const wifi = svg('<g fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M2 6q10-9 20 0M6 10q6-6 12 0M10 14q2-2 4 0"/></g><circle cx="12" cy="17" r="1.3"/>');
const battery = svg('<rect x="1" y="5" width="19" height="10" rx="2" fill="none" stroke="currentColor" opacity=".6"/><rect x="3" y="7" width="15" height="6" rx=".6"/><path d="M22 8v4" stroke="currentColor" stroke-width="2"/>');
const arrow = '<svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="8"/><path d="M5 10h9m-4-4 4 4-4 4"/></svg>';

export function mountLock({ screen, native = false, identity = LOCK_USER, reduced = matchMedia('(prefers-reduced-motion: reduce)'), clock = motionClock, date = () => new Date(), locale } = {}) {
  metrics(); screen.classList.add('macos-lock');
  const content = node('div', 'macos-lock-content'), status = node('div', 'macos-lock-status');
  status.setAttribute('aria-hidden', 'true');
  const keyboard = node('span', '', 'ABC'), network = node('span'), power = node('span');
  network.innerHTML = wifi; power.innerHTML = battery; power.firstChild.classList.add('macos-battery');
  status.append(keyboard, network, power);
  const clockBox = node('div', 'macos-lock-clock'), day = node('span', 'macos-date'), time = node('time', 'macos-time');
  clockBox.append(day, time);
  const user = node('div', 'macos-user'), picture = node('img', 'macos-avatar'), name = node('p', 'macos-name', identity.name);
  picture.src = identity.picture; picture.alt = ''; picture.draggable = false;
  const form = node(native ? 'div' : 'form'); form.id = native ? 'nativePassword' : 'lock';
  form.setAttribute('aria-label', 'Locked');
  if (!native) { form.autocomplete = 'off'; form.noValidate = true; }
  const field = node('div', 'macos-field'); field.id = 'field'; field.dataset.typed = 'false';
  let input;
  if (!native) {
    input = node('input'); input.id = 'password'; input.name = 'password'; input.type = 'password'; input.placeholder = 'Enter Password';
    input.setAttribute('aria-label', 'Password'); input.autocomplete = 'current-password'; input.autocapitalize = 'none'; input.spellcheck = false;
    input.setAttribute('autocorrect', 'off'); input.enterKeyHint = 'go'; input.maxLength = 128;
    field.append(input);
  }
  const placeholder = node('span', 'macos-placeholder', 'Enter Password'), dots = node('span', 'macos-dots'), check = node('span', 'macos-check');
  placeholder.setAttribute('aria-hidden', 'true'); dots.id = 'dots'; dots.setAttribute('aria-hidden', 'true'); check.setAttribute('aria-hidden', 'true');
  field.append(placeholder, dots, check);
  if (!native) { const submit = node('button', 'macos-submit'); submit.id = 'unlock'; submit.type = 'submit'; submit.setAttribute('aria-label', 'Unlock'); submit.innerHTML = arrow; field.append(submit); }
  form.append(field); user.append(picture, name, form); content.append(status, clockBox, user); screen.replaceChildren(content);
  let state = 'idle', count = 0, active = false, appeared = null, wrongAt = null, leavingAt = null, left, timer, raf;
  const duration = () => reduced.matches ? MACOS.reduceMs : MACOS.unlockMs;
  function set(next) { state = next; screen.dataset.state = next; form.dataset.state = next; if (input) input.readOnly = next !== 'idle'; }
  function tickClock() {
    const now = date(), text = clockText(now, locale);
    day.textContent = text.date; time.textContent = text.time; time.dateTime = now.toISOString();
    clearTimeout(timer); timer = setTimeout(tickClock, 60000 - (Date.now() % 60000));
  }
  function setCount(n) {
    count = Math.max(0, Math.floor(Number(n) || 0));
    const visible = Math.min(count, 24);
    while (dots.children.length > visible) dots.lastChild.remove();
    while (dots.children.length < visible) dots.append(node('i'));
    field.dataset.typed = String(count > 0);
    // The native page may say how many; it cannot say what was typed.
    if (native) field.setAttribute('aria-label', count ? `${count} password characters` : 'Enter Password');
  }
  function render(now = clock()) {
    if (!active) return;
    const ms = now * 1000;
    if (appeared !== null) content.style.opacity = String(ease((ms - appeared) / (reduced.matches ? MACOS.reduceMs : MACOS.wakeMs)));
    if (wrongAt !== null) {
      const elapsed = ms - wrongAt;
      field.style.transform = `translateX(${shakeAt(elapsed, reduced.matches)}px)`;
      if (elapsed >= (reduced.matches ? MACOS.reduceMs : MACOS.wrongMs)) {
        wrongAt = null; field.style.transform = ''; if (input) input.value = ''; setCount(0); set('idle'); input?.focus({ preventScroll: true });
      }
    }
    if (state === 'checking') check.style.transform = `rotate(${reduced.matches ? 0 : ms * .36}deg)`;
    if (leavingAt !== null) {
      const p = ease((ms - leavingAt) / duration());
      content.style.opacity = String(1 - p);
      content.style.transform = reduced.matches ? 'none' : `scale(${1 + (MACOS.unlockScale - 1) * p})`;
      if (p === 1) { active = false; leavingAt = null; left?.(); left = null; }
    }
  }
  function loop() { render(); if (active && !native) raf = requestAnimationFrame(loop); }
  function viewport() {
    const v = globalThis.visualViewport;
    if (!v || native) return;
    screen.style.height = `${v.height}px`; screen.style.top = `${v.offsetTop}px`;
    screen.dataset.compact = String(v.height < 540);
  }
  globalThis.visualViewport?.addEventListener('resize', viewport); globalThis.visualViewport?.addEventListener('scroll', viewport);
  document.addEventListener('visibilitychange', () => { if (!document.hidden && active) tickClock(); });
  return {
    form, field, input, dots, render, setCount,
    edit(n) { wrongAt = null; field.style.transform = ''; set('idle'); setCount(n); },
    get state() { return state; },
    show({ focus = true } = {}) {
      cancelAnimationFrame(raf); active = true; wrongAt = leavingAt = null; appeared = clock() * 1000;
      screen.hidden = form.hidden = false; content.style.transform = ''; set('idle'); tickClock(); viewport(); setCount(count); render();
      if (!native) loop(); if (focus) input?.focus({ preventScroll: true });
    },
    checking() { wrongAt = null; set('checking'); },
    wrong() { wrongAt = clock() * 1000; set('wrong'); },
    open() { wrongAt = null; set('open'); },
    leave() {
      if (leavingAt !== null) return Promise.resolve();
      input?.blur(); if (input) input.value = ''; wrongAt = null; set('leaving'); leavingAt = clock() * 1000;
      return new Promise(resolve => { left = resolve; });
    },
    hide() { active = false; cancelAnimationFrame(raf); clearTimeout(timer); screen.hidden = true; form.hidden = true; },
  };
}

export function createLock({ screen, reduced, onsubmit, identity }) {
  const view = mountLock({ screen, reduced, identity }), { input, form } = view;
  // macOS's arrow submits without taking the field's keyboard focus.
  screen.querySelector('#unlock').addEventListener('pointerdown', event => event.preventDefault());
  input.addEventListener('input', () => { if (view.state === 'idle') view.setCount(input.value.length); });
  form.addEventListener('submit', event => {
    event.preventDefault();
    if (view.state !== 'idle' || screen.hidden || form.hidden) return;
    if (!input.value) { view.wrong(); return; }
    // Stay inside the submit gesture: the caller primes sound before any network await.
    onsubmit(input.value);
  });
  screen.addEventListener('click', event => { if (view.state === 'idle' && !event.target.closest('button')) input.focus({ preventScroll: true }); });
  return view;
}
