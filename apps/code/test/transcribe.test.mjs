import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough, Readable } from 'node:stream';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MODEL_DIR, createTranscriber, decodeAudio, pieces, resolveFFmpeg } from '../../../system/transcribe.mjs';

const transcriberWithReference = options => createTranscriber({ openAudio: async prompt => Readable.from([Buffer.from(prompt.audio, 'base64')]), ...options });
const audioRequest = (base, audio) => ({ method: 'POST', headers: { origin: base, 'content-type': 'application/json' }, body: JSON.stringify({ audio: Buffer.from(audio).toString('base64') }) });

async function executable(dir) {
  await mkdir(dir, { recursive: true });
  const file = join(dir, 'ffmpeg');
  await writeFile(file, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  return file;
}

test('ffmpeg lookup honours configuration and PATH before stable Nix profiles', async t => {
  const root = await mkdtemp(join(tmpdir(), 'voice-path-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const pathBin = join(root, 'path'), profileBin = join(root, 'profile');
  const inPath = await executable(pathBin), inProfile = await executable(profileBin);
  const lookup = { env: { PATH: pathBin }, profileBins: [profileBin] };
  assert.equal(resolveFFmpeg(lookup), inPath);
  assert.equal(resolveFFmpeg({ ...lookup, env: { PATH: pathBin, IMPERFECT_FFMPEG: inProfile } }), inProfile);
  assert.equal(resolveFFmpeg({ ...lookup, env: { PATH: join(root, 'missing') } }), inProfile, 'a stripped service PATH still finds the profile');
  await chmod(inPath, 0o600);
  assert.equal(resolveFFmpeg(lookup), inProfile, 'a non-executable PATH entry is skipped');
  await rm(inPath);
  await mkdir(inPath);
  assert.equal(resolveFFmpeg(lookup), inProfile, 'a directory is not an executable');
  assert.throws(() => resolveFFmpeg({ ...lookup, env: { PATH: pathBin, IMPERFECT_FFMPEG: join(root, 'missing') } }), error => error.status === 503 && /IMPERFECT_FFMPEG/.test(error.message), 'bad explicit config is not silently ignored');
  assert.throws(() => resolveFFmpeg({ ...lookup, env: { IMPERFECT_FFMPEG: 'ffmpeg' } }), /absolute path/);
});

test('ffmpeg is rediscovered after installation and in a user Nix profile', async t => {
  const home = await mkdtemp(join(tmpdir(), 'voice-home-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const bin = join(home, 'bin');
  const lookup = { env: { PATH: bin }, profileBins: [] };
  assert.throws(() => resolveFFmpeg(lookup), error => error.status === 503 && /install ffmpeg/.test(error.message));
  const installed = await executable(bin);
  assert.equal(resolveFFmpeg(lookup), installed, 'the next retry sees the installation');
  const profile = await executable(join(home, '.nix-profile/bin'));
  assert.equal(resolveFFmpeg({ home, env: { PATH: join(home, 'missing') } }), profile);
  const modernProfile = await executable(join(home, '.local/state/nix/profile/bin'));
  await chmod(profile, 0o600);
  assert.equal(resolveFFmpeg({ home, env: { PATH: join(home, 'missing') } }), modernProfile);
});

test('a missing or unlaunchable decoder is a service error, never words', async t => {
  const root = await mkdtemp(join(tmpdir(), 'voice-decoder-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const command = await executable(root);
  for (const code of ['ENOENT', 'EACCES', 'ENOEXEC']) {
    const child = new EventEmitter();
    child.stdout = new PassThrough(); child.stderr = new PassThrough();
    await assert.rejects(decodeAudio('recording', { env: { IMPERFECT_FFMPEG: command }, spawnImpl: (path, args) => {
      assert.equal(path, command);
      assert.ok(args.includes('recording'));
      setImmediate(() => { child.emit('error', Object.assign(new Error(`spawn ffmpeg ${code}`), { code })); child.emit('close', -2); });
      return child;
    } }), error => error.status === 503 && /ffmpeg could not start/.test(error.message));
  }
  await writeFile(join(root, 'tokens.txt'), '');
  const { forks, forkImpl } = fakeWorker();
  const transcribe = transcriberWithReference({ modelDir: root, forkImpl, decodeAudio: file => decodeAudio(file, { env: { PATH: join(root, 'missing') }, profileBins: [] }) });
  const { base, close } = await serve(transcribe);
  try {
    const res = await fetch(`${base}/transcribe`, audioRequest(base, wav()));
    assert.equal(res.status, 503);
    assert.match((await res.json()).error, /ffmpeg is not available/);
    assert.equal(forks.length, 0, 'nothing was handed to the recognizer');
  } finally { await close(); }
});

test('the Nix system decoder works even with a stripped service PATH', async t => {
  const bin = '/run/current-system/sw/bin';
  if (!existsSync(join(bin, 'ffmpeg'))) return t.skip('no Nix system ffmpeg');
  const root = await mkdtemp(join(tmpdir(), 'voice-nix-decode-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, 'audio');
  await writeFile(file, wav());
  const samples = await decodeAudio(file, { env: { PATH: join(root, 'missing') }, profileBins: [bin] });
  assert.equal(samples.length, 16000);
  assert.ok(samples.every(sample => sample === 0));
});

test('long audio is heard in half-minute pieces, each cut at a quiet moment', () => {
  const rate = 16000;
  const samples = new Float32Array(75 * rate).fill(0.5);
  // A silence a second before the first half-minute ends.
  samples.fill(0, 29 * rate, 29 * rate + 800);
  const parts = pieces(samples);
  assert.equal(parts.length, 3);
  assert.ok(Math.abs(parts[0].length - 29 * rate) < 800, 'the first piece ends in the silence');
  assert.equal(parts.reduce((sum, part) => sum + part.length, 0), samples.length, 'nothing is lost between pieces');
  assert.deepEqual(pieces(new Float32Array(rate)).map(part => part.length), [rate], 'a short recording is one piece');
});

async function serve(transcribe) {
  const server = createServer(async (req, res) => { if (!await transcribe(req, res, new URL(req.url, 'http://x').pathname)) res.writeHead(418).end(); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { base: `http://127.0.0.1:${server.address().port}`, close: () => new Promise(resolve => server.close(resolve)) };
}

test('without the model it says so, and other paths are not answered', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'no-model-'));
  const { base, close } = await serve(transcriberWithReference({ modelDir: dir }));
  try {
    const res = await fetch(`${base}/transcribe`, audioRequest(base, 'x'));
    assert.equal(res.status, 503);
    assert.match((await res.json()).error, /voice model is not on this computer/);
    assert.equal((await fetch(`${base}/elsewhere`)).status, 418);
  } finally { await close(); await rm(dir, { recursive: true, force: true }); }
});

const wavs = existsSync(join(MODEL_DIR, 'test_wavs')) ? readdirSync(join(MODEL_DIR, 'test_wavs')).filter(name => name.endsWith('.wav')) : [];
test('a recording comes back as its words', { skip: !wavs.length && 'the voice model is not on this computer' }, async () => {
  const { base, close } = await serve(transcriberWithReference({ idleMs: 100 }));
  try {
    const res = await fetch(`${base}/transcribe`, audioRequest(base, readFileSync(join(MODEL_DIR, 'test_wavs', wavs[0]))));
    const answer = await res.json();
    assert.equal(res.status, 200, answer.error);
    assert.ok(answer.text.split(/\s+/).length > 3, answer.text);
    const junk = await fetch(`${base}/transcribe`, audioRequest(base, 'not audio at all'));
    assert.equal(junk.status, 422);
    assert.match((await junk.json()).error, /could not read that audio/);
  } finally { await close(); }
});

// The worker holding the model, as far as createTranscriber talks to it: it
// answers each job with how much it was handed, the way the real one answers
// with words.
function fakeWorker() {
  const forks = [], jobs = [];
  const forkImpl = (path, args, options) => {
    const worker = new EventEmitter();
    worker.send = job => { jobs.push(job); setImmediate(() => worker.emit('message', { id: job.id, text: `heard ${job.pieces.reduce((n, piece) => n + piece.length, 0)} samples` })); };
    worker.kill = () => worker.emit('exit');
    forks.push({ path, args, options });
    return worker;
  };
  return { forks, jobs, forkImpl };
}

// A second of 16 kHz mono silence as a WAV, for ffmpeg to read.
function wav(seconds = 1, rate = 16000) {
  const data = Buffer.alloc(seconds * rate * 2);
  const head = Buffer.alloc(44);
  head.write('RIFF', 0); head.writeUInt32LE(36 + data.length, 4); head.write('WAVE', 8);
  head.write('fmt ', 12); head.writeUInt32LE(16, 16); head.writeUInt16LE(1, 20); head.writeUInt16LE(1, 22);
  head.writeUInt32LE(rate, 24); head.writeUInt32LE(rate * 2, 28); head.writeUInt16LE(2, 32); head.writeUInt16LE(16, 34);
  head.write('data', 36); head.writeUInt32LE(data.length, 40);
  return Buffer.concat([head, data]);
}

// Without the model too: hear() takes a stream to the worker and back, as
// /dictate uses it and /transcribe answers with it. ffmpeg decodes when it is
// here; where it is not, a stand-in hands over the same second of samples.
test('a recording goes from a stream to the worker and comes back as its words', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'model-'));
  await writeFile(join(dir, 'tokens.txt'), '');
  const { forks, jobs, forkImpl } = fakeWorker();
  const ffmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
  const transcribe = transcriberWithReference({ modelDir: dir, idleMs: 50, forkImpl, ...(ffmpeg ? {} : { decodeAudio: async () => new Float32Array(16000) }) });
  try {
    assert.deepEqual(await transcribe.hear(Readable.from([wav()])), { text: 'heard 16000 samples', seconds: 1 });
    assert.equal(forks.length, 1);
    assert.match(forks[0].path, /transcribe-worker\.mjs$/);
    assert.deepEqual(forks[0].args, [dir]);
    assert.equal(jobs.length, 1);
    const { base, close } = await serve(transcribe);
    try {
      const res = await fetch(`${base}/transcribe`, audioRequest(base, wav()));
      assert.deepEqual(await res.json(), { text: 'heard 16000 samples', seconds: 1 });
    } finally { await close(); }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

// Recorder exports AAC in an M4A container. Exercise the actual CPU codec
// path without requiring somebody's recording or a paid recognizer.
test('an exported M4A decodes through the existing transcription service', async t => {
  let ffmpeg;
  try { ffmpeg = resolveFFmpeg(); }
  catch { return t.skip('ffmpeg is not installed'); }
  const dir = await mkdtemp(join(tmpdir(), 'recorder-m4a-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const audio = join(dir, 'meeting.m4a');
  const made = spawnSync(ffmpeg, ['-v', 'error', '-threads', '1', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.5', '-c:a', 'aac', '-threads', '1', audio], { timeout: 10000 });
  assert.equal(made.status, 0, made.stderr?.toString());
  await writeFile(join(dir, 'tokens.txt'), '');
  const { jobs, forkImpl } = fakeWorker();
  const transcribe = transcriberWithReference({ modelDir: dir, idleMs: 50, forkImpl });
  const { base, close } = await serve(transcribe);
  try {
    const res = await fetch(`${base}/transcribe`, audioRequest(base, readFileSync(audio)));
    const answer = await res.json();
    assert.equal(res.status, 200, answer.error);
    assert.match(answer.text, /^heard \d+ samples$/);
    const samples = jobs[0].pieces.reduce((n, part) => n + part.length, 0);
    assert.ok(samples >= 8000 && samples < 10000, `half-second of decoded 16 kHz audio: ${samples}`);
  } finally { await close(); }
});
