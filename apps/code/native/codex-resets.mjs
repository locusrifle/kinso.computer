// Codex banked-reset protocol informed by T3 Code 43f8a8de (MIT).
// No login files are read here; Pi supplies its authenticated provider token.
import { createHash } from 'node:crypto';
import { chatgptAccount, instant, FRESH_MS, piUsage, usageStore } from './usage.mjs';

export function resetCredits(payload, now = Date.now()) {
  if (!payload || typeof payload !== 'object') return null;
  const rows = Array.isArray(payload.credits) ? payload.credits : null;
  // Both the HTTP list and the generated Codex summary use the same credit
  // identifiers, but different field spellings. Never count summary detail rows.
  const normalized = rows?.map(c => ({ id: c?.id, status: c?.status, type: c?.reset_type ?? c?.resetType, expiry: instant(c?.expires_at ?? c?.expiresAt) }));
  const available = normalized?.filter(c => c.status === 'available' && ['codex_rate_limits', 'codexRateLimits'].includes(c.type) && typeof c.id === 'string' && c.id && c.expiry > now)
    .sort((a, b) => a.expiry - b.expiry);
  // The summary count is authoritative: a list may be capped or historical.
  const hasSummary = Object.hasOwn(payload, 'available_count') || Object.hasOwn(payload, 'availableCount');
  const summary = Object.hasOwn(payload, 'available_count') ? payload.available_count : payload.availableCount;
  if (hasSummary && (!Number.isSafeInteger(summary) || summary < 0)) return null;
  if (!hasSummary && (!rows || payload.has_more === true || rows.some(c => typeof c?.reset_type !== 'string') || normalized.some(c => typeof c.id !== 'string' || typeof c.status !== 'string' || c.expiry === null))) return null;
  const availableCount = hasSummary ? summary : available.length;
  const next = availableCount > 0 ? available?.[0] : null;
  return { availableCount, ...(next ? { nextCreditId: next.id, nextExpiresAt: next.expiry } : {}) };
}

// Stable UUIDv5 in imperfect's own namespace: retries, even after process restart,
// cannot turn an uncertain request into a second redemption for this credit.
export function redeemRequestId(account, credit) {
  const namespace = Buffer.from('ab48bd667a7c503591d02c7b57dcc886', 'hex');
  const bytes = createHash('sha1').update(namespace).update(JSON.stringify([account, credit])).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 15) | 80; bytes[8] = (bytes[8] & 63) | 128;
  const h = bytes.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
const states = new Map();
async function credentials(modelRuntime) {
  const provider = 'openai-codex';
  if (!modelRuntime?.getProvider?.(provider) || !modelRuntime.getProviderAuthStatus(provider)?.configured) return null;
  let auth;
  try { auth = (await modelRuntime.getAuth(provider))?.auth; }
  catch { throw new Error('Pi sign-in unavailable; refresh limits'); }
  const accountId = chatgptAccount(auth?.apiKey);
  if (!auth?.apiKey || !accountId) return null;
  // Account mutations are only sent to the official endpoint, never a custom proxy.
  const base = String(auth.baseUrl || modelRuntime.getProvider(provider)?.baseUrl || 'https://chatgpt.com/backend-api').replace(/\/+$/, '');
  if (base !== 'https://chatgpt.com/backend-api') return null;
  return { accountId, auth, url: `${base}/wham/rate-limit-reset-credits`, headers: { Authorization: `Bearer ${auth.apiKey}`, 'ChatGPT-Account-Id': accountId, 'OpenAI-Beta': 'codex-1', originator: 'pi', accept: 'application/json', 'Content-Type': 'application/json' } };
}
export function createCodexResets({ fetch = globalThis.fetch, now = () => Date.now(), accounts = states } = {}) {
  const stateFor = id => { if (!accounts.has(id)) accounts.set(id, { at: 0, credits: null, reading: null, pending: null, attempts: new Map() }); return accounts.get(id); };
  async function read(c, force = false) {
    const state = stateFor(c.accountId);
    if (!force && state.credits && now() - state.at < FRESH_MS) return state.credits;
    if (state.reading) {
      if (!force) return state.reading;
      await state.reading.catch(() => {});
      return read(c, true); // forced validation/refresh must not reuse an older GET
    }
    state.reading = (async () => {
      const response = await fetch(c.url, { headers: c.headers, signal: AbortSignal.timeout(15000) });
      if (!response.ok) throw new Error('Reset credits unavailable');
      const parsed = resetCredits(await response.json(), now());
      if (!parsed) throw new Error('Reset credits unavailable');
      state.credits = parsed; state.at = now(); return parsed;
    })().catch(() => { state.credits = null; state.at = 0; throw new Error('Reset credits unavailable; refresh limits'); }).finally(() => { state.reading = null; });
    return state.reading;
  }
  return {
    async limits({ modelRuntime, store = usageStore }) {
      const c = await credentials(modelRuntime);
      const boundRuntime = c ? { getProvider: id => modelRuntime.getProvider(id), getProviderAuthStatus: id => modelRuntime.getProviderAuthStatus(id), getAuth: async () => ({ auth: c.auth }) } : modelRuntime;
      let windows;
      try { windows = await piUsage({ modelRuntime: boundRuntime, store, fetch }); }
      catch {
        const last = c && stateFor(c.accountId).lastWindows;
        if (!last) throw new Error('Limits unavailable');
        windows = { ...last, limitsUnavailable: true };
      }
      if (!c || !windows.signedIn) return windows;
      if (!windows.limitsUnavailable) stateFor(c.accountId).lastWindows = windows;
      const state = stateFor(c.accountId);
      const uncertain = [...state.attempts].find(([, attempt]) => attempt.uncertain);
      const resetAttempt = state.pending ? { creditId: state.pending.creditId, operationId: state.pending.operationId, busy: true } : uncertain ? { creditId: uncertain[0], operationId: uncertain[1].operationId, uncertain: true } : null;
      const snapshot = { ...windows, accountId: c.accountId, ...(resetAttempt ? { resetAttempt } : {}) };
      try { return { ...snapshot, resetCredits: await read(c) }; }
      catch { return { ...snapshot, resetCredits: null }; }
    },
    async consume({ modelRuntime, store = usageStore, accountId, creditId, confirmed, operationId }) {
      // An opaque UI confirmation ID dedupes settled no-op resends, independently
      // of the stable provider credit key. Only a new explicit intent may retry a
      // definitive no-op. Every confirmation must carry an explicit valid ID.
      const unresolved = () => [...(accounts.get(accountId)?.attempts.values() || [])].some(a => a.uncertain);
      const notApplied = () => ({ outcome: unresolved() ? 'uncertain' : 'not_applied' });
      if (confirmed !== true || typeof accountId !== 'string' || typeof creditId !== 'string' || !creditId || typeof operationId !== 'string' || !operationId || operationId.length > 200) return notApplied();
      let c;
      try { c = await credentials(modelRuntime); } catch { return notApplied(); }
      if (!c || c.accountId !== accountId) return notApplied();
      const state = stateFor(accountId);
      const previous = state.attempts.get(creditId);
      if (previous?.result) return previous.result;
      if (state.pending) {
        if (state.pending.creditId === creditId && state.pending.operationId === operationId) return state.pending.promise;
        throw new Error('Another reset is in progress for this account');
      }
      if ([...state.attempts].some(([id, attempt]) => id !== creditId && attempt.uncertain)) throw new Error('Resolve the previous uncertain reset before using another');
      if (previous?.results?.has(operationId)) return previous.results.get(operationId);
      if (previous?.uncertain && previous.operationId !== operationId) throw new Error('Resolve the previous uncertain reset before using another intent');
      const attempt = previous || { requestId: redeemRequestId(accountId, creditId), uncertain: false, results: new Map() };
      attempt.operationId = operationId;
      state.attempts.set(creditId, attempt);
      const promise = (async () => {
        let current;
        try {
          if (!attempt.uncertain) {
            const credits = await read(c, true);
            if (!credits.availableCount || credits.nextCreditId !== creditId || !(credits.nextExpiresAt > now())) throw new Error('Preflight');
          }
          // Recheck the sign-in after GET and immediately before the only POST.
          current = await credentials(modelRuntime);
          if (current?.accountId !== accountId) throw new Error('Preflight');
        } catch {
          // This invocation sent no POST. An earlier lost response still cannot
          // be declared not-applied just because retry authentication failed.
          if (attempt.uncertain) return { outcome: 'uncertain' };
          const result = { outcome: 'not_applied' };
          attempt.results.set(operationId, result);
          return result;
        }
        attempt.uncertain = true;
        try {
          const response = await fetch(c.url + '/consume', { method: 'POST', headers: current.headers, body: JSON.stringify({ redeem_request_id: attempt.requestId, credit_id: creditId }), signal: AbortSignal.timeout(20000) });
          if (!response.ok) throw new Error('Uncertain');
          const { code } = await response.json();
          if (!['reset', 'nothing_to_reset', 'no_credit', 'already_redeemed'].includes(code)) throw new Error('Uncertain');
          attempt.uncertain = false;
          const result = { outcome: code };
          attempt.results.set(operationId, result);
          if (code === 'reset' || code === 'already_redeemed') attempt.result = result;
          state.credits = null; state.at = 0;
          if (code === 'reset' || code === 'already_redeemed') store.clearCodex?.();
          // Read-only refresh; its failure must never negate a known outcome.
          await read(current, true).catch(() => {});
          return result;
        } catch { state.credits = null; state.at = 0; return { outcome: 'uncertain' }; }
      })().finally(() => { state.pending = null; });
      state.pending = { creditId, operationId, promise };
      return promise;
    },
  };
}
export const codexResets = createCodexResets();
