// Claude Code's sign-in on a Mac lives in the keychain; imperfect has to ask
// for the same item Claude Code itself uses (claude-auth.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { keychainService, secureStorageDir } from '../claude-auth.mjs';

test('the keychain item is Claude Code\'s own: unnamed for the terminal\'s sign-in, suffixed for a named folder', () => {
  assert.equal(keychainService(''), 'Claude Code-credentials');
  const folder = '/Users/noah/.imperfect/credentials/claude';
  assert.equal(keychainService(folder), `Claude Code-credentials-${createHash('sha256').update(folder).digest('hex').slice(0, 8)}`);
});

test('on a Mac imperfect shares the terminal\'s sign-in until one is made in imperfect', async t => {
  const home = await mkdtemp(join(tmpdir(), 'mac-claude-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const env = { HOME: home };
  assert.equal(secureStorageDir(env, false, true), '', 'the unnamed item, shared with Claude Code in Terminal');
  assert.equal(secureStorageDir(env, false, false), join(home, '.claude'), 'Linux names the folder, whose file both read');
  assert.equal(secureStorageDir({ ...env, CLAUDE_CONFIG_DIR: join(home, 'other') }, false, true), join(home, 'other'), 'a config folder the person chose is named');
  await mkdir(join(home, '.imperfect', 'credentials', 'claude'), { recursive: true });
  assert.equal(secureStorageDir(env, false, true), join(home, '.imperfect', 'credentials', 'claude'), 'a sign-in made in imperfect is its own');
});
