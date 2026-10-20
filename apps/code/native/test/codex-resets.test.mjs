import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createCodexResets, resetCredits, redeemRequestId } from '../codex-resets.mjs';
import { createUsageStore } from '../usage.mjs';
import { createTabHost } from '../tabs.mjs';
import { staleCommandError } from '../public/js/session-logic.js';
const NOW = 1791600000000;
const credit = (id = 'first', extra = {}) => ({ id, status: 'available', reset_type: 'codex_rate_limits', expires_at: new Date(NOW + 86400000).toISOString(), ...extra });
const response = body => ({ ok: true, json: async () => body });
const runtime = (account = 'fixture-account') => ({ getProvider: () => ({}), getProviderAuthStatus: () => ({ configured: true }), getAuth: async () => ({ auth: { apiKey: `fixture.${Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: account } })).toString('base64url')}.not-a-token` } }) });
function fixture(options = {}) {
  let time = NOW;
  const calls = [], store = createUsageStore({ now: () => time });
  store.codexHeaders({ 'x-codex-primary-used-percent': '63', 'x-codex-primary-window-minutes': '300' });
  const modelRuntime = runtime();
  let fail = false, list = { available_count: 5, credits: [credit()] }, outcome = 'reset';
  const service = createCodexResets({ now: () => time, accounts: new Map(), fetch: async (url, init) => {
    calls.push({ url, init });
    if (init.method === 'POST') { if (options.post) return options.post(url, init); if (fail) throw new Error('private credentials'); return response({ code: outcome }); }
    if (fail) throw new Error('private credentials');
    return response(list);
  } });
  return { service, calls, store, modelRuntime, advance: ms => { time += ms; }, input: { modelRuntime, store, accountId: 'fixture-account', creditId: 'first', confirmed: true, operationId: 'fixture-intent' }, setFail: v => { fail = v; }, setList: v => { list = v; }, setOutcome: v => { outcome = v; } };
}
test('summary counts are authoritative, expiry/type/status filter only the redeemable target', () => {
  assert.equal(resetCredits({ available_count: 8, credits: [credit()] }, NOW).availableCount, 8);
  assert.equal(resetCredits({ availableCount: 0, credits: [credit()] }, NOW).nextCreditId, undefined);
  assert.deepEqual(resetCredits({ credits: [credit('expired', { expires_at: new Date(NOW).toISOString() }), credit('wrong', { reset_type: 'cash' }), credit('used', { status: 'redeemed' })] }, NOW), { availableCount: 0 });
  assert.deepEqual(resetCredits({ available_count: 3 }, NOW), { availableCount: 3 });
  assert.deepEqual(resetCredits({ availableCount: 7, credits: null }, NOW), { availableCount: 7 });
  assert.deepEqual(resetCredits({ availableCount: 7, credits: [{ id: 'capped-detail', status: 'available', resetType: 'codexRateLimits', expiresAt: (NOW + 86400000) / 1000 }] }, NOW), { availableCount: 7, nextCreditId: 'capped-detail', nextExpiresAt: NOW + 86400000 });
  for (const payload of [null, {}, { credits: [null] }, { credits: [], has_more: true }, { available_count: -1 }, { availableCount: '4' }, { availableCount: null, credits: [] }, { available_count: null, credits: [] }]) assert.equal(resetCredits(payload, NOW), null);
});
test('fresh pushed quota still reads and separately caches reset metadata; failures are not zero or missing bars', async () => {
  const f = fixture();
  let value = await f.service.limits(f.input);
  assert.equal(value.windows[0].used, 63); assert.equal(value.resetCredits.availableCount, 5);
  await f.service.limits(f.input); assert.equal(f.calls.length, 1);
  assert.doesNotMatch(JSON.stringify(value), /not-a-token|Bearer/);
  const broken = fixture(); broken.setFail(true);
  value = await broken.service.limits(broken.input);
  assert.equal(value.windows[0].used, 63); assert.equal(value.resetCredits, null);
});
test('quota and credit outages retain last reported bars without inventing a zero count', async () => {
  const f = fixture(); await f.service.limits(f.input);
  f.advance(61000); f.store.clearCodex(); f.setFail(true);
  const last = await f.service.limits(f.input);
  assert.equal(last.windows[0].used, 63); assert.equal(last.limitsUnavailable, true); assert.equal(last.resetCredits, null);
});
test('no POST without confirmation, exact displayed credit and account; expiry refuses mutation', async () => {
  const f = fixture();
  for (const input of [{ confirmed: false }, { accountId: 'elsewhere' }, { creditId: 'not-displayed' }]) assert.deepEqual(await f.service.consume({ ...f.input, ...input }), { outcome: 'not_applied' });
  f.setList({ credits: [credit('first', { expires_at: new Date(NOW - 1).toISOString() })] });
  assert.deepEqual(await f.service.consume(f.input), { outcome: 'not_applied' });
  assert.equal(f.calls.filter(c => c.init.method === 'POST').length, 0);
});
for (const [kind, operationId] of [['missing', undefined], ['empty', ''], ['oversized', 'x'.repeat(201)]]) test(`${kind} operationId refuses mutation without provider POST`, async () => {
  const f = fixture();
  const input = { ...f.input, operationId };
  if (kind === 'missing') delete input.operationId;
  assert.deepEqual(await f.service.consume(input), { outcome: 'not_applied' });
  assert.equal(f.calls.filter(c => c.init.method === 'POST').length, 0);
});
test('duplicate confirms serialize per account and share one POST and stable UUID; known outcome is memoized', async () => {
  let release;
  const f = fixture({ post: () => new Promise(resolve => { release = resolve; }) });
  const first = f.service.consume(f.input), second = f.service.consume(f.input);
  while (!release) await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(f.service.consume({ ...f.input, creditId: 'second' }), /in progress/);
  release(response({ code: 'reset' }));
  assert.deepEqual(await first, { outcome: 'reset' }); assert.deepEqual(await second, { outcome: 'reset' });
  await f.service.consume(f.input);
  const posts = f.calls.filter(c => c.init.method === 'POST'); assert.equal(posts.length, 1);
  assert.deepEqual(JSON.parse(posts[0].init.body), { redeem_request_id: redeemRequestId('fixture-account', 'first'), credit_id: 'first' });
  assert.equal(f.store.codex(), null);
});
test('uncertain responses never auto-retry; explicit retry reuses target and key even if list changed', async () => {
  let count = 0;
  const f = fixture({ post: async () => { if (++count === 1) throw new Error('token secret'); return response({ code: 'already_redeemed' }); } });
  assert.deepEqual(await f.service.consume(f.input), { outcome: 'uncertain' }); assert.equal(count, 1);
  assert.deepEqual((await f.service.limits(f.input)).resetAttempt, { creditId: 'first', operationId: 'fixture-intent', uncertain: true }, 'other tabs see the same account-level uncertain target');
  await assert.rejects(f.service.consume({ ...f.input, creditId: 'another-credit' }), /previous uncertain/);
  f.setList({ available_count: 0, credits: [] });
  assert.deepEqual(await f.service.consume(f.input), { outcome: 'already_redeemed' });
  const bodies = f.calls.filter(c => c.init.method === 'POST').map(c => c.init.body); assert.equal(bodies[0], bodies[1]);
});
for (const outcome of ['reset', 'nothing_to_reset', 'no_credit', 'already_redeemed']) test(`known ${outcome} preserves outcome even when refresh fails`, async () => {
  const f = fixture({ post: async () => { f.setFail(true); return response({ code: outcome }); } });
  assert.deepEqual(await f.service.consume(f.input), { outcome });
  assert.equal(f.store.codex() === null, outcome === 'reset' || outcome === 'already_redeemed');
});
test('consume forced validation never reuses an older in-flight credit GET', async () => {
  let release, gets = 0, posts = 0;
  const modelRuntime = runtime(), store = createUsageStore({ now: () => NOW });
  store.codexHeaders({ 'x-codex-primary-used-percent': 63 });
  const service = createCodexResets({ now: () => NOW, accounts: new Map(), fetch: async (_url, init) => {
    if (init.method === 'POST') { posts++; return response({ code: 'reset' }); }
    if (++gets === 1) return new Promise(resolve => { release = () => resolve(response({ credits: [credit()] })); });
    return response({ credits: [credit('replacement')] });
  } });
  const reading = service.limits({ modelRuntime, store });
  while (!release) await new Promise(resolve => setImmediate(resolve));
  const consume = service.consume({ modelRuntime, store, accountId: 'fixture-account', creditId: 'first', confirmed: true, operationId: 'forced-validation-intent' });
  release(); await reading;
  assert.deepEqual(await consume, { outcome: 'not_applied' }); assert.equal(gets, 2); assert.equal(posts, 0);
});
test('preflight failures never expose provider errors or trigger POST, and custom proxy cannot consume', async () => {
  const f = fixture(); f.setFail(true);
  assert.deepEqual(await f.service.consume(f.input), { outcome: 'not_applied' });
  const authFailure = { ...runtime(), getAuth: async () => { throw new Error('private provider credentials'); } };
  assert.deepEqual(await f.service.consume({ ...f.input, modelRuntime: authFailure }), { outcome: 'not_applied' });
  assert.equal(f.calls.some(c => c.init.method === 'POST'), false);
  const modelRuntime = { ...runtime(), getAuth: async () => ({ auth: { ...(await runtime().getAuth()).auth, baseUrl: 'https://untrusted.example' } }) };
  assert.deepEqual(await f.service.consume({ ...f.input, modelRuntime }), { outcome: 'not_applied' });
  assert.equal(f.calls.some(c => c.init.method === 'POST'), false);
});
test('sign-in switching during preflight GET cannot redeem on either account', async () => {
  let account = 'fixture-account', posts = 0;
  const modelRuntime = { ...runtime(), getAuth: () => runtime(account).getAuth() };
  const service = createCodexResets({ now: () => NOW, accounts: new Map(), fetch: async (_url, init) => {
    if (init.method === 'POST') posts++;
    account = 'other-account'; return response({ credits: [credit()] });
  } });
  assert.deepEqual(await service.consume({ modelRuntime, accountId: 'fixture-account', creditId: 'first', confirmed: true, operationId: 'account-switch-intent' }), { outcome: 'not_applied' });
  assert.equal(posts, 0);
});
test('unknown response codes stay uncertain and retry preserves the deterministic request across services', async () => {
  const f = fixture({ post: async () => response({ code: 'unexpected' }) });
  assert.deepEqual(await f.service.consume(f.input), { outcome: 'uncertain' });
  assert.deepEqual(await f.service.consume(f.input), { outcome: 'uncertain' });
  const bodies = f.calls.filter(c => c.init.method === 'POST').map(c => JSON.parse(c.init.body));
  assert.deepEqual(bodies[0], bodies[1]);
  assert.equal(bodies[0].redeem_request_id, redeemRequestId('fixture-account', 'first'));
  assert.notEqual(redeemRequestId('other-account', 'first'), bodies[0].redeem_request_id);
  let restartedBody;
  const restarted = createCodexResets({ now: () => NOW, accounts: new Map(), fetch: async (_url, init) => {
    if (init.method !== 'POST') return response({ credits: [credit()] });
    restartedBody = JSON.parse(init.body); return response({ code: 'already_redeemed' });
  } });
  assert.deepEqual(await restarted.consume(f.input), { outcome: 'already_redeemed' });
  assert.deepEqual(restartedBody, bodies[0]);
});
test('tabs routes narrowly to Pi without switching harness; stale session/tab rejected', async () => {
  const calls = [];
  const make = agent => ({ events: new EventEmitter(), snapshot: () => ({ sessionId: 'fixture-session', agent, messages: [] }), command: async c => { calls.push([agent, c]); return { outcome: 'reset' }; }, close: async () => {} });
  const host = await createTabHost({ createRuntime: async () => make('pi'), createClaudeRuntime: async () => make('claude'), claudeAvailable: () => true, firstTab: 'claude', checkUpdates: false });
  try {
    const tab = host.snapshot().tabs[0];
    const c = { type: 'codex-reset-consume', expectedTabId: tab.id, expectedSessionId: 'fixture-session', accountId: 'fixture-account', creditId: 'first', confirmed: true, operationId: 'routing-intent' };
    await assert.rejects(host.command({ ...c, expectedTabId: 'stale' }), /Session changed/);
    await assert.rejects(host.command({ ...c, expectedSessionId: 'stale' }), /Session changed/);
    await assert.rejects(host.command({ ...c, expectedTabId: undefined }), /Session changed/);
    await host.command(c);
    assert.equal(calls.at(-1)[0], 'pi'); assert.equal(host.snapshot().tabs.length, 1);
    assert.equal(staleCommandError(c, { sessionId: 'changed' }), 'session changed');
  } finally { await host.close(); }
});

for (const noop of ['nothing_to_reset', 'no_credit']) test(`new manual intent after ${noop} revalidates same credit; old resend stays deduped`, async () => {
  const f = fixture(); f.setOutcome(noop);
  f.store.codexHeaders({ 'x-codex-primary-used-percent': '0', 'x-codex-primary-window-minutes': '300' });
  const first = { ...f.input, operationId: 'manual-one' };
  assert.deepEqual(await f.service.consume(first), { outcome: noop });
  await f.service.consume(first);
  assert.equal(f.calls.filter(c => c.init.method === 'POST').length, 1);
  // Quota was used again after the definitive no-op; another human confirms.
  f.store.codexHeaders({ 'x-codex-primary-used-percent': '63', 'x-codex-primary-window-minutes': '300' });
  assert.equal(f.store.codex()[0].used, 63);
  f.setOutcome('reset');
  assert.deepEqual(await f.service.consume({ ...first, operationId: 'manual-two' }), { outcome: 'reset' });
  const posts = f.calls.filter(c => c.init.method === 'POST');
  assert.equal(posts.length, 2); assert.equal(posts[0].init.body, posts[1].init.body);
  assert.equal(f.calls.filter(c => c.init.method !== 'POST').length, 4, 'each new confirmation forces fresh validation');
  await f.service.consume(first); await f.service.consume({ ...first, operationId: 'manual-three' });
  assert.equal(f.calls.filter(c => c.init.method === 'POST').length, 2, 'success receipt prevents another redemption');
});
test('same manual noop intent coalesces concurrently and remains deduped after later noops', async () => {
  let release;
  const f = fixture({ post: () => new Promise(resolve => { release = resolve; }) });
  const input = { ...f.input, operationId: 'same-manual-intent' };
  const first = f.service.consume(input), duplicate = f.service.consume(input);
  while (!release) await new Promise(resolve => setImmediate(resolve));
  release(response({ code: 'nothing_to_reset' }));
  assert.deepEqual(await first, { outcome: 'nothing_to_reset' });
  assert.deepEqual(await duplicate, { outcome: 'nothing_to_reset' });
  const next = f.service.consume({ ...input, operationId: 'next-manual-intent' });
  const oldRelease = release;
  while (release === oldRelease) await new Promise(resolve => setImmediate(resolve));
  release(response({ code: 'no_credit' })); await next;
  assert.deepEqual(await f.service.consume(input), { outcome: 'nothing_to_reset' });
  assert.equal(f.calls.filter(c => c.init.method === 'POST').length, 2);
  assert.equal(f.calls.filter(c => c.init.method !== 'POST').length, 4, 'each new intent validates and refreshes');
});
test('expired preflight is definitively not applied and fresh new target is usable', async () => {
  const f = fixture(); f.setList({ credits: [credit('first', { expires_at: new Date(NOW - 1).toISOString() })] });
  assert.deepEqual(await f.service.consume({ ...f.input, operationId: 'expired' }), { outcome: 'not_applied' });
  assert.equal(f.calls.filter(c => c.init.method === 'POST').length, 0);
  f.setList({ credits: [credit('new')] });
  assert.deepEqual(await f.service.consume({ ...f.input, creditId: 'new', operationId: 'fresh' }), { outcome: 'reset' });
});
test('different simultaneous manual intent is refused, not coalesced into an earlier noop', async () => {
  let release; const f = fixture({ post: () => new Promise(resolve => { release = resolve; }) });
  const first = f.service.consume({ ...f.input, operationId: 'one' });
  while (!release) await new Promise(resolve => setImmediate(resolve));
  const second = await Promise.race([
    f.service.consume({ ...f.input, operationId: 'two' }).then(() => 'coalesced', e => e),
    new Promise(resolve => setTimeout(() => resolve('blocked'), 100)),
  ]);
  release(response({ code: 'nothing_to_reset' })); await first;
  assert.match(second?.message || String(second), /in progress/);
  assert.equal(f.calls.filter(c => c.init.method === 'POST').length, 1);
});

for (const kind of ['lost', 'http', 'unknown']) test(`true ${kind} uncertainty keeps manual intent and provider key; failed retry preflight never settles it`, async () => {
  let posts = 0;
  const f = fixture({ post: async () => {
    posts++;
    if (kind === 'lost') throw new Error('private network error');
    if (kind === 'http') return { ok: false };
    return response({ code: 'unknown' });
  } });
  const input = { ...f.input, operationId: 'uncertain-intent' };
  assert.deepEqual(await f.service.consume(input), { outcome: 'uncertain' });
  await assert.rejects(f.service.consume({ ...input, operationId: 'new-intent' }), /previous uncertain/);
  const brokenAuth = { ...runtime(), getAuth: async () => { throw new Error('private auth'); } };
  assert.deepEqual(await f.service.consume({ ...input, modelRuntime: brokenAuth }), { outcome: 'uncertain' });
  assert.equal(posts, 1);
  f.setList({ available_count: 0, credits: [] });
  assert.deepEqual(await f.service.consume(input), { outcome: 'uncertain' });
  const bodies = f.calls.filter(c => c.init.method === 'POST').map(c => c.init.body);
  assert.equal(bodies.length, 2); assert.equal(bodies[0], bodies[1]);
  assert.deepEqual((await f.service.limits(f.input)).resetAttempt, { creditId: 'first', operationId: 'uncertain-intent', uncertain: true });
});
