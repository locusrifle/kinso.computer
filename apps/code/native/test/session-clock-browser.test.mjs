import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {harnessFixture} from './fixtures/harness-page.mjs';
import {themeCss} from '../../../../system/theme.mjs';

// Time, Wi-Fi and battery are the screen's, not a column's: at the top centre
// of the window whatever columns lie under it, scrolled, turned or full.
for (const desk of [false, true]) test(`${desk ? 'native' : 'web'} the screen status stays at the window's centre`, async () => {
 const f = await harnessFixture({desk, site:!desk, viewport:{width:1536,height:900}, messages:[{role:'assistant',content:'Ready.'}]});
 const p = f.page;
 const mod = desk ? 'Meta' : 'Alt';
 const check = async () => {
  await p.waitForTimeout(150);
  const g = await p.evaluate(() => {
   const group = document.querySelector('.screen-status'), c = group.getBoundingClientRect();
   const controls = [...document.querySelectorAll('.session-rail-heading button, .session-rail-item[data-tab-id], .wm-bar button, .wm-bar input, .workbench-bar button')]
    .filter(n => n.getClientRects().length && getComputedStyle(n).visibility !== 'hidden');
   const top = document.elementFromPoint((c.left + c.right) / 2, (c.top + c.bottom) / 2);
   return {center:(c.left+c.right)/2, width:innerWidth, top:c.top, visible:getComputedStyle(group).visibility !== 'hidden', onTop:group.contains(top) || top === group,
    clock:group.querySelector('time')?.textContent, clockVisible:Boolean(group.querySelector('time')?.getClientRects().length), phone:matchMedia('(pointer: coarse)').matches,
    // What is drawn: a band-high button's icon, not its whole hit area.
    overlaps:controls.filter(n => {const r=(n.querySelector('svg') ?? n).getBoundingClientRect();return r.left<c.right && r.right>c.left && r.top<c.bottom && r.bottom>c.top;}).map(n => n.className)};
  });
  assert.ok(g.visible, JSON.stringify(g));
  assert.ok(Math.abs(g.center - g.width / 2) < 1.5, `the window's centre: ${JSON.stringify(g)}`);
  assert.ok(Math.abs(g.top - 4) < 1, 'on the band\'s top line');
  assert.ok(g.clock, 'desktop clock state remains available');
  assert.equal(g.clockVisible, !g.phone, 'the time is visible only outside the phone layout');
  assert.deepEqual(g.overlaps, [], 'over no control');
  return g;
 };
 try {
  await p.locator('.wm-files').waitFor();
  // The whole window opens as every window does (window-in), the status with
  // it: where it stays is measured once it is open.
  await p.waitForFunction(() => !document.getAnimations().some(a => a.animationName === 'window-in'));
  assert.equal(await p.locator('#session-rail .screen-clock, #session-rail time').count(), 0, 'no clock of the session column any more');
  await check();
  f.send({type:'shown', kind:'page', target:'https://clock.example/'});
  await p.locator('.wm-browser').waitFor();
  await p.waitForFunction(() => !document.querySelector('.wm-moving'));
  await check();
  // Columns moved along, the session cut off or out of view entirely.
  await p.keyboard.press(`${mod}+ArrowRight`); await check();
  await p.keyboard.press(`${mod}+ArrowRight`); await check();
  await p.keyboard.press(`${mod}+Shift+ArrowRight`); await p.waitForFunction(() => !document.querySelector('.wm-moving')); await check();
  await p.keyboard.press(`${mod}+Shift+ArrowLeft`); await p.waitForFunction(() => !document.querySelector('.wm-moving')); await check();
  // Back from Files (a website of another origin keeps Alt arrows to itself).
  await p.locator('.wm-files .workbench').focus();
  await p.keyboard.press(`${mod}+ArrowLeft`); await check();
  // Files full: the session's bar is hidden, the screen's status is not.
  await p.locator('.wm-files').click({position:{x:200,y:300}});
  await p.keyboard.press(`${mod}+F`); await p.waitForFunction(() => document.querySelector('.wm-full')); await check();
  await p.keyboard.press(`${mod}+F`); await check();
  await p.locator('.session-rail-fold').click(); await check();
  await p.locator('.session-rail-fold').click(); await check();
  await p.setViewportSize({width:1200,height:800}); await check();
  await p.setViewportSize({width:390,height:800}); await check();
  assert.deepEqual(f.errors,[]);
 } finally { await f.close(); }
});

for (const width of [1536,390,320]) for (const theme of ['black','light-chalk']) test(`${width} ${theme}: screen status stays centred; clock is desktop-only`, async()=>{
 const themeCSS=themeCss(JSON.parse(await readFile(new URL(`./fixtures/themes/${theme}.json`,import.meta.url),'utf8')));
 const f=await harnessFixture({site:true,themeCSS,viewport:{width,height:900},hasTouch:width<500,messages:[{role:'assistant',content:'Ready.'}]});
 const p=f.page,narrow=width<500;
 const geometry=()=>p.evaluate(()=>{
  const rect=n=>{const r=n.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width}};
  const rail=document.querySelector('#session-rail'),clock=document.querySelector('.screen-status'),plus=rail.querySelector('.session-rail-new'),fold=rail.querySelector('.session-rail-fold');
  const tabs=[...rail.querySelectorAll('.session-rail-item[data-tab-id]')];
  const r=rect(rail),c=rect(clock),a=rect(plus),b=rect(fold);
  return {r,c,a,b,last:rect(tabs.at(-1)),bg:getComputedStyle(clock).backgroundColor,headingBg:getComputedStyle(rail.querySelector('.session-rail-heading')).backgroundColor,
   expected:new Intl.DateTimeFormat(undefined,{hour:'2-digit',minute:'2-digit'}).format(new Date()),actual:clock.querySelector('time').textContent,clockVisible:Boolean(clock.querySelector('time').getClientRects().length),phone:matchMedia('(pointer: coarse)').matches,mid:innerWidth/2,
   overlaps:tabs.some(t=>{const x=rect(t);return x.left<c.right&&x.right>c.left&&x.top<c.bottom&&x.bottom>c.top}),
   reachable:plus.contains(document.elementFromPoint((a.left+a.right)/2,(a.top+a.bottom)/2)),
   numerals:tabs.map(t=>t.querySelector('.session-rail-number')?.textContent),marks:tabs.map(t=>Boolean(t.querySelector('.session-rail-logo'))),statusShown:getComputedStyle(clock).display!=='none'};
 });
 try {
  await p.waitForTimeout(500);
  await p.waitForFunction(()=>document.querySelector('.screen-clock').textContent===new Intl.DateTimeFormat(undefined,{hour:'2-digit',minute:'2-digit'}).format(new Date()));
  let g=await geometry();
  // A phone's strip names the session in front instead: no status in the middle.
  if(narrow)assert.equal(g.statusShown,false);else assert.ok(Math.abs((g.c.left+g.c.right)/2-g.mid)<1);
  assert.equal(g.actual,g.expected);assert.equal(g.clockVisible,!g.phone,'no time in the phone app');assert.equal(g.bg,'rgba(0, 0, 0, 0)');assert.equal(g.headingBg,'rgba(0, 0, 0, 0)');
  assert.equal(g.overlaps,false);assert.ok(Math.abs(g.a.left-g.last.right)<1,JSON.stringify(g));assert.ok(g.reachable);if(narrow)assert.deepEqual(g.marks,[true]);else assert.deepEqual(g.numerals,['I']);
  const original=g;
  await p.locator('.session-rail-fold').click();g=await geometry();
  // A phone's sheet keeps + beside the fold, as the Mac's sidebar band does.
  if(narrow)assert.ok(Math.abs(g.a.right-g.b.left)<3,`plus beside the fold: ${JSON.stringify(g)}`);else assert.ok(Math.abs(g.a.left-original.a.left)<1,`expansion preserves plus position: ${JSON.stringify({original,g})}`);
  assert.ok(Math.abs(g.b.left-original.b.left)<1,'expansion preserves fold position');
  if(!narrow)assert.ok(Math.abs((g.c.left+g.c.right)/2-g.mid)<1);assert.equal(g.headingBg,'rgba(0, 0, 0, 0)');
  await p.locator('.session-rail-fold').click();
  f.push({...f.tab,tabs:Array.from({length:24},(_,i)=>({...f.tab.tabs[0],id:`tab-${i}`,focused:i===0,prompt:`Session ${i} caption`}))});
  await p.waitForTimeout(150);g=await geometry();assert.equal(g.overlaps,false);assert.ok(g.reachable,'plus stays reachable on overflow');
  if(!narrow)assert.ok(Math.abs((g.c.left+g.c.right)/2-g.mid)<1,'centre independent of tab count');
  await p.locator('.session-rail-agents').evaluate(n=>n.scrollLeft=n.scrollWidth);g=await geometry();assert.ok(Math.abs(g.a.left-g.last.right)<1,'plus directly follows final tab at end of overflow');
  await p.screenshot({path:`/tmp/session-clock-${width}-${theme}.png`});
  // Clear the real interval before replacing the browser's timer APIs.
  await p.evaluate(()=>dispatchEvent(new Event('pagehide')));
  await p.clock.install({time:new Date('2026-10-09T12:01:00Z')});
  await p.evaluate(()=>dispatchEvent(new Event('pageshow')));
  await p.clock.fastForward(60_000);g=await geometry();assert.equal(g.actual,g.expected,'minute tick uses browser local time');
  const before=g.actual;
  await p.evaluate(()=>dispatchEvent(new Event('pagehide')));
  await p.clock.fastForward(60_000);assert.equal(await p.locator('.screen-clock').textContent(),before,'pagehide cleans interval');
  await p.evaluate(()=>dispatchEvent(new Event('pageshow')));g=await geometry();assert.equal(g.actual,g.expected,'back/forward restoration refreshes clock');
  assert.deepEqual(f.errors,[]);
 }finally{await f.close()}
});
