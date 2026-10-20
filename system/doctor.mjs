// Pulse observes; it never restarts, fetches, cleans a disk or discards work.
import { execFile } from 'node:child_process';
import { readFile, writeFile, mkdir, rename, readdir, stat, statfs, open } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { homedir, hostname } from 'node:os';

export const STATES = ['ok', 'unknown', 'warn', 'crit'];
const minute = 60_000, day = 86400_000;
const result = (state, reason, evidence = {}, since = null) => ({ state, reason, evidence, since });
const unknown = cause => result('unknown', cause);
const compact = evidence => {
  try { const text = JSON.stringify(evidence ?? {}); return Buffer.byteLength(text) <= 8192 ? evidence ?? {} : { truncated: true, preview: text.slice(0, 4000) }; }
  catch { return { unavailable: 'evidence is not serializable' }; }
};
const within = async (promise, milliseconds) => {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('probe timed out')), milliseconds); })]); }
  finally { clearTimeout(timer); }
};
const age = (when, now) => Number.isFinite(Date.parse(when)) && Date.parse(when) <= now + 30_000 ? Math.max(0, now - Date.parse(when)) : Infinity;
const number = value => typeof value === 'number' && Number.isFinite(value);
export async function smallJson(path) {
  const file = await open(path, 'r');
  try { if ((await file.stat()).size > 256 * 1024) throw new Error('too large'); return JSON.parse(await file.readFile('utf8')); }
  finally { await file.close(); }
}
export async function atomicJson(path, value) {
  await mkdir(resolve(path, '..'), { recursive: true, mode: 0o700 });
  const temp = `${path}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  await rename(temp, path);
}
const run = (file, args) => new Promise((yes, no) => execFile(file, args, { timeout: 4000, maxBuffer: 64 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }, (error, stdout) => error ? no(new Error('probe unavailable')) : yes(stdout.trim())));
const optional = promise => promise.catch(() => null);

// Installed system units and one current-boot journal receipt, never checkout
// configuration or a remote peer. Lack of journal permission stays unknown.
export async function observeCrashRecording(execute = run) {
  const fields = output => output == null ? null : Object.fromEntries(output.split('\n').filter(line => line.includes('=')).map(line => {
    const at = line.indexOf('='); return [line.slice(0, at), line.slice(at + 1)];
  }));
  const [timer, service, receipt] = await Promise.all([
    optional(execute('systemctl', ['show', '-p', 'LoadState', '-p', 'ActiveState', 'imperfect-pulse-sample.timer'])),
    optional(execute('systemctl', ['show', '-p', 'LoadState', '-p', 'ActiveState', '-p', 'Result', '-p', 'ExecMainStatus', 'imperfect-pulse-sample.service'])),
    optional(execute('journalctl', ['--boot=0', '--no-pager', '-n', '1', '-o', 'json', 'SYSLOG_IDENTIFIER=imperfect-pulse', 'MESSAGE=Pulse bounded resource sample; observed launches are a lower bound'])),
  ]);
  let sample = null;
  try {
    const entry = JSON.parse(receipt), ms = Number(entry.__REALTIME_TIMESTAMP) / 1000;
    if (entry.PULSE_BOOT_ID && entry.PULSE_BOOT_ID === entry._BOOT_ID && Number.isFinite(ms) && ms > 0) sample = { when: new Date(ms).toISOString(), bootId: entry.PULSE_BOOT_ID };
  } catch { /* Missing, unreadable or malformed receipts are not success. */ }
  return { timer: fields(timer), service: fields(service), sample };
}

function crashRecording(c) {
  const r = c.crashRecording;
  const evidence = { ...r, scope: 'Local current-boot sampling only; persistence, remote replication and hardware watchdog operation are not verified.' };
  for (const name of ['timer', 'service']) {
    const unit = r?.[name];
    if (unit?.LoadState && unit.LoadState !== 'loaded') return result('crit', `Installed OS crash sampler ${name} is ${unit.LoadState}; checkout configuration is not installation.`, evidence);
    if (unit?.ActiveState === 'failed' || (name === 'service' && unit?.Result && unit.Result !== 'success')) return result('crit', `Installed OS crash sampler ${name} failed.`, evidence);
  }
  if (r?.service?.ExecMainStatus && r.service.ExecMainStatus !== '0') return result('crit', 'The OS crash sampler last exited unsuccessfully.', evidence);
  if (r?.timer?.ActiveState && r.timer.ActiveState !== 'active') return result('crit', 'Installed OS crash sampler timer is not active.', evidence);
  if (r?.timer?.LoadState !== 'loaded' || r?.service?.LoadState !== 'loaded' || !r.timer.ActiveState || !r.service.ActiveState || !r.service.Result || r.service.ExecMainStatus == null) return unknown('Installed OS crash sampler status is unavailable; source configuration proves nothing about this host.');
  if (!r.sample?.bootId || age(r.sample.when, c.now) === Infinity) return result('unknown', 'No readable, valid current-boot local crash sample; journal access or recording may be unavailable.', evidence);
  const elapsed = age(r.sample.when, c.now);
  return result(elapsed > 3 * minute ? 'crit' : elapsed > minute ? 'warn' : 'ok', elapsed > minute ? 'The last current-boot local crash sample is stale despite the installed timer.' : 'Installed OS crash sampler timer is active and a fresh current-boot sample is readable in the local journal.', evidence, r.sample.when);
}

// All checks consume a single cheap observation, making every policy testable
// without a real disk, git remote, systemd or a credential-bearing environment.
export function invariantRegistry() {
  const item = (id, title, severity, check, healing, runbook, owner = 'app') => ({ id, title, severity, check, healing, runbook, owner });
  return [
    item('follower-drift', 'App follower', 'crit', c => {
      const f = c.follower;
      if (!f || !number(f.ahead) || !number(f.behind)) return unknown('App follower state or authority main is unavailable.');
      const evidence = { ahead: f.ahead, behind: f.behind, dirty: f.dirty, branch: f.branch, fastForwardable: f.ahead === 0, restartPending: f.restartPending, checked: f.checked };
      if (f.enabled !== false && (f.state === 'unreachable' || age(f.checked, c.now) > 5 * minute)) return result('unknown', 'Authority main is not live; the follower has no fresh successful fetch.', evidence, f.since);
      if (f.ahead > 0) return result('crit', 'Automatic updates paused: local commits are not on authority main.', evidence, f.since);
      if (f.branch && f.branch !== 'main') return result('warn', 'Automatic updates paused: this checkout is not on main.', evidence, f.since);
      if (f.dirty) return result('warn', 'Automatic updates paused: the checkout has local changes.', evidence, f.since);
      if (f.restartPending) return result(age(f.pendingSince || f.since, c.now) > 30 * minute ? 'warn' : 'ok', 'The update is on disk; restart is waiting for agents to settle.', evidence, f.pendingSince || f.since);
      if (f.behind > 0) return result('warn', `This checkout is ${f.behind} commits behind authority main; the follower is ${f.reason || f.state || 'waiting'}.`, evidence, f.since);
      if (f.enabled === false) return result('ok', 'This is the authority checkout; no automatic follower is required.', evidence);
      return result('ok', 'The app checkout matches the last fetched authority main.', evidence);
    }, 'Personal work is left alone; automatic retries never reset it.', 'Reconcile local commits/changes with an agent; check computer-update.json and the commit guard.'),
    item('os-follower', 'OS follower', 'warn', c => {
      const f = c.os;
      if (!f) return unknown('OS follower has not published a readable status file.');
      const when = f.lastRun || f.checked || f.when;
      const evidence = { lastRun: when, lastSwitch: f.lastSwitch, pinnedCommit: f.pinnedCommit, mainCommit: f.mainCommit, mainAt: f.mainAt, pinnedAt: f.pinnedAt, pinnedAgeMs: f.pinnedAt ? age(f.pinnedAt, c.now) : null };
      if (f.state === 'failed' || f.state === 'crit') return result('crit', `OS switch failed: ${f.reason || 'the previous system was retained'}.`, evidence, f.since);
      if (age(when, c.now) > 15 * minute) return result('warn', 'OS follower has not completed a run in the last 15 minutes.', evidence, when);
      if (f.state === 'waiting' || f.state === 'paused' || f.pinnedCommit && f.mainCommit && f.pinnedCommit !== f.mainCommit) return result('warn', `OS switch is waiting: ${f.reason || 'the pinned system is behind main'}.`, evidence, f.since);
      if (!['current', 'switched', 'ok'].includes(f.state)) return unknown('OS follower status does not declare a healthy state.');
      return result('ok', 'OS follower reports its pinned system current.', evidence, f.since);
    }, 'OS retries on its own timer; busy agents hold the switch.', 'Read /var/lib/imperfect-os-follow/status.json; manual disruptive switches need Noah.', 'pulse-os'),
    item('disk-pressure', 'Disk and inodes', 'crit', c => {
      if (!c.disks?.length) return unknown('Disk pressure could not be read for / and /home.');
      const known = c.disks.flatMap(d => [{ path: d.path, kind: 'disk', value: d.used }, { path: d.path, kind: 'inode', value: d.inodes }]).filter(d => number(d.value));
      const worst = known.sort((a, b) => b.value - a.value)[0];
      if (!worst) return unknown('Disk or inode pressure could not be read for / and /home.');
      if (worst.value < 80 && c.disks.some(d => !number(d.used) || !number(d.inodes))) return result('unknown', c.disks.some(d => !number(d.used)) ? 'Disk-use probes are unavailable for one or more mounts.' : `Known disk/inode use is at most ${worst.value.toFixed(1)}%; some filesystems do not report inode counts.`, { disks: c.disks });
      return result(worst.value >= 90 ? 'crit' : worst.value >= 80 ? 'warn' : 'ok', `${worst.path} ${worst.kind} use is ${worst.value.toFixed(1)}%; ${worst.value >= 80 ? 'free space needs attention' : 'below the 80% warning threshold'}.`, { disks: c.disks });
    }, 'No automatic deletion; a guard watches every minute.', 'Identify known disposable caches; ask before deleting personal data.'),
    item('memory-pressure', 'Memory pressure', 'crit', c => {
      const m = c.memory;
      if (!m || !number(m.used) || !number(m.some) || !number(m.full)) return unknown('Memory availability or Linux PSI could not be read.');
      const state = m.used >= 95 || m.full >= 10 ? 'crit' : m.used >= 85 || m.some >= 10 || m.full >= 2 ? 'warn' : 'ok';
      return result(state, `Memory use is ${m.used.toFixed(1)}%, with ${m.full.toFixed(1)}% full memory stalls over 60 seconds.`, m);
    }, 'Worker/browser caps belong to imperfect-workers.slice, not a kill loop.', 'Reduce concurrent heavy jobs; inspect PSI and worker limits.', 'pulse-os'),
    item('services', 'Local services', 'crit', c => {
      if (!c.services?.length) return unknown('Local service health probes are not configured.');
      const bad = c.services.find(s => s.state === 'crit'), missing = c.services.find(s => s.state !== 'ok');
      return bad ? result('crit', `${bad.name} is unhealthy: ${bad.reason}.`, { services: c.services }) : missing ? result('unknown', `${missing.name} health is unknown: ${missing.reason}.`, { services: c.services }) : result('ok', 'Configured local app, store, tunnel and sites probes are healthy.', { services: c.services });
    }, 'Pulse reports only; it does not restart working services.', 'Check the named local unit/loopback endpoint; public store reachability is out of scope.'),
    item('workers', 'Workers ledger', 'warn', c => {
      if (!Array.isArray(c.workers)) return unknown('Worker ledger is unreadable.');
      const failed = c.workers.filter(w => w.finished && w.exit !== 0 && !w.acknowledged), unseen = c.workers.filter(w => w.finished && !w.acknowledged && age(w.finished, c.now) > 10 * minute), running = c.workers.filter(w => !w.finished);
      return result(failed.length ? 'crit' : unseen.length ? 'warn' : 'ok', failed.length ? `${failed.length} failed workers await acknowledgement.` : unseen.length ? `${unseen.length} finished workers have been unacknowledged for over 10 minutes.` : `${running.length} ledger workers running; no overdue completion notices.`, { running: running.map(w => w.name), failed: failed.map(w => w.name), unacknowledged: unseen.map(w => w.name) });
    }, 'Completion hooks raise a durable open item even after a crash.', 'worker logs <name>; review the result, then worker ack <name>.'),
    item('memory-bank', 'Memory bank', 'warn', c => {
      const m = c.bank;
      if (!m?.finished) return unknown('Memory has no completed-pass receipt yet.');
      if (!number(m.oldOpen)) return unknown('Memory open-item ages could not be read.');
      const evidence = { lastPass: m.finished, oldOpen: m.oldOpen };
      if (age(m.finished, c.now) > 30 * minute) return result('crit', 'Memory has not completed a pass in over 30 minutes.', evidence, m.finished);
      // With no nightly review, a refused upgrade is said at once rather than when it is a week old.
      if (m.upgradeRefused) return result('warn', 'An upgrade failed its tests and was not taken: see open/upgrade.md in memory.', { ...evidence, upgradeRefused: true }, m.finished);
      if (age(m.finished, c.now) > 10 * minute || m.oldOpen > 0) return result('warn', `Memory needs review: its last pass finished ${m.finished}, and ${m.oldOpen} open items are older than 7 days.`, evidence, m.finished);
      return result('ok', 'Memory passes are recent, with no old open items.', evidence, m.finished);
    }, 'Memory timers retry; memory calls no model.', 'Inspect imperfect-memory and memory/pulse-pass.json and open/.'),
    item('backups', 'Backup job', 'crit', c => {
      const b = c.backup;
      if (!b) return unknown('No readable restic job receipt is present.');
      if (b.exit !== undefined && b.exit !== 0) return result('crit', 'The last backup job failed; no new successful backup is declared.', { exit: b.exit, success: b.lastSuccess });
      if (!b.lastSuccess) return unknown('Backup receipt has no successful snapshot time.');
      return result(age(b.lastSuccess, c.now) > 2 * day ? 'crit' : age(b.lastSuccess, c.now) > day ? 'warn' : 'ok', `The backup job reported success at ${b.lastSuccess}; restore coverage is not checked.`, { lastSuccess: b.lastSuccess }, b.lastSuccess);
    }, 'Restic scheduling and retries remain with the backup job.', 'Read the restic job receipt/log; verify a restore before claiming backup coverage.'),
    item('clock', 'Clock synchronisation', 'warn', c => {
      if (!c.clock || c.clock.synchronised == null) return unknown('Clock synchronisation status could not be read.');
      if (!c.clock.synchronised) return result('warn', 'The system clock is not synchronised; timestamps may be skewed.', c.clock);
      if (number(c.clock.offsetMs) && Math.abs(c.clock.offsetMs) > 5000) return result('crit', 'The recorded clock offset exceeds five seconds.', c.clock);
      return result('ok', 'The OS reports the clock synchronised; no independent offset estimate is available.', c.clock);
    }, 'Time synchronisation belongs to the OS.', 'Check timedatectl show and the OS time service.', 'pulse-os'),
    item('test-gate', 'Successful test gate', 'warn', c => {
      const g = c.gate;
      if (!g) return unknown('The test launcher has not published a gate receipt.');
      if (number(g.exit) && g.exit !== 0) return result('crit', 'The last recorded test gate failed; it must not admit an update.', { lastSuccess: g.lastSuccess ?? null, finished: g.finished, exit: g.exit, commit: g.commit }, g.finished);
      if (!g.lastSuccess || !number(g.exit)) return unknown('The test launcher has not published a complete successful gate receipt.');
      const state = age(g.lastSuccess, c.now) > 7 * day ? 'warn' : 'ok';
      return result(state, g.exit !== 0 ? 'The last recorded test gate failed; it must not admit an update.' : `The last successful test gate was ${g.lastSuccess}.`, { lastSuccess: g.lastSuccess, finished: g.finished, exit: g.exit, commit: g.commit }, g.finished);
    }, 'Failed gates do not authorize shipping.', 'Run tools/test-gate.mjs in an independent user unit; retry a failing file once alone.'),
    item('reflections', 'Shown pages / reflections', 'warn', c => {
      if (!c.reflections) return unknown('Shown pages have no cheap freshness receipt yet.');
      const stale = c.reflections.filter(r => !r.live || age(r.checked, c.now) > 3 * minute);
      if (!stale.length && c.reflections.some(r => r.source === 'disk-presence')) return result('unknown', 'Declared shown folders still exist; client reflection freshness has no receipt.', { targets: c.reflections.map(r => r.name) });
      return result(stale.length ? 'warn' : 'ok', stale.length ? `${stale.length} shown pages or reflections have a stale freshness receipt.` : 'Declared shown-page freshness receipts are current.', { stale: stale.map(r => r.name) });
    }, 'Existing view refresh paths retry; Pulse never recursively walks files.', 'Refresh the named view; check its owner and freshness receipt.'),
    item('crash-recording', 'Installed OS crash recording', 'crit', crashRecording,
      'The OS timer retries sampling; the app never installs or restarts it.', 'Check installed imperfect-pulse-sample.timer/service and current-boot local journal samples; config alone is not coverage.', 'pulse-os'),
    item('unclean-boots', 'OS incidents', 'crit', c => {
      if (!Array.isArray(c.boots)) return unknown('OS open incident files could not be read.');
      const open = c.boots.filter(b => !b.closed);
      if (!open.length && crashRecording(c).state !== 'ok') return unknown('No open OS incidents were read, but installed local crash recording is not verified; an empty ledger cannot establish a clean boot history.');
      return result(open.length ? 'crit' : 'ok', open.length ? `${open.length} OS incidents remain open: ${open[0].summary || open[0].kind}.` : 'No unresolved OS unclean-boot incidents remain in the ledger.', { incidents: open.map(b => ({ kind: b.kind, host: b.host, when: b.when, bootId: b.bootId, previousBootId: b.previousBootId, summary: b.summary, evidence: b.evidence, suspects: b.suspects, guard: b.guard })) }, open[0]?.when);
    }, 'OS writes black-box evidence; the app only reads/imports it.', 'Review the OS evidence and add a verified guard before closing.', 'pulse-os'),
    { ...item('doctor-heartbeat', 'Doctor heartbeat', 'crit', c => heartbeat(c.doctor, c.now), 'Independent /health check exposes a dead doctor.', 'Inspect the doctor journal; do not restart working agents.'), independent: true },
  ];
}

export function heartbeat(snapshot, now = Date.now()) {
  const fresh = snapshot && age(snapshot.checked, now) <= 3 * minute;
  const future = snapshot && Date.parse(snapshot.checked) > now + 30_000;
  return { id: 'doctor-heartbeat', title: 'Doctor heartbeat', severity: 'crit', owner: 'app', ...result(fresh ? 'ok' : snapshot ? 'crit' : 'unknown', fresh ? 'Doctor completed a pass in the last three minutes.' : future ? 'Doctor receipt is in the future; clock skew prevents a live health claim.' : snapshot ? 'Doctor has not completed a pass in the last three minutes.' : 'Doctor has not published its first pass.', { checked: snapshot?.checked ?? null }, snapshot?.checked ?? null), healing: 'Independent /health check exposes a dead doctor.', runbook: 'Inspect doctor.log / imperfect-code journal; do not restart working agents.' };
}
export function pulseSummary(snapshot, now = Date.now()) {
  const declared = Array.isArray(snapshot?.invariants) ? snapshot.invariants.map(item => item && STATES.includes(item.state) ? item : { state: 'unknown', reason: 'Doctor published an invalid invariant result.', healing: 'Inspect status.json; invalid data never becomes green.' }) : [];
  const items = [...declared, heartbeat(Array.isArray(snapshot?.invariants) ? snapshot : null, now)];
  const worst = [...items].sort((a, b) => STATES.indexOf(b.state) - STATES.indexOf(a.state))[0];
  return { state: worst.state, reason: worst.reason, healing: worst.healing, checked: snapshot?.checked ?? null, counts: Object.fromEntries(STATES.map(s => [s, items.filter(i => i.state === s).length])), doctor: heartbeat(snapshot, now) };
}

export function createObserver({ stateDir, prefix = resolve(stateDir, '../..'), root = join(homedir(), 'imperfect'), authority = false, followerEnabled = true, port = 5067, host = hostname(), osState = '/var/lib/imperfect-os-follow/status.json', execute = run, json = smallJson, filesystem = statfs, text = path => readFile(path, 'utf8'), send = fetch, listWorkers = async () => [] } = {}) {
  const memoryDir = join(prefix, 'memory');
  return async now => {
    const read = path => optional(json(path));
    const [saved, os, backup, gate, pass, reflections, meminfo, psi, clock, workers, crashRecording] = await Promise.all([
      read(join(stateDir, 'computer-update.json')), read(osState), read(join(stateDir, 'restic-status.json')), read(join(stateDir, 'test-gate.json')), read(join(memoryDir, 'pulse-pass.json')), read(join(stateDir, 'reflections.json')),
      optional(text('/proc/meminfo')), optional(text('/proc/pressure/memory')), optional(execute('timedatectl', ['show', '-p', 'NTPSynchronized', '--value'])), optional(listWorkers()), observeCrashRecording(execute),
    ]);
    let follower = saved;
    try {
      const git = (...args) => execute('git', ['-C', root, ...args]);
      const [counts, dirty, branch] = await Promise.all([git('rev-list', '--left-right', '--count', 'HEAD...origin/main'), git('status', '--porcelain', '--untracked-files=normal'), git('rev-parse', '--abbrev-ref', 'HEAD')]);
      const [ahead, behind] = counts.split(/\s+/).map(Number);
      follower = { ...saved, ahead, behind, dirty: Boolean(dirty), branch, enabled: followerEnabled, checked: authority ? new Date(now).toISOString() : saved?.checked };
      // The PC is authority, not a follower; its tracking ref may lag its own commits.
      if (authority) follower = { ...follower, ahead: 0, behind: 0, state: 'current', enabled: false };
    } catch { follower = null; }
    let backupState = backup;
    if (!backupState) {
      const job = await optional(execute('systemctl', ['--user', 'show', '--property=Result', '--property=ExecMainStatus', '--property=ExecMainExitTimestamp', 'restic-store.service']));
      const fields = Object.fromEntries((job ?? '').split('\n').filter(line => line.includes('=')).map(line => { const at = line.indexOf('='); return [line.slice(0, at), line.slice(at + 1)]; }));
      const stamp = fields.ExecMainExitTimestamp, local = stamp?.match(/(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})/);
      const parsed = Date.parse(stamp), when = Number.isFinite(parsed) ? parsed : local ? Date.parse(`${local[1]}T${local[2]}`) : NaN;
      if (Number.isFinite(when) && fields.ExecMainStatus != null) backupState = { exit: fields.Result === 'success' ? Number(fields.ExecMainStatus) : Number(fields.ExecMainStatus) || 1, lastSuccess: fields.Result === 'success' && fields.ExecMainStatus === '0' ? new Date(when).toISOString() : null };
    }
    const disks = await Promise.all(['/', '/home'].map(async path => {
      const f = await optional(filesystem(path));
      return f ? { path, used: (f.blocks - f.bavail) / f.blocks * 100, inodes: f.files ? (f.files - f.ffree) / f.files * 100 : null } : { path, used: null, inodes: null };
    }));
    const total = Number(meminfo?.match(/^MemTotal:\s+(\d+)/m)?.[1]), available = Number(meminfo?.match(/^MemAvailable:\s+(\d+)/m)?.[1]);
    const pressure = kind => Number(psi?.match(new RegExp(`^${kind} .*avg60=([\\d.]+)`, 'm'))?.[1]);
    const memory = total && available >= 0 ? { used: (1 - available / total) * 100, some: pressure('some'), full: pressure('full') } : null;
    const names = await optional(readdir(join(memoryDir, 'open')));
    const boots = [], old = [];
    let openUnreadable = !names || names.length > 128;
    for (const name of (names ?? []).slice(0, 128)) {
      if (!/^[\w.-]+\.(json|md)$/.test(name)) continue;
      const path = join(memoryDir, 'open', name), info = await optional(stat(path));
      if (!info) openUnreadable = true;
      if (info && now - info.mtimeMs > 7 * day) old.push(name);
      if (name.endsWith('.json')) { const b = await read(path); if (!b) openUnreadable = true; if (b?.bootId && b?.previousBootId && b?.kind) boots.push(b); }
    }
    let freshness = Array.isArray(reflections) ? reflections : null;
    if (!freshness) {
      const shown = await read(join(stateDir, 'shown.json'));
      if (Array.isArray(shown) && shown.length) freshness = await Promise.all(shown.slice(0, 32).filter(path => typeof path === 'string' && path.startsWith('/') && !path.includes('/credentials')).map(async path => ({ name: path.split('/').filter(Boolean).at(-1), live: Boolean(await optional(stat(path))), checked: new Date(now).toISOString(), source: 'disk-presence' })));
    }
    const services = [];
    // Loopback only, no external store probe and no credentials.
    for (const [name, target] of [['imperfect-code', `http://127.0.0.1:${port}/health`], ...(authority ? [['store', 'http://127.0.0.1:4322/health'], ['sites', `http://127.0.0.1:${port + 1}/`]] : [])]) {
      try { const res = await send(target, { signal: AbortSignal.timeout(1500), redirect: 'error' }); const body = await res.json(); const healthy = name === 'sites' ? res.status === 404 && body?.error === 'not found' : res.ok && body?.ok === true; services.push({ name, state: healthy ? 'ok' : 'crit', reason: name === 'sites' && healthy ? 'isolated page listener answered its expected empty-root 404' : `loopback HTTP ${res.status}${body && body.ok !== true ? ', ok not true' : ''}` }); }
      catch { services.push({ name, state: 'crit', reason: 'loopback endpoint did not provide a valid health receipt' }); }
    }
    const unit = authority ? 'imperfect-tunnel.service' : 'tailscaled.service';
    const tunnel = await optional(execute('systemctl', [...(authority ? ['--user'] : []), 'show', '--property=ActiveState', '--value', unit]));
    services.push({ name: 'tunnel', state: tunnel === 'active' ? 'ok' : tunnel === null ? 'unknown' : ['inactive', 'failed'].includes(tunnel) ? 'crit' : 'unknown', reason: tunnel === 'active' ? `${unit} active (not an external reachability test)` : `${unit} ${tunnel || 'status unavailable'}` });
    // Private sites are probed only where their user units are declared.
    // HEAD checks their local listener, including its authentication boundary,
    // never credentials, website contents or public store reachability.
    if (authority) for (const [name, port] of [['dacre', 4324], ['aimee', 4325], ['kinso', 4326]]) {
      const state = await optional(execute('systemctl', ['--user', 'show', '--property=LoadState', '--property=ActiveState', `${name}-web.service`]));
      if (!state || !/^LoadState=loaded$/m.test(state)) continue;
      const active = /^ActiveState=active$/m.test(state);
      try { const reply = await send(`http://127.0.0.1:${port}/`, { method: 'HEAD', signal: AbortSignal.timeout(1000), redirect: 'error' }); services.push({ name, state: active && [200, 401].includes(reply.status) ? 'ok' : 'crit', reason: !active ? `${name}-web unit is not active` : `local listener HTTP ${reply.status}; protected contents not inspected` }); }
      catch { services.push({ name, state: 'crit', reason: 'local site listener did not answer' }); }
    }
    return { now, host, follower, os, crashRecording, disks, memory, services, workers, backup: backupState, gate, clock: clock === null ? null : { synchronised: clock === 'yes' }, bank: pass && { ...pass, oldOpen: openUnreadable ? null : old.length, upgradeRefused: Boolean(names?.includes('upgrade.md')) }, reflections: freshness?.length || Array.isArray(reflections) ? freshness : null, boots: openUnreadable && !boots.length ? null : boots };
  };
}

export function createDoctor({ stateDir, observe, registry = invariantRegistry(), incidents, now = Date.now, host = hostname(), onError = () => {} }) {
  let snapshot = null, running = null, timer;
  const ready = optional(smallJson(join(stateDir, 'status.json'))).then(saved => { snapshot = Array.isArray(saved?.invariants) ? { ...saved, invariants: saved.invariants.filter(item => item && typeof item.id === 'string' && STATES.includes(item.state)) } : null; });
  async function pass() {
    await ready;
    const started = now();
    let context;
    try { context = await within(observe(started), 12_000); } catch { context = { now: started }; }
    if (incidents?.importBoot && Array.isArray(context.boots)) {
      // Import before policy evaluation, so one boot does not also create a
      // duplicate generic incident. A guarded ledger close suppresses this
      // old occurrence without ever changing the OS-owned evidence file.
      const unresolved = [];
      for (const record of context.boots) {
        try { if (!(await incidents.importBoot(record)).closed) unresolved.push(record); }
        catch { unresolved.push(record); onError('OS incident could not be imported'); }
      }
      context = { ...context, boots: unresolved };
    }
    const previous = new Map((snapshot?.invariants ?? []).map(i => [i.id, i]));
    const invariants = [];
    for (const definition of registry) {
      if (definition.independent) continue; // The HTTP handler owns this check.
      const { check, ...metadata } = definition;
      let answer;
      try { answer = await within(Promise.resolve().then(() => check(context)), 2000); if (!STATES.includes(answer?.state)) throw new Error('invalid check'); }
      catch { answer = unknown(`The ${definition.title.toLowerCase()} check could not read its evidence.`); }
      answer = { ...answer, reason: String(answer.reason || 'No cause declared.').slice(0, 500), evidence: compact(answer.evidence) };
      const before = previous.get(definition.id), sameState = before?.state === answer.state;
      const transitions = [...(before?.transitions ?? []), ...(!sameState ? [{ when: new Date(started).toISOString(), from: before?.state ?? 'unknown', to: answer.state }] : [])].slice(-32);
      const flaps = Object.fromEntries(Object.entries(before?.flaps ?? {}).filter(([hour]) => Date.parse(hour) >= started - 48 * 3600_000));
      if (before && !sameState) { const hour = `${new Date(started).toISOString().slice(0, 13)}:00:00Z`; flaps[hour] = (flaps[hour] ?? 0) + 1; }
      const item = { ...metadata, ...answer, since: answer.since || (sameState ? before.since : new Date(started).toISOString()), transitions, flaps, consecutiveCrit: answer.state === 'crit' ? (before?.consecutiveCrit ?? 0) + 1 : 0 };
      if (item.consecutiveCrit >= 2 && incidents) {
        try {
          const open = (await incidents.list()).find(i => !i.closed && i.invariant === item.id);
          if (!open) await incidents.open({ title: item.title, invariant: item.id, reason: item.reason, evidence: item.evidence });
        } catch { item.incidentError = 'Incident ledger could not record this critical invariant; inspect its capacity and permissions.'; onError('incident ledger could not record a critical invariant'); }
      }
      invariants.push(item);
    }
    snapshot = { version: 1, host, checked: new Date(started).toISOString(), durationMs: now() - started, invariants };
    await atomicJson(join(stateDir, 'status.json'), snapshot);
    return snapshot;
  }
  return { ready, snapshot: () => snapshot && structuredClone(snapshot), tick() { return running ??= pass().catch(() => { onError('doctor could not publish its pass'); return null; }).finally(() => { running = null; }); }, start(every = minute) { void this.tick(); timer = setInterval(() => void this.tick(), every); timer.unref?.(); }, stop() { clearInterval(timer); } };
}
