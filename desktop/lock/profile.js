// Temporary, explicit native-lock diagnostic. No input, DOM content or authentication data.
(() => {
  if (new URLSearchParams(location.search).get('profile') !== '1') return;
  const origin = performance.now(), groups = new Map();
  let phase = 'approach', active = true, last = null, first = true;
  const send = data => {
    try { window.webkit?.messageHandlers?.imperfect?.postMessage('profile:' + JSON.stringify({ ...data, at: performance.now(), origin: performance.timeOrigin })); } catch {}
  };
  const sample = (name, ms) => {
    if (!active || !Number.isFinite(ms)) return;
    const key = phase + ':' + name;
    const g = groups.get(key) || { n: 0, sum: 0, max: 0, bins: Array(9).fill(0) };
    g.n++; g.sum += ms; g.max = Math.max(g.max, ms);
    g.bins[[8, 16.7, 25, 33.4, 50, 100, 250, 500].findIndex(v => ms <= v) < 0 ? 8 : [8, 16.7, 25, 33.4, 50, 100, 250, 500].findIndex(v => ms <= v)]++;
    groups.set(key, g);
  };
  const flush = () => { if (groups.size) { send({ event: 'histogram', groups: Object.fromEntries(groups) }); groups.clear(); } };
  window.__lockProfile = {
    sample,
    mark(event, extra = {}) { if (active) send({ event, ...extra }); },
    phase(next) { if (!active || phase === next) return; flush(); phase = next; last = null; send({ event: 'phase', phase }); },
  };
  send({ event: 'document', elapsed: origin, width: innerWidth, height: innerHeight, dpr: devicePixelRatio });
  let observer;
  try {
    observer = new PerformanceObserver(list => { for (const e of list.getEntries()) sample('longtask', e.duration); });
    observer.observe({ entryTypes: ['longtask'] });
    send({ event: 'longtask-support', supported: PerformanceObserver.supportedEntryTypes?.includes('longtask') || false });
  } catch { send({ event: 'longtask-support', supported: false }); }
  const raf = now => {
    if (!active) return;
    if (first) { first = false; send({ event: 'first-raf' }); }
    if (last !== null) sample('raf-gap', now - last);
    last = now; requestAnimationFrame(raf);
  };
  requestAnimationFrame(raf);
  const timer = setInterval(flush, 2000);
  setTimeout(() => { flush(); send({ event: 'end' }); active = false; clearInterval(timer); observer?.disconnect(); }, 180000);
})();
