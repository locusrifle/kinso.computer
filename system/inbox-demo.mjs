// The staged inbox: what Messages shows on a computer that is not the
// person's own (a hosted computer someone unlocks to try imperfect), so
// Messages can be seen beside the agents without anyone's real messages.
//
// The conversations are invented, in one file that is easy to change:
// system/inbox-demo.json. Each message says how long ago it was ("45m",
// "3h", "2d 4h"), counted from whenever it is asked, so the inbox always
// looks like this morning's. It answers as the PC's inbox does
// (system/inbox.mjs), so the window and the agents' tools work on it the
// same: search, read, and drafts kept in this process. Nothing reaches
// Unipile; Send sends nothing and says so; nothing connects.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { InboxError, keyOf, parseKey } from './inbox.mjs';

export const DEMO_FILE = join(import.meta.dirname, 'inbox-demo.json');
const LABELS = { gmail: 'Gmail', linkedin: 'LinkedIn', instagram: 'Instagram', whatsapp: 'WhatsApp' };
const KINDS = { gmail: 'mail', linkedin: 'chat', instagram: 'chat', whatsapp: 'chat' };
export const DEMO_SAID = 'This is a demo inbox: nothing was sent.';

// "2d 4h", "45m", "3h": minutes ago.
export function minutesAgo(text) {
  let total = 0;
  for (const [, n, unit] of String(text ?? '').matchAll(/(\d+(?:\.\d+)?)\s*([dhm])/g)) total += Number(n) * { d: 1440, h: 60, m: 1 }[unit];
  return total;
}

// The file, checked: every conversation on a known account, every message
// with words and a time. A mistake in it is said at once, with where.
export function readDemo(file = DEMO_FILE) {
  const raw = JSON.parse(readFileSync(file, 'utf8'));
  const me = String(raw.me?.name ?? 'You');
  const accounts = (raw.accounts ?? []).map(account => {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(account.id ?? '') || !LABELS[account.source]) throw new Error(`inbox-demo.json: account ${JSON.stringify(account.id)} needs an id and a source (${Object.keys(LABELS).join(', ')})`);
    return { id: account.id, source: account.source, label: LABELS[account.source], kind: KINDS[account.source], name: String(account.name ?? LABELS[account.source]), handle: String(account.handle ?? ''), status: 'ok' };
  });
  const conversations = (raw.conversations ?? []).map((c, at) => {
    const account = accounts.find(a => a.id === c.account);
    if (!account || !/^[A-Za-z0-9_-]{1,64}$/.test(c.id ?? '')) throw new Error(`inbox-demo.json: conversation ${at + 1} (${c.id}) needs an id and one of the accounts`);
    if (!Array.isArray(c.messages) || !c.messages.length || c.messages.some(m => !String(m.text ?? '').trim() || !minutesAgo(m.ago))) throw new Error(`inbox-demo.json: ${c.id} needs messages, each with text and ago ("3h")`);
    return {
      key: keyOf(account.kind, account.id, c.id), kind: account.kind, account: account.id, source: account.source,
      name: String(c.name), address: String(c.address ?? ''), subject: String(c.subject ?? ''), unread: Number(c.unread) || 0,
      messages: c.messages.map((m, i) => ({ id: `${c.id}-${i + 1}`, ago: minutesAgo(m.ago), me: m.me === true, from: m.me ? 'You' : String(m.from ?? c.name), text: String(m.text).trim(), files: (m.files ?? []).map(String) })),
    };
  });
  return { me, accounts, conversations };
}

export function createDemoInbox({ file = DEMO_FILE, now = () => Date.now(), tell = () => {} } = {}) {
  let data = null;
  const loaded = () => (data ??= readDemo(file));
  const drafts = new Map();
  const seen = new Set(); // opened in a window: no longer unread, until this computer restarts
  const accountOf = id => loaded().accounts.find(a => a.id === id);
  const find = key => {
    parseKey(key);
    const c = loaded().conversations.find(item => item.key === key);
    if (!c) throw new InboxError('That conversation is not in this inbox. Search or list again for its key.', 404);
    return c;
  };
  const at = minutes => now() - minutes * 60_000;
  const lastOf = c => c.messages.reduce((a, b) => (b.ago < a.ago ? b : a));
  const row = c => {
    const last = lastOf(c);
    return {
      key: c.key, kind: c.kind, account: c.account, source: c.source, name: c.name, subject: c.subject,
      preview: `${last.me ? 'You: ' : ''}${last.text.replace(/\s+/g, ' ').slice(0, 160)}`, at: at(last.ago),
      unread: seen.has(c.key) ? 0 : c.unread, group: false, readOnly: false, avatar: false, draft: drafts.has(c.key),
    };
  };
  const listing = () => {
    const { accounts, conversations } = loaded();
    return { state: 'ready', demo: true, accounts, conversations: conversations.map(row).sort((a, b) => b.at - a.at), refreshedAt: now(), problems: [], notYet: [] };
  };
  const person = (name, address) => ({ name, address });
  return {
    home: true, demo: true,
    async list() { return listing(); },
    async thread(key, { seen: opened = false } = {}) {
      const c = find(key);
      if (opened) seen.add(key);
      const account = accountOf(c.account);
      const me = person(loaded().me, account.handle);
      const them = person(c.name, c.address);
      const messages = [...c.messages].sort((a, b) => b.ago - a.ago).map(m => ({
        id: m.id, at: at(m.ago), me: m.me, from: m.from, text: m.text, quoted: '', deleted: false, event: false,
        attachments: m.files.map(name => ({ name, type: 'file', size: 0, href: '' })),
        ...(c.kind === 'mail' ? { address: m.me ? me.address : c.address, to: [m.me ? them : me], cc: [], subject: c.subject } : {}),
      }));
      const lastTheirs = [...messages].reverse().find(m => !m.me);
      return {
        key, kind: c.kind, account, source: c.source, demo: true, title: c.kind === 'chat' ? c.name : c.subject.replace(/^re:\s*/i, '') || '(no subject)',
        people: [c.name], readOnly: false, avatar: false, messages, cursor: '',
        ...(c.kind === 'mail' ? { reply: { to: [them], subject: /^re\s?:/i.test(c.subject) ? c.subject : `Re: ${c.subject}`, inReplyTo: lastTheirs?.id ?? messages.at(-1).id } } : {}),
        draft: drafts.get(key) ?? null,
      };
    },
    async search(query, { limit = 20, source = '', account = '' } = {}) {
      const words = String(query ?? '').toLowerCase().split(/\s+/).filter(Boolean);
      const most = Math.max(1, Math.min(50, Number(limit) || 20));
      const listed = listing();
      const found = [];
      for (const c of loaded().conversations) {
        if ((source && c.source !== source) || (account && c.account !== account)) continue;
        const said = c.messages.find(m => words.every(word => `${c.name} ${c.subject} ${m.text}`.toLowerCase().includes(word)));
        if (words.length && !said) continue;
        found.push({ ...row(c), ...(words.length ? { match: said.text.replace(/\s+/g, ' ').slice(0, 160) } : {}) });
      }
      return { ...listed, conversations: found.sort((a, b) => b.at - a.at).slice(0, most) };
    },
    async attachment() { return new Response(JSON.stringify({ error: 'This is a demo inbox: its attachments are only names.' }), { status: 404, headers: { 'content-type': 'application/json' } }); },
    async avatar() { throw new InboxError('no picture', 404); },
    async connect() { throw new InboxError('This is a demo inbox, so no accounts are connected here.', 400); },
    // Nothing leaves this computer, and the answer says so.
    async send({ key, text } = {}) {
      find(key);
      if (!String(text ?? '').trim()) throw new InboxError('There is nothing to send.', 400);
      drafts.delete(key);
      return { sent: false, demo: true, said: DEMO_SAID };
    },
    async draft({ key, text, by = '' } = {}) {
      const c = find(key);
      const words = String(text ?? '').replace(/\r\n/g, '\n').trim();
      if (!words) throw new InboxError('A draft needs its words.', 400);
      if (words.length > 20_000) throw new InboxError('That draft is too long.', 413);
      const entry = { text: words, by: String(by ?? '').replace(/\s+/g, ' ').trim().slice(0, 40), at: now() };
      drafts.set(key, entry);
      tell({ type: 'inbox-draft', key, ...entry });
      return { key, title: c.kind === 'chat' ? c.name : `${c.name} · ${c.subject}`, demo: true, ...entry };
    },
    async discard({ key } = {}) { parseKey(key); drafts.delete(key); return { key, discarded: true }; },
  };
}
