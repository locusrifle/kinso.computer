import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { harnessFixture } from './fixtures/harness-page.mjs';
import { usageArtifacts } from './fixtures/usage-controls.mjs';
import { themeCss } from '../../../../system/theme.mjs';

const kinso = 'https://computer.kinso.computer';
const shots = usageArtifacts('auth-cold-start');
const themeCSS = themeCss(JSON.parse(await readFile(new URL('./fixtures/themes/black.json', import.meta.url))));
const idle = { id: null, status: 'idle', busy: false, configured: false };
const providers = [{ id: 'codex', name: 'Codex', configured: false, methods: [{ type: 'oauth', label: 'Sign in with ChatGPT', name: 'ChatGPT subscription' }] }];
async function cold(options = {}) {
  await mkdir(shots, { recursive: true });
  const f = await harnessFixture({ site: true, viewport: { width: 1920, height: 1080 }, themeCSS, messages: [],
    snapshot: { sessionId: null, tabs: [], model: null, auth: idle, harnesses: [{ agent: 'codex', ready: false, blocked: 'Sign in to Codex in imperfect to use your ChatGPT subscription on this machine' }] },
    answer: c => c.type === 'auth_providers' ? providers : c.type === 'models' ? [] : undefined,
    handleRequest: (req, res, path) => {
      if (path !== '/files/list') return false;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ path: '/fixture', home: '/fixture', entries: [] }));
      return true;
    }, ...options });
  const product = f.product ?? f.page;
  // Remove only the shared fixture's 650px height cap, for full-HD evidence.
  await product.addStyleTag({ content: 'html body #entry-terminal { height:100vh !important; }' });
  await product.evaluate(() => document.fonts.ready);
  await product.evaluate(() => { for (const a of document.getAnimations()) if (Number.isFinite(a.effect?.getComputedTiming().endTime)) a.finish(); });
  await product.locator('.fresh-question').waitFor({ state: 'visible' });
  return f;
}
const noAuthFlow = f => assert.equal(f.commands.some(c => c.type === 'auth_login' || c.type === 'auth_answer'), false, 'opening sign-in does not start a provider flow');
const shot = async (p, name) => {
  for (const frame of p.frames()) await frame.waitForFunction(() => !document.documentElement.matches('.turn, .session-turn'));
  // Let the cross-origin child reach the compositor, not just its DOM-ready reply.
  await p.waitForTimeout(1000);
  await p.screenshot({ path: join(shots, `${name}-1920.png`), caret: 'hide' });
};

test('a cold unconfigured direct Kinso origin welcomes Kinso with no query or saved brand', async t => {
  const f = await cold({ productOrigin: kinso }); t.after(() => f.close());
  const p = f.page, sheet = p.locator('#guey-auth[open]');
  assert.equal(p.url(), `${kinso}/`);
  await sheet.getByRole('heading', { name: 'Welcome to Kinso', exact: true }).waitFor();
  assert.equal(await p.locator('html').getAttribute('data-brand'), 'kinso');
  await shot(p, 'kinso-direct-welcome');
  await sheet.getByRole('button', { name: 'Not now', exact: true }).click();
  await p.locator('#entry-pi-label').click();
  const codex = p.locator('#entry-dialog .entry-dialog-option').filter({ hasText: 'Codex · sign in' });
  assert.match(await codex.innerText(), /Sign in to Codex in Kinso/);
  assert.doesNotMatch(await codex.innerText(), /in imperfect/);
  await shot(p, 'kinso-direct-picker');
  await codex.click();
  await sheet.getByRole('heading', { name: 'Codex', exact: true }).waitFor();
  assert.match(await sheet.locator('.auth-feedback').innerText(), /Kinso does not receive your account password/);
  await shot(p, 'kinso-explicit-provider');
  noAuthFlow(f); assert.deepEqual(f.errors, []);
});

test('a cold unconfigured launch frame stays bare through updates, but Settings sign-in is available', async t => {
  const f = await cold({ launchFrame: true, productOrigin: kinso, launchOrigin: 'https://kinso.computer' }); t.after(() => f.close());
  const p = f.product;
  await f.page.waitForFunction(() => messages.some(m => m.type === 'imperfect:demo-ready'));
  assert.equal(await p.locator('html').getAttribute('data-assembly-step'), 'bare');
  assert.equal(await p.locator('#guey-auth[open], #entry-dialog:not([hidden])').count(), 0);
  assert.equal(f.commands.some(c => /^auth_/.test(c.type)), false, 'bare does not even request the provider list');
  await shot(f.page, 'kinso-framed-bare');
  for (let i = 0; i < 3; i++) f.push({ ...f.tab, auth: { ...idle }, stats: { cost: i } });
  await p.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(await p.locator('#guey-auth[open]').count(), 0);
  // Reveal the real Settings control via the normal staged build, not a test-only auth mount.
  await f.page.evaluate(origin => document.querySelector('iframe').contentWindow.postMessage({ type: 'imperfect:assemble', step: 'files', for: 'kinso' }, origin), kinso);
  await f.page.waitForFunction(() => messages.some(m => m.type === 'imperfect:assembled' && m.step === 'files'));
  assert.equal(await p.locator('#guey-auth[open]').count(), 0);
  assert.equal(f.commands.some(c => /^auth_/.test(c.type)), false, 'build updates do not request sign-in');
  const settings = p.locator('.session-rail-settings');
  if (!await settings.isVisible()) await p.getByRole('button', { name: 'show the agents', exact: true }).click();
  await settings.click();
  await p.getByRole('button', { name: 'Sign in to a provider', exact: false }).click();
  const sheet = p.locator('#guey-auth[open]');
  await sheet.getByRole('heading', { name: 'Welcome to Kinso', exact: true }).waitFor();
  await shot(f.page, 'kinso-framed-explicit-settings');
  await sheet.getByRole('button', { name: 'Use a subscription / sign in', exact: true }).click();
  await sheet.getByRole('button', { name: /Codex/ }).waitFor();
  noAuthFlow(f);
  await sheet.getByRole('button', { name: 'Not now', exact: true }).click();
  // Suppressing the welcome must not suppress an active/resumed sign-in flow.
  f.push({ ...f.tab, auth: { ...idle, id: 'fixture-flow', busy: true, status: 'running', providerName: 'Fixture sign-in', message: 'Fixture progress only', events: [] } });
  await p.locator('#guey-auth[open]').getByRole('heading', { name: 'Fixture sign-in', exact: true }).waitFor();
  assert.deepEqual(f.errors, []);
});

test('a cold unconfigured non-Kinso window still welcomes imperfect by default', async t => {
  const f = await cold({ productOrigin: 'https://noah.imperfect.computer' }); t.after(() => f.close());
  await f.page.locator('#guey-auth[open]').getByRole('heading', { name: 'Welcome to imperfect', exact: true }).waitFor();
  assert.equal(await f.page.locator('html').getAttribute('data-brand'), 'imperfect');
  await shot(f.page, 'imperfect-direct-welcome');
  noAuthFlow(f); assert.deepEqual(f.errors, []);
});
