import test from 'node:test';
import assert from 'node:assert/strict';
import { launchChromium } from '../../tools/test-browser.mjs';
import { macosLaunch } from './fixtures/macos-launch.mjs';

test('macOS website lock refuses with no message on screen, clears, then unlocks to audible QuickTime and continues the actual build', async () => {
  const browser = await launchChromium({ headless: true, args: ['--no-sandbox', '--autoplay-policy=document-user-activation-required'] });
  let f;
  try {
    f = await macosLaunch(browser); await f.lock();
    assert.equal((await f.state()).phase, 'ready');
    assert.equal(await f.page.locator('.macos-name').textContent(), 'imperfect');
    await f.page.locator('#password').fill('refused'); await f.page.getByRole('button', { name: 'Unlock', exact: true }).click();
    await f.page.waitForFunction(() => window.__launch().lock.state === 'wrong');
    assert.equal((await f.state()).lock.unlocked, false);
    await f.step(.06, .02);
    assert.notEqual(await f.page.locator('.macos-field').evaluate(el => getComputedStyle(el).transform), 'none');
    assert.equal(await f.page.locator('#announce').textContent(), 'Wrong password.', 'said to a screen reader only; nothing on screen');
    await f.step(.5);
    assert.equal(await f.page.locator('#password').inputValue(), ''); assert.equal(await f.page.locator('#dots i').count(), 0);
    assert.equal(await f.page.evaluate(() => document.activeElement.id), 'password');
    assert.equal((await f.state()).lock.state, 'idle');
    await f.page.locator('#password').fill('fixture-password'); await f.page.keyboard.press('Enter');
    await f.page.waitForFunction(() => window.__launch().phase === 'mac-unlocking');
    await f.step(.3);
    assert.equal(await f.page.locator('[data-window-thumbnail="quicktime"] .shell-thumbnail-app').count(), 1);
    await f.step(.5); await f.page.waitForFunction(() => !!document.querySelector('.genie-mesh'));
    assert.equal(await f.page.locator('.genie-strip').count(), 64);
    await f.step(.7); await f.page.waitForFunction(() => window.__launch().phase === 'quicktime');
    assert.equal((await f.state()).quicktime.muted, false); assert.equal((await f.state()).quicktime.paused, false);
    assert.equal(await f.page.locator('.quicktime .shell-titlebar').textContent(), 'kinso-variations.mp4');
    assert.equal(await f.page.locator('#curtain').isVisible(), false);
    await f.step(2.2); assert.equal((await f.state()).quicktime.hud, false);
    await f.page.locator('.quicktime').hover(); await f.step(.1); assert.equal((await f.state()).quicktime.hud, true);
    await f.page.locator('#quicktimeVideo').evaluate(video => { video.currentTime = video.duration - .1; });
    await f.page.waitForFunction(() => window.__launch().quicktime.ending);
    await f.step(.7); await f.page.waitForFunction(() => window.__launch().phase === 'mac');
    assert.equal((await f.state()).quicktime.window, 'minimized');
    await f.page.locator('#skip').evaluate(el => el.click());
    await f.page.waitForFunction(() => window.__launch().phase === 'demo', null, { timeout: 30000 });
    assert.equal((await f.state()).demoVerified, true);
    assert.deepEqual(f.errors, []); assert.deepEqual(f.refusals, []);
  } finally { await f?.close(); await browser.close(); }
});

test('phone, light appearance and Reduce Motion keep the password usable and omit the genie; skip preserves authentication', async () => {
  const browser = await launchChromium({ headless: true, args: ['--no-sandbox'] });
  let f;
  try {
    f = await macosLaunch(browser, { viewport: { width: 390, height: 844 }, reduced: true, appearance: 'light' });
    await f.page.locator('#skip').evaluate(el => el.click());
    await f.page.waitForFunction(() => window.__launch().phase === 'ready'); await f.step(.2);
    assert.equal((await f.state()).lock.unlocked, false);
    await f.page.setViewportSize({ width: 390, height: 420 });
    const field = await f.page.locator('#password').boundingBox(); assert.ok(field.y > 150 && field.y + field.height < 420);
    await f.page.locator('#password').fill('fixture-password'); await f.page.keyboard.press('Enter');
    await f.page.waitForFunction(() => window.__launch().phase === 'demo', null, { timeout: 30000 });
    assert.equal(await f.page.locator('.genie-mesh').count(), 0); assert.equal((await f.state()).quicktime.entered, false);
    assert.deepEqual(f.errors, []);
  } finally { await f?.close(); await browser.close(); }
});

test('a remembered visitor completes the opener and enters the Mac without displaying a password', async () => {
  const browser = await launchChromium({ headless: true, args: ['--no-sandbox'] });
  let f;
  try {
    f = await macosLaunch(browser, { remembered: true, reduced: true }); await f.lock();
    assert.equal((await f.state()).lock.unlocked, true); assert.equal((await f.state()).lock.shown, false);
    await f.step(.3); await f.step(.5); await f.step(.3);
    await f.page.waitForFunction(() => window.__launch().phase === 'quicktime' || window.__launch().phase === 'quicktime-blocked');
    assert.equal(await f.page.locator('.genie-mesh').count(), 0); assert.deepEqual(f.errors, []);
  } finally { await f?.close(); await browser.close(); }
});

test('the same genie serves the live product and Finder without cloning authenticated iframes', async () => {
  const browser = await launchChromium({ headless: true, args: ['--no-sandbox'] }); let f;
  try {
    f = await macosLaunch(browser, { remembered: true }); await f.page.locator('#skip').evaluate(el => el.click());
    await f.page.waitForFunction(() => window.__launch().phase === 'demo', null, { timeout: 30000 });
    await f.page.evaluate(() => { window.__sameComputer = document.getElementById('computer'); });
    const rootLoads = f.product.seen.roots.length;
    await f.page.getByRole('button', { name: 'Minimize imperfect', exact: true }).click(); await f.step(.2);
    assert.equal(await f.page.locator('.genie-mesh').count(), 1); assert.equal(await f.page.locator('.genie-mesh iframe').count(), 0);
    await f.step(.3);
    assert.equal(await f.page.locator('[data-window-id="imperfect"]').getAttribute('data-window-state'), 'minimized');
    await f.page.getByRole('button', { name: 'Restore imperfect', exact: true }).click(); await f.step(.2);
    assert.equal(await f.page.locator('.genie-mesh').count(), 1); await f.step(.3);
    assert.equal(await f.page.evaluate(() => document.getElementById('computer') === window.__sameComputer), true);
    assert.equal((await f.state()).demoVerified, true);
    assert.equal(f.product.seen.roots.length, rootLoads, 'no replacement product navigation');
    // The completed build has absorbed Finder's Dock icon. Its remaining Trash
    // opens Finder, whose File menu still creates an ordinary Finder window.
    await f.page.getByRole('button', { name: 'Trash', exact: true }).click();
    await f.page.getByRole('button', { name: 'File', exact: true }).click();
    await f.page.getByRole('menuitem', { name: /^New Window/ }).click();
    await f.page.getByRole('button', { name: 'Minimize Finder', exact: true }).click(); await f.step(.2);
    assert.equal(await f.page.locator('.genie-mesh').count(), 1); await f.step(.3);
    await f.page.getByRole('button', { name: 'Restore Finder', exact: true }).click(); await f.step(.5);
    assert.equal(await f.page.locator('[data-window-id="finder"]').getAttribute('data-window-state'), 'open');
    assert.deepEqual(f.errors, []); assert.deepEqual(f.refusals, []);
  } finally { await f?.close(); await browser.close(); }
});
