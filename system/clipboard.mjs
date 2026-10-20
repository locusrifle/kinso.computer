// The clipboard's history and the screenshots, for this computer's own screen
// (apps/code/native/public/js/clipboard.js). imperfect OS keeps the history
// with cliphist, fed by wl-paste as things are copied, and its screenshot key
// saves into ~/Pictures/screenshots and says so here (imperfect-os,
// modules/desktop-tools.nix). A computer without cliphist has no history: 404,
// and the page draws nothing for it.
//
//   GET  /clipboard               what was copied, newest first
//   GET  /clipboard/<id>          one of them whole: the text, or the picture
//   POST /clipboard {do, ...}     delete {id} | wipe | forget {text}; answers
//                                 with the history after it
//   POST /screenshots {taken}     the screenshot key took one (the capture
//                                 script); this screen's windows are told
//   GET  /screenshots/<name>      a screenshot
//   POST /screenshots {delete}    gone, from the folder and from the history
//
// Only for the person at this screen, exactly as the system controls
// (controls.mjs refusal): this server's loopback name, a connection of this
// same user, imperfect's own page; never through /peer/ (server.mjs), never on
// a hosted computer. What was copied is never logged or kept here.

import { readFile, stat, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { refusal, runTool } from './controls.mjs';

// Long enough to recognise a line; the whole thing is one request away.
const PREVIEW = 240;
const SHOT = /^[\w][\w.-]{0,120}\.png$/;
const IMAGE = /^\[\[ binary data (\d+ (?:B|KiB|MiB)) (\w+) (\d+)x(\d+) \]\]$/;
const fail = (status, message) => Object.assign(new Error(message), { status });

// `cliphist list`: one line per item, newest first, "<id>\t<preview>"; a
// picture's preview is "[[ binary data <size> <format> <w>x<h> ]]".
export function parseList(text, limit = 200) {
  const items = [];
  for (const line of String(text ?? '').split('\n')) {
    const tab = line.indexOf('\t');
    const id = line.slice(0, tab);
    if (tab < 1 || !/^\d+$/.test(id)) continue;
    const preview = line.slice(tab + 1);
    const image = IMAGE.exec(preview);
    items.push(image
      ? { id, kind: 'image', size: image[1], format: image[2], width: Number(image[3]), height: Number(image[4]) }
      : { id, kind: 'text', text: preview });
    if (items.length >= limit) break;
  }
  return items;
}

// What a stored item is, from its first bytes: a picture's type, or text.
export function itemType(bytes) {
  const head = bytes.subarray(0, 4).toString('latin1');
  if (head === '\x89PNG') return 'image/png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'image/jpeg';
  if (head === 'GIF8') return 'image/gif';
  if (head.startsWith('BM')) return 'image/bmp';
  if (head === 'II*\0' || head === 'MM\0*') return 'image/tiff';
  return 'text/plain; charset=utf-8';
}

// A PNG's size, from its header.
export const pngSize = bytes => (bytes.length >= 24 && itemType(bytes) === 'image/png' ? { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) } : null);

// The text cliphist would show for it: spaces folded, ends trimmed.
const folded = text => text.trim().split(/\s+/).filter(Boolean).join(' ');

export function createClipboard({
  run = runTool,
  hosted = false,
  refuse = req => refusal(req, { hosted }),
  env = process.env,
  shots = join(homedir(), 'Pictures', 'screenshots'),
  onShot = () => {},
  onBegin = () => {},
} = {}) {
  const captures = new Map();
  const locked = async () => Boolean(await stat(join(env.XDG_RUNTIME_DIR || `/run/user/${process.getuid?.()}`, 'imperfect-lock', 'held')).catch(() => null));
  // The history imperfect OS keeps lives in memory ($XDG_RUNTIME_DIR, gone at
  // logout); elsewhere, cliphist's own place.
  async function database() {
    if (env.CLIPHIST_DB_PATH) return env.CLIPHIST_DB_PATH;
    const kept = env.XDG_RUNTIME_DIR ? join(env.XDG_RUNTIME_DIR, 'cliphist') : '';
    return kept && (await stat(kept).then(found => found.isDirectory(), () => false)) ? join(kept, 'db') : '';
  }
  async function cliphist(args, options) {
    const db = await database();
    const result = await run('cliphist', [...(db ? ['-db-path', db] : []), ...args], options);
    if (result.missing) throw fail(404, 'no clipboard history on this computer');
    return result;
  }
  async function list(width = PREVIEW) {
    const result = await cliphist(['-preview-width', String(width), 'list']);
    // Nothing copied yet: cliphist has no database to open.
    if (!result.ok && /store something first/.test(result.stderr)) return [];
    if (!result.ok) throw fail(502, 'the clipboard history did not open');
    return parseList(result.stdout);
  }
  async function decode(id) {
    const result = await cliphist(['decode', id], { bytes: true });
    return result.ok ? result.stdout : null;
  }
  async function remove(ids) {
    if (!ids.length) return;
    const result = await cliphist(['delete'], { input: ids.map(id => `${id}\n`).join('') });
    if (!result.ok) throw fail(502, 'it was not deleted');
  }
  // Every item that is these bytes exactly, found by its preview first.
  async function matching(bytes, candidate) {
    const found = [];
    for (const item of (await list(candidate.width ?? PREVIEW)).filter(candidate.test)) {
      const whole = await decode(item.id);
      if (whole && whole.equals(bytes)) found.push(item.id);
    }
    return found;
  }

  async function act(body) {
    const what = String(body?.do ?? '');
    if (what === 'delete') {
      const id = String(body.id ?? '');
      if (!/^\d{1,19}$/.test(id)) throw fail(400, 'no such item');
      await remove([id]);
    } else if (what === 'wipe') {
      const result = await cliphist(['wipe']);
      if (!result.ok && !/store something first/.test(result.stderr)) throw fail(502, 'the history was not cleared');
    } else if (what === 'forget') {
      // Something that must not be kept (a Wi-Fi password pasted into the
      // system panel): every copy of exactly it.
      const text = typeof body.text === 'string' ? body.text : '';
      const shown = folded(text);
      if (!shown) throw fail(400, 'nothing to forget');
      const width = Math.max(PREVIEW, [...shown].length + 1);
      await remove(await matching(Buffer.from(text), { width, test: item => item.kind === 'text' && item.text === shown }));
    } else throw fail(400, 'unknown clipboard action');
    return { items: await list() };
  }

  async function shot(body) {
    if (body.begin) {
      for (const [id, capture] of captures) if (Date.now() - capture.at > 600_000) captures.delete(id);
      if (captures.size >= 128) captures.delete(captures.keys().next().value);
      const capture = randomUUID();
      let claimed;
      const ready = new Promise(resolve => { claimed = resolve; });
      captures.set(capture, { at: Date.now(), window: null, done: false, claimed });
      onBegin(capture);
      // The selector may take focus only after the native window fenced its
      // draft, or this short offline/no-window deadline elapsed.
      const timer = setTimeout(claimed, 500);
      await ready;
      clearTimeout(timer);
      return { capture };
    }
    if (body.claim) {
      const capture = captures.get(body.claim);
      if (!capture || capture.done || Date.now() - capture.at > 600_000) throw fail(409, 'capture expired');
      if (typeof body.window !== 'string' || !/^[\w-]{1,80}$/.test(body.window)) throw fail(400, 'no window');
      capture.window ??= body.window;
      capture.claimed();
      return { claimed: capture.window === body.window };
    }
    const name = String(body?.taken ?? body?.delete ?? '');
    if (!SHOT.test(name)) throw fail(400, 'no such screenshot');
    const path = join(shots, name);
    const file = await stat(path).catch(() => null);
    if (!file?.isFile()) throw fail(404, 'no such screenshot');
    if (body.taken) {
      const capture = captures.get(body.capture);
      if (body.capture && (!capture || Date.now() - capture.at > 600_000)) throw fail(409, 'capture expired');
      if (!capture?.done) onShot(name, capture ? { capture: body.capture, window: capture.window } : {});
      if (capture) capture.done = true;
      return { taken: name };
    }
    // Deleted, and the copy the screenshot key put in the history with it.
    const bytes = await readFile(path);
    await unlink(path);
    const size = pngSize(bytes);
    if (size) await remove(await matching(bytes, { test: item => item.kind === 'image' && item.format === 'png' && item.width === size.width && item.height === size.height }).catch(() => []));
    return { deleted: name };
  }

  const json = (res, status, value) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify(value));
  };
  const bytes = (res, type, body) => {
    res.writeHead(200, { 'content-type': type, 'content-length': body.length, 'cache-control': 'no-store', 'content-security-policy': "default-src 'none'; sandbox" });
    res.end(body);
  };
  async function readBody(req) {
    let raw = '';
    req.setEncoding('utf8');
    for await (const chunk of req) { raw += chunk; if (raw.length > 8192) throw fail(413, 'too long'); }
    try { return JSON.parse(raw || '{}'); } catch { throw fail(400, 'not JSON'); }
  }

  async function handle(req, res, path) {
    const [, root, item = '', extra] = /^\/(clipboard|screenshots)(?:\/([^/]*))?(\/.*)?$/.exec(path) ?? [];
    if (!root) return false;
    const why = await refuse(req);
    if (why) { json(res, 403, { error: why }); return true; }
    try {
      if (await locked()) throw fail(403, 'screen is locked');
      if (extra !== undefined) throw fail(404, 'not found');
      if (req.method === 'GET' && root === 'clipboard' && !item) { json(res, 200, { items: await list() }); return true; }
      if (req.method === 'GET' && root === 'clipboard') {
        if (!/^\d{1,19}$/.test(item)) throw fail(404, 'no such item');
        const whole = await decode(item);
        if (!whole) throw fail(404, 'no such item');
        bytes(res, itemType(whole), whole);
        return true;
      }
      if (req.method === 'GET' && root === 'screenshots' && item) {
        if (!SHOT.test(item)) throw fail(404, 'no such screenshot');
        const body = await readFile(join(shots, item)).catch(() => null);
        if (!body) throw fail(404, 'no such screenshot');
        bytes(res, 'image/png', body);
        return true;
      }
      if (req.method !== 'POST' || item) throw fail(405, 'not here');
      const body = await readBody(req);
      json(res, 200, root === 'clipboard' ? await act(body) : await shot(body));
    } catch (error) {
      if (!res.headersSent) json(res, error.status || 500, { error: error.status ? error.message : 'it did not work' });
    }
    return true;
  }

  // Whether a window's socket is this screen's own (screenshots are told
  // only to those).
  const own = async req => !(await refuse(req).catch(() => 'no'));
  return { handle, own };
}
