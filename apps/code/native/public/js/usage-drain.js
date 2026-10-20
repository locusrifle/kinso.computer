// Subscription limits use `pi` for ChatGPT, shared by Pi and Codex.
export function tabSubscription(tab) {
  if (!tab || tab.offline || tab.status !== 'working') return null;
  if (tab.agent === 'claude') return 'claude';
  if (tab.agent === 'codex') return 'pi';
  if (tab.agent !== 'pi') return null;
  const provider = tab.provider ?? tab.model?.provider;
  return provider === 'claude-agent' ? 'claude' : provider === 'openai-codex' ? 'pi' : null;
}

export const DRAIN_WINDOW_MS = 90000;
export const DRAIN_READ_MS = 30000; // The computer coalesces/caches provider reads for a minute.
const keyOf = (agent, name) => JSON.stringify([agent, name || 'Limit']);
const usedOf = used => typeof used === 'number' && Number.isFinite(used) ? Math.max(0, Math.min(100, used)) : null;

// Only fresh answers are observed, never localStorage reflections or repaints.
// A steady cached answer must not extend the last observed drop indefinitely.
export function createUsageDrain() {
  let previous = new Map();
  const until = new Map();
  return {
    observe(answer, now = Date.now()) {
      const next = new Map();
      for (const row of Array.isArray(answer) ? answer : []) {
        if (!['claude', 'pi'].includes(row?.agent) || !row.signedIn || row.error || row.limitsUnavailable) continue;
        for (const w of Array.isArray(row.windows) ? row.windows : []) {
          if (!w) continue;
          const used = usedOf(w.used);
          if (used === null) continue;
          const key = keyOf(row.agent, w.name), before = previous.get(key);
          // A reset/account change is not spending. Don't compare different windows.
          if (before && before.account === row.accountId && before.reset === w.resetsAt && used > before.used) until.set(key, now + DRAIN_WINDOW_MS);
          if (before && (before.account !== row.accountId || before.reset !== w.resetsAt || used < before.used)) until.delete(key);
          next.set(key, { used, reset: w.resetsAt, account: row.accountId });
        }
      }
      for (const key of until.keys()) if (!next.has(key)) until.delete(key);
      previous = next;
    },
    isDraining(agent, name, tabs = [], now = Date.now()) {
      if (!['claude', 'pi'].includes(agent)) return false;
      return tabs.some(tab => tabSubscription(tab) === agent) || (until.get(keyOf(agent, name)) ?? 0) > now;
    },
  };
}
