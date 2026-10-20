// The Mac shell owns window chrome, not the computer document inside it.
import { runGenie } from '../macos/genie.mjs?v=sequoia-4';
import { variant } from '../variant.mjs?v=kinso-lift-2';
export const WINDOW_DEFAULT = Object.freeze({ x: 160, y: 25, width: 1280, height: 796 });
export const DESKTOP_BAND = Object.freeze({ x: 0, y: 25, width: 1600, height: 796 });
const geometryStyle = ({ x, y, width, height }) => ({ left: `${x}px`, top: `${y}px`, width: `${width}px`, height: `${height}px` });
// A CSS-only miniature uses the real window's aspect ratio, never its iframe DOM.
export function thumbnailGeometry(width, height) {
  const scale = Math.min(58 / width, 48 / height);
  return { width: width * scale, height: height * scale, scale };
}
// The Dock, and the app the Mac's main window is (variant.mjs: imperfect, or Kinso on kinso.computer).
const APPS = variant.dock, APP = variant.app, NAME = variant.name;
let icons = {};
const iconURL = id => icons[id] ?? new URL(`./icons/dock-${id === 'trash' ? 'trash-empty' : id}.webp`, import.meta.url).href;
let activeShell;
export function openShellWindow(options) {
  if (!activeShell) throw new Error('Call initShell before opening a Mac window');
  return activeShell.open(options);
}
export const getShellWindow = id => activeShell?.windows.get(id);
export const setTrash = items => activeShell?.setTrash(items);
export const markDockConsumed = (id, consumed = true) => activeShell?.markDockConsumed(id, consumed);
// An app's Dock icon drawn by the page (Kinso's, once its logo has loaded: for-kinso/brand.mjs).
export const setDockIcon = (id, url) => activeShell?.setIcon(id, url);
export function frameDragAllowed(event, frame, base = globalThis.location?.href) {
  if (!frame || event.source !== frame.contentWindow || event.data?.type !== 'imperfect:window-drag') return false;
  let url;
  try { url = new URL(frame.getAttribute('src') || '', base); } catch { return false; }
  return Boolean(frame.getAttribute('src')) && ['https:', 'http:'].includes(url.protocol)
    && event.origin === url.origin && ['start', 'move', 'end'].includes(event.data.phase)
    && Number.isFinite(event.data.x) && Number.isFinite(event.data.y)
    && Math.abs(event.data.x) < 100000 && Math.abs(event.data.y) < 100000;
}
const ABOUT = {
  imperfect: '<div class="shell-about"><h1>imperfect</h1><p>A computer of your own.</p><p class="shell-muted">imperfect.computer</p></div>',
  kinso: '<div class="shell-about kinso-about"><h1>Kinso Computer</h1><p>Your agents and your inbox, in one window.</p><p class="shell-muted">A concept by Noah Fleming</p></div>',
};
const svg = (body, viewBox = '0 0 20 20') => `<svg viewBox="${viewBox}" aria-hidden="true">${body}</svg>`;
const symbols = {
  apple: svg('<path d="M12.15 6.9c-.95 0-2.42-1.08-3.96-1.04-2.04.03-3.91 1.18-4.96 3.01-2.12 3.68-.55 9.11 1.52 12.09 1.01 1.46 2.21 3.09 3.79 3.04 1.52-.06 2.09-.99 3.94-.99 1.83 0 2.35.99 3.96.95 1.63-.03 2.67-1.48 3.67-2.95 1.16-1.69 1.64-3.32 1.67-3.41-.04-.02-3.19-1.22-3.22-4.86-.03-3.04 2.48-4.5 2.6-4.56-1.43-2.09-3.63-2.32-4.4-2.38-2-.15-3.67 1.1-4.61 1.1zM15.53 3.83c.84-1.01 1.4-2.43 1.24-3.83-1.2.05-2.66.8-3.53 1.82-.78.89-1.45 2.34-1.27 3.71 1.34.11 2.71-.69 3.56-1.7"/>', '0 0 24 24'),
  wifi: svg('<g fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M2 7a12 12 0 0 1 16 0M5 10a8 8 0 0 1 10 0M8 13a3 3 0 0 1 4 0"/></g><circle cx="10" cy="16" r="1.2"/>'),
  battery: svg('<rect x="1" y="4" width="21" height="11" rx="3" fill="none" stroke="currentColor" opacity=".6"/><rect x="3" y="6" width="15" height="7" rx="1.3"/><path d="M24 7v5" stroke="currentColor" stroke-width="2"/>', '0 0 26 20'),
  spotlight: svg('<circle cx="8" cy="8" r="5" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="m12 12 5 5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>'),
  control: svg('<g stroke="currentColor" fill="none" stroke-width="1.2"><rect x="2" y="3" width="16" height="5" rx="2.5"/><rect x="2" y="12" width="16" height="5" rx="2.5"/></g><circle cx="6" cy="5.5" r="1.6"/><circle cx="14" cy="14.5" r="1.6"/>'),
  siri: '<span class="shell-siri-orb"></span>',
};
const make = (tag, className, text) => {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text != null) el.textContent = text;
  return el;
};
export function initShell({ stage, appWindow, window: windowElement, frame, dock, icons: drawn = {} }) {
  if (activeShell?.stage === stage) return activeShell;
  icons = { ...drawn };
  appWindow ||= windowElement;
  if (!stage || !appWindow || !frame) throw new Error('Mac shell needs stage, appWindow and frame');
  const windows = new Map();
  let focused = null, z = 20, currentMenu = null, currentTrigger = null, trashItems = [], frameDrag = null;
  const reduced = () => globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  const scale = () => stage.getBoundingClientRect().width / 1600 || 1;
  const point = (x, y) => { const r = stage.getBoundingClientRect(); return { x: (x - r.left) / scale(), y: (y - r.top) / scale() }; };
  const rect = el => { const r = el.getBoundingClientRect(), p = point(r.left, r.top); return { ...p, width: r.width / scale(), height: r.height / scale() }; };
  const clamp = (n, min, max) => Math.max(min, Math.min(max, n));
  const place = (win, x, y) => {
    win.element.style.left = `${clamp(x, 70 - win.element.offsetWidth, 1530)}px`;
    win.element.style.top = `${clamp(y, 25, 765)}px`;
  };
  function focus(win) {
    for (const item of windows.values()) item.element.dataset.focused = String(item === win);
    focused = win;
    if (win) win.element.style.zIndex = String(++z);
    appMenu.textContent = win?.appName || 'Finder';
    appMenu.classList.toggle('is-main-app', appMenu.textContent === NAME);
  }
  function closeMenu() {
    currentMenu?.remove(); currentMenu = null;
    currentTrigger?.setAttribute('aria-expanded', 'false'); currentTrigger?.classList.remove('is-open'); currentTrigger = null;
  }
  function chrome(element, win) {
    element.querySelector(':scope > .mac-lights')?.remove();
    const lights = make('div', 'mac-lights shell-lights'); lights.setAttribute('aria-label', 'Window controls');
    for (const [action, label, glyph] of [['close', 'Close', '×'], ['minimize', 'Minimize', '−'], ['zoom', 'Zoom', '↗']]) {
      const button = make('button', `shell-light shell-light-${action}`, glyph);
      button.type = 'button'; button.setAttribute('aria-label', `${label} ${win.title}`);
      if (action === 'zoom') button.innerHTML = '<svg viewBox="0 0 10 10" aria-hidden="true"><path d="M5 1H9V5ZM1 5V9H5Z"/></svg>';
      button.addEventListener('pointerdown', e => e.stopPropagation());
      button.addEventListener('click', e => { e.stopPropagation(); win[action](); closeMenu(); });
      lights.append(button);
    }
    element.append(lights);
  }
  function makeThumbnail(win, main) {
    const slot = make('div', 'dock-slot shell-thumbnail-slot'); slot.dataset.windowThumbnail = win.id;
    const button = make('button', 'dock-icon shell-thumbnail-button'); button.type = 'button';
    button.setAttribute('aria-label', `Restore ${win.title}`);
    const r = rect(win.element), size = thumbnailGeometry(r.width, r.height);
    const viewport = make('div', 'shell-miniature-viewport');
    Object.assign(viewport.style, { width: `${size.width}px`, height: `${size.height}px` });
    viewport.setAttribute('aria-hidden', 'true');
    const preview = make('div', 'shell-miniature');
    preview.dataset.kind = main ? 'product' : 'managed';
    Object.assign(preview.style, { width: `${r.width}px`, height: `${r.height}px`, transform: `scale(${size.scale})` });
    const header = make('div', 'shell-miniature-header');
    const lights = make('div', 'shell-miniature-lights');
    for (let i = 0; i < 3; i++) lights.append(make('i'));
    header.append(lights, make('span', '', win.title));
    const content = make('div', 'shell-miniature-content');
    content.append(make('div', 'shell-miniature-sidebar'), make('div', 'shell-miniature-card'), make('div', 'shell-miniature-browser'));
    preview.append(header, content); viewport.append(preview);
    if (win.preview) { content.replaceChildren(win.preview()); preview.classList.add('shell-miniature-custom'); }
    const icon = make('img', 'shell-thumbnail-app'); icon.src = win.icon || iconURL(main ? APP : win.appName === 'Finder' ? 'finder' : 'safari'); icon.alt = ''; icon.draggable = false;
    button.append(viewport, icon); button.addEventListener('click', () => win.restore());
    const label = make('span', 'shell-dock-label', win.title); label.setAttribute('aria-hidden', 'true');
    slot.append(button, label); dock.insertBefore(slot, dock.querySelector('[data-app="trash"]'));
    win.thumbnail = slot;
    return viewport;
  }
  function register(element, { id, title, appName = title, main = false, icon, preview, capture }) {
    const win = { id, element, title, appName, icon, preview, capture, settled: Promise.resolve(), body: null, thumbnail: null, zoomed: false, state: 'open', generation: 0 };
    element.classList.add('shell-window'); element.dataset.windowId = id; element.dataset.windowState = 'open';
    element.setAttribute('role', 'region'); element.setAttribute('aria-label', title);
    let oldRect, animation;
    // Cancel only our animation: the narrated phone beat temporarily transforms
    // the main window, and owns that transform and its exact saved position.
    const clearAnimation = () => { win.generation++; animation?.cancel(); animation = null; };
    const removeThumbnail = () => { win.thumbnail?.remove(); win.thumbnail = null; };
    function animateWindow(from, tile, restore, done, enabled = true) {
      const generation = win.generation;
      if (!enabled) { done?.(); win.settled = Promise.resolve(); return; }
      animation = runGenie({ element, stage, from, tile, restore, reduced: reduced(), preview: win.thumbnail?.querySelector('.shell-miniature'), capture: win.capture });
      win.settled = animation.finished.then(ok => { if (ok && generation === win.generation) { animation = null; done?.(); } });
    }
    win.focus = () => { if (win.state !== 'open') return win.restore(); focus(win); return win; };
    win.close = () => {
      clearAnimation(); removeThumbnail(); win.state = 'closed'; element.dataset.windowState = 'closed';
      element.setAttribute('aria-hidden', 'true'); element.inert = true;
      if (focused === win) focusNext(); return win;
    };
    win.restore = () => {
      const from = win.state === 'minimized' && win.thumbnail ? rect(win.thumbnail.querySelector('.shell-miniature-viewport')) : null;
      const closed = win.state === 'closed';
      clearAnimation();
      if (main && closed) {
        Object.assign(element.style, geometryStyle(WINDOW_DEFAULT));
        win.zoomed = false; element.dataset.zoomed = 'false'; oldRect = null;
      }
      win.state = 'open'; element.dataset.windowState = 'open'; element.removeAttribute('aria-hidden'); element.inert = false;
      focus(win);
      if (from) {
        win.thumbnail.style.opacity = '0';
        animateWindow(rect(element), from, true, removeThumbnail);
      } else removeThumbnail();
      return win;
    };
    win.minimize = ({ animate = true } = {}) => {
      if (win.state !== 'open') return win;
      clearAnimation();
      const r = rect(element), target = makeThumbnail(win, main), d = rect(target);
      win.state = 'minimized'; element.inert = true; element.dataset.windowState = 'minimizing';
      win.thumbnail.style.opacity = '0';
      animateWindow(r, d, false, () => {
        element.dataset.windowState = 'minimized'; element.setAttribute('aria-hidden', 'true');
        if (win.thumbnail) win.thumbnail.style.opacity = '';
      }, animate);
      if (focused === win) focusNext(); return win;
    };
    win.zoom = () => {
      win.restore();
      if (!win.zoomed) {
        oldRect = { left: element.style.left, top: element.style.top, width: element.style.width, height: element.style.height };
        Object.assign(element.style, geometryStyle(DESKTOP_BAND));
      } else Object.assign(element.style, oldRect);
      win.zoomed = !win.zoomed; element.dataset.zoomed = String(win.zoomed); return win;
    };
    function focusNext() { focus([...windows.values()].filter(w => w !== win && w.state === 'open').sort((a, b) => +b.element.style.zIndex - +a.element.style.zIndex)[0] || null); }
    element.addEventListener('pointerdown', () => focus(win), true);
    windows.set(id, win); chrome(element, win); return win;
  }
  function dragHandle(handle, win) {
    let drag;
    handle.addEventListener('pointerdown', e => {
      if (e.button !== 0 || e.target.closest('button,input,a,select,textarea,[contenteditable]')) return;
      const p = point(e.clientX, e.clientY); drag = { x: p.x, y: p.y, left: win.element.offsetLeft, top: win.element.offsetTop };
      handle.setPointerCapture(e.pointerId); win.focus(); e.preventDefault();
    });
    handle.addEventListener('pointermove', e => {
      if (!drag) return;
      const p = point(e.clientX, e.clientY); place(win, drag.left + p.x - drag.x, drag.top + p.y - drag.y);
    });
    for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) handle.addEventListener(type, () => { drag = null; });
    handle.addEventListener('dblclick', e => { if (!e.target.closest('button,input,a')) win.zoom(); });
  }
  function open({ id, title, content, className = '', width = 820, height = 570, x = 390, y = 130, appName = title, icon, preview, capture }) {
    if (windows.has(id)) return windows.get(id).restore();
    const element = make('section', `shell-managed ${className}`);
    Object.assign(element.style, { left: `${x}px`, top: `${y}px`, width: `${width}px`, height: `${height}px` });
    const header = make('header', 'shell-titlebar', title); element.append(header);
    const body = make('div', 'shell-body');
    if (typeof content === 'string') body.innerHTML = content; else if (content) body.append(content);
    element.append(body); stage.append(element);
    const win = register(element, { id, title, appName, icon, preview, capture }); win.body = body;
    dragHandle(header, win); win.focus(); return win;
  }
  const oldBar = stage.querySelector('.mac-bar');
  const bar = make('header', 'mac-bar shell-bar'); bar.setAttribute('aria-label', 'Mac menu bar');
  const menuSide = make('nav', 'shell-menu-side'); menuSide.setAttribute('aria-label', 'Application menus');
  const statusSide = make('div', 'shell-status-side'); bar.append(menuSide, statusSide);
  oldBar?.replaceWith(bar); if (!oldBar) stage.append(bar);
  const appMenu = make('button', 'shell-menu-trigger shell-app-menu is-main-app', NAME);
  function trigger(parent, label, key, html) {
    const button = key === 'app' ? appMenu : make('button', `shell-menu-trigger shell-menu-${key}`, label);
    button.type = 'button'; button.dataset.menu = key; button.setAttribute('aria-haspopup', 'menu'); button.setAttribute('aria-expanded', 'false');
    if (html) { button.innerHTML = html; button.setAttribute('aria-label', label); }
    button.addEventListener('click', () => { if (currentTrigger === button) closeMenu(); else showMenu(button, key); });
    button.addEventListener('pointerenter', () => { if (currentMenu && currentTrigger !== button) showMenu(button, key); });
    parent.append(button); return button;
  }
  trigger(menuSide, 'Apple', 'apple', symbols.apple);
  trigger(menuSide, NAME, 'app');
  for (const name of ['File', 'Edit', 'View', 'Window', 'Help', variant.menu.last].filter(Boolean)) trigger(menuSide, name, name.toLowerCase());
  for (const [key, label] of [['control', 'Control Centre'], ['wifi', 'Wi-Fi'], ['battery', 'Battery'], ['spotlight', 'Spotlight'], ['siri', 'Siri']]) trigger(statusSide, label, key, symbols[key]);
  const clock = trigger(statusSide, '', 'clock'); clock.classList.add('mac-clock');
  const tick = () => { const date = new Date(); clock.textContent = new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric' }).format(date).replace(',', '') + '  ' + new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit' }).format(date); clock.setAttribute('aria-label', date.toLocaleString()); };
  tick(); const clockTimer = setInterval(tick, 15000); clockTimer.unref?.();
  dock ||= stage.querySelector('.mac-dock') || make('nav', 'mac-dock');
  if (!dock.parentNode) stage.append(dock);
  dock.id = 'dock'; dock.classList.add('shell-dock'); dock.removeAttribute('aria-hidden'); dock.setAttribute('aria-label', 'Dock'); dock.replaceChildren();
  for (const [id, name] of APPS) {
    if (id === 'trash') dock.append(make('div', 'shell-dock-divider'));
    const slot = make('div', 'dock-slot mac-tile'); slot.dataset.app = id;
    if (id === 'trash') slot.id = 'trash';
    const button = make('button', 'dock-icon'); button.type = 'button'; button.setAttribute('aria-label', name);
    const img = make('img'); img.src = iconURL(id); img.alt = ''; img.draggable = false; button.append(img);
    const label = make('span', 'shell-dock-label', name); label.setAttribute('aria-hidden', 'true'); slot.append(button, label);
    if (id === 'finder' || id === APP) slot.append(make('i', 'mac-run'));
    button.addEventListener('click', () => {
      bounce(button);
      if (id === APP) windows.get('imperfect').restore();
      else if (id === 'trash') openTrash();
      else if (id === 'finder') openFinder();
    });
    dock.append(slot);
  }
  function bounce(button) { if (!reduced() && button.animate) button.animate([{ translate: '0 0' }, { translate: '0 -24px', offset: .35 }, { translate: '0 0', offset: .65 }, { translate: '0 -9px', offset: .83 }, { translate: '0 0' }], { duration: 650, easing: 'ease-out' }); }
  // Init runs behind the film, possibly display:none: use native points rather
  // than a zero DOMRect. Never write transform (the phone beat owns it).
  Object.assign(appWindow.style, geometryStyle(WINDOW_DEFAULT));
  const main = register(appWindow, { id: 'imperfect', title: NAME, appName: NAME, main: true });
  // No overlay over the product's buttons. Only the product knows its empty topbar.
  globalThis.addEventListener('message', event => {
    if (!frameDragAllowed(event, frame)) return;
    const { phase, x, y } = event.data;
    if (phase === 'start' && main.state === 'open') {
      const r = rect(frame); frameDrag = { x: r.x + x, y: r.y + y, left: appWindow.offsetLeft, top: appWindow.offsetTop };
      main.focus(); closeMenu();
    } else if (phase === 'move' && frameDrag && main.state === 'open') {
      const r = rect(frame); place(main, frameDrag.left + r.x + x - frameDrag.x, frameDrag.top + r.y + y - frameDrag.y);
    } else if (phase === 'end') frameDrag = null;
  });
  // Cross-origin pointer events cannot bubble, but browser focus still identifies the iframe.
  globalThis.addEventListener('blur', () => setTimeout(() => { if (document.activeElement === frame && main.state === 'open') { main.focus(); closeMenu(); } }, 0));
  frame.addEventListener('focus', () => { if (main.state === 'open') main.focus(); });
  stage.addEventListener('pointerdown', e => { if (!e.target.closest('.shell-window,.shell-bar,.shell-dock,.shell-menu,.shell-popover')) { focus(null); closeMenu(); } });
  document.addEventListener('pointerdown', e => { if (currentMenu && !currentMenu.contains(e.target) && !bar.contains(e.target)) closeMenu(); }, true);
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') closeMenu();
    if (!currentMenu) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      const items = [...currentMenu.querySelectorAll('button:not(:disabled),input')];
      const at = items.indexOf(document.activeElement), delta = e.key === 'ArrowDown' ? 1 : -1;
      items[(at + delta + items.length) % items.length]?.focus(); e.preventDefault();
    }
  });
  function about() {
    const body = make('div', 'shell-about');
    body.innerHTML = `${symbols.apple}<h1>MacBook Air</h1><p>macOS Sequoia</p><p class="shell-muted">Version 15.8.1</p><div class="shell-about-divider"></div><p>A Mac, with ${NAME}.</p><p class="shell-muted">This desktop is a website, not your operating system.</p>`;
    return open({ id: 'about', title: 'About This Mac', content: body, width: 330, height: 390, x: 635, y: 210, appName: 'Finder', className: 'shell-about-window' });
  }
  const doShop = () => stage.dispatchEvent(new CustomEvent('mac:shop', { bubbles: true }));
  function menuRows(key) {
    const app = focused?.appName || 'Finder', win = focused;
    const row = (label, shortcut, action, disabled = false) => ({ label, shortcut, action, disabled });
    const separator = null;
    if (key === 'apple') return [row('About This Mac', '', about), separator, row('System Settings…'), row('App Store…'), separator, row('Recent Items', '›'), separator, row('Force Quit…', '⌥⌘⎋'), separator, row('Sleep', '', null, true), row('Restart…', '', null, true), row('Shut Down…', '', null, true), separator, row('Lock Screen', '⌃⌘Q', null, true), row('Log Out…', '⇧⌘Q', null, true)];
    if (key === 'app') return [row(`About ${app}`, '', app === 'Finder' ? about : () => open({ id: `about-${APP}`, title: `About ${NAME}`, appName: NAME, width: 350, height: 290, x: 625, y: 260, content: ABOUT[APP] })), separator, row('Settings…', '⌘,'), separator, row('Services', '›'), separator, row(`Hide ${app}`, '⌘H', () => win?.close(), !win), row('Hide Others', '⌥⌘H', () => { for (const w of windows.values()) if (w !== win) w.close(); }), row('Show All', '', () => { for (const w of windows.values()) w.restore(); }), separator, row(`Quit ${app}`, '⌘Q', () => win?.close(), !win)];
    if (key === 'file') return [row('New Window', '⌘N', app === 'Finder' ? openFinder : undefined), row('New Tab', '⌘T', null, true), row('Open…', '⌘O', null, true), separator, row('Close Window', '⌘W', () => win?.close(), !win)];
    if (key === 'edit') return [row('Undo', '⌘Z', null, true), row('Redo', '⇧⌘Z', null, true), separator, row('Cut', '⌘X', null, true), row('Copy', '⌘C', null, true), row('Paste', '⌘V', null, true), row('Select All', '⌘A', null, true), separator, row('AutoFill', '›'), row('Start Dictation…'), row('Emoji & Symbols', '⌃⌘Space')];
    if (key === 'view') return [row('as Icons', '⌘1'), row('as List', '⌘2'), row('as Columns', '⌘3'), row('as Gallery', '⌘4'), separator, row('Show Tab Bar', '⇧⌘T'), row('Show Sidebar', '⌃⌘S'), separator, row('Enter Full Screen', '⌃⌘F', () => win?.zoom(), !win)];
    if (key === 'window') return [row('Minimize', '⌘M', () => win?.minimize(), !win), row('Zoom', '', () => win?.zoom(), !win), row('Move & Resize', '›'), row('Tile Window', '›'), separator, row('Bring All to Front', '', () => { for (const w of windows.values()) if (w.state === 'open') w.focus(); }), separator, ...[...windows.values()].map(w => row(`${w === win ? '✓  ' : '    '}${w.title}`, '', () => w.restore()))];
    if (key === 'help') return [row(`${app} Help`), row(variant.menu.help, '', doShop)];
    if (key === 'shop') return [row('Shop imperfect…', '', doShop)];
    return [];
  }
  function showMenu(button, key) {
    closeMenu(); currentTrigger = button; button.setAttribute('aria-expanded', 'true'); button.classList.add('is-open');
    const popover = ['control', 'wifi', 'battery', 'spotlight', 'siri', 'clock'].includes(key);
    const panel = make('div', popover ? `shell-popover shell-popover-${key}` : 'shell-menu');
    panel.setAttribute('role', popover ? 'dialog' : 'menu'); panel.setAttribute('aria-label', button.getAttribute('aria-label') || button.textContent);
    if (popover) populatePopover(panel, key);
    else for (const item of menuRows(key)) {
      if (!item) { panel.append(make('div', 'shell-menu-separator')); continue; }
      const el = make('button', 'shell-menu-item'); el.type = 'button'; el.setAttribute('role', 'menuitem'); el.disabled = item.disabled;
      el.append(make('span', '', item.label), make('span', 'shell-shortcut', item.shortcut || ''));
      el.addEventListener('click', () => { closeMenu(); item.action?.(); }); panel.append(el);
    }
    stage.append(panel); currentMenu = panel;
    const r = rect(button), width = panel.offsetWidth;
    panel.style.left = `${clamp(popover ? r.x + r.width - width : r.x, 6, 1594 - width)}px`;
    panel.style.top = '24px';
    if (key === 'spotlight') panel.querySelector('input')?.focus();
  }
  function populatePopover(panel, key) {
    if (key === 'battery') {
      panel.innerHTML = '<div class="shell-pop-heading"><strong>Battery</strong><span>87%</span></div><p>Power Source: Power Adapter</p><div class="shell-menu-separator"></div><p class="shell-muted">Battery Settings…</p>'; return;
    }
    if (key === 'wifi') {
      panel.innerHTML = '<div class="shell-pop-heading"><strong>Wi-Fi</strong><button class="shell-switch" aria-label="Wi-Fi" aria-pressed="true"></button></div><div class="shell-menu-separator"></div><small>Known Network</small><div class="shell-network">✓ &nbsp; Wi-Fi connected <span>⌁</span></div><div class="shell-menu-separator"></div><p>Other Networks &nbsp; ›</p><p class="shell-muted">Network controls belong to your computer.</p>'; wireSwitches(panel); return;
    }
    if (key === 'control') {
      panel.innerHTML = '<div class="shell-control-grid"><div class="shell-control-tile"><p>◉ &nbsp; Wi-Fi <small>Connected</small></p><p>ᛒ &nbsp; Bluetooth <small>On</small></p><p>◎ &nbsp; AirDrop <small>Contacts Only</small></p></div><div class="shell-control-tile"><p>☾ &nbsp; Focus</p><div class="shell-menu-separator"></div><p>▣ &nbsp; Screen Mirroring</p></div></div><div class="shell-control-tile"><label>Display <input type="range" min="10" max="100" value="80" aria-label="Display brightness (preview)"></label></div><div class="shell-control-tile"><label>Sound <input type="range" min="0" max="100" value="65" aria-label="Sound volume (preview)"></label></div><div class="shell-control-tile shell-media"><span>♫</span><div>Music<small>Not Playing</small></div><button aria-label="Play" disabled>▶</button></div>'; return;
    }
    if (key === 'spotlight') {
      panel.innerHTML = `<div class="shell-search">${symbols.spotlight}<input aria-label="Spotlight Search" placeholder="Spotlight Search" autocomplete="off"></div><div class="shell-search-results"></div>`;
      const input = panel.querySelector('input'), results = panel.querySelector('.shell-search-results');
      input.addEventListener('input', () => {
        results.replaceChildren(); const query = input.value.trim().toLowerCase(); if (!query) return;
        for (const [id, name] of APPS.filter(([, name]) => name.toLowerCase().includes(query))) {
          const item = make('button', 'shell-search-result', name); item.type = 'button';
          item.addEventListener('click', () => { closeMenu(); dock.querySelector(`[data-app="${id}"] button`)?.click(); }); results.append(item);
        }
      }); return;
    }
    if (key === 'siri') { panel.innerHTML = `${symbols.siri}<strong>Siri</strong><p class="shell-muted">Siri is not available in this website.</p>`; return; }
    const now = new Date(), first = new Date(now.getFullYear(), now.getMonth(), 1).getDay(), last = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
    panel.innerHTML = `<strong>${now.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })}</strong><h3>${now.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}</h3>`;
    const calendar = make('div', 'shell-calendar');
    for (const day of ['S', 'M', 'T', 'W', 'T', 'F', 'S']) calendar.append(make('small', '', day));
    for (let day = 1 - first; day <= last; day++) calendar.append(make('span', day === now.getDate() ? 'is-today' : '', day < 1 ? '' : day));
    panel.append(calendar);
  }
  function wireSwitches(panel) { for (const button of panel.querySelectorAll('.shell-switch')) button.addEventListener('click', () => button.setAttribute('aria-pressed', String(button.getAttribute('aria-pressed') !== 'true'))); }
  function finderContent(isTrash) {
    const root = make('div', 'shell-finder');
    const sidebar = make('aside', 'shell-finder-sidebar');
    sidebar.innerHTML = '<small>Favourites</small><p>◷ &nbsp; Recents</p><p>▧ &nbsp; Applications</p><p>▱ &nbsp; Desktop</p><p>▤ &nbsp; Documents</p><p>↓ &nbsp; Downloads</p><small>Locations</small><p>▣ &nbsp; This Mac</p>';
    const main = make('div', 'shell-finder-main'), toolbar = make('div', 'shell-finder-toolbar');
    toolbar.append(make('span', '', '‹   ›'), make('strong', '', isTrash ? 'Trash' : 'Finder'));
    if (isTrash) {
      const empty = make('button', 'shell-empty-trash', 'Empty'); empty.type = 'button'; empty.disabled = trashItems.length === 0;
      empty.addEventListener('click', () => setTrashLocal([])); toolbar.append(empty);
    }
    const grid = make('div', 'shell-finder-grid');
    const items = isTrash ? trashItems : [];
    if (!items.length) grid.append(make('p', 'shell-finder-empty', isTrash ? 'Trash is empty' : `Your files live in ${NAME}.`));
    for (const item of items) {
      const id = typeof item === 'string' ? item : item.id;
      const name = (typeof item === 'object' && item.name) || APPS.find(([key]) => key === id)?.[1] || id;
      const tile = make('div', 'shell-finder-item'), img = make('img'); img.src = iconURL(id); img.alt = ''; tile.append(img, make('span', '', `${name}.app`)); grid.append(tile);
    }
    main.append(toolbar, grid, make('footer', 'shell-finder-footer', `${items.length} item${items.length === 1 ? '' : 's'}`)); root.append(sidebar, main); return root;
  }
  function openTrash() { return open({ id: 'trash', title: 'Trash', appName: 'Finder', content: finderContent(true), className: 'shell-finder-window', width: 780, height: 510, x: 470, y: 170 }); }
  function openFinder() { return open({ id: 'finder', title: 'Finder', appName: 'Finder', content: finderContent(false), className: 'shell-finder-window', width: 780, height: 510, x: 420, y: 150 }); }
  function setTrashLocal(items) {
    trashItems = Array.isArray(items) ? [...items] : [];
    const img = dock.querySelector('[data-app="trash"] img');
    img.src = new URL(`./icons/dock-trash-${trashItems.length ? 'full' : 'empty'}.webp`, import.meta.url).href;
    dock.querySelector('[data-app="trash"]').dataset.full = String(trashItems.length > 0);
    const win = windows.get('trash'); if (win) win.body.replaceChildren(finderContent(true));
  }
  function consume(id, consumed = true) { const slot = dock.querySelector(`[data-app="${id}"]`); if (slot) slot.dataset.consumed = String(consumed); }
  function setIcon(id, url) {
    icons[id] = url;
    const img = dock.querySelector(`[data-app="${id}"] img`); if (img) img.src = url;
    if (id === APP) main.icon = url;
  }
  activeShell = { stage, windows, open, setTrash: setTrashLocal, markDockConsumed: consume, setIcon, main, focus, closeMenu, openTrash, openFinder };
  main.focus(); return activeShell;
}
