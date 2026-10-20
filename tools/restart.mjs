// Restart imperfect so a change to it takes effect, from an agent or a terminal:
//
//   node tools/restart.mjs
//
// imperfect restarts through its handoff: it waits until no agent is working (the
// one that asked included, so asking mid-turn is fine), then comes back. Open
// windows then reload themselves once nothing in them would be lost.

import WebSocket from 'ws';

const port = process.env.IMPERFECT_PORT || 5067;
const ws = new WebSocket(`ws://127.0.0.1:${port}/pi`);
const done = (text, code = 0) => { console.log(text); ws.terminate(); process.exit(code); };
ws.on('open', () => ws.send(JSON.stringify({ type: 'machine-restart', id: 'restart' })));
ws.on('message', raw => {
  const message = JSON.parse(raw);
  if (message.id !== 'restart') return;
  if (!message.success) done(`imperfect refused: ${message.error}`, 1);
  done('imperfect restarts once no agent is working; open windows then reload.');
});
ws.on('unexpected-response', (_, res) => done(`imperfect refused the connection (${res.statusCode})`, 1));
ws.on('error', error => done(`imperfect is not answering on :${port} (${error.message})`, 1));
setTimeout(() => done('imperfect did not answer', 1), 10_000);
