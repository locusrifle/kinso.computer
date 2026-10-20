import { test } from 'node:test';
import assert from 'node:assert/strict';
import { launchChromium } from '../../../../tools/test-browser.mjs';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

const markdown = `| Job | Worker | Status |
|---|---|---|
| **Cloud machine** (noah.imperfect.computer) | Claude, started before the switch | The front door and the machine's config are written and build. It's now rehearsing the whole install on a local copy of the OVH machine before touching the real one. |
| **Kept sky review** | GPT-6.1 Sol | Re-checking the lock's security, re-running the tests, and looking at the battery cost. |`;

for (const width of [390, 1280]) {
  test(`${width}px: table words stay whole and only the table scrolls sideways`, async () => {
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
    try {
      const page = await browser.newPage({ viewport: { width, height: 844 } });
      await page.goto(`http://127.0.0.1:${server.address().port}`);
      await page.evaluate(async markdown => {
        const { renderGuiTranscript } = await import('/js/gui-transcript.js');
        const transcript = document.createElement('div');
        transcript.className = 'gui-transcript';
        document.querySelector('#root').append(transcript);
        renderGuiTranscript(transcript, { messages: [{ role: 'assistant', content: [{ type: 'text', text: markdown }] }] });
      }, markdown);
      if (process.env.TABLE_WRAP_SHOTS) {
        await mkdir(process.env.TABLE_WRAP_SHOTS, { recursive: true });
        await page.screenshot({ path: join(process.env.TABLE_WRAP_SHOTS, `${process.env.TABLE_WRAP_STAGE || 'table'}-${width}.png`), fullPage: true });
      }
      const result = await page.evaluate(async () => {
        const transcript = document.querySelector('.gui-transcript');
        const box = transcript.querySelector('.gui-table');
        const splitWords = [];
        // Test every character, not cell width: a wide cell can still break
        // words when its min-content width was reduced by anywhere wrapping.
        for (const cell of box.querySelectorAll('th, td')) {
          const walker = document.createTreeWalker(cell, NodeFilter.SHOW_TEXT);
          while (walker.nextNode()) {
            const node = walker.currentNode;
            for (const match of node.textContent.matchAll(/[A-Za-z]+(?:'[A-Za-z]+)*/g)) {
              const tops = new Set();
              for (let i = match.index; i < match.index + match[0].length; i++) {
                const range = document.createRange();
                range.setStart(node, i);
                range.setEnd(node, i + 1);
                tops.add(Math.round(range.getBoundingClientRect().top));
              }
              if (tops.size > 1) splitWords.push(match[0]);
            }
          }
        }
        const checkScroll = box => {
          const overflowing = box.scrollWidth > box.clientWidth + 1;
          box.scrollLeft = 100;
          const moved = box.scrollLeft > 0;
          box.scrollLeft = 0;
          return { overflowing, moved, overflowX: getComputedStyle(box).overflowX };
        };
        const typical = checkScroll(box);
        const statusShare = box.querySelector('td:last-child').getBoundingClientRect().width / box.querySelector('table').getBoundingClientRect().width;
        const selected = cell => {
          const range = document.createRange(); range.selectNodeContents(cell);
          const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
          const text = selection.toString(); selection.removeAllRanges(); return text;
        };
        const cellTexts = [...box.querySelectorAll('td')].map(cell => ({ text: cell.textContent, selected: selected(cell) }));
        // Measure the domain across its newly separated text nodes, so a bad
        // break cannot hide at a node boundary.
        const job = box.querySelector('td');
        const chars = []; const jobWalker = document.createTreeWalker(job, NodeFilter.SHOW_TEXT);
        while (jobWalker.nextNode()) {
          const text = jobWalker.currentNode;
          for (let i = 0; i < text.length; i++) {
            const range = document.createRange(); range.setStart(text, i); range.setEnd(text, i + 1);
            chars.push({ char: text.data[i], top: Math.round(range.getBoundingClientRect().top) });
          }
        }
        const domainStart = job.textContent.indexOf('(noah.');
        const domain = chars.slice(domainStart);
        const domainBreaks = domain.flatMap((char, i) => i && char.top !== domain[i - 1].top ? [domain[i - 1].char] : []);
        const breaks = [...job.querySelectorAll('wbr')].map(wbr => wbr.previousSibling.textContent.at(-1));
        const status = box.querySelector('tr td:last-child');
        const range = document.createRange();
        range.selectNodeContents(status);
        const statusLines = new Set([...range.getClientRects()].map(r => Math.round(r.top))).size;
        const { renderGuiTranscript } = await import('/js/gui-transcript.js');
        // Force overflow at both widths, so scroll containment is not vacuous.
        const columns = Array(12).fill('Extraordinary');
        const wide = document.createElement('div');
        wide.className = 'gui-transcript';
        document.querySelector('#root').append(wide);
        renderGuiTranscript(wide, { messages: [{ role: 'assistant', content: [{ type: 'text', text: `| ${columns.join(' | ')} |\n| ${columns.map(() => '---').join(' | ')} |\n| ${columns.join(' | ')} |\n\nhttps://example.org/${'x'.repeat(400)}` }] }] });
        const forced = checkScroll(wide.querySelector('.gui-table'));
        const tokens = document.createElement('div');
        const token = 'https://a.example/long-path_name@host:port?query=value&other=value';
        renderGuiTranscript(tokens, { messages: [{ role: 'assistant', content: `| Token |\n| --- |\n| **${token}** [${token}](https://example.org) \`${token}\` short-name extraordinary |` }] });
        transcript.append(tokens);
        const tokenCell = tokens.querySelector('td');
        const strong = tokenCell.querySelector('strong');
        const link = tokenCell.querySelector('a');
        const offsets = element => {
          let offset = 0; const points = [];
          for (const child of element.childNodes) {
            if (child.nodeName === 'WBR') points.push(offset);
            else offset += child.textContent.length;
          }
          return points;
        };
        const tokenResult = {
          token, text: tokenCell.textContent, selected: selected(tokenCell),
          strong: offsets(strong), link: offsets(link), href: link.getAttribute('href'),
          codeBreaks: tokenCell.querySelector('code').querySelectorAll('wbr').length,
          outsideBreaks: [...tokenCell.children].filter(n => n.nodeName === 'WBR').length,
        };
        // Exercise a full URL in a narrow text box and inspect actual lines.
        strong.style.cssText = 'display:block;width:100px';
        const urlChars = []; const urlWalker = document.createTreeWalker(strong, NodeFilter.SHOW_TEXT);
        while (urlWalker.nextNode()) {
          const text = urlWalker.currentNode;
          for (let i = 0; i < text.length; i++) {
            const range = document.createRange(); range.setStart(text, i); range.setEnd(text, i + 1);
            urlChars.push({ char: text.data[i], top: Math.round(range.getBoundingClientRect().top) });
          }
        }
        tokenResult.lineBreaks = urlChars.flatMap((char, i) => i && char.top !== urlChars[i - 1].top ? [urlChars[i - 1].char] : []);
        return {
          splitWords, typical, forced, statusLines, statusShare, cellTexts, domainBreaks, breaks, tokenResult,
          cellWrap: getComputedStyle(box.querySelector('td')).overflowWrap,
          paragraphWrap: getComputedStyle(wide.querySelector('p')).overflowWrap,
          noSideways: document.documentElement.scrollWidth <= innerWidth &&
            [transcript, wide].every(t => t.scrollWidth <= t.clientWidth + 1),
        };
      });
      console.log(`${width}px: ${JSON.stringify(result)}`);
      assert.deepEqual(result.splitWords, [], `${width}px: ordinary words in every column stay whole`);
      assert.ok(result.statusShare >= .45, 'Status receives at least 45% of table width');
      assert.equal(result.typical.overflowing, false, 'this table fits without sideways scrolling');
      assert.deepEqual(result.breaks, ['.', '.'], 'domain opportunities are only after dots');
      assert.ok(result.domainBreaks.every(char => /[./\-_@:?&=]/.test(char)), 'actual domain line breaks are natural');
      if (width === 390) assert.ok(result.domainBreaks.length > 0, 'phone domain actually wraps');
      const sourceCells = [
        'Cloud machine (noah.imperfect.computer)', 'Claude, started before the switch',
        "The front door and the machine's config are written and build. It's now rehearsing the whole install on a local copy of the OVH machine before touching the real one.",
        'Kept sky review', 'GPT-6.1 Sol',
        "Re-checking the lock's security, re-running the tests, and looking at the battery cost.",
      ];
      assert.deepEqual(result.cellTexts.map(c => c.text), sourceCells);
      assert.deepEqual(result.cellTexts.map(c => c.selected), sourceCells, 'selection adds no copy characters');
      const token = result.tokenResult;
      const points = [...token.token.matchAll(/[./\-_@:?&=]/g)].map(m => m.index + 1);
      assert.deepEqual(token.strong, points);
      assert.deepEqual(token.link, points, 'link labels gain the same safe opportunities');
      assert.equal(token.href, 'https://example.org', 'link destination is unchanged');
      assert.ok(token.lineBreaks.length > 0, 'full URL actually wraps');
      assert.ok(token.lineBreaks.every(char => /[./\-_@:?&=]/.test(char)), 'full URL breaks only at allowed punctuation');
      assert.equal(token.codeBreaks, 0, 'inline code remains literal');
      assert.equal(token.outsideBreaks, 0, 'short tokens and ordinary long words gain no breaks');
      assert.equal(token.text, `${token.token} ${token.token} ${token.token} short-name extraordinary`);
      assert.equal(token.selected, token.text);
      assert.equal(result.noSideways, true, `${width}px: page and transcripts have no sideways overflow`);
      assert.ok(result.statusLines > 1, `${width}px: long status wraps at spaces`);
      assert.equal(result.paragraphWrap, 'anywhere', 'paragraph URLs retain their wrapping');
      for (const scroll of [result.typical, result.forced]) {
        assert.equal(scroll.overflowX, 'auto');
        if (scroll.overflowing) assert.equal(scroll.moved, true, 'overflow scrolls inside the table box');
      }
      assert.equal(result.forced.overflowing, true, 'wide-table fixture exercises horizontal scrolling');
    } finally {
      await browser.close();
      await new Promise(r => server.close(r));
    }
  });
}
