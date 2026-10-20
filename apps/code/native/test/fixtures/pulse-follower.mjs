import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createFollow } from '../../../../../system/follow.mjs';
import { invariantRegistry } from '../../../../../system/doctor.mjs';
export async function pausedFollower() {
  const dir = await mkdtemp(join(tmpdir(), 'pulse-follower-')), pc = join(dir, 'pc'), here = join(dir, 'laptop'), store = join(dir, 'origin.git'), stateDir = join(dir, 'state');
  const env = { ...process.env, GIT_AUTHOR_NAME: 'test', GIT_COMMITTER_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@example.invalid', GIT_COMMITTER_EMAIL: 'test@example.invalid' };
  const git = (root, ...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  try {
    execFileSync('git', ['init', '--bare', '--quiet', '--initial-branch=main', store], { env });
    execFileSync('git', ['clone', '--quiet', store, pc], { env, stdio: 'ignore' });
    await writeFile(join(pc, 'base'), 'base'); git(pc, 'add', '.'); git(pc, 'commit', '-qm', 'base'); git(pc, 'push', '-q', 'origin', 'main');
    execFileSync('git', ['clone', '--quiet', store, here], { env, stdio: 'ignore' });
    await writeFile(join(here, 'local'), 'a personal commit'); git(here, 'add', '.'); git(here, 'commit', '-qm', 'local work');
    await writeFile(join(pc, 'new-main'), 'authority update'); git(pc, 'add', '.'); git(pc, 'commit', '-qm', 'new main'); git(pc, 'push', '-q', 'origin', 'main');
    let restarts = 0;
    const follow = createFollow({ root: here, stateDir, busy: () => false, restart: async () => { restarts++; }, log: () => {} });
    await follow.tick();
    const state = JSON.parse(await readFile(join(stateDir, 'computer-update.json'), 'utf8'));
    const [ahead, behind] = git(here, 'rev-list', '--left-right', '--count', 'HEAD...origin/main').split(/\s+/).map(Number);
    const definition = invariantRegistry().find(i => i.id === 'follower-drift'), { check, ...metadata } = definition;
    const answer = check({ now: Date.now(), follower: { ...state, ahead, behind, branch: 'main', dirty: false } });
    return { dir, here, state, restarts, invariant: { ...metadata, ...answer }, close: () => rm(dir, { recursive: true, force: true }) };
  } catch (error) { await rm(dir, { recursive: true, force: true }); throw error; }
}
