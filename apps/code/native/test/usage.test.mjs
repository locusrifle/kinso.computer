import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  codexFromHeaders, codexFromEvent, codexFromUsage, chatgptAccount, claudeFromUsage, claudeFromEvent,
  createUsageStore, piUsage, claudeUsage, windowName, instant,
} from '../usage.mjs';

// The shapes below are as the backends send them: Codex's from the Codex
// CLI's own parsers (codex-rs/codex-api/src/rate_limits.rs and
// backend-client's /wham/usage payload), Claude's from the Agent SDK's
// SDKControlGetUsageResponse and SDKRateLimitInfo.
const CODEX_HEADERS = {
  'content-type': 'text/event-stream',
  'x-codex-primary-used-percent': '42.5',
  'x-codex-primary-window-minutes': '300',
  'x-codex-primary-reset-at': '1791374400',
  'x-codex-secondary-used-percent': '12',
  'x-codex-secondary-window-minutes': '10080',
  'x-codex-secondary-reset-at': '1791800000',
  'x-codex-primary-over-secondary-limit-percent': '0',
  'x-codex-credits-has-credits': 'false',
};
const CODEX_EVENT = {
  type: 'codex.rate_limits', plan_type: 'plus',
  rate_limits: { primary: { used_percent: 61, window_minutes: 300, reset_at: 1791374400 }, secondary: { used_percent: 9.5, window_minutes: 10080, reset_at: 1791800000 } },
  credits: { has_credits: false, unlimited: false, balance: null },
};
const WHAM_USAGE = {
  plan_type: 'pro',
  rate_limit: {
    allowed: true, limit_reached: false,
    primary_window: { used_percent: 42, limit_window_seconds: 18000, reset_after_seconds: 3600, reset_at: 1791374400 },
    secondary_window: { used_percent: 84, limit_window_seconds: 604800, reset_after_seconds: 400000, reset_at: 1791800000 },
  },
  additional_rate_limits: [{ limit_name: 'codex_other', metered_feature: 'codex_other', rate_limit: { primary_window: { used_percent: 70, limit_window_seconds: 900, reset_after_seconds: 0, reset_at: 1791370000 }, secondary_window: null } }],
  credits: { has_credits: true, unlimited: false, balance: '9.99' },
};
const CLAUDE_USAGE = {
  session: { total_cost_usd: 0, total_api_duration_ms: 0, total_duration_ms: 0, total_lines_added: 0, total_lines_removed: 0, model_usage: {} },
  subscription_type: 'max',
  rate_limits_available: true,
  rate_limits: {
    five_hour: { utilization: 37, resets_at: '2026-10-07T18:00:00.000Z' },
    seven_day: { utilization: 64.4, resets_at: '2026-10-10T09:00:00.000Z' },
    seven_day_oauth_apps: null,
    seven_day_opus: { utilization: null, resets_at: null },
    model_scoped: [{ display_name: 'Fable', utilization: 12, resets_at: '2026-10-10T09:00:00.000Z' }],
    extra_usage: { is_enabled: false, monthly_limit: null, used_credits: null, utilization: null },
  },
  behaviors: null,
};

test('a window is named by its length', () => {
  assert.equal(windowName(300), '5 hours');
  assert.equal(windowName(10080), 'week');
  assert.equal(windowName(1440), 'day');
  assert.equal(windowName(15), '15 minutes');
  assert.equal(windowName(null), 'limit');
});

test('a reset time is read as seconds, milliseconds or an ISO date', () => {
  assert.equal(instant(1791374400), 1791374400000);
  assert.equal(instant('1791374400'), 1791374400000);
  assert.equal(instant(1791374400000), 1791374400000);
  assert.equal(instant('2026-10-07T18:00:00.000Z'), Date.parse('2026-10-07T18:00:00.000Z'));
  assert.equal(instant(null), null);
});

test('Codex response headers give the 5-hour and the weekly window, each with its length', () => {
  assert.deepEqual(codexFromHeaders(CODEX_HEADERS), [
    { name: '5 hours', used: 42.5, resetsAt: 1791374400000, windowDurationMins: 300 },
    { name: 'week', used: 12, resetsAt: 1791800000000, windowDurationMins: 10080 },
  ]);
  assert.equal(codexFromHeaders({ 'content-type': 'application/json', 'x-ratelimit-remaining-requests': '10' }), null, 'any other provider is passed over');
});

test('a further metered limit in the headers is named', () => {
  const windows = codexFromHeaders({ ...CODEX_HEADERS, 'x-codex-other-primary-used-percent': '5', 'x-codex-other-primary-window-minutes': '60', 'x-codex-other-limit-name': 'GPT-5.3 Codex Spark' });
  assert.deepEqual(windows.map(w => w.name), ['5 hours', 'week', 'GPT-5.3 Codex Spark · hour']);
});

test('the Codex WebSocket rate-limit event gives the same windows', () => {
  assert.deepEqual(codexFromEvent(CODEX_EVENT), [
    { name: '5 hours', used: 61, resetsAt: 1791374400000, windowDurationMins: 300 },
    { name: 'week', used: 9.5, resetsAt: 1791800000000, windowDurationMins: 10080 },
  ]);
  assert.equal(codexFromEvent({ type: 'response.output_text.delta', delta: 'hi' }), null);
});

test('the Codex usage endpoint gives the plan and every window', () => {
  assert.deepEqual(codexFromUsage(WHAM_USAGE), { plan: 'pro', windows: [
    { name: '5 hours', used: 42, resetsAt: 1791374400000, windowDurationMins: 300 },
    { name: 'week', used: 84, resetsAt: 1791800000000, windowDurationMins: 10080 },
    { name: 'codex other · 15 minutes', used: 70, resetsAt: 1791370000000, windowDurationMins: 15 },
  ] });
  assert.deepEqual(codexFromUsage({ plan_type: 'free', rate_limit: null }), { plan: 'free', windows: [] });
});

test('the ChatGPT account is read from the access token, which goes nowhere else', () => {
  const part = obj => Buffer.from(JSON.stringify(obj)).toString('base64url');
  const token = `${part({ alg: 'RS256' })}.${part({ 'https://api.openai.com/auth': { chatgpt_account_id: 'acct-1' } })}.sig`;
  assert.equal(chatgptAccount(token), 'acct-1');
  assert.equal(chatgptAccount('not a token'), null);
});

test('Claude Code’s /usage gives each window that has a figure', () => {
  assert.deepEqual(claudeFromUsage(CLAUDE_USAGE), { plan: 'max', signedIn: true, windows: [
    { name: '5 hours', used: 37, resetsAt: Date.parse('2026-10-07T18:00:00.000Z'), windowDurationMins: 300 },
    { name: 'week', used: 64.4, resetsAt: Date.parse('2026-10-10T09:00:00.000Z'), windowDurationMins: 10080 },
    { name: 'week · Fable', used: 12, resetsAt: Date.parse('2026-10-10T09:00:00.000Z'), windowDurationMins: 10080 },
  ] });
  assert.deepEqual(claudeFromUsage({ ...CLAUDE_USAGE, subscription_type: null, rate_limits_available: false, rate_limits: null }), { plan: null, signedIn: false, windows: [] });
  // Signed in, but its limits not read this time: an error, never "signed out".
  assert.throws(() => claudeFromUsage({ ...CLAUDE_USAGE, rate_limits: null }), /could not read its limits/);
});

test('a Claude rate-limit event is one window, its utilization a fraction', () => {
  assert.deepEqual(claudeFromEvent({ status: 'allowed_warning', rateLimitType: 'five_hour', utilization: 0.81, resetsAt: 1791374400 }),
    { key: 'five_hour', window: { name: '5 hours', used: 81, resetsAt: 1791374400000, windowDurationMins: 300 } });
  assert.equal(claudeFromEvent({ status: 'allowed' }), null, 'without a figure it says nothing');
});

// A model runtime as Pi's: signed in to openai-codex, its token known only here.
const piRuntime = ({ configured = true } = {}) => ({
  getProvider: id => (id === 'openai-codex' ? { id, baseUrl: 'https://chatgpt.com/backend-api' } : undefined),
  getProviderAuthStatus: () => ({ configured }),
  getAuth: async () => ({ auth: { apiKey: 'header.eyJodHRwczovL2FwaS5vcGVuYWkuY29tL2F1dGgiOnsiY2hhdGdwdF9hY2NvdW50X2lkIjoiYWNjdC0xIn19.sig' } }),
});

test('what Codex reported in the last minute is used without asking again', async () => {
  let t = 0;
  const store = createUsageStore({ now: () => t });
  const asked = [];
  const fetch = async (url, init) => { asked.push({ url, init }); return { ok: true, status: 200, json: async () => WHAM_USAGE }; };
  store.codexEvent(CODEX_EVENT);
  assert.deepEqual((await piUsage({ modelRuntime: piRuntime(), store, fetch })).windows.map(w => w.used), [61, 9.5]);
  assert.equal(asked.length, 0);
  t = 61_000;
  const read = await piUsage({ modelRuntime: piRuntime(), store, fetch });
  assert.equal(read.plan, 'pro');
  assert.equal(asked.length, 1);
  assert.equal(asked[0].url, 'https://chatgpt.com/backend-api/wham/usage');
  assert.equal(asked[0].init.headers['ChatGPT-Account-Id'], 'acct-1');
  t = 90_000;
  await piUsage({ modelRuntime: piRuntime(), store, fetch });
  assert.equal(asked.length, 1, 'the answer is kept for a minute');
  t = 125_000;
  await piUsage({ modelRuntime: piRuntime(), store, fetch });
  assert.equal(asked.length, 2);
});

test('Pi not signed in to ChatGPT says so without asking anything', async () => {
  const fetch = async () => { throw new Error('should not ask'); };
  assert.deepEqual(await piUsage({ modelRuntime: piRuntime({ configured: false }), store: createUsageStore(), fetch }), { signedIn: false });
});

test('a sign-in ChatGPT refuses is not signed in', async () => {
  const fetch = async () => ({ ok: false, status: 401, json: async () => ({}) });
  assert.deepEqual(await piUsage({ modelRuntime: piRuntime(), store: createUsageStore(), fetch }), { signedIn: false });
});

test('Claude Code is asked for its /usage once a minute, and its events stand in when it cannot say', async () => {
  let t = 0, asked = 0;
  const store = createUsageStore({ now: () => t });
  const query = { usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: async opts => { asked++; assert.deepEqual(opts, { skipBehaviors: true }); return CLAUDE_USAGE; } };
  assert.equal((await claudeUsage({ query, store })).windows.length, 3);
  await claudeUsage({ query, store });
  assert.equal(asked, 1);

  const failing = createUsageStore({ now: () => t });
  const broken = { usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: async () => { throw new Error('offline'); } };
  await assert.rejects(claudeUsage({ query: broken, store: failing }), /offline/);
  failing.claudeEvent({ status: 'allowed', rateLimitType: 'seven_day', utilization: 0.5, resetsAt: 1791800000 });
  assert.deepEqual(await claudeUsage({ query: broken, store: failing }), { signedIn: true, windows: [{ name: 'week', used: 50, resetsAt: 1791800000000, windowDurationMins: 10080 }] });
});
