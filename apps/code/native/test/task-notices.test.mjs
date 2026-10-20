import { test } from 'node:test';
import assert from 'node:assert/strict';
import { taskNotices } from '../public/js/gui-transcript.js';

// What Claude Code hands the agent when a background task ends: shown as one
// quiet line each, never as the raw block.
const notice = (status, summary) => `<task-notification>\n<task-id>bn197jn3b</task-id>\n<tool-use-id>toolu_01</tool-use-id>\n<output-file>/private/tmp/x.output</output-file>\n<status>${status}</status>\n<summary>${summary}</summary>\n</task-notification>`;

test('a background task\'s end is read as its status, its name and, failed, its exit code', () => {
  assert.deepEqual(taskNotices(notice('failed', 'Background command "Wait for the laptop test runs to finish" failed with exit code 144')), [
    { status: 'failed', name: 'Wait for the laptop test runs to finish', exit: '144', summary: 'Background command "Wait for the laptop test runs to finish" failed with exit code 144' },
  ]);
  const [done] = taskNotices(notice('completed', 'Background command "Run the tests" completed (exit code 0)'));
  assert.deepEqual([done.status, done.name], ['done', 'Run the tests']);
  assert.equal(taskNotices(notice('killed', 'Background command "Serve" was stopped'))[0].status, 'stopped');
  // Two at once are two lines; one without a quoted name keeps what it said.
  const both = taskNotices(`${notice('completed', 'Background agent finished the review')}\n\n${notice('completed', 'Background command "B" completed (exit code 0)')}`);
  assert.deepEqual(both.map(n => n.name), ['finished the review', 'B']);
});

test('a message that only mentions one, or says more besides, is the person\'s and stays as written', () => {
  assert.equal(taskNotices('run the tests'), null);
  assert.equal(taskNotices(`what does this mean?\n${notice('failed', 'Background command "X" failed with exit code 1')}`), null);
  assert.equal(taskNotices('the <task-notification> tag'), null);
  assert.equal(taskNotices(undefined), null);
});
