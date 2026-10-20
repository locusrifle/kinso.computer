import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { modelLine, newestOfEachLine } from '../public/js/model-lines.js';
import { modelText } from '../public/js/agent-faces.js';

// What the two harnesses list when both are signed in: Claude Code's ids and
// Pi's openai-codex names, as they arrive.
const claude = ['default', 'claude-opus-5-5', 'claude-opus-5', 'claude-opus-4-8', 'claude-opus-4-7', 'claude-opus-4-6', 'claude-sonnet-5-5', 'claude-sonnet-5', 'claude-sonnet-4-6', 'claude-fable-5-1', 'claude-fable-5', 'claude-haiku-4-5-20251001']
	.map(id => ({ engine: 'claude', provider: 'claude-agent', id, name: id, ...(id === 'default' ? { name: 'claude-opus-5-5', resolvedModel: 'claude-opus-5-5' } : {}) }));
const codex = [['gpt-5.6-sol', 'GPT-5.6 Sol'], ['gpt-6-sol', 'GPT-6 Sol'], ['gpt-6.1-sol', 'GPT-6.1 Sol'], ['gpt-5.6-luna', 'GPT-5.6 Luna'], ['gpt-6-luna', 'GPT-6 Luna'], ['gpt-6-astra', 'GPT-6 Astra'], ['gpt-5.6-terra', 'GPT-5.6 Terra'], ['gpt-5.5', 'GPT-5.5'], ['gpt-5.3-codex-spark', 'GPT-5.3 Codex Spark']]
	.map(([id, name]) => ({ engine: 'pi', provider: 'openai-codex', id, name }));
const names = list => list.map(modelText);

test('a line is the name without its version, and the version is compared as numbers', () => {
	assert.deepEqual(modelLine('GPT-6.1 Sol'), { line: 'gpt-# sol', version: [6, 1] });
	assert.deepEqual(modelLine('GPT-5.3 Codex Spark'), { line: 'gpt-# codex spark', version: [5, 3] });
	assert.deepEqual(modelLine('GPT-5.5'), { line: 'gpt-#', version: [5, 5] });
	assert.deepEqual(modelLine('Opus 4.8'), { line: 'opus #', version: [4, 8] });
	assert.deepEqual(modelLine('Claude Haiku 4.5 (latest)'), modelLine('Claude Haiku 4.5'));
	assert.deepEqual(modelLine('Opus'), { line: 'opus', version: null });
});

test('only the newest model of each line is offered', () => {
	assert.deepEqual(names(newestOfEachLine([...claude, ...codex], modelText)),
		['Opus 5.5', 'Opus 5.5', 'Sonnet 5.5', 'Fable 5.1', 'Haiku 4.5', 'GPT-6.1 Sol', 'GPT-6 Luna', 'GPT-6 Astra', 'GPT-5.6 Terra', 'GPT-5.5', 'GPT-5.3 Codex Spark']);
});

test('4.10 is newer than 4.9, and 5 than 4.8', () => {
	const list = ['Thing 4.9', 'Thing 4.10', 'Other 4.8', 'Other 5'].map((name, i) => ({ engine: 'pi', provider: 'p', id: String(i), name }));
	assert.deepEqual(names(newestOfEachLine(list, modelText)), ['Thing 4.10', 'Other 5']);
});

test('the model a session is on stays listed, however old', () => {
	const now = claude.find(m => m.id === 'claude-opus-4-7');
	const listed = newestOfEachLine([...claude, ...codex], modelText, m => m === now);
	assert.ok(listed.includes(now));
	assert.ok(!names(listed).includes('Opus 4.8'));
});

test('lines are per harness and provider: the same name elsewhere is its own line', () => {
	const list = [
		{ engine: 'pi', provider: 'openai-codex', id: 'gpt-6-sol', name: 'GPT-6 Sol' },
		{ engine: 'pi', provider: 'openrouter', id: 'openai/gpt-5.6-sol', name: 'GPT-5.6 Sol' },
		{ engine: 'pi', provider: 'openai-codex', id: 'gpt-5.6-sol', name: 'GPT-5.6 Sol' },
	];
	assert.deepEqual(newestOfEachLine(list, modelText).map(m => m.id), ['gpt-6-sol', 'openai/gpt-5.6-sol']);
});

test('a model whose name has no version is never hidden', () => {
	const list = [{ engine: 'claude', provider: 'claude-agent', id: 'opus', name: 'Opus' }, { engine: 'claude', provider: 'claude-agent', id: 'claude-opus-5', name: 'claude-opus-5' }];
	assert.equal(newestOfEachLine(list, modelText).length, 2);
});

test('the model box lists the newest of each line', async () => {
	const source = await readFile(new URL('../public/js/harness.js', import.meta.url), 'utf8');
	assert.match(source, /newestOfEachLine\(\[\.\.\.models\]\.sort\(claudeFirst\), modelText, isNow\)/);
});
