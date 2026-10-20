import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = name => readFile(new URL(`../app/src/main/java/computer/imperfect/code/${name}.kt`, import.meta.url), 'utf8');
const between = (text, from, to) => text.slice(text.indexOf(from), text.indexOf(to, text.indexOf(from) + from.length));

// Back in front, the page is told at once rather than left to notice, and a
// page that cannot answer is loaded again instead of needing the app killed.
test('the app tells its page it is back, and reloads one that does not answer', async () => {
  const main = await source('MainActivity');
  const page = await readFile(new URL('../../apps/code/native/public/js/harness.js', import.meta.url), 'utf8');
  assert.match(page, /globalThis\.imperfectResume = /, 'the page listens for it');
  const onStart = between(main, 'override fun onStart()', 'override fun onStop()');
  assert.match(onStart, /if \(reached\) resumePage\(\)/);
  const resume = between(main, 'private fun resumePage()', 'private fun say(');
  assert.match(resume, /evaluateJavascript\("typeof imperfectResume === 'function'/);
  assert.match(resume, /watchdog\.postDelayed\(/);
  assert.match(resume, /console\.reload\(\)/);
  assert.match(main, /RESUME_ANSWER_MS = \d{4}L/);
  // Nothing waits on a window that is gone.
  assert.match(between(main, 'override fun onStop()', '}'), /watchdog\.removeCallbacksAndMessages\(null\)/);
  assert.match(between(main, 'override fun onDestroy()', '}'), /watchdog\.removeCallbacksAndMessages\(null\)/);
});

test('a page whose renderer dies is made again rather than taking the app down', async () => {
  const surfaces = await source('Surfaces');
  const gone = between(surfaces, 'override fun onRenderProcessGone', '}');
  assert.match(gone, /onGone\(\)/);
  assert.match(surfaces, /onRenderProcessGone\(view: WebView, detail: RenderProcessGoneDetail\): Boolean \{\n\s+onGone\(\)\n\s+return true/);
  assert.match(await source('MainActivity'), /onGone = \{ reached = false; recreate\(\) \}/);
});

test('the app shows the same loading bar as the page while it looks for the computer', async () => {
  const loading = await source('Loading');
  const main = await source('MainActivity');
  assert.match(loading, /DELAY_MS = 150L/, 'only after a moment, as the page does');
  assert.match(loading, /R\.color\.accent/);
  const code = loading.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
  assert.doesNotMatch(code, /ProgressBar|radius|Spinner/i, 'a bar with hard edges, not a spinner');
  assert.match(between(main, 'private fun reach()', 'override fun onNewIntent'), /loading\.begin\(\)/);
  assert.match(main, /onReady = \{[^}]*loading\.end\(\)/);
  assert.match(main, /onFailed = \{[^}]*loading\.end\(\)/);
});
