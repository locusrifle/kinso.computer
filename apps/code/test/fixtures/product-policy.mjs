// Read the real HTTP policy with an isolated runtime/home, never a live service.
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGueyServer } from '../../../../system/server.mjs';

export async function productPolicy({ hosted = true, origins = ['https://computer.kinso.computer'], requestHost } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'product-policy-'));
  let app;
  try {
    app = await createGueyServer({ port: 0, stateDir: join(root, 'data/state'), cwd: root, hosted, origins,
      runtime: { events: new EventEmitter(), snapshot: () => ({ sessionId: 'fixture', cwd: root, busy: false, messages: [], tabs: [] }), async command() { return {}; }, async close() {} },
    });
    const { port } = await app.listen();
    const response = await fetch(`http://127.0.0.1:${port}/`, { headers: requestHost ? { host: requestHost } : {} });
    return { status: response.status, policy: response.headers.get('content-security-policy') };
  } finally { await app?.close(); await rm(root, { recursive: true, force: true }); }
}
