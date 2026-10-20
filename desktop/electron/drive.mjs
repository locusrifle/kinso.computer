// How a page is driven for an agent's `browser` tool
// (apps/code/native/browser.mjs), shared by the person's window (main.mjs)
// and the private browser no one sees (private.mjs): real input, from the
// mouse and keyboard as far as the page can tell, and a wait for wherever
// that takes it.
import { hostname } from 'node:os';

// A private page must never load the real harness, even through MagicDNS,
// Tailscale HTTPS, a frame or a WebSocket: that could affect human sessions.
export function privateBackendAddress(address, port = 5067, ownName = hostname()) {
  try {
    const url = new URL(address);
    if (!/^(?:http|ws)s?:$/.test(url.protocol)) return false;
    if (url.port === String(port)) return true;
    const host = url.hostname.toLowerCase();
    const local = !/[.:]/.test(host) || ['127.0.0.1', '[::1]', ownName.toLowerCase()].includes(host);
    const tailnet = host.endsWith('.ts.net') || /^100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(host);
    const servicePort = url.port || (/^(?:https|wss):$/.test(url.protocol) ? '443' : '80');
    return (local || tailnet) && servicePort === '443';
  } catch { return false; }
}

export const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
// Anything that can take the page somewhere else waits for it to get there:
// to its document, not every picture and advert on it.
const arriving = new WeakSet();
export function watchArrivals(page) {
  arriving.add(page); // a new one is on its way to its first address
  page.on('did-start-navigation', ({ isMainFrame, isSameDocument }) => { if (isMainFrame && !isSameDocument) arriving.add(page); });
  for (const done of ['dom-ready', 'did-fail-load', 'did-stop-loading']) page.on(done, () => arriving.delete(page));
}
export async function settle(page) {
  await pause(250);
  for (const until = Date.now() + 15_000; arriving.has(page) && Date.now() < until;) await pause(100);
}
const KEYS = { ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right', ' ': 'Space', Esc: 'Escape', Return: 'Enter' };
function press(page, combo) {
  const parts = String(combo).split('+');
  const keyCode = KEYS[parts.at(-1)] ?? parts.at(-1);
  const modifiers = parts.slice(0, -1).map(m => ({ ctrl: 'control', cmd: 'meta', super: 'meta' })[m.toLowerCase()] ?? m.toLowerCase());
  page.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
  // What a key types (Enter in a form submits on it) comes as its own event.
  const typed = keyCode === 'Enter' ? '\r' : keyCode === 'Space' ? ' ' : keyCode.length === 1 ? keyCode : '';
  if (typed && !modifiers.some(m => ['control', 'alt', 'meta'].includes(m))) page.sendInputEvent({ type: 'char', keyCode: typed, modifiers });
  page.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
}
export const DRIVE = {
  async run(page, { code, page: theirs }) {
    // The tool's own scripts run in a world of their own; eval in the page's.
    return { value: await (theirs ? page.executeJavaScript(code, true) : page.executeJavaScriptInIsolatedWorld(1717, [{ code }], true)) };
  },
  async open(page, { url }) { page.loadURL(url).catch(() => {}); await settle(page); },
  async click(page, { x, y }) {
    const zoom = page.getZoomFactor(), at = { x: Math.round(x * zoom), y: Math.round(y * zoom) };
    page.sendInputEvent({ type: 'mouseMove', ...at });
    page.sendInputEvent({ type: 'mouseDown', ...at, button: 'left', clickCount: 1 });
    page.sendInputEvent({ type: 'mouseUp', ...at, button: 'left', clickCount: 1 });
    await settle(page);
  },
  async insert(page, { text }) { await page.insertText(text); },
  async key(page, { key }) { press(page, key); await settle(page); },
  async back(page) {
    if (!page.navigationHistory.canGoBack()) throw new Error('There is nothing to go back to');
    page.navigationHistory.goBack(); await settle(page);
  },
  async forward(page) {
    if (!page.navigationHistory.canGoForward()) throw new Error('There is nothing to go forward to');
    page.navigationHistory.goForward(); await settle(page);
  },
  // A picture of the page, small enough for a model to be handed. A tab
  // behind another is drawn all the same; a window the desktop has put out
  // of sight may draw nothing, so there is no picture to take then.
  async capture(page, { most }) {
    let image = await Promise.race([page.capturePage(), pause(5000)]);
    if (!image || image.isEmpty()) throw new Error('The window is out of sight, so the page cannot be pictured; look still reads it');
    if (image.getSize().width > 1280) image = image.resize({ width: 1280 });
    const png = image.toPNG();
    return png.length * 4 / 3 < most ? { png: png.toString('base64') } : { jpeg: image.toJPEG(80).toString('base64') };
  },
};
