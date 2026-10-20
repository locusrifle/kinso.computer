// Where the disk went: a folder as a map of blocks, each as big as what it
// holds, under the folder's list in Files (Noah's Mac design): "Space in
// noah" and what the disk has left over the map, each of the biggest a
// rounded block of its own colour with its name and size, the many small
// ones one grey block. The measure comes from the computer the files are on
// (/files/space, du four levels down); a block opens into its own map,
// measured again past that depth.
//
//   const space = mountSpace({ doc, host, ask, onOpen });
//   space.show(path)   space.hide()   space.isOpen()

// The blocks' colours, biggest first: the Mac's blue, indigo, orange, pink,
// teal and green, then three more; past those, or under a sliver of the
// whole, they share the grey block.
const COLOURS = ['blue', 'indigo', 'orange', 'pink', 'teal', 'green', 'purple', 'cyan', 'yellow'];
const SLIVER = 0.012, GAP = 3;
const DRIVE = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><rect x="2.75" y="7.25" width="18.5" height="9.5" rx="2.5"/><circle cx="17" cy="12" r="1" fill="currentColor" stroke="none"/></svg>';
const AGAIN = '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M13.25 8a5.25 5.25 0 1 1-1.54-3.71"/><path d="M13.25 2.75v3h-3"/></svg>';

// The blocks a folder is drawn as: each of the biggest its own, the rest
// (the many small, and any past the colours) together in one grey block.
export function spaceBlocks(children) {
  const sized = (children ?? []).filter(child => child.size > 0).sort((a, b) => b.size - a.size);
  const total = sized.reduce((sum, child) => sum + child.size, 0);
  const own = [], rest = [];
  for (const child of sized) (own.length < COLOURS.length && child.size >= total * SLIVER ? own : rest).push(child);
  const blocks = own.map((item, i) => ({ item, colour: COLOURS[i] }));
  if (rest.length === 1 && own.length < COLOURS.length) blocks.push({ item: rest[0], colour: COLOURS[own.length] });
  else if (rest.length) blocks.push({ item: { name: 'Other', size: rest.reduce((sum, child) => sum + child.size, 0), rest }, colour: 'other' });
  return blocks;
}

// digits: decimals past 10 (the disk's free and total, 312.4 GB of 994.7 GB)
function bytes(n, digits = 0) {
  if (!Number.isFinite(n)) return '';
  const units = ['B', 'kB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1000 && i < units.length - 1) { n /= 1000; i += 1; }
  return `${n.toFixed(n < 10 && i ? 1 : i ? digits : 0)} ${units[i]}`;
}

// Squarified treemap (Bruls, Huizing, van Wijk): rows of blocks laid along
// the short side, each row kept as square as it can be.
export function squarify(items, rect) {
  const out = [];
  let { x, y, w, h } = rect;
  const total = items.reduce((sum, item) => sum + item.size, 0);
  if (!total || w <= 0 || h <= 0) return out;
  const scale = (w * h) / total;
  const worst = (row, side) => {
    const areas = row.map(item => item.size * scale);
    const sum = areas.reduce((a, b) => a + b, 0);
    return Math.max((side * side * Math.max(...areas)) / (sum * sum), (sum * sum) / (side * side * Math.min(...areas)));
  };
  const lay = row => {
    const areas = row.map(item => item.size * scale);
    const sum = areas.reduce((a, b) => a + b, 0);
    if (w >= h) {
      const width = sum / h;
      let at = y;
      row.forEach((item, k) => { out.push({ item, x, y: at, w: width, h: areas[k] / width }); at += areas[k] / width; });
      x += width; w -= width;
    } else {
      const height = sum / w;
      let at = x;
      row.forEach((item, k) => { out.push({ item, x: at, y, w: areas[k] / height, h: height }); at += areas[k] / height; });
      y += height; h -= height;
    }
  };
  let row = [];
  for (let i = 0; i < items.length;) {
    const side = Math.min(w, h);
    if (!row.length || worst([...row, items[i]], side) <= worst(row, side)) { row.push(items[i]); i += 1; }
    else { lay(row); row = []; }
  }
  if (row.length) lay(row);
  return out;
}

export function mountSpace({ doc, host, ask, onOpen }) {
  const root = doc.createElement('section');
  root.className = 'files-space';
  root.hidden = true;
  root.innerHTML = `
    <header class="space-top">
      <button type="button" class="space-up" data-up aria-label="Out a level" title="Out a level (Backspace)">‹</button>
      <span class="space-title">${DRIVE}<span class="space-where"></span></span>
      <span class="space-free"></span>
      <button type="button" class="space-again" data-rescan aria-label="Measure again" title="Measure again">${AGAIN}</button>
    </header>
    <div class="space-map" role="tree" aria-label="Space used"></div>`;
  host.append(root);
  const map = root.querySelector('.space-map'), where = root.querySelector('.space-where'), free = root.querySelector('.space-free');
  const state = { scan: null, node: null, trail: [], turn: 0 };

  function draw() {
    const node = state.node;
    if (!node || root.hidden) return;
    const { width, height } = map.getBoundingClientRect();
    const blocks = spaceBlocks(node.children);
    const laid = squarify(blocks.map(block => ({ ...block, size: block.item.size })), { x: 0, y: 0, w: width + GAP, h: height + GAP });
    map.replaceChildren(...laid.map(({ item: { item, colour }, x, y, w, h }) => {
      const block = doc.createElement('div');
      const opens = !item.rest && !item.loose;
      block.className = `space-block space-${colour}${opens ? '' : ' space-still'}`;
      block.setAttribute('role', 'treeitem');
      block.style.cssText = `left:${x}px;top:${y}px;width:${Math.max(0, w - GAP)}px;height:${Math.max(0, h - GAP)}px`;
      if (w > 44 && h > 24) {
        const name = doc.createElement('b'); name.textContent = item.name;
        block.append(name);
        if (h > 40) { const size = doc.createElement('span'); size.textContent = bytes(item.size); block.append(size); }
      }
      const what = item.rest ? `${item.rest.length} more: ${item.rest.slice(0, 6).map(child => child.name).join(', ')}${item.rest.length > 6 ? '…' : ''}`
        : `${item.loose ? `${item.name} in ` : ''}${item.path}${item.kind === 'regenerable' ? ' · can be made again' : ''}`;
      block.title = `${what} · ${bytes(item.size)}`;
      block.setAttribute('aria-label', `${item.name}, ${bytes(item.size)}`);
      if (opens) {
        block.addEventListener('click', event => { event.stopPropagation(); enter(item); });
        block.addEventListener('dblclick', event => { event.stopPropagation(); onOpen(item.path); });
      }
      return block;
    }));
    const disk = state.scan.disk;
    where.textContent = `Space in ${node.path.split('/').filter(Boolean).pop() || '/'}`;
    where.dataset.path = node.path;
    where.title = `${node.path} · ${bytes(node.size)}. Measured${state.scan.measuredAt ? ` ${new Date(state.scan.measuredAt).toLocaleString()}` : ''}.`;
    free.textContent = disk ? `${bytes(disk.free, 1)} available of ${bytes(disk.total, 1)}` : bytes(node.size);
    root.querySelector('[data-up]').hidden = !state.trail.length && node.path === '/';
  }

  // Into a block: within what was measured, at once; past it, measured anew.
  function find(node, path) {
    if (node.path === path && !node.loose) return node;
    for (const child of node.children ?? []) if (!child.loose && (path === child.path || path.startsWith(`${child.path}/`))) return find(child, path);
    return null;
  }
  function enter(item) {
    if (item.children) { state.trail.push(state.node); state.node = item; draw(); }
    else void measure(item.path, { keepTrail: true });
  }
  function out() {
    if (state.trail.length) { state.node = state.trail.pop(); draw(); return; }
    const parent = state.node?.path.replace(/\/[^/]+$/, '') || '/';
    if (state.node && parent !== state.node.path) void measure(parent);
  }
  async function measure(path, { fresh = false, keepTrail = false } = {}) {
    const turn = ++state.turn;
    map.replaceChildren(Object.assign(doc.createElement('p'), { className: 'space-wait', textContent: `Measuring ${path.split('/').pop() || '/'}… a big folder takes a minute the first time` }));
    where.textContent = `Space in ${path.split('/').filter(Boolean).pop() || '/'}`;
    where.dataset.path = path;
    free.textContent = '';
    let scan;
    try { scan = await ask(`/files/space?path=${encodeURIComponent(path)}${fresh ? '&fresh' : ''}`); }
    catch (error) { if (turn === state.turn) map.firstChild.textContent = error.message; return; }
    if (turn !== state.turn || root.hidden) return;
    if (keepTrail && state.node) state.trail.push(state.node);
    else state.trail = [];
    state.scan = scan;
    state.node = scan.tree;
    draw();
  }

  root.querySelector('[data-up]').onclick = out;
  root.querySelector('[data-rescan]').onclick = () => { if (state.node) void measure(state.node.path, { fresh: true }); };
  new ResizeObserver(() => draw()).observe(map);

  return {
    show(path) { root.hidden = false; void measure(path); },
    hide() { root.hidden = true; state.turn += 1; },
    out,
    isOpen: () => !root.hidden,
  };
}
