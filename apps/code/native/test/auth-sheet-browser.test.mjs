import test from 'node:test';
import assert from 'node:assert/strict';
import { harnessFixture } from './fixtures/harness-page.mjs';

// The window renders the sign-in sheet on every update, and a working agent
// sends many a second (Noah, signed in on the Mac: Close could not be
// pressed). Its buttons and links stay the same nodes while what they are for
// does not change, so a press lands.
test('the sign-in sheet\'s buttons survive updates, so Close closes it while an agent works', { timeout: 60000 }, async () => {
  const f = await harnessFixture({ messages: [{ role: 'assistant', content: 'Ready.' }] });
  const { page } = f;
  try {
    await page.evaluate(async () => {
      const { mountAuth } = await import('/js/auth.js');
      globalThis.sent = [];
      globalThis.sheet = mountAuth({ command: async (type, fields) => { sent.push(type); return type === 'snapshot' ? { model: { id: 'gpt', provider: 'openai-codex' } } : null; }, chooseModel: () => {} });
      globalThis.signedIn = () => ({ id: 'flow-1', configured: true, busy: false, status: 'success', providerId: 'openai-codex', providerName: 'OpenAI Codex (legacy)', message: 'Signed in.', availableModels: true, events: [{ type: 'auth_url', url: 'https://auth.openai.com/device' }] });
      sheet.render(signedIn());
    });
    const sheet = page.locator('#guey-auth').last();
    await sheet.waitFor();
    const close = sheet.getByRole('button', { name: 'Close' });
    await page.evaluate(() => { globalThis.closeButton = [...[...document.querySelectorAll('#guey-auth')].at(-1).querySelectorAll('button')].find(b => b.textContent === 'Close'); globalThis.link = [...document.querySelectorAll('#guey-auth')].at(-1).querySelector('a'); });
    // Updates while the agent streams: the same state, again and again.
    await page.evaluate(() => { for (let i = 0; i < 20; i++) sheet.render(signedIn()); });
    assert.equal(await page.evaluate(() => closeButton.isConnected && [...document.querySelectorAll('#guey-auth')].at(-1).querySelector('a') === link), true, 'the same button and link');
    // Pressed with an update between down and up, it still closes.
    const box = await close.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.evaluate(() => sheet.render(signedIn()));
    await page.mouse.up();
    await sheet.waitFor({ state: 'hidden' });
    await page.waitForFunction(() => sent.includes('auth_dismiss'));
    // Closed, the same flow's updates leave it closed.
    await page.evaluate(() => sheet.render(signedIn()));
    assert.equal(await sheet.isVisible(), false);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});
