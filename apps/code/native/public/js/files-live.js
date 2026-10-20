// One visible folder per Files surface. SSE invalidates; listings remain the
// authority. A ready/reconnect always needs an unconditional listing before live.
const WINDOW = globalThis.crypto?.randomUUID?.() ?? 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
  const n = Math.floor(Math.random() * 16);
  return (c === 'x' ? n : (n & 3) | 8).toString(16);
});

export function watchFolder({ base, path, refresh, status, EventSource = globalThis.EventSource }) {
  const controller = new AbortController();
  let source, stopped = false, ready = false, mode = 'watch', validated = false;
  let revision = 0, running = false, pending = false, full = false, debounce;
  let heard = Date.now(), version = null;
  const paint = () => status?.(ready && validated ? (mode === 'watch' ? 'live' : 'polling') : 'not-live');
  async function drain() {
    if (stopped || running || !pending) return;
    running = true;
    while (pending && !stopped) {
      const force = full, at = revision;
      pending = full = false;
      try {
        await refresh({ force, signal: controller.signal });
        if (at === revision && ready && force) validated = true;
      } catch { validated = false; }
      if (!stopped) paint();
    }
    running = false;
  }
  function revalidate(force = false, immediate = false) {
    if (stopped) return;
    pending = true; full ||= force;
    clearTimeout(debounce);
    if (immediate) void drain();
    else debounce = setTimeout(() => { void drain(); }, 100);
  }
  function connect() {
    if (stopped) return;
    try {
      const transport = source = new EventSource(`${base}/files/events?path=${encodeURIComponent(path)}&window=${WINDOW}`);
      const current = () => !stopped && source === transport;
      transport.addEventListener('ready', event => {
        if (!current()) return;
        let message;
        try { message = JSON.parse(event.data); } catch { return; }
        if (message.path !== path || !['watch', 'poll'].includes(message.mode)) return;
        revision++; ready = true; validated = false; mode = message.mode; version = message.version; heard = Date.now();
        paint(); revalidate(true, true);
      });
      transport.addEventListener('changed', event => {
        if (!current()) return;
        let message;
        try { message = JSON.parse(event.data); } catch { return; }
        if (message.path !== path) return;
        version = message.version; heard = Date.now(); revalidate();
      });
      transport.addEventListener('heartbeat', event => {
        if (!current()) return;
        let message;
        try { message = JSON.parse(event.data); } catch { return; }
        if (message.path !== path || !['watch', 'poll'].includes(message.mode)) return;
        heard = Date.now();
        if (message.mode !== mode) {
          revision++; mode = message.mode; validated = false; paint();
          revalidate(true, true);
        }
        // A coalesced/dropped notification is only a hint. Even an older
        // heartbeat can trigger a cheap conditional fetch, never a disk patch.
        if (message.version !== version) { version = message.version; revalidate(!validated); }
      });
      transport.onerror = () => {
        if (!current()) return;
        revision++; ready = validated = false;
        paint();
        // EventSource retries by itself; polling continues while it is down.
      };
    } catch { /* unsupported transport: still revalidate periodically */ }
  }
  paint(); connect(); revalidate(true, true);
  const timer = setInterval(() => {
    if (ready && Date.now() - heard > 15_000) {
      revision++; ready = validated = false; paint();
      source?.close();
      // Resume the stream too, rather than trusting a silent connection.
      connect();
    }
    // HTTP rejection can permanently close EventSource instead of retrying.
    if (source?.readyState === 2) connect();
    revalidate(!validated, true);
  }, 10_000);
  return {
    revalidate() {
      if (source?.readyState === 2) connect();
      revalidate(true, true);
    },
    stop() {
      stopped = true; controller.abort(); source?.close();
      clearInterval(timer); clearTimeout(debounce);
    },
  };
}
