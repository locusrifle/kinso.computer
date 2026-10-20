// A stand-in for OpenAI's Responses API, enough for a real Codex to run turns
// against: asked to run something, it thinks, calls Codex's exec_command, and
// says what the command printed; asked anything else, it says what it heard.
// No account, no network. Each request is kept, so a test can see what Codex
// sent (its tools, the person's words). `hold` keeps the next answer back
// until it is let go, so a turn can be caught while it is still running.
import { createServer } from 'node:http';

const sse = (res, events) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  for (const event of events) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  res.end();
};
const usage = { input_tokens: 1200, input_tokens_details: { cached_tokens: 200 }, output_tokens: 40, output_tokens_details: { reasoning_tokens: 10 }, total_tokens: 1240 };
const said = input => {
  const last = [...input].reverse().find(item => item.type === 'message' && item.role === 'user');
  return (last?.content ?? []).filter(part => part.type === 'input_text').map(part => part.text).join('\n');
};

function answer(request, id) {
  const input = request.input ?? [];
  if (input.at(-1)?.type !== 'function_call_output' && /^run /i.test(said(input))) {
    const reasoning = { type: 'reasoning', id: `rs_${id}`, summary: [{ type: 'summary_text', text: 'I will run it.' }], encrypted_content: null };
    const call = { type: 'function_call', id: `fc_${id}`, call_id: `call_${id}`, name: 'exec_command', arguments: JSON.stringify({ cmd: said(input).slice(4) }) };
    return [
      { type: 'response.created', response: { id } },
      { type: 'response.output_item.added', output_index: 0, item: { ...reasoning, summary: [] } },
      { type: 'response.reasoning_summary_part.added', item_id: reasoning.id, output_index: 0, summary_index: 0, part: { type: 'summary_text', text: '' } },
      { type: 'response.reasoning_summary_text.delta', item_id: reasoning.id, output_index: 0, summary_index: 0, delta: 'I will run it.' },
      { type: 'response.output_item.done', output_index: 0, item: reasoning },
      { type: 'response.output_item.added', output_index: 1, item: { ...call, arguments: '' } },
      { type: 'response.output_item.done', output_index: 1, item: call },
      { type: 'response.completed', response: { id, output: [reasoning, call], usage } },
    ];
  }
  const output = input.at(-1)?.type === 'function_call_output' ? input.at(-1).output : null;
  const text = output != null ? `The command printed ${String(typeof output === 'string' ? output : JSON.stringify(output)).match(/[\w-]+-from-codex/)?.[0] ?? 'nothing'}.` : `Heard: ${said(input)}`;
  const message = { type: 'message', id: `msg_${id}`, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] };
  return [
    { type: 'response.created', response: { id } },
    { type: 'response.output_item.added', output_index: 0, item: { ...message, status: 'in_progress', content: [] } },
    { type: 'response.output_text.delta', item_id: message.id, output_index: 0, content_index: 0, delta: text },
    { type: 'response.output_item.done', output_index: 0, item: message },
    { type: 'response.completed', response: { id, output: [message], usage } },
  ];
}

export async function startFakeResponses() {
  const requests = [];
  let held = null;
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      if (req.method !== 'POST') { res.writeHead(404).end(); return; }
      const request = JSON.parse(body);
      requests.push(request);
      if (held) { const wait = held.promise; held.arrived(); await wait; }
      sse(res, answer(request, `resp_${requests.length}`));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return {
    port: server.address().port,
    requests,
    // The next request waits; `arrived` says it has come, `release` lets it go.
    hold() {
      let release, arrived;
      const came = new Promise(resolve => { arrived = resolve; });
      held = { promise: new Promise(resolve => { release = resolve; }), arrived };
      return { arrived: came, release: () => { held = null; release(); } };
    },
    close: () => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); },
  };
}

// A CODEX_HOME whose Codex talks to this stand-in instead of OpenAI.
export const fakeCodexConfig = port => [
  'model = "fake-model"',
  'model_provider = "fake"',
  '[model_providers.fake]',
  'name = "fake"',
  `base_url = "http://127.0.0.1:${port}/v1"`,
  'wire_api = "responses"',
  'requires_openai_auth = false',
  '',
].join('\n');
