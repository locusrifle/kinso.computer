// Changing model never deletes what was typed. A model of the other harness
// opens a tab of its own (tabs.mjs), and the words in the input bar go with
// the person into it, whichever comes first: the answer or the new snapshot.
import test from 'node:test';
import assert from 'node:assert/strict';
import { harnessFixture } from './fixtures/harness-page.mjs';

const MESSAGES = [{ role: 'user', content: 'hello' }, { role: 'assistant', content: [{ type: 'text', text: 'hi' }] }];
const MODELS = [
  { provider: 'fixture', id: 'fixture', name: 'Fixture', engine: 'pi' },
  { provider: 'claude-agent', id: 'opus', name: 'Opus', engine: 'claude' },
];

async function pickOtherHarness(snapshotFirst) {
  const fixture = await harnessFixture({ messages: MESSAGES });
  const { page } = fixture;
  try {
    const claudeTab = { ...fixture.tab, agent: 'claude', sessionId: 'thread-b', model: { provider: 'claude-agent', id: 'opus' }, messages: [],
      tabs: [{ ...fixture.tab.tabs[0], focused: false }, { id: 'tab-b', sessionId: 'thread-b', focused: true, agent: 'claude', name: 'B', prompt: '', status: 'idle' }] };
    fixture.answer = command => {
      if (command.type === 'models') return MODELS;
      if (command.type === 'level') return { current: null, available: [] };
      if (command.type === 'model') {
        if (snapshotFirst) { fixture.push(claudeTab); return {}; }
        setTimeout(() => fixture.push(claudeTab), 50);
        return {};
      }
    };
    await page.locator('#entry-input').fill('half a thought');
    await page.locator('#entry-pi-label').click();
    await page.locator('#entry-dialog .entry-dialog-option', { hasText: 'Opus' }).click();
    await page.waitForFunction(() => harness.guiSnapshot().sessionId === 'thread-b');
    await page.waitForTimeout(100);
    assert.equal(await page.locator('#entry-input').inputValue(), 'half a thought', 'the words stay in the input bar');
    const stored = await page.evaluate(() => Object.entries(localStorage).filter(([key]) => key.startsWith('guey-draft:')).map(([key, value]) => [JSON.parse(key.slice(11))[1], value]));
    assert.deepEqual(stored.filter(([, value]) => value), [['thread-b', 'half a thought']], 'they moved to the new session, not copied');
    assert.deepEqual(fixture.errors, []);
  } finally { await fixture.close(); }
}

test('a model of the other harness keeps the typed words (answer first)', () => pickOtherHarness(false));
test('a model of the other harness keeps the typed words (snapshot first)', () => pickOtherHarness(true));

test('a model of the same harness leaves the words with their session', async () => {
  const fixture = await harnessFixture({ messages: MESSAGES });
  const { page } = fixture;
  try {
    fixture.answer = command => {
      if (command.type === 'models') return [...MODELS, { provider: 'fixture', id: 'other', name: 'Other', engine: 'pi' }];
      if (command.type === 'level') return { current: null, available: [] };
    };
    await page.locator('#entry-input').fill('half a thought');
    await page.locator('#entry-pi-label').click();
    await page.locator('#entry-dialog .entry-dialog-option', { hasText: 'Other' }).click();
    await page.waitForTimeout(100);
    assert.equal(await page.locator('#entry-input').inputValue(), 'half a thought');
    // A later switch to another session does not take the words along.
    fixture.push({ ...fixture.tab, sessionId: 'thread-b', messages: [], tabs: [{ ...fixture.tab.tabs[0], focused: false }, { id: 'tab-b', sessionId: 'thread-b', focused: true, agent: 'pi', name: 'B', prompt: '', status: 'idle' }] });
    await page.waitForFunction(() => harness.guiSnapshot().sessionId === 'thread-b');
    assert.equal(await page.locator('#entry-input').inputValue(), '');
    assert.deepEqual(fixture.errors, []);
  } finally { await fixture.close(); }
});
