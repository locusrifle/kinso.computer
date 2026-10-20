// Whether the view on screen is the computer's view now. No DOM, no network.
//
// A view goes stale when there is reason to doubt it: the window was looked
// at again (it may have slept with a dead socket), its socket closed, or
// another session was asked for and has not come. From then until it is
// shown to be current it is marked, and something is always being done about
// it: attempt() runs at once and again with backoff until fresh() is called
// with evidence from after the doubt began. A view that stays stale says so,
// in steps: 'stale' at first (the bar and the mark only), 'reconnecting'
// after warnMs, 'unreachable' after failMs (with a retry), and after reloadMs
// reload() is asked to load the page again, which it does only where that
// would help and lose nothing, and otherwise is asked again later.

export const WARN_MS = 2000, FAIL_MS = 10_000, RELOAD_MS = 30_000;
export const BACKOFF_MS = [500, 1000, 2000, 4000, 8000, 10_000];

export function createFreshness({ onChange = () => {}, now = () => Date.now(),
  setTimer = (fn, ms) => setTimeout(fn, ms), clearTimer = id => clearTimeout(id),
  warnMs = WARN_MS, failMs = FAIL_MS, reloadMs = RELOAD_MS, backoffMs = BACKOFF_MS } = {}) {
  let view = null, retryTimer = 0, phaseTimer = 0, reloadTimer = 0;
  const info = () => (view ? { phase: view.phase, owner: view.owner, want: view.want, since: view.since } : { phase: 'fresh' });
  const emit = () => onChange(info());
  function stopTimers() { clearTimer(retryTimer); clearTimer(phaseTimer); clearTimer(reloadTimer); retryTimer = phaseTimer = reloadTimer = 0; }
  function phases() {
    clearTimer(phaseTimer); phaseTimer = 0;
    if (!view) return;
    const age = now() - view.since;
    const phase = age >= failMs ? 'unreachable' : age >= warnMs ? 'reconnecting' : 'stale';
    if (phase !== view.phase) { view.phase = phase; emit(); }
    const next = phase === 'stale' ? warnMs : phase === 'reconnecting' ? failMs : 0;
    if (next) phaseTimer = setTimer(phases, Math.max(0, view.since + next - now()));
  }
  function scheduleReload(after) {
    clearTimer(reloadTimer); reloadTimer = 0;
    if (!view?.reload) return;
    const asked = view;
    reloadTimer = setTimer(async () => {
      reloadTimer = 0;
      if (view !== asked) return;
      let done = false;
      try { done = await asked.reload(); } catch {}
      if (!done && view === asked) scheduleReload(reloadMs);
    }, after);
  }
  // One attempt at a time; the next waits for it to end, then for the backoff
  // (or none, when it was asked for again meanwhile).
  function tryNow() {
    clearTimer(retryTimer); retryTimer = 0;
    if (!view?.attempt) return;
    const asked = view;
    if (asked.running) { asked.again = true; return; }
    const delay = backoffMs[Math.min(asked.tries, backoffMs.length - 1)];
    asked.tries++;
    asked.running = true;
    Promise.resolve().then(() => asked.attempt(asked.since)).catch(() => {}).finally(() => {
      asked.running = false;
      if (view !== asked || retryTimer) return;
      if (asked.again) { asked.again = false; tryNow(); } else retryTimer = setTimer(tryNow, delay);
    });
  }
  return {
    get state() { return info(); },
    // Doubt the view of `owner` (and, with `want`, ask for that one of its
    // sessions). Doubted again while still stale (another socket closing as
    // it is tried) it goes on as it was, backoff and all. `restart` (the
    // window looked at again) tries at once and starts the clock again, so a
    // view doubted while nobody was looking does not come back already
    // saying it cannot be reached.
    stale({ owner, want = null, attempt = null, reload = null, restart = false }) {
      const same = view && view.owner === owner && view.want === want;
      if (!same) { stopTimers(); view = { owner, want, attempt, reload, since: now(), tries: 0, phase: 'stale' }; emit(); }
      else {
        Object.assign(view, { attempt: attempt ?? view.attempt, reload: reload ?? view.reload });
        if (!restart) return;
        view.since = now(); view.tries = 0;
        if (view.phase !== 'stale') { view.phase = 'stale'; emit(); }
      }
      phases();
      scheduleReload(Math.max(0, view.since + reloadMs - now()));
      tryNow();
    },
    // The view of `owner`, showing `have`, is current as of `at`. Evidence
    // from before the doubt began (a message already on its way) does not
    // count, nor a view of another session than the one asked for.
    fresh(at = now(), owner = view?.owner, have = null) {
      if (!view || owner !== view.owner || at < view.since || (view.want && have !== view.want)) return false;
      view = null; stopTimers(); emit();
      return true;
    },
    // Not doubted any more, whatever it shows: what was asked for was
    // refused, which is said elsewhere, and trying again would not help.
    forget(owner) {
      if (!view || view.owner !== owner) return;
      view = null; stopTimers(); emit();
    },
    // The person asked: try now, and give it the full time again.
    retry() {
      if (!view) return;
      view.tries = 0; view.since = now();
      if (view.phase !== 'stale') { view.phase = 'stale'; emit(); }
      phases(); scheduleReload(reloadMs);
      tryNow();
    },
  };
}
