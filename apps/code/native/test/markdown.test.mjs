import test from 'node:test';
import assert from 'node:assert/strict';
import { renderMarkdown } from '../public/js/markdown.js';

// A page in /home/me/notes, as the viewer sees it.
const ctx = {
  file: href => {
    const parts = '/home/me/notes'.split('/').filter(Boolean);
    for (const part of decodeURIComponent(href.split(/[?#]/)[0]).split('/')) {
      if (part === '..') parts.pop(); else if (part && part !== '.') parts.push(part);
    }
    return `/${parts.join('/')}`;
  },
  raw: path => `/files/raw?path=${encodeURIComponent(path)}`,
};
const md = text => renderMarkdown(text, ctx);

test('headings, paragraphs, emphasis, code and rules', () => {
  assert.equal(md('# Title\n\nSome *soft* and **strong** and `code` and ~~gone~~.'),
    '<h1 id="title">Title</h1><p>Some <em>soft</em> and <strong>strong</strong> and <code>code</code> and <del>gone</del>.</p>');
  assert.equal(md('Big\n===\n\nSmall\n---'), '<h1 id="big">Big</h1><h2 id="small">Small</h2>');
  assert.equal(md('### Three ###'), '<h3 id="three">Three</h3>');
  assert.equal(md('a\n\n---\n\nb'), '<p>a</p><hr><p>b</p>');
  assert.equal(md('snake_case_name stays'), '<p>snake_case_name stays</p>');
  assert.equal(md('```js\nconst a = 1 < 2;\n```'), '<pre><code class="language-js">const a = 1 &lt; 2;</code></pre>');
  assert.equal(md('    indented\n    code'), '<pre><code>indented\ncode</code></pre>');
  assert.equal(md('> quoted\n> more'), '<blockquote><p>quoted\nmore</p></blockquote>');
  assert.equal(md('line one  \nline two'), '<p>line one<br>line two</p>');
});

test('lists, nested, numbered and tasks', () => {
  assert.equal(md('- a\n- b\n  - b1\n  - b2\n- c'), '<ul><li>a</li><li>b<ul><li>b1</li><li>b2</li></ul></li><li>c</li></ul>');
  assert.equal(md('3. three\n4. four'), '<ol start="3"><li>three</li><li>four</li></ol>');
  assert.equal(md('- [ ] todo\n- [x] done'), '<ul><li class="task"><input type="checkbox" disabled> todo</li><li class="task"><input type="checkbox" disabled checked> done</li></ul>');
  assert.equal(md('- one\n\n- two'), '<ul><li><p>one</p></li><li><p>two</p></li></ul>', 'a loose list keeps its paragraphs');
  assert.equal(md('- item\ncarried on'), '<ul><li>item\ncarried on</li></ul>');
});

test('links: the web opens elsewhere, files beside it open in the viewer, nothing runs', () => {
  assert.equal(md('[site](https://example.com "Ex")'), '<p><a href="https://example.com" target="_blank" rel="noopener noreferrer" title="Ex">site</a></p>');
  assert.equal(md('[next](other.md)'), '<p><a href="#" data-path="/home/me/notes/other.md">next</a></p>');
  assert.equal(md('[up](../README.md#install)'), '<p><a href="#" data-path="/home/me/README.md">up</a></p>');
  assert.equal(md('[here](#Get-Started)'), '<p><a href="#Get-Started" data-anchor="get-started">here</a></p>');
  assert.equal(md('[bad](javascript:alert(1))'), '<p>bad</p>');
  assert.equal(md('[bad](JavaScript:alert)'), '<p>bad</p>');
  assert.equal(md('[wiki](https://w.org/Foo_(bar))'), '<p><a href="https://w.org/Foo_(bar)" target="_blank" rel="noopener noreferrer">wiki</a></p>');
  assert.equal(md('see https://example.com/a.'), '<p>see <a href="https://example.com/a" target="_blank" rel="noopener noreferrer">https://example.com/a</a>.</p>');
  assert.equal(md('<https://x.y>'), '<p><a href="https://x.y" target="_blank" rel="noopener noreferrer">https://x.y</a></p>');
});

test('images beside the page come through the file reader; others only from the web', () => {
  assert.equal(md('![a cat](pics/cat.png)'), '<p><img src="/files/raw?path=%2Fhome%2Fme%2Fnotes%2Fpics%2Fcat.png" alt="a cat" loading="lazy"></p>');
  assert.equal(md('![w](https://e.x/w.png)'), '<p><img src="https://e.x/w.png" alt="w" loading="lazy"></p>');
  assert.equal(md('![x](javascript:1)'), '<p>x</p>');
  assert.equal(md('![x](data:text/html,hi)'), '<p>x</p>');
});

test('HTML in the text is shown as written, never run', () => {
  assert.equal(md('<script>alert(1)</script>'), '<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>');
  assert.equal(md('[x](a.md" onclick="alert(1))'), '<p>[x](a.md&quot; onclick=&quot;alert(1))</p>');
  assert.equal(md('# <img src=x onerror=alert(1)>'), '<h1 id="">&lt;img src=x onerror=alert(1)&gt;</h1>');
  assert.equal(md('`<b>`'), '<p><code>&lt;b&gt;</code></p>');
});

test('tables', () => {
  assert.equal(md('| a | b |\n|:--|--:|\n| 1 | 2 |\n| 3 |'),
    '<table><thead><tr><th style="text-align:left">a</th><th style="text-align:right">b</th></tr></thead><tbody><tr><td style="text-align:left">1</td><td style="text-align:right">2</td></tr><tr><td style="text-align:left">3</td><td style="text-align:right"></td></tr></tbody></table>');
});
