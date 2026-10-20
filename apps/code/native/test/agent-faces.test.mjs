import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { modelText, modelLabel } from '../public/js/agent-faces.js';

const HARNESS = new URL('../public/js/harness.js', import.meta.url);

// The status bar names the model the same way whichever harness runs it, and
// says nothing when there is none rather than repeating the harness's name.
test('a model is named by its display name, or for Claude by the model its id names', () => {
  assert.equal(modelText({ id: 'gpt-6-astra', name: 'GPT-6 Astra' }), 'GPT-6 Astra');
  assert.equal(modelText({ id: 'default', resolvedModel: 'claude-opus-5' }), 'Opus 5');
  assert.equal(modelText({ id: 'opus', name: 'Opus', resolvedModel: 'claude-opus-5-5' }), 'Opus 5.5', '"Opus" alone does not say which');
  assert.equal(modelText({ id: 'claude-haiku-4-5-20251001' }), 'Haiku 4.5');
  assert.equal(modelLabel('claude-fable-5-1'), 'Fable 5.1');
  assert.equal(modelLabel('GLM 5.3 Flash'), 'GLM 5.3 Flash');
  assert.equal(modelText(null), '');
});

test('imperfect has no slash commands: the model is picked in its own box', async () => {
	const source = await readFile(HARNESS, 'utf8');
	assert.doesNotMatch(source, /slashMenu|const COMMANDS/);
	assert.match(source, /modelName\.onclick = \(\) => \{ chooseModel\(\)/);
});
