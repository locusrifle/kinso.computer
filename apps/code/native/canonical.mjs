// The vocabulary the surfaces speak, owned by no harness.
//
// Every pane above this file — the transcript, the rail, the composer, the
// phone — reads these names and no others. A harness is wrapped by translating
// *into* this vocabulary. It is never wrapped by translating into another
// harness's shape, because that makes the first harness privileged and every
// later one a translation of a translation.
//
// Pi's translation is close to the identity today. That is not a reason to skip
// it: the day Pi renames a block, the translation absorbs the rename and the UI
// never learns it happened. That is the whole point of the layer. Claude and
// Codex arrive as streams and are folded into this shape by transcript.mjs.
//
// The names are taken from T3 Code (`pingdotgg/t3code`, MIT), whose
// `packages/contracts/src/providerRuntime.ts` had already paid for the mistakes.
// Theirs is larger because they carry six harnesses; this is the subset our
// surfaces actually read.

// What a message can be. `user` and `assistant` are the conversation;
// `toolResult` is what a tool said back; the rest are the harness telling the
// person something about the session rather than about the work.
export const ROLES = Object.freeze([
  'user', 'assistant', 'toolResult', 'custom',
  'compaction', 'compactionSummary', 'branchSummary',
]);

// What assistant content can be. Four, and the transcript renders exactly four.
export const BLOCKS = Object.freeze(['text', 'thinking', 'toolCall', 'image']);

// Which harness a value came from: the three imperfect runs. Kept on the
// snapshot for diagnosis only: no surface may branch on it. If a pane needs to
// know who is underneath, the vocabulary is missing a word and this is the
// file to add it to.
export const SOURCES = Object.freeze(['pi', 'claude', 'codex']);

const ROLE_SET = new Set(ROLES);
const BLOCK_SET = new Set(BLOCKS);

// Unknown blocks are dropped rather than passed through. A harness that invents
// a block type would otherwise reach a renderer that has no case for it.
export function canonicalBlocks(content) {
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  if (!Array.isArray(content)) return [];
  const out = [];
  for (const block of content) {
    const type = block?.type;
    if (!BLOCK_SET.has(type)) continue;
    // Extra fields a harness hangs on a block are kept. Pi's `thoughtSignature`
    // means nothing to the transcript, but stripping it here would quietly
    // change what a session file round-trips.
    if (type === 'text') out.push({ ...block, type: 'text', text: block.text ?? '' });
    else if (type === 'thinking') out.push({ ...block, type: 'thinking', thinking: block.thinking ?? '' });
    else if (type === 'toolCall') out.push({ ...block, type: 'toolCall', id: block.id, name: block.name, arguments: block.arguments ?? {} });
    else out.push({ ...block, type: 'image' });
  }
  return out;
}

// A message keeps whatever extra fields its harness hung on it — the renderer
// reads `summary`, `display`, `details`, `errorMessage` and `timestamp` — but
// its role and its content are canonical or it does not pass.
function translate(message) {
  if (!message || !ROLE_SET.has(message.role)) return null;
  const content = message.role === 'assistant' || message.role === 'user'
    ? canonicalBlocks(message.content)
    : message.content;
  return { ...message, content };
}
// A settled message does not change, so it is translated once: the same
// message in is the same message out, and what is kept by identity further on
// (the pictures the server hands the window by address) is found again. The
// message still being written changes in place, so it is translated afresh.
const translated = new WeakMap();
export function canonicalMessage(message) {
  if (!message || typeof message !== 'object') return null;
  if (!translated.has(message)) translated.set(message, translate(message));
  return translated.get(message);
}
// A list that has not changed since it was last translated is answered with
// the same translation.
const lists = new WeakMap();
function canonicalMessages(messages = []) {
  const kept = lists.get(messages);
  if (kept?.length === messages.length) return kept.out;
  const out = messages.map(canonicalMessage).filter(Boolean);
  lists.set(messages, { length: messages.length, out });
  return out;
}

// The snapshot every harness answers with. Fields absent from a harness are
// absent here too rather than faked: a missing `stats` is an honest gap the
// pane can hide, while a zeroed one is a lie the person would read as fact.
export function canonicalSnapshot(raw = {}, source = raw.source ?? 'pi') {
  if (!SOURCES.includes(source) || (raw.source != null && !SOURCES.includes(raw.source))) {
    throw new Error('Unsupported execution source');
  }
  return {
    ...raw,
    source,
    messages: canonicalMessages(raw.messages),
    partial: raw.partial ? translate(raw.partial) : null,
    busy: Boolean(raw.busy),
    streaming: Boolean(raw.streaming),
  };
}
