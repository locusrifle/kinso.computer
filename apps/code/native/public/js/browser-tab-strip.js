import { pinButtons } from './browser-start.js';

// Shared chrome for native, iframe and streamed tabs. Retain nodes on metadata
// updates: loading/title/agent events must not steal keyboard focus.
export function mountTabStrip({ select, close, create, visit = null }) {
  const make = (tag, cls) => { const el = document.createElement(tag); el.className = cls; return el; };
  const el = make('div', 'browser-tab-strip');
  const row = make('div', 'browser-tabs');
  row.setAttribute('role', 'tablist'); row.setAttribute('aria-label', 'Browser tabs');
  const add = make('button', 'browser-new');
  add.type = 'button'; add.textContent = '+'; add.title = 'New tab (Ctrl+T)'; add.setAttribute('aria-label', 'New tab');
  add.onclick = create;
  el.append(row, add);
  if (visit) el.append(...pinButtons(visit, true));
  const nodes = new Map();
  let tabs = [], selected = null;
  function focus(id) { nodes.get(id)?.button.focus({ preventScroll: true }); reveal(id); }
  function reveal(id) {
    const item = nodes.get(id)?.item;
    if (!item) return;
    if (item.offsetLeft < row.scrollLeft) row.scrollLeft = item.offsetLeft;
    else if (item.offsetLeft + item.offsetWidth > row.scrollLeft + row.clientWidth) row.scrollLeft = item.offsetLeft + item.offsetWidth - row.clientWidth;
  }
  function remove(id) {
    const at = tabs.findIndex(tab => tab.id === id);
    const focused = nodes.get(id)?.item.contains(document.activeElement);
    const next = tabs[at + 1]?.id ?? tabs[at - 1]?.id;
    close(id);
    if (focused && next != null) focus(nodes.has(id) ? next : selected ?? next);
    else if (focused && nodes.size) add.focus({ preventScroll: true });
  }
  function keys(event) {
    if (event.defaultPrevented) return;
    const key = event.key.toLowerCase();
    const id = [...nodes].find(([, node]) => node.item.contains(event.target))?.[0] ?? selected;
    if (event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey && ['t', 'w'].includes(key)) {
      event.preventDefault(); event.stopPropagation();
      if (key === 't') create(); else if (id != null) remove(id);
      return;
    }
    if (!event.target.closest('.browser-tab-item') || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
    const at = tabs.findIndex(tab => tab.id === id);
    let next;
    if (key === 'arrowright') next = tabs[(at + 1) % tabs.length];
    if (key === 'arrowleft') next = tabs[(at - 1 + tabs.length) % tabs.length];
    if (key === 'home') next = tabs[0];
    if (key === 'end') next = tabs.at(-1);
    if (key === 'delete') { event.preventDefault(); event.stopPropagation(); remove(id); }
    if (next) { event.preventDefault(); event.stopPropagation(); select(next.id); focus(next.id); }
  }
  el.addEventListener('keydown', keys);
  row.addEventListener('wheel', event => {
    if (row.scrollWidth <= row.clientWidth) return;
    event.preventDefault(); event.stopPropagation();
    row.scrollLeft += (Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY) * (event.deltaMode ? 32 : 1);
  }, { passive: false });
  function paint(list) {
    tabs = list;
    const focusId = [...nodes].find(([, node]) => node.item.contains(document.activeElement))?.[0];
    const previous = selected;
    // A connected scoped browser may have owner tabs but no watched page.
    // Keyboard reachability is not selection: Ctrl+W in its address/body
    // must not close an unseen background arrival.
    selected = tabs.find(tab => tab.front)?.id ?? null;
    const roving = selected ?? tabs[0]?.id;
    const kept = new Set(tabs.map(tab => tab.id));
    for (const [id, node] of nodes) if (!kept.has(id)) { node.item.remove(); nodes.delete(id); }
    for (const [index, tab] of tabs.entries()) {
      let node = nodes.get(tab.id);
      if (!node) {
        const item = make('div', 'browser-tab-item');
        const button = make('button', 'browser-tab'); button.type = 'button'; button.setAttribute('role', 'tab'); button.dataset.tab = tab.id;
        const icon = make('span', 'browser-tab-icon'); icon.setAttribute('aria-hidden', 'true');
        const title = make('span', 'browser-tab-title');
        const state = make('span', 'browser-tab-state'); state.setAttribute('aria-hidden', 'true');
        const x = make('button', 'browser-tab-close'); x.type = 'button'; x.textContent = '×'; x.tabIndex = -1;
        button.append(icon, title, state); item.append(button, x);
        button.onclick = () => select(tab.id);
        x.onclick = event => { event.stopPropagation(); remove(tab.id); };
        item.addEventListener('mousedown', event => { if (event.button === 1) event.preventDefault(); });
        item.addEventListener('auxclick', event => { if (event.button === 1) { event.preventDefault(); event.stopPropagation(); remove(tab.id); } });
        node = { item, button, icon, title, state, x, favicon: null }; nodes.set(tab.id, node);
      }
      const title = tab.url === 'about:blank' ? 'New tab' : (tab.title || tab.label || tab.url || 'New tab').replace(/\.html?$/i, '');
      node.title.textContent = title;
      node.button.title = `${title}${tab.url && tab.url !== 'about:blank' ? `\n${tab.url}` : ''}${tab.driving ? '\nAgent is using this tab' : ''}${tab.loading ? '\nLoading' : ''}${tab.unread ? '\nUpdated' : ''}`;
      node.button.setAttribute('aria-label', `${title}${tab.driving ? ', agent is using this tab' : ''}${tab.loading ? ', loading' : ''}${tab.unread ? ', updated' : ''}`);
      node.button.setAttribute('aria-selected', String(tab.id === selected));
      node.button.tabIndex = tab.id === roving ? 0 : -1;
      node.x.setAttribute('aria-label', `Close ${title}`); node.x.title = `Close ${title}`;
      node.item.classList.toggle('front', tab.id === selected);
      for (const [cls, value] of [['front', tab.id === selected], ['driven', tab.driving], ['loading', tab.loading], ['unread', tab.unread]]) node.button.classList.toggle(cls, Boolean(value));
      const initial = title === 'New tab' ? '·' : title[0]?.toUpperCase() || '·';
      const favicon = /^(https?:|data:image\/)/i.test(tab.favicon || '') ? tab.favicon : '';
      if (node.favicon !== favicon) {
        node.favicon = favicon; node.icon.replaceChildren();
        if (favicon) {
          const image = document.createElement('img'); image.alt = ''; image.referrerPolicy = 'no-referrer'; image.src = favicon;
          image.onerror = () => {
            if (node.favicon !== favicon || node.icon.firstChild !== image) return;
            const title = node.title.textContent;
            node.icon.textContent = title === 'New tab' ? '·' : title[0]?.toUpperCase() || '·';
          };
          node.icon.append(image);
        } else node.icon.textContent = initial;
      } else if (!favicon) node.icon.textContent = initial;
      // append only when out of order; moving a focused button loses focus.
      if (row.children[index] !== node.item) row.insertBefore(node.item, row.children[index] || null);
    }
    if (focusId != null) {
      const next = nodes.has(focusId) ? focusId : roving;
      if (next != null && !nodes.get(next)?.item.contains(document.activeElement)) focus(next);
      else if (next == null) add.focus({ preventScroll: true });
    }
    if (selected !== previous) reveal(selected);
  }
  return { el, paint, keys };
}
