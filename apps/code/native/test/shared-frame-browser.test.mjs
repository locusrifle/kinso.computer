import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { inflateSync } from 'node:zlib';
import { harnessFixture } from './fixtures/harness-page.mjs';
import { themeCss } from '../../../../system/theme.mjs';
const themes = await Promise.all(['black','light-chalk'].map(async name => themeCss(JSON.parse(await readFile(new URL(`./fixtures/themes/${name}.json`,import.meta.url),'utf8')))));

const index = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
const box = (page, selector) => page.locator(selector).evaluate(n => { const r = n.getBoundingClientRect(); return { x:r.x, y:r.y, width:r.width, height:r.height, bottom:r.bottom }; });
const near = (a,b,label) => assert.ok(Math.abs(a-b)<2, `${label}: ${a} vs ${b}`);
// One screen pixel, from a 1x1 PNG (its only row needs no unfiltering).
const pixel = async (page,x,y) => {
  const png=await page.screenshot({clip:{x:Math.floor(x),y:Math.floor(y),width:1,height:1}});
  const chunks=[]; for(let at=8;at<png.length;) { const length=png.readUInt32BE(at), type=png.toString('ascii',at+4,at+8); if(type==='IDAT') chunks.push(png.subarray(at+8,at+8+length)); at+=12+length; }
  return [...inflateSync(Buffer.concat(chunks)).subarray(1,4)];
};

for (const width of [1536,1280,390,320]) for (const light of [false,true]) test(`shared frame ${width} ${light?'Chalk':'Black'}: aligned bands, one composer, drafts and questions`, async () => {
  const mobile = width < 500;
  // This suite covers the selectable scrolling frame; focus has its own suite.
  const f = await harnessFixture({ site:true, layout:'scrolling', themeCSS:themes[light?1:0], viewport:{width,height:972}, hasTouch:mobile,
    machines:[{id:'desktop',name:'PC',self:true,reachable:true,capabilities:['code','files']},{id:'laptop',name:'Laptop',reachable:true,capabilities:['code','files']}],
    messages:[{role:'user',content:'A human paragraph.\n\nAnother paragraph.'},{role:'assistant',content:'An unchanged assistant response.'}],
    handleRequest:async (req,res,path) => {
      if(path==='/') { res.setHeader('Content-Type','text/html'); res.end(index); return true; }
      if(path==='/files/list') { res.setHeader('Content-Type','application/json'); res.end(JSON.stringify({path:new URL(req.url,'http://fixture').searchParams.get('path')||'/fixture',home:'/fixture',entries:[]})); return true; }
      return false;
    }
  });
  const p=f.page;
  try {
    await p.waitForTimeout(650);
    const rail=await box(p,'#session-rail');
    const status=await box(p,'.entry-status');
    const input=await box(p,'#entry-input-zone');
    near(status.x,0,'composer left'); near(input.width,width,'composer spans Files too'); near(status.width,width,'controls span Files too');
    near(rail.height,status.height+input.height,'matching resting bands');
    const files=await box(p,'.workbench-bar');
    near(files.y,rail.y,'header tops'); near(files.height,rail.height,'header thickness');
    assert.equal(await p.locator('.workbench-heading').count(),0,'no redundant heading');
    assert.deepEqual(await p.locator('.workbench-path .workbench-crumb').allTextContents(),['PC','fixture'],'Files names its computer and folder in the single row');
    assert.doesNotMatch(await p.locator('.workbench-bar').innerText(),/Laptop|Computers/,'other computers stay in the root picker, not the folder header');
    assert.equal(await p.locator('.workbench-view-count').textContent(),'+','one view: the count is +');
    const sessionTab=await box(p,'.session-rail-item.active .session-rail-open'), filesRow=await box(p,'.workbench-address');
    near(filesRow.y,sessionTab.y,'Files row level with the session tabs'); near(filesRow.bottom,sessionTab.bottom,'and as tall');
    assert.equal(await p.locator('.session-rail-item.active .session-rail-number').textContent(),'I','collapsed sessions use Roman numerals');
    assert.equal(await p.locator('.session-rail-item.active .session-rail-line').evaluate(n=>getComputedStyle(n).gap),'8px','Roman number/caption gap');
    assert.equal(await p.locator('#entry-input').count(),1);
    const outline=await p.locator('.session-rail-item.active .session-rail-open').evaluate(n=>{const s=getComputedStyle(n);return [s.borderTopWidth,s.borderRightWidth,s.borderBottomWidth,s.borderLeftWidth,s.backgroundColor];});
    assert.deepEqual(outline.slice(0,4),['1px','1px','0px','1px'],'the band supplies the selected tab bottom edge');
    assert.equal(outline[4],'rgba(0, 0, 0, 0)');
    const tab=await box(p,'.session-rail-item.active .session-rail-open');
    assert.ok(Math.abs(tab.bottom-rail.bottom)<0.1,'tab sides run down through the shared divider');
    near((await box(p,'.session-rail-agents > :first-child')).x,rail.x,'tabs start hard at the left edge');
    // A folder tab: the divider shows beside the selected tab but not under it.
    const under=await pixel(p,tab.x+tab.width/2,rail.bottom-1), panel=await pixel(p,tab.x+tab.width/2,rail.bottom+3);
    const beside=await pixel(p,tab.x+tab.width+20,rail.bottom-1);
    assert.deepEqual(under,panel,'the panel runs on up into the selected tab');
    assert.notDeepEqual(beside,panel,'the divider is drawn elsewhere');
    for(const selector of ['.session-rail-new .session-rail-open','.session-rail-fold']) {
      const control=await box(p,selector);
      near(control.bottom,tab.bottom,`${selector} rests on the divider`); near(control.height,tab.height,`${selector} as tall as the tabs`);
    }
    assert.equal(await p.locator('.session-rail-item.active .session-rail-open').evaluate(n=>getComputedStyle(n).borderRadius),'0px');
    const ink=await box(p,'.session-rail-item.active .session-rail-line');
    assert.ok(ink.y>=tab.y+1 && ink.bottom<=tab.bottom,'session ink fits inside seated tab');
    await p.locator('#entry-input').evaluate(n=>n.blur());
    await p.evaluate(()=>{window.inputFocuses=0;document.querySelector('#entry-input').addEventListener('focus',()=>inputFocuses++);});
    await p.locator('.entry-usage').click();
    await p.locator('.usage-box').waitFor();
    near((await box(p,'.usage-box')).y,rail.bottom,'usage starts below shared top');
    near((await box(p,'.usage-box')).bottom,status.y,'usage fills middle only');
    assert.equal(await p.evaluate(()=>inputFocuses),0,'usage opens without keyboard');
    await p.locator('.usage-back').click();
    assert.equal(await p.evaluate(()=>inputFocuses),0,'usage closes without keyboard');
    const inset=await p.locator('.gui-prompt').evaluate(n=>{
      const s=getComputedStyle(n), first=n.firstElementChild,last=n.lastElementChild;
      return {padding:[s.paddingTop,s.paddingRight,s.paddingBottom,s.paddingLeft].map(parseFloat),first:first?getComputedStyle(first).marginTop:'0px',last:last?getComputedStyle(last).marginBottom:'0px'};
    });
    assert.ok(inset.padding.every(v=>v===inset.padding[0]),'equal human padding');
    assert.equal(inset.first,'0px'); assert.equal(inset.last,'0px');
    const content=await p.locator('.gui-prompt').evaluate(n=>{const r=n.getBoundingClientRect(),range=document.createRange(); range.selectNodeContents(n);const text=range.getBoundingClientRect();return [text.top-r.top,r.bottom-text.bottom,getComputedStyle(n).lineHeight];});
    near(content[0],content[1],'actual text line boxes have symmetrical vertical inset');
    assert.equal(content[2],'24px','human text and typing share a baseline rhythm');
    await p.locator('#entry-input').fill('A draft\nwith several\nlines to keep\nwhile changing panels');
    await p.waitForTimeout(100);
    assert.ok((await box(p,'#entry-input-zone')).height>input.height,'multiline grows instead of clipping');
    assert.ok(await p.locator('#entry-input').evaluate(n=>n.clientHeight>=96 && n.scrollHeight<=n.clientHeight),'all four draft lines fit without clipping');
    await p.locator('#entry-input').fill('A draft\n'+'lines to keep\n'.repeat(30));
    const capped=await p.locator('#entry-input').evaluate(n=>({height:n.clientHeight,scroll:n.scrollHeight,room:document.querySelector('#canvas').clientHeight}));
    assert.ok(capped.height<=capped.room*.3 && capped.height%24===0 && capped.scroll>capped.height,'long drafts scroll at a whole-line cap, leaving the panels readable');
    await p.locator('#entry-input').fill('A draft\nwith several\nlines to keep\nwhile changing panels');
    if(mobile) {
      await p.locator('#canvas-strip').evaluate(s=>s.scrollTo({left:s.clientWidth,behavior:'instant'}));
      await p.waitForTimeout(150);
      near((await box(p,'.wm-files')).width,width,'Files is one phone width');
      await p.getByRole('button',{name:'PC filesystem root',exact:true}).click();
      await p.getByRole('button',{name:'Choose a computer',exact:true}).click();
      await p.locator('.workbench-device').first().waitFor();
      assert.deepEqual(await p.locator('.workbench-device .workbench-name').allTextContents(),['PC','Laptop']);
      await p.locator('.workbench-view-count').click();
      await p.waitForFunction(()=>document.querySelector('.workbench-view-count').textContent==='2/2');
      const count=await box(p,'.workbench-view-count');
      assert.ok(count.x>=0 && count.x+count.width<=width,'the count stays inside a narrow row');
      await p.locator('.workbench-view-count').click();
      assert.equal(await p.locator('.workbench-view-picker .workbench-tab').count(),2,'compact count retains multiple views');
      await p.keyboard.press('Escape');
      near((await box(p,'#entry-input-zone')).width,width,'swiped composer width');
      assert.equal(await p.locator('#entry-input').count(),1);
      await p.locator('#canvas-strip').evaluate(s=>s.scrollTo({left:0,behavior:'instant'}));
    }
    assert.match(await p.locator('#entry-input').inputValue(),/lines to keep/);
    f.push({...f.tab,ui:{dialogs:[{id:'question',method:'confirm',title:'Keep this draft?',message:'Choose without losing the draft.'}]}});
    await p.locator('#entry-dialog.input-dialog:not([hidden])').waitFor();
    assert.equal(await p.locator('#entry-input-zone').isVisible(),false);
    near((await box(p,'#entry-dialog')).width,width,'question shares full footer');
    near((await box(p,'#entry-dialog')).bottom,972,'question at canvas bottom');
    f.push({...f.tab,ui:{dialogs:[]}});
    await p.locator('#entry-input').waitFor();
    assert.match(await p.locator('#entry-input').inputValue(),/lines to keep/);
    await p.setViewportSize({width,height:700});
    await p.waitForTimeout(100);
    near((await box(p,'#entry-input-zone')).bottom,700,'resized footer');
    if(mobile) {
      await p.evaluate(()=>{document.documentElement.style.setProperty('--safe-top','36px');document.documentElement.style.setProperty('--safe-bottom','240px');});
      await p.waitForTimeout(100);
      near((await box(p,'#entry-input-zone')).bottom,460,'keyboard-sized bottom inset');
      near((await box(p,'#session-rail')).y,36,'safe top inset');
      await p.evaluate(()=>document.documentElement.style.setProperty('--safe-bottom','340px'));
      f.push({...f.tab,ui:{dialogs:[{id:'keyboard-question',method:'confirm',title:'Keep this draft?',message:'A long question still leaves conversation space. '.repeat(80)}]}});
      await p.locator('#entry-dialog.input-dialog:not([hidden])').waitFor();
      await p.waitForTimeout(100);
      near((await box(p,'#entry-dialog')).bottom,360,'question remains above a large keyboard');
      assert.ok(await p.locator('#entry-output').evaluate(n=>n.clientHeight>=58),'question leaves readable transcript room');
      assert.ok(await p.locator('#entry-dialog').evaluate(n=>n.scrollHeight>n.clientHeight),'long question scrolls, never clips its answers');
      f.push({...f.tab,ui:{dialogs:[]}});
      await p.locator('#entry-input').waitFor();
      assert.match(await p.locator('#entry-input').inputValue(),/lines to keep/);
    }
    const outer=await p.evaluate(()=>({w:document.documentElement.scrollWidth,h:document.documentElement.scrollHeight}));
    assert.equal(outer.w,width); assert.equal(outer.h,700);
    assert.deepEqual(f.errors,[]);
  } finally {await f.close();}
});
