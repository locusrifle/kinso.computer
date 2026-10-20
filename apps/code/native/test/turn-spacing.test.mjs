import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { launchChromium } from '../../../../tools/test-browser.mjs';
import { themeCss } from '../../../../system/theme.mjs';
import { testTheme } from './fixtures/theme.mjs';

// Real renderer and the app's own stylesheets, in its order, on its body:
// catches competing image/paragraph margins. Turns are apart by the same
// space, with no rule between them (the conversation's look, focus.css).
// No running agent, external pages or service.
const STYLES = ['look', 'guey', 'entry-terminal', 'imperfect', 'focus', 'phone'];
test('all visible turns share the same spacing, without a rule, on Black/Chalk, desktop/phone', async () => {
 const themes = Object.fromEntries(await Promise.all(['black', 'light-chalk'].map(async id => [id, themeCss(await testTheme(id))])));
 const server = createServer(async (req, res) => {
  try {
   const path = req.url.split('?')[0];
   if (path === '/') {
    res.setHeader('Content-Type', 'text/html');
    res.end(`<!doctype html><meta name="viewport" content="width=device-width">${STYLES.map(name => `<link rel="stylesheet" href="/css/${name}.css">`).join('')}<body class="imperfect"><main class="gui-transcript" id="root"></main>`);
   } else {
    res.setHeader('Content-Type', path.endsWith('.js') ? 'text/javascript' : 'text/css');
    res.end(await readFile(new URL(`../public${path}`, import.meta.url)));
   }
  } catch { res.writeHead(404).end(); }
 });
 await new Promise(r => server.listen(0, '127.0.0.1', r));
 let browser;
 try {
  browser = await launchChromium({ headless: true, args: ['--no-sandbox'] });
  for (const theme of ['black', 'light-chalk']) for (const width of [1280, 390, 320]) {
   const page = await browser.newPage({ viewport: { width, height: 900 } });
   const errors = []; page.on('pageerror', error => errors.push(error.message));
   await page.goto(`http://127.0.0.1:${server.address().port}`);
   await page.addStyleTag({ content: themes[theme] + '\nbody {margin:0} #root {height:800px;overflow-y:auto;overflow-anchor:none}' });
   const result = await page.evaluate(async () => {
    const { renderGuiTranscript } = await import('/js/gui-transcript.js');
    const { windowNode } = await import('/js/pages.js');
    const { liveMessage } = await import('/js/live-message.js');
    const { transcriptScroll } = await import('/js/transcript-scroll.js');
    const root = document.querySelector('#root');
    const imageNode = () => { const img = document.createElement('img'); img.className = 'entry-image'; img.width = 80; img.height = 40; img.src = 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="80" height="40"/>'; return img; };
    const messages = [
     { role:'user', content:'First prompt\nSecond line' },
     { role:'assistant', content:'# Heading\n\nParagraph one\n\nParagraph two' },
     { role:'assistant', content:'```js\nconst answer = 42;\n```' },
     { role:'assistant', content:'- One\n- Two' },
     { role:'assistant', content:'| A | B |\n| --- | --- |\n| C | D |' },
     { role:'toolResult', content:'Hidden tool output' },
     { role:'toolResult', content:[{type:'image'}] },
     { role:'toolResult', content:[{type:'image'}] },
     { role:'user', content:[{type:'image'}] },
     { role:'user', content:'' },
     { role:'custom', customType:'question', content:'Which option?\n\nOption one\nOption two' },
     { role:'assistant', content:[], errorMessage:'A readable error\nwith another line' },
     { role:'toolResult', content:'Shown in the conversation, in a square window: http://127.0.0.1/fixture.wav' },
     { role:'assistant', content:'Final paragraph' },
    ];
    // Use the real media window DOM, but stub media resolution locally.
    const originalFetch = window.fetch;
    window.fetch = async () => ({ok:true,json:async()=>({url:'data:audio/wav;base64,'})});
    renderGuiTranscript(root, { messages }, { imageNode, windowNode });
    window.fetch = originalFetch;
    const tick = () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    await tick();
    const gaps = [];
    // Scroll each turn into view before measuring, preserving auto containment.
    for (let i = 1; i < root.children.length; i++) {
     const current = root.children[i], previous = root.children[i-1];
     current.scrollIntoView({block:'center'}); await tick();
     const rect = current.getBoundingClientRect(), prior = previous.getBoundingClientRect();
     const style = getComputedStyle(current);
     const content = current.classList.contains('gui-window') ? current.querySelector('.gui-window-body') : current.firstElementChild;
     gaps.push({ above:rect.top-prior.bottom, below:content.getBoundingClientRect().top-rect.top-parseFloat(style.borderTopWidth), border:style.borderTopWidth, left:rect.left });
    }
    const edgeMargins = [...root.querySelectorAll('.gui-message')].map(n => [getComputedStyle(n.firstElementChild).marginTop,getComputedStyle(n.lastElementChild).marginBottom]);
    const paragraphs = root.children[1].querySelectorAll('p');
    const paragraphSpacing = parseFloat(getComputedStyle(paragraphs[0]).marginBottom);
    const mediaWindow = root.querySelector('.gui-window');
    mediaWindow.classList.add('full');
    const fullStyle = getComputedStyle(mediaWindow);
    const fullSpacing = [fullStyle.paddingTop, fullStyle.borderTopWidth, fullStyle.marginBottom];
    mediaWindow.classList.remove('full');
    const prompt = root.querySelector('.gui-prompt'), promptStyle = getComputedStyle(prompt);
    const beforeCount = root.children.length;
    const scroller = transcriptScroll(root);
    const live = liveMessage(() => scroller.pin());
    // Preserve a completed prefix while text grows, and keep latest at bottom.
    const start = 'Stable paragraph\n\nGrowing';
    root.append(...live.draw({role:'assistant',content:[{type:'text',text:start}]}));
    const article = root.lastElementChild, prefix = article.firstElementChild;
    scroller.latest(); await tick();
    live.draw({role:'assistant',content:[{type:'text',text:start+' answer. '.repeat(60)}]});
    await new Promise(r => setTimeout(r, 1200)); await tick();
    const follows = root.scrollHeight-root.clientHeight-root.scrollTop < 2;
    const prefixKept = prefix === article.firstElementChild;
    const containment = getComputedStyle(root.children[3]).contentVisibility;
    // Paging smoke uses already measured/kept turns (the harness keeps these
    // gui-live too). Off-screen intrinsic estimates are not actual geometry.
    root.querySelectorAll('.gui-message').forEach(n => n.classList.add('gui-live'));
    await tick();
    root.dispatchEvent(new WheelEvent('wheel', {deltaY:-100})); root.scrollTop = 180; await tick();
    const anchored = root.children[3], oldY = anchored.getBoundingClientRect().top;
    const fromBottom = root.scrollHeight-root.scrollTop;
    const older = document.createDocumentFragment();
    renderGuiTranscript(older, {messages:[{role:'user',content:'An older prompt'},{role:'assistant',content:'An older answer'}]});
    older.querySelectorAll('.gui-message').forEach(n => n.classList.add('gui-live'));
    root.prepend(older);
    root.scrollTop = root.scrollHeight-fromBottom; await tick();
    const pagingDrift = Math.abs(anchored.getBoundingClientRect().top-oldY);
    return {gaps,edgeMargins,paragraphSpacing,fullSpacing,promptPadding:[promptStyle.paddingTop,promptStyle.paddingBottom],beforeCount,hidden:root.textContent.includes('Hidden tool output'),firstBorder:getComputedStyle(root.firstElementChild).borderTopWidth,lastMargin:getComputedStyle(root.lastElementChild).marginBottom,follows,prefixKept,pagingDrift,overflow:root.scrollWidth>root.clientWidth,containment};
   });
   const label = `${theme}/${width}`;
   assert.equal(result.beforeCount, 13, label);
   for (const [i, gap] of result.gaps.entries()) {
    assert.ok(Math.abs(gap.above-14)<0.1, `${label} turn ${i+1} above: ${gap.above}`);
    assert.ok(Math.abs(gap.below)<0.1, `${label} turn ${i+1} below: ${gap.below}`);
    assert.equal(gap.border,'0px',label);
   }
   assert.ok(result.gaps.every(g => g.left === result.gaps[0].left), `${label} turn insets`);
   assert.ok(result.edgeMargins.every(([top,bottom])=>top==='0px'&&bottom==='0px'), `${label} trims content edges`);
   assert.ok(result.paragraphSpacing>8, `${label} retains interior paragraph spacing`);
   assert.deepEqual(result.promptPadding,['10px','11px'],label);
   assert.deepEqual(result.fullSpacing,['0px','0px','0px'],`${label} fullscreen has no turn spacing`);
   assert.equal(result.firstBorder,'0px',label); assert.equal(result.lastMargin,'0px',label);
   assert.equal(result.hidden,false,label); assert.equal(result.overflow,false,label);
   assert.equal(result.follows,true,`${label} follows streaming`); assert.equal(result.prefixKept,true,label);
   assert.ok(result.pagingDrift<1,`${label} paging drift ${result.pagingDrift}`);
   assert.equal(result.containment,'auto',label); assert.deepEqual(errors,[],label);
   await page.close();
  }
 } finally { await browser?.close(); await new Promise(r => server.close(r)); }
});
