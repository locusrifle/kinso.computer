// One machine of the mind. It binds loopback; `tailscale serve` is the only
// way in, and the tailnet is what tells it who else is in the mind.
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMachines, solitaryMachines } from './machines.mjs';
import { createFollow, followsMain, packagesToInstall } from './follow.mjs';
import { ensureDataDirs, readConfig, resolvePrefix } from './machine.mjs';
import { createDoctor, createObserver, invariantRegistry } from './doctor.mjs';
import { createIncidentLedger, createWorkerLedger } from './pulse-ledger.mjs';

const here = dirname(fileURLToPath(import.meta.url));

// Packages are installed here, before anything loads them, so a new lockfile
// (an update committed on the PC, or main followed from it) takes effect
// between one run and the next, never under a running session. On Mac, use
// the installer's exact lockfile receipt, including integrity/platform changes
// and removals, not just version differences. A failed rebuild holds startup.
if (process.platform === 'darwin') {
  const { installMacPackages } = await import('../desktop/mac/packages.mjs');
  installMacPackages(resolve(here, '..'));
}
const missing = process.platform === 'darwin' ? [] : await packagesToInstall(resolve(here, '..'));
if (missing.length) {
  console.log(`imperfect: installing what the lockfile names first: ${missing.slice(0, 5).join(', ')}${missing.length > 5 ? `, and ${missing.length - 5} more` : ''}`);
  try { execFileSync('npm', ['install', '--no-save', '--no-audit', '--no-fund', '--loglevel=error'], { cwd: resolve(here, '..'), stdio: 'inherit', timeout: 600_000 }); }
  catch (error) { console.error(`imperfect: npm install failed (${error.message}); starting with the packages already here, and trying again next start`); }
}
const { createGueyServer } = await import('./server.mjs');

const prefix = resolvePrefix();
const p = await ensureDataDirs(prefix);
const config = await readConfig(prefix);

// Renters stand alone. A hosted member explicitly enrolled with their PC
// uses the same verified peer discovery as other personal computers.
const machines = config.hosted && !config.authority.id ? solitaryMachines() : createMachines();
let follow = null;
let activation = null;
let activationDone = false;
let activationResult = false;
const app = await createGueyServer({
  port: config.port,
  cwd: p.workspace,
  stateDir: p.state,
  agentDir: p.agent,
  sessionDir: p.sessions,
  origins: config.origins,
  machines,
  authority: config.authority,
  hosted: config.hosted,
  inboxSetting: config.inbox,
  inbox: { keyFile: resolve(prefix, 'credentials', 'unipile.json'), tokenFile: resolve(prefix, 'credentials', 'inbox-token') },
  // The computers the PC lends Messages to, if any (system/inbox-lend.mjs).
  lendFile: resolve(prefix, 'credentials', 'inbox-lend.json'),
  // Runs under the existing handoff's final idle fence, not a second updater.
  restart: async () => {
    const take = activation;
    activation = null;
    if (take && await take() === false) {
      activationResult = false;
      activationDone = true;
      return false;
    }
    activationResult = true;
    activationDone = true;
    process.kill(process.pid, 'SIGTERM');
  },
  notify: { dir: resolve(prefix, 'push'), credentials: resolve(prefix, 'credentials') },
  deviceHandsTokenFile: config.deviceHandsTokenFile,
  deviceHandsAccount: config.deviceHandsAccount,
});
const address = await app.listen();
const registry = invariantRegistry();
const incidents = createIncidentLedger({ stateDir: p.state, memoryDir: resolve(prefix, 'memory'), registry });
const workers = createWorkerLedger({ stateDir: p.state, memoryDir: resolve(prefix, 'memory') });
const doctor = createDoctor({ stateDir: p.state, registry, incidents,
  observe: createObserver({ stateDir: p.state, prefix, root: resolve(here, '..'), port: config.port,
    authority: Boolean(config.authority.id && await machines.selfId() === config.authority.id),
    followerEnabled: followsMain(config, await machines.selfId()), listWorkers: () => workers.list() }),
  onError: message => console.error(`pulse: ${message}`) });
doctor.start();
console.log(`imperfect listening on ${address.address}:${address.port} (${p.workspace})`);

// Hosted members follow their store origin too. Self-hosters without an
// authority still update only when asked. All use the same idle handoff.
//
// The handoff fences every tab until all work settles, with no deadline, which
// is right when a person asks for it. An update nobody asked for must never
// hold the window: on 2026-09-29 a closed tab still finishing its turn left
// both open tabs refusing prompts for as long as it ran. So the update counts
// closing tabs as working, and if the fence has not settled within a minute it
// lifts it (resume never aborts a turn) and tries again on a later tick.
const selfId = await machines.selfId().catch(() => '');
if (followsMain(config, selfId)) {
  const quiet = () => {
    const snap = app.runtime.snapshot();
    return !snap.handoff?.settling && !(snap.tabs ?? []).some(tab => tab.status === 'working' || tab.status === 'blocked');
  };
  const restart = async take => {
    activation = take ?? null;
    activationDone = false;
    activationResult = false;
    app.handoff.request(true);
    for (let waited = 0; waited < 60_000; waited += 500) {
      await new Promise(resolve => setTimeout(resolve, 500));
      const { phase } = app.handoff.snapshot();
      if (activationDone) return activationResult;
      // Once activation begins, keep the fence until Git and the receipt have
      // finished; never lift it halfway through a fast-forward.
      if (phase === 'restarting') waited = 0;
      if (phase === 'held') break;
    }
    console.log('follow: the handoff did not settle; delivery resumed, trying again later');
    activation = null;
    app.handoff.resume();
    return false;
  };
  follow = createFollow({ root: resolve(here, '..'), busy: () => !quiet(), restart,
    source: config.authority.gitUrl, idleOnly: true, stateDir: p.state });
  await follow.ready;
  follow.start();
}

// A stop used to close the runtimes the instant the signal arrived, which
// severed whatever turn was mid-flight. The harness then wrote "Request
// interrupted by user" into the transcript -- a sentence about a person who did
// nothing, for work they then had to reconstruct. Restarting to pick up a change
// is routine; silently cancelling a running turn and blaming the reader is not.
//
// Shutdown is unbounded and fail-closed. Recovery deadlines belong to an
// explicitly destructive operator action, not this queue-preserving handoff.
// Orchestrator cancellation should call resumeDelivery(), not abort the turn.
async function settle() {
  const host = app.runtime;
  // Fail closed until the tab host aggregates these hooks over EVERY runtime.
  // Rendered status is not a lifecycle boundary (notably blocked human dialogs).
  if (typeof host.requestQuiesce !== 'function' || typeof host.waitForIdle !== 'function') {
    throw new Error('Tab host lacks durable quiesce/true-idle hooks; refusing automatic shutdown');
  }
  console.log('imperfect: fencing delivery and awaiting natural session settlement');
  await host.requestQuiesce();
  await host.waitForIdle();
}

let closing = false;
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    if (closing) return;
    closing = true;
    try {
      await settle();
      doctor.stop();
      follow?.stop();
      await app.close();
      process.exit(0);
    } catch (error) {
      console.error(`imperfect: shutdown held: ${error.message}`);
      closing = false;
    }
  });
}
