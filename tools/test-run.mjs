// Run independent unit files concurrently, browser files serially. The shared
// launcher also holds the machine-wide browser lease.
// --changed deliberately does not promise a dependency graph: only tracked,
// test-only edits can narrow the run. Product/config/assets need all suites.
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
export const SUITES = ['apps/code/native/test', 'apps/code/test', 'locker/test', 'desktop/client/build'];
export const testFiles = () => SUITES.flatMap(dir => readdirSync(join(root, dir)).filter(name => name.endsWith('.test.mjs')).sort().map(name => join(dir, name)));
const source = file => readFileSync(join(root, file), 'utf8');
const inTests = file => SUITES.some(dir => file.startsWith(`${dir}/`));
const BROWSER = new Set(['playwright', 'electron', 'tools/test-browser.mjs', 'tools/imperfect-browser.mjs']);
const SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*)['"]([^'"]+)['"]/g;

// Follow test fixtures, not product imports: a server may offer a browser
// without a unit test launching one. This is scheduling, not coverage selection.
export function drivesBrowser(file, { read = source } = {}, seen = new Set()) {
  if (BROWSER.has(file)) return true;
  if (seen.has(file)) return false;
  seen.add(file);
  let text;
  try { text = read(file); }
  catch (error) {
    // Source-code snippets in tests can look like imports relative to the
    // test itself. Unresolved fixture references take the serial lane.
    if (error.code === 'ENOENT') return true;
    throw error;
  }
  if (/(?:browser|chromium).*\.test\.mjs$/.test(file) || /launchChromium|launchImperfectBrowser|startPrivate|chromium\.launch|enginePath/.test(text)) return true;
  for (const [, spec] of text.matchAll(SPECIFIER)) {
    const next = spec.startsWith('.') ? relative(root, resolve(root, dirname(file), spec)) : spec;
    if (BROWSER.has(next)) return true;
    if ((inTests(next) || next.startsWith('tools/')) && drivesBrowser(next, { read }, seen)) return true;
  }
  return false;
}

export function testsFor(changed, tests = testFiles(), { untracked = [] } = {}) {
  if (untracked.length) throw new Error('Untracked changes have no established coverage. Review them and run explicit test paths (or npm test); nothing was verified.');
  if (changed.some(file => file.startsWith('phone/'))) throw new Error('Phone changes need node --test phone/tests/*.test.mjs and real-device checks; this runner cannot verify them.');
  if (!changed.length) return [];
  if (changed.every(file => tests.includes(file))) return tests.filter(file => changed.includes(file));
  const known = file => /^(?:apps|system|tools|locker|desktop|website)\//.test(file)
    || /^(?:package(?:-lock)?\.json|AGENTS\.md|install\.sh|[^/]+\.(?:mjs|js|cjs|json))$/.test(file);
  if (!changed.every(known)) throw new Error('Unknown changed paths: choose explicit tests after review; nothing was verified.');
  return tests; // No partial basename/import matches can suppress this fallback.
}

function changedFiles() {
  // Git failure must not masquerade as a clean checkout. Without an upstream,
  // compare the working tree to HEAD; committed branch work needs explicit tests.
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  let base = 'HEAD';
  try { base = git('merge-base', 'HEAD', '@{upstream}'); } catch { /* local-only branch */ }
  const untracked = git('ls-files', '--others', '--exclude-standard').split('\n').filter(Boolean);
  return { paths: [...new Set([...git('diff', '--name-only', base).split('\n').filter(Boolean), ...untracked])], untracked };
}

function run(files, concurrency) {
  if (!files.length) return Promise.resolve(0);
  return new Promise(done => {
    const child = spawn(process.execPath, ['--test', `--test-concurrency=${concurrency}`, ...files], { cwd: root, stdio: 'inherit' });
    child.once('error', error => { console.error(error.message); done(1); });
    child.once('exit', code => done(code ?? 1));
  });
}

if (import.meta.main) {
  try {
    const args = process.argv.slice(2);
    if (args.includes('--changed') && args.length !== 1) throw new Error('Use --changed alone, or explicit test files.');
    let files;
    if (args[0] === '--changed') {
      const { paths, untracked } = changedFiles();
      files = testsFor(paths, testFiles(), { untracked });
      console.log('Changed selection: tracked test-only edits narrow the run; all other supported edits run every repository suite. Without an upstream, only differences from HEAD are considered.');
    } else files = args.length ? args.map(file => relative(root, resolve(file))) : testFiles();
    if (!files.length) { console.log('No changes relative to the comparison base; no tests ran (not a verification).'); process.exit(0); }
    if (files.some(file => !file.endsWith('.test.mjs') || !existsSync(join(root, file)))) throw new Error('Expected existing .test.mjs file paths.');
    const browser = files.filter(file => drivesBrowser(file)), plain = files.filter(file => !browser.includes(file));
    console.log(`${plain.length} test files without a browser, then ${browser.length} with one (serial)`);
    const failed = (await run(plain, Math.min(8, Math.max(1, availableParallelism() - 2)))) | (await run(browser, 1));
    process.exit(failed ? 1 : 0);
  } catch (error) { console.error(error.message); process.exit(1); }
}
