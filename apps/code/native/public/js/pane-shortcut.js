// Only the human pane chord crosses an isolated project's frame boundary.
// No session, browser-history or arbitrary command bridge is exposed.
// It is Alt here, a browser's modifier (pi-card.js): in the desktop window
// Electron takes the chord before the frame hears it (desktop/electron/main.mjs),
// and the page there ignores what a frame says (harness.js).
// Alt+Left and Alt+Right: the window on that side; Alt+Up and Alt+Down: the
// session before and after; Alt+Shift+B: the browser.
export function hearPaneShortcut() {
  if (window.parent === window) return;
  const steps = { ArrowLeft: ['imperfect-pane-step', -1], ArrowRight: ['imperfect-pane-step', 1], ArrowUp: ['imperfect-session-step', -1], ArrowDown: ['imperfect-session-step', 1] };
  window.addEventListener('keydown', event => {
    const browser = event.shiftKey && event.code === 'KeyB';
    if (!event.isTrusted || !event.altKey || event.ctrlKey || event.metaKey ||
        (!browser && (event.shiftKey || !steps[event.code]))) return;
    if (document.querySelector('dialog[open], [role="dialog"]:not([hidden]), [role="menu"]:not([hidden])')) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    const [type, step] = steps[event.code] ?? [];
    if (!event.repeat) window.parent.postMessage(browser ? { type: 'imperfect-browser-launch' } : { type, step }, '*');
  }, true);
}

export function withPaneShortcut(html) {
  const script = `<script>(${hearPaneShortcut.toString()})();</script>`;
  // Before the application's handlers, but after its doctype.
  return /<!doctype[^>]*>/i.test(html) ? html.replace(/<!doctype[^>]*>/i, match => match + script) : script + html;
}
