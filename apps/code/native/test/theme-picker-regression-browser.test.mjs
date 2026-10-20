import test from 'node:test';
import assert from 'node:assert/strict';
import { listThemes, themeCss } from '../../../../system/theme.mjs';
import { harnessFixture, readBody } from './fixtures/harness-page.mjs';

// Only a loopback fake backend receives choices: never change the live theme.
// Automatic first (the Mac pair, half and half), then the Mac pair (plain).
for (const current of ['mac-dark', 'mac-light']) for (const width of [1536, 390]) test(`${width} ${current}: Automatic and the two themes' faces, browse without choosing`, async () => {
  const themes = (await listThemes(`/tmp/imperfect-picker-no-personal-${process.pid}`)).map(t => ({...t, current:t.id === current}));
  assert.deepEqual(themes.map(t => t.id), ['mac-dark', 'mac-light']);
  const ids = ['auto', ...themes.map(t => t.id)];
  const choices = [];
  const f = await harnessFixture({site:true, viewport:{width,height:900}, hasTouch:width<500,
    messages:[{role:'assistant',content:'Ready.'}], themeCSS:themeCss(themes.find(t=>t.current)),
    handleRequest:async (req,res,path) => {
      if (path === '/themes.json') {res.setHeader('Content-Type','application/json');res.end(JSON.stringify({themes}));return true;}
      if (path === '/theme') {choices.push((await readBody(req)).id);res.end('{}');return true;}
      return false;
    }});
  const p=f.page;
  try {
    await p.keyboard.press('Alt+Shift+T');
    await p.locator('#theme-picker').waitFor({state:'visible'});
    assert.equal(await p.locator('#theme-picker .pick').count(),3);
    for (const id of ids) await p.locator(`#theme-picker [data-theme="${id}"]`).waitFor({state:'visible'});
    const faces=await p.locator('#theme-picker .pick-face').evaluateAll(nodes=>nodes.map(n=>({image:getComputedStyle(n).backgroundImage,blend:getComputedStyle(n).backgroundBlendMode,bg:getComputedStyle(n).backgroundColor})));
    assert.equal(faces.length,3);
    for(const face of faces) assert.ok(face.blend.split(', ').every(mode=>mode==='normal'),face.blend);
    assert.match(faces[0].image,/^linear-gradient/,'Automatic: the pair, half and half');
    for(const face of faces.slice(1)){assert.equal(face.image,'none');assert.notEqual(face.bg,'rgba(0, 0, 0, 0)');}
    assert.equal(await p.locator('.pick.chosen').getAttribute('data-theme'),current);
    const seen=new Set();
    for(let i=0;i<3;i++) {
      const chosen=p.locator('.pick.chosen');
      seen.add(await chosen.getAttribute('data-theme'));
      const r=await chosen.boundingBox();assert.ok(r.x>=0 && r.x+r.width<=width+1,'chosen face inside viewport');
      await p.keyboard.press('ArrowRight');
    }
    assert.equal(seen.size,3);assert.deepEqual(choices,[],'browsing never posts a choice');
    await p.keyboard.press('Escape');await p.locator('#theme-picker').waitFor({state:'hidden'});
    assert.deepEqual(choices,[],'closing preserves selection');
    await p.waitForTimeout(100);await p.keyboard.press('Alt+Shift+T');await p.locator('#theme-picker').waitFor({state:'visible'});
    assert.equal(await p.locator('.pick.chosen').getAttribute('data-theme'),current);
    await p.keyboard.press('ArrowRight');const next=await p.locator('.pick.chosen').getAttribute('data-theme');
    await p.keyboard.press('Enter');await p.waitForFunction(()=>document.querySelector('#theme-picker').hidden);
    await p.waitForTimeout(100);assert.deepEqual(choices,[next],'explicit confirmation alone posts choice');
    assert.deepEqual(f.errors,[]);
  } finally {await f.close();}
});
