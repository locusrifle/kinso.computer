// imperfect OS's screen lock (its imperfect-lock keeper and locker): while locked,
// imperfect hides its UI; on release it fades in over its plain theme ground (public/js/arrival.js).
//
// Locked is the keeper's `held` file there AND the kernel saying the keeper's guard (`keeper`, an flock) is held,
// never the file alone: a keeper killed before it could tidy up leaves imperfect as it was. Only read: imperfect
// never takes the guard itself, which would keep a lock from starting. `held`'s mtime
// identifies when this lock began.
//
// `touched` beside it is the locker's (imperfect OS, lock/locker.py): when Locus and Vaita touched on this lock,
// used by the lock presentation. Only a time, and only believed when it names this lock's epoch, so
// a touch on an earlier lock is never taken for this one's; anything else in it is ignored.
import { closeSync, constants, existsSync, fstatSync, openSync, readFileSync, readSync, statSync } from 'node:fs';
import { join } from 'node:path';

export const lockDir = () => join(process.env.XDG_RUNTIME_DIR || `/run/user/${process.getuid?.() ?? 0}`, 'imperfect-lock');

// st_dev as /proc/locks writes it, major:minor in hex (glibc's encoding)
const devOf = dev => `${(Math.floor(dev / 256) & 0xfff).toString(16).padStart(2, '0')}:${((dev & 0xff) | (Math.floor(dev / 4096) & 0xfff00)).toString(16).padStart(2, '0')}`;

// The touch on the lock that began at `epoch` (s), or null: a small file, two finite times, the touch no earlier
// than the lock and no later than now (and a minute's grace for the clock).
export function touchOf(dir, epoch, now = Date.now() / 1000) {
  let fd;
  try {
    // A replaced file must not follow a symlink or block the main thread on a FIFO before fstat.
    fd = openSync(join(dir, 'touched'), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    if (!fstatSync(fd).isFile()) return null;
    const buf = Buffer.alloc(257), n = readSync(fd, buf, 0, 257, 0);
    if (n > 256) return null;
    const data = JSON.parse(buf.subarray(0, n).toString('utf8'));
    const at = data?.touched, of = data?.epoch;
    if (typeof at !== 'number' || typeof of !== 'number' || !Number.isFinite(at) || !Number.isFinite(of)) return null;
    if (Math.abs(of - epoch) > 0.002 || at < epoch - 1 || at > now + 60) return null;
    return at;
  } catch { return null; } finally { if (fd !== undefined) closeSync(fd); }
}

// { epoch, touched } (s) while a lock holds (touched null until they touch), else null
export function lockState(dir = lockDir(), locks = () => readFileSync('/proc/locks', 'utf8')) {
  try {
    const held = statSync(join(dir, 'held')), guard = statSync(join(dir, 'keeper'));
    const at = `${devOf(guard.dev)}:${guard.ino}`;
    // "3: FLOCK  ADVISORY  WRITE 1234 00:2c:5678 0 EOF"; a waiter's line has "->" before FLOCK
    const kept = locks().split('\n').some(line => { const f = line.trim().split(/\s+/); return f[1] === 'FLOCK' && f[5] === at; });
    if (!kept) return null;
    const epoch = held.mtimeMs / 1000;
    return { epoch, touched: touchOf(dir, epoch) };
  } catch { return null; }
}

// Calls tell(state) now and whenever it changes: a look for the file ten times a second, the kernel's word on the
// guard when it is there (and every two seconds while it stays), and the touch at each look while it holds.
export function watchLock(tell, { dir = lockDir(), every = 100, recheck = 2000 } = {}) {
  let state = null, checked = 0, said;
  const look = () => {
    if (!existsSync(join(dir, 'held'))) state = null;
    else if (!state || Date.now() - checked >= recheck) { state = lockState(dir); checked = Date.now(); }
    else state = { ...state, touched: touchOf(dir, state.epoch) };
    const now = state ? `${state.epoch} ${state.touched}` : null;
    if (now !== said) { said = now; tell(state); }
  };
  look();
  const timer = setInterval(look, every);
  timer.unref?.();
  return { now: () => state, stop: () => clearInterval(timer) };
}
