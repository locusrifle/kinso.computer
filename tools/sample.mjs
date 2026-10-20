// Ask the website's own sampler for a word's art, from the command line.
//
// The sampler measures a font with a canvas, so it needs a browser to run in.
// Rather than keep a second implementation for the terminal, this serves the
// real thing to a headless Chromium and reads the answer back: the sampler
// the store's wordmarks are drawn with.

import { launchChromium } from './test-browser.mjs';
import { rm, writeFile } from 'node:fs/promises';
import { serveDirectory } from './serve.mjs';

const WEBSITE = new URL('../website/', import.meta.url);
const PAGE_NAME = '.sample.html';

const PAGE_HTML = `<!doctype html>
<html><head><meta charset="utf-8"></head><body><pre id="out">pending</pre>
<script type="module">
import { loadFont, wordmarkArt } from '/assets/js/wordmark.js';
const word = new URL(location.href).searchParams.get('word') ?? 'imperfect';
await loadFont();
document.getElementById('out').textContent = wordmarkArt(word);
</script></body></html>
`;

async function dumpDom(url) {
  const browser = await launchChromium({ headless: true, args: ['--disable-gpu', '--no-sandbox', '--hide-scrollbars'] });
  try {
    const page = await browser.newPage();
    await page.goto(url);
    await page.waitForFunction(() => {
      const output = document.querySelector('#out');
      return output && output.textContent !== 'pending';
    });
    return await page.content();
  } finally {
    await browser.close();
  }
}

function unescapeHtml(text) {
  return text
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replaceAll('&amp;', '&');
}

// Give `fn` a sample(word) and clean up the server and the page afterwards.
export async function withSampler(fn) {
  const page = new URL(PAGE_NAME, WEBSITE);
  await writeFile(page, PAGE_HTML);
  const { server, origin } = await serveDirectory(WEBSITE.pathname, { port: 0 });

  const sample = async (word) => {
    const dom = await dumpDom(`${origin}/${PAGE_NAME}?word=${encodeURIComponent(word)}`);
    const match = /<pre id="out">([\s\S]*?)<\/pre>/.exec(dom);
    if (match === null) throw new Error('the sampler page did not render');
    return unescapeHtml(match[1]);
  };

  try {
    return await fn(sample);
  } finally {
    server.close();
    await rm(page, { force: true });
  }
}

export function sampleWord(word) {
  return withSampler((sample) => sample(word));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const word = process.argv[2] ?? 'imperfect';
  const art = await withSampler((sample) => sample(word, process.argv[3] ?? 'omarchy'));
  if (art.trim() === '') {
    process.stderr.write(`${word} sampled empty\n`);
    process.exit(1);
  }
  process.stdout.write(`${art}\n`);
}
