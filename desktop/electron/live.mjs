// Live browser pictures and input. A watch follows the front unless its first
// line pins a durable tab id. scope:'browser' lets that viewer retarget its
// own pin, never follow another viewer's front. Each page has one shared screencast, paced by the
// viewers of that page only; no viewer selects the front just by watching.
import { DRIVE } from './drive.mjs';

const QUALITY = 60;
const LARGEST = 1600;
const DRAW_EVERY = 100;
const MAX_FIELD_CONTEXT = 64 * 1024;

// draw(page) wakes a renderer out of sight; fit resizes that tab's actual
// viewport, in both headed and screenless browsers. appearance('light' or
// 'dark') is a viewer's own, said with its watch and whenever it turns
// (public/js/live.js): only a browser with no screen of its own takes it.
export function createLive({ tabs, front, toFront, launch, create = null, close = null, draw = null, fit = null, maxScale = 2, nativeScale = null, appearance = null }) {
  const watchers = new Set(), casts = new Map(), viewports = new WeakMap(), stopping = new WeakMap(), metadata = new WeakMap();
  const look = value => { if (appearance && (value === 'light' || value === 'dark')) appearance(value); };
  let followSize = null, previousFront = front(), changing = Promise.resolve(), told = '', fieldSequence = 0;
  const panelSize = size => {
    if (!size || ![size.width, size.height, size.scale].every(value => Number.isFinite(value) && value > 0)) return null;
    const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
    return { width: Math.round(clamp(size.width, 1, 1920)), height: Math.round(clamp(size.height, 1, 1920)), scale: clamp(size.scale, 1, maxScale) };
  };
  const list = () => [...tabs().values()].filter(page => !page.isDestroyed()).map(page => ({
    tab: page.id, title: page.getTitle(), url: page.getURL(), front: page.id === front(),
    favicon: metadata.get(page)?.favicon ?? '', loading: Boolean(page.isLoading?.()), driving: Boolean(metadata.get(page)?.driving),
  }));
  function observe(page) {
    if (metadata.has(page)) return;
    const state = { favicon: '', driving: false, timer: null };
    metadata.set(page, state);
    for (const event of ['page-title-updated', 'did-navigate', 'did-navigate-in-page', 'did-start-loading', 'did-stop-loading']) {
      page.on(event, () => { if (event === 'did-navigate') state.favicon = ''; void changed(); });
    }
    page.on('page-favicon-updated', (_, icons) => { state.favicon = icons?.[0] ?? ''; void changed(); });
    page.once('destroyed', () => { clearTimeout(state.timer); metadata.delete(page); void changed(); });
  }
  function driving(page) {
    if (page.isDestroyed() || tabs().get(page.id) !== page) return;
    observe(page);
    const state = metadata.get(page);
    state.driving = true;
    clearTimeout(state.timer);
    state.timer = setTimeout(() => { state.driving = false; state.timer = null; void changed(); }, 4000);
    state.timer.unref?.();
    void changed();
  }
  // A surviving pre-update browser ignores watch.tab. Mark fixed replies so
  // a new panel can refuse that old front-follow protocol instead of guessing.
  const write = (watcher, said) => { try { watcher.write(watcher.fixed ? { ...said, watching: watcher.tab, ...(watcher.browser ? { scope: 'browser' } : {}) } : said); } catch { watcher.stop(); } };
  function retarget(watcher, page) {
    bind(watcher, null);
    watcher.tab = page?.id ?? null;
    watcher.page = page ?? null;
    claim(watcher);
    write(watcher, { tabs: list() });
  }
  const surviving = excluded => [...tabs().values()].filter(page => page.id !== excluded && !page.isDestroyed());
  const target = watcher => {
    const page = tabs().get(watcher.fixed ? watcher.tab : front());
    return page && !page.isDestroyed() && (!watcher.fixed || page === watcher.page) ? page : null;
  };
  const claim = watcher => {
    if (!fit || !watcher.size) return;
    const page = target(watcher);
    if (page) viewports.set(page, watcher.size);
    if (!watcher.fixed) followSize = watcher.size;
  };
  function fail(watcher, error = 'The watched tab is closed or expired') {
    if (watcher.failed) return;
    watcher.failed = error;
    watcher.stop();
    write(watcher, { error, tab: watcher.tab, expired: true, closed: true });
  }

  // A pending frame is delivered once to each ready viewer. Chromium is
  // acknowledged only after all viewers of this cast have drawn it.
  function deliver(cast) {
    if (!cast.active || !cast.latest) return;
    for (const watcher of cast.watchers) {
      if (!target(watcher)) { if (watcher.fixed && !watcher.browser) fail(watcher); continue; }
      if (target(watcher) !== cast.page || watcher.drawing || watcher.seen === cast.latest) continue;
      watcher.drawing = true;
      watcher.seen = cast.latest;
      write(watcher, cast.latest);
    }
    if ([...cast.watchers].every(watcher => watcher.seen === cast.latest)) cast.latest = null;
  }
  function advance(cast) {
    if (!cast?.active) return;
    if (cast.latest) deliver(cast);
    if (!cast.latest && cast.unacked != null && [...cast.watchers].every(watcher => !watcher.drawing)) {
      const sessionId = cast.unacked;
      cast.unacked = null;
      cast.page.debugger.sendCommand('Page.screencastFrameAck', { sessionId }).catch(() => {});
    }
  }
  function drawn(watcher) {
    watcher.drawing = false;
    advance(watcher.cast);
  }
  function bind(watcher, cast) {
    if (watcher.cast === cast) return;
    const old = watcher.cast;
    old?.watchers.delete(watcher);
    watcher.cast = cast;
    watcher.drawing = false;
    watcher.seen = null;
    advance(old);
    if (!cast) return;
    cast.watchers.add(watcher);
    // A still page may never produce another frame. New viewers see the last
    // immediately, without sending the same picture to existing viewers.
    if (cast.last && !cast.latest) cast.latest = cast.last;
    deliver(cast);
  }
  function stopCast(cast) {
    if (!cast.active) return cast.stopping;
    cast.active = false;
    casts.delete(cast.page);
    for (const watcher of [...cast.watchers]) bind(watcher, null);
    cast.latest = cast.last = cast.unacked = null;
    cast.stopping = cast.stop();
    stopping.set(cast.page, cast.stopping);
    return cast.stopping;
  }
  const biggest = members => {
    let width = 0, height = 0;
    for (const watcher of members) { width = Math.max(width, watcher.width); height = Math.max(height, watcher.height); }
    return { width: Math.min(LARGEST, width || LARGEST), height: Math.min(LARGEST, height || LARGEST) };
  };
  async function start(page, members, fitted) {
    await stopping.get(page);
    if (!members.some(watcher => watchers.has(watcher) && target(watcher) === page)) return;
    const debug = page.debugger, mine = !debug.isAttached();
    const cast = { page, active: true, watchers: new Set(), latest: null, last: null, unacked: null, viewport: JSON.stringify(fitted) };
    let awake, restore, drawing = false;
    const heard = (_, method, params) => {
      if (method !== 'Page.screencastFrame' || !cast.active || casts.get(page) !== cast) return;
      if (page.isDestroyed() || tabs().get(page.id) !== page) { void changed(); return; }
      const { deviceWidth: width, deviceHeight: height } = params.metadata ?? {};
      cast.latest = cast.last = { frame: params.data, tab: page.id, width, height, ...(fit && fitted ? { size: fitted } : {}) };
      cast.unacked = params.sessionId;
      deliver(cast);
    };
    cast.stop = async () => {
      clearInterval(awake);
      debug.off('message', heard);
      await Promise.resolve().then(() => debug.sendCommand('Page.stopScreencast')).catch(() => {});
      if (typeof restore === 'function') await restore();
      if (mine && debug.isAttached()) try { debug.detach(); } catch { /* gone */ }
    };
    casts.set(page, cast);
    try {
      if (mine) debug.attach('1.3');
      if (fit && fitted) restore = await fit(page, fitted);
      // A fit may have awaited a destroyed tab or disconnected viewer.
      const remaining = members.filter(watcher => watchers.has(watcher) && target(watcher) === page);
      if (!remaining.length) { await stopCast(cast); return; }
      debug.on('message', heard);
      for (const watcher of remaining) bind(watcher, cast);
      const wake = () => {
        if (drawing || !cast.active) return;
        drawing = true;
        Promise.resolve().then(() => { if (cast.active) return draw(page); }).catch(() => {}).finally(() => { drawing = false; });
      };
      awake = draw && setInterval(wake, DRAW_EVERY);
      if (draw) wake();
      const scale = nativeScale ? nativeScale(page) : fitted?.scale;
      const size = fit && fitted ? { width: Math.round(fitted.width * scale), height: Math.round(fitted.height * scale) } : biggest(remaining);
      await debug.sendCommand('Page.startScreencast', { format: 'jpeg', quality: QUALITY, maxWidth: size.width, maxHeight: size.height, everyNthFrame: 1 });
    } catch (error) {
      await stopCast(cast);
      for (const watcher of members) {
        if (!watchers.has(watcher)) continue;
        if (watcher.fixed) fail(watcher, `The watched tab cannot be shown: ${error.message}`);
        else write(watcher, { error: `The tab cannot be shown: ${error.message}` });
      }
    }
  }
  function changed() {
    if (front() !== previousFront) {
      previousFront = front();
      const page = tabs().get(previousFront);
      if (fit && followSize && page && [...watchers].some(watcher => !watcher.fixed)) viewports.set(page, followSize);
    }
    // Remove obsolete bindings synchronously: a closed/changed target must
    // never deliver another frame while an asynchronous cast stop is pending.
    for (const watcher of [...watchers]) {
      const page = target(watcher);
      if (!page && watcher.browser && watcher.tab != null) {
        const remaining = surviving(watcher.tab);
        retarget(watcher, remaining.find(page => page.id === front()) ?? remaining[0]);
      } else if (!page && watcher.fixed && !watcher.browser) fail(watcher);
      else if (watcher.cast && watcher.cast.page !== page) bind(watcher, null);
    }
    changing = changing.then(update, update);
    return changing;
  }
  async function update() {
    const now = JSON.stringify(list());
    if (now !== told) {
      told = now;
      for (const watcher of watchers) write(watcher, { tabs: JSON.parse(now) });
    }
    const wanted = new Map();
    for (const watcher of [...watchers]) {
      const page = target(watcher);
      if (!page) { if (watcher.fixed && !watcher.browser) fail(watcher); continue; }
      if (!wanted.has(page)) wanted.set(page, []);
      wanted.get(page).push(watcher);
    }
    for (const cast of [...casts.values()]) {
      const members = wanted.get(cast.page);
      if (!members || (fit && cast.viewport !== JSON.stringify(viewports.get(cast.page) ?? null))) await stopCast(cast);
    }
    for (const [page, members] of wanted) {
      const cast = casts.get(page);
      if (cast) { for (const watcher of members) if (watchers.has(watcher) && target(watcher) === page) bind(watcher, cast); }
      else await start(page, members, viewports.get(page) ?? null);
    }
  }

  const point = (said, page) => {
    const viewport = fit && viewports.get(page);
    const scale = nativeScale ? nativeScale(page) : viewport?.scale;
    return {
      x: Math.round((Number(said.x) || 0) * (viewport && said.page?.width > 0 ? viewport.width * scale / said.page.width : 1)),
      y: Math.round((Number(said.y) || 0) * (viewport && said.page?.height > 0 ? viewport.height * scale / said.page.height : 1)),
    };
  };
  async function act(said, watcher) {
    if (watcher.browser && ['front', 'new', 'close'].includes(said.do)) {
      if (said.do === 'new') {
        if (!create) throw new Error('This window cannot create a tab');
        const created = await create();
        const page = tabs().get(created?.id ?? created);
        if (!page || page.isDestroyed()) throw new Error('The new tab is unavailable');
        retarget(watcher, page);
      } else {
        const id = said.tab, page = tabs().get(id);
        if (!Number.isSafeInteger(id) || id <= 0 || !page || page.isDestroyed()) throw new Error('That tab is closed');
        if (said.do === 'front') {
          retarget(watcher, page);
          toFront(id);
        } else {
          if (!close) throw new Error('This window cannot close a tab');
          // Native windows remove guests asynchronously. Unbind before close
          // and choose a survivor excluding it, never a closing last picture.
          const remaining = surviving(id), index = surviving().indexOf(page);
          if (watcher.page === page) retarget(watcher, remaining[Math.min(index, remaining.length - 1)]);
          await close(id);
        }
      }
      return changed();
    }
    if (watcher.fixed) {
      if (!target(watcher)) {
        if (watcher.browser) throw new Error('No tab is open');
        fail(watcher); return;
      }
      if (said.do === 'launch') throw new Error('A fixed watch cannot launch a browser');
      if (['new', 'close'].includes(said.do)) throw new Error('A fixed watch cannot create or close tabs');
      if (Number(said.tab) !== watcher.tab) throw new Error('This watch is fixed to another tab');
      // Selecting the watched tab is harmless, but never changes portal front.
      if (said.do === 'front') return;
    } else {
      if (said.do === 'launch') {
        if (!launch) throw new Error('This window cannot launch a browser');
        await launch();
        return changed();
      }
      if (said.do === 'new') {
        if (!create) throw new Error('This window cannot create a tab');
        await create();
        return changed();
      }
      if (said.do === 'close') {
        const id = said.tab, page = tabs().get(id);
        if (!Number.isSafeInteger(id) || id <= 0 || !page || page.isDestroyed()) throw new Error('That tab is closed');
        if (!close) throw new Error('This window cannot close a tab');
        await close(id);
        return changed();
      }
      if (said.do === 'front') {
        const id = Number(said.tab), page = tabs().get(id);
        if (!page || page.isDestroyed()) throw new Error('That tab is closed');
        toFront(id);
        if (fit && followSize) viewports.set(page, followSize);
        return changed();
      }
    }
    const page = target(watcher);
    if (!page) throw new Error('No tab is open');
    if (Number(said.tab) !== page.id) throw new Error('The tab in front changed; look again');
    switch (said.do) {
      case 'tap': {
        const at = point(said, page);
        // Native guest input needs focus, but only a human tap may grant it.
        page.focus?.();
        // CDP targets the guest's CSS viewport even when its embedding
        // window is elsewhere; native mouse events use the host surface.
        const zoom = page.getZoomFactor(), css = { x: at.x / zoom, y: at.y / zoom };
        await page.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', ...css });
        await page.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', ...css, button: 'left', clickCount: 1 });
        await page.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', ...css, button: 'left', clickCount: 1 });
        return focused(page, watcher, said.gesture);
      }
      case 'scroll': {
        const zoom = page.getZoomFactor(), at = point(said, page);
        await page.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseWheel', x: at.x / zoom, y: at.y / zoom, deltaX: Number(said.dx) || 0, deltaY: Number(said.dy) || 0 });
        return;
      }
      case 'edit': {
        if (typeof said.field !== 'string' || said.field !== watcher.field) throw new Error('The page field changed; tap it again');
        const valid = await DRIVE.run(page, { code: `(() => {
          const held = globalThis.__imperfectLiveField;
          let node = document.activeElement;
          while (node?.shadowRoot?.activeElement) node = node.shadowRoot.activeElement;
          if (!held || held.token !== ${JSON.stringify(said.field)} || held.node !== node || !node.isConnected || node.disabled || node.readOnly) return false;
          if (${Number.isSafeInteger(said.start) && Number.isSafeInteger(said.end) && said.start >= 0 && said.end >= said.start}) {
            if (typeof node.selectionStart !== 'number') return false;
            node.setSelectionRange(${Number.isSafeInteger(said.start) ? said.start : 0}, ${Number.isSafeInteger(said.end) ? said.end : 0});
          }
          return true;
        })()` });
        if (!valid.value) throw new Error('The page field changed; tap it again');
        if (said.key) await editKey(page, String(said.key));
        else if (said.text) await DRIVE.insert(page, { text: String(said.text) });
        else if (said.start !== said.end) await editKey(page, 'Backspace');
        return;
      }
      case 'type':
        if (said.text) await DRIVE.insert(page, { text: String(said.text) });
        if (said.enter) await DRIVE.key(page, { key: 'Enter' });
        return focused(page, watcher);
      case 'key': await DRIVE.key(page, { key: String(said.key) }); return focused(page, watcher);
      case 'back': return DRIVE.back(page);
      case 'forward': return DRIVE.forward(page);
      case 'reload': page.reload(); return;
      case 'navigate': {
        const url = String(said.url ?? '');
        if (url !== 'about:blank' && !/^https?:\/\//i.test(url)) throw new Error('Use a web address');
        await page.loadURL(url);
        return changed();
      }
      default: throw new Error(`The live browser does not know how to ${said.do}`);
    }
  }
  async function editKey(page, combo) {
    const shifted = combo.startsWith('Shift+'), key = shifted ? combo.slice(6) : combo;
    const codes = { Backspace: 8, Tab: 9, Enter: 13, Escape: 27, End: 35, Home: 36, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Delete: 46 };
    if (!Object.hasOwn(codes, key)) throw new Error('Unsupported website key');
    const event = { key, code: key, windowsVirtualKeyCode: codes[key], modifiers: shifted ? 8 : 0 };
    await page.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...event });
    if (key === 'Enter') await page.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'char', ...event, text: '\r', unmodifiedText: '\r' });
    await page.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', ...event });
  }
  async function focused(page, watcher, gesture) {
    await new Promise(resolve => setTimeout(resolve, 40));
    if (!watchers.has(watcher) || target(watcher) !== page) return;
    // Only a human page tap creates a keyboard capability. Never send an
    // existing password value, and never keep field contents on the backend.
    if (!Number.isSafeInteger(gesture)) return;
    const token = `${page.id}:${gesture}:${++fieldSequence}`;
    const field = await DRIVE.run(page, { code: `(() => {
      let node = document.activeElement;
      while (node?.shadowRoot?.activeElement) node = node.shadowRoot.activeElement;
      const kind = node?.type ?? '';
      const editable = Boolean(node && !node.disabled && !node.readOnly &&
        (node.isContentEditable || node.tagName === 'TEXTAREA' ||
         (node.tagName === 'INPUT' && /^(text|search|url|tel|email|password|number)$/.test(kind))));
      const mirror = editable && kind !== 'password' && typeof node.selectionStart === 'number' && node.value.length <= ${MAX_FIELD_CONTEXT};
      globalThis.__imperfectLiveField = editable ? { node, token: ${JSON.stringify(token)} } : null;
      return { editable, kind, multiline: node?.tagName === 'TEXTAREA' || Boolean(node?.isContentEditable),
        token: editable ? ${JSON.stringify(token)} : null, mirror,
        ...(mirror ? { value: node.value, start: node.selectionStart, end: node.selectionEnd } : {}) };
    })()` }).then(got => got.value, () => ({ editable: false }));
    watcher.field = field?.token ?? null;
    if (watchers.has(watcher) && target(watcher) === page) write(watcher, { field, gesture });
  }

  return {
    changed, observe, driving,
    watch({ width, height, size, tab, scope, resume, appearance: seen } = {}, send) {
      const fixed = tab !== undefined, browser = scope === 'browser';
      look(seen);
      const watcher = {
        write: send, fixed, browser, tab, page: fixed ? tabs().get(tab) : null, cast: null, drawing: false, seen: null, size: panelSize(size), failed: null,
        width: Math.max(1, Math.round(Number(width) || LARGEST)), height: Math.max(1, Math.round(Number(height) || LARGEST)),
        stop() {
          if (!watchers.delete(watcher)) return;
          const cast = watcher.cast;
          bind(watcher, null);
          if (cast && !cast.watchers.size) void stopCast(cast);
          if (!watchers.size) told = '';
          void changed();
        },
        async hear(said) {
          if (!watchers.has(watcher)) return;
          if (said?.ack) return drawn(watcher);
          if (said?.appearance !== undefined) {
            look(said.appearance);
            if (!said.do && !said.size) return;
          }
          try {
            let size;
            if (said?.size && fit) {
              size = panelSize(said.size);
              if (!size) return;
            }
            if (said?.do && !['front', 'launch', 'new', 'close', 'tap', 'scroll', 'type', 'edit', 'key', 'back', 'forward', 'reload', 'navigate'].includes(said.do)) throw new Error(`The live browser does not know how to ${said.do}`);
            if (said?.do === 'navigate') {
              let url;
              try { url = new URL(said.url); } catch { throw new Error('Use a web address'); }
              if (said.url !== 'about:blank' && !/^https?:$/.test(url.protocol)) throw new Error('Use a web address');
            }
            // Validate input before storing or claiming size, so a rejected
            // fixed action cannot resize this page now or on its next input.
            if (watcher.fixed && said?.do === 'launch') throw new Error('A fixed watch cannot launch a browser');
            if (watcher.fixed && !watcher.browser && ['new', 'close'].includes(said?.do)) throw new Error('A fixed watch cannot create or close tabs');
            const lifecycle = watcher.browser && ['front', 'new', 'close'].includes(said?.do);
            if (lifecycle && said.do !== 'new') {
              const page = tabs().get(said.tab);
              if (!Number.isSafeInteger(said.tab) || said.tab <= 0 || !page || page.isDestroyed()) throw new Error('That tab is closed');
            }
            if (watcher.fixed && said?.do && !lifecycle && (watcher.browser ? !Number.isSafeInteger(said.tab) || said.tab !== watcher.tab : Number(said.tab) !== watcher.tab)) throw new Error('This watch is fixed to another tab');
            if (watcher.fixed && !watcher.browser && !target(watcher)) { fail(watcher); return; }
            if (watcher.browser && said?.do && !lifecycle && !target(watcher)) throw new Error('No tab is open');
            if (size) watcher.size = size;
            claim(watcher);
            await changed();
            if (!watchers.has(watcher) || (said?.size && !said.do)) return;
            // Input must stay in human order, including an asynchronous tap
            // focus reply followed by composition, paste or rapid deletion.
            const action = (watcher.actions ?? Promise.resolve()).then(() => {
              if (watchers.has(watcher)) return act(said ?? {}, watcher);
            });
            watcher.actions = action.catch(() => {});
            await action;
          } catch (error) { if (watchers.has(watcher)) write(watcher, { error: error.message }); }
        },
      };
      watchers.add(watcher);
      if (scope !== undefined && (scope !== 'browser' || !fixed)) { fail(watcher, 'A browser scope needs a fixed tab and scope "browser"'); return watcher; }
      if (resume !== undefined && (resume !== true || !browser)) { fail(watcher, 'Only a browser-scoped watch can resume'); return watcher; }
      // A resumed scoped viewer may have been disconnected when its pin
      // closed. Recover the view, never rewrite a later stale input id.
      if (browser && resume && (tab === null || (Number.isSafeInteger(tab) && tab > 0)) && !target(watcher)) {
        const remaining = surviving();
        retarget(watcher, remaining.find(page => page.id === front()) ?? remaining[0]);
        tab = watcher.tab;
      }
      write(watcher, { tabs: list() });
      const emptyBrowser = browser && tab === null;
      if (fixed && !emptyBrowser && (!Number.isSafeInteger(tab) || tab <= 0)) { fail(watcher, 'A fixed watch needs a positive browser tab id'); return watcher; }
      if (fixed && !emptyBrowser && !target(watcher)) { fail(watcher); return watcher; }
      claim(watcher);
      const page = target(watcher), cast = casts.get(page);
      if (cast && (!fit || cast.viewport === JSON.stringify(viewports.get(page) ?? null))) bind(watcher, cast);
      void changed();
      return watcher;
    },
    watching: () => watchers.size,
  };
}

// One connection to the window's socket: a tool request, or newline-ended
// JSON each way for as long as a live viewer stays.
export function answer(socket, { drive, live }) {
  let asked = '', hear = null;
  socket.setEncoding('utf8');
  socket.on('error', () => {});
  socket.on('data', chunk => {
    if (hear) { hear(chunk); return; }
    asked += chunk;
    const cut = asked.indexOf('\n');
    if (cut < 0) return;
    let first = null;
    try { first = JSON.parse(asked.slice(0, cut)); } catch { /* a request, whole at the end */ }
    if (first?.do === 'watch') hear = watchOn(socket, live, first, asked.slice(cut + 1));
  });
  socket.on('end', async () => {
    if (hear) return;
    let said;
    try { said = await drive(JSON.parse(asked)); } catch (error) { said = { error: error.message }; }
    socket.end(JSON.stringify(said));
  });
}

function watchOn(socket, live, first, rest) {
  let heard = '';
  const watcher = live.watch(first, said => { if (!socket.destroyed) socket.write(`${JSON.stringify(said)}\n`); });
  const hear = chunk => {
    heard += chunk;
    for (let cut = heard.indexOf('\n'); cut >= 0; cut = heard.indexOf('\n')) {
      const line = heard.slice(0, cut);
      heard = heard.slice(cut + 1);
      let said;
      try { said = JSON.parse(line); } catch { continue; }
      void watcher.hear(said);
    }
  };
  socket.on('end', () => { watcher.stop(); socket.end(); });
  socket.on('close', () => watcher.stop());
  hear(rest);
  return hear;
}
