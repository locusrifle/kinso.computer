import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { launchChromium } from '../../../../tools/test-browser.mjs';
const read = name => readFileSync(new URL('../public/js/' + name, import.meta.url), 'utf8');
const renderer = `
 const scroller = transcriptScroll(output);
 let renderedSessionId;
 function renderTranscript() {
   if (renderedSessionId !== state.sessionId) { renderedSessionId = state.sessionId; scroller.latest(); }
   const top = output.scrollTop;
   output.replaceChildren();
   state.messages.forEach(entry=>message(output,entry));
   output.append(queueBox);
   scroller.rendered(top);
 }`;
const helper = read('transcript-scroll.js').replace('export ', '');

for (const viewport of [{ width: 1200, height: 800 }, { width: 390, height: 844 }]) {
  test(`shared scroll helper reload and reader policy at ${viewport.width}px`, async () => {
    const browser = await launchChromium({ headless: true, ignoreDefaultArgs: ['--hide-scrollbars'], args: ['--no-sandbox'] });
    try {
      const page = await browser.newPage({ viewport });
      await page.addInitScript(() => { if (!localStorage.getItem('imperfect-view-mode')) localStorage.setItem('imperfect-view-mode', 'gui'); });
      const html = `<style>#output{height:300px;overflow:auto;overflow-anchor:none} #output::-webkit-scrollbar{width:16px} #output::-webkit-scrollbar-thumb{background:#888} .row{height:40px}</style><div id=canvas style="display:none"><div id=output tabindex=0></div></div><textarea id=input></textarea><script>
        ${helper}
        const output = document.querySelector('#output'), input = document.querySelector('#input');
        let restoredView = JSON.parse(sessionStorage.getItem('view') || 'null');
        let state = {sessionId:'selected',messages:Array.from({length:80},(_,i)=>i)};
        const choosing=false, overlay=false, usageOpen=false, hooks={}, personal=true, expandAll=false, queueBox=document.createElement('div');
        // Exercise the shared scroll helper; production native mounting is covered by harness-views-browser.
        const focusedTabId=()=>state.sessionId;
        const el=(tag,text,cls)=>{const n=document.createElement(tag);if(text!=null)n.textContent=text;if(cls)n.className=cls;return n;};
        function message(frame, entry) { const row=document.createElement('div'); row.className='row'; row.dataset.userIndex=String(entry); row.tabIndex=-1; row.textContent='output '+entry; frame.append(row); }
        ${renderer}
        window.incoming=()=>{state.messages.push(state.messages.length);renderTranscript();};
        window.switchSession=()=>{state.sessionId='other';renderTranscript();};
        renderTranscript();
        window.reveal=()=>{document.querySelector('#canvas').style.display='block';output.style.height='240px';queueBox.style.height='180px';};
        window.growImage=()=>{const img=new Image();queueBox.style.height='auto';queueBox.append(img);img.src='data:image/svg+xml,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="100" height="600"/>');};
      </script>`;
      await page.route('http://scroll.test/', route => route.fulfill({ contentType: 'text/html', body: html }));
      await page.goto('http://scroll.test/');
      await page.evaluate(() => sessionStorage.setItem('view', JSON.stringify({tabId:'selected',outputTop:0,followTranscript:false})));
      await page.reload();
      const bottom = () => page.waitForFunction(() => {const o=document.querySelector('#output');return o.clientHeight>0 && o.scrollHeight-o.clientHeight-o.scrollTop<2;});
      const settled = () => page.evaluate(() => new Promise(resolve => {
        const o=document.querySelector('#output');let last=o.scrollTop, stable=0;
        function check(){if(o.scrollTop===last)stable++;else stable=0;last=o.scrollTop;if(stable===5)resolve();else requestAnimationFrame(check);}requestAnimationFrame(check);
      }));
      await page.evaluate(() => reveal());
      await bottom();
      await page.evaluate(() => growImage());
      await page.waitForFunction(() => document.querySelector('img')?.naturalHeight === 600);
      await bottom();
      await page.setViewportSize({width:viewport.width,height:viewport.height-100});
      await bottom();
      assert.equal(await page.evaluate(() => state.sessionId), 'selected');
      // Clicking the latest output or wheeling down at the end is not scrolling up.
      await page.locator('#output').click({position:{x:40,y:40}});
      await page.evaluate(() => incoming());
      await bottom();
      await page.mouse.wheel(0,100);
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(()=>requestAnimationFrame(resolve))));
      await page.evaluate(() => incoming());
      await bottom();
      await page.locator('#output').hover();
      await page.mouse.wheel(0,-500);
      await page.waitForFunction(() => {const o=document.querySelector('#output');return o.scrollHeight-o.clientHeight-o.scrollTop>100;});
      // Wheel scrolling animates too: two frames can still be mid-gesture.
      await settled();
      const top = await page.locator('#output').evaluate(o=>o.scrollTop);
      await page.evaluate(() => incoming());
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(()=>requestAnimationFrame(resolve))));
      assert.equal(await page.locator('#output').evaluate(o=>o.scrollTop), top);
      await page.locator('#output').focus();
      await page.keyboard.press('Control+End');
      await bottom();
      // The final offset can precede the scroll event that resumes following.
      // Finish the native keyboard gesture before rebuilding the transcript.
      await settled();
      await page.evaluate(() => incoming());
      await bottom();
      await page.keyboard.press('PageUp');
      await page.waitForFunction(() => {const o=document.querySelector('#output');return o.scrollHeight-o.clientHeight-o.scrollTop>100;});
      // Native keyboard scrolling animates: observe its completion, not a timer.
      await settled();
      const keyboardTop = await page.locator('#output').evaluate(o=>o.scrollTop);
      await page.evaluate(() => incoming());
      assert.equal(await page.locator('#output').evaluate(o=>o.scrollTop), keyboardTop);
      await page.evaluate(() => switchSession());
      await bottom();
      // Drag the native scrollbar thumb upward (no wheel/touch shortcut).
      const box = await page.locator('#output').boundingBox();
      await page.mouse.move(box.x + box.width - 7, box.y + box.height - 5);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width - 7, box.y + 60, {steps:10});
      await page.mouse.up();
      await page.waitForFunction(() => {const o=document.querySelector('#output');return o.scrollHeight-o.clientHeight-o.scrollTop>100;});
      await settled();
      const pointerTop = await page.locator('#output').evaluate(o=>o.scrollTop);
      await page.evaluate(() => incoming());
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(()=>requestAnimationFrame(resolve))));
      assert.equal(await page.locator('#output').evaluate(o=>o.scrollTop), pointerTop);
      await page.locator('#input').fill('Unsent draft');
      assert.equal(await page.locator('#input').inputValue(),'Unsent draft');
    } finally { await browser.close(); }
  });
}
