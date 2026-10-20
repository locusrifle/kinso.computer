// Real Chromium forms in a hidden, disposable Electron window.
// HTTPS is replaced at Electron's network layer before creating the window;
// DNS and a fail-closed Electron request allowlist also block external redirects.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { _electron } from 'playwright';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { grantTester } from '../rentals.mjs';
import { DAY, offersFixture } from './offers-fixture.mjs';

async function browserFixture(t, f, owner) {
  f.stripe.browserOrigin = f.origin;
  const root = await mkdtemp(join(tmpdir(), 'offers-electron-'));
  const entry = join(root, 'main.cjs');
  await writeFile(entry, `const { app, BrowserWindow, session } = require('electron');
app.whenReady().then(() => {
  // Electron's request hook also catches redirects, unlike Playwright routing.
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    let allowed = details.url === 'about:blank';
    try { allowed ||= new URL(details.url).origin === ${JSON.stringify(f.origin)}; } catch {}
    callback({ cancel: !allowed });
  });
  session.defaultSession.protocol.handle('https', () => new Response('External network denied', { status: 503 }));
  const win = new BrowserWindow({ show: false, width: 1050, height: 850,
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false } });
  win.loadURL('about:blank');
});
app.on('window-all-closed', () => app.quit());
`);
  let electron;
  t.after(async () => { await electron?.close(); await rm(root, { recursive: true, force: true }); });
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  electron = await _electron.launch({
    executablePath: fileURLToPath(new URL('../../node_modules/.bin/electron', import.meta.url)),
    args: [entry, `--user-data-dir=${join(root, 'profile')}`, '--no-sandbox', '--no-proxy-server',
      '--host-resolver-rules=MAP checkout.stripe.com ~NOTFOUND, MAP billing.stripe.com ~NOTFOUND',
      ...(env.WAYLAND_DISPLAY ? ['--ozone-platform=wayland'] : env.DISPLAY ? ['--ozone-platform=x11'] : ['--ozone-platform=headless'])],
    env, timeout: 20_000,
  });
  const context = electron.context(), errors = [], blocked = [], checkoutVisits = [], portalVisits = [];
  // The local fake Stripe hosts its pages behind the same loopback proxy.
  // CSP remains production policy; no external navigation is needed.
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin === f.origin) return route.continue();
    blocked.push(route.request().url()); return route.abort('blockedbyclient');
  });
  if (owner) await context.addCookies([{ name: 'imperfect_account', value: owner.token, url: f.origin, httpOnly: true, sameSite: 'Lax' }]);
  const page = await electron.firstWindow(); page.setDefaultTimeout(10_000);
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error' && /Content Security Policy|Refused to/.test(message.text())) errors.push(message.text()); });
  t.after(() => {
    assert.deepEqual(errors, [], 'forms work without weakening CSP');
    assert.deepEqual(blocked, [], 'no unexpected external requests');
  });
  page.on('framenavigated', frame => {
    if (frame !== page.mainFrame()) return;
    const url = new URL(frame.url());
    if (url.origin === f.origin && url.pathname.startsWith('/fake-stripe/checkout/') && !checkoutVisits.includes(url.pathname)) checkoutVisits.push(url.pathname);
    if (url.origin === f.origin && url.pathname === '/fake-stripe/portal' && !portalVisits.includes(url.pathname)) portalVisits.push(url.pathname);
  });
  const clickForm = async (action, target) => {
    const response = page.waitForResponse(r => r.url() === `${f.origin}${action}` && r.request().method() === 'POST');
    await Promise.all([page.waitForURL(target), page.locator(`form[action="${action}"] button`).click()]);
    return response;
  };
  return { page, clickForm, checkoutVisits, portalVisits };
}

test('browser rental checkout → account state → customer portal under the real account CSP', { timeout: 60_000 }, async t => {
  const f = await offersFixture(t), owner = f.seed();
  const { page, clickForm, checkoutVisits, portalVisits } = await browserFixture(t, f, owner);
  const account = await page.goto(`${f.origin}/account`);
  assert.equal(account.status(), 200);
  assert.match(account.headers()['content-security-policy'], /form-action 'self' https:\/\/checkout\.stripe\.com https:\/\/billing\.stripe\.com;/);
  assert.equal(account.headers()['referrer-policy'], 'strict-origin');
  assert.match(await page.textContent('body'), /Rent — US\$40\/month/);
  const checkout = await clickForm('/account/rent', `${f.origin}/fake-stripe/checkout/**`);
  assert.equal(checkout.status(), 303);
  assert.equal((await checkout.request().allHeaders()).origin, f.origin, 'native form carries a canonical Origin, not null');
  assert.match(await page.textContent('body'), /Fixture Stripe checkout/);
  assert.equal(checkoutVisits.length, 1);
  assert.equal(f.store.rentals().length, 1);
  const sub = f.subscription(owner), session = [...f.stripe.sessions.values()][0];
  session.status = 'complete'; session.subscription = sub.id;
  assert.equal((await f.webhook('checkout.session.completed', session)).status, 200);
  await Promise.all([page.waitForURL(`${f.origin}/account?checkout=complete`), page.getByRole('link', { name: 'Return to imperfect' }).click()]);
  assert.match(await page.textContent('body'), /Rental: active/);
  assert.equal(await page.locator('form[action="/account/rent"]').count(), 0);
  assert.equal(await page.locator('form[action="/account/portal"]').count(), 1);
  f.store.registerComputer({ username: 'alder', computerId: 'fixture-alder', state: 'ready' });
  await page.reload(); assert.match(await page.textContent('body'), /Computer: ready/);
  const portal = await clickForm('/account/portal', `${f.origin}/fake-stripe/portal`);
  assert.equal(portal.status(), 303);
  await page.getByRole('heading', { name: 'Fixture Stripe portal' }).waitFor();
  assert.equal(portalVisits.length, 1);
  assert.match(await page.textContent('body'), /Fixture Stripe portal/);
  await Promise.all([page.waitForURL(`${f.origin}/account`), page.getByRole('link', { name: 'Return to account' }).click()]);
  sub.status = 'past_due';
  sub.latest_invoice = { status: 'open', attempted: true, paid: false, created: Math.floor(f.now() / 1000), customer_email: 'alder@example.invalid' };
  assert.equal((await f.webhook('invoice.payment_failed', { subscription: sub.id })).status, 200);
  await page.reload();
  assert.match(await page.textContent('body'), /Rental: past_due/);
  assert.match(await page.textContent('body'), /Stop scheduled:/);
  assert.match(await page.textContent('body'), /Data retention until/);
  sub.status = 'active'; sub.latest_invoice.paid = true; sub.latest_invoice.status = 'paid';
  assert.equal((await f.webhook('invoice.paid', { subscription: sub.id })).status, 200);
  await page.reload(); assert.match(await page.textContent('body'), /Rental: active/);
  assert.doesNotMatch(await page.textContent('body'), /Stop scheduled:/);
});

test('browser anonymous OS checkout → private thanks → installation guide; no sign-in required', { timeout: 60_000 }, async t => {
  const f = await offersFixture(t);
  const { page, clickForm, checkoutVisits } = await browserFixture(t, f);
  await page.goto(`${f.origin}/host.html`);
  assert.equal(await page.locator('form[action="/os/buy"]').count(), 1, 'configured offer has a real form');
  const checkout = await clickForm('/os/buy', `${f.origin}/fake-stripe/checkout/**`);
  assert.equal(checkout.status(), 303);
  await page.getByRole('heading', { name: 'Fixture Stripe checkout' }).waitFor();
  assert.equal(checkoutVisits.length, 1);
  const session = [...f.stripe.sessions.values()][0];
  assert.equal(session.client_reference_id, undefined);
  f.settleOS(session, 'anonymous@example.invalid');
  const thanksResponse = page.waitForResponse(r => r.url().includes('/os/thanks?'));
  await Promise.all([page.waitForURL(`${f.origin}/os/thanks?session_id=${session.id}`), page.getByRole('link', { name: 'Return to imperfect' }).click()]);
  const thanks = await thanksResponse;
  assert.equal(thanks.status(), 200); assert.equal(thanks.headers()['cache-control'], 'no-store');
  assert.match(await page.textContent('body'), /thank you/i);
  const license = f.store.licenseBySession(session.id);
  assert.ok((await page.textContent('body')).includes(license.key));
  assert.equal(f.sent.length, 1); assert.equal(f.sent[0].to, 'anonymous@example.invalid');
  await page.reload();
  assert.equal(f.store.listLicenses().length, 1); assert.equal(f.sent.length, 1);
  await Promise.all([page.waitForURL(`${f.origin}/os/install`), page.getByRole('link', { name: 'Continue to the OS installation guide' }).click()]);
  assert.match(await page.textContent('body'), /erase disks/);
  assert.match(await page.textContent('body'), /installer download is not published/);
});

test('browser tester and disabled pages are explanatory, not broken checkout controls', { timeout: 60_000 }, async t => {
  const f = await offersFixture(t, { disabled: true }), owner = f.seed();
  const { page, checkoutVisits } = await browserFixture(t, f, owner);
  await page.goto(`${f.origin}/account`);
  assert.match(await page.textContent('body'), /Monthly billing is not open yet/);
  assert.equal(await page.locator('form[action="/account/rent"]').count(), 0);
  await page.goto(`${f.origin}/host.html`);
  assert.equal(await page.locator('form[action="/os/buy"]').count(), 0);
  assert.equal(await page.getByRole('link', { name: /Ask about imperfect OS/ }).count(), 1);
  await page.goto(`${f.origin}/rent.html`);
  assert.equal(new URL(page.url()).pathname, '/', 'the old rent address lands on the desktop');
  grantTester(f.store, 'alder', f.now() + DAY, f.now());
  await page.goto(`${f.origin}/account`);
  assert.match(await page.textContent('body'), /you’re a tester, no card needed/);
  assert.match(await page.textContent('body'), /your computer is being made/);
  assert.equal(await page.locator('form[action="/account/portal"]').count(), 0);
  f.setNow(f.now() + DAY); await page.reload();
  assert.match(await page.textContent('body'), /Rental: canceled/);
  assert.match(await page.textContent('body'), /Data retention until/);
  assert.equal(checkoutVisits.length, 0); assert.equal(f.stripe.calls.length, 0);
});
