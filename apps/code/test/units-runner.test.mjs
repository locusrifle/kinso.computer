import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { supervise } from '../../../system/units-runner.mjs';

function fixture({ outcomes = [1, 0], restartSeconds = 2, deadline, onPause, onSpawn, empty = async () => true } = {}) {
  const signals = new EventEmitter(), states = [], kills = [], children = [];
  let clock = 1000, cancelled = false;
  const config = { command: ['runner', 'task'], cwd: '/fixture', env: { FIXTURE: 'yes' }, umask: 0o077, restart: 'on-failure', restartSeconds, deadline, stopWaitMs: 100 };
  const dependencies = {
    signals, empty, now: () => clock, cancelled: () => cancelled,
    publish: async state => { states.push(state); },
    pause: async ms => { clock += Math.max(ms, 1); onPause?.({ cancel, signals, clock }); },
    signalGroup: signal => { kills.push(signal); signals.emit(signal); },
    spawnImpl: (program, args, options) => {
      const child = new EventEmitter(); children.push(child);
      assert.equal(program, '/bin/sh'); assert.deepEqual(args.slice(-2), ['runner', 'task']);
      assert.equal(options.detached, undefined); // Same group, led by supervisor, never the worker PID.
      assert.equal(options.env.FIXTURE, 'yes');
      queueMicrotask(() => {
        child.emit('spawn'); onSpawn?.({ child, cancel, signals });
        const outcome = outcomes[children.length - 1];
        if (outcome instanceof Error) child.emit('error', outcome);
        else if (outcome !== undefined) child.emit('close', outcome, outcome === null ? 'SIGKILL' : null);
      });
      return child;
    },
  };
  function cancel() { cancelled = true; }
  return { config, dependencies, states, kills, children, cancel, signals };
}

test('supervisor restarts a crash, exposes activating, and never restarts success', async () => {
  const f = fixture(); await supervise(f.config, f.dependencies);
  assert.equal(f.children.length, 2);
  assert.deepEqual(f.states, ['active', 'activating', 'active', 'inactive']);
  assert.deepEqual(f.kills, ['SIGTERM', 'SIGTERM']); // Descendant cleanup, not cancellation.
  assert.equal(f.signals.listenerCount('SIGTERM'), 0);
});

test('spawn failures and signalled workers also recover with on-failure', async () => {
  for (const outcome of [new Error('ENOENT'), null]) {
    const f = fixture({ outcomes: [outcome, 0] }); await supervise(f.config, f.dependencies);
    assert.equal(f.children.length, 2); assert.equal(f.states.at(-1), 'inactive');
  }
  const f = fixture({ outcomes: [1] }); f.config.restart = 'no';
  await supervise(f.config, f.dependencies); assert.equal(f.children.length, 1); assert.equal(f.states.at(-1), 'failed');
});

test('stop during restart delay is durable even if no signal is delivered', async () => {
  const f = fixture({ onPause: ({ cancel, clock }) => { if (clock > 1001) cancel(); } });
  await supervise(f.config, f.dependencies);
  assert.equal(f.children.length, 1); assert.equal(f.states.at(-1), 'inactive');
});

test('stop during cleanup is not mistaken for the supervisor own cleanup signal', async () => {
  let calls = 0;
  const f = fixture({ empty: async () => ++calls > 1, onPause: ({ cancel, signals }) => { cancel(); signals.emit('SIGTERM'); } });
  await supervise(f.config, f.dependencies);
  assert.equal(f.children.length, 1); assert.equal(f.states.at(-1), 'inactive');
});

test('a running cancellation stops the group and cannot restart the worker', async () => {
  const f = fixture({ outcomes: [], onSpawn: ({ child, cancel, signals }) => { cancel(); signals.emit('SIGTERM'); child.emit('close', null, 'SIGTERM'); } });
  await supervise(f.config, f.dependencies);
  assert.equal(f.children.length, 1); assert.equal(f.states.at(-1), 'inactive'); assert.ok(f.kills.includes('SIGTERM'));
});

test('the original runtime budget covers restart delays and all attempts', async () => {
  const f = fixture({ deadline: 1100, outcomes: [1, 1, 0] });
  await supervise(f.config, f.dependencies);
  assert.equal(f.children.length, 1); assert.equal(f.states.at(-1), 'failed');
  const expired = fixture({ deadline: 999 }); await supervise(expired.config, expired.dependencies);
  assert.equal(expired.children.length, 0);
});

test('a runtime deadline stops a running worker without any app polling', { timeout: 2000 }, async () => {
  const signals = new EventEmitter(), child = new EventEmitter(), states = [], kills = [];
  await supervise({ command: ['runner'], deadline: Date.now() + 20, restart: 'on-failure', stopWaitMs: 100 }, {
    signals, cancelled: () => false, empty: async () => true, publish: async state => { states.push(state); },
    spawnImpl: () => { queueMicrotask(() => child.emit('spawn')); return child; },
    signalGroup: signal => { kills.push(signal); if (signal === 'SIGTERM') queueMicrotask(() => child.emit('close', null, signal)); },
  });
  assert.ok(kills.includes('SIGTERM')); assert.equal(states.at(-1), 'failed');
});

test('a stubborn descendant fails closed rather than overlapping a new attempt', async () => {
  const f = fixture({ empty: async () => false }); await supervise(f.config, f.dependencies);
  assert.equal(f.children.length, 1); assert.equal(f.states.at(-1), 'failed'); assert.ok(f.kills.includes('SIGKILL'));
});
