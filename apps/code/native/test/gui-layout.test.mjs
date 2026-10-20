import { test } from 'node:test';
import assert from 'node:assert/strict';
import { launchChromium } from '../../../../tools/test-browser.mjs';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';

test('GUI DOM safety, readable work, and input navigation on desktop/phone', async () => {
 const server=createServer(async(req,res)=>{try {const path=req.url.split('?')[0];if(path==='/'){res.setHeader('Content-Type','text/html');res.end('<!doctype html><meta name="viewport" content="width=device-width"><link rel="stylesheet" href="/css/gui-transcript.css"><main id="root"></main>');return;}const text=await readFile(new URL(`../public${path}`,import.meta.url));res.setHeader('Content-Type',path.endsWith('.js')?'text/javascript':'text/css');res.end(text);}catch{res.writeHead(404).end();}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const browser=await launchChromium({headless:true,args:['--no-sandbox']}).catch(error=>{server.close();throw error;});
 try { for(const width of [1280,390]) {
  const page=await browser.newPage({viewport:{width,height:820}});await page.goto(`http://127.0.0.1:${server.address().port}`);
  const result=await page.evaluate(async()=>{
   const {renderGuiTranscript,pastInputs}=await import('/js/gui-transcript.js');
   const root=document.querySelector('#root');const transcript=document.createElement('div');transcript.className='gui-transcript';root.append(transcript);
   const state={messages:[{role:'user',content:'First prompt'},{role:'assistant',content:[{type:'text',text:'# Heading\n\n**Bold** [safe](https://example.org) [bad](javascript:alert(1)) <img src=x onerror=alert(1)>\n\n```js\n<script>alert(1)</script>\n```\n\n- One\n- Two\n\n17. Seventeen\n18. Eighteen\n\n| A | B |\n| --- | --- |\n| C | D |'},{type:'thinking',thinking:'private reasoning'},{type:'toolCall',id:'t1',name:'read',arguments:{path:'secret'}}]},{role:'toolResult',toolCallId:'t1',isError:true,content:'Permission denied'},{role:'assistant',content:'Significant answer'},{role:'user',content:'Second prompt'}]};
   renderGuiTranscript(transcript,state);
   const {transcriptScroll}=await import('/js/transcript-scroll.js');
   const scroll=document.createElement('div');scroll.style.cssText='height:150px;overflow:auto;overflow-anchor:none';root.append(scroll);const scroller=transcriptScroll(scroll);
   const grow=()=>{for(let i=0;i<30;i++){const p=document.createElement('p');p.textContent='Conversation '+i;p.style.height='35px';scroll.append(p);}};
   const tick=()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));grow();scroller.latest();await tick();const follows=scroll.scrollHeight-scroll.clientHeight-scroll.scrollTop<2;
   scroll.dispatchEvent(new WheelEvent('wheel',{deltaY:-100}));scroll.scrollTop=80;await tick();grow();scroller.rendered(80);await tick();const frozen=scroll.scrollTop===80;
   scroller.latest();await tick();const latest=scroll.scrollHeight-scroll.clientHeight-scroll.scrollTop<2;
   return {olStart:transcript.querySelector('ol')?.start,follows,frozen,latest,unsafe:!!transcript.querySelector('script,img,[href^="javascript"]'),heading:transcript.querySelector('h1')?.textContent,code:transcript.querySelector('pre code')?.textContent,table:!!transcript.querySelector('table'),hidden:!['private reasoning','Permission denied','secret'].some(t=>transcript.textContent.includes(t))&&!transcript.querySelector('details'),answer:transcript.textContent.includes('Significant answer'),inputs:pastInputs(state).length,overflow:document.documentElement.scrollWidth>innerWidth};
  });
  assert.equal(result.olStart,17,'a list starting at 17 is numbered from 17');assert.equal(result.follows,true);assert.equal(result.frozen,true);assert.equal(result.latest,true);
  assert.equal(result.unsafe,false);assert.equal(result.heading,'Heading');assert.equal(result.table,true);assert.equal(result.hidden,true,'what was said, not how: no reasoning, tool calls or tool output');assert.equal(result.answer,true);assert.equal(result.inputs,2);assert.equal(result.overflow,false);await page.close();
 }} finally {await browser.close();await new Promise(r=>server.close(r));}
});

test('an empty conversation opens on its harness overview, one line a part, opened on a click', async () => {
 const server=createServer(async(req,res)=>{try {const path=req.url.split('?')[0];if(path==='/'){res.setHeader('Content-Type','text/html');res.end('<!doctype html><meta name="viewport" content="width=device-width"><link rel="stylesheet" href="/css/gui-transcript.css"><main id="root"></main>');return;}const text=await readFile(new URL(`../public${path}`,import.meta.url));res.setHeader('Content-Type',path.endsWith('.js')?'text/javascript':'text/css');res.end(text);}catch{res.writeHead(404).end();}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const browser=await launchChromium({headless:true,args:['--no-sandbox']}).catch(error=>{server.close();throw error;});
 try { for(const width of [1280,320]) {
  const page=await browser.newPage({viewport:{width,height:700}});await page.goto(`http://127.0.0.1:${server.address().port}`);
  const result=await page.evaluate(async()=>{
   const {renderGuiTranscript}=await import('/js/gui-transcript.js');
   const transcript=document.createElement('div');transcript.className='gui-transcript';document.querySelector('#root').append(transcript);
   const tools=Array.from({length:40},(_,i)=>`tool_${i}`);
   const state={source:'claude',messages:[],model:{name:'Opus 5.5'},level:'high',startup:{version:'Claude Code 2.1.286',cwd:'~/workspace',sections:[{name:'Context',compact:'AGENTS.md',expanded:'~/workspace/AGENTS.md'},{name:'Tools',compact:tools.join(', '),expanded:tools.join('\n')}]}};
   const draw=()=>{transcript.replaceChildren();renderGuiTranscript(transcript,state);};
   draw();
   const head=transcript.querySelector('.gui-overview-head').textContent;
   const labels=[...transcript.querySelectorAll('.gui-overview-label')].map(n=>n.textContent);
   const oneLine=[...transcript.querySelectorAll('.gui-overview-part summary')].every(n=>n.getBoundingClientRect().height<30);
   transcript.querySelectorAll('summary')[1].click();await new Promise(r=>setTimeout(r,50));draw();
   const kept=transcript.querySelectorAll('.gui-overview-part')[1].open&&transcript.querySelectorAll('.gui-overview-part li').length===40+1;
   return {head,labels,oneLine,kept,notice:transcript.textContent.includes('Start a conversation'),overflow:document.documentElement.scrollWidth>innerWidth};
  });
  assert.equal(result.head,'Claude Code 2.1.286Opus 5.5high effort');
  assert.deepEqual(result.labels,['[Context]','[Tools]']);
  assert.equal(result.oneLine,true,'each part is one line, however long its list');
  assert.equal(result.kept,true,'an opened part lists everything, and stays open through redraws');
  assert.equal(result.notice,false);assert.equal(result.overflow,false);await page.close();
 }} finally {await browser.close();await new Promise(r=>server.close(r));}
});
