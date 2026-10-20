// How imperfect's window draws (desktop/electron/gpu.mjs): ANGLE on Vulkan
// only on AMD, and only where Electron's Vulkan loader will find RADV.
import assert from 'node:assert/strict';
import test from 'node:test';
import { angleBackend } from '../../../../desktop/electron/gpu.mjs';

const NIX_RADV = '/run/opengl-driver/share/vulkan/icd.d/radeon_icd.x86_64.json';

function machine({ nodes = { renderD128: '0x1002' }, icds = {}, env = {}, platform = 'linux' } = {}) {
  const tree = { '/sys/class/drm': ['card1', ...Object.keys(nodes)], ...icds };
  const list = dir => { if (!tree[dir]) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); return tree[dir]; };
  const read = file => {
    const node = Object.keys(nodes).find(name => file === `/sys/class/drm/${name}/device/vendor`);
    if (!node) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    return `${nodes[node]}\n`;
  };
  return { platform, env, home: '/home/me', list, read };
}

test('AMD with RADV where the loader looks draws through Vulkan', () => {
  assert.equal(angleBackend(machine({ icds: { '/usr/share/vulkan/icd.d': ['radeon_icd.x86_64.json'] } })), 'vulkan');
});

test('RADV named before Electron starts (NixOS, by imperfect-open) draws through Vulkan', () => {
  assert.equal(angleBackend(machine({ env: { VK_ADD_DRIVER_FILES: NIX_RADV } })), 'vulkan');
});

test('RADV the loader cannot find leaves Chromium its own choice', () => {
  assert.equal(angleBackend(machine({ icds: { '/run/opengl-driver/share/vulkan/icd.d': ['radeon_icd.x86_64.json'] } })), null);
  assert.equal(angleBackend(machine({
    env: { VK_DRIVER_FILES: '/usr/share/vulkan/icd.d/intel_icd.x86_64.json' },
    icds: { '/usr/share/vulkan/icd.d': ['radeon_icd.x86_64.json', 'intel_icd.x86_64.json'] },
  })), null);
});

test('other GPUs, a missing render node and other systems leave Chromium its own choice', () => {
  const icds = { '/usr/share/vulkan/icd.d': ['radeon_icd.x86_64.json'] };
  assert.equal(angleBackend(machine({ nodes: { renderD128: '0x8086' }, icds })), null);
  assert.equal(angleBackend(machine({ nodes: { renderD129: '0x1002', renderD128: '0x8086' }, icds })), null);
  assert.equal(angleBackend(machine({ nodes: {}, icds })), null);
  assert.equal(angleBackend(machine({ platform: 'darwin', icds })), null);
});
