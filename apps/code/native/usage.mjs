// How much of each subscription is used: the ChatGPT one Pi or the Codex CLI
// signs in with (openai-codex) and the Claude one Claude Code signs in with. Each limit is a
// window: { name, used (percent, 0-100), resetsAt (ms since 1970, or null),
// windowDurationMins (its length, when known: where even spending would be) }.
//
// What a harness already received is read first: the Codex backend reports
// its limits on every response (x-codex-* headers over HTTP, a
// codex.rate_limits event over its WebSocket), and Claude Code reports
// rate_limit_event frames. Only when that is missing or more than a minute
// old is the harness's own usage endpoint asked, from this computer, which
// holds the sign-in; the answer is kept for a minute. No token leaves here.
//
// The parsers are pure and are tested against the shapes the two backends
// send (test/usage.test.mjs).

import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const FRESH_MS = 60_000;
const CODEX_BASE = 'https://chatgpt.com/backend-api';

const num = value => { if (value == null || typeof value === 'boolean' || (typeof value === 'string' && value.trim() === '')) return null; const n = Number(value); return Number.isFinite(n) ? n : null; };
const clamp = n => Math.max(0, Math.min(100, n));
// Seconds or milliseconds since 1970, or an ISO date, as milliseconds.
export function instant(value) {
  if (value == null || value === '') return null;
  const n = num(value);
  if (n != null) return n > 0 ? (n < 1e12 ? n * 1000 : n) : null;
  const t = Date.parse(value);
  return Number.isFinite(t) ? t : null;
}
// A window's length, said the way people say it.
export function windowName(minutes) {
  const m = num(minutes);
  if (!m || m <= 0) return 'limit';
  if (m % 10080 === 0) return m === 10080 ? 'week' : `${m / 10080} weeks`;
  if (m % 1440 === 0) return m === 1440 ? 'day' : `${m / 1440} days`;
  if (m % 60 === 0) return m === 60 ? 'hour' : `${m / 60} hours`;
  return `${m} minutes`;
}
const limitWindow = (name, used, resetsAt, minutes = null) => {
  if (used == null) return null;
  const length = num(minutes);
  return { name, used: clamp(used), resetsAt: instant(resetsAt), ...(length > 0 ? { windowDurationMins: length } : {}) };
};
const named = (limit, name) => (limit ? `${limit} · ${name}` : name);
const limitLabel = id => String(id ?? '').replace(/[_-]+/g, ' ').trim();

/* ------------------------------------------------------------------ Codex */
// The headers of a Codex response: x-codex-primary-used-percent and its
// -window-minutes and -reset-at (seconds), the same for secondary, and the
// same again under x-<limit>- for each further metered limit.
export function codexFromHeaders(headers) {
  const h = Object.fromEntries(Object.entries(headers ?? {}).map(([k, v]) => [k.toLowerCase(), Array.isArray(v) ? v[0] : v]));
  const limits = new Set(Object.keys(h).map(k => /^x-(.+)-(?:primary|secondary)-used-percent$/.exec(k)?.[1]).filter(Boolean));
  const out = [];
  for (const id of [...limits].sort((a, b) => (b === 'codex') - (a === 'codex'))) {
    const label = id === 'codex' ? '' : (String(h[`x-${id}-limit-name`] ?? '').trim() || limitLabel(id));
    for (const which of ['primary', 'secondary']) {
      const minutes = h[`x-${id}-${which}-window-minutes`];
      const w = limitWindow(named(label, windowName(minutes)), num(h[`x-${id}-${which}-used-percent`]), h[`x-${id}-${which}-reset-at`], minutes);
      if (w) out.push(w);
    }
  }
  return out.length ? out : null;
}
// The codex.rate_limits event the Codex WebSocket sends beside a response.
export function codexFromEvent(event) {
  if (event?.type !== 'codex.rate_limits' || !event.rate_limits) return null;
  const label = event.metered_limit_name || event.limit_name ? limitLabel(event.metered_limit_name || event.limit_name) : '';
  const out = ['primary', 'secondary'].map(which => {
    const w = event.rate_limits[which];
    return w && limitWindow(named(label === 'codex' ? '' : label, windowName(w.window_minutes)), num(w.used_percent), w.reset_at, w.window_minutes);
  }).filter(Boolean);
  return out.length ? out : null;
}
// GET {base}/wham/usage, which the Codex CLI's /status reads.
export function codexFromUsage(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const read = (limit, label) => ['primary_window', 'secondary_window'].map(which => {
    const w = limit?.[which];
    const minutes = num(w?.limit_window_seconds) != null ? num(w.limit_window_seconds) / 60 : null;
    const resets = w?.reset_at ?? (num(w?.reset_after_seconds) != null ? Date.now() + num(w.reset_after_seconds) * 1000 : null);
    return w && limitWindow(named(label, windowName(minutes)), num(w.used_percent), resets, minutes);
  }).filter(Boolean);
  const out = [...read(payload.rate_limit, ''), ...(Array.isArray(payload.additional_rate_limits) ? payload.additional_rate_limits : [])
    .flatMap(extra => read(extra?.rate_limit, limitLabel(extra?.limit_name || extra?.metered_feature)))];
  return { plan: typeof payload.plan_type === 'string' ? payload.plan_type : null, windows: out };
}
// The ChatGPT account a sign-in belongs to, from its access token.
export function chatgptAccount(token) {
  try {
    const part = String(token).split('.')[1];
    const claims = JSON.parse(Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
    return claims?.['https://api.openai.com/auth']?.chatgpt_account_id || null;
  } catch { return null; }
}

/* ----------------------------------------------------------------- Claude */
const CLAUDE_WINDOWS = [['five_hour', '5 hours', 300], ['seven_day', 'week', 10080], ['seven_day_opus', 'week · Opus', 10080], ['seven_day_sonnet', 'week · Sonnet', 10080], ['seven_day_oauth_apps', 'week · apps', 10080]];
// What Claude Code's /usage shows, as the Agent SDK hands it over.
export function claudeFromUsage(response) {
  if (!response || typeof response !== 'object') return null;
  const plan = typeof response.subscription_type === 'string' ? response.subscription_type : null;
  if (!response.rate_limits_available) return { plan, signedIn: false, windows: [] };
  // Limits it has but could not read this time (just woken, the network
  // still coming up): not a signed-out account. claudeUsage falls back to
  // what Claude Code last reported, and nothing is kept.
  if (!response.rate_limits) throw new Error('Claude Code could not read its limits just now');
  const r = response.rate_limits;
  const out = CLAUDE_WINDOWS.map(([key, name, minutes]) => r[key] && limitWindow(name, num(r[key].utilization), r[key].resets_at, minutes));
  for (const scoped of Array.isArray(r.model_scoped) ? r.model_scoped : []) out.push(limitWindow(`week · ${scoped.display_name}`, num(scoped.utilization), scoped.resets_at, 10080));
  return { plan, signedIn: true, windows: out.filter(Boolean) };
}
const EVENT_WINDOWS = { five_hour: ['5 hours', 300], seven_day: ['week', 10080], seven_day_opus: ['week · Opus', 10080], seven_day_sonnet: ['week · Sonnet', 10080] };
// One rate_limit_event's window. Its utilization is a fraction (0-1), as
// Claude Code reads it from the API's unified rate-limit headers.
export function claudeFromEvent(info) {
  const [name, minutes] = EVENT_WINDOWS[info?.rateLimitType] ?? [];
  const used = num(info?.utilization);
  return name && used != null ? { key: info.rateLimitType, window: limitWindow(name, used * 100, info.resetsAt, minutes) } : null;
}

/* ---------------------------------------------------- what was received */
// One per process: every tab's harness on this computer reports here.
export function createUsageStore({ now = () => Date.now() } = {}) {
  let codex = null, codexAccount = null;
  const claude = new Map();
  const cache = new Map();
  return {
    codexHeaders(headers) { const windows = codexFromHeaders(headers); if (windows) codex = { at: now(), windows }; },
    codexEvent(event) { const windows = codexFromEvent(event); if (windows) codex = { at: now(), windows }; },
    claudeEvent(info) { const got = claudeFromEvent(info); if (got) claude.set(got.key, { at: now(), window: got.window }); },
    // What Codex last reported, while it is fresh.
    codex: () => (codex && now() - codex.at < FRESH_MS ? codex.windows : null),
    clearCodex() { codex = null; for (const key of cache.keys()) if (key.startsWith('codex:')) cache.delete(key); },
    bindCodexAccount(account) { if (codexAccount !== null && codexAccount !== account) codex = null; codexAccount = account; },
    // What Claude Code reported, however old; a fallback for its /usage.
    claude: () => [...claude.values()].map(item => item.window),
    // An answer kept for a minute; a failure is not kept.
    async cached(key, read) {
      const hit = cache.get(key);
      if (hit && now() - hit.at < FRESH_MS) return hit.value;
      const pending = Promise.resolve().then(read);
      cache.set(key, { at: now(), value: pending });
      pending.catch(() => { if (cache.get(key)?.value === pending) cache.delete(key); });
      return pending;
    },
  };
}
export const usageStore = createUsageStore();

/* --------------------------------------------------------------- reading */
// Pi's half: the ChatGPT subscription it signs in with, if it does.
export async function piUsage({ modelRuntime, store = usageStore, fetch = globalThis.fetch }) {
  const provider = 'openai-codex';
  if (!modelRuntime?.getProvider?.(provider) || !modelRuntime.getProviderAuthStatus(provider)?.configured) return { signedIn: false };
  const auth = (await modelRuntime.getAuth(provider))?.auth;
  const token = auth?.apiKey;
  if (!token) return { signedIn: false };
  const account = chatgptAccount(token);
  store.bindCodexAccount?.(account);
  const received = store.codex();
  if (received) return { signedIn: true, windows: received };
  return store.cached(`codex:${account}`, async () => {
    const base = String(auth.baseUrl || modelRuntime.getProvider(provider)?.baseUrl || CODEX_BASE).replace(/\/+$/, '');
    const response = await fetch(`${base}/wham/usage`, { headers: { Authorization: `Bearer ${token}`, ...(account ? { 'ChatGPT-Account-Id': account } : {}), originator: 'pi', accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
    if (response.status === 401 || response.status === 403) return { signedIn: false };
    if (!response.ok) throw new Error(`ChatGPT answered ${response.status}`);
    const read = codexFromUsage(await response.json());
    return { signedIn: true, plan: read?.plan ?? null, windows: read?.windows ?? [] };
  });
}
// The Codex CLI's own sign-in (~/.codex/auth.json, or $CODEX_HOME), for the
// same ChatGPT subscription when Pi is not signed in to it, or cannot say: so
// the limits are there whichever of the two signed in. It is only read, never
// refreshed or written; the Codex CLI keeps it fresh itself whenever it runs.
export async function codexCliUsage({ home = process.env.CODEX_HOME || join(homedir(), '.codex'), store = usageStore, fetch = globalThis.fetch } = {}) {
  let auth;
  try { auth = JSON.parse(await readFile(join(home, 'auth.json'), 'utf8')); } catch { return { signedIn: false }; }
  const token = auth?.tokens?.access_token;
  if (typeof token !== 'string' || !token) return { signedIn: false };
  const account = auth.tokens.account_id || chatgptAccount(token);
  return store.cached(`codex-cli:${account}`, async () => {
    const response = await fetch(`${CODEX_BASE}/wham/usage`, { headers: { Authorization: `Bearer ${token}`, ...(account ? { 'ChatGPT-Account-Id': account } : {}), originator: 'codex_cli_rs', accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
    if (response.status === 401 || response.status === 403) return { signedIn: false, expired: true };
    if (!response.ok) throw new Error(`ChatGPT answered ${response.status}`);
    const read = codexFromUsage(await response.json());
    return { signedIn: true, plan: read?.plan ?? null, windows: read?.windows ?? [], via: 'codex' };
  });
}
// Claude Code's half: what its /usage shows, or else what it reported.
export async function claudeUsage({ query, store = usageStore }) {
  try {
    return await store.cached('claude', async () => {
      const ask = query?.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET;
      if (typeof ask !== 'function') throw new Error('This Claude Code cannot say its usage');
      const read = claudeFromUsage(await ask.call(query, { skipBehaviors: true }));
      if (!read) throw new Error('Claude Code said nothing about usage');
      return read;
    });
  } catch (error) {
    const windows = store.claude();
    if (windows.length) return { signedIn: true, windows };
    throw error;
  }
}
