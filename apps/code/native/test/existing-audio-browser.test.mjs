import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { launchChromium } from '../../../../tools/test-browser.mjs';
import { createGueyServer } from '../../../../system/server.mjs';
import { createTabHost } from '../tabs.mjs';
import { fixture } from '../../tools/gui-preview.mjs';

// Real page, upload server and prompt attachment resolution. ASR is a fixture:
// codec decoding is checked separately, and no model/provider turn is run here.
test('existing M4A uploads retain their originals as file attachments alongside transcription, including retry and missing MIME', async t => {
  const root = await mkdtemp(join(tmpdir(), 'existing-audio-'));
  const prompts = [], wire = [], uploads = [], hearing = [];
  const snap = { ...fixture({ empty: true, agent: 'claude' }), cwd: root, tabs: undefined, sessionId: 'audio-session' };
  const runtime = { events: new EventEmitter(), snapshot: () => snap,
    command: async command => { if (command.type === 'prompt') prompts.push(command); return { accepted: true }; }, close: async () => {} };
  const host = await createTabHost({ sessionToken: 'audio-fixture-only', firstTab: 'claude',
    createRuntime: () => runtime, createClaudeRuntime: () => runtime, claudeAvailable: () => true });
  const app = await createGueyServer({ port: 0, stateDir: join(root, 'state'), runtime: host, sessionToken: 'audio-fixture-only' });
  let browser;
  t.after(async () => { await browser?.close(); await app.close(); await rm(root, { recursive: true, force: true }); });
  const address = await app.listen();
  browser = await launchChromium({ headless: true, args: ['--no-sandbox', '--disable-gpu', '--disable-features=LocalNetworkAccessChecks'] });
  const page = await browser.newPage({ viewport: { width: 430, height: 850 }, isMobile: true, hasTouch: true });
  page.setDefaultTimeout(8000);
  page.on('request', req => { if (req.url().endsWith('/upload')) uploads.push(req.postDataBuffer()); });
  page.on('websocket', socket => socket.on('framesent', frame => {
    try { const c = JSON.parse(frame.payload); if (c.type === 'prompt') wire.push(c); } catch {}
  }));
  await page.route('**/js/site.js', async route => {
    const response = await route.fetch();
    await route.fulfill({ response, body: `${await response.text()}\nwindow.harness = harness;` });
  });
  let refuse = false;
  await page.route('**/transcribe', route => {
    hearing.push(route.request().postDataJSON());
    return route.fulfill({ status: refuse ? 503 : 200,
      json: refuse ? { error: 'fixture decoder unavailable' } : { text: 'Words from the saved recording.' } });
  });
  await page.goto(`http://127.0.0.1:${address.port}/?face=code`);
  await page.waitForFunction(() => window.harness?.guiSnapshot().sessionId === 'audio-session');
  const audio = Buffer.from('original exported audio fixture');
  for (const [index, mimeType] of ['audio/mp4', 'application/octet-stream', ''].entries()) {
    const name = `Recorder-meeting-${index}.m4a`;
    if (index === 1) refuse = true;
    await page.locator('#entry-files').setInputFiles({ name, mimeType, buffer: audio });
    await page.locator('.entry-pending-chip:not(.is-uploading)').waitFor();
    if (index === 1) {
      await page.locator('.entry-voice[data-state="kept"]').waitFor();
      assert.equal(uploads.length, 2);
      assert.equal(await page.locator('.entry-pending-chip').textContent(), name, 'failure retains the file, not an image chip');
      refuse = false;
      await page.locator('.entry-voice[data-state="kept"]').click();
    }
    await page.waitForFunction(() => document.querySelector('#entry-input').value.includes('Words from the saved recording.'));
    await page.locator('.entry-voice[data-state="idle"]').waitFor();
    assert.equal(uploads.length, index + 1, 'transcription and retry reuse the original upload');
    assert.deepEqual(uploads[index], audio);
    assert.equal(await page.locator('.entry-pending-chip').textContent(), name);
    assert.doesNotMatch(await page.locator('#entry-input').inputValue(), /image \d/);
    const request = hearing.at(-1);
    assert.equal(request.session, 'audio-session');
    assert.equal(request.instanceId, host.snapshot().instanceId);
    if (index === 1) assert.deepEqual(hearing[1], hearing[2], 'transcription retry keeps its scoped reference');
    if (index === 0 && process.env.PHONE_AUDIO_SCREENSHOT) {
      await page.screenshot({ path: process.env.PHONE_AUDIO_SCREENSHOT });
    }
    assert.deepEqual(await page.evaluate(() => harness.submit()), { accepted: true });
    assert.equal(prompts.length, index + 1);
    assert.match(prompts[index].text, /Words from the saved recording\./);
    assert.match(prompts[index].text, /\[uploaded file: .*Recorder-meeting-/);
    assert.deepEqual(prompts[index].images, [], 'audio never enters image preparation');
    assert.deepEqual(wire[index].attachments, [{ kind: 'file', reference: request.audio }]);
    assert.equal(wire[index].images, undefined);
    assert.deepEqual(await readFile(join(root, 'uploads', request.audio.name)), audio);
  }
  refuse = true;
  await page.locator('#entry-files').setInputFiles({ name: 'untranscribed.m4a', mimeType: 'audio/mp4', buffer: audio });
  await page.locator('.entry-voice[data-state="kept"]').waitFor();
  await page.locator('#entry-input').fill('Keep this original without a transcript.');
  assert.deepEqual(await page.evaluate(() => harness.submit()), { accepted: true });
  assert.match(prompts[3].text, /Keep this original without a transcript\./);
  assert.match(prompts[3].text, /uploaded file:.*untranscribed-/);
  assert.deepEqual(prompts[3].images, []);
  await page.keyboard.press('Escape');
  assert.equal(uploads.length, 4);
  assert.equal((await readdir(join(root, 'uploads'))).length, 4);
});
