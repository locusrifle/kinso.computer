// Messages in the real harness page: the sidebar's section, the list, a chat
// and an email thread, search, a filter, an agent's draft and the person's
// own Send, Connect, and the empty states, over the real /inbox route and a
// fake Unipile (apps/code/test/fixtures/unipile.mjs), in the Mac's light and
// dark, on a desk and a phone. MESSAGES_SHOTS=<dir> keeps a picture of each.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { harnessFixture } from './fixtures/harness-page.mjs';
import { testTheme } from './fixtures/theme.mjs';
import { launchChromium } from '../../../../tools/test-browser.mjs';
import { themeCss } from '../../../../system/theme.mjs';
import { createInboxRoute, runMessagesDraft } from '../../../../system/inbox.mjs';
import { startFakeUnipile, unipileData } from '../../test/fixtures/unipile.mjs';

const shots = process.env.MESSAGES_SHOTS;
if (shots) await mkdir(shots, { recursive: true });
const DESK = { width: 1400, height: 900 }, PHONE = { width: 390, height: 844 };
const sidebarRow = (page, name) => page.locator('#session-rail .sidebar-row').filter({ has: page.locator('.session-rail-asked', { hasText: new RegExp(`^${name}$`) }) });
const NEWEST = [
  'chat:acc_whatsapp:chat_mum', 'mail:acc_gmail_home:th_dinner', 'chat:acc_linkedin:chat_priya', 'mail:acc_gmail_work:th_pilot',
  'chat:acc_whatsapp:chat_climb', 'chat:acc_instagram:chat_jules', 'mail:acc_gmail_home:th_receipt', 'chat:acc_linkedin:chat_tom',
];

async function messagesPage(t, browser, { theme, viewport, state = 'ready' }) {
  const fake = await startFakeUnipile(state === 'no-accounts' ? { data: { ...unipileData(), accounts: [] } } : {});
  const root = await mkdtemp(join(tmpdir(), 'messages-browser-'));
  if (state !== 'no-key') await writeFile(join(root, 'unipile.json'), JSON.stringify({ dsn: fake.origin, apiKey: fake.key }));
  // What the computer tells its windows (an agent's draft) reaches the page's socket.
  let tell = () => {};
  let route = createInboxRoute({ dir: join(root, 'inbox'), keyFile: join(root, 'unipile.json'), tell: message => tell(message), ...(state === 'demo' ? { source: { kind: 'demo' } } : {}) });
  if (state === 'read-only') {
    const box = await route.inbox();
    for (const name of ['list', 'thread', 'search']) {
      const original = box[name].bind(box);
      box[name] = async (...args) => ({ ...await original(...args), canSend: false, canConnect: false });
    }
  }
  const setDemo = () => {
    route = createInboxRoute({ source: { kind: 'demo' }, tell: message => tell(message) });
    tell({ type: 'inbox-changed' });
  };
  const phone = viewport.width < 500;
  const f = await harnessFixture({ browser, desk: !phone, viewport, hasTouch: phone, themeCSS: themeCss(await testTheme(theme)),
    handleRequest: (req, res, path) => route(req, res, path, new URL(req.url, 'http://fixture').search),
    messages: state === 'demo'
      ? [{ role: 'user', content: 'Find the demo pilot email and draft a reply. Draft only.' }, { role: 'assistant', content: [{ type: 'text', text: 'This is the demo inbox: invented conversations. Nothing can be sent from it.' }] }]
      : [{ role: 'user', content: 'reply to Priya for me' }, { role: 'assistant', content: [{ type: 'text', text: 'Drafted a reply to Priya in Messages. It waits for you to press Send.' }] }] });
  tell = message => f.send(state === 'read-only' ? { type: 'inbox-changed' } : message);
  t.after(async () => { await f.close(); await fake.close(); await rm(root, { recursive: true, force: true }); });
  // The fixture's page is 650px tall; Messages is drawn the height of the screen.
  await f.page.addStyleTag({ content: 'html body #entry-terminal { height: 100vh !important; }' });
  const name = `${theme}-${viewport.width}`;
  const shot = async what => { if (shots) { await f.page.waitForTimeout(300); await f.page.screenshot({ path: join(shots, `${name}-${what}.png`) }); } };
  const rows = () => f.page.locator('.messages-row').evaluateAll(all => all.map(row => row.dataset.key));
  const show = async () => { await f.page.evaluate(() => harness.showMessages({})); await f.page.waitForTimeout(phone ? 900 : 300); };
  // Nothing in Messages runs wider than its window.
  const fits = async () => {
    const wide = await f.page.evaluate(() => [...document.querySelectorAll('.messages, .messages-thread, .messages-scroll, .messages-composer, .messages-list')]
      .filter(n => n.offsetWidth && n.scrollWidth > n.clientWidth + 1).map(n => `${n.className} ${n.scrollWidth}>${n.clientWidth}`));
    if (wide.length) console.log('wider than its window:', wide);
    return !wide.length;
  };
  // Back to the list, where the window is too narrow for both.
  const back = async () => { if (await f.page.locator('.messages-back').isVisible()) await f.page.locator('.messages-back').click(); };
  return { ...f, fake, phone, shot, rows, show, fits, back, setDemo };
}

// A phone's pointer from the first frame: Electron's fine pointer can
// otherwise win a race with the touch emulation (as sidebar-cleanup's).
const TOUCH = ['--blink-settings=primaryHoverType=1,availableHoverTypes=1,primaryPointerType=2,availablePointerTypes=2'];
for (const theme of ['mac-light', 'mac-dark']) for (const viewport of [DESK, PHONE]) {
  test(`Messages, ${theme} at ${viewport.width}: every account newest first, a chat with an agent's draft, an email thread, search and a filter; only Send sends`, { timeout: 120000 }, async t => {
    const browser = await launchChromium({ headless: true, args: ['--no-sandbox', '--disable-gpu', ...(viewport.width < 500 ? TOUCH : [])] });
    t.after(() => browser.close());
    const m = await messagesPage(t, browser, { theme, viewport });
    const { page } = m;

    // The sidebar: Messages beside the sessions, the newest conversations, then all of them.
    if (m.phone) {
      await page.waitForFunction(() => matchMedia('(pointer: coarse)').matches && document.querySelector('#entry-terminal').classList.contains('phone-layout'));
      await page.evaluate(() => harness.toggleRail());
    }
    await page.locator('#session-rail .sidebar-head-title', { hasText: 'Messages' }).waitFor();
    assert.deepEqual(await page.locator('#session-rail .sidebar-head-title').allTextContents(), ['Sessions', 'Files', 'Sites', 'Messages']);
    await page.locator('#session-rail .session-rail-asked', { hasText: 'All messages' }).waitFor();
    const names = await page.locator('#session-rail .session-rail-list .session-rail-asked').allTextContents();
    const at = names.indexOf('Mum');
    assert.deepEqual(names.slice(at), ['Mum', 'Ellie Fleming', 'Priya Shah', 'All messages'], names.join(' | '));
    assert.equal(await sidebarRow(page, 'Mum').locator('.sidebar-unread').count(), 1, 'unread, marked');
    assert.equal(await sidebarRow(page, 'All messages').locator('.sidebar-meta').textContent(), '3');
    await m.shot('sidebar');
    if (m.phone) await page.evaluate(() => harness.toggleRail());
    if (!m.phone) {
      // A conversation chosen in the sidebar opens in the panel beside the session; Files and back.
      await sidebarRow(page, 'Priya Shah').locator('button').first().click();
      await page.locator('.wm-in-panel:not(.wm-tucked) .messages-bubble').first().waitFor();
      assert.equal(await page.evaluate(() => harness.guiSnapshot?.() && document.querySelector('.messages').closest('.wm-window').classList.contains('wm-in-panel')), true);
      await page.waitForFunction(() => [...document.querySelectorAll('#session-rail .sidebar-row.active .session-rail-asked')].map(n => n.textContent).join() === 'Priya Shah');
      await m.shot('panel-chat');
      await sidebarRow(page, 'Home').locator('button').first().click();
      await page.waitForFunction(() => document.querySelector('.messages').closest('.wm-window').classList.contains('wm-tucked'));
      await sidebarRow(page, 'All messages').locator('button').first().click();
      await page.waitForFunction(() => !document.querySelector('.messages').closest('.wm-window').classList.contains('wm-tucked') && document.querySelector('.messages').dataset.view === 'list');
      await page.evaluate(() => harness.showMessages({}));
    }

    await m.show();
    await page.locator('.messages-row').first().waitFor();
    assert.deepEqual(await m.rows(), NEWEST);
    assert.deepEqual(await page.locator('.messages-row.unread').evaluateAll(all => all.map(row => row.dataset.key)), ['chat:acc_whatsapp:chat_mum', 'mail:acc_gmail_home:th_dinner', ...(m.phone ? ['chat:acc_linkedin:chat_priya'] : [])]);
    assert.equal(await page.locator('.messages-row[data-key="chat:acc_whatsapp:chat_mum"] .messages-row-unread').textContent(), '2');
    assert.ok(await m.fits());
    await m.shot('list');

    // An agent drafts a reply to Priya: the list marks it at once, nothing
    // is opened for the person, and it waits in her composer, said as Claude's.
    await runMessagesDraft({ key: 'chat:acc_linkedin:chat_priya', text: 'Thursday at 2 works. I will read the brief first.', harness: 'claude' });
    await page.locator('.messages-row[data-key="chat:acc_linkedin:chat_priya"] .messages-row-draft').waitFor();
    assert.equal(await page.locator('.messages').getAttribute('data-view'), 'list');
    assert.equal(await page.locator('.messages-row[data-key="chat:acc_linkedin:chat_priya"].unread').count(), m.phone ? 1 : 0, 'drafting does not change read state (desktop opened Priya above)');
    await m.shot('drafted');
    await page.locator('.messages-row[data-key="chat:acc_linkedin:chat_priya"]').click();
    await page.locator('.messages-bubble').first().waitFor();
    assert.deepEqual(await page.locator('.messages-msg:not(.event) .messages-bubble').evaluateAll(all => all.map(b => b.closest('.messages-msg').classList.contains('me'))), [false, true, false]);
    assert.equal(await page.locator('.messages-file').getAttribute('href'), '/inbox/attachment?key=chat%3Aacc_linkedin%3Achat_priya&message=m6&id=a6');
    assert.equal(await page.locator('.messages-field').inputValue(), 'Thursday at 2 works. I will read the brief first.');
    assert.match(await page.locator('.messages-drafted').textContent(), /^Drafted by Claude\./);
    assert.equal(await page.locator('.messages-reply-to').textContent(), 'Reply on LinkedIn as Noah Fleming');
    assert.ok(await m.fits());
    await m.shot('chat');
    // Return is a new line, never Send.
    await page.locator('.messages-field').focus();
    await page.keyboard.press('End');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(300);
    assert.deepEqual(m.fake.sent, [], 'nothing sent by drafting, opening or Return');
    assert.equal(await page.locator('.messages-row[data-key="chat:acc_linkedin:chat_priya"].unread').count(), 0, 'read once opened');

    await m.back();
    await page.locator('.messages-row[data-key="mail:acc_gmail_work:th_pilot"]').click();
    await page.locator('.messages-letter').first().waitFor();
    assert.deepEqual(await page.locator('.messages-letter-from').allTextContents(), ['Marcus Lee', 'You', 'Marcus Lee']);
    assert.equal(await page.locator('.messages-reply-to').textContent(), 'To Northwind Pilots <pilots@northwind.example> · Re: Pilot timeline');
    assert.equal(await page.locator('.messages-letter-quoted:visible').count(), 0, 'quotes folded');
    await page.locator('.messages-letter-more').first().click();
    assert.match(await page.locator('.messages-letter-quoted:visible').first().textContent(), /^On Sun, 19 Oct 2026, Marcus Lee wrote:/);
    assert.ok(await m.fits());
    await m.shot('mail');
    await m.back();

    // Search, then one service.
    await page.locator('.messages-search input').fill('roast');
    await page.waitForFunction(() => document.querySelectorAll('.messages-row').length === 1);
    assert.deepEqual(await m.rows(), ['chat:acc_whatsapp:chat_mum']);
    await page.locator('.messages-search input').fill('setup notes');
    await page.waitForFunction(() => [...document.querySelectorAll('.messages-row')].map(r => r.dataset.key).join() === 'mail:acc_gmail_work:th_pilot');
    await m.shot('search');
    await page.locator('.messages-search input').fill('');
    await page.waitForFunction(n => document.querySelectorAll('.messages-row').length === n, NEWEST.length);
    await page.locator('.messages-chip', { hasText: 'WhatsApp' }).click();
    assert.deepEqual(await m.rows(), ['chat:acc_whatsapp:chat_mum', 'chat:acc_whatsapp:chat_climb']);
    await page.locator('.messages-chip', { hasText: 'WhatsApp' }).click();
    assert.deepEqual(await m.rows(), NEWEST, 'toggling the provider off restores every conversation');

    // Connect: the services, X said as not yet.
    await page.locator('.messages-bar .messages-tool[aria-label="Connect an account"]').click();
    await page.locator('.messages-connect').waitFor();
    const choices = await page.locator('.messages-connect .messages-connect-choice').evaluateAll(all => all.map(b => [b.textContent.trim(), b.disabled]));
    assert.deepEqual(choices.at(-1), ['Xnot yet', true]);
    assert.ok(choices.some(([text]) => text === 'Gmail2 connected'), JSON.stringify(choices));
    await m.shot('connect');
    await page.keyboard.press('Escape');

    // The person's own press of Send, once.
    await page.locator('.messages-row[data-key="chat:acc_linkedin:chat_priya"]').click();
    await page.locator('.messages-bubble').first().waitFor();
    await page.locator('.messages-field').fill('Thursday at 2 works.');
    await page.locator('.messages-send').click();
    await page.waitForFunction(() => document.querySelector('.messages-field').value === '');
    assert.deepEqual(m.fake.sent, [{ kind: 'chat', chat: 'chat_priya', text: 'Thursday at 2 works.', account_id: 'acc_linkedin' }]);
    assert.deepEqual(m.errors, []);
  });
}

for (const theme of ['mac-light', 'mac-dark']) {
  test(`Messages, ${theme}: no key says how to get one; no accounts offers each to connect, opening Unipile's sign-in page`, { timeout: 120000 }, async t => {
    const browser = await launchChromium({ headless: true, args: ['--no-sandbox', '--disable-gpu'] });
    t.after(() => browser.close());
    const none = await messagesPage(t, browser, { theme, viewport: DESK, state: 'no-key' });
    await none.show();
    await none.page.locator('.messages-empty-title').waitFor();
    assert.equal(await none.page.locator('.messages-empty-title').textContent(), 'Messages needs a Unipile key');
    assert.match(await none.page.locator('.messages-empty').textContent(), /~\/\.imperfect\/credentials\/unipile\.json/);
    assert.equal(await none.page.locator('.messages-search').isVisible(), false, 'nothing to search');
    assert.equal(await sidebarRow(none.page, 'Set up Messages').count(), 1);
    await none.shot('no-key');
    assert.deepEqual(none.errors, []);

    const empty = await messagesPage(t, browser, { theme, viewport: PHONE, state: 'no-accounts' });
    await empty.show();
    await empty.page.locator('.messages-connect-choice').first().waitFor();
    assert.equal(await empty.page.locator('.messages-empty-title').textContent(), 'Connect your accounts');
    await empty.shot('no-accounts');
    assert.deepEqual(empty.errors, []);

    const desk = await messagesPage(t, browser, { theme, viewport: DESK, state: 'no-accounts' });
    await desk.show();
    await desk.page.locator('.messages-empty .messages-connect-choice', { hasText: 'WhatsApp' }).click();
    await desk.page.waitForFunction(() => harness.guiSnapshot && document.querySelector('.browser-page'));
    assert.deepEqual(desk.fake.links.map(link => link.providers), [['WHATSAPP']]);
    assert.deepEqual(desk.fake.sent, []);
    assert.deepEqual(desk.errors, []);
  });
}

// The demo inbox, on a computer that is not the person's own: invented
// conversations in the sidebar and the panel, said as a demo; Send shows
// the reply and sends nothing.
for (const theme of ['mac-light', 'mac-dark']) {
  test(`Messages, ${theme}: the demo inbox in the sidebar and the panel, and Send that sends nothing`, { timeout: 120000 }, async t => {
    const browser = await launchChromium({ headless: true, args: ['--no-sandbox', '--disable-gpu'] });
    t.after(() => browser.close());
    const m = await messagesPage(t, browser, { theme, viewport: { width: 1920, height: 1080 }, state: 'demo' });
    const { page } = m;
    await page.locator('#session-rail .session-rail-asked', { hasText: 'All messages' }).waitFor();
    const names = await page.locator('#session-rail .session-rail-list .session-rail-asked').allTextContents();
    assert.ok(names.includes('Ingrid Vasquez-Holm') && names.includes('Tobias Ferreira-Lund'), names.join(' | '));
    await sidebarRow(page, 'Tobias Ferreira-Lund').locator('button').first().click();
    await page.locator('.wm-in-panel:not(.wm-tucked) .messages-letter').first().waitFor();
    assert.equal(await page.locator('.messages-demo-tag').isVisible(), true);
    assert.match(await page.locator('.messages-reply-to').textContent(), /^Demo inbox/);
    assert.equal(await page.locator('.messages-bar .messages-tool[aria-label="Connect an account"]').isVisible(), false, 'nothing to connect');
    await m.shot('demo-panel');
    const key = await page.locator('.messages-row').filter({ hasText: 'Tobias Ferreira-Lund' }).getAttribute('data-key');
    await runMessagesDraft({ key, text: 'Wednesday 10am works for us.', harness: 'codex' });
    await page.waitForFunction(() => document.querySelector('.messages-field').value === 'Wednesday 10am works for us.');
    await m.shot('demo-draft');
    assert.equal(await page.locator('.messages-bubble').count(), 0);
    await page.locator('.messages-field').fill('Wednesday 10am works for us.');
    await page.locator('.messages-send').click();
    await page.waitForFunction(() => document.querySelector('.messages-said').textContent.startsWith('Demo'));
    assert.equal(await page.locator('.messages-letter-body').last().textContent(), 'Wednesday 10am works for us.');
    assert.equal(m.fake.requests.length, 0, 'Unipile is never asked');
    assert.deepEqual(m.errors, []);
  });
}

test('a read-and-draft-only loan disables Send/Connect; socket invalidation fetches a draft without read marks; revocation forgets all old words', { timeout: 120000 }, async t => {
  const browser = await launchChromium({ headless: true, args: ['--no-sandbox', '--disable-gpu'] });
  t.after(() => browser.close());
  const m = await messagesPage(t, browser, { theme: 'mac-dark', viewport: { width: 1920, height: 1080 }, state: 'read-only' });
  const { page } = m;
  const key = 'chat:acc_linkedin:chat_priya';
  await m.show();
  await page.locator(`.messages-row[data-key="${key}"]`).click();
  await page.locator('.messages-bubble').first().waitFor();
  assert.equal(await page.locator('.messages-send').isDisabled(), true);
  assert.equal(await page.locator('[aria-label="Connect an account"].messages-tool').isVisible(), false);
  assert.match(await page.locator('.messages-reply-to').textContent(), /sending is off/);
  await page.locator('.messages-field').fill('Keep my unsent words.');
  await page.locator('.messages-field').press('Enter');
  assert.deepEqual(m.fake.sent, []);
  await page.locator('.messages-field').fill('');

  // An invalidation holds no words; the actual server uses this for every
  // session socket, including peer sockets. Only /inbox/ may answer words.
  const paths = [];
  page.on('request', request => { if (request.url().includes('/inbox/thread')) paths.push(request.url()); });
  // Put a draft through the real inbox route, but deliver only an invalidation.
  const refreshed = page.waitForResponse(response => response.url().includes('/inbox/thread'));
  await page.evaluate(async key => {
    await fetch('/inbox/draft', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key, text: 'Draft reached through the guarded route.', by: 'Codex' }) });
  }, key);
  await refreshed;
  await page.waitForFunction(() => document.querySelector('.messages-field').value === 'Draft reached through the guarded route.');
  assert.match(await page.locator('.messages-drafted').textContent(), /Sending is off here/);
  assert.ok(paths.length && paths.every(path => !new URL(path).searchParams.has('seen')), 'background refresh marks nothing read');

  await page.locator('.messages-field').fill('private typed draft to forget');
  await page.locator('.messages-search input').fill('setup notes');
  await page.waitForFunction(() => document.querySelectorAll('.messages-row').length === 1);
  m.setDemo();
  await page.waitForFunction(() => !document.querySelector('.messages-demo-tag').hidden && document.querySelector('.messages').dataset.view === 'list');
  assert.equal(await page.locator('.messages-field').inputValue(), '');
  assert.equal(await page.locator('.messages-search input').inputValue(), '');
  const words = await page.locator('.messages').innerText();
  assert.ok(!words.includes('Priya') && !words.includes('private typed draft') && !words.includes('Northwind'));
  assert.ok((await m.rows()).length >= 12);
  assert.deepEqual(m.fake.sent, []);
  assert.deepEqual(m.errors, []);
});
