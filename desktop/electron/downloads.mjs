// Where a download lands from imperfect's window: in Downloads, under the
// name it came with, or with (1), (2)... before its extension when that is
// taken, as a browser does: never over a file already there, nor over one
// still coming in under the same name. Its path goes on the clipboard when
// it is done, unless the person copied something else meanwhile, and the
// page is told where it went (Workbench says so, with the way to it).
import { existsSync } from 'node:fs';
import { basename, join } from 'node:path';

// The first free path in dir for name: name itself, else "name (n).ext".
export function freePath(dir, name, taken = existsSync) {
  const whole = basename(String(name ?? '')).replace(/^\.+$/, '') || 'download';
  const dot = whole.lastIndexOf('.');
  const [stem, ext] = dot > 0 ? [whole.slice(0, dot), whole.slice(dot)] : [whole, ''];
  for (let n = 0; n < 10_000; n++) {
    const path = join(dir, n ? `${stem} (${n})${ext}` : whole);
    if (!taken(path)) return path;
  }
  return join(dir, `${stem} (${Date.now()})${ext}`);
}

// item: Electron's DownloadItem. clip: { read() -> text or null, write(text) }.
// tell({ url, path, state }) once it is done, whatever became of it.
export function createDownloads({ dir, clip, tell = () => {}, exists = existsSync }) {
  const coming = new Set();
  return item => {
    const path = freePath(dir, item.getFilename(), candidate => coming.has(candidate) || exists(candidate));
    coming.add(path);
    item.setSavePath(path);
    const before = clip.read();
    item.once('done', async (_, state) => {
      coming.delete(path);
      tell({ url: item.getURL(), path: state === 'completed' ? item.getSavePath() : '', state });
      const previous = await before;
      if (state !== 'completed' || previous === null || await clip.read() !== previous) return;
      clip.write(item.getSavePath());
    });
  };
}
