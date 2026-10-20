import test from 'node:test';
import assert from 'node:assert/strict';
import { harnessFixture } from './fixtures/harness-page.mjs';

const SONNET = { provider: 'claude-agent', id: 'claude-sonnet-5-5', name: 'Sonnet', engine: 'claude', billing: 'Claude subscription' };
const HAIKU = { ...SONNET, id: 'claude-haiku-5-5', name: 'Haiku' };
const LAPTOP = { provider: 'fixture', id: 'laptop-only', name: 'Laptop only', engine: 'pi', billing: 'API' };
const machines = () => [
  { id: 'lap', name: 'laptop', self: true, reachable: true },
  { id: 'desk', name: 'desktop', reachable: true },
  { id: 'off', name: 'sleeping', reachable: false },
];
async function laptopFixture() {
  const f = await harnessFixture({ machines: machines(), messages: [{ role: 'assistant', content: [{ type: 'text', text: 'hello' }] }],
    snapshot: { harnesses: [{ agent: 'claude', ready: true, usual: true, model: SONNET }, { agent: 'pi', ready: true }] } });
  f.routed = []; f.made = []; f.models = { '': [SONNET, LAPTOP], desk: [SONNET, HAIKU] };
  f.snapshots = { '': f.tab, desk: structuredClone(f.tab) };
  f.answer = (c, owner) => {
    f.routed.push({ ...c, owner });
    if (c.type === 'models') return f.models[owner] ?? [];
    if (c.type === 'snapshot') return f.snapshots[owner];
    if (c.type === 'tab-focus') return { snapshot: f.snapshots[owner] };
    if (c.type === 'tab-new') {
      f.made.push({ ...c, owner });
      const tab = { id: 'new-tab', sessionId: `new-${owner || 'lap'}`, focused: true, agent: c.agent, status: 'idle', name: 'new' };
      const next = { ...f.snapshots[owner], tabId: tab.id, sessionId: tab.sessionId, agent: c.agent, model: c.model ?? SONNET, messages: [],
        tabs: [...f.snapshots[owner].tabs.map(t => ({ ...t, focused: false })), tab] };
      f.snapshots[owner] = next;
      return { id: tab.id, snapshot: next };
    }
    if (c.type === 'prompt') return { accepted: true };
  };
  return f;
}
async function newDraft(f, { viewingDesktop = false, computer } = {}) {
  const { page } = f;
  if (viewingDesktop) {
    await page.locator('.session-rail-item[data-owner="desk"] .session-rail-open').click();
    await page.waitForFunction(() => harness.guiSnapshot().owner === 'desk');
  }
  await page.evaluate(() => harness.newTab());
  await page.locator('#entry-terminal.fresh').waitFor();
  if (computer) {
    await page.locator('#entry-pi-label').click();
    await page.locator(`#entry-dialog [data-computer="${computer}"]`).click();
    await page.locator('#entry-dialog .entry-dialog-close').click();
  }
}
async function send(f, text = 'on the chosen computer') {
  await f.page.locator('#entry-input').fill(text);
  await f.page.locator('#entry-send').click();
  await f.page.waitForFunction(() => harness.guiSnapshot().sessionId?.startsWith('new-') && document.querySelector('#entry-input').value === '');
  for (let n = 0; !f.routed.some(c => c.type === 'prompt') && n < 50; n++) await f.page.waitForTimeout(20);
}

test('viewing desktop captures desktop for the next draft: one remote creation, no local creation', async () => {
  const f = await laptopFixture();
  try {
    await newDraft(f, { viewingDesktop: true });
    await f.page.waitForFunction(() => document.querySelector('.entry-model-name').textContent.startsWith('desktop · '));
    await send(f);
    assert.deepEqual(f.made.map(c => c.owner), ['desk']);
    assert.deepEqual(f.routed.filter(c => c.type === 'prompt').map(c => [c.owner, c.expectedSessionId]), [['desk', 'new-desk']]);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('an explicit laptop choice overrides the desktop conversation in view', async () => {
  const f = await laptopFixture();
  try {
    await newDraft(f, { viewingDesktop: true, computer: '@serving' });
    assert.doesNotMatch(await f.page.locator('.entry-model-name').textContent(), /desktop|laptop/);
    await send(f);
    assert.deepEqual(f.made.map(c => c.owner), ['']);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('the model menu changes computers while the old catalog is delayed; stale choices cannot overwrite the new owner', async () => {
  const f = await laptopFixture();
  try {
    let release;
    const answer = f.answer;
    f.answer = (c, owner) => c.type === 'models' && !owner ? new Promise(resolve => { release = () => resolve([SONNET, LAPTOP]); }) : answer(c, owner);
    await newDraft(f);
    await f.page.locator('#entry-pi-label').click();
    await f.page.locator('#entry-dialog [data-computer="desk"]').click();
    await f.page.getByText('Haiku 5.5', { exact: true }).waitFor();
    assert.equal(await f.page.locator('#entry-dialog [data-computer="off"]').isDisabled(), true);
    release();
    await f.page.waitForTimeout(100);
    assert.equal(await f.page.getByText('Laptop only', { exact: true }).count(), 0);
    await f.page.getByText('Haiku 5.5', { exact: true }).click();
    assert.match(await f.page.locator('.entry-model-name').textContent(), /desktop · Haiku 5.5/);
    await send(f);
    assert.deepEqual(f.made.map(c => [c.owner, c.model.id]), [['desk', HAIKU.id]]);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('a chosen peer going offline before first send preserves the question and creates nowhere', async () => {
  const f = await laptopFixture();
  try {
    await newDraft(f, { computer: 'desk' });
    f.machines = machines().map(row => row.id === 'desk' ? { ...row, reachable: false } : row);
    await f.page.locator('#entry-input').fill('keep my desktop question');
    await f.page.locator('#entry-send').click();
    await f.page.waitForFunction(() => /offline/.test(document.querySelector('#entry-model-status').textContent));
    assert.equal(await f.page.locator('#entry-input').inputValue(), 'keep my desktop question');
    assert.deepEqual(f.made, []);
    assert.equal(f.routed.filter(c => c.type === 'prompt').length, 0);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('changing computers clears a laptop-only model; it is never sent to desktop', async () => {
  const f = await laptopFixture();
  try {
    await newDraft(f);
    await f.page.locator('#entry-pi-label').click();
    await f.page.getByText('Laptop only', { exact: true }).click();
    await f.page.locator('#entry-pi-label').click();
    await f.page.locator('#entry-dialog [data-computer="desk"]').click();
    await f.page.getByText('Haiku 5.5', { exact: true }).waitFor();
    await f.page.locator('.entry-dialog-close').click();
    await send(f);
    assert.deepEqual(f.made.map(c => [c.owner, c.agent, c.model.id]), [['desk', 'claude', SONNET.id]]);
  } finally { await f.close(); }
});

test('a model withdrawn before first send keeps the draft instead of silently choosing another model', async () => {
  const f = await laptopFixture();
  try {
    await newDraft(f, { computer: 'desk' });
    await f.page.locator('#entry-pi-label').click();
    await f.page.getByText('Haiku 5.5', { exact: true }).click();
    f.models.desk = [SONNET];
    await f.page.locator('#entry-input').fill('keep this model choice');
    await f.page.locator('#entry-send').click();
    await f.page.waitForFunction(() => /Chosen model is unavailable/.test(document.querySelector('#entry-model-status').textContent));
    assert.equal(await f.page.locator('#entry-input').inputValue(), 'keep this model choice');
    assert.deepEqual(f.made, []);
    assert.equal(f.routed.filter(c => c.type === 'prompt').length, 0);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('sign-in availability and sign-in discovery belong to the chosen peer, not the laptop', async () => {
  const f = await laptopFixture();
  try {
    f.snapshots.desk = { ...f.snapshots.desk, auth: { configured: true, status: 'idle', busy: false },
      harnesses: [...f.snapshots.desk.harnesses, { agent: 'codex', ready: false, blocked: 'Sign in to Codex in imperfect' }] };
    await f.page.locator('.session-rail-item[data-owner="desk"]').waitFor({ state: 'attached' });
    f.sendFrom('desk', { type: 'snapshot', data: f.snapshots.desk });
    const answer = f.answer;
    f.answer = (c, owner) => {
      const result = answer(c, owner);
      if (c.type === 'auth_providers') return [{ id: 'codex', name: 'Codex', methods: [{ type: 'oauth', label: 'Use device code', name: 'ChatGPT subscription' }] }];
      return result;
    };
    await newDraft(f, { computer: 'desk' });
    await f.page.locator('#entry-pi-label').click();
    await f.page.getByText('Codex · sign in', { exact: true }).click();
    await f.page.locator('.auth-provider', { hasText: 'Use device code' }).waitFor();
    assert.deepEqual(f.routed.filter(c => c.type === 'auth_providers').map(c => c.owner), ['desk']);
    assert.deepEqual(f.made, []);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('a first attachment materializes on the captured peer and uploads there', async () => {
  const f = await laptopFixture();
  try {
    const uploads = [];
    await f.page.route('**/upload', route => { uploads.push(route.request().url()); return route.fulfill({ json: { path: '/fixture/plan.txt', size: 4, reference: { name: 'saved', sessionId: 'new-desk' } } }); });
    await newDraft(f, { viewingDesktop: true });
    await f.page.locator('#entry-files').setInputFiles({ name: 'plan.txt', mimeType: 'text/plain', buffer: Buffer.from('plan') });
    await f.page.waitForFunction(() => document.querySelector('#entry-pending')?.textContent.includes('plan.txt'));
    for (let n = 0; !uploads.length && n < 50; n++) await f.page.waitForTimeout(20);
    assert.deepEqual(f.made.map(c => c.owner), ['desk']);
    assert.equal(uploads.length, 1);
    assert.match(uploads[0], /\/peer\/desk\/upload$/);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('a first recording materializes on desktop and keeps its dictation target there', async () => {
  const f = await laptopFixture();
  try {
    await f.page.evaluate(() => {
      Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }) } });
      window.MediaRecorder = class { static isTypeSupported() { return true; } start() {} stop() { this.ondataavailable({ data: new Blob(['words'], { type: 'audio/webm' }) }); this.onstop(); } };
    });
    const sent = [], uploads = [];
    await f.page.route('**/upload', route => { uploads.push(route.request().url()); return route.fulfill({ json: { path: '/fixture/voice.webm', size: 5, reference: { name: 'voice', sessionId: 'new-desk' } } }); });
    await f.page.route('**/dictate', route => { sent.push({ url: route.request().url(), body: route.request().postDataJSON() }); return route.fulfill({ json: { accepted: true, words: 'hello desktop' } }); });
    await newDraft(f, { computer: 'desk' });
    const mic = f.page.locator('.entry-voice[data-state]');
    await mic.click();
    await f.page.waitForFunction(() => document.querySelector('.entry-voice[data-state]').dataset.state === 'recording');
    await mic.click();
    await f.page.waitForFunction(() => document.querySelector('.entry-voice[data-state]').dataset.state === 'idle');
    assert.deepEqual(f.made.map(c => c.owner), ['desk']);
    assert.equal(sent.length, 1);
    assert.match(sent[0].url, /\/peer\/desk\/dictate$/);
    assert.equal(sent[0].body.session, 'new-desk');
    assert.equal(sent[0].body.tab, 'new-tab');
    assert.equal(uploads.length, 1);
    assert.match(uploads[0], /\/peer\/desk\/upload$/);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});
