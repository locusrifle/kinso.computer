import WebSocket from 'ws';

// Resolve only against verified inventory, then re-probe the captured peer.
// A name is convenience for agents; the transport always uses its stable id.
export async function sessionComputer(machines, computer) {
  if (computer === undefined) return null;
  if (typeof computer !== 'string' || !computer.trim()) throw new Error('computer must be a machine name or id from the machine list');
  const asked = computer.trim();
  const rows = await machines.list();
  const exact = rows.find(row => row.id === asked);
  const matches = exact ? [exact] : rows.filter(row => row.name?.toLowerCase() === asked.toLowerCase());
  if (!matches.length) throw new Error(`Unknown computer: ${asked}`);
  if (matches.length !== 1) throw new Error(`Ambiguous computer: ${asked}; use its machine id`);
  const row = matches[0];
  if (row.self) return null;
  if (!row.reachable) throw new Error(`${row.name} is offline; no session created`);
  const peer = await machines.peer(row.id);
  if (!peer?.url) throw new Error(`${row.name} is offline; no session created`);
  return peer;
}

// The same /pi peer transport used by a window; no remote token, shell, or
// second placement API. Never retry a creation whose acknowledgement was lost.
export async function openPeerSession(peer, { cwd, agent, name, prompt, model, thinking }) {
  const url = new URL('/pi', peer.url);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(url);
  const pending = new Map();
  let serial = 0;
  const lost = () => {
    for (const { reject } of pending.values()) reject(new Error(`${peer.name}: connection lost; session acceptance is unknown. Check its sessions before trying again.`));
    pending.clear();
  };
  ws.on('error', lost);
  ws.on('close', lost);
  ws.on('message', raw => {
    let message;
    try { message = JSON.parse(raw); } catch { return; }
    if (message.type !== 'response') return;
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    if (message.success) request.resolve(message.data);
    else request.reject(new Error(`${peer.name}: ${message.error || 'session command refused'}`));
  });
  const command = fields => new Promise((resolve, reject) => {
    if (ws.readyState !== WebSocket.OPEN) { reject(new Error(`${peer.name} is offline`)); return; }
    const id = `session-${++serial}`;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ ...fields, id }));
  });
  let timer;
  try {
    return await Promise.race([
      (async () => {
        await new Promise((resolve, reject) => {
          ws.once('open', resolve);
          ws.once('error', error => reject(new Error(`${peer.name} is unavailable; no session created (${error.message})`)));
          ws.once('close', () => reject(new Error(`${peer.name} is offline; no session created`)));
        });
        const made = await command({ type: 'tab-new', agent, ...(cwd ? { cwd } : {}) });
        if (!made?.id) throw new Error(`${peer.name}: session creation was not acknowledged`);
        const identity = { expectedTabId: made.id, ...(made.sessionId ? { expectedSessionId: made.sessionId } : {}) };
        if (name) await command({ type: 'name', name, ...identity });
        if (agent === 'pi' && typeof model === 'string' && model.includes('/')) {
          const cut = model.indexOf('/');
          await command({ type: 'model', provider: model.slice(0, cut), modelId: model.slice(cut + 1), persist: false, ...identity });
        }
        if (agent === 'pi' && thinking) await command({ type: 'thinking', level: thinking, ...identity });
        if (prompt) await command({ type: 'prompt', text: prompt, ...identity });
        return { id: made.id };
      })(),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${peer.name}: session request timed out; acceptance is unknown. Check its sessions before trying again.`)), 15_000); }),
    ]);
  } finally {
    clearTimeout(timer);
    ws.terminate();
  }
}
