import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);
const root = fileURLToPath(new URL('../../../../', import.meta.url));
const subprocess = (args, env = {}) => {
  const environment = { ...process.env, ...env };
  delete environment.NODE_TEST_CONTEXT;
  return exec(process.execPath, args, { cwd: root, env: environment, timeout: 30_000, maxBuffer: 2 * 1024 * 1024 });
};

// These files used to start listening before launch rejected, leaving the
// runner pending for ~120 seconds. Exercise their real imports in fresh Node
// processes: the executable check must happen before any fixture is opened.
for (const file of ['browser-placement-browser.test.mjs', 'streaming-browser.test.mjs', 'focus-opacity.test.mjs', 'surface-chrome.test.mjs']) {
  test(`missing Chromium fails promptly: ${file}`, { timeout: 60_000 }, async () => {
    const missing = '/nonexistent/imperfect-test-chromium';
    const result = await subprocess(['--test', `apps/code/native/test/${file}`], { CHROMIUM: missing })
      .then(value => ({ ...value, code: 0 }), error => error);
    assert.ok(!result.killed, 'subprocess must exit by itself, not hit the 30-second deadline');
    assert.equal(result.code, 1, `${result.stdout}\n${result.stderr}`);
    const output = `${result.stdout}\n${result.stderr}`;
    assert.ok(output.includes(`Chromium executable unavailable: ${missing}. Set CHROMIUM to an executable Chromium binary.`), output);
    assert.doesNotMatch(output, /Promise resolution is still pending|cancelledByParent/);
  });
}

// Import-time validation handles missing binaries. A valid binary can still
// fail at launch, newPage, navigation, mounting or readiness: all handles
// opened by the shared fixture must close, even if browser.close rejects.
for (const stage of ['launch', 'newPage', 'goto', 'evaluate', 'waitFor', 'close']) {
  test(`harness initialization cleans up after ${stage} failure`, { timeout: 60_000 }, async () => {
    // CHROMIUM names any executable: its launch is the mock below.
    const { stdout } = await subprocess(['--input-type=module', '--eval', `
      import assert from 'node:assert/strict';
      import { mock } from 'node:test';
      import { once } from 'node:events';
      import { WebSocket } from 'ws';
      import { chromium } from 'playwright';
      import { harnessFixture } from './apps/code/native/test/fixtures/harness-page.mjs';
      const stage = ${JSON.stringify(stage)};
      const failure = new Error('injected ' + stage);
      let closed = false, socket;
      const page = {
        on() {},
        async goto(url) {
          socket = new WebSocket(url.replace('http:', 'ws:'));
          await once(socket, 'open');
          if (stage === 'goto') throw failure;
        },
        async evaluate() { if (stage === 'evaluate') throw failure; },
        async waitForFunction() {},
        locator() { return { first() { return this; }, async waitFor() { throw failure; } }; },
      };
      mock.method(chromium, 'launch', async () => {
        if (stage === 'launch') throw failure;
        return {
          async newPage() { if (stage === 'newPage') throw failure; return page; },
          async close() { closed = true; if (stage === 'close') throw failure; },
        };
      });
      await assert.rejects(harnessFixture({ messages: [{ role: 'assistant', content: 'Ready' }] }), error => error === failure);
      assert.equal(closed, stage !== 'launch', 'an acquired browser was closed');
      if (socket && socket.readyState !== WebSocket.CLOSED) await once(socket, 'close');
      mock.restoreAll();
      console.log('cleanup complete');
      // No process.exit(): leaked HTTP/WebSocket handles must fail the parent's deadline.
    `], { CHROMIUM: process.execPath });
    assert.match(stdout, /cleanup complete/);
  });
}

test('test launcher applies the configured timeout to pages and contexts', async () => {
  const { stdout } = await subprocess(['--input-type=module', '--eval', `
    import assert from 'node:assert/strict';
    import { mock } from 'node:test';
    import { chromium } from 'playwright';
    import { launchChromium, TEST_TIMEOUT } from './tools/test-browser.mjs';
    const deadlines = [];
    const make = () => ({ setDefaultTimeout(value) { deadlines.push(value); } });
    mock.method(chromium, 'launch', async () => ({ async newPage() { return make(); }, async newContext() { return make(); }, async close() {} }));
    const browser = await launchChromium();
    try {
      await browser.newPage(); await browser.newContext();
      assert.equal(TEST_TIMEOUT, 1234);
      assert.deepEqual(deadlines, [1234, 1234]);
    } finally { await browser.close(); mock.restoreAll(); }
    console.log('timeouts applied');
  `], { CHROMIUM: process.execPath, IMPERFECT_TEST_TIMEOUT: '1234' });
  assert.match(stdout, /timeouts applied/);
});

test('the shared real fixture settles its entrance without disabling later animations', { timeout: 30_000 }, async t => {
  const { harnessFixture } = await import('./fixtures/harness-page.mjs');
  const fixture = await harnessFixture({ messages: [{ role: 'assistant', content: [{ type: 'text', text: 'Ready' }] }] });
  t.after(() => fixture.close());
  assert.equal(await fixture.page.locator('#entry-output .gui-assistant').isVisible(), true);
  assert.equal(await fixture.page.evaluate(() => {
    const animation = document.body.animate([{ opacity: 1 }, { opacity: 0.9 }], { duration: 10_000 });
    const running = animation.playState === 'running';
    animation.cancel();
    return running;
  }), true);
});
