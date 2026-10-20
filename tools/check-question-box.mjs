// The real throwaway surface, with local questions rather than a running agent.
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { launchChromium } from './test-browser.mjs';
import { readTheme, themeCss } from '../system/theme.mjs';

const at = 'http://127.0.0.1:5076';
const before = process.argv.includes('--before');
const shots = join(homedir(), 'workbench/question-box/shots');
await mkdir(shots, { recursive: true });
const browser = await launchChromium({ headless: true, args: ['--no-sandbox'] });
const errors = [];
const question = {
  header: 'Remove', question: '“Save for later” keeps your draft instead of sending it. Which do you want gone?',
  options: [
    { label: 'Both (Recommended)', description: 'Delete the Later feature and its dock button. The writer also drops save, open and post buttons: the piece stays saved as you work. A very long description should wrap calmly, even beside a narrow conversation or on a phone. ' + 'unbroken-description-'.repeat(12) },
    { label: 'Only writer buttons', description: 'Keep Later. The writer saves automatically, and I handle posting.' },
    { label: 'Only Later', description: 'The writer keeps its own buttons.' },
  ],
};
let sequence = 0;
try {
  for (const theme of ['bloom-light', 'bloom-dark']) for (const phone of [false, true]) {
    const context = await browser.newContext({ viewport: { width: phone ? 390 : 1426, height: phone ? 844 : 956 }, isMobile: phone, hasTouch: phone });
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    let socket;
    const commands = [];
    let state = {
      sessionId: 'question-check', cwd: '/tmp/imperfect-qbox', agent: 'claude', busy: false,
      model: { provider: 'fixture', id: 'fixture', name: 'Question check' }, stats: {},
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'Let’s make the question box quieter.' }] },
        { role: 'assistant', content: [{ type: 'text', text: 'The conversation stays here while you choose.\n\n' + 'Earlier conversation, still scrollable.\n\n'.repeat(30) }] },
      ],
      tabs: [{ id: 'question-tab', sessionId: 'question-check', name: 'Question check', focused: true, agent: 'claude', status: 'idle' }],
      ui: { dialogs: [] }, queue: { items: [] }, updates: [{ name: 'pi', installed: '0.99.2', latest: '1.0.0' }],
    };
    const push = () => socket.send(JSON.stringify({ type: 'snapshot', data: state }));
    const themeData = await readTheme(theme);
    await page.route('**/theme.css', route => route.fulfill({ contentType: 'text/css', body: themeCss(themeData) }));
    await page.route('**/upload', route => route.fulfill({ json: { path: '/tmp/imperfect-qbox/pending.txt', size: 20 } }));
    await page.route('**/machines.json', route => route.fulfill({ json: { machines: [{ id: 'question-machine', name: 'Question check', self: true, reachable: true, online: true, protocol: 1, capabilities: ['code', 'files', 'preferences'] }] } }));
    await page.routeWebSocket(/\/pi$/, ws => {
      socket = ws;
      ws.onMessage(raw => {
        const request = JSON.parse(raw); commands.push(request);
        const data = request.type === 'snapshot' ? state : request.type === 'tab-focus' ? { snapshot: state } : { ok: true };
        ws.send(JSON.stringify({ type: 'response', id: request.id, success: true, data }));
        if (request.type === 'dialog') { state = { ...state, ui: { dialogs: [] } }; push(); }
      });
      push();
    });
    await page.goto(at);
    await page.locator('#entry-output .gui-assistant').waitFor();
    await page.locator('#entry-input').fill('My unfinished draft');
    await page.locator('#entry-files').setInputFiles({ name: 'pending.txt', mimeType: 'text/plain', buffer: Buffer.from('Keep this attachment') });
    await page.waitForFunction(() => !document.querySelector('#entry-pending').hidden);
    await page.locator('.session-actions').evaluate(node => node.classList.add('open'));
    const bottom = ['#entry-input-zone', '.entry-status', '#entry-pending'];
    const visibility = await Promise.all(bottom.map(selector => page.locator(selector).isVisible()));
    const name = `${before ? 'before' : 'after'}-${theme}-${phone ? 'phone' : 'desktop'}`;
    const shot = suffix => page.screenshot({ path: join(shots, `${name}-${suffix}.png`) });
    const open = async (method, fields = {}, agent = 'claude') => {
      state = { ...state, agent, ui: { dialogs: [{ id: `q-${++sequence}`, method, title: 'Allow this action?', ...fields }] } }; push();
      await page.locator('#entry-dialog:not([hidden])').waitFor();
      await page.waitForTimeout(80);
      if (!before) {
        for (const selector of ['#entry-input-zone', '.entry-status', '#entry-pending']) assert.equal(await page.locator(selector).isVisible(), false, `${name}: hides ${selector}`);
        const geometry = await page.locator('#entry-dialog').evaluate(node => {
          const output = document.querySelector('#entry-output'), terminal = document.querySelector('#entry-terminal');
          const style = getComputedStyle(node);
          return { overflow: node.scrollWidth > node.clientWidth, bottom: node.getBoundingClientRect().bottom, terminalBottom: terminal.getBoundingClientRect().bottom, outputHeight: output.clientHeight, scrollable: output.scrollHeight > output.clientHeight, border: style.borderTopWidth, bg: style.backgroundColor, terminalBg: getComputedStyle(terminal).backgroundColor };
        });
        assert.equal(geometry.overflow, false, `${name}: no horizontal overflow`);
        assert.ok(Math.abs(geometry.bottom - geometry.terminalBottom) < 2, `${name}: replaces the composer at the bottom`);
        assert.ok(geometry.outputHeight > 50 && geometry.scrollable, `${name}: transcript stays scrollable`);
        assert.equal(geometry.border, '1px');
        assert.equal(geometry.bg, geometry.terminalBg, `${name}: one surface`);
      }
    };
    const close = async () => {
      if (before) { state = { ...state, ui: { dialogs: [] } }; push(); }
      else await page.keyboard.press('Escape');
      await page.locator('#entry-dialog').waitFor({ state: 'hidden' });
      if (!before) {
        for (const [index, selector] of bottom.entries()) assert.equal(await page.locator(selector).isVisible(), visibility[index], `${name}: restores ${selector}`);
        assert.equal(await page.locator('#entry-input').inputValue(), 'My unfinished draft');
        assert.match(await page.locator('#entry-pending').textContent(), /pending.txt/);
        assert.equal(await page.locator('.session-actions').evaluate(node => node.classList.contains('open')), true);
      }
    };
    await open('questions', { questions: [question] });
    await shot('one');
    await page.getByRole('button', { name: 'Other', exact: true }).click();
    const other = page.locator('.entry-dialog-other input');
    await other.click();
    await other.fill('Don’t delete it; I changed my mind.');
    if (!before) assert.deepEqual(await other.evaluate(node => { const style = getComputedStyle(node); return [style.outlineStyle, style.borderRadius]; }), ['none', '0px']);
    await shot('other');
    if (!before) {
      await page.keyboard.press('Enter');
      await page.locator('#entry-dialog').waitFor({ state: 'hidden' });
      assert.equal(commands.filter(c => c.type === 'dialog').at(-1).value[question.question], 'Don’t delete it; I changed my mind.');
    } else await close();
    await open('questions', { questions: [question, { ...question, header: 'Keep', question: 'Where should it stay?', options: question.options.slice(1) }, { header: 'Next', question: 'What happens next?', options: [{ label: 'Wait', description: 'Nothing needs to happen today.' }, { label: 'Continue', description: 'Keep going.' }], multiSelect: true }] }, 'pi');
    await shot('three');
    await page.locator('#entry-dialog').evaluate(node => { node.scrollTop = node.scrollHeight; });
    await shot('three-bottom');
    if (!before) {
      const actions = page.locator('.entry-dialog-actions');
      const actionBox = await actions.boundingBox(), dialogBox = await page.locator('#entry-dialog').boundingBox();
      assert.ok(actionBox.y >= dialogBox.y && actionBox.y + actionBox.height <= dialogBox.y + dialogBox.height, `${name}: actions reachable in a tall question`);
      await page.keyboard.press('ArrowDown'); await page.keyboard.press('Enter');
      assert.equal(await page.locator('.entry-dialog-question').first().locator('.active .entry-dialog-option-label').textContent(), 'Only writer buttons');
      assert.equal(await page.locator('.entry-dialog-actions button').first().isDisabled(), true);
      await page.locator('.entry-dialog-question').nth(1).getByRole('button', { name: 'Only Later', exact: false }).click();
      await page.locator('.entry-dialog-question').nth(2).getByRole('button', { name: 'Wait', exact: false }).click();
      await page.keyboard.press('Enter');
      await page.locator('#entry-dialog').waitFor({ state: 'hidden' });
      assert.equal(Object.keys(commands.filter(c => c.type === 'dialog').at(-1).value).length, 3);
    } else await close();
    await open('confirm', { message: 'This command will remove the old scratch folder. Only the folder named here is affected.' }, 'pi');
    await shot('permission');
    if (!before) { await page.keyboard.press('ArrowDown'); await page.keyboard.press('Enter'); await page.locator('#entry-dialog').waitFor({ state: 'hidden' }); assert.equal(commands.filter(c => c.type === 'dialog').at(-1).confirmed, false); }
    else await close();
    await open('confirm', { message: 'Keep the unfinished piece?' });
    await shot('confirm'); await close();
    if (!before) assert.equal(commands.filter(c => c.type === 'dialog').at(-1).cancelled, true, 'Esc sends cancellation');
    await context.close();
    console.log(`ok: ${name}`);
  }
  assert.deepEqual(errors, []);
} finally { await browser.close(); }
