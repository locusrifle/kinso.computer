import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const server = await readFile(new URL('../../../../system/server.mjs', import.meta.url), 'utf8');
const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');

const policy = server.match(/const POLICY = "([^"]+)"/)?.[1] ?? '';

test('the page obeys the policy the machine sends with it', () => {
  assert.ok(policy, 'no Content-Security-Policy found in server.mjs');
  const scriptSrc = policy.split(';').map(p => p.trim()).find(p => p.startsWith('script-src'));
  assert.equal(scriptSrc, "script-src 'self'", 'the policy changed; this test is about what it allows');

  // 'self' means files, not inline. An inline <script> in the page is not a
  // slower script, it is a script that never runs at all -- and nothing says
  // so out loud, which is how `?face=` sat broken looking like it had never
  // been wired. Every script the page loads has to come from a file.
  for (const [, attrs, body] of html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/g)) {
    assert.match(attrs, /\ssrc=/, `inline <script> in index.html: ${body.trim().slice(0, 60)}`);
    assert.equal(body.trim(), '', 'a <script src> should have no body');
  }
});

