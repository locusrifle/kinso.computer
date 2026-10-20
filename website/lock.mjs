// Authentication only. Both lock presentations live in macos/lock.mjs.
// The workbench a locker answer opens, or null: { id, url } with an https (or loopback http) url and no credentials.
export function workbenchOf(answer) {
  const bench = answer?.ok === true ? answer.workbench : null;
  if (!bench || typeof bench.id !== 'string' || typeof bench.url !== 'string') return null;
  try {
    const url = new URL(bench.url);
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (url.username || url.password || !(url.protocol === 'https:' || (local && url.protocol === 'http:'))) return null;
    return { id: bench.id, url: url.href };
  } catch { return null; }
}
async function ask(fetcher, init) {
  const response = await fetcher('/unlock', { credentials: 'same-origin', cache: 'no-store', ...init });
  return workbenchOf(await response.json().catch(() => null));
}
// A remembered unlock (the cookie), with a fresh address; null if there is none or the locker cannot be reached.
export const remembered = ({ fetcher = fetch } = {}) => ask(fetcher, { method: 'GET' }).catch(() => null);
// The password, checked by the locker; null for any refusal (wrong, too many tries, unreachable): all look the same.
export const unlock = (password, { fetcher = fetch } = {}) => ask(fetcher, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: String(password) }),
}).catch(() => null);
