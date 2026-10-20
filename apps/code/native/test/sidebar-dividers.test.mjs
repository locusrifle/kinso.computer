import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const css = await readFile(new URL('../public/css/focus.css', import.meta.url), 'utf8');

test('shared group dividers add only the same half-pixel border as Usage', () => {
  const rule = css.match(/body\.imperfect \.session-rail-sidebar > \.sidebar-head:not\(:first-child\)\s*\{([^}]+)\}/g);
  assert.equal(rule?.length, 1, 'one shared rule, without brand or layout forks');
  const declaration = 'border-top: 0.5px solid var(--sep-strong);';
  assert.equal(rule[0].split('{')[1].replace('}', '').trim(), declaration, 'no added gaps, labels, icons, row styling or reorder');
  const usage = css.match(/body\.imperfect \.session-rail-foot > \.session-rail-usage\s*\{([^}]+)\}/)?.[1];
  assert.ok(usage?.includes(declaration), 'matches the existing Settings/Usage separator');
});
