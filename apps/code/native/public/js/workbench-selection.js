// What is selected in a folder, by position: the picked items, the anchor (the
// last item clicked, where a Shift range starts) and the cursor (where the
// arrows are). Each change is a new selection; workbench-view.js paints it.
//
//   pick(selection, i, { toggle, range })   a click, Ctrl+click, Shift+click
//   step(selection, by, count, { range })   an arrow, Shift+arrow
//   all(selection, count)                   Ctrl+A

export const none = () => ({ picked: new Set(), anchor: -1, cursor: -1 });

export function pick(selection, i, { toggle = false, range = false } = {}) {
  if (i < 0) return none();
  if (range && selection.anchor >= 0) {
    const picked = toggle ? new Set(selection.picked) : new Set();
    for (let n = Math.min(selection.anchor, i); n <= Math.max(selection.anchor, i); n++) picked.add(n);
    return { picked, anchor: selection.anchor, cursor: i };
  }
  if (toggle) {
    const picked = new Set(selection.picked);
    if (picked.has(i)) picked.delete(i); else picked.add(i);
    return { picked, anchor: i, cursor: i };
  }
  return { picked: new Set([i]), anchor: i, cursor: i };
}

export function step(selection, by, count, { range = false } = {}) {
  if (!count) return selection;
  const to = selection.cursor < 0 ? 0 : Math.max(0, Math.min(count - 1, selection.cursor + by));
  return pick(selection, to, { range });
}

export function all(selection, count) {
  const at = n => (n >= 0 && n < count ? n : 0);
  return { picked: new Set(Array.from({ length: count }, (_, n) => n)), anchor: at(selection.anchor), cursor: at(selection.cursor) };
}
