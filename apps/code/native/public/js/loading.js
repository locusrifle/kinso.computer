// The one loading mark: a thin bar running along the top edge in the theme's
// accent (loading.css). Anything loading or reconnecting holds it with
// begin() and lets go with the function begin() returns; it shows only once
// something has been held for DELAY_MS, so what is quick never flickers it.
export const DELAY_MS = 150;

export function mountLoadingBar(into = document.body, { delayMs = DELAY_MS } = {}) {
  const bar = document.createElement('div');
  bar.className = 'loading-bar';
  bar.setAttribute('role', 'progressbar');
  bar.setAttribute('aria-label', 'loading');
  bar.hidden = true;
  into.append(bar);
  const held = new Set();
  let timer = 0;
  const paint = () => {
    if (!held.size) { clearTimeout(timer); timer = 0; bar.hidden = true; return; }
    if (bar.hidden && !timer) timer = setTimeout(() => { timer = 0; bar.hidden = !held.size; }, delayMs);
  };
  return {
    element: bar,
    begin() {
      const token = {};
      held.add(token); paint();
      return () => { held.delete(token); paint(); };
    },
  };
}

// Under the bar, when a view cannot be brought up to date in a moment: the
// computer it is on, that it is being tried, and once it has been a while,
// that it cannot be reached, with a way to try again now.
export function mountConnectionLine(before, { onRetry = () => {} } = {}) {
  const line = document.createElement('div');
  line.className = 'entry-connection';
  line.setAttribute('role', 'status');
  line.hidden = true;
  const text = document.createElement('span');
  text.className = 'entry-connection-text';
  const retry = document.createElement('button');
  retry.type = 'button';
  retry.className = 'entry-connection-retry';
  retry.textContent = 'retry';
  retry.onclick = () => onRetry();
  line.append(text, retry);
  before.before(line);
  return {
    element: line,
    paint({ phase, name } = {}) {
      const who = name || 'this computer';
      line.hidden = phase !== 'reconnecting' && phase !== 'unreachable';
      line.dataset.phase = phase ?? 'fresh';
      text.textContent = phase === 'unreachable' ? `can't reach ${who}` : `${who} · reconnecting…`;
      retry.hidden = phase !== 'unreachable';
    },
  };
}
