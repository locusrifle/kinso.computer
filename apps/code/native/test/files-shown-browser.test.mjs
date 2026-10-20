// Real show result events, production harness, Files backend and shown asset server.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFiles } from '../../../../system/files.mjs';
import { createShown } from '../../../../system/shown.mjs';
import { runShow, provideShownTabs } from '../code-control.mjs';
import { harnessFixture } from './fixtures/harness-page.mjs';

for (const desk of [true, false]) for (const peer of [false, true]) {
  test(`show local HTML stays in Files: ${desk ? 'desktop' : 'phone'}, ${peer ? 'peer' : 'self'}`, { timeout: 30000 }, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'files-shown-'));
    const path = join(dir, 'index.html');
    const key = Symbol.for('imperfect.shown'), before = globalThis[key];
    await writeFile(path, '<button onclick="this.textContent=\'Playing\'">Play</button><script src="app.js"></script>');
    await writeFile(join(dir, 'app.js'), 'document.body.dataset.ready="yes"');
    const shown = createShown({ stateDir: join(dir, '.state') });
    const files = createFiles({ thumbnailDir: join(dir, '.cache'), pictureMakers: [] });
    await shown.listen(0);
    let fixture;
    try {
      fixture = await harnessFixture({ desk, viewport: desk ? { width: 1200, height: 900 } : { width: 390, height: 844 }, hasTouch: !desk,
        messages: [{ role: 'assistant', content: [{ type: 'text', text: 'ready' }] }],
        machines: [{ id: 'pc', self: true, home: true, reachable: true, capabilities: ['files'] }, { id: 'other', reachable: true, capabilities: ['files'] }],
        handleRequest: async (req, res, pathname) => {
          const route = pathname.replace(/^\/peer\/other/, '');
          return await shown.handle(req, res, route) || await files(req, res, route, new URL(req.url, 'http://fixture').search);
        } });
      const { page } = fixture;
      await page.waitForTimeout(200); // inventory connects the peer transport
      // Send on the owning computer's socket, not a field supplied by a page.
      provideShownTabs(event => fixture.sendFrom(peer ? 'other' : '', { type: 'shown', ...event }));
      const result = await runShow({ path: dir, session: 'thread-a' });
      assert.equal(result, `Opened in Workbench: ${path}`);
      const player = page.frameLocator('.wm-files .workbench-view-page iframe');
      await player.locator('body[data-ready="yes"]').waitFor();
      await player.getByRole('button', { name: 'Play', exact: true }).click();
      await player.getByRole('button', { name: 'Playing', exact: true }).waitFor();
      assert.equal(await page.locator('.wm-browser').count(), 0);
      assert.equal(await page.locator('.workbench-crumb[aria-current="page"]').textContent(), 'index.html');
      assert.equal(await page.evaluate(() => { const kept = JSON.parse(localStorage.getItem('imperfect.workbench.tabs')); return kept.tabs[kept.active].owner; }), peer ? 'other' : '');
      // Re-show does not create another panel/tab or stop an active application.
      await runShow({ path, session: 'thread-a' });
      await page.waitForTimeout(150);
      assert.equal(await page.locator('.workbench-view-count').textContent(), '+');
      await player.getByRole('button', { name: 'Playing', exact: true }).waitFor();
      if (!peer) {
        fixture.push({ ...fixture.tab, messages: [{ role: 'assistant', content: 'ready' }, { role: 'toolResult', toolName: 'show', content: [{ type: 'text', text: result }] }] });
        const link = page.locator('.gui-opened a[data-file]');
        await link.waitFor();
        assert.equal(await link.getAttribute('title'), 'open it in Files');
        await link.click();
        assert.equal(await page.locator('.wm-browser').count(), 0, 'the real tool result link opens Files too');
      }
      // An unregistered server is not blindly embedded or sent to Browser.
      // Registered dev/project server playback is exercised by project-files-views-browser.
      const events = [];
      provideShownTabs(event => events.push(event));
      await runShow({ path: 'http://localhost:5173/', session: 'thread-a' });
      assert.equal(events.length, 1);
      assert.equal(events[0].kind, undefined);
      fixture.sendFrom(peer ? 'other' : '', { type: 'shown', ...events[0] });
      await page.locator('.workbench-status').filter({ hasText: 'No registered app' }).waitFor();
      assert.equal(await page.locator('.wm-browser').count(), 0);
      assert.equal(await page.locator('.wm-files .workbench-view-page iframe').count(), 1);
      assert.deepEqual(fixture.errors, []);
    } finally {
      provideShownTabs(() => {});
      await fixture?.close();
      await shown.close();
      globalThis[key] = before;
      await rm(dir, { recursive: true, force: true });
    }
  });
}
