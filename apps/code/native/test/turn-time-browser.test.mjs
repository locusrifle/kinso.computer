// How a turn went and where the context was compacted, drawn as T3 Code
// draws them (gui-transcript.js, harness.js): under each answer how long the
// turn took and when it finished; while one works, how long so far; a rule
// across the conversation where it was compacted.
import test from 'node:test';
import assert from 'node:assert/strict';
import { harnessFixture } from './fixtures/harness-page.mjs';

const say = (role, text, at, extra = {}) => role === 'user'
  ? { role, content: text, timestamp: at }
  : { role, content: [{ type: 'text', text }], timestamp: at, ...extra };

test('each finished turn says how long it took and when, the one at work counts up, and a compaction is a rule with its counts', async () => {
  const t0 = Date.now() - 3_600_000, asked = Date.now() - 42_000;
  const messages = [
    say('user', 'make the rows square', t0),
    // Pi times an answer from when it began: it ended 93s later.
    say('assistant', 'Done.', t0 + 40_000, { durationMs: 93_000 }),
    // A compaction after a turn is not part of it.
    { role: 'compactionSummary', tokensBefore: 392737, tokensAfter: 6298, timestamp: t0 + 200_000 },
    say('user', 'and the plus?', t0 + 400_000),
    say('assistant', 'Thin now.', t0 + 404_000),
    say('user', 'now time the turns', asked),
  ];
  const f = await harnessFixture({ desk: { mac: true }, messages: [say('user', 'hi', t0), say('assistant', 'hello', t0 + 1000)], viewport: { width: 1280, height: 790 } });
  const { page } = f;
  const lines = () => page.$$eval('#entry-output :is(.gui-turn-time, .gui-compaction, .gui-message)', nodes => nodes.map(n => n.matches('.gui-message') ? n.textContent.trim() : `[${n.textContent}]`));
  try {
    f.push({ ...f.tab, messages, busy: true, streaming: true });
    await page.waitForFunction(() => document.querySelector('#entry-output .gui-turn-time.working'));
    const working = await lines();
    assert.deepEqual(working.slice(0, 6), ['make the rows square', 'Done.', `[Worked for 2m 13s · ${await page.evaluate(at => new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }), t0 + 133_000)}]`,
      '[Context compacted 393k → 6k tokens]', 'and the plus?', 'Thin now.']);
    assert.match(working[6], /^\[Worked for 4\.0s · /);
    assert.equal(working[7], 'now time the turns');
    assert.match(working[8], /^\[Locus is typing… · 4[2-9]s\]$/, 'counts from when it was asked');
    const first = working[8];
    await page.waitForFunction(first => document.querySelector('#entry-output .gui-turn-time.working').textContent !== first, first, { timeout: 3000 });

    f.push({ ...f.tab, messages, busy: true, streaming: true, operation: 'compacting' });
    await page.waitForFunction(() => document.querySelector('#entry-output .gui-compaction.active')?.textContent === 'Compacting context');
    assert.equal(await page.locator('#entry-output .gui-turn-time.working').count(), 0, 'compacting says so instead');

    const done = [...messages, say('assistant', 'Each turn is timed.', asked + 30_000)];
    f.push({ ...f.tab, messages: done, busy: false, streaming: false, operation: null });
    await page.waitForFunction(() => !document.querySelector('#entry-output :is(.gui-turn-time.working, .gui-compaction.active)'));
    assert.match((await lines()).at(-1), /^\[Worked for 30s · /, 'the turn just done, under its answer');

    // Asked again: the finished turn keeps its line under its answer.
    const next = [...done, say('user', 'thanks', Date.now())];
    f.push({ ...f.tab, messages: next, busy: true, streaming: true });
    await page.waitForFunction(() => document.querySelector('#entry-output .gui-turn-time.working'));
    const after = await lines();
    assert.deepEqual(after.slice(-4).map(line => line.replace(/ · .*\]$/, ']')), ['Each turn is timed.', '[Worked for 30s]', 'thanks', '[Locus is typing…]']);
    assert.match(after.at(-1), /^\[Locus is typing… · [0-2]s\]$/);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

// Keyed like T3 Code's timeline: what is on screen is the same node through
// every update, whichever part of the conversation it is in.
test('a message is drawn once: new turns and whole snapshots keep its nodes', async () => {
  const t0 = Date.now() - 600_000;
  const first = [say('user', 'one', t0), say('assistant', 'first answer', t0 + 5_000)];
  const f = await harnessFixture({ desk: { mac: true }, messages: first, viewport: { width: 1280, height: 790 } });
  const { page } = f;
  try {
    await page.evaluate(() => document.querySelectorAll('#entry-output > *').forEach((node, i) => { node.kept = i; }));
    const second = [...first, say('user', 'two', t0 + 60_000)];
    f.push({ ...f.tab, messages: second, busy: true, streaming: true });
    await page.waitForFunction(() => document.querySelector('#entry-output .gui-turn-time.working'));
    f.push({ ...f.tab, messages: [...second, say('assistant', 'second answer', t0 + 70_000)], busy: false, streaming: false });
    await page.waitForFunction(() => !document.querySelector('#entry-output .gui-turn-time.working') && document.querySelector('#entry-output').textContent.includes('second answer'));
    const kept = await page.$$eval('#entry-output > *', nodes => nodes.map(node => [node.textContent, node.kept ?? null]));
    assert.deepEqual(kept.slice(0, 3).map(([, mark]) => mark), [0, 1, 2], `the first turn's nodes stayed: ${JSON.stringify(kept)}`);
    assert.deepEqual(kept.map(([text]) => text.replace(/ · .*$/, '')), ['one', 'first answer', 'Worked for 5.0s', 'two', 'second answer', 'Worked for 10s']);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});
