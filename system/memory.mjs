// Memory: a system of record of what Noah does with his computers, in one
// place on the PC (~/.imperfect/memory/), and his last exchanges for agents
// to read first. It is plumbing, by code alone: no model reads or writes it.
//
// The record is the harnesses' own session logs, the way code is the record
// of a codebase. A pass copies every log that changed gzipped into
// raw/<computer>/<harness>/ (and each computer's ~/imperfect reflog into
// reflog/), so nothing is lost when a harness tidies its logs away. (The
// calls with Vaita there were, and their sounds, were copied as they are into
// raw/<computer>/calls/; those stay, and are counted, but no more are made.)
// The logs themselves are left exactly as they
// are (each harness needs its log to resume a session). A log is copied once
// it has been still for 30 minutes, so never halfway through a write, and
// again if it grew (it was resumed): .done.json remembers each log's size and
// time. Until then it is in live/ under the name it will have in raw/: a
// link to it where it is on this computer, and a copy of one another computer
// is writing, fetched again as it grows (follow), so what was said a minute
// ago anywhere is in memory at the next pass. Other computers are reached
// over ssh, named in computers.json ({ "laptop": "noah@laptop" }); one that
// does not answer is skipped and caught up later.
//
// recent.md is Noah's last EXCHANGES exchanges, across every session,
// harness and computer, in the order he spoke: each his message and the
// agent's reply to it, its last words before he spoke again (the filter),
// word for word, headed with the time, computer, harness, session, the folder
// it ran in and the commit ~/imperfect was at. A reply over REPLY_CHARS (and
// a message of his over WORDS_CHARS) is cut, with the log and line where the
// whole is. A pass reads the logs newest first, only as far back as those
// exchanges need (load), and writes recent.md again.
//
// The filter keeps:
//
//   - Noah's message, word for word: injected system reminders, hook output
//     and voice-mode instructions are cut, a picture becomes [image] and a
//     pasted block [pasted text: its first line];
//   - the agent's last text before Noah's next message, word for word.
//
// Both leave out sessions in which Noah never spoke or that ran in a
// throwaway folder, a line a log holds twice (Claude Code sometimes writes
// part of a session again), thinking, and errors a retry replaced. A replay,
// a session in which everything distinctive Noah said he had said word for
// word in an earlier one (a probe or a test run again), is left out. Secrets
// are redacted on the way out: anything shaped like a key, a password said in
// so many words, the exact values of the files in ~/.imperfect/credentials/
// (read here, kept in memory only), and the words in .secrets (hashes of what
// the model that once wrote memory reported redacting).
//
// Any other view of the record (a day, a project, what is still open) is for
// the agent that wants it to make from raw/ and Git when it wants it. recall
// searches the words in the logs themselves.
//
// A timer starts a pass every two minutes, and one runs at a time (lock).
// Every two hours the pass then keeps Pi and Claude Code up to date
// (system/upgrade.mjs).
//
//   node system/memory.mjs                  a pass (the timer)
//   node system/memory.mjs search <words>   what was said: Noah first, newest first
//   node system/memory.mjs sizes            logs and raw bytes per computer
//   node system/memory.mjs home             exit 0 when memory lives on this computer (install.sh)
//
// recall (RECALL_TOOL, runRecall) is the search as an agent tool. On another
// computer it asks the PC (POST /memory, createMemoryRoute), the way
// generate_image asks it for a paid picture: memory stays in one place.
import { constants } from 'node:buffer';
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { appendFile, chmod, lstat, mkdir, open, readdir, readFile, readlink, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { hostname } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { pipeline, Readable } from 'node:stream';
import { pipeline as pipe } from 'node:stream/promises';
import { createGunzip, gunzipSync } from 'node:zlib';
import { SECRETS } from '../locker/hooks/pre-receive.mjs';
import { readConfig, resolvePrefix } from './machine.mjs';
import { importedBytes, readMemoryImport, validateMemoryImport } from './memory-imports.mjs';
import { readTailnet, tailnetStatus } from './machines.mjs';
import { durableArchiveRows, loadDurableArchive } from '../apps/code/native/durable-archive.mjs';

const QUIET_MS = 30 * 60_000; // a log this still is copied into raw/
const REPO = resolve(import.meta.dirname, '..');
export const memoryDir = (prefix = resolvePrefix()) => join(prefix, 'memory');

// --- time, in this computer's own zone ---------------------------------------
const pad = n => String(n).padStart(2, '0');
export function localTime(ms) {
  const d = new Date(ms);
  const off = -d.getTimezoneOffset();
  const zone = `${off < 0 ? '-' : '+'}${pad(Math.floor(Math.abs(off) / 60))}:${pad(Math.abs(off) % 60)}`;
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${zone}`;
}
const day = ms => localTime(ms).slice(0, 10);
const clock = ms => localTime(ms).slice(11, 16);

// --- secrets -----------------------------------------------------------------
// The store's list of what must never be pushed, and a few more shapes.
const SHAPES = [
  ...SECRETS.map(([pattern]) => pattern),
  /\bic_[A-Za-z0-9]{16,}/,
  /\bsk-[A-Za-z0-9_-]{16,}/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/,
  /\bxox[a-z]-[A-Za-z0-9-]{10,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\b[prs]k_(live|test)_[A-Za-z0-9]{8,}/,
  /\btskey-[a-z]+-/,
  /\bcf[a-z]{1,3}_[A-Za-z0-9]{30,}/,
].map(pattern => new RegExp(`(?:${pattern.source})[\\w-]*`, 'g')); // to the end of the token

// A value in a credentials file that is worth hunting for: long, one word,
// not an address, a path or a plain URL.
const secretLike = v => v.length >= 10 && !/\s/.test(v) && !/^[a-z][a-z0-9+.-]*:\/\/[^@]*$/i.test(v)
  && !/^[^@\s]+@[^@\s]+\.[a-z]+$/i.test(v) && !/^[/~.]/.test(v) && (/\d/.test(v) || v.length >= 24);

// The values in ~/.imperfect/credentials/, never written anywhere.
export async function credentialValues(dir, files = null) {
  const values = new Set();
  const take = v => { if (typeof v === 'string' && secretLike(v.trim())) values.add(v.trim()); };
  const leaves = v => { if (v && typeof v === 'object') Object.values(v).forEach(leaves); else take(v); };
  for (const name of files ?? await readdir(dir).catch(() => [])) {
    const bytes = await readFile(join(dir, name)).catch(() => null);
    if (!bytes || bytes.includes(0)) continue; // a keystore, or a folder
    const text = bytes.toString('utf8');
    try {
      const parsed = JSON.parse(text);
      // Claude's config snapshot mixes sign-in state with public feature/model
      // caches. Exempt only observed public model metadata positions, never
      // arbitrary leaves in a cache. Key-shape redaction remains independent.
      if (name === '.claude.json' && parsed && typeof parsed === 'object') {
        for (const [key, value] of Object.entries(parsed)) {
          if (['cachedGrowthBookFeatures', 'cachedExperimentData', 'clientDataCacheSlots'].includes(key)) {
            const publicModel = path => (
              key === 'clientDataCacheSlots' && path.length === 2 && /^bi1-[a-f0-9]{16}$/.test(path[0]) && path[1] === 'model'
            ) || (
              key === 'cachedGrowthBookFeatures' && path.length === 2 && ['tengu_tool_search_unsupported_models', 'tengu_lucky_cerf'].includes(path[0]) && /^\d+$/.test(path[1])
            ) || (
              key === 'cachedExperimentData' && path.length === 3 && path[0] === 'tengu_lucky_cerf' && path[1] === 'value' && /^\d+$/.test(path[2])
            );
            const metadata = (v, path = []) => {
              if (v && typeof v === 'object') for (const [field, child] of Object.entries(v)) metadata(child, [...path, field]);
              else if (!publicModel(path) || typeof v !== 'string' || !/^claude-(?:opus|sonnet|haiku|fable|[0-9])[-a-z0-9]*$/.test(v)) take(v);
            };
            metadata(value);
          } else leaves(value);
        }
      } else leaves(parsed);
      continue;
    } catch {}
    for (const line of text.split('\n')) {
      take(line);
      const value = /^\s*(?:export\s+)?[\w.-]+\s*[=:]\s*(.*)$/.exec(line)?.[1];
      if (value) take(value.trim().replace(/^(['"])(.*)\1$/, '$2'));
    }
  }
  return [...values].sort((a, b) => b.length - a.length);
}

const hash = text => createHash('sha256').update(text).digest('hex');
// A word, for matching against the hashes in .secrets.
const WORD = /[^\s'"`<>()[\]{},;:=/\\|*]{6,}/g;

// hashes: of words to redact wherever they appear (learned).
export function redactor(values = [], hashes = new Set()) {
  return text => {
    let out = String(text)
      .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[redacted private key]')
      .replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:'"]+:[^\s/@'"]+@/gi, '$1[redacted]@')
      .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/g, 'Bearer [redacted]')
      // a password said in so many words: "sudo is …", "password: …", "… is the password"
      .replace(/\b((?:sudo|password)(?: password)?(?: is|:)\s+)(?!\[redacted\]|(?:required|needed|not|no|available|enabled|disabled|blocked|missing|set|the|a|an|only|still|now|fine|ok|okay|working|asked|prompting|wrong|correct|right|changed|in|on)\b)[^\s,.;)]+/gi, '$1[redacted]')
      .replace(/(\S{4,})(\s+is\s+(?:the|my|his)\s+(?:sudo\s+)?(?:password|passcode|pin)\b)/gi, (all, word, rest) => (/[\d\W_]|[a-z][A-Z]/.test(word) && word !== '[redacted]' ? `[redacted]${rest}` : all));
    for (const shape of SHAPES) out = out.replace(shape, '[redacted]');
    for (const value of values) if (out.includes(value)) out = out.split(value).join('[redacted]');
    if (hashes.size) {
      out = out.replace(WORD, word => {
        const bare = word.replace(/[.,!?]+$/, '');
        return hashes.has(hash(bare)) ? `[redacted]${word.slice(bare.length)}` : word;
      });
    }
    return out;
  };
}

// What the model that once wrote memory reported redacting, kept as hashes in
// .secrets: each one word of at least six characters, the way WORD finds it,
// shaped like a secret. Nothing adds to it any more; it is still applied.
const learned = async dir => new Set((await readFile(join(dir, '.secrets'), 'utf8').catch(() => '')).split('\n').filter(line => /^[0-9a-f]{64}$/.test(line)));

// --- the filter --------------------------------------------------------------
// The words of a message, with a marker for each thing that is not words.
function said(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map(b => (b?.type === 'text' ? b.text ?? '' : b?.type === 'image' ? '[image]' : b?.type === 'document' ? '[document]' : ''))
    .filter(Boolean).join('\n');
}

const firstLine = text => (String(text).split('\n').map(line => line.trim()).find(Boolean) ?? '').slice(0, 100);
// What the harness says on Noah's behalf: notifications, command output, stops.
const HARNESS = /^(<task-notification>|<local-command-|\[Request interrupted by user|Caveat: The messages below)/;

// A picture (or any file) written into text as a data: URL.
const DATA_URL = /data:[\w/+.-]+;base64,[A-Za-z0-9+/=]{64,}/g;
export function noahWords(text) {
  const words = String(text)
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
    .replace(/<([\w-]*hook[\w-]*)>[\s\S]*?<\/\1>/g, '')
    .replace(/(<\/spoken-input>)\s*<instruction>[\s\S]*?<\/instruction>/g, '$1')
    .replace(/<spoken-input>\s*([\s\S]*?)\s*<\/spoken-input>/g, '[spoken] $1')
    .replace(/<pasted_content[^>]*>([\s\S]*?)<\/pasted_content[^>]*>/g, (_, body) => `[pasted text: ${firstLine(body)}]`)
    .replace(DATA_URL, '[data]')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  // A slash command reads as he typed it: /model opus.
  const command = /<command-name>\s*([^<]*?)\s*<\/command-name>/.exec(words);
  if (command) return [command[1], /<command-args>([\s\S]*?)<\/command-args>/.exec(words)?.[1].trim()].filter(Boolean).join(' ');
  return HARNESS.test(words) ? '' : words;
}

// Turns: each of Noah's messages, then the agent's last text before his next,
// each with the line of the log it begins on (and, for a reply in more than
// one block, the line it ends on). Text before his first message answers
// nobody.
function turns(events, afterRecord = 0) {
  const out = [];
  let reply = null;
  for (const event of events) {
    // A new block may share the old reply's message id, but not its words.
    if (afterRecord && event.sourceRecordIndex > afterRecord && reply?.sourceRecordIndex <= afterRecord) reply = null;
    if (event.who === 'noah') {
      if (reply) out.push(reply);
      reply = null;
      out.push(event);
    } else if (event.who === 'agent' && out.length) {
      const same = reply && event.id && reply.id === event.id;
      reply = same ? (reply.text.endsWith(event.text) ? reply : { ...event, line: reply.line, end: event.line, text: `${reply.text}\n\n${event.text}` }) : event;
    }
  }
  if (reply) out.push(reply);
  return out.filter(event => !afterRecord || event.sourceRecordIndex > afterRecord)
    .map(({ at, who, text, line, end }) => ({ at, who, text: text.trim(), line, ...(end > line ? { end } : {}) }));
}

// A log's lines, read as its bytes stream in: only one line is ever a string,
// so a log of any size is read whole if no line of it is longer than most
// (what Node can make a string of; a line longer is the log's error).
export async function* logLines(bytes, most = constants.MAX_STRING_LENGTH) {
  let parts = [], size = 0;
  for await (const chunk of bytes) {
    let start = 0, end;
    while ((end = chunk.indexOf(10, start)) !== -1) {
      parts.push(chunk.subarray(start, end));
      size += end - start;
      if (size > most) break;
      yield Buffer.concat(parts, size).toString('utf8');
      parts = [];
      size = 0;
      start = end + 1;
    }
    if (size <= most && start < chunk.length) { parts.push(chunk.subarray(start)); size += chunk.length - start; }
    if (size > most) throw new Error(`a line of more than ${most} bytes`);
  }
  if (size) yield Buffer.concat(parts, size).toString('utf8');
}

// Pictures go as soon as a line is read: an image (or document) keeps only
// that it was one, which is all said() notes ([image]), and a data: URL
// anywhere is [data], as in Noah's words. What a tool wrote into a file is
// only measured (toolLine), never shown, so it keeps its length.
const ARGUMENTS = { tool_use: 'input', toolCall: 'arguments' };
function unpictured(value, measured = false) {
  if (typeof value === 'string') return measured ? value : value.replace(DATA_URL, '[data]');
  if (!value || typeof value !== 'object') return value;
  if (value.type === 'image' || value.type === 'document') return { type: value.type };
  for (const [key, inner] of Object.entries(value)) {
    value[key] = key === ARGUMENTS[value.type] && inner && typeof inner === 'object' && !Array.isArray(inner)
      ? Object.fromEntries(Object.entries(inner).map(([name, arg]) => [name, unpictured(arg, measured || BODY.test(name))]))
      : unpictured(inner, measured);
  }
  return value;
}

// A log's JSON objects, pictures out, from its text or a stream of its bytes:
// each with its line in the log, and its place among the log's records
// (sourceRecordIndex, which an import's cutoff counts).
async function* records(log, most) {
  let sourceRecordIndex = 0, line = 0;
  for await (const text of typeof log === 'string' ? log.split('\n') : logLines(log, most)) {
    line++;
    if (!text.trim()) continue;
    sourceRecordIndex++;
    let record;
    try { record = JSON.parse(text); } catch { continue; }
    yield { record: unpictured(record), sourceRecordIndex, line };
  }
}

const oneLine = (text, most) => { const line = String(text).replace(/\s+/g, ' ').trim(); return line.length > most ? `${line.slice(0, most)}…` : line; };

// A tool call is one line: its name and arguments, a body (what was written
// into a file) only measured; and its result cut short, a file read only
// counted, a worker's report kept longer. Copies of one history are told
// apart by them too (load).
const BODY = /^(content|new_string|old_string|edits|oldText|newText|patch)$/;
function toolLine(name, input) {
  const args = Object.entries(input && typeof input === 'object' ? input : {}).flatMap(([key, value]) => {
    if (value == null || value === '') return [];
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    return [BODY.test(key) ? `${key}=(${text.length} chars)` : `${key}=${oneLine(text, /prompt|command|text|description|query/.test(key) ? 600 : 160)}`];
  });
  return `${name}(${args.join(', ')})`;
}
function resultLine(name, content, error) {
  const text = said(content).trim();
  if (!text) return error ? 'error' : '';
  if (/^read$/i.test(name) && !error) return `(${text.split('\n').length} lines)`;
  return `${error ? 'error: ' : ''}${oneLine(text, /^(agent|task)$/i.test(name) ? 2000 : 300)}`;
}

// Each reader answers the session's id, folder and the agent's models; its
// events in order: Noah's words, the agent's words, each tool call (with its
// result) and the harness's notes (a worker finished); and from those the
// filter's turns (entries). Each reads a log's text or a stream of its bytes
// (most: as logLines).
// Claude Code: one JSON object a line; an assistant message is spread over a
// line per block, sharing message.id. It sometimes writes a stretch of a
// session into its log again, uuids and all: a line already read is skipped.
export async function readClaude(log, most, { afterRecord = 0 } = {}) {
  let id = '', cwd = '';
  const events = [], models = new Set(), calls = new Map(), seen = new Set();
  for await (const { record: e, sourceRecordIndex, line } of records(log, most)) {
    const emit = event => events.push({ ...event, sourceRecordIndex, line });
    if (seen.has(e.uuid)) continue;
    if (e.uuid) seen.add(e.uuid);
    const at = Date.parse(e.timestamp);
    id ||= e.sessionId ?? '';
    cwd ||= e.cwd ?? '';
    if (e.isSidechain || !Number.isFinite(at)) continue;
    const content = e.message?.content;
    if (e.type === 'user') {
      const results = Array.isArray(content) ? content.filter(b => b?.type === 'tool_result') : [];
      for (const b of results) { const call = calls.get(b.tool_use_id); if (call) call.result = resultLine(call.name, b.content, b.is_error); }
      const words = said(content);
      if (/^\s*<task-notification>/.test(words)) { emit({ at, who: 'note', text: oneLine(words.replace(/<[^>]*>/g, ' '), 600) }); continue; }
      if (e.toolUseResult !== undefined || results.length || e.isMeta || e.isCompactSummary || e.promptSource === 'system' || (e.origin && e.origin.kind !== 'human')) continue;
      const noah = noahWords(words);
      if (noah) emit({ at, who: 'noah', text: noah });
    } else if (e.type === 'attachment' && e.attachment?.type === 'queued_command' && (e.attachment.commandMode ?? 'prompt') === 'prompt') {
      // What Noah sends while the agent works reaches it mid-turn, as an attachment, not a message of its own.
      const noah = noahWords(said(e.attachment.prompt));
      if (noah) emit({ at: Date.parse(e.attachment.timestamp) || at, who: 'noah', text: noah });
    } else if (e.type === 'assistant' && !e.isApiErrorMessage && e.message?.model !== '<synthetic>') {
      if (e.message?.model && sourceRecordIndex > afterRecord) models.add(e.message.model);
      for (const b of Array.isArray(content) ? content : []) {
        if (b?.type === 'text' && b.text?.trim()) emit({ at, who: 'agent', id: e.message?.id, text: b.text });
        else if (b?.type === 'tool_use') { const call = { at, who: 'tool', name: b.name, text: toolLine(b.name, b.input), result: '', sourceRecordIndex }; calls.set(b.id, call); events.push(call); }
      }
    }
  }
  return { id, cwd, models: [...models], events: events.filter(event => event.sourceRecordIndex > afterRecord), entries: turns(events, afterRecord) };
}

// Pi: a header line, then entries; a reply that failed is retried as another.
export async function readPi(log, most, { afterRecord = 0, archive = false } = {}) {
  let id = '', cwd = '';
  const events = [], models = new Set(), calls = new Map(), seen = new Set();
  for await (const { record: e, sourceRecordIndex: index, line } of records(log, most)) {
    const sourceRecordIndex = archive ? e.sourceRecordIndex : index;
    const emit = event => events.push({ ...event, sourceRecordIndex, line });
    const at = Date.parse(e.timestamp);
    if (e.type === 'session') { id ||= e.id ?? ''; cwd ||= e.cwd ?? ''; continue; }
    if (e.type !== 'message' || !Number.isFinite(at)) continue;
    if (afterRecord && e.id) {
      if (seen.has(e.id)) continue; // a replay of a historical record is not a new turn
      seen.add(e.id);
    }
    const m = e.message ?? {};
    if (archive && m.role === 'user' && e.archiveKind && e.archiveKind !== 'pi.user') {
      emit({ at, who: 'note', text: oneLine(said(m.content), 600) });
    } else if (m.role === 'user') {
      const words = noahWords(said(m.content));
      if (words) emit({ at, who: 'noah', text: words });
    } else if (m.role === 'toolResult') {
      const call = calls.get(m.toolCallId);
      if (call) call.result = resultLine(call.name, m.content, m.isError);
    } else if (m.role === 'assistant' && m.stopReason !== 'error') {
      if (m.model && sourceRecordIndex > afterRecord) models.add(m.provider ? `${m.provider}/${m.model}` : m.model);
      for (const b of Array.isArray(m.content) ? m.content : []) {
        if (b?.type === 'text' && b.text?.trim()) emit({ at, who: 'agent', id: e.id, text: b.text });
        else if (b?.type === 'toolCall') { const call = { at, who: 'tool', name: b.name, text: toolLine(b.name, b.arguments), result: '', sourceRecordIndex }; calls.set(b.id, call); events.push(call); }
      }
    }
  }
  return { id, cwd, models: [...models], events: events.filter(event => event.sourceRecordIndex > afterRecord), entries: turns(events, afterRecord) };
}
// Codex rollouts retain response items as well as UI event messages. Prefer
// the response items (including tools), never both copies of the same turn.
export async function readCodex(log, most, { afterRecord = 0 } = {}) {
  let id = '', cwd = '', source;
  const events = [], fallback = [], models = new Set(), calls = new Map(), seen = new Set();
  const content = blocks => said(typeof blocks === 'string' ? blocks : blocks?.map(b => ({ ...b,
    type: ['input_text', 'output_text'].includes(b?.type) ? 'text' : b?.type === 'input_image' ? 'image' : b?.type })));
  const userWords = text => /^(?:# AGENTS\.md instructions\b|<environment_context\b|<INSTRUCTIONS>)/.test(text.trim()) ? '' : noahWords(text);
  for await (const { record: e, sourceRecordIndex, line } of records(log, most)) {
    const p = e.payload ?? {}, at = Date.parse(e.timestamp);
    if (e.type === 'session_meta') { id ||= p.id ?? ''; cwd ||= p.cwd ?? ''; source = p.source; continue; }
    if (e.type === 'turn_context') { if (p.model && sourceRecordIndex > afterRecord) models.add(p.model); continue; }
    if (!Number.isFinite(at) || !['event_msg', 'response_item'].includes(e.type)) continue;
    const key = JSON.stringify([e.type, at, p]);
    if (seen.has(key)) continue;
    seen.add(key);
    const emit = (event, into = events) => into.push({ at, ...event, sourceRecordIndex, line });
    if (e.type === 'event_msg') {
      const item = p.type === 'item_completed' ? p.item : null;
      const who = p.type === 'user_message' || item?.type === 'UserMessage' ? 'noah'
        : p.type === 'agent_message' || item?.type === 'AgentMessage' ? 'agent' : null;
      const text = who === 'noah' ? userWords(item ? content(item.content) : p.message ?? '') : item ? content(item.content) : p.message;
      if (who && text?.trim()) emit({ who, text }, fallback);
    } else if (e.type === 'response_item') {
      if (p.type === 'message' && ['user', 'assistant'].includes(p.role)) {
        const text = p.role === 'user' ? userWords(content(p.content)) : content(p.content);
        if (text.trim()) emit({ who: p.role === 'user' ? 'noah' : 'agent', id: p.id, text });
      } else if (['function_call', 'custom_tool_call'].includes(p.type)) {
        let input = p.input ?? p.arguments;
        if (typeof input === 'string') { try { input = JSON.parse(input); } catch { input = { arguments: input }; } }
        const call = { at, who: 'tool', name: p.name, text: toolLine(p.name, input), result: '', sourceRecordIndex };
        calls.set(p.call_id, call); events.push(call);
      } else if (['function_call_output', 'custom_tool_call_output'].includes(p.type)) {
        const call = calls.get(p.call_id);
        if (call) call.result = resultLine(call.name, content(p.output), false);
      }
    }
  }
  // Exec/subagent rollouts are still archived byte-for-byte, not exchanges in
  // which their injected task is mistaken for Noah speaking.
  if (source && !['cli', 'vscode'].includes(source)) return { id, cwd, models: [], events: [], entries: [] };
  const echoes = new Map(), echoKey = e => JSON.stringify([e.who, e.text.replace(/\[(?:image|document)\]/g, '').trim()]);
  for (const e of events) echoes.set(echoKey(e), (echoes.get(echoKey(e)) ?? 0) + 1);
  for (const e of fallback) {
    const key = echoKey(e), n = echoes.get(key) ?? 0;
    if (n) echoes.set(key, n - 1); else events.push(e);
  }
  events.sort((a, b) => a.sourceRecordIndex - b.sourceRecordIndex);
  return { id, cwd, models: [...models], events: events.filter(e => e.sourceRecordIndex > afterRecord), entries: turns(events, afterRecord) };
}
const READERS = { claude: readClaude, pi: readPi, codex: readCodex };

// --- joined to git -----------------------------------------------------------
// `git reflog --date=iso-strict --format='%H %gd'`: "<hash> HEAD@{<time>}", newest first.
export function parseReflog(text) {
  return String(text).split('\n').flatMap(line => {
    const m = /^([0-9a-f]{40}) \S*@\{([^}]+)\}/.exec(line.trim());
    const at = m && Date.parse(m[2]);
    return m && Number.isFinite(at) ? [{ commit: m[1], at }] : [];
  }).sort((a, b) => a.at - b.at);
}
export const commitAt = (reflog, at) => reflog.findLast(move => move.at <= at)?.commit ?? null;

// Uuid v7 ids (Pi) begin with the time, so their tail tells sessions apart.
export const shortId = id => (/^[0-9a-f]{8}-[0-9a-f]{4}-7/.test(id) ? id.replace(/-/g, '').slice(-8) : id.replace(/-/g, '').slice(0, 8));

// --- sessions ----------------------------------------------------------------
// Probes and tests run in throwaway folders; nobody spoke there.
const throwaway = cwd => /^(\/tmp|\/var\/tmp|\/private\/tmp|\/(?:home|Users)\/[^/]+\/\.cache)(\/|$)/.test(cwd);
// Shorter than this, what Noah said ("yes", "continue") is not distinctive.
const DISTINCTIVE = 20;

// A replay: a session in which everything distinctive Noah said, he had said
// word for word in an earlier one. It points to where he first said it.
function markReplays(sessions) {
  for (const session of sessions) delete session.replayOf;
  const said = session => session.entries.filter(entry => entry.who === 'noah' && entry.text.length >= DISTINCTIVE);
  const first = new Map();
  for (const session of sessions) {
    if (session.imported) continue; // continuations cannot turn canonical history into a replay
    for (const entry of said(session)) {
      const known = first.get(entry.text);
      if (!known || entry.at < known.at) first.set(entry.text, { session, at: entry.at });
    }
  }
  for (const session of sessions) {
    const own = said(session), earlier = own.map(entry => first.get(entry.text));
    if (!session.imported && own.length && earlier.every((known, i) => known.session !== session && known.at < own[i].at)) session.replayOf = earlier[0];
  }
}

// --- reading -----------------------------------------------------------------
// The logs in raw/, and those still being written (live: read where they are
// on this computer, from live/ for another's, standing in for their older
// copies in raw/), newest first by when each was last written, read one at a
// time until Noah's distinct messages in them reach back past every log not
// yet read (with SLACK for the computers' clocks): a log last written before
// a message cannot hold a newer one, so the newest `want` exchanges are all
// in hand. Copies of one history (a mirror, a Durable archive of a log, an
// import) count once, and a replay is left out; if that leaves fewer than
// `want`, it reads on.
const EXCHANGES = 20;
const SLACK = 10 * 60_000;
async function load({ prefix, dir, live = [], want = EXCHANGES, log }) {
  const redact = redactor(await credentialValues(join(prefix, 'credentials')), await learned(dir));
  const done = Object.values(await readDone(dir));
  const written = new Map(done.map(entry => [entry.raw, entry.mtime]));
  const imports = new Map(done.filter(entry => entry.importPath).map(entry => [entry.raw, entry.importPath]));
  const provenanceByRaw = new Map(done.filter(entry => entry.provenance).map(entry => [entry.raw, entry.provenance]));
  const provenanceByPath = new Map(done.filter(entry => entry.provenance).map(entry => [entry.provenance.path, entry.provenance]));
  const logs = new Map();
  for (const computer of await readdir(join(dir, 'raw')).catch(() => [])) {
    for (const harness of Object.keys(READERS)) {
      for (const name of (await readdir(join(dir, 'raw', computer, harness)).catch(() => [])).filter(name => name.endsWith('.gz'))) {
        const raw = join('raw', computer, harness, name);
        const mtime = written.get(raw) ?? (await stat(join(dir, raw)).catch(() => null))?.mtimeMs ?? 0;
        logs.set(raw, { computer, harness, mtime, bytes: () => pipeline(createReadStream(join(dir, raw)), createGunzip(), () => {}) });
      }
    }
  }
  for (const { raw, path, snapshot, mtime, source } of live) {
    const [, computer, harness] = raw.split('/');
    logs.set(raw, { computer, harness, bytes: () => createReadStream(path), path, snapshot, mtime, source });
  }
  const order = [...logs].sort(([a, x], [b, y]) => y.mtime - x.mtime || (a < b ? -1 : 1));
  const sessions = [], reflogs = new Map(), said = new Map();
  let next = 0, target = want, kept = [], exchanges = [];
  async function read([raw, { computer, harness, bytes, path, snapshot, mtime, source }]) {
    if (!reflogs.has(computer)) reflogs.set(computer, parseReflog(await readFile(join(dir, 'reflog', computer), 'utf8').catch(() => '')));
    try {
      const durable = raw.endsWith('.sqlite.gz');
      const importPath = imports.get(raw) ?? path;
      const provenance = durable ? provenanceByRaw.get(raw) : importPath ? (await readMemoryImport(dir, importPath) || provenanceByPath.get(importPath)) : null;
      if (imports.has(raw) && !provenance) throw new Error('memory import: archived import manifest missing');
      let session, legacyHash, identity, archiveSize;
      const digest = createHash('sha256');
      if (durable) {
        const archive = await loadDurableArchive(snapshot || join(dir, raw));
        const legacy = archive.entries.find(e => e.kind === 'imperfect.legacy');
        if (legacy) {
          legacyHash = hash(legacy.data.source);
          if (provenance) for await (const _ of importedBytes(Readable.from([Buffer.from(legacy.data.source)]), provenance)) { /* validate immutable prefix */ }
        } else if (provenance) throw new Error('memory import: Durable archive has no original');
        session = await readPi(durableArchiveRows(archive, { activeBranch: true }).map(JSON.stringify).join('\n'), undefined,
          { afterRecord: provenance?.recordCount ?? 0, archive: true });
        identity = archive.identity; archiveSize = archive.entries.length;
      } else {
        const hashed = async function* () { for await (const chunk of bytes()) { digest.update(chunk); yield chunk; } };
        session = await READERS[harness](provenance ? importedBytes(hashed(), provenance) : hashed(), undefined,
          { afterRecord: provenance?.recordCount ?? 0 });
      }
      session.id ||= basename(raw, '.jsonl.gz');
      // Keep even an empty Durable projection here: it can supersede a legacy
      // import containing only historical/abandoned messages.
      if ((durable || (provenance ? session.entries.length : session.entries.some(entry => entry.who === 'noah'))) && !throwaway(session.cwd)) {
        sessions.push({ ...session, computer, harness, durable, identity, archiveSize, legacyHash, sourceHash: durable ? null : digest.digest('hex'), imported: Boolean(provenance), raw, path, source, live: Boolean(path), mtime, reflog: reflogs.get(computer) });
        for (const entry of session.entries) if (entry.who === 'noah') said.set(`${entry.at}\n${entry.text}`, entry.at);
      }
    } catch (error) {
      log(`${raw}: ${error.message}`);
    }
  }
  const enough = () => {
    if (next >= order.length) return true;
    const times = [...said.values()].sort((a, b) => b - a);
    return times.length >= target && times[target - 1] > order[next][1].mtime + SLACK;
  };
  for (;;) {
    while (!enough()) await read(order[next++]);
    kept = distinct(sessions);
    exchanges = exchangesOf(kept);
    if (exchanges.length >= want || next >= order.length) break;
    target += want - exchanges.length;
  }
  return { sessions: kept, exchanges: exchanges.slice(-want), redact };
}

// The sessions read, each history once.
function distinct(sessions) {
  // Exact source bytes, not a shared title/UUID, prove a JSONL is already in a
  // Durable archive. Snapshots/mirrors of that same Durable identity count once.
  const originals = new Set(sessions.filter(s => s.legacyHash).map(s => `${s.computer}:${s.legacyHash}:${s.imported}`));
  const latest = new Map();
  for (const s of sessions.filter(s => s.durable)) {
    const key = s.identity;
    if (!latest.has(key) || latest.get(key).archiveSize < s.archiveSize || (latest.get(key).archiveSize === s.archiveSize && s.imported && !latest.get(key).imported)) latest.set(key, s);
  }
  const selected = sessions.filter(s => s.durable ? latest.get(s.identity) === s && s.entries.length : !originals.has(`${s.computer}:${s.sourceHash}:${s.imported}`));
  // A runtime archive/renamed rollout can mirror a native log, or an older
  // prefix of it. UUID alone is not proof: retain divergent histories. Compare
  // original bytes or the complete ordered narrative, within one provenance.
  const unique = [], histories = new Map();
  const narrative = s => s.events.map(({ at, who, id, name, text, result }) => JSON.stringify([at, who, id, name, text, result]));
  for (const s of selected) {
    if (s.durable) { unique.push(s); continue; }
    const key = JSON.stringify([s.computer, s.harness, s.id, s.cwd, s.imported]);
    const peers = histories.get(key);
    if (!peers) { histories.set(key, [{ session: s }]); unique.push(s); continue; }
    const story = narrative(s);
    const same = peers.find(p => p.session.sourceHash === s.sourceHash || (p.story ||= narrative(p.session)).slice(0, Math.min(p.story.length, story.length)).every((event, i) => event === story[i]));
    if (!same) { peers.push({ session: s, story }); unique.push(s); }
    else if (story.length > same.session.events.length || (story.length === same.session.events.length && s.live && !same.session.live)) {
      unique[unique.indexOf(same.session)] = s;
      same.session = s; same.story = story;
    }
  }
  markReplays(unique);
  return unique;
}

// Every exchange in the sessions but the replays', in the order Noah spoke: his
// message and the agent's reply (null when he spoke again first). A reply
// whose message is before what is read of the log (an import's cutoff) is an
// exchange of its own, with no message.
function exchangesOf(sessions) {
  const out = [];
  for (const session of sessions) {
    if (session.replayOf) continue;
    let last = null;
    for (const entry of session.entries) {
      if (entry.who === 'noah') out.push(last = { session, at: entry.at, noah: entry, reply: null });
      else if (last && !last.reply) last.reply = entry;
      else out.push(last = { session, at: entry.at, noah: null, reply: entry });
    }
    if (last) last.final = true;
  }
  return out.sort((a, b) => a.at - b.at);
}

// --- recent.md ---------------------------------------------------------------
// The exchanges, oldest first, under a few lines on what this is and where
// the ground truth is. Each is headed with its day and time (this computer's
// zone), computer, harness and short session id, the folder it ran in and
// the commit ~/imperfect was at, and whether the session's log is still being
// written; then Noah's message and the agent's reply, word for word, quoted
// so that nothing in them reads as this file's own structure.
const REPLY_CHARS = 1500; // a reply longer than this is cut, with where the whole is
const WORDS_CHARS = 6000; // and a message of Noah's longer than this
const tilde = path => String(path).replace(/^\/(?:home|Users)\/[^/]+(?=\/|$)/, '~');
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const quoted = text => text.split('\n').map(line => (line ? `> ${line}` : '>')).join('\n');

// Where what was said is whole: its line in the log in raw/, or in the log
// still being written (where it is on this computer, or its copy in live/).
function whereSaid(session, entry, dir) {
  const lines = entry.end ? `lines ${entry.line}–${entry.end}` : `line ${entry.line}`;
  const raw = tilde(join(dir, session.raw));
  if (session.durable) return `row ${entry.line} of the rows of the Durable archive ${raw} (durableArchiveRows in apps/code/native/durable-archive.mjs)`;
  if (session.live) return `${lines} of ${tilde(session.path)}${session.source ? `, a copy of ${session.computer}:${tilde(session.source)}` : ''}, still being written (then ${raw})`;
  return `${lines} of ${raw}`;
}

// Text cut to most characters, at a space where one is near, saying how much
// more there is and where.
function cut(text, most, where) {
  if (text.length <= most) return text;
  const head = text.slice(0, most), space = head.search(/\s\S*$/), kept = (space > most - 200 ? head.slice(0, space) : head).trimEnd();
  return `${kept} […]\n\n[cut: ${text.length - kept.length} more characters. The whole is ${where}.]`;
}

function renderRecent(exchanges, { now, dir, redact }) {
  const made = localTime(now);
  const out = [`# recent: Noah's last ${plural(exchanges.length, 'exchange')} with his agents, oldest first`, '',
    `Made ${made.slice(0, 16).replace('T', ' ')} (${made.slice(19)}, the zone of every time here) from the logs of every session on every computer. Each exchange is what Noah said and the agent's reply, its last words before he spoke again, word for word; a reply over ${REPLY_CHARS} characters is cut, with where the whole is. The ground truth is the logs themselves, copied unchanged into ${tilde(dir)}/raw/<computer>/<harness>/ (gzipped JSONL: \`zcat <log> | sed -n <line>p\`), and each computer's ~/imperfect reflog in ${tilde(dir)}/reflog/<computer>, which gives the commit at any moment. The recall tool searches them.`];
  if (!exchanges.length) out.push('', 'Nothing said yet.');
  for (const { session, at, noah, reply, final } of exchanges) {
    const { computer, harness, id, cwd, reflog, live } = session, commit = commitAt(reflog, at);
    out.push('', `## ${day(at)} ${clock(at)} · ${computer} · ${harness} ${shortId(id)} · ${cwd ? tilde(cwd) : 'no folder'}${commit ? ` · commit ${commit.slice(0, 12)}` : ''}${live && final ? ' · still being written' : ''}`, '');
    out.push(...(noah ? ['Noah:', quoted(cut(redact(noah.text), WORDS_CHARS, whereSaid(session, noah, dir)))] : ['Noah: (earlier, before the part of this log that is read: it continues an imported one)']));
    out.push('', ...(reply ? [`Agent, ${clock(reply.at)}:`, quoted(cut(redact(reply.text), REPLY_CHARS, whereSaid(session, reply, dir)))]
      : [`Agent: (no reply in words${live && final ? ' yet' : ''})`]));
  }
  return `${out.join('\n')}\n`;
}

// --- gathering ---------------------------------------------------------------
const quote = text => `'${String(text).replace(/'/g, `'\\''`)}'`;
// BSD and GNU find share -exec, not -printf or stat's format flags. Node is
// already required for the source-side SQLite backup; use its nanosecond stat
// here too, so same-size WAL commits still invalidate the collection stamp.
const FILE_STATS = `const { statSync } = require('node:fs'); for (const path of process.argv.slice(1)) { const s = statSync(path, { bigint: true }); if (s.isFile()) console.log([String(s.size), Number(s.mtimeNs) / 1e9, path, String(s.ctimeNs), String(s.dev) + ':' + String(s.ino)].join('\\t')); }`;
const LIST = `find "$HOME/.claude/projects" "$HOME/.pi/agent/sessions" "$HOME/.pi/agent/sessions-from-the-other-runtime" "$HOME/.imperfect/data/state/sessions" "$HOME/.imperfect/data/state/sessions-from-the-other-runtime" "$HOME/.imperfect/data/agent/sessions" "$HOME/.imperfect/data/agent/sessions-from-the-other-runtime" "$HOME/.codex/sessions" "$HOME/.codex/archived_sessions" \\( -name '*.jsonl' -o -name '*.sqlite' -o -name '*.sqlite-wal' \\) -not -path '*/subagents/*' -exec node -e ${quote(FILE_STATS)} {} + 2>/dev/null; true`;
const REFLOG = `git -C "$HOME/imperfect" reflog --date=iso-strict --format='%H %gd' 2>/dev/null; true`;

// A command's output, or with into, the output streamed into that file, so a
// log of any size is never held.
const failed = (error, stderr) => new Error(String(stderr || error.message).trim().split('\n').at(-1));
function exec(file, args, options = {}, into = null) {
  if (!into) {
    return new Promise((done, fail) => execFile(file, args, { encoding: 'buffer', maxBuffer: 1 << 30, timeout: 600_000, ...options },
      (error, stdout, stderr) => (error ? fail(failed(error, stderr)) : done(stdout))));
  }
  const child = spawn(file, args, { stdio: ['ignore', 'pipe', 'pipe'], timeout: 600_000, ...options });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr = `${stderr}${chunk}`.slice(-4096); });
  const ended = new Promise((done, fail) => child.on('error', error => fail(failed(error))).on('close', (code, signal) =>
    (code === 0 ? done() : fail(failed(new Error(`${file} ended with ${signal ?? code}`), stderr)))));
  // A failed command can exit before the destination even opens. Let both
  // lifetimes settle before put() removes its partial file, or an outstanding
  // write can recreate that file after cleanup. A failed destination must also
  // stop the producer instead of waiting for its command timeout.
  const copied = pipe(child.stdout, createWriteStream(into, { mode: 0o600 })).catch(error => {
    child.kill();
    throw error;
  });
  return Promise.allSettled([ended, copied]).then(([exit, copy]) => {
    if (copy.status === 'rejected') throw copy.reason;
    if (exit.status === 'rejected') throw exit.reason;
  });
}
export const here = (env = process.env) => (command, into) => exec('sh', ['-c', command], { env }, into);
// SSH is non-login on a Mac: its Dock/keeper Node need not be on sshd's PATH.
// Read only the public runtime path, never any harness or credential config.
export const memorySourceEnvironment = `export PATH="$HOME/.local/bin:$HOME/.local/share/mise/shims:/opt/homebrew/bin:/usr/local/bin:$PATH"
if [ -x /usr/bin/plutil ] && [ -f "$HOME/.imperfect/mac.json" ]; then
  imperfect_node=$(/usr/bin/plutil -extract node raw -o - "$HOME/.imperfect/mac.json" 2>/dev/null) || imperfect_node=
  if [ -n "$imperfect_node" ] && [ -x "$imperfect_node" ]; then export PATH="$(dirname "$imperfect_node"):$PATH"; fi
fi
node -e 'const [a,b] = process.versions.node.split(".").map(Number); process.exit(a > 22 || a === 22 && b >= 19 ? 0 : 1)' >/dev/null 2>&1 || { echo 'History collection requires Node 22.19 or newer on the source computer' >&2; exit 1; }
`;
// A computer that stops answering partway (asleep, off the network) is let go
// after half a minute, not at the command's timeout.
export const overSsh = destination => (command, into) => exec('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15',
  '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=2', '-o', 'ControlMaster=auto', '-o', `ControlPath=/tmp/imperfect-memory-${process.getuid?.() ?? 0}-%C`, '-o', 'ControlPersist=60', destination, `${memorySourceEnvironment}${command}`], {}, into);

// This computer (local: its logs still being written are read where they
// are), and the others named in computers.json (theirs are followed).
export async function computers(dir = memoryDir()) {
  const others = await readFile(join(dir, 'computers.json'), 'utf8').then(JSON.parse, () => ({}));
  return [{ name: hostname().split('.')[0], run: here(), local: true },
    ...Object.entries(others).filter(([, to]) => typeof to === 'string' && to).map(([name, to]) => ({ name, run: overSsh(to) }))];
}

// data, or what write(part) writes there, put in place whole.
async function put(path, data, write = part => writeFile(part, data, { mode: 0o600 })) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const part = `${path}.${process.pid}.part`;
  try {
    await write(part);
  } catch (error) {
    await rm(part, { force: true });
    throw error;
  }
  await rename(part, path);
}
const readDone = async dir => {
  let text;
  try { text = await readFile(join(dir, '.done.json'), 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return {}; throw error; }
  const done = JSON.parse(text);
  if (!done || typeof done !== 'object' || Array.isArray(done)) throw new Error('Invalid memory collection index; refusing to forget archive provenance');
  return done;
};

// Each computer's reflog is kept beside the raw logs, so any moment in raw/
// has its commit, even once a harness or git has let go.
async function keepReflog(dir, name, text) {
  const path = join(dir, 'reflog', name);
  const known = await readFile(path, 'utf8').catch(() => '');
  const all = [...new Set(`${known}\n${text}`.split('\n').filter(Boolean))].join('\n');
  if (all !== known) await put(path, `${all}\n`);
}

// A log still being written goes into live/, by the name it will have in
// raw/ once still, and never into raw/ or .done.json: on this computer a link
// to where it is, which is read in place; from another computer a copy,
// fetched whole the first time and then only what the log grew by, with the
// OVERLAP bytes before that to check it grew and was not written over (if it
// was, it is fetched whole again). Answers where to read it.
const OVERLAP = 4096;
async function follow({ dir, run, raw, file, local }) {
  const path = join(dir, 'live', raw.slice('raw/'.length, -'.gz'.length));
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  if (local) {
    if (await readlink(path).catch(() => null) !== file.path) { await rm(path, { force: true }); await symlink(file.path, path); }
    return { path: file.path };
  }
  const have = (await lstat(path).catch(() => null))?.size ?? 0;
  if (have && have === file.size) return { path, source: file.path };
  if (have > OVERLAP && file.size > have) {
    const part = `${path}.${process.pid}.gz.part`;
    try {
      await run(`tail -c +${have - OVERLAP + 1} -- ${quote(file.path)} | gzip -c`, part);
      const added = gunzipSync(await readFile(part)), before = Buffer.alloc(OVERLAP), handle = await open(path, 'r');
      try { await handle.read(before, 0, OVERLAP, have - OVERLAP); } finally { await handle.close(); }
      if (added.length >= OVERLAP && added.subarray(0, OVERLAP).equals(before)) {
        await appendFile(path, added.subarray(OVERLAP));
        return { path, source: file.path };
      }
    } finally { await rm(part, { force: true }); }
  }
  await put(path, null, async part => {
    const gz = `${path}.${process.pid}.gz.part`;
    try {
      await run(`gzip -c -- ${quote(file.path)}`, gz);
      await pipe(createReadStream(gz), createGunzip(), createWriteStream(part, { mode: 0o600 }));
    } finally { await rm(gz, { force: true }); }
  });
  return { path, source: file.path };
}

// Quiet JSONL logs are gzipped byte-for-byte; active ones are followed.
// SQLite always travels as a standalone online backup, including hot remote
// databases. Never gzip/copy only a live SQLite main file. Answers how many
// logs were taken, the logs still being written (live) and the computers that
// did not answer (missed).
async function copy({ dir, from, now, log }) {
  const donePath = join(dir, '.done.json');
  const done = await readDone(dir), live = [], missed = [];
  const rawOwners = new Map(Object.entries(done).map(([key, entry]) => [entry.raw, key]));
  const convertedImports = new Map(Object.values(done).filter(e => e.provenance).map(e => [e.provenance.path, e.provenance]));
  let taken = 0;
  for (const { name, run, local } of from) {
    let files;
    try {
      files = String(await run(LIST)).split('\n').flatMap(line => {
        const [size, time, path, ctime, inode] = line.split('\t');
        return path ? [{ size: Number(size), mtime: Math.round(Number(time) * 1000), path, stamp: JSON.stringify([size, time, ctime, inode]) }] : [];
      });
      const wal = new Map(files.filter(f => f.path.endsWith('.sqlite-wal')).map(f => [f.path.slice(0, -4), f]));
      files = files.filter(f => !f.path.endsWith('.sqlite-wal')).map(f => f.path.endsWith('.sqlite')
        ? { ...f, stamp: JSON.stringify([f.stamp, wal.get(f.path)?.stamp]), mtime: Math.max(f.mtime, wal.get(f.path)?.mtime || 0) } : f);
      await keepReflog(dir, name, String(await run(REFLOG)));
    } catch (error) {
      log(`${name}: not reachable (${error.message}); it is caught up later`);
      missed.push(name);
      continue;
    }
    const following = new Set();
    for (const file of files) {
      const key = `${name}:${file.path}`;
      const harness = file.path.includes('/.claude/projects/') ? 'claude' : file.path.includes('/.codex/') ? 'codex' : 'pi';
      const durable = file.path.endsWith('.sqlite');
      const distinctPath = durable || harness === 'codex' || file.path.includes('/sessions-from-the-other-runtime/') || file.path.includes('/.imperfect/data/agent/');
      let raw = done[key]?.raw || join('raw', name, harness, `${distinctPath ? `${hash(file.path)}-` : ''}${basename(file.path)}.gz`);
      if (rawOwners.has(raw) && rawOwners.get(raw) !== key) raw = join('raw', name, harness, `${hash(file.path)}-${basename(file.path)}.gz`);
      rawOwners.set(raw, key);
      try {
        if (durable) {
          // Snapshot hot databases too: remote work and WAL-only commits must
          // not wait for the source to become quiet. Always read our snapshot.
          if (local && now - file.mtime < QUIET_MS) live.push({ raw, path: file.path, snapshot: join(dir, raw), mtime: file.mtime });
          const reader = local ? quote(join(REPO, 'apps/code/native/durable-archive.mjs')) : '"$HOME/imperfect/apps/code/native/durable-archive.mjs"';
          const source = file.path.endsWith('.jsonl.durable.sqlite') ? file.path.slice(0, -'.durable.sqlite'.length) : null;
          let provenance = null;
          if (source) {
            if (local) provenance = await readMemoryImport(dir, source);
            else {
              const script = `import { readMemoryImport } from './system/memory-imports.mjs'; import { homedir } from 'node:os'; import { join } from 'node:path'; console.log(JSON.stringify(await readMemoryImport(join(homedir(), '.imperfect/memory'), ${JSON.stringify(source)})));`;
              provenance = JSON.parse(String(await run(`cd "$HOME/imperfect" && node --input-type=module -e ${quote(script)}`)));
            }
          }
          // Conversion can outlive its JSONL/manifest. Never forget a cutoff
          // already validated against this archive's immutable original bytes.
          provenance ||= done[key]?.provenance || null;
          if (done[key]?.stamp === file.stamp && JSON.stringify(done[key]?.provenance || null) === JSON.stringify(provenance)) continue;
          let size;
          await put(join(dir, raw), null, async part => {
            await run(`${local ? quote(process.execPath) : 'node'} ${reader} snapshot ${quote(file.path)}`, part);
            const archive = await loadDurableArchive(part, { compressed: true });
            size = archive.byteLength;
            if (provenance) {
              const source = archive.entries.find(e => e.kind === 'imperfect.legacy')?.data.source;
              if (!source) throw new Error('memory import: Durable archive has no original');
              for await (const _ of importedBytes(Readable.from([Buffer.from(source)]), provenance)) { /* validate before replacing raw */ }
            }
          });
          done[key] = { size, mtime: file.mtime, stamp: file.stamp, raw, ...(provenance ? { provenance } : {}) };
          await put(donePath, `${JSON.stringify(done, null, 1)}\n`);
          taken++;
          continue;
        }
        const provenance = local ? (await readMemoryImport(dir, file.path) || convertedImports.get(file.path)) : null;
        if (provenance) {
          raw = join('raw', name, harness, `import-${hash(file.path)}-${basename(file.path)}.gz`);
          await validateMemoryImport(file.path, provenance);
          if (file.size === provenance.byteCutoff) continue; // never resumed: nothing new to copy
        }
        if (now - file.mtime < QUIET_MS) {
          following.add(join(dir, 'live', raw.slice('raw/'.length, -'.gz'.length)));
          live.push({ raw, mtime: file.mtime, ...await follow({ dir, run, raw, file, local }) });
          continue;
        }
        if (done[key]?.size === file.size && done[key]?.mtime === file.mtime) continue;
        await put(join(dir, raw), null, part => run(`gzip -c -- ${quote(file.path)}`, part));
        done[key] = { size: file.size, mtime: file.mtime, raw, ...(provenance ? { importPath: file.path } : {}) };
        await put(donePath, `${JSON.stringify(done, null, 1)}\n`);
        taken++;
      } catch (error) {
        log(`${key}: ${error.message}; tried again next pass`);
      }
    }
    // What this computer has stopped writing is in raw/ now (or soon).
    for (const harness of Object.keys(READERS)) {
      const folder = join(dir, 'live', name, harness);
      for (const file of await readdir(folder).catch(() => [])) if (!following.has(join(folder, file))) await rm(join(folder, file), { force: true });
    }
  }
  return { taken, live, missed };
}

// A pass: what changed copied from each computer (from) into raw/, the logs
// still being written followed, and recent.md made again from the newest
// exchanges; pulse-pass.json says when it finished, for Pulse.
export async function gather({ prefix = resolvePrefix(), dir = memoryDir(prefix), from, now = Date.now(), log = console.log } = {}) {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
  const started = Date.now();
  const { taken, live, missed } = await copy({ dir, from: from ?? await computers(dir), now, log });
  const { sessions, exchanges, redact } = await load({ prefix, dir, live, log });
  const recent = renderRecent(exchanges, { now, dir, redact });
  await put(join(dir, 'recent.md'), recent);
  await put(join(dir, 'pulse-pass.json'), `${JSON.stringify({ finished: new Date(now + Date.now() - started).toISOString(), exchanges: exchanges.length, missed })}\n`);
  return { taken, live: live.length, missed, sessions: sessions.length, replays: sessions.filter(session => session.replayOf).length, exchanges: exchanges.length, recentBytes: Buffer.byteLength(recent) };
}

// One pass at a time: a socket in Linux's abstract namespace, named for the
// memory folder. The kernel lets it go when the process ends, however it
// ends, so a pass that died never holds up the next. Answers how to let go,
// or null while another pass holds it.
export function lock(dir = memoryDir()) {
  return new Promise(done => {
    const server = createServer();
    server.once('error', () => done(null));
    server.listen({ path: `\0imperfect-memory-${hash(resolve(dir)).slice(0, 16)}` }, () => { server.unref(); done(() => new Promise(closed => server.close(closed))); });
  });
}

// Per computer: its logs and their bytes (and gzipped, in raw/), and the
// calls' recordings it once made and the bytes of those and their logs.
export async function sizes({ dir = memoryDir() } = {}) {
  const done = await readDone(dir);
  const by = {};
  const row = name => (by[name] ??= { logs: 0, rawBytes: 0, gzipBytes: 0, calls: 0, callBytes: 0 });
  for (const [key, entry] of Object.entries(done)) {
    const r = row(key.slice(0, key.indexOf(':')));
    if (basename(dirname(entry.raw)) === 'calls') { if (entry.raw.endsWith('.webm')) r.calls++; r.callBytes += entry.size; continue; }
    r.logs++;
    r.rawBytes += entry.size;
    r.gzipBytes += (await stat(join(dir, entry.raw)).catch(() => null))?.size ?? 0;
  }
  return { computers: by };
}

// --- recall ------------------------------------------------------------------
// What was said, searched in the logs themselves: every log in raw/ and in
// live/ (those still being written, standing in for their older copies in
// raw/), newest first, SEARCH_JOBS at once. grep finds the lines holding
// every word as JSON writes it, but for what a tool answered (TOOL_OUTPUT),
// which nobody said, the last SEARCH_BYTES of them a log; the
// harness's reader reads only those, after the log's first line (a session's
// header), and keeps what Noah and the agents said that holds every word (a
// Durable archive is read whole). Noah's words first, then the agents',
// newest first in each: the search stops once it has as many of Noah's as
// were asked for, each newer than any log not read yet. A hit then brings its
// neighbour, read from its whole log (the reply to his message, or the
// message a reply was for), and the commit ~/imperfect was at; secrets are
// redacted as in recent.md.
const SEARCH_JOBS = 8;
const SEARCH_BYTES = 4 << 20;
const TOOL_OUTPUT = ['"tool_result"', '"role":"toolResult"', '"type":"function_call_output"', '"type":"custom_tool_call_output"'];
const terms = query => [...String(query).toLowerCase().matchAll(/"([^"]+)"|(\S+)/g)].map(m => m[1] ?? m[2]);

function isAncestor(commit, repo) {
  return new Promise(done => execFile('git', ['-C', repo, 'merge-base', '--is-ancestor', commit, 'HEAD'], error => done(!error ? true : error.code === 1 ? false : null)));
}

// The logs to search, newest first by when each was last written.
async function searchable(dir) {
  const done = await readDone(dir).catch(() => ({}));
  const written = new Map(Object.values(done).map(entry => [entry.raw, entry.mtime]));
  const logs = new Map();
  for (const top of ['raw', 'live']) {
    for (const computer of await readdir(join(dir, top)).catch(() => [])) {
      for (const harness of Object.keys(READERS)) {
        for (const name of await readdir(join(dir, top, computer, harness)).catch(() => [])) {
          if (top === 'raw' ? !name.endsWith('.gz') : name.endsWith('.part')) continue;
          const path = join(dir, top, computer, harness, name), raw = join('raw', computer, harness, top === 'raw' ? name : `${name}.gz`);
          const mtime = (top === 'raw' && written.get(raw)) || (await stat(path).catch(() => null))?.mtimeMs;
          if (mtime !== undefined) logs.set(raw, { computer, harness, path, mtime, durable: name.endsWith('.sqlite.gz') });
        }
      }
    }
  }
  return [...logs.values()].sort((a, b) => b.mtime - a.mtime);
}

// A log read whole, or (with words) only its lines that hold them all, with
// the line each event of the reading is at in the log.
async function readLog({ path, harness, durable }, words = null) {
  if (durable) {
    const archive = await loadDurableArchive(path);
    return { session: await readPi(durableArchiveRows(archive, { activeBranch: true }).map(JSON.stringify).join('\n'), undefined, { archive: true }), at: line => line };
  }
  if (!words) {
    const bytes = createReadStream(path);
    return { session: await READERS[harness](path.endsWith('.gz') ? pipeline(bytes, createGunzip(), () => {}) : bytes), at: line => line };
  }
  const cat = path.endsWith('.gz') ? `gzip -dc -- ${quote(path)}` : `cat -- ${quote(path)}`;
  const greps = [`grep -n -v -F ${TOOL_OUTPUT.map(text => `-e ${quote(text)}`).join(' ')}`, ...words.map(word => `grep -i -F -e ${quote(JSON.stringify(word).slice(1, -1))}`)].join(' | ');
  const found = String(await here()(`{ ${cat} | head -n 1 | head -c ${SEARCH_BYTES}; echo; ${cat} | ${greps} | tail -c ${SEARCH_BYTES}; } 2>/dev/null; true`));
  const [header, ...matched] = found.split('\n'), lines = [1], text = [header];
  for (const line of matched) {
    const n = /^(\d+):/.exec(line)?.[1];
    if (n > 1) { lines.push(Number(n)); text.push(line.slice(n.length + 1)); }
  }
  return /^\d+:/m.test(matched.join('\n')) ? { session: await READERS[harness](text.join('\n')), at: line => lines[line - 1] } : null;
}

// The reply to Noah's message, or the message a reply was for.
function neighbour({ events, entries }, hit) {
  if (hit.who === 'noah') {
    const i = entries.findIndex(entry => entry.who === 'noah' && entry.at === hit.at && entry.text === hit.text);
    return i >= 0 && entries[i + 1]?.who === 'agent' ? entries[i + 1] : null;
  }
  const i = events.findIndex(event => event.who === 'agent' && event.at === hit.at && event.text === hit.text);
  return i >= 0 ? events.slice(0, i).findLast(event => event.who === 'noah') ?? null : null;
}

export async function search(query, { limit = 10, dir = memoryDir(), repo = REPO, credentials = join(dirname(dir), 'credentials') } = {}) {
  const words = terms(query);
  if (!words.length) return [];
  const most = Math.max(1, Math.min(50, Number(limit) || 10));
  const holds = text => { const lower = text.toLowerCase(); return words.every(word => lower.includes(word)); };
  const logs = await searchable(dir), found = { noah: new Map(), agent: new Map() }, finished = new Set();
  const newest = hits => [...hits.values()].sort((a, b) => b.at - a.at);
  let next = 0, unread = 0;
  const take = (log, read) => {
    if (!read || throwaway(read.session.cwd)) return;
    const { session, at } = read;
    for (const event of session.events) {
      if (!found[event.who] || !holds(event.text)) continue;
      const key = `${event.at}\n${event.text}`;
      if (!found[event.who].has(key)) found[event.who].set(key, { who: event.who, at: event.at, text: event.text, log, line: at(event.line), id: session.id || basename(log.path).replace(/\.jsonl(\.gz)?$/, ''), cwd: session.cwd });
    }
    for (const who of Object.keys(found)) if (found[who].size > most) found[who] = new Map(newest(found[who]).slice(0, most).map(hit => [`${hit.at}\n${hit.text}`, hit]));
  };
  // The newest log not read yet is unread: no log after it holds anything newer.
  const enough = () => unread >= logs.length || (found.noah.size >= most && [...found.noah.values()].every(hit => hit.at > logs[unread].mtime + SLACK));
  await Promise.all(Array.from({ length: SEARCH_JOBS }, async () => {
    while (next < logs.length && !enough()) {
      const i = next++;
      take(logs[i], await readLog(logs[i], words).catch(() => null));
      finished.add(i);
      while (finished.has(unread)) unread++;
    }
  }));
  const hits = [...newest(found.noah), ...newest(found.agent)].slice(0, most);
  const redact = redactor(await credentialValues(credentials), await learned(dir));
  const minute = ms => { const time = localTime(ms); return `${time.slice(0, 16)}${time.slice(19)}`; };
  const wholes = new Map(), reflogs = new Map(), known = new Map();
  return Promise.all(hits.map(async hit => {
    const { log, at, who, text, line } = hit;
    if (!wholes.has(log.path)) wholes.set(log.path, readLog(log).catch(() => null));
    if (!reflogs.has(log.computer)) reflogs.set(log.computer, readFile(join(dir, 'reflog', log.computer), 'utf8').then(parseReflog, () => []));
    const whole = (await wholes.get(log.path))?.session, other = whole && neighbour(whole, hit), commit = commitAt(await reflogs.get(log.computer), at);
    const id = whole?.id || hit.id, cwd = whole?.cwd || hit.cwd;
    if (commit && !known.has(commit)) known.set(commit, isAncestor(commit, repo));
    return { who, time: minute(at), text: redact(text), computer: log.computer, harness: log.harness, session: shortId(id), cwd: cwd ? tilde(cwd) : '', path: tilde(log.path), line,
      commit, ancestor: commit ? await known.get(commit) : null, neighbour: other ? { who: other.who, time: minute(other.at), text: redact(other.text) } : null };
  }));
}

export const RECALL_TOOL = {
  name: 'recall',
  description: "Search what Noah and the agents said in past sessions, on every computer, in the session logs themselves: Noah's own words first, then the agents', newest first. Use it when asked about a past decision or \"what did we do about X\", and before redoing something that may have been settled. Give a few distinctive words; every word must appear (quote a phrase to keep it together). Each hit is the words said, with the reply or the message beside it, its session and folder, the log and line it is at, and the commit ~/imperfect was at then, so `git show <commit>:<path>` in ~/imperfect shows the system as it was. On the PC, ~/.imperfect/memory/recent.md holds Noah's last 20 exchanges word for word, and raw/<computer>/<harness>/ every log (gzipped JSONL, one per session), for any other view to be made from.",
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'words that must all appear in what was said' },
      limit: { type: 'number', description: 'how many hits, at most (default 10, up to 20)' },
    },
    required: ['query'],
  },
};

// Where memory is, told by the machine server (createMemoryRoute): null here,
// else the PC's URL ('' while it cannot be reached).
let where = async () => null;

const cap = (text, most = 1200) => (text.length > most ? `${text.slice(0, most)} […]` : text);
function describe(query, hits) {
  if (!hits.length) return `Nothing said in past sessions holding "${query}". Try fewer or other words.`;
  const out = [`${hits.length} thing${hits.length === 1 ? '' : 's'} said holding "${query}" (Noah first, newest first). \`git show <commit>:<path>\` in ~/imperfect shows the system as it was then.`];
  hits.forEach((hit, i) => {
    const commit = hit.commit ? `commit ${hit.commit.slice(0, 12)}${hit.ancestor === true ? ' (in HEAD)' : hit.ancestor === false ? ' (not in HEAD)' : ''}` : 'no commit (before ~/imperfect)';
    const pair = [hit, hit.neighbour].filter(Boolean).sort((a, b) => Date.parse(a.time) - Date.parse(b.time) || (a.who === 'noah' ? -1 : 1));
    out.push('', `${i + 1}. ${hit.who}, ${hit.time.slice(0, 16).replace('T', ' ')} on ${hit.computer} (${[hit.harness, hit.session].filter(Boolean).join(' ')}${hit.cwd ? `, in ${hit.cwd}` : ''}), ${commit}`,
      `   ${hit.path}${hit.line ? `, line ${hit.line}` : ''}`,
      ...pair.map(entry => `   ${entry.who} ${entry.time.slice(11, 16)}: ${cap(entry.text).replace(/\n/g, '\n   ')}`));
  });
  return out.join('\n');
}

export async function runRecall({ query, limit, signal } = {}, { locate = () => where(), fetch: send = fetch, find = search } = {}) {
  const words = String(query ?? '').trim();
  if (!words) throw new Error('recall needs words to look for');
  const most = Math.max(1, Math.min(20, Number(limit) || 10));
  const url = await locate();
  if (url === null) return describe(words, await find(words, { limit: most }));
  if (!url) throw new Error('Memory is kept on the PC, and this computer cannot reach it right now. Try again once the PC is on.');
  let response;
  try {
    response = await send(`${url}/memory`, { method: 'POST', headers: { origin: url, 'content-type': 'application/json' }, body: JSON.stringify({ query: words, limit: most }), signal, redirect: 'error' });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new Error(`The PC, which keeps memory, could not be reached (${error.message})`);
  }
  const answer = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`The PC, which keeps memory, answered: ${answer.error || response.status}`);
  return describe(words, answer.hits ?? []);
}

// The PC's side: POST /memory { query, limit } -> { hits }, for recall on the
// person's other computers. Guarded like /images/make: the exact origin is
// required, which a page elsewhere cannot claim and /peer/ drops.
// authority(): the PC's URL when this computer is not it, else null.
export function createMemoryRoute({ authority = async () => null, dir } = {}) {
  where = authority;
  return async function handle(req, res, path) {
    if (path !== '/memory' || req.method !== 'POST') return false;
    const json = (status, value) => { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value)); };
    if (!req.headers.origin) { json(403, { error: 'exact origin required' }); return true; }
    try {
      let raw = '';
      req.setEncoding('utf8');
      for await (const chunk of req) {
        raw += chunk;
        if (raw.length > 16_384) throw Object.assign(new Error('too long'), { status: 413 });
      }
      const { query, limit } = JSON.parse(raw || '{}');
      json(200, { hits: await search(String(query ?? ''), { limit, ...(dir ? { dir } : {}) }) });
    } catch (error) {
      json(error.status || 400, { error: error.message });
    }
    return true;
  };
}

// Memory lives where the others' things land: on the authority in
// machine.json, or here when this computer follows none (start.mjs).
// 0 here, 1 elsewhere, 2 cannot tell (no tailnet answer).
export async function memoryHome(prefix = resolvePrefix(), status = tailnetStatus) {
  const { authority } = await readConfig(prefix);
  if (!authority.id) return 0;
  const self = readTailnet(await status()).self?.id;
  return !self ? 2 : self === authority.id ? 0 : 1;
}

// A pass as the timer starts it, every two minutes: every computer reached,
// what changed copied, and recent.md made again. In the first pass after each
// even hour (.upgraded) Pi and Claude Code are then brought up to date
// (system/upgrade.mjs), into this service's journal, and while that runs a
// pass is still made every two minutes beside it, so recent.md stays fresh.
const FRESH_MS = 2 * 60_000;
const slot = ms => { const [date, hour] = localTime(ms).split('T'); return `${date} ${Math.floor(parseInt(hour, 10) / 2)}`; };
const kb = n => `${(n / 1024).toFixed(0)} KB`;

async function pass({ dir = memoryDir() } = {}) {
  if (!await lock(dir)) return console.log('memory: another pass is running');
  const once = async () => {
    const result = await gather({ dir });
    if (result.taken) console.log(`memory: took ${plural(result.taken, 'log')}, followed ${result.live} still being written, made recent.md (${plural(result.exchanges, 'exchange')}, ${kb(result.recentBytes)})`);
  };
  await once();
  const upgraded = Date.parse(await readFile(join(dir, '.upgraded'), 'utf8').catch(() => '')), now = Date.now();
  if (Number.isFinite(upgraded) && slot(upgraded) === slot(now)) return;
  await put(join(dir, '.upgraded'), localTime(now));
  let beside = Promise.resolve();
  const fresh = setInterval(() => { beside = beside.then(once).catch(error => console.error(`memory: pass beside the upgrade: ${error.message}`)); }, FRESH_MS);
  try {
    await new Promise(done => spawn(process.execPath, [join(REPO, 'system', 'upgrade.mjs')], { stdio: 'inherit' }).on('close', done).on('error', error => { console.error(`memory: upgrade: ${error.message}`); done(); }));
  } finally {
    clearInterval(fresh);
    await beside;
  }
}

if (process.argv[1] === import.meta.filename) {
  const [command, ...rest] = process.argv.slice(2);
  const table = ({ computers: by }) => Object.entries(by).map(([name, r]) =>
    `${name}: ${r.logs} logs, ${kb(r.rawBytes)} (raw/ ${kb(r.gzipBytes)} gzipped); ${r.calls} calls recorded, ${kb(r.callBytes)}`).join('\n');
  if (command === 'search') console.log(describe(rest.join(' '), await search(rest.join(' '), { limit: 20 })));
  else if (command === 'sizes') console.log(table(await sizes()));
  else if (command === 'home') process.exitCode = await memoryHome();
  else if (!command) await pass();
  else {
    console.error('usage: node system/memory.mjs [search <words> | sizes | home]');
    process.exitCode = 2;
  }
}
