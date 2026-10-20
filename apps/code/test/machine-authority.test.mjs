import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { normalizeConfig } from '../../../system/machine.mjs';

test('authority enrollment keeps a stable id', () => {
  const config = normalizeConfig({ authority: { id: 'ng6iZuhwg721CNTRL', name: 'desktop' } });
  assert.equal(config.authority.id, 'ng6iZuhwg721CNTRL');
});

test('a display name alone never silently enrolls an authority', () => {
  assert.equal(normalizeConfig().authority.id, '');
  const config = normalizeConfig({ authority: { id: '../desktop', name: 'desktop' } });
  assert.equal(config.authority.id, '');
});

test('authority may name an explicit tailnet SSH repository and a different login', () => {
  for (const gitUrl of ['ssh://vaita@desktop/home/vaita/imperfect', 'ssh://desktop/home/vaita/imperfect',
    'ssh://vaita@desktop.tail123.ts.net/home/vaita/imperfect', 'ssh://vaita@100.64.0.4/home/vaita/imperfect']) {
    assert.equal(normalizeConfig({ authority: { id: 'pc', gitUrl } }).authority.gitUrl, gitUrl);
  }
  for (const gitUrl of ['https://buyer:FAKE@store.invalid/repo', 'vaita@desktop:imperfect',
    'ssh://vaita:password@desktop/home/vaita/imperfect', 'ssh://desktop.example.com/repo',
    'ssh://vaita@desktop:22/repo', 'ssh://-oProxyCommand@desktop/repo',
    'ssh://desktop/repo;touch', 'ssh://desktop/repo%20x', 'ssh://desktop/repo?x',
    'ssh://desktop/home/../repo', 'ssh://desktop//repo', 'ssh://127.0.0.1/repo', '', null]) {
    assert.throws(() => normalizeConfig({ authority: { id: 'pc', gitUrl } }), /authority.gitUrl must be an SSH URL/);
  }
  assert.equal(normalizeConfig({ authority: { gitUrl: 'ssh://desktop/repo' } }).authority.id, '', 'a URL is not enrollment');
});

test('a hosted computer says so in its settings and stands alone without an authority', async () => {
  assert.equal(normalizeConfig().hosted, false, 'an ordinary install is not hosted');
  assert.equal(normalizeConfig({ hosted: 'yes' }).hosted, false);
  assert.equal(normalizeConfig({ hosted: true }).hosted, true);
  // Hosted, it stands alone: start.mjs never looks for other computers.
  assert.match(await readFile(new URL('../../../system/start.mjs', import.meta.url), 'utf8'), /const machines = config\.hosted && !config\.authority\.id \? solitaryMachines\(\) : createMachines\(\);/);
});
