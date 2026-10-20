// Voice into words, on this machine: POST /transcribe with a reference to an audio or
// video file (a recording from the mic in imperfect's dock, or an old one
// attached), and the answer is its text, for the composer. The mic's own
// recordings are heard by the same hear() and sent on as the prompt
// (system/dictate.mjs). The decoder reads a copy from a
// temporary decoder file and deleted; the uploaded original is never deleted.
//
// ffmpeg turns whatever arrives into 16 kHz mono samples, and Parakeet
// (sherpa-onnx, the model in ~/.imperfect/models) turns those into words, in a
// child process: loaded it holds about a gigabyte, so it starts with the
// first request and exits a minute after the last.

import { fork, spawn } from 'node:child_process';
import { accessSync, constants, createWriteStream, existsSync, statSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { homedir, tmpdir, userInfo } from 'node:os';
import { delimiter, isAbsolute, join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';

import { readAttachmentJson } from '../apps/code/native/uploads.mjs';

export const MODEL_DIR = join(homedir(), '.imperfect', 'models', 'parakeet-tdt-0.6b-v2-int8');
const RATE = 16000;

// Long audio is heard in pieces of about half a minute, each ending at the
// quietest moment of its last three seconds, so no word is cut in two.
export function pieces(samples, { rate = RATE, length = 30, search = 3 } = {}) {
  const out = [];
  const size = length * rate, window = search * rate, step = rate / 50;
  let start = 0;
  while (samples.length - start > size) {
    let cut = start + size, quietest = Infinity;
    for (let at = start + size - window; at < start + size; at += step) {
      let energy = 0;
      for (let i = at; i < at + step; i++) energy += samples[i] * samples[i];
      if (energy < quietest) { quietest = energy; cut = at + step / 2; }
    }
    out.push(samples.subarray(start, cut));
    start = cut;
  }
  if (samples.length - start > rate / 10) out.push(samples.subarray(start));
  return out;
}

const unavailable = message => Object.assign(new Error(message), { status: 503 });

// A service need not inherit the person's shell PATH. Honour an explicit
// executable first, then PATH, then Nix's stable profile links (not a pinned
// store path). Resolve on each recording so installing it makes retry work.
export function resolveFFmpeg({
  env = process.env, home = homedir(),
  profileBins = [join(home, '.nix-profile/bin'), join(home, '.local/state/nix/profile/bin'), join('/etc/profiles/per-user', userInfo().username, 'bin'), '/run/current-system/sw/bin'],
} = {}) {
  const executable = file => {
    try { accessSync(file, constants.X_OK); return statSync(file).isFile(); }
    catch { return false; }
  };
  if (env.IMPERFECT_FFMPEG) {
    if (!isAbsolute(env.IMPERFECT_FFMPEG) || !executable(env.IMPERFECT_FFMPEG)) throw unavailable('IMPERFECT_FFMPEG must name an executable absolute path to ffmpeg on this computer');
    return env.IMPERFECT_FFMPEG;
  }
  for (const bin of [...(env.PATH ?? '/usr/bin:/bin').split(delimiter), ...profileBins]) {
    const file = resolve(bin, 'ffmpeg');
    if (executable(file)) return file;
  }
  throw unavailable('ffmpeg is not available to the voice service on this computer; install ffmpeg or set IMPERFECT_FFMPEG to its executable absolute path');
}

export function decodeAudio(file, { spawnImpl = spawn, ...lookup } = {}) {
  const command = resolveFFmpeg(lookup);
  return new Promise((resolve, reject) => {
    const ff = spawnImpl(command, ['-v', 'error', '-i', file, '-vn', '-ac', '1', '-ar', String(RATE), '-f', 'f32le', '-'], { stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks = [];
    let error = '';
    ff.stdout.on('data', chunk => chunks.push(chunk));
    ff.stderr.on('data', chunk => { error += chunk; });
    ff.on('error', error => reject(['ENOENT', 'EACCES', 'ENOEXEC'].includes(error.code)
      ? unavailable('ffmpeg could not start on this computer; check its executable and dependencies, or set IMPERFECT_FFMPEG to a working executable absolute path')
      : error));
    ff.on('close', code => {
      if (code !== 0) return reject(new Error(`could not read that audio: ${error.trim().split('\n').at(-1) || `ffmpeg ${code}`}`));
      const bytes = Buffer.concat(chunks);
      resolve(new Float32Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.length / 4)));
    });
  });
}

// forkImpl and decodeAudio: the worker and ffmpeg, which a test can stand in for.
export function createTranscriber({ modelDir = MODEL_DIR, idleMs = 60_000, forkImpl = fork, decodeAudio: decode = decodeAudio, openAudio } = {}) {
  let worker = null, idle = null, next = 0;
  const waiting = new Map();
  // The worker holding the model, started when first wanted.
  function transcriber() {
    clearTimeout(idle);
    if (worker) return worker;
    worker = forkImpl(new URL('./transcribe-worker.mjs', import.meta.url).pathname, [modelDir], { serialization: 'advanced', stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
    worker.on('message', ({ id, text, error }) => {
      const job = waiting.get(id);
      if (!job) return;
      waiting.delete(id);
      if (error) job.reject(new Error(error)); else job.resolve(text);
      if (!waiting.size) idle = setTimeout(() => { worker?.kill(); }, idleMs);
    });
    worker.on('exit', () => {
      worker = null;
      for (const job of waiting.values()) job.reject(new Error('the transcriber stopped'));
      waiting.clear();
    });
    return worker;
  }
  const words = samples => new Promise((resolve, reject) => {
    const id = ++next;
    waiting.set(id, { resolve, reject });
    transcriber().send({ id, pieces: pieces(samples).map(piece => piece.slice()) });
  });

  // The words in some audio (a stream or bytes): { text, seconds }. Without
  // the model it fails with status 503, as the route answers.
  async function hear(audio) {
    if (!existsSync(join(modelDir, 'tokens.txt'))) throw Object.assign(new Error('the voice model is not on this computer; run ./install.sh again to fetch it'), { status: 503 });
    const dir = await mkdtemp(join(tmpdir(), 'imperfect-voice-'));
    try {
      const file = join(dir, 'audio');
      await pipeline(audio, createWriteStream(file));
      const samples = await decode(file);
      const text = samples.length ? await words(samples) : '';
      return { text, seconds: Math.round(samples.length / RATE) };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  // Answers POST /transcribe; false for anything else.
  async function handle(req, res, path) {
    if (path !== '/transcribe' || req.method !== 'POST') return false;
    const json = (status, value) => { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(value)); };
    if (!req.headers.origin) { json(403, { error: 'exact origin required' }); return true; }
    try {
      const audio = await openAudio(await readAttachmentJson(req));
      try { json(200, await hear(audio)); } finally { audio.destroy(); }
    } catch (error) {
      json(error.status || 422, { error: error.message });
    }
    return true;
  }
  return Object.assign(handle, { hear });
}
