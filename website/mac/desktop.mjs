// The pointer assembles the real desktop. A brief inert phone view shares its computer.
export const VOICE_RATE = .8;
export const INTRO = { text: "This is a Mac. And this is imperfect. Let's build it.", voice: 'mac/sounds/line-0.m4a', durationMs: 4720 };
export const STEPS = [
  { text: 'Drop in Claude Code.', voice: 'mac/sounds/line-1.m4a', durationMs: 1680, apps: ['claude'], build: 'claude' },
  { text: 'Then ChatGPT.', voice: 'mac/sounds/line-2.m4a', durationMs: 1840, apps: ['chatgpt'], build: 'codex' },
  { text: 'Your files.', voice: 'mac/sounds/line-3.m4a', durationMs: 1200, apps: ['finder'], build: 'files' },
  { text: 'And a browser.', voice: 'mac/sounds/line-4.m4a', durationMs: 1120, apps: ['safari'], build: 'browser' },
  { text: "And it's on your phone.", voice: 'mac/sounds/line-phone.m4a', durationMs: 1520, apps: [], phone: true },
  { text: "Now that software is one sentence away, you don't need apps other people made.", voice: 'mac/sounds/line-5.m4a', durationMs: 4720, apps: ['final-cut', 'imovie', 'notes'], trash: true },
  { text: "It's yours.", voice: 'mac/sounds/line-6.m4a', durationMs: 1120, apps: [], build: 'done' },
];
export const DROP_SOUND = 'mac/sounds/drag-to-trash.m4a';
export const SCREEN = { w: 1600, h: 900 };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const clamp = x => Math.max(0, Math.min(1, x));

// script: another build, told to its own clock instead of these lines (a company's version of the site, variant.mjs).
// It gets the same pointer, Dock and drops (play(api)), names the apps it folds in (steps), and is primed and stopped
// with the Mac.
export function createMac({ screen, curtain, reduced, onstage, onfinish, ontrash, onphone, script = null }) {
  const frame = screen.querySelector('#computer'), arrow = screen.querySelector('.mac-cursor');
  let prepared = false, revealed = false, played = false, stopped = false, finished = false;
  let step = -1, built = [], absorbed = [], trashed = [], hosted = false, live = false, x = 850, y = 450;
  let voiceCancel = null;
  const voicePlayer = new Audio(), dropPlayer = new Audio();
  voicePlayer.preload = dropPlayer.preload = 'auto';
  voicePlayer.src = INTRO.voice; dropPlayer.src = DROP_SOUND;
  voicePlayer.playbackRate = VOICE_RATE;
  function prime() {
    script?.prime?.();
    for (const audio of [voicePlayer, dropPlayer]) {
      audio.muted = true;
      audio.play().then(() => { if (played) return; audio.pause(); audio.currentTime = 0; audio.muted = false; }).catch(() => { audio.muted = false; });
    }
  }
  function fit() {
    const scale = Math.min(innerWidth / SCREEN.w, innerHeight / SCREEN.h);
    screen.style.setProperty('--scale', String(scale));
    screen.style.setProperty('--desktop-height', `${screen.dataset.lockDesktop === 'true' ? innerHeight / scale : SCREEN.h}px`);
  }
  function prepare() {
    if (prepared) return;
    prepared = true; fit(); addEventListener('resize', fit); screen.hidden = false;
  }
  async function reveal() {
    if (revealed) return;
    prepare(); revealed = true;
    screen.dataset.visible = 'true'; screen.setAttribute('aria-hidden', 'false'); screen.inert = false;
    point(850, 450);
    const ms = reduced.matches ? 0 : 1500;
    document.body.style.setProperty('--rise-ms', `${ms}ms`);
    curtain.hidden = false; document.body.dataset.curtain = 'down'; void curtain.offsetHeight;
    document.body.dataset.curtain = 'up'; await delay(ms + (ms ? 40 : 0)); curtain.hidden = true;
  }
  // loginwindow's wallpaper is already here. Its dissolve owns this entrance.
  function enter() {
    screen.dataset.lockDesktop = 'true'; prepare(); fit(); revealed = true;
    screen.dataset.visible = 'true'; screen.setAttribute('aria-hidden', 'false'); screen.inert = false;
    arrow.hidden = true;
  }
  function point(px, py) { x = px; y = py; arrow.style.translate = `${px - 4}px ${py - 4}px`; }
  function localRect(el) {
    const r = el.getBoundingClientRect(), stage = screen.getBoundingClientRect(), scale = stage.width / SCREEN.w;
    return { left: (r.left - stage.left) / scale, top: (r.top - stage.top) / scale, width: r.width / scale, height: r.height / scale };
  }
  const centre = el => { const r = localRect(el); return { x: r.left + r.width / 2, y: r.top + r.height / 2, r }; };
  const tileOf = name => screen.querySelector(`.mac-dock [data-app="${name}"]`);
  function move(tx, ty, ms, along) {
    const sx = x, sy = y;
    if (reduced.matches || stopped) { point(tx, ty); along?.(tx, ty); return Promise.resolve(); }
    return new Promise(resolve => {
      const start = performance.now();
      const tick = now => {
        const t = clamp((now - start) / ms), e = t * t * (3 - 2 * t);
        point(sx + (tx - sx) * e, sy + (ty - sy) * e); along?.(x, y);
        if (t < 1 && !stopped) requestAnimationFrame(tick); else resolve();
      };
      requestAnimationFrame(tick);
    });
  }
  // Audio's own clock drives the flight. Buffering pauses the icon too; the last
  // frame lands on ended, not on an independent approximation of the line.
  function sound(line) {
    voicePlayer.src = line.voice; voicePlayer.currentTime = 0; voicePlayer.playbackRate = VOICE_RATE; voicePlayer.muted = false;
    let over = false, failed = false, failedAt = 0, resolve, timer;
    const done = new Promise(ok => { resolve = ok; });
    const finishVoice = () => {
      if (over) return; over = true; clearTimeout(timer);
      voicePlayer.removeEventListener('ended', finishVoice); voicePlayer.removeEventListener('error', fail);
      if (voiceCancel === cancel) voiceCancel = null;
      resolve();
    };
    const fail = () => {
      if (failed || over) return; failed = true; failedAt = performance.now();
      clearTimeout(timer); timer = setTimeout(finishVoice, line.durationMs / VOICE_RATE);
    };
    const cancel = () => { voicePlayer.pause(); finishVoice(); };
    voiceCancel = cancel;
    voicePlayer.addEventListener('ended', finishVoice, { once: true }); voicePlayer.addEventListener('error', fail, { once: true });
    // A network-stalled sound is bounded; it cannot strand the desktop forever.
    timer = setTimeout(cancel, line.durationMs / VOICE_RATE + 15000);
    voicePlayer.play().catch(fail);
    return { done, get over() { return over; }, progress() { return over ? 1 : failed ? clamp((performance.now() - failedAt) / (line.durationMs / VOICE_RATE)) : clamp(voicePlayer.currentTime * 1000 / line.durationMs); } };
  }
  function build(part) {
    if (!built.includes(part)) built.push(part);
    return onstage?.(part);
  }
  function consume(tile, name, trash) {
    tile.classList.add('mac-consumed'); tile.setAttribute('aria-hidden', 'true');
    if (trash) { if (!trashed.includes(name)) trashed.push(name); ontrash?.([...trashed]); }
    else if (!absorbed.includes(name)) absorbed.push(name);
  }
  function drop(name, tile, ghost, target, part, trash) {
    if (stopped) { ghost.remove(); return; }
    point(target.x, target.y);
    // Sound and protocol send share this exact drop task. The product paints its
    // own option/pane, then acknowledges after two frames (measured by launch).
    dropPlayer.muted = false; dropPlayer.currentTime = 0; dropPlayer.play().catch(() => {});
    const painted = part ? build(part) : null;
    consume(tile, name, trash);
    const stage = screen.getBoundingClientRect(), scale = stage.width / SCREEN.w;
    screen.dispatchEvent(new CustomEvent('imperfect:drop', { bubbles: true, detail: { name, step: part ?? null, trash, x: stage.left + target.x * scale, y: stage.top + target.y * scale, at: performance.now() } }));
    ghost.animate([{ scale: '1', opacity: 1 }, { scale: '.12', opacity: 0 }], { duration: 160, easing: 'ease-in', fill: 'forwards' }).finished.finally(() => ghost.remove());
    delete screen.dataset.dragging;
    return painted;
  }
  async function pick(name) {
    const tile = tileOf(name), icon = tile?.querySelector('img');
    if (!icon) return null;
    const at = centre(icon);
    await move(at.x, at.y, Math.min(720, 220 + Math.hypot(at.x - x, at.y - y) * .65));
    if (stopped) return null;
    const ghost = icon.cloneNode(); ghost.className = 'mac-ghost';
    Object.assign(ghost.style, { left: `${at.r.left}px`, top: `${at.r.top}px`, width: `${at.r.width}px`, height: `${at.r.height}px` });
    screen.append(ghost); icon.style.visibility = 'hidden'; screen.dataset.dragging = name;
    // Close the Dock gap on pickup, not on impact: the Trash must not jump
    // sideways out from under the carried icon on the drop/sound frame.
    tile.classList.add('mac-consumed');
    const carry = (px, py) => { ghost.style.translate = `${px - at.x}px ${py - at.y}px`; };
    return { tile, ghost, carry, start: at };
  }
  function flight(held, target, spoken, from, to) {
    const sx = x, sy = y;
    return new Promise(resolve => {
      const tick = () => {
        if (stopped) { held.ghost.remove(); resolve(); return; }
        const progress = spoken.progress();
        const t = spoken.over || progress >= to || from >= to ? 1 : clamp((progress - from) / (to - from));
        const e = t * t * (3 - 2 * t);
        point(sx + (target.x - sx) * e, sy + (target.y - sy) * e - Math.sin(t * Math.PI) * 40); held.carry(x, y);
        if (t < 1) requestAnimationFrame(tick); else resolve();
      };
      requestAnimationFrame(tick);
    });
  }
  async function intoWindow(s) {
    const held = await pick(s.apps[0]); if (!held || stopped) return;
    const win = localRect(frame), target = { x: win.left + win.width * .47, y: win.top + win.height * .48 };
    const spoken = sound(s);
    await flight(held, target, spoken, 0, 1); await spoken.done;
    await drop(s.apps[0], held.tile, held.ghost, target, s.build, false);
  }
  async function toTrash(s) {
    let spoken;
    for (const [i, name] of s.apps.entries()) {
      const held = await pick(name); if (!held || stopped) return;
      if (!spoken) spoken = sound(s);
      const target = centre(tileOf('trash').querySelector('img'));
      await flight(held, target, spoken, spoken.progress(), (i + 1) / s.apps.length);
      if (i === s.apps.length - 1) await spoken.done;
      drop(name, held.tile, held.ghost, target, null, true);
    }
  }
  function finish() { finished = true; arrow.hidden = true; screen.querySelector('.mac-build-shield')?.remove(); }
  function present(on) { hosted = on; screen.dataset.hosted = String(on); if (on) screen.querySelector('.mac-offline').hidden = true; }
  function setLive(on) { live = on; screen.dataset.live = String(on); if (on) screen.querySelector('.mac-offline').hidden = true; }
  function offline() { screen.querySelector('.mac-offline').hidden = false; }
  async function complete() {
    prepare(); stopped = true; voiceCancel?.(); dropPlayer.pause(); onphone?.(null); script?.stop?.();
    for (const s of script?.steps ?? STEPS) for (const name of s.apps) { const tile = tileOf(name); if (tile) consume(tile, name, s.trash); }
    for (const ghost of screen.querySelectorAll('.mac-ghost')) ghost.remove();
    step = STEPS.length; build('done'); finish();
  }
  async function play() {
    if (played || stopped) return; played = true;
    if (reduced.matches) { await complete(); await onfinish?.(); return; }
    arrow.hidden = false; point(850, 450);
    const shield = document.createElement('div'); shield.className = 'mac-build-shield'; screen.append(shield);
    if (script) {
      await script.play({ screen, frame, arrow, point, move, localRect, centre, tileOf, pick, flight, drop, build, finish, onfinish,
        stopped: () => stopped, at: () => ({ x, y }), step: i => { step = i; } });
      return;
    }
    await build('bare'); await sound(INTRO).done;
    for (const [i, s] of STEPS.entries()) {
      if (stopped) return; step = i;
      if (s.phone) {
        if (reduced.matches) continue;
        arrow.hidden = true;
        const spoken = sound(s); await onphone?.(spoken); await spoken.done;
        if (!stopped) arrow.hidden = false;
      }
      else if (s.trash) await toTrash(s);
      else if (s.apps.length) await intoWindow(s);
      else { await sound(s).done; if (!stopped) await build(s.build); }
    }
    if (stopped) return; step = STEPS.length; await onfinish?.();
  }
  return { prime, prepare, reveal, enter, play, complete, finish, present, live: setLive, offline,
    state: () => ({ prepared, revealed, step, finished, hosted, live, built: [...built], absorbed: [...absorbed], trashed: [...trashed] }) };
}
