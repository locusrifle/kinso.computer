import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { launchChromium } from '../../../../tools/test-browser.mjs';
import { harnessFixture } from './fixtures/harness-page.mjs';
import { themeCss } from '../../../../system/theme.mjs';

const messages = [{ role: 'assistant', content: [{ type: 'text', text: 'Ready' }] }];
const STILLS = process.env.USAGE_DRAIN_STILLS;
for (const [theme, fixture] of [['dark', 'black'], ['light', 'light-chalk']]) test(`usage foot: live subscriptions, observed drops, easing and reduced motion (${theme})`, async t => {
  const themeCSS = themeCss(JSON.parse(await readFile(new URL(`fixtures/themes/${fixture}.json`, import.meta.url), 'utf8')));
  const browser = await launchChromium({ headless: true, args: ['--no-sandbox'] });
  let f;
  t.after(async () => { try { await f?.close(); } finally { await browser.close(); } });
  f = await harnessFixture({ desk: true, messages, themeCSS, browser: { newPage: options => browser.newPage({ ...options, deviceScaleFactor: STILLS ? 2 : 1 }) } });
  const { page } = f;
  const resetsAt = Date.now() + 4 * 3600000;
  let chatUsed = 20;
  const limits = () => [
    { agent: 'claude', signedIn: true, windows: [{ name: '5 hours', used: 8, resetsAt, windowDurationMins: 300 }, { name: 'week', used: 12, resetsAt: resetsAt + 6 * 86400000, windowDurationMins: 10080 }] },
    { agent: 'pi', signedIn: true, windows: [{ name: 'week', used: chatUsed, resetsAt: resetsAt + 6 * 86400000, windowDurationMins: 10080 }] },
  ];
  f.answer = c => c.type === 'usage' ? limits() : c.type === 'usage-history' ? null : undefined;
  // Capture only the usage module's existing tick. Allows deterministic expiry
  // and polling assertions without spending real minutes or adding app timers.
  await page.evaluate(async () => {
    const { mountUsage } = await import('/js/usage.js');
    const interval = globalThis.setInterval, timeout = globalThis.setTimeout;
    globalThis.setTimeout = (fn, ms, ...args) => ms === 1500 ? 0 : timeout(fn, ms, ...args);
    globalThis.setInterval = (fn, ms, ...args) => { if (ms === 30000) globalThis.usageTick = fn; return interval(fn, ms, ...args); };
    const original = document.querySelector('.session-rail-usage');
    original.remove();
    const commands = [];
    globalThis.drainTabs = [];
    globalThis.drainAnswer = [];
    globalThis.drainUsage = mountUsage({ tabs: () => drainTabs, cacheIdentity: () => 'drain-fixture', command: async type => { commands.push(type); return type === 'usage' ? drainAnswer : null; } });
    globalThis.drainCommands = commands;
    drainUsage.summary.classList.add('session-rail-usage');
    document.querySelector('.session-rail-foot').append(drainUsage.summary);
    globalThis.setInterval = interval; globalThis.setTimeout = timeout;
    const now = Date.now;
    globalThis.drainTime = 0; Date.now = () => now() + drainTime;
  });
  await page.evaluate(answer => { drainAnswer = answer; usageTick(); }, limits());
  const rows = page.locator('.session-rail-usage .usage-row');
  const claude = rows.filter({ hasText: 'Claude 5h' }), chat = rows.filter({ hasText: 'ChatGPT' });
  await page.waitForFunction(() => document.querySelectorAll('.session-rail-usage .usage-row').length === 3);
  assert.equal(await page.locator('.session-rail-usage .usage-row[data-draining="true"]').count(), 0);
  assert.equal(await claude.getAttribute('data-draining'), 'false');
  const animation = row => row.locator('.usage-row-fill').evaluate(n => ({ name: getComputedStyle(n, '::after').animationName, duration: getComputedStyle(n, '::after').animationDuration, transform: getComputedStyle(n, '::after').transform, transition: getComputedStyle(n).transitionDuration, colour: getComputedStyle(n).backgroundColor }));
  assert.equal((await animation(claude)).name, 'none');
  assert.equal((await animation(claude)).transition, '0s', 'idle rows have no motion, including on refills');
  if (STILLS) await mkdir(STILLS, { recursive: true });
  const shot = async name => { if (STILLS) await page.locator('.session-rail-foot').screenshot({ path: `${STILLS}/${theme}-${name}.png`, animations: 'allow' }); };
  await shot('idle');
  await page.evaluate(() => { drainTabs = [{ agent: 'claude', status: 'working', owner: 'other-computer' }]; drainUsage.syncActivity(); });
  assert.equal(await claude.getAttribute('data-draining'), 'true');
  assert.match(await claude.getAttribute('title'), /Claude 5h: 92% left, being used now/);
  assert.match(await page.locator('.session-rail-usage').getAttribute('aria-label'), /being used now/);
  assert.equal((await animation(claude)).name, 'usage-drain');
  assert.equal((await animation(claude)).duration, '1.6s');
  assert.equal(await chat.getAttribute('data-draining'), 'false');
  await page.waitForTimeout(650);
  await shot('claude-draining');
  // The same DOM fill survives readings, so 600ms width transitions can run.
  await claude.locator('.usage-row-fill').evaluate(n => { globalThis.originalFill = n; });
  await page.evaluate(() => { drainTime += 31000; usageTick(); });
  assert.equal(await page.evaluate(() => drainCommands.filter(c => c === 'usage').length), 2, 'working sessions switch the existing tick to 30s reads');
  chatUsed = 28;
  await page.evaluate(answer => { drainAnswer = answer; drainTime += 31000; usageTick(); }, limits());
  await page.waitForFunction(() => [...document.querySelectorAll('.usage-row')].some(n => n.textContent.includes('ChatGPT') && n.dataset.draining === 'true'));
  assert.equal(await claude.locator('.usage-row-fill').evaluate(n => n === originalFill), true);
  assert.equal((await animation(chat)).transition, '0.6s');
  assert.ok(await chat.locator('.usage-row-fill').evaluate(n => n.getAnimations().some(a => a.transitionProperty === 'width')), 'a drop eases instead of replacing the fill');
  await page.waitForTimeout(650);
  await shot('chatgpt-drop');
  if (STILLS) {
    const fill = chat.locator('.usage-row-fill');
    await fill.evaluate(n => { const a = n.getAnimations({ subtree: true }).find(a => a.animationName === 'usage-drain'); a.pause(); a.currentTime = 0; globalThis.drainAnimation = a; });
    for (let i = 0; i < 8; i++) { await page.evaluate(i => { drainAnimation.currentTime = i * 200; }, i); await shot(`motion-${String(i).padStart(2, '0')}`); }
    await page.evaluate(() => drainAnimation.play());
  }
  chatUsed = 90;
  await page.evaluate(answer => { drainAnswer = answer; drainTime += 31000; usageTick(); }, limits());
  await page.waitForFunction(() => [...document.querySelectorAll('.usage-row')].some(n => n.textContent.includes('ChatGPT') && n.dataset.low === 'true'));
  await page.waitForTimeout(650);
  assert.equal(await chat.getAttribute('data-draining'), 'true');
  const lowColour = (await animation(chat)).colour;
  assert.equal(await chat.locator('.usage-row-fill').evaluate(n => getComputedStyle(n).animationName), 'usage-drain-breathe', 'a low fill is too short for the band, so it breathes too');
  await shot('low-draining');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  assert.equal((await animation(chat)).name, 'none');
  assert.equal((await animation(chat)).transform, 'none');
  assert.equal((await animation(chat)).colour, lowColour, 'low-quota red keeps its meaning');
  assert.equal(await chat.locator('.usage-row-fill').evaluate(n => getComputedStyle(n).animationName), 'none', 'reduced motion: the low fill is still');
  await shot('reduced-motion');
  await page.evaluate(() => { drainUsage.button.click(); });
  await page.waitForFunction(() => document.querySelector('.usage-window[data-account="ChatGPT"]')?.dataset.draining === 'true');
  assert.match(await page.locator('.usage-window[data-account="ChatGPT"] [role="meter"]').getAttribute('aria-valuetext'), /being used now/);
  assert.equal(await page.locator('.usage-window[data-account="ChatGPT"] .usage-fill').evaluate(n => getComputedStyle(n, '::after').animationName), 'none');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  assert.equal(await page.locator('.usage-window[data-account="ChatGPT"] .usage-fill').evaluate(n => getComputedStyle(n, '::after').animationName), 'usage-drain');
  chatUsed = 95;
  await page.evaluate(answer => { drainAnswer = answer; }, limits());
  await page.locator('.usage-box .usage-refresh').click();
  await page.waitForFunction(() => document.querySelector('.usage-window[data-account="ChatGPT"] [aria-valuenow="5"]'));
  assert.ok(await page.locator('.usage-window[data-account="ChatGPT"] .usage-fill').evaluate(n => n.getAnimations().some(a => a.transitionProperty === 'width')), 'the Usage page also eases falling readings');
  await page.evaluate(() => drainUsage.close());
  await page.evaluate(() => { drainTabs = []; drainUsage.syncActivity(); drainTime += 90001; usageTick(); });
  assert.equal(await claude.getAttribute('data-draining'), 'false');
  assert.equal(await chat.getAttribute('data-draining'), 'false');
  const count = await page.evaluate(() => drainCommands.filter(c => c === 'usage').length);
  await page.evaluate(() => { drainTime += 31000; usageTick(); });
  assert.equal(await page.evaluate(() => drainCommands.filter(c => c === 'usage').length), count, 'idle returns to 3-minute reads');
  assert.deepEqual(f.errors, []);
});

test('real harness snapshots immediately drain Claude, Codex and subscription Pi tabs, including another computer', async t => {
  const f = await harnessFixture({ messages, machines: [{ id: 'pc', self: true, reachable: true }, { id: 'laptop', name: 'Laptop', reachable: true }] });
  t.after(() => f.close());
  const resetsAt = Date.now() + 3600000;
  f.answer = c => c.type === 'usage' ? ['claude', 'pi'].map(agent => ({ agent, signedIn: true, windows: [{ name: 'week', used: 20, resetsAt }] })) : undefined;
  await f.page.locator('.session-rail-usage').click();
  await f.page.locator('.usage-window').first().waitFor();
  await f.page.getByRole('button', { name: 'Back to conversation', exact: true }).click();
  for (const [agent, provider, account] of [['claude', null, 'Claude'], ['codex', null, 'ChatGPT'], ['pi', 'claude-agent', 'Claude'], ['pi', 'openai-codex', 'ChatGPT'], ['pi', 'anthropic', null]]) {
    const next = { ...f.tab, tabs: [{ ...f.tab.tabs[0], agent, provider, status: 'working' }] };
    f.push(next);
    if (account) await f.page.waitForFunction(account => [...document.querySelectorAll('.usage-row')].some(n => n.textContent.includes(account) && n.dataset.draining === 'true'), account);
    else await f.page.waitForFunction(() => !document.querySelector('.usage-row[data-draining="true"]'));
  }
  f.sendFrom('laptop', { type: 'snapshot', data: { ...f.tab, tabs: [{ id: 'remote', agent: 'claude', status: 'working' }] } });
  await f.page.waitForFunction(() => [...document.querySelectorAll('.usage-row')].some(n => n.textContent.includes('Claude') && n.dataset.draining === 'true'));
  assert.deepEqual(f.errors, []);
});
