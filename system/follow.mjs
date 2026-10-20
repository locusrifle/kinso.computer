// Authority-linked computers and hosted members follow main through the
// same natural-settlement handoff. Self-hosted members still update on request.
// Hosted checkouts move only inside the final idle fence; personal changes are
// never merged or discarded. Packages are installed on the next start, not here.
import { execFile } from 'node:child_process';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { normalizeAuthorityGitUrl } from './machine.mjs';

function exec(file, args, options) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: 120_000, maxBuffer: 4 << 20, ...options }, (error, stdout) => {
      // Git's stderr and error objects can contain origin's lifetime key.
      if (error) reject(new Error('Git operation failed'));
      else resolve(String(stdout).trim());
    });
  });
}

const messages = {
  current: '',
  waiting: 'An update is ready. Your computer will update when no agent is working or waiting for you.',
  restarting: 'Your computer is restarting to finish its update.',
  'local changes': 'Automatic updates paused: this computer has your own changes. They have been left alone. Ask your agent to help update without losing them.',
  diverged: 'Automatic updates paused: this computer has its own commits or is not on main. Your work has been left alone. Ask your agent to help update.',
  unreachable: 'The update source is not answering. Your computer will try again later.',
};
// Commit text is for members, but a URL with credentials must never reach a log
// or a window even if someone accidentally put one in a commit message.
const safeText = text => String(text).replace(/\b(https?:\/\/)[^\s/@]+(?::[^\s/@]*)?@/gi, '$1[private]@');

export function followsMain(config, selfId) {
  return config.hosted === true || Boolean(config.authority?.id && selfId && selfId !== config.authority.id);
}

export function createFollow({ root, busy, restart, branch = 'main', idleOnly = false, stateDir, source,
  run = exec, log = message => console.log(`follow: ${message}`) }) {
  // Keep origin (which may contain a member key) untouched. origin/main is
  // still the local comparison ref used by the follower and doctor.
  const upstream = source === undefined ? 'origin' : normalizeAuthorityGitUrl(source);
  const git = (...args) => run('git', ['-C', root, ...args]);
  const fetchMain = () => upstream === 'origin'
    ? git('fetch', '--quiet', 'origin', `${branch}:refs/remotes/origin/${branch}`)
    : run('git', ['-C', root, 'fetch', '--quiet', '--no-tags', '--', upstream, `${branch}:refs/remotes/origin/${branch}`], {
      env: { ...process.env, GIT_SSH_COMMAND: 'ssh -oBatchMode=yes -oConnectTimeout=10 -oStrictHostKeyChecking=yes', GIT_SSH_VARIANT: 'ssh' },
    });
  let pending = false, said = '', timer = null, ticking = null;
  let state = { status: 'current', message: '', applied: null, state: 'unknown', reason: 'not checked yet', since: new Date().toISOString(), checked: null, restartPending: false };
  let saving = Promise.resolve(), sequence = 0;
  const save = () => {
    if (!record) return;
    const snapshot = JSON.stringify(state), next = `${record}.${process.pid}.${++sequence}.tmp`;
    saving = saving.then(async () => { await mkdir(stateDir, { recursive: true, mode: 0o700 }); await writeFile(next, snapshot, { mode: 0o600 }); await rename(next, record); }).catch(() => {});
  };
  const record = stateDir && join(stateDir, 'computer-update.json');
  const ready = record ? readFile(record, 'utf8').then(async text => {
    const saved = JSON.parse(text);
    if (['current', 'paused', 'waiting', 'restarting', 'unreachable'].includes(saved?.state)) {
      state = { ...state, state: saved.state, reason: safeText(saved.reason), since: saved.since, checked: saved.checked,
        restartPending: Boolean(saved.restartPending), ...(saved.pendingSince ? { pendingSince: saved.pendingSince } : {}) };
    }
    if (saved?.applied && /^[a-f0-9]{40,64}$/.test(saved.applied.to) && Array.isArray(saved.applied.commits)) {
      if (await git('rev-parse', 'HEAD') === saved.applied.to) {
        state.applied = { ...saved.applied, commits: saved.applied.commits.map(commit => ({
          hash: commit.hash, subject: safeText(commit.subject), body: safeText(commit.body),
        })) };
      }
    }
  }).catch(() => {}) : Promise.resolve();
  const once = message => { if (message !== said) log(message); said = message; };
  const publish = (status, reason) => {
    const machineState = ['local changes', 'diverged'].includes(status) ? 'paused' : status;
    reason ??= ({ current: 'matches authority main', waiting: 'agents are busy or handoff is settling', restarting: 'restart requested', 'local changes': 'dirty tree', diverged: 'local commits', unreachable: 'authority fetch or update failed' })[status];
    const changed = state.state !== machineState || state.reason !== reason;
    state = { ...state, status, message: messages[status], state: machineState, reason,
      since: changed ? new Date().toISOString() : state.since, checked: new Date().toISOString(), restartPending: pending || ['waiting', 'restarting'].includes(status) };
    if (state.restartPending) state.pendingSince ??= state.since;
    else delete state.pendingSince;
    save();
    return status;
  };
  async function permitted(here, there) {
    if (await git('rev-parse', '--abbrev-ref', 'HEAD') !== branch) { once(`not on ${branch}; left alone`); return publish('diverged', 'not on main'); }
    if (await git('status', '--porcelain')) { once('this checkout has changes of its own; left alone'); return publish('local changes'); }
    try { await git('merge-base', '--is-ancestor', here, there); }
    catch { once(`this checkout has commits ${branch} does not; left alone`); return publish('diverged'); }
    return null;
  }
  async function apply(here, there) {
    // The handoff's final fence is held here. Recheck after waiting: an agent
    // may have edited or committed while the update was waiting to settle.
    if (await git('rev-parse', 'HEAD') !== here) { publish('waiting'); return false; }
    if (await permitted(here, there)) return false;
    if (idleOnly) publish('restarting');
    const changed = (await git('diff', '--name-only', here, there)).split('\n').filter(Boolean);
    const history = await git('log', '--reverse', '--format=%H%x00%s%x00%b%x00', `${here}..${there}`);
    const fields = history.split('\0');
    const commits = [];
    for (let i = 0; i + 2 < fields.length; i += 3) {
      commits.push({ hash: fields[i].trim(), subject: safeText(fields[i + 1]), body: safeText(fields[i + 2].trim()) });
    }
    // Write the receipt before moving HEAD. On startup it is shown only if
    // that target became HEAD; a failed merge cannot claim an update happened.
    const applied = { from: here, to: there, at: new Date().toISOString(), commits };
    if (record) {
      // An earlier waiting-state publication must not overwrite this receipt
      // after HEAD moves. Preserve machine state alongside the handoff receipt.
      await saving;
      await mkdir(stateDir, { recursive: true, mode: 0o700 });
      await writeFile(`${record}.tmp`, JSON.stringify({ ...state, applied }), { mode: 0o600 });
      await rename(`${record}.tmp`, record);
    }
    await git('merge', '--ff-only', '--quiet', there);
    state.applied = applied;
    said = '';
    log(`took ${there.slice(0, 7)} (${changed.length} file${changed.length === 1 ? '' : 's'})`);
    if (changed.includes('package-lock.json')) log('new packages; they are installed when imperfect restarts');
    if (changed.includes('binaries.json')) log('a new phone app is pinned; ./install.sh phone fetches it');
    pending = true;
    return true;
  }
  async function step() {
    await ready;
    try { await fetchMain(); }
    catch { once('the update source is not answering; trying again later'); return publish('unreachable'); }
    const [here, there] = await Promise.all([git('rev-parse', 'HEAD'), git('rev-parse', `origin/${branch}`)]);
    if (state.applied && state.applied.to !== here) state.applied = null;
    const blocked = await permitted(here, there);
    if (blocked) return blocked;
    if (here !== there) {
      if (idleOnly) {
        if (busy()) { once('update ready; waiting until no agent is working'); return publish('waiting'); }
        publish('waiting');
        const result = await restart(() => apply(here, there));
        if (result === false) return state.status;
        pending = false;
        return publish('restarting');
      }
      await apply(here, there);
    }
    if (!pending) return publish('current');
    if (busy()) { once('updated; restarting once no agent is working'); return publish('waiting'); }
    log('restarting to run what it took');
    if (await restart() === false) { said = ''; once('updated; restarting once no agent is working'); return publish('waiting'); }
    pending = false;
    return publish('restarting');
  }
  return {
    snapshot: () => structuredClone(state),
    ready,
    tick() {
      ticking ??= step().catch(() => {
        // Never include raw Git errors, command arguments or URLs.
        once('could not safely apply the update; trying again later');
        return publish('unreachable');
      }).finally(async () => { await saving; ticking = null; });
      return ticking;
    },
    start(every = 120_000) {
      const go = () => { void this.tick(); };
      go();
      timer = setInterval(go, every);
      timer.unref?.();
    },
    stop() { clearInterval(timer); },
  };
}

// The packages the lockfile names that node_modules does not hold.
export async function packagesToInstall(root) {
  const packages = path => readFile(join(root, path), 'utf8').then(text => JSON.parse(text).packages ?? {}, () => ({}));
  const [want, have] = await Promise.all([packages('package-lock.json'), packages('node_modules/.package-lock.json')]);
  return Object.entries(want).filter(([path, p]) => path.startsWith('node_modules/')
    && (have[path] ? have[path].version !== p.version : !(p.optional || p.dev || p.devOptional || p.peer))).map(([path]) => path.slice('node_modules/'.length));
}
