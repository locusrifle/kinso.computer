// A temporary place on a real disk, for tests that move things to the Trash.
// gio refuses tmpfs ("Trashing on system internal mounts is not supported"),
// and os.tmpdir() is tmpfs on many desktops (Omarchy's /tmp is), so the
// things to trash go under ~/.cache instead. Their trash is a folder of its
// own beside them on the same disk (XDG_DATA_HOME), never the person's.
//
//   const disk = await realDisk('name-');
//   disk.files   where to put what is trashed      disk.trash   where it goes
//   disk.run     gio with that trash, for createFileActions({ run })
//   await disk.remove()   everything under it, whatever a test left read only

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chmod, mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const exec = promisify(execFile);

// Each folder under dir writable again, so it can be emptied: a test that
// made one read only (to be refused) and failed before putting it back must
// not leave it behind, or fail the next one's cleanup. Links are not followed.
async function writable(dir) {
  await chmod(dir, 0o700).catch(() => {});
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    if (entry.isDirectory()) await writable(join(dir, entry.name));
  }
}

export async function realDisk(prefix) {
  const parent = join(homedir(), '.cache');
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, `imperfect-test-${prefix}`));
  const files = join(root, 'files'), data = join(root, 'data');
  await mkdir(files);
  await mkdir(data);
  return {
    root, files, trash: join(data, 'Trash', 'files'),
    run: (bin, args) => exec(bin, args, { env: { ...process.env, XDG_DATA_HOME: data } }),
    remove: async () => { await writable(root); await rm(root, { recursive: true, force: true }); },
  };
}
