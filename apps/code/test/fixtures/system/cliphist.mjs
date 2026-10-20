// cliphist (0.7.0) as it behaves, in memory, for the clipboard's tests
// (system/clipboard.mjs): newest first, a picture listed by its size, text
// folded and cut to the preview width, nothing copied yet an error.
import { pngSize } from '../../../../../system/clipboard.mjs';

// A PNG's first bytes: signature, then IHDR with its width and height.
export const png = (width, height, tail = 'x') => {
  const head = Buffer.alloc(24);
  Buffer.from('\x89PNG\r\n\x1a\n', 'latin1').copy(head, 0);
  head.writeUInt32BE(13, 8);
  head.write('IHDR', 12, 'latin1');
  head.writeUInt32BE(width, 16);
  head.writeUInt32BE(height, 20);
  return Buffer.concat([head, Buffer.from(tail)]);
};

export function fakeCliphist() {
  const db = new Map();
  let next = 0;
  const calls = [];
  const preview = (id, bytes, width) => {
    const size = pngSize(bytes);
    if (size) return `${id}\t[[ binary data ${bytes.length} B png ${size.width}x${size.height} ]]`;
    const text = bytes.toString().trim().split(/\s+/).filter(Boolean).join(' ');
    return `${id}\t${[...text].length > width ? `${[...text].slice(0, width).join('')}…` : text}`;
  };
  const run = async (command, args, { input = '', bytes = false } = {}) => {
    if (command !== 'cliphist') return { ok: false, missing: true, stdout: '', stderr: '' };
    calls.push(args.join(' '));
    const rest = [...args];
    let width = 100;
    while (rest[0]?.startsWith('-')) { const [flag, value] = rest.splice(0, 2); if (flag === '-preview-width') width = Number(value); }
    const [what, arg] = rest;
    const out = stdout => ({ ok: true, code: 0, stdout: bytes ? Buffer.from(stdout) : stdout, stderr: '' });
    if (what === 'list') {
      if (!db.size) return { ok: false, code: 1, stdout: '', stderr: 'opening db: please store something first\n' };
      return out([...db].reverse().map(([id, value]) => `${preview(id, value, width)}\n`).join(''));
    }
    if (what === 'decode') return db.has(arg) ? { ok: true, code: 0, stdout: db.get(arg), stderr: '' } : { ok: false, code: 1, stdout: Buffer.alloc(0), stderr: `id ${arg} not found` };
    if (what === 'delete') { for (const line of input.split('\n').filter(Boolean)) db.delete(line.split('\t')[0]); return out(''); }
    if (what === 'wipe') { db.clear(); return out(''); }
    throw new Error(`unexpected ${args}`);
  };
  return { run, calls, db, put: value => { db.set(String(++next), Buffer.from(value)); return String(next); } };
}
