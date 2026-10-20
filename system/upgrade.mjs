// Pi and Claude Code, kept up to date. Memory's pass runs this when it is
// done, every two hours (system/memory.mjs), so what it did is in that
// service's journal (journalctl --user -u imperfect-memory): each update, from
// which version to which, or why not.
//
// Each comes in two forms:
//
//   - the CLIs headless workers run, pi and claude, through mise, here and on
//     the computers memory reaches (computers.json). mise installs a new
//     version beside the old one, so one already running is untouched.
//   - the packages imperfect runs its sessions with (package.json). A new
//     version is installed and tested in a copy of this checkout, never in
//     it: imperfect's sessions run from its node_modules. If npm test passes
//     there, package.json and the lockfile are committed here (the
//     post-commit hook pushes main, which the laptop follows) and imperfect
//     is asked to restart (tools/restart.mjs), which waits until no agent is
//     working; start.mjs installs the new lockfile before it loads anything.
//     With someone's uncommitted work in the checkout it is left to the next
//     restart, since a restart would start running that too.
//     If the tests fail, nothing here changes, and the journal says which.
//     So that it is not stuck there unseen, the failing tests and versions
//     are also written to open/upgrade.md in memory's folder (report), where
//     Pulse's doctor counts it once it is a week old; it is taken away once
//     the tests pass with them, or there is nothing to take.
//
// A version is taken as soon as it is out: the tests are the gate, not its age.
//
//   node system/upgrade.mjs
import { execFile } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { computers, localTime, memoryDir } from './memory.mjs';

const REPO = resolve(import.meta.dirname, '..');
const CLIS = ['claude', 'pi'];
// Released together, moved together.
const GROUPS = [['@anthropic-ai/claude-agent-sdk'], ['@earendil-works/pi-ai', '@earendil-works/pi-coding-agent', '@earendil-works/pi-durable', '@earendil-works/chord']];
const log = line => console.log(`upgrade: ${line}`);

function run(file, args, options = {}) {
  return new Promise((done, fail) => execFile(file, args, { encoding: 'utf8', maxBuffer: 1 << 26, timeout: 20 * 60_000, ...options },
    (error, stdout, stderr) => (error ? fail(Object.assign(error, { output: `${stdout}\n${stderr}` })) : done(stdout.trim()))));
}

const numbers = version => String(version ?? '0.0.0').split('.').map(Number);
export const newer = (a, b) => { const [x, y] = [numbers(a), numbers(b)]; const i = x.findIndex((n, k) => n !== y[k]); return i >= 0 && x[i] > y[i]; };

// For each group, the newest stable version all of it has, where that is
// newer than the lockfile's. times: { name: what
// `npm view <name> time` answers }, locked: { name: version }.
export function targets(times, locked) {
  const out = {};
  for (const group of GROUPS) {
    const ready = group.map(name => Object.entries(times[name] ?? {}).map(([v]) => v).filter(v => /^\d+\.\d+\.\d+$/.test(v)));
    const best = ready[0].filter(v => ready.every(list => list.includes(v))).reduce((a, v) => (!a || newer(v, a) ? v : a), null);
    // A partially published release, or a local package ahead of the common
    // version, must not split this experimental runtime's compatibility group.
    if (!best || group.some(name => !locked[name] || newer(locked[name], best))) continue;
    for (const name of group) if (newer(best, locked[name])) out[name] = best;
  }
  return out;
}

// `mise current`: a line a tool, its name and version.
const current = text => Object.fromEntries(String(text).split('\n').map(line => line.trim().split(/\s+/)).filter(([tool]) => CLIS.includes(tool)));

export async function clis() {
  for (const { name, run: on } of await computers()) {
    try {
      const before = current(await on('mise current'));
      await on(`mise upgrade ${CLIS.join(' ')}`);
      const after = current(await on('mise current'));
      const moved = CLIS.filter(tool => before[tool] !== after[tool]).map(tool => `${tool} ${before[tool]} → ${after[tool]}`);
      log(`${name}: ${moved.length ? moved.join(', ') : `current (${CLIS.map(tool => `${tool} ${after[tool]}`).join(', ')})`}`);
    } catch (error) {
      log(`${name}: the CLIs were not updated (${error.message})`);
    }
  }
}

// npm test in a checkout: null when it passes. A browser test can miss its
// moment on a busy computer (this runs at low priority, beside memory), so
// the files that failed are tried once more, and only failing again counts:
// answers what failed.
export async function npmTest(cwd) {
  // Run as its own tests, even from inside another test run, and reported as
  // a person reads them (✖ and `test at`): Node 22 reports TAP to a pipe.
  // Own the reporter whose failures we parse. Inheriting any reporter (not
  // just spec), or its destination, can otherwise make Node reject the run
  // before testing. Preserve unrelated NODE_OPTIONS, including quoted values.
  const inherited = process.env.NODE_OPTIONS ?? '';
  const tokens = inherited.match(/(?:[^\s"]+|"(?:\\.|[^"\\])*")+/g) ?? [];
  const kept = [];
  for (let i = 0; i < tokens.length; i++) {
    const option = tokens[i].replace(/^"(.*)"$/, '$1');
    if (/^--test-reporter(?:-destination)?(?:=|$)/.test(option)) {
      if (!option.includes('=')) i++;
    } else kept.push(tokens[i]);
  }
  const nodeOptions = [...kept, '--test-reporter=spec'].join(' ');
  const options = { cwd, env: { ...process.env, NODE_TEST_CONTEXT: undefined, NODE_OPTIONS: nodeOptions } };
  const failures = output => [...new Set(String(output ?? '').split('\n').filter(line => /^\s*✖/.test(line) && !/failing tests:/.test(line)).map(line => line.trim()))].slice(0, 8).join('\n');
  try {
    await run('npm', ['test'], options);
    return null;
  } catch (error) {
    const files = [...new Set([...String(error.output ?? '').matchAll(/^test at (\S+?):\d+:\d+$/gm)].map(match => match[1]))];
    if (!files.length) return failures(error.output) || error.message.split('\n')[0];
    try {
      await run(process.execPath, ['--test', ...files], options);
      log(`packages: passed on a second try: ${failures(error.output).replace(/\s*\n\s*/g, '; ')}`);
      return null;
    } catch (again) {
      return failures(again.output) || again.message.split('\n')[0];
    }
  }
}

// What open/upgrade.md says of an update the tests refuse: a line naming the
// versions, then the tests that failed; with no failure, taken away. Dated
// the day the tests first failed with these versions.
const raisedDir = dir => join(dir, 'open');
export async function report(moves, failed, { dir = memoryDir(), now = Date.now() } = {}) {
  const file = join(raisedDir(dir), 'upgrade.md');
  if (!failed) return rm(file, { force: true });
  const what = `npm test fails with ${moves.join(', ')}`;
  const since = (await readFile(file, 'utf8').catch(() => '')).match(/^- (\d{4}-\d\d-\d\d) upgrade: (.*?);/);
  const date = since?.[2] === what ? since[1] : localTime(now).slice(0, 10);
  await mkdir(raisedDir(dir), { recursive: true, mode: 0o700 });
  await writeFile(file, `- ${date} upgrade: ${what}; not taken until imperfect passes with them (system/upgrade.mjs):\n${failed.split('\n').map(line => `  ${line}`).join('\n')}\n`);
}

export async function packages() {
  const git = (...args) => run('git', ['-C', REPO, ...args]);
  const names = GROUPS.flat();
  const lock = JSON.parse(await readFile(join(REPO, 'package-lock.json'), 'utf8'));
  const locked = Object.fromEntries(names.map(name => [name, lock.packages?.[`node_modules/${name}`]?.version]));
  const times = Object.fromEntries(await Promise.all(names.map(async name => [name, JSON.parse(await run('npm', ['view', name, 'time', '--json']))])));
  const want = targets(times, locked);
  const moves = Object.entries(want).map(([name, version]) => `${name} ${locked[name]} → ${version}`);
  if (!moves.length) return report([], null).then(() => log(`packages: current (${names.map(name => `${name} ${locked[name]}`).join(', ')})`));
  const unchanged = async base => await git('rev-parse', '--abbrev-ref', 'HEAD') === 'main' && !await git('diff', '--name-only', base, '--', 'package.json', 'package-lock.json');
  const base = await git('rev-parse', 'HEAD');
  if (!await unchanged(base)) return log(`packages: ${moves.join(', ')} waits: ~/imperfect is not on main, or its package.json or lockfile has changes of its own`);
  // Beside node_modules, on the same disk, where copying it costs nothing.
  const top = await mkdtemp(join(homedir(), '.cache', 'imperfect-upgrade-')), trial = join(top, 'imperfect');
  try {
    await git('worktree', 'add', '--quiet', '--detach', trial, base);
    await run('cp', ['-a', '--reflink=auto', join(REPO, 'node_modules'), trial]);
    // Each at exactly its version (a range would let npm take a newer one),
    // saved as package.json names it now: with ^, or pinned.
    const { dependencies } = JSON.parse(await readFile(join(trial, 'package.json'), 'utf8'));
    for (const caret of [true, false]) {
      const these = Object.entries(want).filter(([name]) => dependencies[name].startsWith('^') === caret).map(([name, version]) => `${name}@${version}`);
      if (these.length) await run('npm', ['install', ...(caret ? [] : ['--save-exact']), '--no-audit', '--no-fund', '--loglevel=error', ...these], { cwd: trial });
    }
    const failed = await npmTest(trial);
    await report(moves, failed);
    if (failed) return log(`packages: ${moves.join(', ')} not taken, npm test failed with them, twice:\n${failed}`);
    if (!await unchanged(base)) return log(`packages: ${moves.join(', ')} passed the tests but waits: ~/imperfect changed meanwhile`);
    const claude = JSON.parse(await readFile(join(trial, 'node_modules', '@anthropic-ai', 'claude-agent-sdk', 'package.json'), 'utf8')).claudeCodeVersion;
    const named = [want['@anthropic-ai/claude-agent-sdk'] && `Claude Code ${claude ?? want['@anthropic-ai/claude-agent-sdk']}`, want['@earendil-works/pi-coding-agent'] && `Pi Durable ${want['@earendil-works/pi-coding-agent']} (with Chord and Pi auth/resources)`].filter(Boolean);
    try {
      for (const file of ['package.json', 'package-lock.json']) await cp(join(trial, file), join(REPO, file));
      await git('commit', '--quiet', '-m', `Sessions run on ${named.join(' and ')}\n\n${moves.join('\n')}\n\nnpm test passed with them. imperfect installs them when it next restarts, once no agent is working.`, '--', 'package.json', 'package-lock.json');
    } catch (error) {
      await git('checkout', 'HEAD', '--', 'package.json', 'package-lock.json');
      return log(`packages: ${moves.join(', ')} passed the tests but could not be committed, so nothing changed (${String(error.output ?? error.message).trim().split('\n').at(-1)})`);
    }
    const commit = await git('rev-parse', '--short', 'HEAD');
    // A restart runs the checkout as it is: not while someone's work in it is
    // uncommitted. The next restart installs them anyway.
    if (await git('status', '--porcelain', '--untracked-files=no')) return log(`packages: ${moves.join(', ')}; committed ${commit}, installed at imperfect's next restart (~/imperfect has uncommitted changes a restart would start running)`);
    log(`packages: ${moves.join(', ')}; committed ${commit} and asked imperfect to restart`);
    log(await run(process.execPath, [join(REPO, 'tools', 'restart.mjs')]).catch(error => `restart: ${String(error.output ?? error.message).trim()}`));
  } finally {
    await git('worktree', 'remove', '--force', trial).catch(() => {});
    await rm(top, { recursive: true, force: true });
  }
}

if (process.argv[1] === import.meta.filename) {
  await clis();
  await packages().catch(error => log(`packages: ${error.message}`));
}
