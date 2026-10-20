import test from 'node:test';
import assert from 'node:assert/strict';
import { launchChromium } from '../../../../tools/test-browser.mjs';
import {fixture, serve, fixtureResponse} from '../../tools/gui-preview.mjs';
import { themeCss } from '../../../../system/theme.mjs';
import { testTheme } from './fixtures/theme.mjs';

for(const theme of ['black','light-chalk']) test(`${theme}: native bridge key turns only the session panel, in the theme's diagonal`, async()=>{
 const {server,sockets,port}=await serve(themeCss(await testTheme(theme,`/tmp/native-origin-no-personal-${process.pid}`)));
 const whole=id=>{const d=fixture();d.sessionId=id;d.tabs=d.tabs.map(t=>({...t,focused:t.id===id}));d.messages=[{role:'assistant',content:`${id} only`}];return d;};
 sockets.removeAllListeners('connection');
 sockets.on('connection',ws=>{ws.send(JSON.stringify({type:'snapshot',data:whole('mirror')}));ws.on('message',raw=>{const c=JSON.parse(raw);ws.send(JSON.stringify({type:'response',id:c.id,success:true,data:c.type==='tab-focus'?{snapshot:whole(c.tabId)}:fixtureResponse(c)}));});});
 const browser=await launchChromium({headless:true,args:['--no-sandbox']});
 try{
  const page=await browser.newPage({viewport:{width:1536,height:900}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.addInitScript(()=>{globalThis.imperfectDesk={onKey:fn=>{globalThis.deskKey=fn;},onBrowse(){},onTab(){},front(){},onOpen(){}};});
  await page.goto(`http://127.0.0.1:${port}/?face=code`);await page.locator('.wm-files').waitFor();await page.locator('[data-tab-id="other"]').waitFor();
  await page.evaluate(()=>{
   window.reveal=null;const animate=Element.prototype.animate;
   Element.prototype.animate=function(frames,options){const a=animate.call(this,frames,options);if(options?.pseudoElement){a.pause();window.reveal=a;}return a;};
  });
  await page.evaluate(()=>deskKey('session2'));
  await page.waitForFunction(()=>window.reveal);
  const g=await page.evaluate(()=>{
   const panel=document.querySelector('.entry-screen').getBoundingClientRect();
   return {clip:window.reveal.effect.getKeyframes()[0].clipPath,pseudo:window.reveal.effect.pseudoElement,width:panel.width,text:document.querySelector('#entry-output').textContent,named:getComputedStyle(document.querySelector('.entry-screen')).viewTransitionName,animated:document.getAnimations().filter(a=>a.effect?.pseudoElement).length,background:getComputedStyle(document.documentElement,'::view-transition-new(session-panel)').backgroundColor};
  });
  assert.match(g.clip,/^polygon\(calc\(50% \+ 9vh\)/,JSON.stringify(g));assert.equal(g.pseudo,'::view-transition-new(session-panel)');assert.ok(g.width<1000,'Files keeps its own column');assert.equal(g.named,'session-panel');assert.equal(g.animated,1);assert.notEqual(g.background,'rgba(0, 0, 0, 0)','new themed panel occludes the previous text');assert.ok(g.text.includes('other only'));
  await page.evaluate(()=>window.reveal.finish());await page.waitForTimeout(100);await page.emulateMedia({reducedMotion:'reduce'});await page.evaluate(()=>{window.reveal=null;deskKey('session1');});await page.waitForFunction(()=>document.querySelector('#entry-output').textContent.includes('mirror only'));assert.equal(await page.evaluate(()=>window.reveal),null);assert.deepEqual(errors,[]);
 }finally{await browser.close();for(const ws of sockets.clients)ws.terminate();await new Promise(r=>sockets.close(r));await new Promise(r=>server.close(r));}
});
