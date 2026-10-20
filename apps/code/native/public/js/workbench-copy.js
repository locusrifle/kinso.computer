// Text onto the OS clipboard, with a fallback for WebViews without the
// Clipboard API.
export async function copyText(text, doc = document) {
  function fallback() {
    const active = doc.activeElement;
    const field = doc.createElement('textarea');
    field.value = text;
    // Focus is needed for old WebViews to copy, not to summon a keyboard.
    field.readOnly = true;
    field.setAttribute('aria-label', 'Copy');
    field.style.cssText = 'position:fixed;left:-10000px;top:0;font-size:16px';
    doc.body.append(field);
    field.focus({ preventScroll: true });
    field.select();
    field.setSelectionRange(0, text.length);
    try {
      if (!doc.execCommand('copy')) throw new Error('Clipboard access was refused');
    } finally {
      field.remove();
      active?.focus({ preventScroll: true });
    }
  }
  const clipboard = doc.defaultView?.navigator.clipboard;
  if (!clipboard?.writeText) { fallback(); return; }
  try { await clipboard.writeText(text); }
  catch { fallback(); }
}

// The OS clipboard holds literal paths, never image bytes or peer URLs.
export function copyPaths(paths, doc = document) { return copyText(paths.join('\n'), doc); }

// Delegated so grid/list repainting needs no per-row timers. Never capture a
// pointer or prevent its motion: scrolling and the phone's back swipe stay native.
export function holdToCopy(items, onHold, { delay = 500 } = {}) {
  const doc = items.ownerDocument;
  let pending, timer, suppressed;
  const pointers = new Set();
  const cancel = () => { clearTimeout(timer); pending = null; };
  doc.addEventListener('pointerdown', event => {
    pointers.add(event.pointerId);
    cancel();
    if (pointers.size !== 1 || event.button !== 0) return;
    const row = event.target.closest?.('.workbench-item');
    if (!row || !items.contains(row) || items.hidden) return;
    suppressed = null;
    pending = { row, id: event.pointerId, x: event.clientX, y: event.clientY };
    timer = setTimeout(() => {
      const hold = pending;
      pending = null;
      if (!hold || !hold.row.isConnected || items.hidden || !hold.row.getClientRects().length) return;
      suppressed = { row: hold.row, until: Infinity };
      onHold([...items.children].indexOf(hold.row));
    }, delay);
  }, true);
  doc.addEventListener('pointermove', event => {
    if (pending && (Math.hypot(event.clientX - pending.x, event.clientY - pending.y) > 10)) cancel();
  }, true);
  const release = event => {
    pointers.delete(event.pointerId);
    cancel();
    if (suppressed) suppressed.until = Date.now() + 1000;
  };
  doc.addEventListener('pointerup', release, true);
  doc.addEventListener('pointercancel', release, true);
  doc.addEventListener('scroll', cancel, true);
  doc.addEventListener('visibilitychange', cancel);
  doc.defaultView.addEventListener('blur', () => { cancel(); pointers.clear(); });
  for (const kind of ['click', 'dblclick', 'contextmenu']) items.addEventListener(kind, event => {
    // Touch context menus can precede the hold timer; don't let an image's
    // native save popup steal the gesture. Desktop right-click is unchanged.
    if (kind === 'contextmenu' && pending && pending.row.contains(event.target)) {
      event.preventDefault(); event.stopImmediatePropagation(); return;
    }
    if (suppressed && Date.now() <= suppressed.until && suppressed.row.contains(event.target)) {
      event.preventDefault(); event.stopImmediatePropagation();
    }
  }, true);
  return cancel;
}
