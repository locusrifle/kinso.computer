import { test } from 'node:test';
import assert from 'node:assert/strict';
import { launchChromium } from '../../../../tools/test-browser.mjs';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';

// A code block an agent writes stays inside the window on a phone (its long
// lines wrap, nothing is cut off) and its copy button puts the whole block,
// exactly as written, on the clipboard in one tap.
test('a code block wraps inside the window and copies whole in one tap', async () => {
  const server = createServer(async (req, res) => {
    try {
      const path = req.url.split('?')[0];
      if (path === '/') {
        res.setHeader('Content-Type', 'text/html');
        res.end('<!doctype html><meta name="viewport" content="width=device-width"><link rel="stylesheet" href="/css/gui-transcript.css"><main id="root"></main>');
        return;
      }
      const text = await readFile(new URL(`../public${path}`, import.meta.url));
      res.setHeader('Content-Type', path.endsWith('.js') ? 'text/javascript' : 'text/css');
      res.end(text);
    } catch { res.writeHead(404).end(); }
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const browser = await launchChromium({ headless: true, args: ['--no-sandbox'] }).catch(error => { server.close(); throw error; });
  const block = "I'm Noah's CTO (Opus 5.5). Thanks!\n\nNoah is building imperfect: a NixOS-based OS whose whole desktop is a web page served by the machine itself, a line far wider than any phone.\n    indented, and an unbroken https://example.org/" + 'x'.repeat(200);
  try {
    for (const width of [1280, 390]) {
      const page = await browser.newPage({ viewport: { width, height: 820 } });
      await page.goto(`http://127.0.0.1:${server.address().port}`);
      const result = await page.evaluate(async block => {
        const copied = [];
        Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async text => { copied.push(text); } } });
        const { renderGuiTranscript } = await import('/js/gui-transcript.js');
        const transcript = document.createElement('div');
        transcript.className = 'gui-transcript';
        document.querySelector('#root').append(transcript);
        renderGuiTranscript(transcript, { messages: [{ role: 'user', content: 'make it shorter' }, { role: 'assistant', content: [{ type: 'text', text: 'Here:\n\n```\n' + block + '\n```\n\nDone.' }] }] });
        const box = transcript.querySelector('.gui-code');
        const pre = box.querySelector('pre');
        const button = box.querySelector('button.gui-copy');
        const boxRect = box.getBoundingClientRect();
        const buttonRect = button.getBoundingClientRect();
        const before = button.textContent;
        button.click();
        await new Promise(r => setTimeout(r, 50));
        return {
          code: pre.querySelector('code').textContent,
          inside: boxRect.left >= 0 && boxRect.right <= innerWidth,
          noSideways: pre.scrollWidth <= pre.clientWidth + 1 && document.documentElement.scrollWidth <= innerWidth,
          buttonInBox: buttonRect.left >= boxRect.left && buttonRect.right <= boxRect.right && buttonRect.top >= boxRect.top,
          tappable: buttonRect.height >= 28,
          before,
          after: button.textContent,
          copied,
        };
      }, block);
      assert.equal(result.code, block, `${width}px: the block shows exactly what was written`);
      assert.equal(result.inside, true, `${width}px: the block stays inside the window`);
      assert.equal(result.noSideways, true, `${width}px: long lines wrap; nothing scrolls sideways or is cut off`);
      assert.equal(result.buttonInBox, true, `${width}px: the copy button sits inside the block`);
      assert.equal(result.tappable, true, `${width}px: the copy button is big enough to tap`);
      assert.equal(result.before, 'copy');
      assert.deepEqual(result.copied, [block], `${width}px: one tap copies the whole block, exactly`);
      assert.equal(result.after, 'copied');
      await page.close();
    }
  } finally {
    await browser.close();
    await new Promise(r => server.close(r));
  }
});
