// Isolated Kinso review: real site + product frontend, fixture transports only.
// Never reads installed credentials, contacts the VM, sends mail or runs models.
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLockerServer } from '../../server.mjs';
import { openStore } from '../../store.mjs';
import { command, createSiteLocks, readTicket } from '../../site-locks.mjs';
import { launchProductFixture } from './launch-product.mjs';

export async function kinsoLaunch({ port = 0, exactOrigins = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'kinso-review-')), credentials = join(root, 'credentials');
  const files = { file: join(credentials, 'site-locks.json'), doorFile: join(credentials, 'site-door-secret'), credentials, out() {} };
  await command(['door-secret'], files);
  let origin;
  const product = await launchProductFixture({ ids: ['kinso'], launchOrigin: () => origin,
    publicOrigin: exactOrigins ? 'https://computer.kinso.computer' : null,
    verifyTicket: async ticket => readTicket(ticket, await readFile(files.doorFile)) });
  await command(['replace', 'kinso', 'kinso', product.origin, '--ticket'], files);
  const store = openStore();
  const app = await createLockerServer({ store, stripe: null,
    mail: { configured: false, async send() { throw new Error('No mail in review'); } },
    tell: async () => { throw new Error('No notifications in review'); },
    config: { secure: false, hosts: 'store.invalid', stripe: {} },
    siteLocks: createSiteLocks({ ...files, secure: false, log: { error() {} } }),
    port, log: { info() {}, warn() {}, error() {} } });
  const transportOrigin = `http://127.0.0.1:${(await app.listen()).port}`;
  origin = exactOrigins ? 'https://kinso.computer' : transportOrigin;
  return { origin, transportOrigin, url: `${origin}/?for=kinso`, product,
    async close() { await app.close(); store.close(); await product.close(); await rm(root, { recursive: true, force: true }); } };
}
