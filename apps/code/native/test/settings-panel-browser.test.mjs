import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { harnessFixture, readBody } from './fixtures/harness-page.mjs';
import { openUsage, usageArtifacts } from './fixtures/usage-controls.mjs';
import { themeCss } from '../../../../system/theme.mjs';
import { aggregateUsage } from '../usage-history.mjs';

const themeCSS = themeCss(JSON.parse(await readFile(new URL('./fixtures/themes/black.json', import.meta.url), 'utf8')));
const messages = [{ role: 'user', content: 'Keep this conversation here.' }, { role: 'assistant', content: [{ type: 'text', text: 'The conversation and its draft stay in the middle.' }] }];
const shots = usageArtifacts('settings-panel');
const bounds = async (page, selector) => {
  await page.evaluate(() => { for (const a of document.getAnimations()) if (Number.isFinite(a.effect?.getComputedTiming().endTime)) a.finish(); });
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  return page.locator(selector).first().evaluate(n => { const r = n.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });
};
const settings = async page => {
  const row = page.locator('.session-rail-settings');
  if (!await row.isVisible()) await page.evaluate(() => harness.toggleRail());
  await row.click();
  await page.locator('.settings-sheet').waitFor({ state: 'visible' });
  await page.waitForFunction(() => !document.querySelector('#entry-terminal.phone-layout') || Math.abs(document.querySelector('.wm-settings').getBoundingClientRect().x) < 1);
  await page.getByRole('button', { name: 'Automatic', exact: true }).waitFor();
  await bounds(page, '.wm-settings');
};
async function fixture(t, phone = false, kinso = false) {
  const themes = [];
  const f = await harnessFixture({ desk: !phone, hasTouch: phone, viewport: phone ? { width: 390, height: 844 } : { width: 1920, height: 1080 }, messages, themeCSS,
    handleRequest: async (req, res, path) => {
      if (path === '/inbox/list' || path === '/inbox/search') {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ state: 'ready', accounts: [{ id: 'fixture-account', source: 'whatsapp', label: 'Fixture' }], conversations: [{ key: 'chat:fixture', kind: 'chat', source: 'whatsapp', account: 'fixture-account', name: 'Fixture conversation', preview: 'Fixture only', at: Date.now() }] })); return true;
      }
      if (path === '/themes.json') {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ auto: true, themes: [{ id: 'black', name: 'Black', background: '#000000', foreground: '#eeeeee', accent: '#999999' }] })); return true;
      }
      if (path === '/theme') { themes.push(await readBody(req)); res.end('{}'); return true; }
      return false;
    }, snapshot: { auth: { providers: [], busy: false, configured: true, status: 'idle' } } });
  t.after(() => f.close());
  if (kinso) {
    // The fixture uses the same production entrypoint, with the actual variant.
    await f.page.evaluate(() => sessionStorage.setItem('imperfect.for', 'kinso'));
    await f.page.reload();
    await f.page.evaluate(async () => { const { mountGueyPi } = await import('/js/harness.js'); window.harness = mountGueyPi({ hooks: { canFocus: () => true } }); });
    await f.page.locator('#entry-output .gui-assistant').waitFor();
  }
  await f.page.addStyleTag({ content: 'html body #entry-terminal { height: 100vh !important; }' });
  f.answer = c => c.type === 'usage' ? [{ agent: 'pi', signedIn: true, accountId: 'fixture-only', windows: [{ name: 'week', used: 24, resetsAt: Date.now() + 86400000, windowDurationMins: 10080 }], resetCredits: { availableCount: 1, nextCreditId: 'fixture-credit', nextExpiresAt: Date.now() + 86400000 } }] : c.type === 'usage-history' ? { ...aggregateUsage([], { owner: 'fixture' }), historyCoverage: { complete: true } } : c.type === 'auth_providers' ? [] : undefined;
  await mkdir(shots, { recursive: true });
  f.themes = themes;
  return f;
}

for (const phone of [false, true]) test(`Settings and Usage share the existing panel; draft, features and state survive (${phone ? 'phone' : '1920'})`, { timeout: 90000 }, async t => {
  const f = await fixture(t, phone); const { page } = f;
  await page.locator('#entry-input').fill('Unsent draft.');
  const original = await bounds(page, '.entry-screen');
  const panel = phone ? null : await bounds(page, '.wm-files');
  await settings(page);
  if (phone) await page.waitForFunction(() => Math.abs(document.querySelector('.wm-settings').getBoundingClientRect().x) < 1);
  else {
    assert.deepEqual(await bounds(page, '.wm-settings'), panel);
    assert.deepEqual(await bounds(page, '.entry-screen'), original);
    assert.equal(await page.locator('#entry-output').evaluate(n => n.inert), false);
    assert.equal(await page.locator('#entry-output').isVisible(), true);
  }
  assert.equal(await page.locator('dialog.settings-sheet, .entry-screen .settings-sheet').count(), 0);
  assert.equal(await page.locator('.settings-sheet').getByRole('button', { name: 'Sign in to a provider', exact: false }).count(), 1);
  assert.ok(await page.locator('.settings-key').count() > 8);
  await Promise.all([page.waitForResponse(r => new URL(r.url()).pathname === '/theme'), page.getByRole('button', { name: 'Black', exact: true }).click()]);
  assert.deepEqual(f.themes, [{ id: 'black' }]);
  const body = page.locator('.settings-body');
  await page.screenshot({ path: join(shots, `settings-${phone ? 'phone' : '1920'}.png`) });
  await body.evaluate(n => { n.scrollTop = 120; });
  const scroll = await body.evaluate(n => n.scrollTop);
  if (phone && !await page.locator('.session-rail-usage').isVisible()) await page.evaluate(() => harness.toggleRail());
  await openUsage(page);
  if (phone) await page.waitForFunction(() => Math.abs(document.querySelector('.wm-usage').getBoundingClientRect().x) < 1);
  else assert.deepEqual(await bounds(page, '.wm-usage'), panel);
  await page.locator('.usage-box').getByRole('meter').waitFor();
  assert.equal(await page.locator('.wm-settings').isVisible(), phone); // Phone strip keeps all columns, desktop tucks the others.
  assert.equal(await page.locator('.entry-screen .usage-box').count(), 0);
  await bounds(page, '.wm-usage');
  await page.screenshot({ path: join(shots, `usage-${phone ? 'phone' : '1920'}.png`) });
  // Explicit, cancellable reset confirmation, never sent to a real provider.
  await page.getByRole('button', { name: 'Use reset', exact: true }).click();
  const confirm = page.getByRole('group', { name: 'Confirm Codex reset' });
  await confirm.waitFor();
  await page.keyboard.press('Escape');
  assert.equal(await confirm.count(), 0);
  assert.equal(await page.locator('.usage-box').count(), 1);
  await page.getByRole('group', { name: 'Usage metric' }).getByRole('button', { name: 'Graphs', exact: true }).click();
  await page.getByText('No recorded activity in this range.', { exact: true }).waitFor();
  await settings(page);
  assert.equal(await body.evaluate(n => n.scrollTop), scroll);
  assert.equal(await page.getByRole('button', { name: 'Black', exact: true }).getAttribute('aria-pressed'), 'true');
  if (phone && !await page.locator('.session-rail-usage').isVisible()) await page.evaluate(() => harness.toggleRail());
  await openUsage(page);
  await page.waitForFunction(() => !document.querySelector('#entry-terminal.phone-layout') || Math.abs(document.querySelector('.wm-usage').getBoundingClientRect().x) < 1);
  assert.equal(await page.getByRole('group', { name: 'Usage metric' }).getByRole('button', { name: 'Graphs', exact: true }).getAttribute('aria-pressed'), 'true');
  if (!phone) {
    // Existing Files/browser/Messages and their content survive utility modes.
    await page.evaluate(() => harness.showFiles());
    assert.equal(await page.locator('.wm-usage').isVisible(), false);
    await page.evaluate(() => browseFromWindow({ url: 'https://fixture.example/' }));
    await page.locator('.wm-browser webview').waitFor();
    await page.locator('.wm-browser webview').evaluate(n => { n.kept = true; });
    await settings(page); await openUsage(page);
    assert.equal(await page.locator('.wm-browser webview').evaluate(n => n.kept), true);
    await page.evaluate(() => harness.showMessages({}));
    const search = page.getByRole('searchbox', { name: 'Search messages', exact: true });
    await search.fill('Retained search');
    await settings(page); await openUsage(page);
    assert.equal(await page.locator('.wm-messages').isVisible(), false);
    await page.evaluate(() => harness.showMessages({}));
    assert.equal(await search.inputValue(), 'Retained search');
    await openUsage(page);
    // Typing in the middle still works with Usage open. Escape there belongs
    // to the conversation, not a background utility panel.
    await page.locator('#entry-input').fill('Still unsent.');
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('.usage-box').isVisible(), true);
    await page.locator('.usage-back').focus();
    await page.keyboard.press('Meta+f');
    assert.equal(await page.locator('#entry-terminal.focus-full-panel').count(), 1);
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#entry-terminal.focus-full-panel').count(), 0);
    assert.equal(await page.locator('.usage-box').count(), 1);
  }
  await page.locator('.usage-back').click();
  await page.waitForFunction(() => !document.querySelector('.usage-box'));
  if (phone) await page.waitForFunction(() => Math.abs(document.querySelector('.entry-screen').getBoundingClientRect().x) < 1);
  assert.equal(await page.locator('#entry-input').inputValue(), phone ? 'Unsent draft.' : 'Still unsent.');
  await settings(page);
  if (phone) {
    await page.waitForFunction(() => history.state?.window === true);
    await page.goBack();
  } else await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.querySelector('.wm-settings') || !document.querySelector('.wm-settings').isConnected);
  assert.ok(!f.commands.some(c => ['prompt', 'auth_login', 'auth_logout', 'codex-reset-consume'].includes(c.type)));
  assert.deepEqual(f.errors, []);
});

for (const phone of [false, true]) test(`Kinso uses the same utility panel and keeps its conversation (${phone ? 'phone' : '1920'})`, { timeout: 90000 }, async t => {
  const f = await fixture(t, phone, true); const { page } = f;
  await page.locator('#entry-input').fill('Kinso unsent draft');
  await settings(page);
  await page.screenshot({ path: join(shots, `kinso-settings-${phone ? 'phone' : '1920'}.png`) });
  assert.equal(await page.locator(phone ? '.wm-settings' : '.wm-settings.wm-in-panel').count(), 1);
  await page.getByRole('button', { name: 'Usage and limits', exact: false }).click();
  await page.locator('.wm-usage .usage-box').getByRole('meter').waitFor();
  await page.waitForFunction(() => !document.querySelector('#entry-terminal.phone-layout') || Math.abs(document.querySelector('.wm-usage').getBoundingClientRect().x) < 1);
  assert.equal(await page.locator('#entry-input').inputValue(), 'Kinso unsent draft');
  assert.equal(await page.locator('#entry-output').isVisible(), true);
  await bounds(page, '.wm-usage');
  await page.screenshot({ path: join(shots, `kinso-usage-${phone ? 'phone' : '1920'}.png`) });
  assert.deepEqual(f.errors, []);
});

test('Settings keeps model/account actions session-bound and never starts authorization merely by opening', { timeout: 90000 }, async t => {
  const f = await fixture(t); const { page } = f;
  let release;
  f.answer = c => c.type === 'models' ? new Promise(resolve => { release = resolve; }) : c.type === 'auth_providers' || c.type === 'auth_accounts' ? [] : undefined;
  await settings(page);
  assert.equal(f.commands.some(c => c.type.startsWith('auth_') || c.type === 'models'), false);
  await page.getByRole('button', { name: 'Choose a model', exact: false }).click();
  await page.waitForFunction(() => !document.querySelector('.settings-sheet') || !document.querySelector('.settings-sheet').isConnected);
  const deadline = Date.now() + 10000;
  while (!release && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(release, 'model command reached the fixture');
  const request = f.commands.find(c => c.type === 'models');
  assert.equal(request.expectedSessionId, 'thread-a'); assert.equal(request.expectedTabId, 'tab-a');
  f.push({ ...f.tab, sessionId: 'thread-b', tabs: [{ ...f.tab.tabs[0], id: 'tab-b', sessionId: 'thread-b' }] });
  await page.waitForFunction(() => harness.guiSnapshot().sessionId === 'thread-b');
  release([{ provider: 'fixture', id: 'old-model' }]);
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(await page.locator('.model-picker:not([hidden])').count(), 0, 'late model list never applies to another session');
  await settings(page);
  await page.getByRole('button', { name: 'Sign in to a provider', exact: false }).click();
  await page.locator('.guey-auth[open]').getByRole('button', { name: 'Use a subscription / sign in', exact: true }).waitFor();
  assert.equal(f.commands.some(c => c.type === 'auth_login'), false);
  await page.locator('.guey-auth[open]').getByRole('button', { name: 'Not now', exact: true }).click();
  await settings(page);
  await page.getByRole('button', { name: 'Sign out of a provider', exact: false }).click();
  await page.locator('.guey-auth[open]').getByRole('heading', { name: 'Sign out of a provider' }).waitFor();
  assert.equal(f.commands.some(c => c.type === 'auth_logout'), false);
  await page.locator('.guey-auth[open]').getByRole('button', { name: 'Close', exact: true }).click();
  assert.deepEqual(f.errors, []);
});
