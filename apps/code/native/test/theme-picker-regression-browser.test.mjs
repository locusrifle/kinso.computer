import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { listThemes, themeCss } from '../../../../system/theme.mjs';
import { harnessFixture, readBody } from './fixtures/harness-page.mjs';

for (const width of [1440, 390]) test(`Kinso ${width}: isolated pickers, live Automatic, persistent explicit choices`, { timeout: 90000 }, async t => {
  const themes = await listThemes(`/tmp/imperfect-picker-no-personal-${process.pid}`), posts = [];
  const f = await harnessFixture({ site: true, productOrigin: 'https://computer.kinso.computer',
    viewport: { width, height: width === 390 ? 844 : 900 }, hasTouch: width === 390,
    messages: [{ role: 'assistant', content: 'An invented conversation for appearance review.' }],
    themeCSS: themeCss(themes[0]) + `@media (prefers-color-scheme: light) {${themeCss(themes[1])}}`,
    handleRequest: async (req, res, path) => {
      if (path === '/themes.json') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ themes, auto: true })); return true; }
      if (path === '/theme') { posts.push((await readBody(req)).id); res.end('{}'); return true; }
      return false;
    } });
  t.after(() => f.close());
  const p = f.page;
  const appearance = expected => p.waitForFunction(expected => document.documentElement.dataset.kinsoAppearance === expected && document.querySelector('.kinso-sharks')?.dataset.palette === expected, expected);
  const settings = async () => {
    await p.evaluate(() => document.querySelector('.session-rail-settings').click());
    await p.locator('.settings-theme').first().waitFor();
  };
  const pick = name => p.getByRole('button', { name, exact: true }).click();
  await p.addStyleTag({ content: 'html body #entry-terminal { height: 100vh !important; }' });
  assert.equal(await p.locator('html').getAttribute('data-kinso-theme'), 'auto');
  await p.emulateMedia({ colorScheme: 'dark' }); await appearance('dark');
  await p.evaluate(() => { window.originalSea = document.querySelector('.kinso-sharks'); window.initialDraw = originalSea.getContext('2d'); });
  await p.emulateMedia({ colorScheme: 'light' }); await appearance('light');
  await settings();
  assert.deepEqual(await p.locator('.settings-theme-name').allTextContents(), ['Automatic', 'Kinso Light', 'Kinso Dark']);
  assert.equal(await p.locator('.settings-theme[aria-pressed="true"]').textContent(), 'Automatic');
  await pick('Kinso Dark'); await appearance('dark');
  await p.emulateMedia({ colorScheme: 'light' }); await appearance('dark');
  if (process.env.KINSO_PRESENTATION_SHOTS) {
    await mkdir(process.env.KINSO_PRESENTATION_SHOTS, { recursive: true });
    await p.screenshot({ path: join(process.env.KINSO_PRESENTATION_SHOTS, `${width}-settings-picker.png`) });
  }
  await p.reload(); await appearance('dark');
  assert.equal(await p.locator('html').getAttribute('data-kinso-theme'), 'kinso-dark');
  await p.evaluate(() => dispatchEvent(new Event('imperfect-themes')));
  await p.locator('#theme-picker').waitFor({ state: 'visible' });
  assert.deepEqual(await p.locator('#theme-picker .pick').evaluateAll(nodes => nodes.map(n => n.ariaLabel)), ['Automatic', 'Kinso Light', 'Kinso Dark']);
  assert.equal(await p.locator('.pick.chosen').getAttribute('data-theme'), 'kinso-dark');
  if (process.env.KINSO_PRESENTATION_SHOTS) await p.screenshot({ path: join(process.env.KINSO_PRESENTATION_SHOTS, `${width}-carousel-picker.png`) });
  await p.keyboard.press('ArrowRight'); await p.keyboard.press('Enter'); await appearance('light');
  assert.equal(await p.locator('html').getAttribute('data-kinso-theme'), 'auto');
  await p.emulateMedia({ colorScheme: 'dark' }); await appearance('dark');
  await p.evaluate(() => window.originalSea = document.querySelector('.kinso-sharks'));
  await p.emulateMedia({ colorScheme: 'light' }); await appearance('light');
  assert.equal(await p.evaluate(() => originalSea === document.querySelector('.kinso-sharks')), true, 'the sea is not remounted');
  assert.deepEqual(posts, [], 'Kinso never writes the computer’s Mac choice');
  // Same browser and origin, deliberately back to imperfect, with Kinso saved.
  await p.evaluate(async () => (await import('/js/kinso-theme.js')).setKinsoTheme('kinso-dark'));
  await p.goto('https://computer.kinso.computer/?for=imperfect');
  await p.locator('#entry-output .gui-assistant').waitFor();
  await settings();
  assert.deepEqual(await p.locator('.settings-theme-name').allTextContents(), ['Automatic', 'Mac · Dark', 'Mac · Light']);
  assert.equal(await p.locator('.kinso-sharks').count(), 0);
  assert.equal(await p.locator('body').evaluate(n => getComputedStyle(n).backgroundColor), 'rgb(255, 255, 255)');
  await Promise.all([p.waitForResponse(response => new URL(response.url()).pathname === '/theme'), pick('Mac · Dark')]);
  assert.deepEqual(posts, ['mac-dark']);
  await p.emulateMedia({ colorScheme: 'dark' });
  assert.equal(await p.locator('body').evaluate(n => getComputedStyle(n).backgroundColor), 'rgb(18, 18, 20)');
  assert.equal(await p.evaluate(() => localStorage.getItem('kinso.appearance')), 'kinso-dark');
  assert.deepEqual(f.errors, []);
});

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
