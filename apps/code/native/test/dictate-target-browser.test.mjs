import { test } from 'node:test';
import assert from 'node:assert/strict';
import { launchChromium } from '../../../../tools/test-browser.mjs';
import { serve, fixture, fixtureResponse } from '../../tools/gui-preview.mjs';

async function windowFixture(t, agent = 'claude') {
  const { server, sockets, port } = await serve('', { empty: true, agent });
  // Pin the touch surface before its first paint; Electron can otherwise
  // expose its default fine pointer while a touch context is initializing.
  const browser = await launchChromium({ headless: true, args: ['--no-sandbox', '--disable-gpu', '--blink-settings=primaryHoverType=1,availableHoverTypes=1,primaryPointerType=2,availablePointerTypes=2'] });
  t.after(async () => { await browser.close(); for (const socket of sockets.clients) socket.terminate(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const page = await browser.newPage({ viewport: { width: 430, height: 850 }, isMobile: true, hasTouch: true });
  await page.addInitScript(() => {
    window.micPermissionPending = false;
    window.micPermissionRequests = 0;
    Object.defineProperty(navigator, 'mediaDevices', { value: { getUserMedia: () => {
      window.micPermissionRequests++;
      const stream = { getTracks: () => [{ stop() {} }] };
      return window.micPermissionPending ? new Promise(resolve => { window.allowMic = () => resolve(stream); }) : Promise.resolve(stream);
    } } });
    window.MediaRecorder = class { static isTypeSupported() { return true; } start() {} stop() { this.ondataavailable({ data: new Blob(['fixture words'], { type: 'audio/webm' }) }); this.onstop(); } };
  });
  const owners = new Map();
  let refuseFocus = false;
  for (const owner of ['pc', 'laptop']) {
    const snap = fixture({ empty: true, agent });
    snap.instanceId = `${owner}-host-1`;
    snap.sessionId = null;
    snap.tabs[0].sessionId = null;
    owners.set(owner, { snap, socket: null });
  }
  const view = (owner, tab = 'mirror') => {
    const entry = owners.get(owner), snap = structuredClone(entry.snap);
    snap.tabs.forEach(item => { item.focused = item.id === tab; });
    snap.sessionId = snap.tabs.find(item => item.focused)?.sessionId ?? null;
    return snap;
  };
  await page.route('**/machines.json', route => route.fulfill({ json: { machines: [
    { id: 'pc', name: 'PC', self: true, reachable: true }, { id: 'laptop', name: 'Laptop', reachable: true },
  ] } }));
  await page.routeWebSocket(/\/pi$/, socket => {
    const owner = socket.url().includes('/peer/laptop/') ? 'laptop' : 'pc';
    const entry = owners.get(owner);
    entry.socket = socket;
    let tab = 'mirror';
    socket.onMessage(raw => {
      const message = JSON.parse(raw);
      let data = fixtureResponse(message);
      if (message.type === 'snapshot') data = view(owner, tab);
      if (message.type === 'tab-focus' && refuseFocus) {
        socket.send(JSON.stringify({ type: 'response', id: message.id, success: false, error: 'fixture focus failed' }));
        return;
      }
      if (message.type === 'tab-focus') {
        tab = message.tabId;
        data = { ...view(owner, tab).tabs.find(item => item.id === tab), snapshot: view(owner, tab) };
      }
      socket.send(JSON.stringify({ type: 'response', id: message.id, success: true, data }));
    });
    socket.send(JSON.stringify({ type: 'snapshot', data: view(owner) }));
  });
  const sent = [], uploads = [];
  let reject = false, pendingResponse = null;
  await page.route('**/upload', route => { uploads.push({ url: route.request().url(), headers: route.request().headers(), bytes: route.request().postDataBuffer()?.toString() }); return route.fulfill({ json: { path: '/fixture/plan.txt', size: 4, reference: { name: 'fixture-saved', sessionId: null } } }); });
  await page.route('**/dictate', async route => {
    const req = route.request();
    const { audio, ...prompt } = req.postDataJSON();
    sent.push({ prompt, audio });
    await pendingResponse;
    await route.fulfill({ status: reject ? 422 : 200, json: reject ? { error: 'fixture could not hear it' } : { accepted: true, words: 'fixture words' } });
  });
  await page.goto(`http://127.0.0.1:${port}/?face=code`);
  await page.waitForSelector('[data-owner="pc"][data-tab-id="mirror"]');
  const mic = page.locator('.entry-voice[data-state]');
  const wait = state => page.waitForFunction(state => document.querySelector('.entry-voice[data-state]')?.dataset.state === state, state);
  const select = async (owner, tab) => {
    await page.locator(`[data-owner="${owner}"][data-tab-id="${tab}"]`).click();
    await page.waitForFunction(() => !document.querySelector('#entry-output').classList.contains('entry-switching'));
    // tab focus is acknowledged before the transition callback settles.
    await page.waitForTimeout(100);
  };
  const push = (owner, tab = 'mirror') => owners.get(owner).socket.send(JSON.stringify({ type: 'snapshot', data: view(owner, tab) }));
  return { page, mic, sent, uploads, wait, select, push, owners, refuse: value => { reject = value; }, refuseFocus: value => { refuseFocus = value; },
    holdResponse: () => { let release; pendingResponse = new Promise(resolve => { release = resolve; }); return () => { pendingResponse = null; release(); }; } };
}

for (const agent of ['claude', 'pi']) test(`visible fresh ${agent} tab can send its first mic prompt with null session, despite keyboard resize and snapshots`, async t => {
  const { page, mic, wait, push, sent } = await windowFixture(t, agent);
  await page.locator('#entry-input').fill('typed prefix');
  await mic.click(); await wait('recording');
  await page.setViewportSize({ width: 430, height: 460 });
  await page.locator('#entry-input').focus();
  push('pc');
  await mic.click(); await wait('idle');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].prompt.tab, 'mirror');
  assert.equal(sent[0].prompt.session, null);
  assert.equal(sent[0].prompt.instanceId, 'pc-host-1');
  assert.equal(sent[0].prompt.machine, undefined);
  assert.equal(sent[0].prompt.text, 'typed prefix');
  assert.equal(await page.locator('#entry-input').inputValue(), '');
  assert.equal(await page.locator('#entry-terminal.fresh').count(), 0, 'a spoken first prompt also sends the bar down');
  assert.equal(await page.locator('.gui-typing-who').textContent(), 'Locus is typing…');
});

test('permission, tab and machine changes cannot redirect a recording or a failed retry; original prefix and request id are retained', async t => {
  const { page, mic, wait, sent, select, refuse } = await windowFixture(t);
  await page.locator('#entry-input').fill('original prefix');
  await page.evaluate(() => { window.micPermissionPending = true; });
  await mic.click(); await wait('hearing');
  await select('pc', 'other');
  await page.evaluate(() => window.allowMic()); await wait('recording');
  await page.locator('#entry-input').fill('other draft');
  await mic.click(); await wait('kept');
  assert.equal(sent.length, 0);
  assert.match(await page.locator('#entry-flash').textContent(), /another tab or computer/);
  assert.equal(await page.locator('#entry-input').inputValue(), 'other draft');
  await select('pc', 'mirror');
  refuse(true);
  await mic.click(); await wait('kept');
  assert.equal(sent.length, 1);
  assert.equal(await page.locator('#entry-input').inputValue(), 'original prefix');
  await select('laptop', 'mirror');
  await mic.click(); await wait('kept');
  assert.equal(sent.length, 1, 'even an identically named remote tab cannot receive it');
  await select('pc', 'mirror');
  await page.locator('#entry-input').fill('original prefix\n\nnew draft');
  refuse(false);
  await mic.click(); await wait('idle');
  assert.deepEqual(sent[1], sent[0], 'same audio, frozen prefix, target and id on retry');
  assert.equal(await page.locator('#entry-input').inputValue(), 'new draft');
});

test('cancelling pending microphone permission clears the recording hold and permits a fresh attempt', async t => {
  const { page, mic, wait, sent } = await windowFixture(t);
  await page.evaluate(() => { window.micPermissionPending = true; });
  await mic.click(); await wait('hearing');
  await page.keyboard.press('Escape');
  await page.evaluate(() => { window.micPermissionPending = false; window.allowMic(); });
  await wait('idle');
  assert.equal(sent.length, 0);
  await mic.click(); await wait('recording');
  await mic.click(); await wait('idle');
  assert.equal(sent.length, 1);
});

test('changing computers during an active recording never sends to the new computer', async t => {
  const { mic, wait, sent, select } = await windowFixture(t);
  await mic.click(); await wait('recording');
  await select('laptop', 'mirror');
  await mic.click(); await wait('kept');
  assert.equal(sent.length, 0);
  await select('pc', 'mirror');
  await mic.click(); await wait('idle');
  assert.equal(sent[0].prompt.machine, undefined);
  assert.equal(sent[0].prompt.tab, 'mirror');
});

test('an HTTP failure after machine navigation restores only the original draft and attachment', async t => {
  const { page, mic, wait, sent, select, refuse, owners, push, holdResponse } = await windowFixture(t);
  owners.get('pc').snap.tabs[0].sessionId = 'original-session';
  push('pc');
  await page.waitForTimeout(100);
  await page.locator('#entry-input').fill('original prefix');
  await page.locator('#entry-files').setInputFiles({ name: 'plan.txt', mimeType: 'text/plain', buffer: Buffer.from('plan') });
  await page.waitForSelector('.entry-pending-chip:not(.is-uploading)', { state: 'attached' });
  refuse(true);
  const release = holdResponse();
  await mic.click(); await wait('recording');
  await mic.click(); await wait('hearing');
  await page.waitForFunction(() => document.querySelector('#entry-input').value === '');
  await select('laptop', 'mirror');
  await page.locator('#entry-input').fill('remote draft');
  release(); await wait('kept');
  assert.equal(await page.locator('#entry-input').inputValue(), 'remote draft');
  assert.equal(await page.locator('.entry-pending-chip').count(), 0);
  await select('pc', 'mirror');
  assert.equal(await page.locator('#entry-input').inputValue(), 'original prefix');
  assert.equal(await page.locator('.entry-pending-chip').count(), 1);
  refuse(false);
  await mic.click(); await wait('idle');
  assert.equal(sent[0].prompt.text, 'original prefix');
  assert.deepEqual(sent[1], sent[0]);
  assert.equal(await page.locator('.entry-pending-chip').count(), 0);
});

test('a lazy session id arriving during a failed HTTP request keeps its prefix on the original owner', async t => {
  const { page, mic, wait, select, refuse, owners, push, holdResponse } = await windowFixture(t);
  await page.locator('#entry-input').fill('lazy prefix');
  refuse(true);
  const release = holdResponse();
  await mic.click(); await wait('recording');
  await mic.click(); await wait('hearing');
  owners.get('pc').snap.tabs[0].sessionId = 'lazy-created';
  push('pc');
  await select('laptop', 'mirror');
  await page.locator('#entry-input').fill('remote draft');
  release(); await wait('kept');
  assert.equal(await page.locator('#entry-input').inputValue(), 'remote draft');
  await select('pc', 'mirror');
  assert.equal(await page.locator('#entry-input').inputValue(), 'lazy prefix');
});

test('a failed focus attempt clears switching and can resume the original mic target safely', async t => {
  const { page, mic, wait, sent, select, refuseFocus, push } = await windowFixture(t);
  refuseFocus(true);
  await select('pc', 'other');
  assert.match(await page.locator('#entry-flash').textContent(), /focus failed/);
  refuseFocus(false);
  // A fresh owner snapshot resolves the conservative disconnected guard.
  push('pc');
  await select('pc', 'mirror');
  await mic.click(); await wait('recording');
  await mic.click(); await wait('idle');
  assert.equal(sent[0].prompt.tab, 'mirror');
});

for (const owner of ['pc', 'laptop']) for (const phase of ['permission', 'recording', 'retry']) test(`replacing ${owner}'s host during ${phase} cannot send held null-target speech to a reused focused tab`, async t => {
  const { page, mic, wait, sent, owners, push, refuse, select } = await windowFixture(t);
  if (owner === 'laptop') await select(owner, 'mirror');
  await page.locator('#entry-input').fill('original draft');
  if (phase === 'permission') await page.evaluate(() => { window.micPermissionPending = true; });
  await mic.click(); await wait(phase === 'permission' ? 'hearing' : 'recording');
  if (phase === 'retry') {
    refuse(true);
    await mic.click(); await wait('kept');
    assert.equal(sent[0].prompt.instanceId, `${owner}-host-1`);
    assert.equal(await page.locator('#entry-input').inputValue(), 'original draft');
  }
  owners.get(owner).snap.instanceId = `${owner}-host-2`;
  push(owner);
  await page.waitForTimeout(100);
  await page.locator('#entry-input').fill('replacement draft');
  if (phase === 'permission') {
    await page.evaluate(() => { window.micPermissionPending = false; window.allowMic(); }); await wait('recording');
  }
  const previous = sent.length;
  await mic.click(); await wait('kept');
  assert.equal(sent.length, previous, 'connected owner and same focused tab id are not sufficient');
  assert.equal(await page.locator('#entry-input').inputValue(), 'replacement draft');
  assert.match(await page.locator('#entry-flash').textContent(), /no longer open/);
  await mic.click(); await wait('kept');
  assert.equal(sent.length, previous, 'retry must not recapture the replacement host stamp');
  // Restore only the mock host to inspect the kept audio/body without a live restart.
  owners.get(owner).snap.instanceId = `${owner}-host-1`; push(owner);
  await page.waitForTimeout(100); refuse(false);
  await mic.click(); await wait('idle');
  assert.equal(sent.at(-1).audio.name, 'fixture-saved', 'uploaded speech reference was kept');
  assert.equal(sent.at(-1).prompt.instanceId, `${owner}-host-1`);
  if (phase === 'retry') assert.deepEqual(sent.at(-1), sent[0], 'requested null session, stamp, prefix and id stay immutable');
  owners.get(owner).snap.instanceId = `${owner}-host-2`; push(owner);
  await page.waitForTimeout(100);
  await mic.click(); await wait('recording');
  await mic.click(); await wait('idle');
  assert.equal(sent.at(-1).prompt.instanceId, `${owner}-host-2`, 'a fresh mic captures the new host');
});

test('an HTTP failure after a mock host replacement cannot restore the old prefix into the reused null tab', async t => {
  const { page, mic, wait, sent, owners, push, refuse, holdResponse } = await windowFixture(t);
  await page.locator('#entry-input').fill('old prefix');
  refuse(true); const release = holdResponse();
  await mic.click(); await wait('recording');
  await mic.click(); await wait('hearing');
  await page.waitForFunction(() => document.querySelector('#entry-input').value === '');
  owners.get('pc').snap.instanceId = 'pc-host-2'; push('pc');
  await page.waitForTimeout(100);
  await page.locator('#entry-input').fill('replacement draft');
  release(); await wait('kept');
  assert.equal(await page.locator('#entry-input').inputValue(), 'replacement draft');
  await mic.click(); await wait('kept');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].prompt.instanceId, 'pc-host-1');
  assert.equal(sent[0].prompt.text, 'old prefix');
  assert.equal(await page.locator('#entry-input').inputValue(), 'replacement draft');
  // The old audio and prefix remain held, not reassigned to the replacement.
  owners.get('pc').snap.instanceId = 'pc-host-1'; push('pc');
  await page.waitForTimeout(100); refuse(false);
  await mic.click(); await wait('idle');
  assert.deepEqual(sent[1], sent[0]);
  assert.equal(await page.locator('#entry-input').inputValue(), '', 'restored original host must not inherit its replacement’s draft');
  owners.get('pc').snap.instanceId = 'pc-host-2'; push('pc');
  await page.waitForTimeout(100);
  assert.equal(await page.locator('#entry-input').inputValue(), 'replacement draft', 'replacement keeps its own scoped draft');
});

test('a fresh tab on an unstamped older backend fails before permission with update or typed-first guidance', async t => {
  const { page, mic, wait, sent, owners, push } = await windowFixture(t);
  delete owners.get('pc').snap.instanceId; push('pc');
  await page.waitForTimeout(100);
  await page.locator('#entry-input').fill('draft untouched');
  await mic.click(); await wait('idle');
  assert.equal(await page.evaluate(() => window.micPermissionRequests), 0);
  assert.equal(sent.length, 0);
  assert.equal(await page.locator('#entry-input').inputValue(), 'draft untouched');
  assert.match(await page.locator('#entry-flash').textContent(), /update imperfect.*typed first message/);
  owners.get('pc').snap.tabs[0].sessionId = 'typed-first'; push('pc');
  await page.waitForTimeout(100);
  await mic.click(); await wait('recording');
  await mic.click(); await wait('idle');
  assert.equal(sent[0].prompt.session, 'typed-first');
  assert.equal(sent[0].prompt.instanceId, undefined, 'existing SID does not require a host stamp');
});

test('existing-session speech survives a host lifetime change only with the same actual session id', async t => {
  const { page, mic, wait, sent, owners, push } = await windowFixture(t);
  owners.get('pc').snap.tabs[0].sessionId = 'existing'; push('pc');
  await page.waitForTimeout(100);
  await mic.click(); await wait('recording');
  owners.get('pc').snap.instanceId = 'pc-host-2'; push('pc');
  await page.waitForTimeout(100);
  await mic.click(); await wait('idle');
  assert.equal(sent[0].prompt.session, 'existing');
  await mic.click(); await wait('recording');
  owners.get('pc').snap.tabs[0].sessionId = 'unrelated'; push('pc');
  await page.waitForTimeout(100);
  await page.locator('#entry-input').fill('unrelated draft');
  await mic.click(); await wait('kept');
  assert.equal(sent.length, 1);
  assert.equal(await page.locator('#entry-input').inputValue(), 'unrelated draft');
});

test('remote fresh speech carries its captured peer host stamp through a lazy identity upgrade and retry', async t => {
  const { mic, wait, sent, owners, push, select, refuse, page } = await windowFixture(t);
  await select('laptop', 'mirror');
  await mic.click(); await wait('recording');
  refuse(true); await mic.click(); await wait('kept');
  assert.equal(sent[0].prompt.machine, undefined, 'routing is in /peer/, not in the command');
  assert.equal(sent[0].prompt.instanceId, 'laptop-host-1');
  owners.get('laptop').snap.tabs[0].sessionId = 'lazy-created'; push('laptop');
  await page.waitForTimeout(100);
  refuse(false); await mic.click(); await wait('idle');
  assert.deepEqual(sent[1], sent[0], 'lazy ID arrival must not rewrite the frozen null request');
  assert.equal(sent[1].prompt.session, null);
});

test('closing the original target keeps its recording and explains why it cannot be sent', async t => {
  const { mic, wait, sent, owners, push, page } = await windowFixture(t);
  await mic.click(); await wait('recording');
  owners.get('pc').snap.tabs = owners.get('pc').snap.tabs.filter(tab => tab.id !== 'mirror');
  push('pc', 'other');
  await page.waitForSelector('[data-owner="pc"][data-tab-id="mirror"]', { state: 'detached' });
  await mic.click(); await wait('kept');
  assert.equal(sent.length, 0);
  assert.match(await page.locator('#entry-flash').textContent(), /no longer open/);
  await mic.click(); await wait('kept');
  assert.equal(sent.length, 0);
  await page.keyboard.press('Escape'); await wait('idle');
});


test('imported audio retries its uploaded reference on the captured owner and returns words only to its original draft', async t => {
  const { page, mic, wait, select, uploads } = await windowFixture(t);
  await select('laptop', 'mirror');
  await page.locator('#entry-input').fill('original draft');
  const requests = [];
  let release;
  let reject = true;
  await page.route('**/transcribe', async route => {
    requests.push({ url: route.request().url(), body: route.request().postDataJSON() });
    if (!reject) await new Promise(resolve => { release = resolve; });
    await route.fulfill({ status: reject ? 503 : 200, json: reject ? { error: 'fixture decoder unavailable' } : { text: 'heard meeting words' } });
  });
  await page.locator('#entry-files').setInputFiles({ name: 'meeting.wav', mimeType: 'audio/wav', buffer: Buffer.from('uploaded sound') });
  await wait('kept');
  assert.equal(uploads.length, 1);
  assert.match(uploads[0].url, /\/peer\/laptop\/upload$/);
  assert.equal(uploads[0].headers['x-instance-id'], 'laptop-host-1');
  assert.equal(uploads[0].bytes, 'uploaded sound');
  reject = false;
  await mic.click(); await wait('hearing');
  await page.waitForTimeout(50);
  await select('pc', 'mirror');
  await page.locator('#entry-input').fill('local draft');
  release(); await wait('idle');
  assert.equal(await page.locator('#entry-input').inputValue(), 'local draft');
  await select('laptop', 'mirror');
  assert.match(await page.locator('#entry-input').inputValue(), /original draft/);
  assert.match(await page.locator('#entry-input').inputValue(), /heard meeting words/);
  assert.deepEqual(requests[0], requests[1]);
  assert.equal(uploads.length, 1, 'retry does not upload the audio again');
});

for (const replace of [false, true]) test(`imported audio ${replace ? 'cannot enter a replacement null tab' : 'follows its own lazy session identity upgrade'} while hearing`, async t => {
  const { page, wait, owners, push } = await windowFixture(t);
  await page.locator('#entry-input').fill('original draft');
  let release;
  await page.route('**/transcribe', async route => {
    await new Promise(resolve => { release = resolve; });
    await route.fulfill({ json: { text: 'imported words' } });
  });
  await page.locator('#entry-files').setInputFiles({ name: 'meeting.wav', mimeType: 'audio/wav', buffer: Buffer.from('sound') });
  await wait('hearing');
  for (let i = 0; !release && i < 100; i++) await page.waitForTimeout(10);
  if (replace) owners.get('pc').snap.instanceId = 'replacement-host';
  else owners.get('pc').snap.tabs[0].sessionId = 'lazy-created';
  push('pc'); await page.waitForTimeout(100);
  if (replace) await page.locator('#entry-input').fill('replacement draft');
  release(); await wait(replace ? 'kept' : 'idle');
  const text = await page.locator('#entry-input').inputValue();
  if (replace) assert.equal(text, 'replacement draft');
  else { assert.match(text, /original draft/); assert.match(text, /imported words/); }
});

test('imported audio retains its background draft across a lazy session identity upgrade', async t => {
  const { page, wait, owners, push, select } = await windowFixture(t);
  await page.locator('#entry-input').fill('background prefix');
  let release;
  await page.route('**/transcribe', async route => {
    await new Promise(resolve => { release = resolve; });
    await route.fulfill({ json: { text: 'background words' } });
  });
  await page.locator('#entry-files').setInputFiles({ name: 'meeting.wav', mimeType: 'audio/wav', buffer: Buffer.from('sound') });
  await wait('hearing');
  for (let i = 0; !release && i < 100; i++) await page.waitForTimeout(10);
  await select('laptop', 'mirror');
  await page.locator('#entry-input').fill('remote draft');
  owners.get('pc').snap.tabs[0].sessionId = 'lazy-created'; push('pc');
  release(); await wait('idle');
  assert.equal(await page.locator('#entry-input').inputValue(), 'remote draft');
  await select('pc', 'mirror');
  const text = await page.locator('#entry-input').inputValue();
  assert.match(text, /background prefix/);
  assert.match(text, /background words/);
});

for (const kind of ['photo', 'file']) for (const owner of ['pc', 'laptop']) test(`background ${owner} fresh-tab ${kind} draft follows its first SID (${owner === 'pc' ? 'upload pending, same-owner navigation' : 'upload ready, cross-owner navigation'})`, async t => {
  const { page, owners, push, select } = await windowFixture(t);
  if (owner !== 'pc') await select(owner, 'mirror');
  let release;
  if (owner === 'pc') await page.route('**/upload', async route => {
    await new Promise(resolve => { release = resolve; });
    await route.fulfill({ json: { reference: { name: 'captured-original', sessionId: null }, size: 4 } });
  });
  await page.locator('#entry-input').fill('original prefix');
  await page.locator('#entry-files').setInputFiles({ name: kind === 'photo' ? 'photo.png' : 'plan.txt',
    mimeType: kind === 'photo' ? 'image/png' : 'text/plain', buffer: Buffer.from('body') });
  if (owner === 'pc') await page.locator('.entry-pending-chip.is-uploading').waitFor();
  else await page.waitForFunction(() => document.querySelector('#entry-plus').classList.contains('has-files') && !document.querySelector('.entry-pending-chip.is-uploading'));
  const prefix = await page.locator('#entry-input').inputValue();
  await select('pc', owner === 'pc' ? 'other' : 'mirror');
  await page.locator('#entry-input').fill('unrelated draft');
  owners.get(owner).snap.tabs[0].sessionId = 'created-elsewhere';
  push(owner, owner === 'pc' ? 'other' : 'mirror');
  await page.waitForTimeout(100);
  if (release) { release(); await page.waitForTimeout(100); }
  assert.equal(await page.locator('#entry-input').inputValue(), 'unrelated draft');
  assert.equal(await page.locator('.entry-pending-chip').count(), 0);
  await select(owner, 'mirror');
  assert.equal(await page.locator('#entry-input').inputValue(), prefix);
  assert.equal(await page.locator('#entry-plus span').textContent(), '1', 'original attachment remains in the upgraded draft');
  assert.equal(await page.locator('.entry-pending-chip:not(.is-uploading)').count(), kind === 'photo' ? 0 : 1);
});

for (const kind of ['photo', 'file']) for (const owner of ['pc', 'laptop']) test(`background ${owner} ${kind} draft cannot migrate into a replacement host's colliding tab/SID`, async t => {
  const { page, owners, push, select } = await windowFixture(t);
  if (owner !== 'pc') await select(owner, 'mirror');
  await page.locator('#entry-input').fill('original private draft');
  await page.locator('#entry-files').setInputFiles({ name: kind === 'photo' ? 'photo.png' : 'plan.txt',
    mimeType: kind === 'photo' ? 'image/png' : 'text/plain', buffer: Buffer.from('body') });
  await page.waitForFunction(() => document.querySelector('#entry-plus').classList.contains('has-files') && !document.querySelector('.entry-pending-chip.is-uploading'));
  const original = await page.locator('#entry-input').inputValue();
  await select('pc', owner === 'pc' ? 'other' : 'mirror');
  await page.locator('#entry-input').fill('unrelated draft');
  owners.get(owner).snap.instanceId = `${owner}-replacement`;
  owners.get(owner).snap.tabs[0].sessionId = 'replacement-session';
  push(owner, owner === 'pc' ? 'other' : 'mirror');
  await page.waitForTimeout(100);
  // The host replacement may also replace the null-session foreground tab.
  await select(owner, 'mirror');
  assert.equal(await page.locator('#entry-input').inputValue(), '');
  assert.equal(await page.locator('.entry-pending-chip').count(), 0);
  await page.locator('#entry-input').fill('replacement draft');
  // Returning only the mock owner to its old lifetime shows the quarantined
  // draft still exists. Nothing was deleted or rebound to the new owner.
  owners.get(owner).snap.instanceId = `${owner}-host-1`;
  owners.get(owner).snap.tabs[0].sessionId = null;
  push(owner);
  await page.waitForTimeout(100);
  assert.equal(await page.locator('#entry-input').inputValue(), original);
  assert.equal(await page.locator('#entry-plus span').textContent(), '1');
  assert.equal(await page.locator('.entry-pending-chip').count(), kind === 'photo' ? 0 : 1);
});
