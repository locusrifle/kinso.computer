import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resetText, usageSections, remainingPercent, windowTimeLeft, readUsagePreferences, paceOf, usageFoot, footRows, paceWords, todayUsage, tokenCount, dollars, shortLeft } from '../public/js/usage.js';
const NOW = Date.parse('2026-10-09T12:00:00Z');
test('T3 default Limits and validated metric/period preferences never store personal metadata', () => {
  assert.deepEqual(readUsagePreferences({ getItem: () => null }), { metric: 'limits', period: 30 });
  assert.deepEqual(readUsagePreferences({ getItem: () => '{invalid' }), { metric: 'limits', period: 30 });
  assert.deepEqual(readUsagePreferences({ getItem: () => JSON.stringify({ metric: 'cost', period: 7, owner: 'private' }) }), { metric: 'cost', period: 7 });
  assert.deepEqual(readUsagePreferences({ getItem: () => JSON.stringify({ metric: 'billing', period: 1 }) }), { metric: 'limits', period: 30 });
});

test('T3 countdowns and remaining quota use reported values, never fabricated limits', () => {
  assert.equal(resetText(NOW + 40 * 60000, NOW), 'resets in 40m');
  assert.equal(resetText(NOW + 130 * 60000, NOW), 'resets in 2h 10m');
  assert.equal(resetText(NOW + 3 * 86400000, NOW), 'resets in 3d 0h');
  assert.equal(resetText(NOW - 1, NOW), 'resets now');
  assert.equal(resetText(null, NOW), '');
  assert.equal(remainingPercent(37.4), 63);
  assert.equal(remainingPercent(200), 0); assert.equal(remainingPercent(-2), 100);
  for (const v of [null, undefined, NaN, Infinity, '37', false]) assert.equal(remainingPercent(v), null);
  assert.equal(windowTimeLeft({ resetsAt: NOW + 60 * 60000, windowDurationMins: 120 }, NOW), 50);
  assert.equal(windowTimeLeft({ resetsAt: NOW + 60 * 60000 }, NOW), null);
  assert.equal(windowTimeLeft({ resetsAt: NOW - 1, windowDurationMins: 120 }, NOW), 0);
});

test('provider sections retain sign-in and sanitized failure states', () => {
  assert.deepEqual(usageSections([
    { agent: 'pi', signedIn: false },
    { agent: 'claude', signedIn: true, plan: 'max', windows: [{ name: '5 hours', used: 37.4, resetsAt: NOW + 40 * 60000 }] },
  ], NOW), [
    { title: 'ChatGPT', line: 'Not signed in to ChatGPT here · sign in from Settings (Pi) or with codex login' },
    { title: 'Claude · max', windows: [{ name: '5 hours', remaining: 63, reset: 'resets in 40m', resetsAt: NOW + 40 * 60000, timeLeft: null, windowDurationMins: null }] },
  ]);
  assert.deepEqual(usageSections([{ agent: 'claude', error: 'private exception' }]), [{ title: 'Claude', line: 'Limits unavailable · try Refresh' }]);
  assert.deepEqual(usageSections([{ agent: 'claude', signedIn: true }]), [{ title: 'Claude', line: 'No limits reported.' }]);
  assert.deepEqual(usageSections(null), []);
});

test('ledger retains its dock position and independent authority routing; history is lazy for Limits', async () => {
  const source = await readFile(new URL('../public/js/harness.js', import.meta.url), 'utf8');
  assert.match(source, /dock\.prepend\(usageView\.button, browser, voice\.button\)/);
  assert.match(source, /usageOwner\(machineRows, usageAuthority, localOnly\)/);
  assert.match(source, /sendUsage\(owner, type, \{ \.\.\.fields, scope: 'computer' \}\)/);
  const usage = await readFile(new URL('../public/js/usage.js', import.meta.url), 'utf8');
  assert.match(usage, /command\(metric === 'limits' \? 'usage' : 'usage-history'\)/);
  assert.doesNotMatch(usage, /usage-chart|paintHistory|selectedTab/);
});

test('the sidebar foot: each week a ring, the rest lines, each paced against even spending', () => {
  const HOUR = 3_600_000, DAY = 24 * HOUR;
  const answer = [
    // ChatGPT: 51% of its week used with only 30% of it gone, so ahead.
    { agent: 'pi', signedIn: true, plan: 'prolite', windows: [{ name: 'week', used: 51, resetsAt: NOW + 4.9 * DAY, windowDurationMins: 10080 }] },
    { agent: 'claude', signedIn: true, plan: 'pro', windows: [
      { name: '5 hours', used: 45, resetsAt: NOW + 0.3 * HOUR, windowDurationMins: 300 },
      { name: 'week', used: 10, resetsAt: NOW + 6.1 * DAY, windowDurationMins: 10080 },
      { name: 'week · Fable', used: 0, resetsAt: NOW + 6.1 * DAY, windowDurationMins: 10080 },
      { name: 'limit', used: null },
    ] },
  ];
  const { rings, lines } = usageFoot(answer, NOW);
  assert.deepEqual(rings.map(w => [w.account, w.name, w.remaining]), [['ChatGPT', 'week', 49], ['Claude', 'week', 90]]);
  assert.deepEqual(lines.map(w => [w.label, w.remaining]), [['Claude 5 hours', 55], ['Claude Fable week', 100]], 'a window with no figure is left out');
  const [chatgpt, claude] = rings;
  assert.equal(Math.round(chatgpt.pace.timeLeft), 70); assert.equal(chatgpt.pace.ahead, true);
  // 51% in 2.1 days is 24% a day: the 49% left lasts about two more days.
  assert.ok(Math.abs(chatgpt.pace.runsOutAt - (NOW + 49 / (51 / (2.1 * DAY)))) < 1000);
  assert.equal(claude.pace.ahead, false); assert.equal(claude.pace.runsOutAt, null);
  assert.equal(Math.round(claude.pace.perDay), 15, '90% over 6.1 days');
  assert.equal(lines[0].pace.perDay, null, 'under a day left: no daily figure');
  // Early in a window, no rate is read from the little used so far.
  assert.equal(paceOf({ remaining: 80, resetsAt: NOW + 4.9 * HOUR, windowDurationMins: 300 }, NOW).ahead, false);
  assert.equal(paceOf({ remaining: 80, resetsAt: NOW + HOUR }, NOW), null, 'no length, no pace');
});

test('the sidebar foot is a table: Claude, then ChatGPT, each one\'s own windows, short, paced in words', () => {
  const HOUR = 3_600_000, DAY = 24 * HOUR;
  const answer = [
    { agent: 'pi', signedIn: true, plan: 'prolite', windows: [{ name: 'week', used: 51, resetsAt: NOW + 4.9 * DAY, windowDurationMins: 10080 }] },
    { agent: 'claude', signedIn: true, plan: 'pro', windows: [
      { name: '5 hours', used: 45, resetsAt: NOW + 0.3 * HOUR, windowDurationMins: 300 },
      { name: 'week', used: 10, resetsAt: NOW + 6.1 * DAY, windowDurationMins: 10080 },
      { name: 'week · Fable', used: 0, resetsAt: NOW + 6.1 * DAY, windowDurationMins: 10080 },
      { name: 'limit', used: null },
    ] },
    { agent: 'mystery', signedIn: true, windows: [{ name: 'week', used: 1 }] },
  ];
  const rows = footRows(answer, NOW);
  assert.deepEqual(rows.map(w => [w.account, w.short, w.remaining]), [['Claude', '5h', 55], ['Claude', 'week', 90], ['ChatGPT', 'week', 49]],
    'a model\'s own week, a window with no figure and an unknown subscription are left to the panel');
  assert.equal(rows[2].pace.ahead, true);
  assert.match(paceWords(rows[2].pace), /^Faster than even spending · runs out .+, before it resets$/);
  assert.equal(paceWords(rows[1].pace), 'On pace · 15% a day lasts until it resets');
  assert.equal(paceWords(rows[0].pace), 'On pace', 'under a day left: no daily figure');
  assert.equal(paceWords(null), '');
  assert.deepEqual(footRows(null, NOW), []);
});

test('today is counted from this window\'s own midnight, from the hours; an older computer\'s UTC days still count', () => {
  const now = new Date(2026, 9, 17, 20, 0).getTime(), midnight = new Date(2026, 9, 17).getTime(), HOUR = 3_600_000;
  const hours = [
    { at: midnight - HOUR, tokens: 5, estimatedUSD: 1, responses: 1 },
    { at: midnight, tokens: 100, estimatedUSD: 2, responses: 3 },
    { at: midnight + 5 * HOUR, tokens: 50, estimatedUSD: 0.5, responses: 2 },
    { at: midnight - 10 * 24 * HOUR, tokens: 999, estimatedUSD: 9, responses: 9 },
  ];
  const seen = todayUsage({ hours }, now);
  assert.deepEqual([seen.today.tokens, seen.today.responses, seen.today.estimatedUSD], [150, 5, 2.5]);
  assert.equal(seen.days.length, 7); assert.equal(seen.days[5].tokens, 5); assert.equal(seen.weekUSD, 3.5);
  const older = todayUsage({ days: [{ key: '2026-10-17', tokens: { input: 7, output: 3 }, estimatedUSD: 1, responses: 2 }] }, now);
  assert.deepEqual([older.today.tokens, older.today.responses], [10, 2]);
  assert.equal(todayUsage(null, now), null);
  assert.deepEqual([tokenCount(236468408), tokenCount(1200), tokenCount(12345678901), tokenCount(999), tokenCount(1e6)], ['236M', '1.2k', '12B', '999', '1M']);
  assert.deepEqual([dollars(80.05), dollars(0.13), dollars(1234.4)], ['$80', '$0.13', '$1,234']);
  assert.deepEqual([shortLeft(6 * 24 * HOUR + HOUR), shortLeft(28.8 * HOUR), shortLeft(18 * 60000)], ['6d', '1d 4h', '18m']);
});


test('Settings and Usage are wm panel modes, not a modal or a conversation replacement', async () => {
  const source = await readFile(new URL('../public/js/harness.js', import.meta.url), 'utf8');
  const settings = await readFile(new URL('../public/js/settings.js', import.meta.url), 'utf8');
  assert.match(source, /kind: 'settings', body/);
  assert.match(source, /kind: 'usage', body: usageHost/);
  assert.match(source, /panel: usageHost/);
  assert.doesNotMatch(source, /middle\.classList\.(?:add|contains)\('usage-open'\)/);
  assert.match(settings, /el\('section', 'settings-sheet'\)/);
  assert.doesNotMatch(settings, /showModal|document\.body\.append|Promise\.resolve\(\)\.then\(action\)/);
  for (const action of ['signIn', 'signOut', 'chooseModel', 'usage']) assert.match(settings, new RegExp(`then\\(${action}\\)`));
});
