import { performance } from 'node:perf_hooks';
import { setTimeout as sleep } from 'node:timers/promises';
import { tailnetStatus } from './machines.mjs';

// Discovery's selfId() deliberately falls back to a hostname for local use.
// That fallback is not evidence on which to freeze an enrolled authority role.
export async function startupIdentity({ machines, authority, hosted = false, status = tailnetStatus,
  timeoutMs = 30_000, retryMs = 250 } = {}) {
  // Hosted computers can stand alone without Tailscale. If explicitly
  // enrolled, their inventory may reach a PC, but startup retains their own
  // identity rather than freezing a main-following authority role.
  if (hosted || !authority?.id) return machines.selfId();
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || !Number.isFinite(retryMs) || retryMs <= 0) {
    throw new Error('Invalid startup identity deadline');
  }
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    let timer;
    const remaining = deadline - performance.now();
    const value = await Promise.race([
      Promise.resolve().then(status).catch(() => null),
      new Promise(resolve => { timer = setTimeout(() => resolve(null), Math.max(0, remaining)); }),
    ]).finally(() => clearTimeout(timer));
    const id = value?.Self?.StableID ?? value?.Self?.ID;
    // Online is intentionally not required: a known identity can work locally
    // while disconnected. Never infer identity from DNS, hostname or config.
    if (performance.now() < deadline && typeof id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(id)) return id;
    const left = deadline - performance.now();
    if (left > 0) await sleep(Math.min(retryMs, left));
  }
  throw new Error('Verified Tailscale self identity unavailable; enrolled startup refused');
}
