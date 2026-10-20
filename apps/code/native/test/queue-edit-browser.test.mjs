import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { launchChromium } from '../../../../tools/test-browser.mjs';
const read = name => readFileSync(new URL('../public/js/' + name, import.meta.url), 'utf8');
const source = read('harness.js');
const restore = source.slice(source.indexOf('export function restoreQueueItem'), source.indexOf('export function mountGueyPi')).replace('export ', '');
const queue = source.slice(source.indexOf('\tconst queueDrafts ='), source.indexOf('\tfunction applyQueue('));
// Each whole registerKeyBinding({ ... }) call for these keys, however many lines.
const calls = [];
for (let at = source.indexOf('registerKeyBinding('); at >= 0; at = source.indexOf('registerKeyBinding(', at + 1)) {
  let depth = 0, end = at + 'registerKeyBinding'.length;
  do { const c = source[end++]; if (c === '(') depth++; else if (c === ')') depth--; } while (depth > 0);
  calls.push(source.slice(at, end) + ';');
}
const bindings = [source.match(/\tconst sessionStep = .*\n/)[0], ...calls.filter(call => /edit latest queued prompt|previous session|next session/.test(call))].join('\n');

// Up in an empty input bar takes the latest steering back; MOD+Up and
// MOD+Down are the sessions. The modifier is Super in the desktop window
// (imperfectDesk), with Alt answering too off sway; Alt alone in a browser
// (pi-card.js).
for (const { name, desk, mod, label, alias, refused } of [
  { name: 'desktop window', desk: true, mod: 'Meta', label: 'Super', alias: 'Alt', refused: 'Meta+Alt' },
  { name: 'browser', desk: false, mod: 'Alt', label: 'Alt', alias: null, refused: 'Meta' },
]) test(`real mouse and Up in an empty input bar edit one item without switching sessions or consuming siblings; ${label}+Up and ${label}+Down are the sessions (${name})`, async () => {
  const browser = await launchChromium({ headless: true, args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage();
    await page.setContent('<textarea id=editor></textarea><div id=queue></div>');
    if (desk) await page.evaluate(() => { window.imperfectDesk = {}; });
    await page.addScriptTag({ content: read('pi-card.js').replaceAll('export ', '') });
    await page.addScriptTag({ content: `
      const input = document.querySelector('#editor'), queueBox = document.querySelector('#queue');
      const el = (tag, text, cls) => Object.assign(document.createElement(tag), {textContent: text, className: cls});
      const image = {type:'image',mimeType:'image/png',data:'aW1hZ2U='};
      let attachments = [], state = {sessionId:'session-a',queue:{items:[
        {id:'1',lane:'steering',text:'duplicate'},
        {id:'2',lane:'steering',text:'duplicate',images:[image]},
        {id:'3',lane:'steering',text:'newest'}
      ]}};
      window.calls = []; window.cycles = []; window.brought = 0;
      function cycleTab(step) { cycles.push(step); return true; }
      const wm = { bring() { brought++; } }, keysHeld = () => false, overlay = null;
      function focusedTabId() { return 'tab-a'; }
      function saveDraft() {} function paintPending() {} function paintCaret() {}
      const ownerSessionKey = (owner, session) => JSON.stringify([owner, session]);
      const selectedOwner = 'desktop', ownerKey = value => value;
      const hooks = {}; function fail(e) { throw e; }
      async function command(type, fields) {
        calls.push({type,...fields});
        const index = fields.latest ? state.queue.items.length-1 : state.queue.items.findIndex(i=>i.id===fields.queueId);
        return {item:index<0?null:state.queue.items.splice(index,1)[0]};
      }
      ${restore}
      ${queue}
      ${bindings}
      window.images = () => attachments.map(a=>a.image);
      paintQueue();
    ` });
    assert.equal(await page.locator('.entry-queue-hint').textContent(), '↳ click a line, or ↑ in an empty input bar, to edit latest');
    const value = () => page.locator('#editor').inputValue();
    const rows = () => page.locator('.entry-queue-line').evaluateAll(rows => rows.map(r => r.dataset.queueId));
    await page.locator('#editor').focus();
    await page.keyboard.press(`${refused}+ArrowUp`);
    await page.keyboard.press('Shift+ArrowUp');
    assert.equal(await value(), '', 'only Up itself');
    await page.keyboard.press('ArrowUp');
    assert.equal(await value(), 'newest');
    assert.deepEqual(await rows(), ['1', '2']);
    await page.keyboard.press('ArrowUp');
    assert.equal(await value(), 'newest', 'with text in the input bar Up is the caret\'s');
    await page.locator('[data-queue-id="2"]').click();
    assert.equal(await value(), 'duplicate\n\nnewest');
    assert.deepEqual(await rows(), ['1']);
    assert.equal(await page.evaluate(() => document.activeElement.id), 'editor');
    assert.deepEqual(await page.evaluate(() => images()), [{type:'image',mimeType:'image/png',data:'aW1hZ2U='}]);
    assert.deepEqual(await page.evaluate(() => calls), [
      {type:'queue-take',latest:true,expectedSessionId:'session-a',expectedTabId:'tab-a'},
      {type:'queue-take',queueId:'2',expectedSessionId:'session-a',expectedTabId:'tab-a'},
    ]);
    assert.deepEqual(await page.evaluate(() => cycles), []);
    // The modifier's Up and Down: the session before and after, the view following.
    await page.keyboard.press(`${mod}+ArrowUp`);
    await page.keyboard.press(`${mod}+ArrowDown`);
    await page.keyboard.press(`${mod}+Shift+ArrowUp`);
    await page.keyboard.press(`${refused}+ArrowDown`);
    assert.deepEqual(await page.evaluate(() => cycles), [-1, 1]);
    assert.equal(await page.evaluate(() => brought), 2);
    assert.equal(await value(), 'duplicate\n\nnewest', 'the draft as it was');
    if (alias) {
      await page.keyboard.press(`${alias}+ArrowDown`);
      assert.deepEqual(await page.evaluate(() => cycles), [-1, 1, 1], 'Alt answers too');
    }
  } finally { await browser.close(); }
});
