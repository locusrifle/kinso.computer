// One transcript for every harness that hands imperfect a stream.
//
// Claude sends SDK frames and Codex its app server's items, neither of which
// is what the window draws. A harness has a small adapter (`claudeEvents` in
// claude-runtime.mjs, `codexEvents` in codex-runtime.mjs) that turns its own
// frames into the events below, and this file folds those events into the
// canonical messages, the message being streamed, the tools still running and
// the state of the turn. The window never sees a frame; the adapters never
// touch a message list; another harness is one more adapter.
//
// Pi is the exception, on purpose: Pi keeps, persists and replays its own
// transcript, so its snapshot is read from its session and passed through
// `canonicalSnapshot`. Folding Pi's events here would keep a second copy of a
// conversation Pi already owns.
//
// The events, and what each means:
//   user      { content }                          the person said this; blocks or text
//   text      { id, delta | text, done, model }    assistant prose, streamed by id
//   thinking  { id, delta | text, done }           assistant reasoning, streamed by id
//   tool      { id, name, arguments, status, output, isError }
//                                                  one step of a tool's life: running, done or failed
//   turn      { state: 'start' | 'end', failed }   a model turn beginning or ending
//   usage     { tokens, cost, contextUsage }       counters; the latest wins
//   error     { message }                          the harness failed in the middle of the conversation
//   compaction { state: 'start' | 'stop' | 'end', tokensBefore, tokensAfter }
//                                                  the harness compacting its context; at its end
//                                                  the conversation says where (compactionSummary)
//
// Every event may carry `timestamp` (ms), when it happened; one that does not
// happened now. Each message keeps the time it was settled, so a turn can be
// timed, from the person's message to the last thing said in answer.
//
// Anything else is unknown. If it carries `text` it is still shown, so a
// harness that invents an event degrades to a readable line rather than a
// silent gap or a broken view.
import { canonicalBlocks, canonicalSnapshot } from './canonical.mjs';

export const EVENTS = Object.freeze(['user', 'text', 'thinking', 'tool', 'turn', 'usage', 'error', 'compaction']);

const textOf = content => typeof content === 'string' ? content : (Array.isArray(content) ? content : []).filter(b => b?.type === 'text').map(b => b.text ?? '').join('\n');

export function createTranscript() {
  const messages = [];
  // Blocks still arriving, in arrival order, each findable by the id its
  // harness streams under. `partial` is what the window draws from them.
  let live = [];
  const running = new Map();
  let streaming = false;
  let failed = null;
  let stats = {};
  let compacting = false;
  // When the event being absorbed happened.
  let now = Date.now();

  // Appended in place: a copy per message made rebuilding a long session n².
  const push = message => { messages.push(message.timestamp == null ? { ...message, timestamp: now } : message); };
  const settle = block => {
    live = live.filter(item => item !== block);
    const { id: _id, model, ...content } = block;
    push({ role: 'assistant', content: [content], ...(model ? { model } : {}) });
  };
  // A streamed block and the settled block that ends it do not always share an
  // id: Claude streams by content index and settles by message. A settled block
  // that names nothing live takes the oldest live block of its kind, which is
  // the one it was streaming.
  const find = (kind, id) => live.find(item => item.type === kind && item.id === id) ?? (id == null ? null : live.find(item => item.type === kind && item.id == null));
  const stream = (kind, event) => {
    const field = kind === 'text' ? 'text' : 'thinking';
    let block = find(kind, event.id) ?? (event.done ? live.find(item => item.type === kind) : null);
    if (!block) { block = { type: kind, id: event.id ?? null, [field]: '' }; live = [...live, block]; }
    if (typeof event.text === 'string') block[field] = event.text;
    else if (typeof event.delta === 'string') block[field] += event.delta;
    if (event.model) block.model = event.model;
    // The window renders `partial` by identity, so a new object per change.
    live = live.map(item => item === block ? { ...block } : item);
    if (event.done) settle(live.find(item => item.type === kind && item.id === block.id) ?? block);
  };
  const finishTool = (tool, status, output, isError, images = []) => {
    running.delete(tool.toolCallId);
    push({ role: 'assistant', content: [{ type: 'toolCall', id: tool.toolCallId, name: tool.toolName, arguments: tool.args }] });
    push({ role: 'toolResult', toolCallId: tool.toolCallId, toolName: tool.toolName, content: [{ type: 'text', text: output ?? '' }, ...images], isError: Boolean(isError) || status === 'failed' });
  };

  function absorb(event) {
    now = Number.isFinite(event?.timestamp) ? event.timestamp : Date.now();
    switch (event?.type) {
      case 'user': {
        const content = canonicalBlocks(event.content);
        // A retried send arrives twice; the
        // same words twice in a row, with nothing between them, are one message.
        const last = messages.at(-1);
        if (last?.role === 'user' && textOf(last.content) === textOf(content) && textOf(content)) return true;
        push({ role: 'user', content, ...(event.timestamp ? { timestamp: event.timestamp } : {}) });
        return true;
      }
      case 'text': case 'thinking': stream(event.type, event); return true;
      case 'tool': {
        if (!event.id) return true;
        const known = running.get(event.id);
        const tool = { toolCallId: event.id, toolName: event.name ?? known?.toolName ?? 'tool', args: event.arguments ?? known?.args ?? {}, status: 'running', ...(event.output != null ? { result: event.output } : known?.result != null ? { result: known.result } : {}) };
        if (event.status === 'done' || event.status === 'failed') finishTool(tool, event.status, event.output, event.isError, event.images);
        else running.set(event.id, tool);
        return true;
      }
      case 'turn': {
        if (event.state === 'start') { streaming = true; failed = null; return true; }
        // A harness that never says "done" does not lose what it said: every
        // live block settles, and a tool still running is finished as failed
        // rather than left spinning under a turn that has ended.
        for (const block of [...live]) settle(block);
        for (const tool of [...running.values()]) finishTool(tool, 'failed', tool.result ?? '', true);
        streaming = false;
        failed = event.failed ? String(event.failed) : null;
        return true;
      }
      case 'compaction': {
        compacting = event.state === 'start';
        if (event.state !== 'end') return true;
        // Claude's boundary and the summary after it are one compaction.
        const last = messages.at(-1), counts = Object.fromEntries(['tokensBefore', 'tokensAfter'].filter(k => Number.isFinite(event[k])).map(k => [k, event[k]]));
        if (last?.role === 'compactionSummary') messages[messages.length - 1] = { ...last, ...counts };
        else push({ role: 'compactionSummary', ...counts });
        return true;
      }
      case 'usage': {
        const { type: _type, ...rest } = event;
        stats = { ...stats, ...rest };
        return true;
      }
      case 'error':
        push({ role: 'assistant', content: [], errorMessage: String(event.message ?? 'error') });
        return true;
      default: {
        if (typeof event?.text === 'string' && event.text.trim()) push({ role: 'custom', customType: String(event.kind ?? event.type ?? 'unknown'), content: event.text });
        return false;
      }
    }
  }

  return {
    absorb,
    absorbAll(events) { for (const event of events ?? []) absorb(event); },
    get messages() { return messages; },
    get streaming() { return streaming; },
    get compacting() { return compacting; },
    get failed() { return failed; },
    set failed(value) { failed = value; },
    firstUserLine() {
      return textOf(messages.find(m => m.role === 'user')?.content ?? '').split('\n').map(s => s.trim()).find(Boolean) ?? '';
    },
    // The conversation half of a harness's snapshot, already canonical. The
    // runtime adds the session facts (model, cwd) and its `source`.
    view(source, rest = {}) {
      const partial = live.length ? { role: 'assistant', content: live.map(({ id: _id, model: _model, ...block }) => block) } : null;
      return canonicalSnapshot({ ...rest, messages, partial, streaming, failed, stats }, source);
    },
  };
}
