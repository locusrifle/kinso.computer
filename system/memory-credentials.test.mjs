import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { credentialValues, redactor } from './memory.mjs';
test('Claude config model caches are metadata, not secrets; credential values and key shapes still redact', async t => {
 const dir = await mkdtemp(join(tmpdir(), 'credential-models-')); t.after(() => rm(dir, { recursive: true, force: true }));
 const secret = 'fixture-' + '9'.repeat(30), shaped = 'sk-' + 'x'.repeat(40);
 await writeFile(join(dir, '.claude.json'), JSON.stringify({ clientDataCacheSlots: { 'bi1-0123456789abcdef': { model: 'claude-opus-5', token: secret } }, cachedGrowthBookFeatures: { tengu_tool_search_unsupported_models: ['claude-fable-5-1'] }, oauth: { accessToken: shaped } }));
 const redact = redactor(await credentialValues(dir));
 assert.equal(redact('claude-opus-5 claude-fable-5-1'), 'claude-opus-5 claude-fable-5-1'); assert.equal(redact(secret), '[redacted]'); assert.equal(redact(shaped), '[redacted]');
 await writeFile(join(dir, 'auth.json'), JSON.stringify({ password: 'claude-opus-5' }));
 assert.equal(redactor(await credentialValues(dir))('claude-opus-5'), '[redacted]', 'no global model whitelist');
});

test('a credential-file allowlist skips public catalogs without exempting model-shaped credentials', async t => {
 const dir = await mkdtemp(join(tmpdir(), 'credential-pi-')); t.after(() => rm(dir, { recursive: true, force: true }));
 await writeFile(join(dir, 'settings.json'), JSON.stringify({ defaultModel: 'gpt-6.1-sol' }));
 await writeFile(join(dir, 'models-store.json'), JSON.stringify({ model: 'gpt-6.1-sol' }));
 await writeFile(join(dir, 'auth.json'), JSON.stringify({ token: 'fixture-secret-1234567890' }));
 const files = ['auth.json', 'models.json'];
 const redact = redactor(await credentialValues(dir, files));
 assert.equal(redact('gpt-6.1-sol'), 'gpt-6.1-sol'); assert.equal(redact('fixture-secret-1234567890'), '[redacted]');
 await writeFile(join(dir, 'auth.json'), JSON.stringify({ token: 'gpt-6.1-sol' }));
 assert.equal(redactor(await credentialValues(dir, files))('gpt-6.1-sol'), '[redacted]', 'no global model whitelist');
});

test('model-shaped credentials anywhere inside caches remain learned secrets', async t => {
 const dir = await mkdtemp(join(tmpdir(), 'credential-cache-')); t.after(() => rm(dir, { recursive: true, force: true }));
 for (const key of ['clientDataCacheSlots', 'cachedGrowthBookFeatures', 'cachedExperimentData']) {
  for (const field of ['password', 'token', 'accessToken', 'unknown']) {
   for (const value of [{ [field]: 'claude-opus-5' }, { nested: { [field]: 'claude-opus-5' } }]) {
    await writeFile(join(dir, '.claude.json'), JSON.stringify({ [key]: { 'bi1-0123456789abcdef': { model: 'claude-sonnet-5', ...value } } }));
    assert.equal(redactor(await credentialValues(dir))('claude-opus-5'), '[redacted]', `${key}/${field}`);
   }
  }
 }
 await writeFile(join(dir, '.claude.json'), JSON.stringify({ cachedExperimentData: { tengu_lucky_cerf: { value: ['claude-opus-5'], password: 'claude-sonnet-5' } }, cachedGrowthBookFeatures: { tengu_lucky_cerf: ['claude-fable-5-1'] } }));
 const redact = redactor(await credentialValues(dir));
 assert.equal(redact('claude-opus-5 claude-fable-5-1'), 'claude-opus-5 claude-fable-5-1');
 assert.equal(redact('claude-sonnet-5'), '[redacted]');
});
