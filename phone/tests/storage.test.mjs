import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// A page an agent shows plays in a frame of the phone's window, from its own
// computer's page origin; a game there keeps its saves only if the window
// lets pages store anything at all.
test('the phone lets pages agents show keep their saves', async () => {
  const surfaces = await readFile(new URL('../app/src/main/java/computer/imperfect/code/Surfaces.kt', import.meta.url), 'utf8');
  assert.match(surfaces, /domStorageEnabled = true/);
  assert.doesNotMatch(surfaces, /domStorageEnabled = false/);
});
