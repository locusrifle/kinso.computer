// How pages draw. Chromium on Linux runs ANGLE on the GPU's OpenGL driver.
// On AMD that is radeonsi, which on a Radeon 860M (Mesa 26.1) faults on
// WebGL games such as Bloxd: the GPU resets, Chromium's GPU process dies and
// the game's tab with it. RADV, the same GPU's Vulkan driver, draws them
// cleanly, so on AMD ANGLE uses Vulkan, but only where Electron's own Vulkan
// loader will find RADV: asked for Vulkan without it, Chromium gives up the
// GPU entirely. NixOS keeps its drivers in /run/opengl-driver, out of the
// loader's sight; imperfect-open names RADV there before Electron starts,
// since Chromium's GPU process inherits the environment it began with.
import { readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';

const AMD = '0x1002';
const RADV = /^radeon_icd\..*\.json$/;

// Where the Vulkan loader looks for drivers by itself.
function vulkanDirs(env, home) {
  const config = (env.XDG_CONFIG_DIRS || '/etc/xdg').split(':');
  const data = (env.XDG_DATA_DIRS || '/usr/local/share:/usr/share').split(':');
  return [...config, '/etc', env.XDG_DATA_HOME || join(home, '.local/share'), ...data, '/usr/local/share', '/usr/share']
    .filter(Boolean).map(dir => join(dir, 'vulkan/icd.d'));
}

// 'vulkan' for Chromium's --use-angle, or null to leave Chromium's choice.
export function angleBackend({ platform = process.platform, env = process.env, home = homedir(),
  list = dir => readdirSync(dir), read = file => readFileSync(file, 'utf8') } = {}) {
  if (platform !== 'linux') return null;
  const quiet = (fn, fallback) => { try { return fn(); } catch { return fallback; } };
  // The first render node is the one Chromium draws on.
  const node = quiet(() => list('/sys/class/drm'), [])
    .filter(name => /^renderD\d+$/.test(name))
    .sort((a, b) => Number(a.slice(7)) - Number(b.slice(7)))[0];
  if (!node || quiet(() => read(`/sys/class/drm/${node}/device/vendor`), '').trim() !== AMD) return null;
  const named = [env.VK_DRIVER_FILES, env.VK_ICD_FILENAMES, env.VK_ADD_DRIVER_FILES].filter(Boolean).join(':').split(':');
  if (named.some(file => RADV.test(basename(file)))) return 'vulkan';
  // These two replace the loader's own search; RADV is not among them.
  if (env.VK_DRIVER_FILES || env.VK_ICD_FILENAMES) return null;
  return vulkanDirs(env, home).some(dir => quiet(() => list(dir), []).some(name => RADV.test(name))) ? 'vulkan' : null;
}
