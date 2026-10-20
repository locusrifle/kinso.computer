// Workbench's folders, as this computer's own user sees them.
//
//   GET  /files/list?path=      a folder's entries, newest modified first; the home
//                               folder when no path
//   GET  /files/thumbnail?path= a picture, small (made once, kept on disk), for
//                               the grid and the list
//   POST /files/trash {paths}   move each to the desktop's trash (file-actions.mjs)
//   GET  /files/peek?path=      what a file is, to open it: its kind, type and size
//   GET  /files/raw?path=       a file's bytes, streamed, with Range; read only;
//                               &download=1 sends it to be saved, under its name
//   GET  /files/text?path=      a text file of this user's, whole, to edit, and
//                               its version (file-text.mjs)
//   POST /files/text?path=      its new text, over the version in If-Match
//   GET  /files/space?path=     where the disk went: a folder measured four
//                               levels down, for the map, and the disk's free space
//
// Another computer's folders are the same requests through /peer/<id>/, so
// none of this knows which disk it is on. Anything this user can read can be
// listed; a folder it cannot open says so.

import { spawn } from 'node:child_process';
import { constants, createReadStream } from 'node:fs';
import { access, open, readFile, realpath, stat, statfs } from 'node:fs/promises';
import { basename, dirname, extname, join, resolve, sep } from 'node:path';
import { homedir } from 'node:os';
import { createFileActions } from './file-actions.mjs';
import { createFileFeed } from './file-feed.mjs';
import { createFileText } from './file-text.mjs';
import { createThumbnails, pictureMaking } from './thumbnails.mjs';

// path is root, or somewhere under it ('/' holds everything).
export const inside = (path, root) => path === root || path.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);

// What a file is, by its name, wherever imperfect serves one: its own page
// and the pages agents show (shown.mjs).
export const MIME = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json',
  '.wasm': 'application/wasm', '.woff2': 'font/woff2', '.otf': 'font/otf', '.ttf': 'font/ttf',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.avif': 'image/avif', '.bmp': 'image/bmp', '.ico': 'image/x-icon',
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.ogv': 'video/ogg',
  '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.ogg': 'audio/ogg', '.opus': 'audio/ogg', '.wav': 'audio/wav', '.flac': 'audio/flac', '.aac': 'audio/aac',
  '.pdf': 'application/pdf',
};

// A Range header, as the part of a file it asks for.
export function byteRange(header, size) {
  const match = /^bytes=(\d*)-(\d*)$/i.exec(String(header || '').trim());
  if (!match || (match[1] === '' && match[2] === '')) return null;
  let start = match[1] === '' ? Math.max(0, size - Number(match[2])) : Number(match[1]);
  const end = match[1] === '' || match[2] === '' ? size - 1 : Math.min(Number(match[2]), size - 1);
  if (!Number.isInteger(start) || !Number.isInteger(end) || start > end) return null;
  if (start >= size) return 'unsatisfiable';
  return { start, end };
}

// A range asked for only if the file is still the one it began with
// (If-Range, as a download that broke off resumes): its ETag, exactly, or
// its date, exactly, when that says enough: a date is to the second, so one
// changed within the last second may change again under the same date. A
// file changed since, or one sent with neither, comes whole.
function stillSame(req, headers, modified) {
  const asked = String(req.headers?.['if-range'] ?? '').trim();
  if (!asked) return true;
  if (asked.startsWith('"') || asked.startsWith('W/')) return Boolean(headers.etag) && asked === headers.etag;
  return Boolean(headers['last-modified']) && asked === headers['last-modified'] && Number.isFinite(modified) && Date.now() - modified >= 1000;
}

// A file's bytes, in the range asked for, else whole: a video is sought this
// way, and a phone fetches only what it plays. Never more than the size it
// was said to be, though it grows meanwhile. modified: its time, in ms, for If-Range.
export function sendRange(req, res, full, size, headers, { modified } = {}) {
  const range = req.headers?.range && stillSame(req, headers, modified) ? byteRange(req.headers.range, size) : null;
  if (range === 'unsatisfiable') { res.writeHead(416, { ...headers, 'content-range': `bytes */${size}` }); return res.end(); }
  if (!range && size === 0) { res.writeHead(200, { ...headers, 'content-length': 0 }); return res.end(); }
  const stream = createReadStream(full, range ? { start: range.start, end: range.end } : { start: 0, end: size - 1 });
  stream.on('error', () => res.destroy());
  res.on('close', () => stream.destroy());
  if (range) res.writeHead(206, { ...headers, 'content-range': `bytes ${range.start}-${range.end}/${size}`, 'content-length': range.end - range.start + 1 });
  else res.writeHead(200, { ...headers, 'content-length': size });
  stream.pipe(res);
}

// What can be thrown away and made again: caches, builds, installed
// packages, spare checkouts. The map shows these apart, and lists the
// biggest as worth a look.
const REGENERABLE = /^(\.cache|cache|caches|node_modules|target|dist|build|\.next|\.nuxt|\.turbo|\.parcel-cache|__pycache__|\.pytest_cache|\.mypy_cache|\.venv|venv|\.gradle|\.npm|\.pnpm-store|\.yarn|\.cargo|\.rustup|\.m2|go|\.tox|worktrees|\.worktrees|tmp|\.tmp|Trash)$/;
const MEDIA = /^(music|pictures|videos|movies|photos|steam|steamapps|games)$/i;
export const kindOfFolder = name => (name === '.git' ? 'git' : REGENERABLE.test(name) ? 'regenerable' : MEDIA.test(name) ? 'media' : 'other');

// du's lines ("bytes<TAB>path", deepest first) as a tree. What a folder
// holds beyond its measured folders is its loose files; anything under a
// thousandth of the whole is gathered into one "smaller" block per folder.
export function spaceTree(duText, top) {
  const nodes = new Map();
  for (const line of String(duText).split('\n')) {
    const tab = line.indexOf('\t');
    if (tab < 1) continue;
    const bytes = Number(line.slice(0, tab));
    const path = line.slice(tab + 1);
    if (!Number.isFinite(bytes) || !inside(path, top)) continue;
    nodes.set(path, { name: basename(path) || path, path, size: bytes, kind: kindOfFolder(basename(path)), children: [] });
  }
  const root = nodes.get(top);
  if (!root) return null;
  for (const [path, node] of nodes) if (path !== top) nodes.get(dirname(path))?.children.push(node);
  const floor = root.size / 1000;
  const worth = [];
  (function tidy(node, insideRegenerable) {
    if (node.kind === 'regenerable' && !insideRegenerable && node !== root) worth.push(node);
    const measured = node.children.reduce((sum, child) => sum + child.size, 0);
    const kept = node.children.filter(child => child.size >= floor);
    const small = node.children.reduce((sum, child) => sum + (child.size >= floor ? 0 : child.size), 0);
    for (const child of kept) tidy(child, insideRegenerable || node.kind === 'regenerable');
    kept.sort((a, b) => b.size - a.size);
    if (node.size - measured >= floor) kept.push({ name: 'files', path: node.path, size: node.size - measured, kind: 'files', loose: true });
    if (small >= floor) kept.push({ name: 'smaller', path: node.path, size: small, kind: 'files', loose: true });
    node.children = kept;
    if (!node.children.length) delete node.children;
  })(root, false);
  worth.sort((a, b) => b.size - a.size);
  return { tree: root, worth: worth.slice(0, 8).map(({ name, path, size }) => ({ name, path, size })) };
}

// The pictures Workbench shows small.
export const PICTURE = /\.(png|jpe?g|gif|webp|avif|svg|bmp)$/i;

// How /proc/self/mountinfo writes a path (a space is \040), and the
// filesystems that are not on a disk.
const unescapeMount = value => String(value).replace(/\\(\d{3})/g, (_, octal) => String.fromCharCode(parseInt(octal, 8)));
const VIRTUAL = /^(tmpfs|devtmpfs|ramfs|proc|sysfs|cgroup2?|overlay|squashfs|devpts|mqueue|debugfs|tracefs|securityfs|pstore|bpf|configfs|fusectl|hugetlbfs|autofs|binfmt_misc|efivarfs|nsfs|rpc_pipefs|selinuxfs|fuse\..*)$/;

// What du must not go into when measuring top: the mounts under it that are
// another disk, or not a disk at all. A btrfs (or bcachefs...) subvolume of the
// same device is the same disk, though it has its own st_dev, so du -x would
// stop at it: on a / and /home that share one btrfs, / came out smaller than
// /home. Snapshots are left out too: they share their blocks with the disk,
// and counting them would make it many times its size. A disk is its device,
// as mountinfo names it (followed through links); a virtual mount is only
// ever itself. null: no mounts to go by, so stay on top's own filesystem (-x).
const SNAPSHOTS = /(^|\/)(\.snapshots|timeshift-btrfs)(\/|$)/;
export async function otherDisks(text, top, { real = path => realpath(path).catch(() => path) } = {}) {
  const mounts = [];
  for (const line of String(text || '').split('\n')) {
    const fields = line.split(' ');
    const dash = fields.indexOf('-');
    if (dash < 6) continue;
    const source = unescapeMount(fields[dash + 2] ?? ''), fstype = fields[dash + 1];
    const disk = source.startsWith('/dev/') && !source.startsWith('/dev/loop') && !VIRTUAL.test(fstype);
    mounts.push({ path: unescapeMount(fields[4]), root: unescapeMount(fields[3]), id: disk ? `${fstype} ${await real(source)}` : `dev ${fields[2]}` });
  }
  // The last mount over a place is the one seen there.
  const holding = mounts.filter(mount => inside(top, mount.path)).sort((a, b) => a.path.length - b.path.length).at(-1);
  if (!holding) return null;
  const out = [];
  for (const mount of mounts) {
    if (mount.path === top || !inside(mount.path, top) || out.some(path => inside(mount.path, path))) continue;
    if (mount.id !== holding.id || SNAPSHOTS.test(mount.path) || SNAPSHOTS.test(mount.root)) out.push(mount.path);
  }
  return out;
}
const globSafe = path => path.replace(/[*?[\]\\]/g, '\\$&');

// du's arguments for measuring top four levels down, and what its numbers are
// in: GNU du gives bytes and leaves out other disks by name (skip, from
// otherDisks), or stays on top's own (-x); a Mac's du counts kilobytes and
// knows only -x.
export function duCommand(top, skip, platform = process.platform) {
  if (platform === 'darwin') return { args: ['-x', '-k', '-d', '4', top], scale: 1024 };
  return { args: [...(skip ? skip.map(path => `--exclude=${globSafe(path)}`) : ['-x']), '-B1', '-d', '4', top], scale: 1 };
}
// du's lines in bytes, whatever it counted in.
const inBytes = (text, scale) => (scale === 1 ? text : String(text).split('\n').map(line => line.replace(/^(\d+)\t/, (_, n) => `${Number(n) * scale}\t`)).join('\n'));

// What a file opens as in Workbench, by its name; a file with a name none
// of these know is text if it is small and UTF-8 throughout, else nothing.
const OPENS = [
  ['image', PICTURE],
  ['markdown', /\.(md|markdown)$/i],
  ['video', /\.(mp4|m4v|webm|mov|ogv)$/i],
  ['audio', /\.(mp3|m4a|ogg|opus|wav|flac|aac)$/i],
  ['pdf', /\.pdf$/i],
  ['text', /(\.(txt|text|log|json|jsonl|js|mjs|cjs|jsx|ts|tsx|css|scss|html?|xml|svg|sh|bash|zsh|fish|py|rb|go|rs|c|h|cc|cpp|hpp|java|kt|swift|lua|pl|php|sql|toml|ya?ml|ini|conf|cfg|env|csv|tsv|diff|patch|vue|svelte|nix|desktop|service)|^(makefile|dockerfile|license|copying|readme|changelog|\.[a-z0-9_.-]+rc|\.gitignore|\.env.*))$/i],
];
export const TEXT_LIMIT = 1 << 20;
const utf8 = bytes => { try { new TextDecoder('utf-8', { fatal: true }).decode(bytes); return !bytes.includes(0); } catch { return false; } };
export async function kindOf(full, info) {
  const name = basename(full);
  const known = OPENS.find(([, test]) => test.test(name))?.[0];
  if (known) return known;
  if (info.size > TEXT_LIMIT) return 'none';
  const handle = await open(full, 'r');
  try {
    const bytes = Buffer.alloc(info.size);
    const { bytesRead } = await handle.read(bytes, 0, info.size, 0);
    return utf8(bytes.subarray(0, bytesRead)) ? 'text' : 'none';
  } finally { await handle.close(); }
}
// A file's bytes are only ever sent as what cannot run here: pictures, sound,
// video and PDFs as themselves, text as plain text, anything else as bytes,
// and all of it sandboxed (but a PDF, which the browser's viewer could not
// show sandboxed, and which runs nothing on this origin).
const AS_ITSELF = new Set(['image', 'video', 'audio', 'pdf']);
function typeFor(full, kind) {
  if (AS_ITSELF.has(kind)) return MIME[extname(full).toLowerCase()] ?? 'application/octet-stream';
  return kind === 'text' || kind === 'markdown' ? 'text/plain; charset=utf-8' : 'application/octet-stream';
}
// A file sent to be saved is never shown, so it needs no kind of its own
// beyond what it is by its name: pictures, sound, video and PDFs as
// themselves (a phone files them by it), anything else as bytes, which keeps
// a name with no extension as it is rather than given one.
const savedAs = full => {
  const kind = OPENS.find(([, test]) => test.test(basename(full)))?.[0];
  return AS_ITSELF.has(kind) ? typeFor(full, kind) : 'application/octet-stream';
};

// A file's name in Content-Disposition (RFC 6266): as itself in filename*,
// UTF-8 percent-encoded as RFC 8187 (5987) allows, which leaves no quote,
// bracket, star or line break, and to be saved, in plain ASCII in filename
// too, for whatever cannot read filename*: with no ; = or * in it either, so
// a reader that ignores quotes cannot find another parameter inside it.
const ATTR_CHAR = /['()*]/g;
export function disposition(type, name) {
  const whole = String(name).toWellFormed();
  const encoded = encodeURIComponent(whole).replace(ATTR_CHAR, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  if (type !== 'attachment') return `${type}; filename*=UTF-8''${encoded}`;
  const plain = whole.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^\x20-\x7e]|["\\%;=*]/gu, '_') || 'download';
  return `attachment; filename="${plain}"; filename*=UTF-8''${encoded}`;
}
// What a saved copy is checked against when it resumes: the file's identity,
// size and time, which change when its bytes do.
const validators = info => ({
  etag: `"${info.ino.toString(36)}-${info.size.toString(36)}-${Math.round(info.mtimeMs * 1000).toString(36)}"`,
  'last-modified': new Date(info.mtimeMs).toUTCString(),
});
// Pages a browser asked for from elsewhere, or from the agents' pages beside
// imperfect (another port, the same site), never read or edit a file;
// Workbench asks from its own origin. Requests with no such header are not a
// browser's (another of the person's computers, through /peer/).
export const READS = new Set(['/files/list', '/files/events', '/files/peek', '/files/raw', '/files/thumbnail', '/files/text']);
export const fromElsewhere = req => {
  const site = req.headers?.['sec-fetch-site'];
  return Boolean(site) && site !== 'same-origin' && site !== 'none';
};

const unreadable = error => error?.code === 'EACCES' || error?.code === 'EPERM';

export function createFiles({
  launcher = spawn,
  thumbnailDir = join(process.env.IMPERFECT_PREFIX || join(homedir(), '.imperfect'), 'cache', 'files', 'pictures'),
  pictureMakers = pictureMaking().makers,
  pictureExtension = pictureMaking().extension,
  actions = createFileActions(),
  mounts = () => readFile('/proc/self/mountinfo', 'utf8').catch(() => ''),
  feedOptions,
  edits = createFileText(),
} = {}) {
  const json = (res, status, value) => { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(value)); };
  const pictureOf = createThumbnails({ dir: thumbnailDir, makers: pictureMakers, extension: pictureExtension });
  const feed = createFileFeed(feedOptions);

  // A picture, small: made once and kept, else the picture itself. An SVG is
  // sent as it is; in an <img> it cannot run anything, and opened by its
  // address it is sandboxed, as is everything sent here.
  async function thumbnail(req, res, path) {
    const full = resolve('/', String(path || ''));
    if (!PICTURE.test(full)) return json(res, 404, { error: 'not a picture' });
    const info = await stat(full);
    if (!info.isFile()) return json(res, 404, { error: 'not a picture' });
    const headers = { 'cache-control': 'private, max-age=86400', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox" };
    const small = extname(full).toLowerCase() !== '.svg' && await pictureOf(full, info).catch(() => null);
    if (small) return sendRange(req, res, small, (await stat(small)).size, { ...headers, 'content-type': MIME[extname(small).toLowerCase()] ?? 'image/webp' });
    sendRange(req, res, full, info.size, { ...headers, 'content-type': MIME[extname(full).toLowerCase()] });
  }

  async function body(req, limit = 1 << 20) {
    let text = '';
    req.setEncoding?.('utf8');
    for await (const chunk of req) { text += chunk; if (text.length > limit) throw Object.assign(new Error('too much asked at once'), { status: 413 }); }
    try { return JSON.parse(text || '{}'); } catch { throw Object.assign(new Error('not a request'), { status: 400 }); }
  }
  // A file's new text, as it came: no more than the edit limit.
  async function bytes(req, limit) {
    const tooMuch = () => Object.assign(new Error(`it would be over ${Math.round(limit / (1 << 20) * 10) / 10} MB`), { status: 413 });
    if (Number(req.headers?.['content-length']) > limit) throw tooMuch();
    const chunks = [];
    let size = 0;
    for await (const chunk of req) { size += chunk.length; if (size > limit) throw tooMuch(); chunks.push(chunk); }
    return Buffer.concat(chunks);
  }

  // Measuring a big folder takes du a while, so a folder's measure is kept a
  // few minutes and one measure is shared by everyone asking at once.
  const measures = new Map();
  function measure(full, fresh) {
    const had = measures.get(full);
    if (had && !fresh && (had.pending || Date.now() - had.at < 5 * 60_000)) return had.value;
    const value = mounts().then(text => otherDisks(text, full)).catch(() => null).then(skip => new Promise(done => {
      const { args, scale } = duCommand(full, skip);
      const child = launcher('du', args, { stdio: ['ignore', 'pipe', 'ignore'] });
      let out = '';
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', chunk => { out += chunk; });
      child.on('error', () => done(''));
      child.on('close', () => done(inBytes(out, scale)));
    })).then(async text => {
      const found = spaceTree(text, full);
      const disk = await statfs(full).then(fs => ({ total: fs.blocks * fs.bsize, free: fs.bavail * fs.bsize }), () => null);
      const entry = measures.get(full);
      if (entry) { entry.pending = false; entry.at = Date.now(); }
      return found ? { path: full, ...found, disk, measuredAt: Date.now() } : null;
    });
    measures.set(full, { value, pending: true, at: 0 });
    return value;
  }

  // Answers a /files/ request; false for anything else.
  async function handle(req, res, path, search) {
    if (!path.startsWith('/files/')) return false;
    const query = new URLSearchParams(search);
    try {
      if (READS.has(path) && fromElsewhere(req)) {
        json(res, 403, { error: 'files are read only from Workbench' });
      } else if (path === '/files/list' && req.method === 'GET') {
        const full = query.get('path') ? resolve('/', query.get('path')) : homedir();
        const found = await feed.list(full, req.headers?.['if-none-match']);
        res.writeHead(found.unchanged ? 304 : 200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'private, no-cache', etag: found.etag });
        res.end(found.unchanged ? undefined : JSON.stringify(found.value));
      } else if (path === '/files/events' && req.method === 'GET') {
        const full = query.get('path') ? resolve('/', query.get('path')) : homedir();
        await feed.events(req, res, full, query.get('window'));
      } else if (path === '/files/peek' && req.method === 'GET') {
        const full = resolve('/', String(query.get('path') || ''));
        const info = await stat(full);
        if (!info.isFile()) return json(res, 404, { error: "Can't open this: it isn't a file" }), true;
        const kind = await kindOf(full, info);
        const editable = (kind === 'markdown' || kind === 'text') && await edits.editable(full);
        json(res, 200, { path: full, name: basename(full), size: info.size, mtime: info.mtimeMs, kind, type: MIME[extname(full).toLowerCase()] ?? null, editable });
      } else if (path === '/files/raw' && req.method === 'GET') {
        const full = resolve('/', String(query.get('path') || ''));
        const download = query.get('download') === '1';
        const info = await stat(full);
        // A folder is not sent whole: only a file is saved.
        if (!info.isFile()) return json(res, 404, { error: download && info.isDirectory() ? "Can't download a folder, only a file" : "Can't open this: it isn't a file" }), true;
        // One that cannot be read says so, rather than breaking off once begun.
        await access(full, constants.R_OK).catch(error => {
          throw unreadable(error) ? Object.assign(new Error("Can't open this file: you don't have permission"), { status: 403 }) : error;
        });
        const kind = download ? null : await kindOf(full, info);
        const headers = {
          'content-type': download ? savedAs(full) : typeFor(full, kind), 'accept-ranges': 'bytes', 'cache-control': 'no-store',
          'content-disposition': disposition(download ? 'attachment' : 'inline', basename(full)),
          ...validators(info),
          ...(kind === 'pdf' ? {} : { 'content-security-policy': "default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'; sandbox" }),
        };
        sendRange(req, res, full, info.size, headers, { modified: info.mtimeMs });
      } else if (path === '/files/text' && req.method === 'GET') {
        json(res, 200, await edits.read(String(query.get('path') || '')));
      } else if (path === '/files/text' && req.method === 'POST') {
        const version = String(req.headers?.['if-match'] ?? '').trim().replace(/^(W\/)?"(.*)"$/, '$2');
        json(res, 200, await edits.save(String(query.get('path') || ''), await bytes(req, edits.limit), version));
      } else if (path === '/files/thumbnail' && req.method === 'GET') {
        await thumbnail(req, res, query.get('path'));
      } else if (path === '/files/trash' && req.method === 'POST') {
        const asked = await body(req);
        json(res, 200, await actions.trash(asked?.paths));
      } else if (path === '/files/space' && req.method === 'GET') {
        const full = resolve('/', String(query.get('path') || '/'));
        if (!(await stat(full)).isDirectory()) return json(res, 404, { error: 'not a folder' }), true;
        const found = await measure(full, query.has('fresh'));
        if (found) json(res, 200, found); else json(res, 404, { error: 'could not measure that folder' });
      } else json(res, 404, { error: 'no such request' });
    } catch (error) {
      if (res.destroyed || res.headersSent) return true;
      if (error?.status) json(res, error.status, { error: error.message, ...(error.current ? { version: error.current } : {}) });
      else if (unreadable(error)) json(res, 403, { error: "Can't open this folder: you don't have permission" });
      else if (error?.code === 'ENOENT') json(res, 404, { error: "Can't open this folder: it isn't there" });
      else if (error?.code === 'ENOTDIR') json(res, 404, { error: "Can't open this: it isn't a folder" });
      else json(res, 500, { error: `Can't open this folder: ${error.message}` });
    }
    return true;
  }
  handle.close = () => feed.close();
  return handle;
}
