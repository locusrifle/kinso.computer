// Who owns the machine's state directory.
//
// The lock used to be a number. On the next boot that number belongs to
// somebody else — systemd hands out low pids by the hundred while a desktop is
// starting — so the machine asked "is pid 1210 alive?", got yes from a
// stranger, and refused to start for good. That is what happened on the
// testbed: the console never came up, and every window opened by a Super key
// waited forty seconds for a machine that was never coming and then dumped
// core.
//
// So a lock now says which boot it was written in and when that process
// started. A lock from an earlier boot is stale by definition, and within one
// boot a pid that has been reused has a different start time. Neither can be
// mistaken for a machine that is really running.

import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';

// A Mac has no /proc: the same two facts come from sysctl (when it booted)
// and ps (when a process began), each a line that stays the same for as
// long as that boot, or that process, lasts.
const MAC = process.platform === 'darwin';
const said = (command, args) => new Promise(resolve => execFile(command, args, { timeout: 3000, env: { ...process.env, LC_ALL: 'C', LANG: 'C' } }, (error, out) => resolve(error ? '' : String(out).trim())));

export async function bootId(read = readFile) {
  if (MAC && read === readFile) return said('/usr/sbin/sysctl', ['-n', 'kern.boottime']);
  try { return String(await read('/proc/sys/kernel/random/boot_id', 'utf8')).trim(); }
  catch { return ''; }
}

// Field 22 of /proc/<pid>/stat: jiffies since boot at which the process began.
// The name in field 2 may contain spaces and brackets, so the fields are read
// from after the last ')' rather than by splitting the whole line.
export async function startedAt(pid, read = readFile) {
  if (MAC && read === readFile) return said('/bin/ps', ['-o', 'lstart=', '-p', String(pid)]);
  try {
    const stat = String(await read(`/proc/${pid}/stat`, 'utf8'));
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    const ticks = Number(fields[19]);
    return Number.isFinite(ticks) ? String(ticks) : '';
  } catch { return ''; }
}

export async function ownerRecord({ pid = process.pid, read = readFile } = {}) {
  return { pid, boot: await bootId(read), started: await startedAt(pid, read) };
}

export function parseOwner(text) {
  try {
    const held = JSON.parse(String(text ?? ''));
    const pid = Number(held?.pid);
    if (!Number.isInteger(pid) || pid <= 0) return null;
    return { pid, boot: String(held.boot ?? ''), started: String(held.started ?? '') };
  } catch { return null; }
}

/**
 * Is the lock we read still a running machine? `alive` answers whether that pid
 * exists at all; the rest is what tells a survivor from a stranger wearing its
 * number.
 */
export async function ownerHolds(held, { boot, alive, read = readFile } = {}) {
  if (!held) return false;
  if (held.boot && boot && held.boot !== boot) return false;
  if (!alive(held.pid)) return false;
  if (!held.started) return true;
  const started = await startedAt(held.pid, read);
  return started === '' || started === held.started;
}
