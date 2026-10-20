// A second view of the SAME authenticated computer, not a second ticket or session.
// Its native phone viewport is inert; the desktop document never leaves its window.
import { demoAddress, isDemoReady } from '../media.mjs';

export function createPhone({ stage, appWindow, device, frame, reduced }) {
  let address = null, verified = false, ready = false, loads = 0, played = false, showing = false, returned = false;
  let generation = 0, controller = null, savedTransform = null;
  const fallback = device.querySelector('.phone-unavailable'), clock = device.querySelector('.phone-clock');
  function paintReady(on) {
    ready = on; device.dataset.ready = String(on);
    frame.setAttribute('aria-hidden', String(!on)); frame.inert = true;
    fallback.hidden = on;
  }
  function prepare(origin) {
    if (reduced.matches || frame.getAttribute('src')) return;
    const candidate = new URL('/?face=code&launch=phone', demoAddress(origin));
    address = candidate; loads = 0; paintReady(false);
    // Park transparent inside the stage, rather than display:none/offscreen:
    // the product must get its real paint frames while the film covers it.
    device.hidden = false; device.dataset.shown = 'false'; device.setAttribute('aria-hidden', 'true');
    // The primary ticket has already established the origin's HttpOnly cookie.
    // A normal same-origin navigation reuses it; never ask the store for a ticket.
    frame.src = address.href;
  }
  frame.addEventListener('load', () => {
    if (!frame.getAttribute('src')) return;
    if (++loads > 1) { verified = false; paintReady(false); }
  });
  frame.addEventListener('error', () => { verified = false; paintReady(false); });
  addEventListener('message', event => {
    if (!address || event.source !== frame.contentWindow || event.origin !== address.origin) return;
    if (isDemoReady(event, frame, address, 'imperfect:demo-ready')) {
      verified = true;
      frame.contentWindow.postMessage({ type: 'imperfect:assemble', step: 'done' }, address.origin);
    } else if (verified && event.data?.type === 'imperfect:assembled' && event.data.step === 'done') paintReady(true);
  });
  const wait = (ms, signal) => new Promise(resolve => {
    const done = () => { clearTimeout(timer); signal.removeEventListener('abort', done); resolve(); };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
    if (signal.aborted) done();
  });
  function tell(phase) {
    stage.dispatchEvent(new CustomEvent('imperfect:phone', { bubbles: true, detail: { phase, at: performance.now(), ready } }));
  }
  function reset() {
    ++generation; controller?.abort(); controller = null;
    if (savedTransform !== null) { appWindow.style.transform = savedTransform; savedTransform = null; }
    appWindow.classList.remove('phone-travel'); device.classList.remove('phone-moving');
    device.dataset.shown = 'false'; device.hidden = !address; device.setAttribute('aria-hidden', 'true'); showing = false;
  }
  async function exhibit(spoken) {
    if (!spoken) { reset(); return; }
    if (reduced.matches) return;
    reset(); const mine = generation, aborter = new AbortController(); controller = aborter;
    const signal = aborter.signal;
    played = true; returned = false;
    savedTransform = appWindow.style.transform;
    clock.textContent = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date());
    device.hidden = false; device.dataset.shown = 'enter'; device.setAttribute('aria-hidden', 'false'); device.inert = true;
    void device.offsetWidth;
    appWindow.classList.add('phone-travel'); device.classList.add('phone-moving');
    const original = savedTransform && savedTransform !== 'none' ? savedTransform + ' ' : '';
    appWindow.style.transform = original + 'translateX(-320px)'; device.dataset.shown = 'true';
    await wait(600, signal);
    if (signal.aborted || mine !== generation) return;
    showing = true; tell('shown');
    await Promise.race([spoken.done, new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }))]);
    await wait(1000, signal);
    if (signal.aborted || mine !== generation) return;
    appWindow.style.transform = savedTransform; device.dataset.shown = 'exit';
    await wait(600, signal);
    if (signal.aborted || mine !== generation) return;
    returned = true; showing = false; appWindow.classList.remove('phone-travel'); savedTransform = null;
    device.classList.remove('phone-moving'); device.dataset.shown = 'false'; device.setAttribute('aria-hidden', 'true'); controller = null;
    tell('returned');
  }
  return { prepare, exhibit, reset, state: () => ({ loaded: Boolean(frame.getAttribute('src')), verified, ready, played, showing, returned }) };
}
