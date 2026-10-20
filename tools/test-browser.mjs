// All test/check browsers are imperfect's own engine, the Electron its window
// is built on (imperfect-browser.mjs), or the machine's Chromium where CHROMIUM
// names one; never a bundled download.
// Check before fixtures open servers: launch rejection alone can leave a failed
// test's listening socket alive and make Node wait indefinitely for the file.
import { accessSync, constants, statSync } from 'node:fs';
import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { enginePath, launchImperfectBrowser } from './imperfect-browser.mjs';
import { lockCommand } from '../system/pulse-ledger.mjs';

export const engine = process.env.CHROMIUM ? 'chromium' : 'imperfect';
export const chromiumPath = process.env.CHROMIUM || enginePath;
try {
  accessSync(chromiumPath, constants.X_OK);
  if (!statSync(chromiumPath).isFile()) throw new Error('not a file');
} catch (error) {
  throw new Error(engine === 'chromium'
    ? `Chromium executable unavailable: ${chromiumPath}. Set CHROMIUM to an executable Chromium binary.`
    : `imperfect's browser unavailable: ${chromiumPath}. Run npm ci, or set CHROMIUM to an executable Chromium binary.`, { cause: error });
}

// A cross-process two-browser cap, held by the kernel: the lock Pulse's
// ledger takes (flock on Linux, lockf or perl on a Mac), tried once. Dead
// launcher leases are reclaimed; a launch failure releases its lease too.
// Individual tests need not coordinate.
const tryLock = (slot, program) => lockCommand(slot, program, process.platform, { wait: 0 });
export async function browserLease({ root = join(tmpdir(), `imperfect-test-browsers-${process.getuid?.() ?? 'user'}`), timeout = 120_000 } = {}) {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const started = Date.now();
  while (Date.now() - started < timeout) {
    for (let index = 0; index < 2; index++) {
      const slot = join(root, String(index));
      const lock = spawn(...tryLock(slot, ['bash', '-c', 'echo ready; read -r _ || true']), { stdio: ['pipe', 'pipe', 'ignore'] });
      lock.stdin.on('error', () => {});
      const ended = new Promise(resolve => { lock.once('close', resolve); lock.once('error', resolve); });
      const held = await new Promise((resolve, reject) => {
        lock.once('error', reject);
        lock.once('exit', () => resolve(false));
        lock.stdout.once('data', () => resolve(true));
      });
      if (held) {
        let released = false;
        return async () => { if (!released) { released = true; lock.stdin.end(); await ended; } };
      }
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('The two-browser test cap is busy; retry after the other browsers close.');
}
// How long a page action or wait may take before a test fails: Playwright's
// own 30 seconds made every failing browser test cost half a minute, and a
// red run most of an hour. IMPERFECT_TEST_TIMEOUT (ms) changes it.
const configuredTimeout = Number(process.env.IMPERFECT_TEST_TIMEOUT);
export const TEST_TIMEOUT = Number.isFinite(configuredTimeout) && configuredTimeout > 0 ? configuredTimeout : 10_000;
// Every page and context a test browser makes starts with TEST_TIMEOUT.
function withTestTimeout(browser) {
  for (const make of ['newPage', 'newContext']) {
    if (typeof browser[make] !== 'function') continue;
    const original = browser[make].bind(browser);
    browser[make] = async (...args) => { const made = await original(...args); made.setDefaultTimeout?.(TEST_TIMEOUT); return made; };
  }
  return browser;
}
export async function launchChromium(options = {}) {
  const release = await browserLease();
  try {
    const browser = engine === 'imperfect'
      ? await launchImperfectBrowser({ timeout: 120_000, ...options })
      : await chromium.launch({ timeout: 120_000, ...options, executablePath: chromiumPath });
    if (typeof browser.once === 'function') browser.once('disconnected', () => { void release(); });
    else { // Synthetic fixture browsers have no event emitter.
      const close = browser.close.bind(browser);
      browser.close = async (...args) => { try { return await close(...args); } finally { await release(); } };
    }
    return withTestTimeout(browser);
  } catch (error) { await release(); throw error; }
}
