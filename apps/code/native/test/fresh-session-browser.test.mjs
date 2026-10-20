// A new session is a question and an input bar, on the computer the window
// is on. Nothing is made until it is used; the first prompt sends the bar
// down. Kinso's window (?for=kinso) wears Kinso's name and its sharks.
import test from 'node:test';
import assert from 'node:assert/strict';
import { harnessFixture } from './fixtures/harness-page.mjs';

const MESSAGES = [{ role: 'user', content: 'hello' }, { role: 'assistant', content: [{ type: 'text', text: 'hi' }] }];
const HARNESSES = [
  { agent: 'pi', ready: true, usual: false },
  { agent: 'claude', ready: true, usual: true, model: { provider: 'claude-agent', id: 'claude-sonnet-5-5' } },
  { agent: 'codex', ready: false, usual: false, blocked: 'Sign in to Codex in imperfect' },
];
const MODELS = [
  { provider: 'claude-agent', id: 'claude-sonnet-5-5', name: 'Sonnet', engine: 'claude', billing: 'Claude subscription' },
  { provider: 'claude-agent', id: 'claude-haiku-5-5', name: 'Haiku', engine: 'claude', billing: 'Claude subscription' },
  { provider: 'fixture', id: 'fixture', name: 'fixture', engine: 'pi', billing: 'API' },
];
const MACHINES = [
  { id: 'a', name: 'desktop', self: true, online: true, reachable: true },
  { id: 'vm', name: 'cloud', hosted: true, online: true, reachable: true },
];

// A computer that makes the new tab it is asked for, focused and empty, and
// takes the prompt sent to it.
async function freshFixture(options = {}) {
  const f = await harnessFixture({ messages: MESSAGES, machines: MACHINES, snapshot: { harnesses: HARNESSES }, ...options });
  f.made = []; f.prompts = [];
  f.answer = (command, owner) => {
    if (command.type === 'models') return MODELS;
    if (command.type === 'tab-new') {
      f.made.push({ ...command, owner });
      const tab = { id: 'tab-new', sessionId: 'thread-new', focused: true, agent: command.agent ?? 'claude', name: 'new', prompt: '', status: 'idle' };
      const next = { ...f.tab, sessionId: 'thread-new', tabId: 'tab-new', agent: tab.agent, messages: [], busy: false, streaming: false,
        tabs: [...f.tab.tabs.map(row => ({ ...row, focused: false })), tab] };
      f.tab = next;
      return { snapshot: next };
    }
    if (command.type === 'prompt') { f.prompts.push(command); return { accepted: true }; }
    return undefined;
  };
  return f;
}
const barMiddle = page => page.evaluate(() => { const box = document.querySelector('#entry-input-zone').getBoundingClientRect(); return box.top + box.height / 2; });

test('a new session asks what is wanted over its bar, names the harness, and makes nothing until the first prompt', async () => {
  const f = await freshFixture(); const { page } = f;
  try {
    assert.equal(await page.evaluate(() => document.documentElement.dataset.brand), 'imperfect');
    assert.equal(await page.locator('.kinso-sharks').count(), 0, 'imperfect has no sea');
    assert.equal(await page.locator('#entry-input').getAttribute('placeholder'), 'Message');
    const foot = await barMiddle(page);
    await page.evaluate(() => harness.newTab());
    await page.waitForSelector('#entry-terminal.fresh .fresh-question');
    assert.equal(await page.locator('.fresh-question').textContent(), 'what do you want?');
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'entry-input', 'the keys go to the bar');
    await page.waitForFunction(foot => { const box = document.querySelector('#entry-input-zone').getBoundingClientRect(); return box.top + box.height / 2 < foot - 100; }, foot);
    // Harness and model before a prompt is sent: the brand's mark, the model, the harness in words.
    await page.waitForFunction(() => document.querySelector('#entry-pi-label .entry-harness-name')?.textContent === 'Claude Code');
    await page.waitForFunction(() => document.querySelector('#entry-pi-label .entry-model-name')?.textContent === 'Sonnet 5.5');
    assert.equal(await page.locator('#entry-pi-label .brand-mark').getAttribute('data-brand'), 'imperfect');
    // Computer choice lives inside this picker, not on the fresh screen.
    await page.locator('#entry-pi-label').click();
    await page.locator('#entry-dialog .entry-dialog-option', { hasText: 'Haiku 5.5' }).waitFor();
    const rows = await page.locator('#entry-dialog .entry-dialog-option').allTextContents();
    assert.ok(rows.some(row => /Codex · sign in/.test(row)), rows.join(' | '));
    assert.deepEqual(await page.locator('#entry-dialog [data-computer] .entry-dialog-option-label').allTextContents(), ['desktop', 'cloud']);
    assert.equal(await page.locator('#entry-terminal .computer-choice').count(), 0);
    await page.locator('#entry-dialog .entry-dialog-option', { hasText: 'Haiku 5.5' }).click();
    await page.waitForFunction(() => document.querySelector('#entry-pi-label .entry-model-name')?.textContent === 'Haiku 5.5');
    assert.equal(f.made.length, 0, 'opening and picking make nothing');
    await page.locator('#entry-input').fill('hello there');
    await page.keyboard.press('Enter');
    // The question goes, the bar goes down, what was asked shows with the typing line.
    await page.waitForSelector('#entry-terminal.fresh-move:not(.fresh)');
    await page.waitForSelector('#entry-output .gui-typing');
    assert.match(await page.locator('#entry-output .gui-typing .gui-typing-who').textContent(), /^Locus is typing…$/);
    assert.equal(await page.locator('#entry-output').getAttribute('aria-live'), 'polite');
    await page.waitForFunction(() => !document.querySelector('#entry-terminal.fresh-move'));
    assert.ok(Math.abs(await barMiddle(page) - foot) < 2, 'the bar is back at its place');
    assert.deepEqual(f.made.map(command => [command.agent, command.model?.id, command.owner]), [['claude', 'claude-haiku-5-5', '']], 'made here, on what was picked');
    await page.waitForFunction(() => document.querySelector('#entry-input').value === '');
    assert.equal(f.prompts.length, 1);
    assert.equal(f.prompts[0].text, 'hello there');
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('Escape leaves a new session unmade; going back to a session shows it as it was, without the move', async () => {
  const f = await freshFixture(); const { page } = f;
  try {
    await page.evaluate(() => harness.newTab());
    await page.waitForSelector('#entry-terminal.fresh');
    await page.locator('#entry-input').fill('not yet');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('#entry-terminal.choosing'));
    assert.equal(await page.locator('#entry-terminal.fresh, #entry-terminal.fresh-move').count(), 0);
    assert.equal(await page.locator('#entry-input').inputValue(), '', 'the session keeps its own draft');
    await page.evaluate(() => harness.newTab());
    await page.waitForSelector('#entry-terminal.fresh');
    assert.equal(await page.locator('#entry-input').inputValue(), 'not yet', 'and the new one keeps its own');
    assert.equal(f.made.length, 0);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('with less motion the first prompt puts the bar in its place at once', async () => {
  const f = await freshFixture(); const { page } = f;
  try {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.evaluate(() => harness.newTab());
    await page.waitForSelector('#entry-terminal.fresh');
    await page.evaluate(() => { window.moved = false; new MutationObserver(() => { if (document.querySelector('#entry-terminal.fresh-move')) window.moved = true; }).observe(document.querySelector('#entry-terminal'), { attributes: true }); });
    await page.locator('#entry-input').fill('hello');
    await page.keyboard.press('Enter');
    await page.waitForSelector('#entry-terminal:not(.fresh)');
    assert.equal(await page.evaluate(() => window.moved), false);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('the sidebar names sessions without marks', async () => {
  const f = await freshFixture(); const { page } = f;
  try {
    const rows = page.locator('#session-rail .session-rail-item:not(.session-rail-new)');
    await rows.first().waitFor({ state: 'attached' });
    assert.equal(await rows.locator('.session-rail-line :is(svg, .session-rail-logo, img)').count(), 0, 'no decorative row marks; close buttons remain operable');
    assert.equal(await rows.first().locator('.session-rail-asked').textContent(), 'make a game');
  } finally { await f.close(); }
});

test('Kinso\'s window: its name from the address for the tab, its mark, and sharks throughout the conversation', async () => {
  const f = await freshFixture(); const { page } = f;
  try {
    const origin = new URL(page.url()).origin;
    const mount = async query => {
      await page.goto(`${origin}/${query}`);
      await page.evaluate(async () => { const { mountGueyPi } = await import('/js/harness.js'); window.harness = mountGueyPi({ hooks: { canFocus: () => true } }); });
      await page.waitForFunction(() => harness.guiSnapshot().tabs.length > 0);
    };
    await mount('?for=kinso');
    assert.equal(await page.evaluate(() => document.documentElement.dataset.brand), 'kinso');
    assert.equal(await page.title(), 'Kinso');
    // Kept for the tab: the next address need not say it.
    await mount('');
    assert.equal(await page.evaluate(() => document.documentElement.dataset.brand), 'kinso');
    assert.equal(await page.locator('#entry-pi-label .brand-mark').getAttribute('data-brand'), 'kinso');
    assert.equal(await page.locator('#entry-input').getAttribute('placeholder'), 'what do you want?');
    assert.equal(await page.locator('.fresh-question').count(), 0);
    const sea = () => page.evaluate(() => Number(getComputedStyle(document.querySelector('.kinso-sharks')).opacity));
    assert.equal(await sea(), 1, 'sharks behind an existing conversation');
    await page.setViewportSize({ width: 1920, height: 1080 });
    await page.evaluate(() => { for (const style of document.querySelectorAll('style')) if (style.textContent.startsWith('#harness-reach')) style.textContent = '#harness-reach{display:none}'; });
    await page.evaluate(() => harness.newTab());
    await page.waitForSelector('#entry-terminal.choosing');
    assert.equal(await page.locator('.fresh-question').count(), 0);
    assert.equal(await page.locator('#entry-input').getAttribute('placeholder'), 'what do you want?');
    await page.waitForFunction(() => Number(getComputedStyle(document.querySelector('.kinso-sharks')).opacity) === 1);
    await page.evaluate(() => { for (const a of document.getAnimations()) if (Number.isFinite(a.effect?.getComputedTiming().endTime)) a.finish(); });
    const geometry = await page.evaluate(() => {
      const input = document.querySelector('#entry-input-zone').getBoundingClientRect(), status = document.querySelector('.entry-status').getBoundingClientRect();
      const model = document.querySelector('#entry-pi-label').getBoundingClientRect(), send = document.querySelector('#entry-send').getBoundingClientRect();
      return { width: input.width, height: status.bottom - input.top, modelLeft: model.left, sendLeft: send.left, modelTop: model.top, statusTop: status.top };
    });
    assert.equal(geometry.width, 720);
    assert.equal(geometry.height, 63);
    assert.ok(geometry.modelLeft < geometry.sendLeft && geometry.modelTop >= geometry.statusTop, 'model and harness bottom left, send right');
    await page.locator('#entry-input').fill('hello');
    await page.keyboard.press('Enter');
    await page.waitForSelector('#entry-output .gui-typing');
    assert.match(await page.locator('#entry-output .gui-typing .gui-typing-who').textContent(), /^Kinso is typing…$/);
    assert.equal(await sea(), 1, 'sharks remain behind the first output');
    assert.equal(await page.locator('#entry-terminal.fresh-move').count(), 0);
    assert.equal(await page.locator('.fresh-question').count(), 0);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

for (const reduced of [false, true]) test(`Kinso starts empty at the foot with a live or still sea (${reduced ? 'reduced motion' : 'motion'})`, async () => {
  const f = await freshFixture({ productOrigin: 'https://computer.kinso.computer', messages: [],
    snapshot: { tabs: [{ id: 'tab-a', sessionId: 'thread-a', focused: true, agent: 'pi', prompt: '', status: 'idle' }], harnesses: HARNESSES } });
  const { page } = f;
  try {
    await page.emulateMedia({ reducedMotion: reduced ? 'reduce' : 'no-preference', colorScheme: 'dark' });
    assert.equal(await page.locator('html').getAttribute('data-kinso-theme'), 'auto');
    await page.waitForFunction(() => document.querySelector('.kinso-sharks')?.dataset.palette === 'dark');
    const sea = await page.locator('.kinso-sharks').elementHandle();
    await page.emulateMedia({ colorScheme: 'light' });
    await page.waitForFunction(() => document.querySelector('.kinso-sharks')?.dataset.palette === 'light');
    assert.equal(await sea.evaluate(n => n === document.querySelector('.kinso-sharks')), true);
    const before = await page.locator('#entry-input-zone').boundingBox();
    assert.equal(await page.locator('.fresh-question, #entry-terminal.fresh, #entry-terminal.fresh-move').count(), 0);
    assert.equal(await page.locator('#entry-input').getAttribute('placeholder'), 'what do you want?');
    await page.waitForFunction(() => document.querySelector('.kinso-sharks')?.width > 0);
    await page.locator('#entry-input').fill('first words');
    await page.keyboard.press('Enter');
    await page.locator('#entry-output .gui-typing').waitFor();
    assert.deepEqual(await page.locator('#entry-input-zone').boundingBox(), before);
    assert.equal(await page.locator('.kinso-sharks').evaluate(n => getComputedStyle(n).opacity), '1');
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

for (const layout of ['focus', 'scrolling', 'dwindle']) for (const width of [1920, 390]) {
  test(`Kinso's bar stays at the foot through the first send (${layout}, ${width})`, async () => {
    const f = await freshFixture({ layout, viewport: { width, height: 900 }, productOrigin: 'https://computer.kinso.computer' });
    const { page } = f;
    try {
      await page.addStyleTag({ content: 'html body #entry-terminal { height: 100vh !important; }' });
      // The fine-pointer narrow window opens with its sidebar over the bar.
      // Fold it as a person would before checking conversation hit targets.
      if (layout === 'focus' && width === 390) await page.locator('.session-rail-fold').click();
      await page.evaluate(() => { for (const a of document.getAnimations()) if (Number.isFinite(a.effect?.getComputedTiming().endTime)) a.finish(); });
      await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
      const rect = () => { const r = document.querySelector('#entry-input-zone').getBoundingClientRect(); return [r.x, r.y, r.width, r.height]; };
      const before = await page.evaluate(rect);
      await page.evaluate(() => {
        window.barFrames = []; window.barMoving = false; window.sampleBar = true;
        window.originalSea = document.querySelector('.kinso-sharks');
        const sample = () => {
          const r = document.querySelector('#entry-input-zone').getBoundingClientRect();
          barFrames.push([r.x, r.y, r.width, r.height]);
          barMoving ||= document.querySelector('#entry-terminal').classList.contains('fresh-move');
          if (sampleBar) requestAnimationFrame(sample);
        };
        requestAnimationFrame(sample);
      });
      await page.evaluate(() => harness.newTab());
      await page.waitForSelector('#entry-terminal.choosing');
      assert.deepEqual(await page.evaluate(rect), before, 'fresh starts at the conversation position');
      assert.equal(await page.locator('.fresh-question').count(), 0);
      assert.equal(await page.locator('#entry-input').getAttribute('placeholder'), 'what do you want?');
      assert.equal(await page.evaluate(() => document.activeElement.id), 'entry-input');
      await page.locator('#entry-input').fill('hello');
      await page.keyboard.press('Enter');
      await page.waitForSelector('#entry-output .gui-typing');
      await page.waitForTimeout(650);
      const frames = await page.evaluate(() => { sampleBar = false; return barFrames; });
      for (const frame of frames) assert.deepEqual(frame, before, 'no intermediate frame moves or resizes the bar');
      assert.equal(await page.evaluate(() => barMoving), false);
      const layers = await page.evaluate(() => {
        const canvas = document.querySelector('.kinso-sharks'), output = document.querySelector('#entry-output');
        const input = document.querySelector('#entry-input'); const r = input.getBoundingClientRect();
        return { same: canvas === originalSea, opacity: getComputedStyle(canvas).opacity,
          z: Number(getComputedStyle(canvas).zIndex), outputZ: Number(getComputedStyle(output).zIndex),
          events: getComputedStyle(canvas).pointerEvents, inputHit: document.elementFromPoint((Math.max(0, r.x) + Math.min(r.right, innerWidth)) / 2, r.y + r.height / 2)?.id,
          lift: document.querySelector('#entry-terminal').style.getPropertyValue('--fresh-lift') };
      });
      assert.equal(layers.same, true); assert.equal(layers.opacity, '1'); assert.equal(layers.events, 'none');
      assert.ok(layers.z < layers.outputZ, 'sea is below the messages');
      assert.equal(layers.inputHit, 'entry-input', 'sea never takes input clicks');
      assert.equal(layers.lift, '', 'Kinso never measures the old question or bar lift');
      assert.deepEqual(f.errors, []);
    } finally { await f.close(); }
  });
}

test('the send button makes one local session and sends once, even if pressed again while creation waits', async () => {
  const f = await freshFixture(); const { page } = f;
  try {
    let release;
    const answer = f.answer;
    f.answer = (command, owner) => command.type === 'tab-new' ? new Promise(resolve => { release = () => resolve(answer(command, owner)); }) : answer(command, owner);
    await page.evaluate(() => harness.newTab());
    await page.locator('#entry-input').fill('button prompt');
    await page.locator('#entry-send').click();
    await page.waitForFunction(() => document.querySelector('.gui-typing'));
    await page.locator('#entry-send').click();
    await page.locator('.session-rail-item[data-owner="vm"][data-tab-id="tab-a"] .session-rail-open').click();
    assert.equal(typeof release, 'function');
    assert.equal(f.commands.filter(c => c.type === 'tab-new').length, 1);
    release();
    await page.waitForFunction(() => document.querySelector('#entry-input').value === '');
    for (let n = 0; n < 30 && !f.prompts.length; n++) await page.waitForTimeout(20);
    assert.equal(f.prompts.length, 1);
    assert.equal(f.prompts[0].text, 'button prompt');
    assert.equal(f.prompts[0].expectedSessionId, 'thread-new', 'navigation cannot retarget a first prompt in flight');
    assert.equal(f.made[0].owner, '', 'the serving computer, not a cloud/local choice');
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('a failed new session restores its words and says why without sending them elsewhere', async () => {
  const f = await freshFixture(); const { page } = f;
  try {
    const answer = f.answer;
    f.answer = (command, owner) => command.type === 'tab-new' ? Promise.reject(new Error('Fixture cannot start')) : answer(command, owner);
    await page.evaluate(() => harness.newTab());
    await page.locator('#entry-input').fill('keep this question');
    await page.locator('#entry-send').click();
    await page.waitForFunction(() => document.querySelector('#entry-terminal.fresh') && document.querySelector('#entry-input').value === 'keep this question');
    assert.match(await page.locator('#entry-model-status').textContent(), /Fixture cannot start/);
    assert.equal(f.prompts.length, 0);
    assert.equal(f.made.length, 0);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('a failed first prompt returns only to its original draft after navigation', async () => {
  const f = await freshFixture(); const { page } = f;
  try {
    const answer = f.answer; let rejectPrompt;
    f.answer = (command, owner) => {
      if (command.type === 'prompt') return new Promise((resolve, reject) => { rejectPrompt = reject; });
      if (command.type === 'tab-focus') {
        const tab = f.tab.tabs.find(row => row.id === command.tabId);
        f.tab = { ...f.tab, tabId: tab.id, sessionId: tab.sessionId, messages: tab.id === 'tab-a' ? MESSAGES : [],
          tabs: f.tab.tabs.map(row => ({ ...row, focused: row.id === tab.id })) };
        return { snapshot: f.tab };
      }
      return answer(command, owner);
    };
    await page.evaluate(() => harness.newTab());
    await page.locator('#entry-input').fill('original first prompt');
    await page.locator('#entry-send').click();
    await page.waitForFunction(() => document.querySelector('#entry-terminal:not(.choosing)'));
    for (let n = 0; n < 30 && !rejectPrompt; n++) await page.waitForTimeout(20);
    assert.equal(typeof rejectPrompt, 'function');
    // Await the actual selection acknowledgement, not its instant cached preview.
    await page.evaluate(() => harness.showSession('thread-a'));
    assert.equal(await page.evaluate(() => harness.guiSnapshot().sessionId), 'thread-a');
    await page.locator('#entry-input').fill('another session draft');
    rejectPrompt(new Error('fixture refused the first prompt'));
    await page.waitForTimeout(100);
    assert.equal(await page.locator('#entry-input').inputValue(), 'another session draft');
    await page.evaluate(() => harness.showSession('thread-new'));
    assert.equal(await page.evaluate(() => harness.guiSnapshot().sessionId), 'thread-new');
    assert.equal(await page.locator('#entry-input').inputValue(), 'original first prompt');
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});
