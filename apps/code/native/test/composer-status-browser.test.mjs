import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { harnessFixture } from './fixtures/harness-page.mjs';
import { launchChromium } from '../../../../tools/test-browser.mjs';
import { themeCss } from '../../../../system/theme.mjs';
import { testTheme } from './fixtures/theme.mjs';

const index = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
const waiting = 'failed'; // the status line's text; a background task alone shows none
const draft = 'A draft stays readable while the background task finishes its work.';
const geometry = page => page.evaluate(() => {
  const rect = selector => {
    const r = document.querySelector(selector).getBoundingClientRect();
    return { x: r.x, y: r.y, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
  };
  const status = document.querySelector('#entry-model-status');
  return { input: rect('#entry-input'), status: rect('#entry-model-status'), header: rect('.entry-status'),
    stack: rect('.entry-input-stack'), mirrorInk: getComputedStyle(document.querySelector('.entry-caret-mirror')).color,
    statusInk: getComputedStyle(status).color, ellipsis: getComputedStyle(status).textOverflow,
    statusFits: status.scrollWidth <= status.clientWidth,
    selection: [document.querySelector('#entry-input').selectionStart, document.querySelector('#entry-input').selectionEnd] };
});

test('the status shares the typing line in theme ink; drafts, steering and controls keep their space; a background task shows nothing', { timeout: 150000 }, async () => {
  const browser = await launchChromium({ headless: true, args: ['--no-sandbox', '--disable-gpu'] });
  const preview = process.env.COMPOSER_STATUS_PREVIEW_DIR;
  if (preview) await mkdir(preview, { recursive: true });
  try {
    for (const theme of ['black', 'light-chalk', 'galaxy-plum-velvet']) {
      const f = await harnessFixture({ browser, site: true, hasTouch: true,
        themeCSS: themeCss(await testTheme(theme)), viewport: { width: 390, height: 844 },
        messages: [{ role: 'user', content: 'Keep working in the background.' },
          { role: 'assistant', content: 'I will report back when the background task finishes.' }],
        handleRequest: async (_req, res, path) => {
          if (path !== '/') return false;
          res.setHeader('Content-Type', 'text/html'); res.end(index); return true;
        } });
      const page = f.page;
      const input = page.locator('#entry-input'), status = page.locator('#entry-model-status');
      try {
        const state = { ...f.tab, agent: 'pi', level: 'high', failed: true,
          model: { provider: 'fixture', id: 'gpt-6.1-sol', name: 'GPT-6.1 Sol' },
          queue: { items: [{ id: 'steer-1', text: 'Keep this steering available.' }] } };
        for (const viewport of [{ width: 1200, height: 900 }, { width: 390, height: 844 },
          { width: 320, height: 844 }, { width: 390, height: 460 }]) {
          const key = `${theme}/${viewport.width}x${viewport.height}`;
          await page.setViewportSize(viewport);
          f.push({ ...state, failed: false, operation: 'background' });
          await page.waitForTimeout(80);
          assert.equal(await status.textContent(), '', `${key}: a background task working says nothing`);
          f.push(state);
          await page.waitForFunction(text => document.querySelector('#entry-model-status').textContent === text, waiting);
          // The production phone focus guard authorizes typing only after a tap.
          await input.tap({ position: { x: 5, y: 10 } });
          await input.fill('');
          await page.waitForTimeout(80);
          assert.equal(await input.inputValue(), '', `${key}: empty composer remains available`);
          const empty = await geometry(page);
          assert.ok(Math.abs(empty.input.y - empty.status.y) < 1, `${key}: status is on the actual prompt row`);
          assert.ok(empty.header.bottom <= empty.status.y, `${key}: not in the model/effort/dock row`);
          assert.ok(empty.input.right < empty.status.x && empty.status.right <= viewport.width - 13, `${key}: reserved inline space`);
          assert.ok(empty.input.width >= 85 && empty.status.width > 0, `${key}: input and status both visible`);
          assert.ok(empty.status.bottom <= viewport.height, `${key}: keyboard-sized viewport fits`);
          assert.equal(empty.statusInk, empty.mirrorInk, `${key}: same theme ink as visible input`);
          assert.equal(empty.ellipsis, 'ellipsis');
          if (viewport.width >= 390) assert.equal(empty.statusFits, true, `${key}: the complete waiting text fits`);
          assert.equal(await status.getAttribute('role'), 'status');
          assert.equal(await page.locator('.entry-queue-line').isVisible(), true, `${key}: steering remains available`);
          assert.equal(await page.locator('#entry-thinking').textContent(), '· high');
          assert.equal(await page.locator('#entry-plus').isVisible(), true);
          if (preview && theme !== 'light-chalk' && viewport.height > 460) {
            await page.screenshot({ path: `${preview}/${theme}-${viewport.width}-waiting.png` });
          }
          // Existing text must refit when the status arrives or leaves, even without a keystroke.
          f.push({ ...state, failed: false });
          await page.waitForFunction(() => !document.querySelector('#entry-model-status').textContent);
          await input.fill(draft);
          await page.waitForTimeout(80);
          const without = await geometry(page);
          await input.evaluate(n => n.setSelectionRange(2, 9));
          f.push(state);
          await page.waitForFunction(text => document.querySelector('#entry-model-status').textContent === text, waiting);
          await page.waitForTimeout(80);
          const withStatus = await geometry(page);
          assert.ok(withStatus.input.width < without.input.width, `${key}: status does not overlay draft`);
          assert.deepEqual(withStatus.selection, [2, 9], `${key}: selection preserved`);
          assert.equal(await input.inputValue(), draft);
          assert.ok(withStatus.input.height >= without.input.height, `${key}: a wrapped draft regrows, never clips`);
          assert.ok(await input.evaluate(n => n.scrollHeight <= n.clientHeight), `${key}: all draft lines fit`);
          if (preview && theme === 'black' && viewport.width === 390 && viewport.height === 844) {
            await page.screenshot({ path: `${preview}/black-390-draft.png` });
          }
          f.push({ ...state, failed: false });
          await page.waitForFunction(() => !document.querySelector('#entry-model-status').textContent);
          await page.waitForTimeout(80);
          assert.equal(await status.isVisible(), false, `${key}: idle status takes no space`);
          assert.ok(Math.abs((await geometry(page)).input.width - without.input.width) < 1, `${key}: full input width restored`);
          assert.equal(await input.inputValue(), draft);
        }
        assert.equal(f.commands.some(c => c.type === 'prompt' || c.type === 'queue-take'), false);
        assert.deepEqual(f.errors, []);
      } finally { await f.close(); }
    }
  } finally { await browser.close(); }
});
