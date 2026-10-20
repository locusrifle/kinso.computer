import test from 'node:test';
import assert from 'node:assert/strict';
import { browserStripFixture, stripGeometry } from './fixtures/browser-strip.mjs';
import { FAKE_DESK } from './fixtures/harness-page.mjs';

for (const width of [1200, 390]) for (const native of [true, false]) {
  test(`browser strip ${width}px ${native ? 'fake native' : 'real iframe'}: one/many, overflow, selection, new and close`, { timeout: 45000 }, async () => {
    const fixture = await browserStripFixture({ width, native });
    const { page, open, reveal, tabs } = fixture;
    try {
      await open(1); await reveal();
      assert.equal(await tabs().count(), 1);
      assert.equal(await page.locator('.wm-browser .browser-tab-strip').isVisible(), true);
      assert.equal(await page.locator('.wm-browser .browser-count,.wm-browser .browser-list').count(), 0);
      assert.equal(await tabs().first().getAttribute('role'), 'tab');
      assert.equal(await tabs().first().getAttribute('aria-selected'), 'true');
      assert.equal(await tabs().first().getAttribute('tabindex'), '0');
      const initial = await stripGeometry(page);
      assert.equal(initial.bar.height, 72);
      assert.ok(initial.strip.bottom <= initial.controls.y + 1, 'tabs above navigation controls');
      const born = native ? null : await page.frameLocator('.wm-browser iframe').getByRole('button').evaluate(() => window.born);
      for (let index = 2; index <= 12; index++) await open(index, native);
      await reveal();
      const many = await stripGeometry(page);
      assert.equal(await tabs().count(), 12);
      assert.ok(many.overflow, 'many tabs scroll horizontally');
      assert.equal(new Set(many.items.map(item => Math.round(item.y))).size, 1, 'tabs never wrap');
      assert.equal(many.bar.height, initial.bar.height, 'more tabs do not grow the app bar');
      assert.equal(many.controls.y, initial.controls.y, 'address/navigation row is not displaced');
      if (native) assert.deepEqual(many.address, initial.address, 'address bounds remain unchanged');
      await tabs().first().click();
      assert.equal(await tabs().first().getAttribute('aria-selected'), 'true');
      if (!native) assert.equal(await page.frameLocator('.wm-browser .browser-page.front iframe').getByRole('button').evaluate(() => window.born), born, 'selection does not reload the real iframe');
      await tabs().first().focus();
      await page.keyboard.press('End');
      assert.equal(await tabs().last().getAttribute('aria-selected'), 'true');
      assert.equal(await tabs().last().evaluate(tab => tab === document.activeElement), true);
      await page.keyboard.press('Home');
      await page.keyboard.press('ArrowRight');
      assert.equal(await tabs().nth(1).getAttribute('aria-selected'), 'true');
      assert.equal(await tabs().nth(1).evaluate(tab => tab === document.activeElement), true);
      assert.equal(await tabs().evaluateAll(all => all.filter(tab => tab.tabIndex === 0).length), 1);
      await page.keyboard.press('ArrowLeft');
      await page.locator('.wm-browser .browser-tab-close').nth(5).click();
      assert.equal(await tabs().count(), 11, 'close x removes a background tab');
      assert.equal(await tabs().first().getAttribute('aria-selected'), 'true', 'background close leaves front alone');
      await page.locator('.wm-browser .browser-tab-item').nth(4).click({ button: 'middle' });
      assert.equal(await tabs().count(), 10, 'middle click closes wrapper');
      await tabs().first().focus(); await page.keyboard.press('Delete');
      assert.equal(await tabs().count(), 9, 'Delete closes selected tab');
      await page.locator('.wm-browser .browser-new').click();
      assert.equal(await tabs().count(), 10, '+ opens in the same browser');
      assert.equal(await page.locator('.wm-browser').count(), 1);
      assert.equal(await page.locator('.wm-browser .browser-tab.front .browser-tab-title').textContent(), 'New tab');
      await tabs().last().focus(); await page.keyboard.press('Control+w');
      assert.equal(await tabs().count(), 9, 'Ctrl+W closes the focused tab');
      await tabs().last().focus(); await page.keyboard.press('Control+t');
      assert.equal(await tabs().count(), 10, 'Ctrl+T opens via strip');
      while (await tabs().count() > 1) await page.locator('.wm-browser .browser-tab-close').last().click();
      await page.locator('.wm-browser .browser-tab-close').last().click();
      await page.locator('.wm-browser').waitFor({ state: 'detached' });
      assert.deepEqual(fixture.errors, []);
    } finally { await fixture.close(); }
  });
}

test('native strip: desk driving/loading/unread states and stable focus during guest updates', { timeout: 30000 }, async () => {
  const fixture = await browserStripFixture();
  const { page, tabs } = fixture;
  try {
    await fixture.open(1); await fixture.open(2, true); await fixture.reveal();
    await tabs().first().focus();
    await tabs().first().evaluate(tab => { window.keptTab = tab; });
    await page.evaluate(() => tabFromWindow({ id: 102, do: 'driving' }));
    assert.equal(await tabs().nth(1).evaluate(tab => tab.classList.contains('driven')), true);
    const behind = page.locator('.wm-browser webview').nth(1);
    await behind.evaluate(view => view.dispatchEvent(new Event('did-start-loading')));
    assert.equal(await tabs().nth(1).evaluate(tab => tab.classList.contains('loading')), true);
    await behind.evaluate(view => view.dispatchEvent(new Event('did-stop-loading')));
    assert.equal(await tabs().nth(1).evaluate(tab => tab.classList.contains('loading')), false);
    assert.equal(await tabs().nth(1).evaluate(tab => tab.classList.contains('unread')), true);
    await behind.evaluate(view => view.dispatchEvent(Object.assign(new Event('page-title-updated'), { title: 'Updated behind.html' })));
    assert.equal(await tabs().first().evaluate(tab => tab === window.keptTab && tab === document.activeElement), true, 'paint retains DOM and keyboard focus');
    assert.equal(await tabs().nth(1).locator('.browser-tab-title').textContent(), 'Updated behind');
    await tabs().nth(1).click();
    assert.equal(await tabs().nth(1).evaluate(tab => tab.classList.contains('unread')), false, 'reading the tab clears unread');
    assert.deepEqual(fixture.errors, []);
  } finally { await fixture.close(); }
});

test('shared strip: descriptors, accessible close/new and focus survive repeated paints', { timeout: 30000 }, async () => {
  const fixture = await browserStripFixture();
  const { page } = fixture;
  try {
    await fixture.open(1); await fixture.reveal();
    await page.evaluate(async () => {
      const { mountTabStrip } = await import('/js/browser-tab-strip.js');
      window.stripCalls = [];
      window.contractStrip = mountTabStrip({ select: id => stripCalls.push(['select', id]), close: id => stripCalls.push(['close', id]), create: () => stripCalls.push(['create']) });
      document.querySelector('.browser-tab-strip').replaceWith(contractStrip.el);
      window.descriptors = [{ id: 'a', title: 'Essay.html', url: 'https://example.test/', front: true }, { id: 'b', label: 'Notes.htm', url: 'https://example.test/notes', driving: true, loading: true, unread: true }, { id: 'c', url: 'about:blank' }];
      contractStrip.paint(descriptors);
    });
    const all = page.locator('.wm-browser .browser-tab');
    assert.deepEqual(await all.locator('.browser-tab-title').allTextContents(), ['Essay', 'Notes', 'New tab']);
    assert.equal(await all.nth(1).evaluate(tab => ['driven', 'loading', 'unread'].every(state => tab.classList.contains(state))), true);
    assert.equal(await page.locator('.wm-browser .browser-tab-close').first().getAttribute('aria-label') !== null, true);
    await all.first().focus();
    await page.evaluate(() => { window.keptStripTab = document.activeElement; for (let i = 0; i < 10; i++) contractStrip.paint(descriptors.map(one => ({ ...one }))); });
    assert.equal(await all.first().evaluate(tab => tab === keptStripTab && tab === document.activeElement), true);
    await page.keyboard.press('ArrowRight');
    assert.deepEqual(await page.evaluate(() => stripCalls.at(-1)), ['select', 'b']);
    await page.keyboard.press('Delete');
    assert.deepEqual(await page.evaluate(() => stripCalls.at(-1)), ['close', 'b']);
    // The integration cases above exercise the real Ctrl+T chord. The
    // harness owns that global shortcut, so use + for this callback-only
    // descriptor fixture rather than invoking the harness's separate pane.
    await page.locator('.wm-browser .browser-tab-item').last().click({ button: 'middle' });
    assert.deepEqual(await page.evaluate(() => stripCalls.at(-1)), ['close', 'c']);
    await page.locator('.wm-browser .browser-new').click();
    assert.deepEqual(await page.evaluate(() => stripCalls.at(-1)), ['create']);
    await all.first().focus();
    await page.evaluate(() => contractStrip.paint(descriptors.filter(one => one.id !== 'a').map(one => ({ ...one, front: one.id === 'b' }))));
    assert.equal(await all.first().evaluate(tab => tab === document.activeElement), true, 'external removal keeps roving focus on the selected survivor');
    await page.evaluate(() => contractStrip.paint([]));
    assert.equal(await page.locator('.wm-browser .browser-new').evaluate(button => button === document.activeElement), true, 'external last close leaves + with keyboard focus');
    assert.deepEqual(fixture.errors, []);
  } finally { await fixture.close(); }
});

test('native browser restores its tabs across a harness reload; last close removes its strip', { timeout: 30000 }, async () => {
  const fixture = await browserStripFixture();
  const { page } = fixture;
  try {
    await fixture.open(1); await fixture.open(2); await fixture.open(3); await fixture.reveal();
    const before = await page.locator('.wm-browser webview').evaluateAll(views => views.map(view => view.getAttribute('src')));
    await page.evaluate(() => harness.prepareSurfaceReload());
    await page.reload(); await page.evaluate(FAKE_DESK);
    await page.evaluate(async () => { const { mountGueyPi } = await import('/js/harness.js'); window.harness = mountGueyPi({ hooks: { canFocus: () => true } }); });
    await page.waitForFunction(() => document.querySelectorAll('.wm-browser webview').length === 3);
    assert.deepEqual(await page.locator('.wm-browser webview').evaluateAll(views => views.map(view => view.getAttribute('src'))), before);
    await fixture.reveal();
    for (const left of [2, 1, 0]) {
      await page.locator('.wm-browser .browser-tab-close').last().click();
      if (!left) await page.locator('.wm-browser').waitFor({ state: 'detached' });
      assert.equal(await page.locator('.wm-browser .browser-tab').count(), left);
    }
    assert.equal(await page.locator('.wm-browser .browser-tab-strip').count(), 0);
    assert.deepEqual(fixture.errors, []);
  } finally { await fixture.close(); }
});
