import { config } from './launch-config.mjs?v=kinso-lift-2';
import { demoAddress, isDemoReady, waitForMedia, primeVideo, playVideo, firstVideoFrame, fadeDuration, preloadDue } from './media.mjs';
import { createFilmLayer } from './film.mjs?v=plain-1';
import { remembered, unlock } from './lock.mjs?v=sequoia-4';
import { createLock } from './macos/lock.mjs?v=kinso-lift-2';
import { MACOS, animate, ease } from './macos/timings.mjs?v=sequoia-4';
import { createMacLaunch } from './macos/launch.mjs?v=kinso-lift-2';
import { createMac } from './mac/desktop.mjs?v=kinso-1';
import { initShell, getShellWindow, setTrash, setDockIcon } from './mac/shell.mjs?v=kinso-lift-2';
import { initShop } from './shop.mjs?v=kinso-1';
import { createPhone } from './mac/phone.mjs?v=clone-3';
import { variant } from './variant.mjs?v=kinso-lift-2';
// kinso.computer is this page made for Kinso (variant.mjs); what differs there is loaded only there (for-kinso/).
const kinso = variant.id === 'kinso' ? await import('./for-kinso/site.mjs?v=kinso-lift-2') : null;
const $ = id => document.getElementById(id);
const video = $('film'), frame = $('computer'), reduced = matchMedia('(prefers-reduced-motion: reduce)');
const introScreen = $('introScreen'), filmScreen = $('filmScreen'), demoScreen = $('demoScreen');
const lockScreen = $('lockScreen'), hint = $('hint'), announce = $('announce');
const layer = createFilmLayer({ video, canvas: $('filmCanvas'), screen: filmScreen, area: $('filmArea') });
const kinsoIcons = kinso?.dressPage();
// Decode behind the opener, so the sheet can never reveal an unpainted photograph.
const desktopImage = new Image(); desktopImage.src = variant.wallpaper;
const desktopPaint = desktopImage.decode().catch(() => {});
// Tahlia's photograph is Apple's aerial, so the repository never holds it (.gitignore); the PC serves its copy. Where a
// copy lacks it, imperfect's night shows through underneath instead of an empty desktop.
const wallpaperImage = variant.wallpapers.map(url => `url("${url}")`).join(', ');
document.querySelector('.mac-wall').style.backgroundImage = wallpaperImage;
// Measurable behind the opener, still transparent and inert.
$('macScreen').hidden = false;
initShell({ stage: $('macScreen'), appWindow: document.querySelector('.mac-window'), frame, dock: document.querySelector('.mac-dock'),
  ...(kinsoIcons ? { icons: { [variant.app]: kinsoIcons.now.dock } } : {}) });
initShop({ open: openShop, restore: () => getShellWindow('imperfect')?.restore(), ...(variant.for ? { company: variant.for } : {}) });
const phone = createPhone({ stage: $('macScreen'), appWindow: document.querySelector('.mac-window'), device: document.querySelector('.mac-phone'), frame: $('phoneComputer'), reduced });
// On kinso.computer, a film window (Noah on camera, then the launch video) instead of QuickTime's, and the build told
// to his words (for-kinso/film.mjs, build.mjs); the build moves the film, which is made with the unlock.
let kinsoFilm = null;
const kinsoBuild = kinso?.createKinsoBuild({ stage: $('macScreen'), reduced, film: { recede: () => kinsoFilm?.recede(), intoFiles: tile => kinsoFilm?.intoFiles(tile) } }) ?? null;
const mac = createMac({ screen: $('macScreen'), curtain: $('curtain'), reduced, onstage: assemble, onfinish: finishMac, ontrash: setTrash, onphone: phone.exhibit,
  ...(kinsoBuild ? { script: kinsoBuild } : {}) });
// The old full-screen film is optional (launch-config.mjs) and only loaded if its path is taken (showFilm).
const film = Boolean(config.videoUrl);
// The archived full-screen film is only loaded if that legacy path is explicitly invoked.
const introForMac = () => intro;
const macLaunch = createMacLaunch({ stage: $('macScreen'), introScreen, intro: introForMac, mac, reduced, film: config.quicktimeFilm,
  onphase: setPhase, ondesktop: () => { if (!frame.getAttribute('src')) requestDemo(); }, onfinish: showMac,
  ...(kinso ? { wallpaperImage, player: options => (kinsoFilm = kinso.createKinsoFilm(options)) } : {}) });
let phase = 'loading', intro = null, introReady = false, openerDone = false, lockChecked = false;
let workbench = null, demo = null, unlocked = false, primed = false, skipped = false;
let generation = 0, pendingMedia = null, stallTimer = null, hintTimer = null, skyLive = false;
let demoLoaded = false, demoVerified = false, frameLoads = 0, frameAsk = 0, demoPreloadAt = null, ending = false, endingReady = false;
let lastMediaTime = 0, pausedByVisibility = false;
// The product's steps (the app's assembly.js); kinso.computer's build adds Messages before done.
const ASSEMBLY = variant.assembly;
let desiredStep = reduced.matches ? 'done' : 'bare', paintedStep = null;
const assemblyHistory = [], assemblyWaiters = new Set();
function waitForAssembly(step, ms = config.demoTimeoutMs) {
  if (demoVerified && ASSEMBLY.indexOf(paintedStep) >= ASSEMBLY.indexOf(step)) return Promise.resolve(true);
  return new Promise(resolve => {
    const waiter = { step, resolve: ok => { clearTimeout(waiter.timer); assemblyWaiters.delete(waiter); resolve(ok); } };
    waiter.timer = setTimeout(() => waiter.resolve(false), ms); assemblyWaiters.add(waiter);
  });
}
function sendAssembly() {
  if (!demoVerified || !demo) return;
  assemblyHistory.push({ step: desiredStep, sentAt: performance.now(), paintedAt: null });
  frame.contentWindow.postMessage({ type: 'imperfect:assemble', step: desiredStep, ...(variant.for ? { for: variant.for } : {}) }, demo.origin);
}
function assemble(step) {
  if (!ASSEMBLY.includes(step) || ASSEMBLY.indexOf(step) < ASSEMBLY.indexOf(desiredStep)) return Promise.resolve(false);
  desiredStep = step;
  if (paintedStep !== step) sendAssembly();
  return waitForAssembly(step);
}
async function openShop(url) {
  if (!demoVerified || paintedStep !== 'done') {
    say('The Shop will open when your computer is ready.');
    if (!await waitForAssembly('done')) { say('Your computer is not available yet. Try again, then open Shop.'); return false; }
  }
  if (!demoVerified || !demo || paintedStep !== 'done') return false;
  frame.contentWindow.postMessage({ type: 'imperfect:open', url }, demo.origin);
  say('Opening Shop in your computer’s browser.');
  return true;
}

function setPhase(next) {
  phase = next; document.body.dataset.phase = next;
  dispatchEvent(new CustomEvent('imperfect:sequence', { detail: { phase } }));
}
function say(text = '') { announce.textContent = text; }
function visible(el, on) {
  el.dataset.visible = String(on); el.setAttribute('aria-hidden', String(!on)); el.inert = !on;
}
function prompt(text = '', play = false) {
  $('status').textContent = text; $('prompt').hidden = !text;
  $('action').hidden = !play; $('action').textContent = 'Play film';
  $('retry').hidden = play || !text; $('fallback').hidden = true;
  say(text);
}
function gesture() {
  intro?.prime(); mac.prime(); macLaunch.prime();
  if (primed || !film) return;
  primed = true;
  const id = generation;
  primeVideo(video, { isCurrent: () => id === generation && !['film', 'mac', 'demo'].includes(phase) }).catch(() => { primed = false; });
}
// The opener comes first. Its first press unlocks sound; scrolling alone does not fake an activation.
for (const type of ['pointerdown', 'keydown', 'touchend']) addEventListener(type, event => {
  if (event.isTrusted && ['intro', 'contact'].includes(phase)) gesture();
}, { capture: true, passive: true });
function hideHint() { clearTimeout(hintTimer); hint.dataset.on = 'false'; }
function showHint() { if (phase === 'intro' && !intro?.state().moved) hint.dataset.on = 'true'; }
function startOpener() {
  if (!introReady || phase !== 'loading') return;
  intro.start({ auto: false });
  setPhase('intro'); say('Scroll, swipe up, or press an arrow key to bring them together.');
  if (config.scrollHint) hintTimer = setTimeout(showHint, config.hintAfterMs);
}
function showLock() {
  if (!openerDone || !lockChecked || !['loading', 'intro', 'contact'].includes(phase)) return;
  if (unlocked) { afterLock(); return; }
  setPhase('ready'); intro?.lockSky(true); lockScreen.hidden = false; lockScreen.dataset.on = 'true';
  lockScreen.dataset.sky = 'on';
  sharks?.start();
  lock.show({ focus: matchMedia('(pointer: fine)').matches }); say('Enter the password.');
}
async function liftLock() {
  const timing = config.kinsoUnlock;
  await desktopPaint;
  sharks?.cover(); introScreen.hidden = true; lockScreen.inert = true;
  lockScreen.dataset.departure = 'fade';
  if (reduced.matches) {
    await animate(MACOS.reduceMs, t => { lockScreen.style.opacity = String(1 - ease(t, timing.fadeEase)); }).finished;
  } else {
    await lock.leave({ ms: timing.fadeMs, curve: timing.fadeEase, zoom: false });
    // Give the decoded desktop two paint opportunities before any of the sea moves.
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    lockScreen.dataset.departure = 'lift';
    await animate(timing.liftMs, t => { lockScreen.style.transform = `translateY(${-100 * ease(t, timing.liftEase)}%)`; }).finished;
  }
  lock.hide(); sharks?.stop(); lockScreen.dataset.departure = 'done';
}
function leaveLock({ skip = false } = {}) {
  if (skip || lockScreen.hidden) { lock.hide(); sharks?.stop(); return; }
  if (kinso) return liftLock();
  void sharks?.fade(reduced.matches ? MACOS.reduceMs : MACOS.unlockMs);
  return lock.leave().then(() => { lock.hide(); sharks?.stop(); });
}
// Unlocked: skipped, straight to the finished computer; otherwise macOS's unlock into the Mac, the QuickTime film,
// then the build (macos/launch.mjs).
function afterLock() {
  if (skipped) { leaveLock({ skip: true }); openComputer(); }
  else macLaunch.enter({ leave: leaveLock, sheet: Boolean(kinso) });
}
const lock = createLock({ screen: lockScreen, reduced, ...(kinsoIcons ? { identity: { name: variant.lock.name, picture: kinsoIcons.now.avatar } } : {}), ...kinso?.logoLock($('wordmark'), lockScreen), onsubmit: password => {
  if (phase !== 'ready') return;
  gesture(); setPhase('unlocking'); lock.checking(); say('Checking…');
  unlock(password).then(bench => {
    if (phase !== 'unlocking') return;
    if (!bench) { setPhase('ready'); lock.wrong(); say('Wrong password.'); return; }
    opened(bench); lock.open(); afterLock();
  });
} });
// Kinso's sharks swim on its lock, behind the clock and the password (for-kinso/lock-sharks.mjs).
const sharks = kinso?.mountSharks(lockScreen, { word: $('wordmark'), backdrop: $('sky') }) ?? null;
kinsoIcons?.ready.then(drawn => {
  if (!drawn) return;
  setDockIcon(variant.app, drawn.dock);
  const avatar = lockScreen.querySelector('.macos-avatar'); if (avatar) avatar.src = drawn.avatar;
});
// Whatever computer the lock's password opens (/unlock): the site's own, told which company's site it is in (for).
function computerAddress(bench) {
  const url = demoAddress(bench.url, location.href);
  if (variant.for) url.searchParams.set('for', variant.for);
  return url;
}
function opened(bench) {
  workbench = bench; unlocked = true; demo = computerAddress(bench);
}
// kinso.computer asks for its password on every visit, reload included: a remembered unlock
// (the cookie) only renews the ticket after the password (requestDemo), never skips the lock.
if (variant.id === 'kinso') { lockChecked = true; showLock(); }
else remembered().then(bench => { lockChecked = true; if (bench) opened(bench); showLock(); });
document.addEventListener('keydown', event => {
  if (phase !== 'intro' || event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
  if (!['ArrowDown', 'ArrowUp', 'PageDown', 'PageUp', ' ', 'Spacebar', 'Enter'].includes(event.key)) return;
  if (event.target.closest?.('a, button, input, textarea, select')) return;
  event.preventDefault(); intro?.approach();
});
addEventListener('imperfect:intro', event => {
  const type = event.detail.type;
  if (type === 'move') hideHint();
  if (type === 'touch' && phase === 'intro') { hideHint(); setPhase('contact'); }
  if (type === 'complete' && ['intro', 'contact'].includes(phase)) {
    openerDone = true; skyLive = intro?.state().sky === 'webgl'; showLock();
  }
});
const FILMING = ['film-loading', 'film', 'film-paused', 'film-blocked', 'film-error'];
function backdrop(on) {
  if (on && intro && skyLive && layer.mode === 'webgl') { introScreen.hidden = false; intro.sky(true); }
  else { intro?.sky(false); introScreen.hidden = true; }
}
function clearStall() { clearTimeout(stallTimer); stallTimer = null; }
async function showFilm({ fromStart = true } = {}) {
  if (!video.getAttribute('src') && config.videoUrl) video.src = config.videoUrl;
  const id = ++generation; pendingMedia?.abort(); clearStall(); hideHint();
  pendingMedia = new AbortController(); intro?.quiet(); backdrop(skyLive);
  setPhase('film-loading'); prompt(); say('Loading the film…');
  try {
    await waitForMedia(video, { timeoutMs: config.mediaTimeoutMs, signal: pendingMedia.signal });
    if (id !== generation) return;
    video.volume = 1; video.muted = false; if (fromStart) video.currentTime = 0;
    await playVideo(video, { timeoutMs: config.mediaTimeoutMs, signal: pendingMedia.signal });
    await firstVideoFrame(video);
    if (id !== generation) return;
    layer.start(); setPhase('film'); prompt(); visible(filmScreen, true); mac.prepare();
    if (layer.mode !== 'webgl') backdrop(false);
  } catch (error) {
    if (id !== generation || error.name === 'AbortError') return;
    video.pause(); setPhase(error.name === 'NotAllowedError' ? 'film-blocked' : 'film-error');
    prompt(error.name === 'NotAllowedError' ? 'Tap to play with sound.' : 'The film is unavailable. Retry.', error.name === 'NotAllowedError');
  }
}
layer.onplain = () => { if (phase === 'film') backdrop(false); };
function watchStall() {
  if (phase !== 'film' || stallTimer !== null) return;
  stallTimer = setTimeout(() => { video.pause(); setPhase('film-error'); prompt('The film stopped loading. Retry.'); clearStall(); }, config.mediaTimeoutMs);
}
async function showMac() {
  // Without a film this is the unlock's next step: the opener's sound ends, the real product is asked for at once,
  // and the sky stays as it was under the lock until the Mac rises from under it.
  ++generation; clearStall(); hideHint(); intro?.quiet(); setPhase('mac'); prompt(); say('A Mac, with your own app being built on it.');
  if (!frame.getAttribute('src')) await requestDemo();
  // kinso.computer's build is told to Noah's words: it starts on time, and the product paints as it arrives.
  const ready = await waitForAssembly('bare', kinsoBuild ? 0 : config.demoTimeoutMs);
  await mac.reveal(); visible(filmScreen, false); backdrop(false); layer.stop();
  if (ready || kinsoBuild) mac.play();
  else { await mac.complete(); await finishMac(); }
}
// Refresh the one-minute ticket immediately before navigating. An unverified
// document is never displayed; there is no static imitation to swap in or out.
async function requestDemo() {
  const ask = ++frameAsk;
  demoVerified = demoLoaded = false; paintedStep = null; frameLoads = 0; mac.live(false); mac.present(false);
  visible(demoScreen, false);
  const bench = await remembered();
  if (ask !== frameAsk || !workbench) return;
  if (bench?.id !== workbench.id) { if (ending) mac.offline(); return; }
  workbench = bench; demo = computerAddress(bench);
  visible(demoScreen, false); demoScreen.hidden = false; frame.src = demo.href;
}
function preloadDemo() {
  if (phase !== 'film' || document.hidden || stallTimer !== null || demoPreloadAt !== null) return;
  if (!preloadDue(video, { afterS: config.preloadAfterS, aheadS: config.preloadAheadS })) return;
  demoPreloadAt = video.currentTime; requestDemo();
}
async function finishMac() {
  ending = true;
  // Slow builds may outlive the ticket; its authenticated document, not the original ticket, confirms readiness.
  if (!frame.getAttribute('src')) await requestDemo();
  mac.finish();
  endingReady = true;
  if (demoVerified && paintedStep === 'done') revealLive();
  else { mac.offline(); say('Your computer is not available yet. Try again.'); }
}
// From bare through done, this is the same real document at the same size.
// The build only adds the product's own capabilities; done enables interaction.
function presentBuild() {
  if (!demoVerified || !paintedStep) return;
  visible(demoScreen, true);
  demoScreen.inert = !endingReady;
  demoScreen.setAttribute('aria-hidden', String(!endingReady));
  mac.present(true);
}
function revealLive() {
  if (!endingReady || !demoVerified || paintedStep !== 'done') return;
  presentBuild(); mac.live(true); setPhase('demo'); say('The computer is ready.');
}
frame.addEventListener('load', () => {
  if (!frame.getAttribute('src')) return;
  if (++frameLoads > 1) { demoVerified = false; paintedStep = null; visible(demoScreen, false); mac.present(false); mac.live(false); if (ending) mac.offline(); }
  demoLoaded = true;
});
frame.addEventListener('error', () => {
  demoVerified = false; paintedStep = null; visible(demoScreen, false); mac.present(false); mac.live(false); if (ending) mac.offline();
});
addEventListener('message', event => {
  if (!demo || event.source !== frame.contentWindow || event.origin !== demo.origin) return;
  if (isDemoReady(event, frame, demo, config.demoReadyType)) {
    demoVerified = true; sendAssembly();
    if (!skipped && !reduced.matches && variant.phone) phone.prepare(demo.origin);
    return;
  }
  if (!demoVerified || event.data?.type !== 'imperfect:assembled') return;
  const step = event.data.step;
  if (!ASSEMBLY.includes(step) || ASSEMBLY.indexOf(step) > ASSEMBLY.indexOf(desiredStep) || ASSEMBLY.indexOf(step) < ASSEMBLY.indexOf(paintedStep)) return;
  paintedStep = step;
  const record = assemblyHistory.findLast(row => row.step === step && row.paintedAt === null);
  if (record) record.paintedAt = performance.now();
  for (const waiter of [...assemblyWaiters]) if (ASSEMBLY.indexOf(step) >= ASSEMBLY.indexOf(waiter.step)) waiter.resolve(true);
  presentBuild(); if (ending) revealLive();
});
// Mounting a cross-origin page must not steal the lock's keyboard focus.
let lastFocus = null;
document.addEventListener('focusin', event => { if (event.target !== frame) lastFocus = event.target; });
addEventListener('blur', () => setTimeout(() => {
  if (document.activeElement !== frame || !demoScreen.inert) return;
  if (lastFocus?.isConnected && lastFocus.getClientRects().length) lastFocus.focus({ preventScroll: true }); else frame.blur();
}));
async function openComputer() {
  macLaunch.stop(); sharks?.stop(); intro?.quiet(); intro?.suspend(); video.pause(); layer.stop();
  setPhase('mac');
  desiredStep = 'done';
  if (!frame.getAttribute('src')) await requestDemo();
  await mac.complete(); await waitForAssembly('done');
  await mac.reveal(); visible(filmScreen, false); backdrop(false);
  await finishMac();
}
$('skip').addEventListener('click', event => {
  event.preventDefault(); skipped = true;
  if (phase === 'demo') { frame.focus({ preventScroll: true }); return; }
  if (!unlocked) {
    openerDone = true; intro?.quiet(); hideHint(); showLock();
    if (phase === 'ready') $('password').focus({ preventScroll: true });
  } else openComputer();
});
$('action').addEventListener('click', () => showFilm({ fromStart: video.currentTime === 0 }));
$('retry').addEventListener('click', () => { video.load(); showFilm(); });
$('macRetry').addEventListener('click', () => requestDemo());
video.addEventListener('ended', () => { if (phase === 'film') showMac(); });
video.addEventListener('error', () => { if (!FILMING.includes(phase)) return; clearStall(); setPhase('film-error'); prompt('The film stopped loading. Retry.'); });
video.addEventListener('waiting', watchStall); video.addEventListener('stalled', watchStall);
video.addEventListener('playing', clearStall);
video.addEventListener('timeupdate', () => { if (phase !== 'film') return; if (video.currentTime > lastMediaTime) clearStall(); lastMediaTime = video.currentTime; preloadDemo(); });
document.addEventListener('visibilitychange', () => {
  if (document.hidden && ['film', 'film-loading'].includes(phase)) {
    pausedByVisibility = true; ++generation; pendingMedia?.abort(); clearStall(); video.pause(); setPhase('film-paused');
  } else if (!document.hidden && pausedByVisibility) { pausedByVisibility = false; showFilm({ fromStart: false }); }
});
function gaveUp() {
  if (introReady) return;
  openerDone = true; showLock();
}
const introTimer = setTimeout(gaveUp, config.mediaTimeoutMs);
import('./intro/intro.mjs?v=kinso-lift-2').then(async module => {
  intro = module.intro; await module.ready;
  clearTimeout(introTimer); introReady = true;
  if (openerDone) { intro.lockSky(true); return; }
  startOpener();
}).catch(() => { clearTimeout(introTimer); gaveUp(); });
window.__launch = () => ({ phase, generation, videoTime: video.currentTime, videoPaused: video.paused, demoLoaded, demoVerified, demoPreloadAt,
  skyLive, film: layer.state(), lock: { shown: !lockScreen.hidden && !$('lock').hidden, state: lock.state, unlocked, workbench: workbench?.id ?? null, sky: lockScreen.dataset.sky === 'on' },
  quicktime: macLaunch.state(), hint: hint.dataset.on === 'true', intro: intro?.state(), mac: mac.state(), phone: phone.state(), assembly: { desired: desiredStep, painted: paintedStep, history: assemblyHistory.map(row => ({ ...row })) },
  ...(kinso ? { variant: variant.id, kinso: { film: kinsoFilm?.state() ?? null, build: kinsoBuild.state(), sharks: sharks.state() } } : {}) });
window.__filmProbe = points => layer.probe(points);
function fadeTimes() { for (const [name, ms] of [['--fade', config.fadeMs], ['--handoff', config.handoffMs], ['--unlock', config.unlockMs]]) document.documentElement.style.setProperty(name, `${fadeDuration(reduced.matches, ms)}ms`); }
fadeTimes(); reduced.addEventListener('change', fadeTimes);
