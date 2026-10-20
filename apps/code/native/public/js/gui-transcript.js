// Original DOM renderer informed by T3 Code's MessagesTimeline (MIT); no HTML injection.
// A local address (http://localhost:5173/) or a file the agent made is a
// link, and what the agent shows plays in a window, or is a link to the
// browser tab it opened (pages.js).
import { appendWithPages, localLink, pageLink, windowOf, inBrowser, shownName } from './pages.js';
import { harnessName } from './agent-faces.js';
import { copyText } from './workbench-copy.js';
import { animateInView } from './visible-animation.js';
const node = (tag, text, cls) => { const n = document.createElement(tag); if (text != null) n.textContent = text; if (cls) n.className = cls; return n; };
function inline(parent, text) {
 const pattern = /(`[^`]+`|\*\*[^*]+\*\*|\[[^\]]+\]\([^\s)]+\))/g;
 let end = 0;
 for (const m of text.matchAll(pattern)) {
  appendWithPages(parent, text.slice(end, m.index));
  const token = m[0];
  if (token[0] === '`') { const code = node('code', token.slice(1,-1)); parent.append(localLink(token.slice(1,-1), code) ?? code); }
  else if (token.startsWith('**')) { const strong = node('strong'); appendWithPages(strong, token.slice(2,-2)); parent.append(strong); }
  else {
   const [, label, href] = token.match(/^\[([^\]]+)\]\((.+)\)$/);
   const local = localLink(href, label);
   if (local) { parent.append(local); end = m.index + token.length; continue; }
   const a = node('a', label);
   if (/^(https?:\/\/|mailto:)/i.test(href)) { a.href = href; a.rel = 'noopener noreferrer'; a.target = '_blank'; }
   parent.append(a);
  }
  end = m.index + token.length;
 }
 appendWithPages(parent, text.slice(end));
}
// Table-only opportunities keep words intact and copied text unchanged.
// Leave inline code literal; a genuinely unbreakable value can scroll.
function tableCell(tag, text) {
 const cell = node(tag); inline(cell, text);
 const walker = document.createTreeWalker(cell, NodeFilter.SHOW_TEXT);
 const texts = []; while (walker.nextNode()) if (!walker.currentNode.parentElement.closest('code')) texts.push(walker.currentNode);
 for (const text of texts) {
  const fragment = document.createDocumentFragment(); let end = 0;
  for (const token of text.data.matchAll(/\S{13,}/g)) {
   for (const point of token[0].matchAll(/[./\-_@:?&=]/g)) {
    const offset = token.index + point.index + 1;
    fragment.append(document.createTextNode(text.data.slice(end, offset)), node('wbr')); end = offset;
   }
  }
  if (end) { fragment.append(document.createTextNode(text.data.slice(end))); text.replaceWith(fragment); }
 }
 return cell;
}
// A block of code wraps inside the window, and copies whole in one tap.
function codeBlock(text) {
 const box = node('div', null, 'gui-code'), copy = node('button', 'copy', 'gui-copy'), pre = node('pre');
 copy.type = 'button';
 copy.addEventListener('click', async () => {
  try { await copyText(text); copy.textContent = 'copied'; }
  catch { copy.textContent = 'not copied'; }
  setTimeout(() => { copy.textContent = 'copy'; }, 1500);
 });
 pre.append(node('code', text));
 box.append(copy, pre);
 return box;
}
export function markdown(parent, value) {
 const lines = String(value ?? '').split('\n');
 for (let i = 0; i < lines.length;) {
  const line = lines[i++];
  if (/^\s*```/.test(line)) {
   const body = []; while (i < lines.length && !/^\s*```/.test(lines[i])) body.push(lines[i++]); i++;
   parent.append(codeBlock(body.join('\n'))); continue;
  }
  if (!line.trim()) continue;
  if (i < lines.length && /^\s*\|?\s*:?-{3}/.test(lines[i]) && line.includes('|')) {
   const table = node('table'); const cells = s => s.trim().replace(/^\||\|$/g,'').split('|');
   const head = node('tr'); for (const c of cells(line)) { head.append(tableCell('th',c.trim())); } table.append(head); i++;
   while (i < lines.length && lines[i].includes('|')) { const row = node('tr'); for (const c of cells(lines[i++])) { row.append(tableCell('td',c.trim())); } table.append(row); }
   const wrap = node('div', null, 'gui-table'); wrap.append(table); parent.append(wrap); continue;
  }
  const heading = line.match(/^(#{1,6})\s+(.*)/);
  const list = line.match(/^\s*(?:[-*+] |\d+\. )(.*)/);
  if (list) {
   const ordered = /^\s*\d/.test(line); const ul = node(ordered ? 'ol' : 'ul'); let item = list;
   // A list that goes on from an earlier one keeps its numbers: 17. starts at 17.
   if (ordered && parseInt(line, 10) !== 1) ul.start = parseInt(line, 10);
   do { const li = node('li'); inline(li,item[1]); ul.append(li); item = lines[i]?.match(ordered ? /^\s*\d+\. (.*)/ : /^\s*[-*+] (.*)/); if (item) i++; } while (item);
   parent.append(ul); continue;
  }
  const p = node(heading ? `h${heading[1].length}` : 'p'); inline(p, heading ? heading[2] : line); parent.append(p);
 }
}
// A new conversation opens on how its harness is put together, as Pi's
// terminal opens on its startup block: the harness, model and folder, then one
// line for each part (instruction files, skills, prompts, extensions or MCP
// servers, tools), each opening to its whole list. An empty conversation is
// redrawn with every update, so which lines are open is kept here.
const opened = new Set();
function overview(state) {
 const { version, cwd, sections = [] } = state.startup;
 const box = node('section', null, 'gui-overview');
 const head = node('div', null, 'gui-overview-head');
 const level = state.level && state.level !== 'off' ? `${state.level} effort` : '';
 head.append(node('span', version, 'gui-overview-harness'));
 for (const part of [state.model?.name, level]) if (part) head.append(node('span', part));
 box.append(head);
 if (cwd) box.append(node('div', cwd, 'gui-overview-cwd'));
 for (const s of sections) {
  const row = node('details', null, 'gui-overview-part');
  row.open = opened.has(s.name);
  row.addEventListener('toggle', () => { if (row.open) opened.add(s.name); else opened.delete(s.name); });
  const summary = node('summary');
  summary.append(node('span', `[${s.name}]`, 'gui-overview-label'), node('span', s.compact, 'gui-overview-list'));
  const list = node('ul');
  for (const item of String(s.expanded || s.compact).split('\n')) list.append(node('li', item));
  row.append(summary, list);
  box.append(row);
 }
 return box;
}
const textOf = content => typeof content === 'string' ? content : (content ?? []).filter(b => b.type === 'text').map(b => b.text ?? '').join('\n');
// How a turn is timed and a compaction marked, as T3 Code does both (its
// MessagesTimeline and orchestrationTiming, MIT): a quiet line under each
// answer, "Worked for 2m 13s", with the time it finished; a rule across the
// conversation where the context was compacted, with how many tokens it held
// before and after.
export function formatDuration(ms) {
 if (!Number.isFinite(ms) || ms < 0) return '0s';
 if (ms < 1000) return `${Math.max(1, Math.round(ms))}ms`;
 if (ms < 10_000) { const tenths = Math.round(ms / 100) / 10; return tenths >= 10 ? '10s' : `${tenths.toFixed(1)}s`; }
 if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
 const total = Math.round(ms / 1000), h = Math.floor(total / 3600), m = Math.floor(total % 3600 / 60), sec = total % 60;
 return [h && `${h}h`, m && `${m}m`, sec && `${sec}s`].filter(Boolean).join(' ');
}
// While it works, whole seconds count up.
export const formatWorking = ms => ms < 60_000 ? `${Math.max(0, Math.floor(ms / 1000))}s` : formatDuration(Math.floor(ms / 1000) * 1000);
const tokens = n => n >= 1e6 ? `${(n / 1e6).toFixed(1).replace(/\.0$/, '')}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n);
// The time a turn finished; a day before today says which.
export function finishedAt(ms, now = Date.now()) {
 const date = new Date(ms), time = date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
 const day = d => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
 const days = Math.round((day(new Date(now)) - day(date)) / 86_400_000);
 if (days <= 0) return time;
 if (days === 1) return `yesterday at ${time}`;
 return `${date.toLocaleDateString([], { day: 'numeric', month: 'short', ...(date.getFullYear() !== new Date(now).getFullYear() ? { year: 'numeric' } : {}) })} ${time}`;
}
// When a message was done: an answer Pi timed ends its duration after it began.
const endOf = m => Number(m?.timestamp) + (Number.isFinite(m?.durationMs) ? m.durationMs : 0);
// A turn: from the person's message at `start` to the last thing said before
// `end` (the next message of theirs, or the end). Untimed, or with no answer
// in it, it is not a turn to time.
export function turnTime(messages, start, end = messages.length) {
 const asked = messages[start];
 if (asked?.role !== 'user' || !Number.isFinite(Number(asked.timestamp))) return null;
 // What the agent said and its tools answered; a compaction after it is not the turn's.
 const said = messages.slice(start + 1, end).filter(m => m?.role === 'assistant' || m?.role === 'toolResult');
 if (!said.some(m => m.role === 'assistant')) return null;
 const last = Math.max(...said.map(endOf).filter(Number.isFinite));
 return Number.isFinite(last) && last >= asked.timestamp ? { startedAt: Number(asked.timestamp), endedAt: last } : null;
}
export function turnTimeNode({ startedAt, endedAt }) {
 const line = node('p', `Worked for ${formatDuration(endedAt - startedAt)} · ${finishedAt(endedAt)}`, 'gui-turn-time');
 line.title = new Date(endedAt).toLocaleString();
 return line;
}
// A background task's end, as Claude Code tells its agent (a message of
// <task-notification> blocks): not something the person said, so it is one
// quiet line, what the task was and how it ended, never the raw tags.
const NOTICE = /<task-notification>([\s\S]*?)<\/task-notification>/g;
export function taskNotices(text) {
 const source = String(text ?? '');
 if (!source.includes('<task-notification>') || source.replace(NOTICE, '').trim()) return null;
 return [...source.matchAll(NOTICE)].map(([, body]) => {
  const field = name => body.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`))?.[1]?.trim() ?? '';
  const summary = field('summary'), status = field('status').toLowerCase();
  return {
   status: status === 'completed' ? 'done' : status === 'failed' ? 'failed' : status === 'killed' || status === 'stopped' ? 'stopped' : status || 'done',
   name: summary.match(/"([^"]+)"/)?.[1] ?? summary.replace(/^Background (?:command|task|agent)\s*/i, ''),
   exit: summary.match(/exit code (\d+)/i)?.[1] ?? null,
   summary,
  };
 });
}
export function taskNoticeNode(notice) {
 const said = { done: 'Background task finished', failed: 'Background task failed', stopped: 'Background task stopped' }[notice.status] ?? 'Background task';
 const line = node('p', null, 'gui-task-note');
 line.dataset.status = notice.status;
 line.append(node('span', null, 'gui-task-dot'), node('span', said, 'gui-task-said'));
 if (notice.name) line.append(node('span', notice.name, 'gui-task-name'));
 if (notice.status === 'failed' && notice.exit) line.append(node('span', `exit ${notice.exit}`, 'gui-task-exit'));
 line.title = notice.summary;
 return line;
}
const MINIMIZE = '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 14h6v6M20 10h-6V4M14 10l7-7M3 21l7-7"/></svg>';
export function compactionNode(m, active = false) {
 const label = active ? 'Compacting context'
  : Number.isFinite(m?.tokensBefore) && Number.isFinite(m?.tokensAfter) ? `Context compacted ${tokens(m.tokensBefore)} → ${tokens(m.tokensAfter)} tokens`
  : Number.isFinite(m?.tokensBefore) ? `Context compacted from ${tokens(m.tokensBefore)} tokens`
  : 'Context compacted';
 const row = node('div', null, `gui-compaction${active ? ' active' : ''}`);
 row.setAttribute('role', 'separator');
 row.setAttribute('aria-label', label);
 const text = node('span', null, 'gui-compaction-label');
 text.innerHTML = MINIMIZE;
 text.append(label);
 row.append(text);
 return active ? animateInView(row) : row;
}
// The conversation is what was said: the person's messages and the agent's
// words and pictures. How it got there (reasoning, tool calls, their output)
// is not drawn; the working mark in the status line says it is at work. A
// picture a tool handed back (a screenshot the agent read) is drawn, alone:
// what the agent looked at, the person sees. What the agent showed plays in a
// window (windowNode, from the harness, which keeps it playing through
// redraws); what it opened in the browser is a link that opens it again.
// `from` is where state.messages begins in the whole conversation, so keys
// and indices stay the same whether a part or the whole is drawn.
export function renderGuiTranscript(into, state, { imageNode, windowNode, from = 0 } = {}) {
 const messages = [...(state.messages ?? []), ...(state.partial ? [state.partial] : [])];
 if (!messages.length) into.append(state.startup ? overview(state) : node('p', 'Start a conversation.', 'gui-notice'));
 messages.forEach((m, i) => {
  const index = i + from;
  if (m.role === 'compactionSummary') { into.append(compactionNode(m)); return; }
  if (m.role === 'toolResult') {
   const shown = windowOf(textOf(m.content));
   if (shown && inBrowser(shown.target)) {
    const opened = node('article', 'Opened ', 'gui-message gui-assistant gui-opened');
    opened.append(localLink(shown.target, shownName(shown.target)) ?? pageLink(shown.target, shownName(shown.target)));
    into.append(opened);
    return;
   }
   if (shown) {
    const win = windowNode?.(shown, `${state.sessionId}:${index}`);
    if (win) into.append(win);
    return;
   }
   const pictures = (Array.isArray(m.content) ? m.content : []).filter(b => b.type === 'image').map(b => imageNode?.(b, m.toolName ? `what ${m.toolName} showed` : 'image')).filter(Boolean);
   if (pictures.length) {
    const shown = node('article', null, 'gui-message gui-assistant gui-picture'); shown.append(...pictures);
    into.append(shown);
   }
   return;
  }
  const notices = m.role === 'user' ? taskNotices(textOf(m.content)) : null;
  if (notices) { into.append(...notices.map(taskNoticeNode)); return; }
  const article = node('article', null, `gui-message gui-${m.role === 'user' ? 'user' : 'assistant'}`);
  if (m.role === 'user') { article.dataset.userIndex = String(index); article.tabIndex = -1; article.append(node('div', textOf(m.content), 'gui-prompt')); }
  else if (typeof m.content === 'string') markdown(article, m.content);
  else for (const b of m.content ?? []) if (b.type === 'text') markdown(article, b.text);
  for (const b of Array.isArray(m.content) ? m.content : []) if (b.type === 'image') { const image = imageNode?.(b,'image'); if (image) article.append(image); }
  if (m.errorMessage) article.append(node('p',m.errorMessage,'gui-error'));
  if (article.childNodes.length) into.append(article);
 });
}
export function pastInputs(state) {
 return (state.messages ?? []).flatMap((m,index) => m.role === 'user' && !taskNotices(textOf(m.content)) ? [{index,text:textOf(m.content)}] : []);
}
