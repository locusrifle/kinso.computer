// Text chosen by a drag stays in the text it began in.
//
// A browser extends a drag to wherever the pointer lands in the page, so a
// drag that went a little past the end of a line, below a message or into
// the window beside it chose every message after it and that window's words
// too (Noah: "really difficult to select text in imperfect without
// autoselecting everything"). A Mac's text view instead chooses up to the
// nearest point of its own text, as if the pointer were held at its edge.
// Here too: while the pointer is outside the text the drag began in, the
// chosen end is put back at the nearest point inside it, before the page is
// drawn, so the overreach is never seen.

export const TEXT_REGIONS = '.gui-transcript, .workbench-view-text pre, .workbench-page';

const clamp = (value, low, high) => Math.min(Math.max(value, low), high);

export function caretAt(doc, x, y) {
  const position = doc.caretPositionFromPoint?.(x, y);
  if (position?.offsetNode) return { node: position.offsetNode, offset: position.offset };
  const range = doc.caretRangeFromPoint?.(x, y);
  return range ? { node: range.startContainer, offset: range.startOffset } : null;
}

// The nearest place in `region`'s own text to (x, y): the point brought in
// to its edge, then to its text's edge (inside its padding: a window's edge
// may lie over its rim), then its middle, at that height.
export function caretInside(doc, region, x, y) {
  const box = region.getBoundingClientRect();
  const style = doc.defaultView.getComputedStyle(region);
  const left = box.left + (Number.parseFloat(style.paddingLeft) || 0);
  const right = box.right - (Number.parseFloat(style.paddingRight) || 0);
  const height = clamp(y, box.top + 1, box.bottom - 1);
  for (const across of [clamp(x, box.left + 1, box.right - 1), clamp(x, left + 1, right - 1), (left + right) / 2]) {
    const caret = caretAt(doc, across, height);
    if (caret && region.contains(caret.node)) return caret;
  }
  return null;
}

export function containChoosing(doc = document, regions = TEXT_REGIONS) {
  const view = doc.defaultView;
  let region = null;
  let last = null;
  let frame = 0;
  const stop = () => { region = null; last = null; if (frame) view.cancelAnimationFrame(frame); frame = 0; };
  doc.addEventListener('pointerdown', event => {
    stop();
    if (event.button !== 0 || !event.isPrimary || event.pointerType === 'touch' || event.detail > 1) return;
    const target = event.target instanceof view.Element ? event.target : event.target?.parentElement;
    if (!target || target.closest('button, input, textarea, select, a, [contenteditable="true"]')) return;
    region = target.closest(regions);
  }, true);
  for (const type of ['pointerup', 'pointercancel']) doc.addEventListener(type, stop, true);
  view.addEventListener('blur', stop);
  doc.addEventListener('pointermove', event => {
    if (!region || !(event.buttons & 1)) return;
    last = event;
    // After the browser's own move, before the frame is drawn.
    if (!frame) frame = view.requestAnimationFrame(keep);
  }, true);

  function keep() {
    frame = 0;
    if (!region?.isConnected || !last) return;
    const chosen = doc.getSelection();
    if (!chosen?.rangeCount || !region.contains(chosen.anchorNode)) return;
    const box = region.getBoundingClientRect();
    const { clientX: x, clientY: y } = last;
    const over = doc.elementFromPoint(x, y);
    const inside = x > box.left && x < box.right && y > box.top && y < box.bottom && region.contains(over);
    if (inside && region.contains(chosen.focusNode)) return;
    const caret = caretInside(doc, region, x, y);
    if (!caret) return;
    if (caret.node === chosen.focusNode && caret.offset === chosen.focusOffset) return;
    try { chosen.extend(caret.node, caret.offset); } catch { /* a node gone mid-drag */ }
  }
  return { stop };
}
