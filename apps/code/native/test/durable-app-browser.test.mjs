// Real app server, tab host, Durable SQLite adapter and shared MCP tools.
// Only the provider and Claude SDK query are fake; all homes/ports are private.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { createTabHost } from '../tabs.mjs';
import { createClaudeRuntime } from '../claude-runtime.mjs';
import { createGueyServer } from '../../../../system/server.mjs';
import { launchChromium } from '../../../../tools/test-browser.mjs';
import { fixture, answer, until } from './durable-fixture.mjs';
import { PNG } from './fixtures/harness-page.mjs';

function claudeQuery() {
  let wake, ended = false;
  const frames = [];
  return ({ prompt }) => {
    void (async () => { for await (const _input of prompt) {
      frames.push({ type: 'assistant', session_id: 'claude-fixture', message: { content: [{ type: 'text', text: 'Claude contract answer.' }] } },
        { type: 'result', subtype: 'success', session_id: 'claude-fixture', usage: { input_tokens: 1, output_tokens: 1 } });
      wake?.();
    } })();
    return {
      async *[Symbol.asyncIterator]() { while (!ended) { if (frames.length) yield frames.shift(); else await new Promise(r => { wake = r; }); } },
      close() { ended = true; wake?.(); }, interrupt: async () => {}, supportedModels: async () => [],
      setModel: async () => {}, applyFlagSettings: async () => {}, setPermissionMode: async () => {},
    };
  };
}

test('isolated app uses Durable for send, steer/edit/abort, questions, read/show, import, reconnect and persisted restart; Claude stays independent', { timeout: 120_000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'durable-app-browser-'));
  let app, browser, current, release;
  const runtimes = [];
  const stage = text => { console.error(`[durable app] ${text}`); t.diagnostic(text); };
  t.after(async () => {
    stage('cleanup'); release?.(); await browser?.close();
    for (const tab of app?.runtime.snapshot().tabs || []) {
      stage(`retiring fixture ${tab.agent} ${tab.id}`);
      await app.runtime.command({ type: 'tab-close', tabId: tab.id, closeConfirmed: true }).catch(() => {});
    }
    await app?.close();
    for (const runtime of runtimes) await runtime.close();
    await rm(dir, { recursive: true, force: true });
  });
  const calls = [];
  const respond = async (model, request, _count, options) => {
    calls.push(request);
    const user = request.messages.findLast(m => m.role === 'user');
    const text = typeof user?.content === 'string' ? user.content : user?.content?.filter(b => b.type === 'text').map(b => b.text).join('');
    const last = request.messages.at(-1);
    if (text === 'hold') {
      await new Promise(resolve => { release = resolve; options.signal.addEventListener('abort', resolve, { once: true }); });
      return answer(model, [{ type: 'text', text: 'Held answer.' }], options.signal.aborted ? 'aborted' : 'stop');
    }
    if (text === 'question' && last.role !== 'toolResult') return answer(model, [{ type: 'toolCall', id: 'question', name: 'AskUserQuestion', arguments: { questions: [{ question: 'Which way?', header: 'Way', options: [{ label: 'Left' }, { label: 'Right' }] }] } }], 'toolUse');
    if (text === 'picture') {
      if (last.role !== 'toolResult') return answer(model, [{ type: 'toolCall', id: 'read-picture', name: 'read', arguments: { path: join(dir, 'picture.png') } }], 'toolUse');
      if (last.toolName === 'read') {
        assert.ok(last.content.some(b => b.type === 'image'), 'actual read returns a picture to the provider');
        return answer(model, [{ type: 'toolCall', id: 'show-picture', name: 'mcp__imperfect__show', arguments: { path: join(dir, 'picture.png') } }], 'toolUse');
      }
      assert.equal(last.toolName, 'mcp__imperfect__show');
      assert.ok(last.content.some(b => b.type === 'image'), 'shared MCP show returns the picture too');
    }
    return answer(model, [{ type: 'text', text: `Answer: ${text}` }]);
  };
  await writeFile(join(dir, 'picture.png'), PNG);
  const sm = SessionManager.create(dir, join(dir, 'legacy'));
  sm.appendMessage({ role: 'user', content: 'Original imported words.', timestamp: 1 });
  sm.appendMessage(answer({ api: 'openai-codex-responses', provider: 'openai-codex', id: 'gpt-6.1-sol' }, [{ type: 'text', text: 'Original imported answer.' }]));
  sm.appendSessionInfo('Import fixture');
  const original = await readFile(sm.getSessionFile());
  const start = async () => {
    const host = await createTabHost({ cwd: dir, stateDir: join(dir, 'tabs'), firstTab: 'pi', claudeAvailable: () => true,
      createRuntime: async options => {
        try {
          const f = await fixture(t, { dir, sessionPath: options.sessionPath, respond });
          current = f.runtime; runtimes.push(current); return current;
        } catch (error) { console.error('Fixture runtime creation failed:', error); throw error; }
      },
      createClaudeRuntime: options => createClaudeRuntime({ ...options, cwd: dir, queryImpl: claudeQuery(), authImpl: () => 'fixture-only', accountInfoImpl: async () => ({ apiProvider: 'firstParty', tokenSource: 'claude.ai', apiKeySource: 'none' }), sessionMessagesImpl: async () => [] }),
      listPiSessions: async () => [{ id: sm.getSessionId(), path: sm.getSessionFile(), cwd: dir, name: 'Import fixture', modified: Date.now(), agent: 'pi' }], listClaudeSessions: async () => [],
    });
    app = await createGueyServer({ cwd: dir, port: 0, pagePort: 0, stateDir: join(dir, 'server'), sessionToken: 'isolated-fixture-only', runtime: host,
      machines: { self: async () => 'Fixture', selfId: async () => 'fixture', origins: async () => [], list: async () => [{ id: 'fixture', name: 'Fixture', self: true, reachable: true }], peer: async () => null },
      browser: { sockets: async () => [], open: async () => { throw new Error('This fixture must never open a desktop browser'); } },
    });
    return `http://127.0.0.1:${(await app.listen()).port}/`;
  };
  let url = await start();
  browser = await launchChromium({ headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.setDefaultTimeout(10_000);
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.route('**/*', route => /^https?:\/\/(127\.0\.0\.1|localhost):/.test(route.request().url()) ? route.continue() : route.abort());
  const input = page.locator('#entry-input');
  const send = async text => { await input.fill(text); await input.press('Enter'); };
  const shown = text => page.locator('#entry-output').getByText(text, { exact: true }).waitFor();
  await page.goto(url); await input.waitFor();
  assert.equal(await page.locator('#entry-terminal.focus-layout').count(), 1, 'the real browser app starts in the shared desktop layout');
  await send('hello'); await shown('Answer: hello'); stage('created SQLite conversation and sent through the browser');
  assert.equal(current.snapshot().source, 'pi'); assert.match(current.snapshot().sessionFile, /\.sqlite$/);
  await send('hold'); await until(() => current.snapshot().busy && Boolean(release));
  await send('queued original'); await page.locator('.entry-queue-line').filter({ hasText: 'queued original' }).waitFor();
  await page.locator('.entry-queue-line').click();
  await page.waitForFunction(() => document.querySelector('#entry-input').value === 'queued original');
  await send('edited steering'); await page.locator('.entry-queue-line').filter({ hasText: 'edited steering' }).waitFor();
  release(); await shown('Answer: edited steering'); stage('steered and edited the Durable inbox through the browser');
  assert.ok(!current.snapshot().messages.some(m => m.role === 'user' && JSON.stringify(m.content).includes('queued original')));
  release = null; await send('hold'); await until(() => Boolean(release));
  await send('withdrawn words'); await page.locator('.entry-queue-line').waitFor();
  await input.press('Control+c'); await until(() => !current.snapshot().busy);
  await page.waitForFunction(() => document.querySelector('#entry-input').value.includes('withdrawn words'));
  assert.equal(current.snapshot().queue.items.length, 0); await input.fill(''); stage('abort returned withdrawn steering to the composer');
  await send('question'); await page.getByRole('button', { name: 'Right', exact: true }).click();
  await page.locator('.entry-dialog-actions button').first().click(); await shown('Answer: question');
  assert.match(JSON.stringify(current.snapshot().messages.find(m => m.toolName === 'AskUserQuestion')), /Right/); stage('answered an actual tool question through the browser');
  await send('picture'); await shown('Answer: picture');
  await page.waitForFunction(() => [...document.querySelectorAll('#entry-output img')].some(img => img.complete && img.naturalWidth > 0));
  stage('actual read and shared MCP show returned image blocks and the browser decoded an image');
  const before = current.snapshot(), history = before.sessionFile;
  // A fresh transport must hydrate committed state, not execute a new turn.
  const count = calls.length; await page.reload(); await shown('Answer: picture'); assert.equal(calls.length, count);
  await app.close(); app = null; url = await start();
  await page.goto(url); await shown('Answer: picture');
  assert.equal(current.snapshot().sessionFile, history); assert.deepEqual(current.snapshot().messages, before.messages); assert.equal(calls.length, count); stage('reconnected and restarted persisted SQLite history without another provider call');
  await page.getByRole('button', { name: 'History', exact: true }).click();
  await page.locator('.sidebar-past .session-rail-open').filter({ hasText: 'Import fixture' }).click();
  try { await shown('Original imported answer.'); }
  catch (error) { console.error('Import UI:', await page.locator('body').innerText()); throw error; }
  // Transcript hydration can precede the new view's captured execution proof.
  // As with reconnect/upload checks, wait for that proof before submitting.
  await page.waitForFunction(() => document.querySelector('#entry-output').dataset.fresh === 'fresh');
  await send('continued import');
  try { await shown('Answer: continued import'); }
  catch (error) {
    console.error('Import continuation diagnostics:', JSON.stringify({ runtime: current.snapshot(), host: app.runtime.snapshot(), calls: calls.length,
      page: await page.evaluate(() => ({ text: document.body.innerText, draft: document.querySelector('#entry-input').value, fresh: document.querySelector('#entry-output').dataset.fresh })) }));
    throw error;
  }
  assert.deepEqual(await readFile(sm.getSessionFile()), original); stage('imported and continued JSONL without changing its original bytes');
  // The untouched Claude adapter still crosses the same app/transport boundary.
  const claude = await app.runtime.command({ type: 'tab-new', agent: 'claude', model: null });
  await page.locator(`[data-tab-id="${claude.id}"] .session-rail-open`).click();
  await send('Claude fixture prompt'); await shown('Claude contract answer.');
  assert.equal(app.runtime.snapshot(claude.id).source, 'claude'); stage('unchanged Claude adapter answered through the same app UI');
  assert.deepEqual(errors, []);
});
