// Messages: the person's conversations -- Gmail, WhatsApp, LinkedIn,
// Instagram and the rest -- in imperfect, beside the agents, through
// Unipile (developer.unipile.com): one REST API for all of them.
//
// The key is the person's own Unipile account: its DSN (the address of
// their API) and an access token, in ~/.imperfect/credentials/unipile.json
// on the PC only: {"dsn": "api8.unipile.com:13851", "apiKey": "..."}. It is
// read at each call and goes nowhere but Unipile's X-API-KEY header: never
// into an answer, an error, a log or the cache.
//
// The PC answers. It is the authority in machine.json (or this computer,
// when it follows none): it holds the key, asks Unipile, and keeps what
// Unipile said in <state>/inbox/ (the conversations, names, previews, which
// ones the person has opened, and agents' drafts). Every other computer of
// the person's own asks the PC, the way recall asks it for memory: the
// request travels, the key and the messages' store never do. The PC answers
// only its own screen and the person's own devices on the tailnet.
//
// A computer that is not the person's own (hosted: someone unlocks it on the
// web) shows the demo inbox (system/inbox-demo.mjs) and never asks the PC,
// unless the PC lends it the real one (system/inbox-lend.mjs): which inbox a
// computer shows is its "inbox" setting (inboxSource, below).
//
// Nothing here sends on its own. /inbox/send is the person pressing Send in
// the Messages view (a page's exact origin, which /peer/ drops); the agents'
// tools only search, read and draft a reply into that view's composer.
//
//   GET  /inbox/list[?refresh=1]       the accounts and the conversations, newest first
//   GET  /inbox/thread?key=&cursor=    one conversation: its messages, or an email thread
//   GET  /inbox/search?q=              conversations holding the words
//   GET  /inbox/attachment?key=&message=&id=   an attachment's bytes
//   GET  /inbox/avatar?key=            the other person's picture, where there is one
//   POST /inbox/connect {provider} or {reconnect}   Unipile's sign-in page for an account
//   POST /inbox/send {key, text, nonce}             the person's reply, sent
//   POST /inbox/draft {key, text, by}               an agent's draft, into the composer
//   POST /inbox/discard {key}                       a draft put away
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { createDemoInbox } from './inbox-demo.mjs';
import { Readable } from 'node:stream';

export function credentialsFile(env = process.env) {
  return join(env.IMPERFECT_PREFIX || join(homedir(), '.imperfect'), 'credentials', 'unipile.json');
}

// What each kind of Unipile account is, as the person knows it. Kinds not
// here (a calendar, a phone line) are not conversations.
export const SOURCES = {
  GOOGLE_OAUTH: { source: 'gmail', label: 'Gmail', kind: 'mail' },
  MAIL: { source: 'mail', label: 'Email', kind: 'mail' },
  ICLOUD: { source: 'icloud', label: 'iCloud Mail', kind: 'mail' },
  OUTLOOK: { source: 'outlook', label: 'Outlook', kind: 'mail' },
  EXCHANGE: { source: 'exchange', label: 'Exchange', kind: 'mail' },
  WHATSAPP: { source: 'whatsapp', label: 'WhatsApp', kind: 'chat' },
  LINKEDIN: { source: 'linkedin', label: 'LinkedIn', kind: 'chat' },
  INSTAGRAM: { source: 'instagram', label: 'Instagram', kind: 'chat' },
  TELEGRAM: { source: 'telegram', label: 'Telegram', kind: 'chat' },
  MESSENGER: { source: 'messenger', label: 'Messenger', kind: 'chat' },
  SLACK: { source: 'slack', label: 'Slack', kind: 'chat' },
  TWITTER: { source: 'x', label: 'X', kind: 'chat' },
};
// What a sign-in link may offer, by source (Unipile's hosted auth names).
export const CONNECTS = { gmail: 'GOOGLE', whatsapp: 'WHATSAPP', linkedin: 'LINKEDIN', instagram: 'INSTAGRAM', outlook: 'OUTLOOK', telegram: 'TELEGRAM', mail: 'MAIL' };
// Unipile lists X/Twitter as no longer maintained, so it is not offered.
export const NOT_YET = [{ source: 'x', label: 'X', note: 'Not yet: Unipile no longer maintains X (Twitter), so imperfect does not offer it.' }];

export const NO_KEY = file => `Messages has no Unipile key yet. Sign up at dashboard.unipile.com (the 7-day trial is enough), copy your DSN from the dashboard, generate an access token, and save both on the PC as ${file} (mode 600): {"dsn": "apiN.unipile.com:PORT", "apiKey": "..."}. Then connect each account from Messages.`;

export class InboxError extends Error {
  constructor(message, status = 400, extra = {}) { super(message); this.status = status; Object.assign(this, extra); }
}

/* ------------------------------------------------------------- the key */

// The API's address from the DSN as the dashboard gives it ("api8.unipile.com:13851"),
// with or without https://. Plain http only to this computer (the tests'
// fake Unipile): the key is never sent in the clear.
export function unipileOrigin(dsn) {
  const raw = String(dsn ?? '').trim().replace(/\/+$/, '').replace(/\/api\/v1$/, '');
  let url;
  try { url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`); } catch { url = null; }
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url?.hostname);
  if (!raw || !url || url.username || url.password || url.search || url.hash || url.pathname !== '/' || !(url.protocol === 'https:' || (url.protocol === 'http:' && loopback))) {
    throw new InboxError('The dsn in unipile.json is not an address like apiN.unipile.com:PORT (as Unipile\'s dashboard shows it).', 500);
  }
  return url.origin;
}

export async function readKey(file) {
  let raw;
  try { raw = await readFile(file, 'utf8'); } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new InboxError(`${file} could not be read (${error.code}).`, 500);
  }
  let parsed;
  try { parsed = JSON.parse(raw); } catch { throw new InboxError(`${file} is not JSON. ${NO_KEY(file)}`, 500); }
  const apiKey = typeof parsed?.apiKey === 'string' ? parsed.apiKey.trim() : '';
  if (!apiKey || typeof parsed?.dsn !== 'string') throw new InboxError(`${file} needs both "dsn" and "apiKey". ${NO_KEY(file)}`, 500);
  return { origin: unipileOrigin(parsed.dsn), apiKey };
}

/* ------------------------------------------------------------ Unipile */

// Unipile's errors are { title, detail, type, status }, said as a sentence.
export function unipileFailure(status, text, doing) {
  let body = {};
  try { body = JSON.parse(text); } catch { /* not JSON */ }
  const said = [body.title, body.detail].filter(Boolean).join(': ') || `HTTP ${status}`;
  const type = String(body.type ?? '');
  let message = `Unipile answered ${status} while ${doing}: ${said}`;
  if (status === 401 && /missing_credentials|invalid_credentials|unauthorized/i.test(`${type} ${said}`) && doing === 'listing the accounts') {
    message = `Unipile did not accept the key (401). Check the apiKey and dsn in ~/.imperfect/credentials/unipile.json against the Unipile dashboard.`;
  } else if (/disconnected_account|expired_credentials|disconnected_feature/.test(type)) {
    message = `That account is disconnected from Unipile (${said}). Reconnect it from Messages.`;
  } else if (status === 429) {
    message = `Unipile says to slow down (429) while ${doing}${body.retry_after ? `; try again in ${body.retry_after}s` : ''}.`;
  }
  return new InboxError(message, status >= 500 ? 502 : status, { type });
}

// key: { origin, apiKey }. send: fetch, or the tests'.
export function unipile(key, { send = fetch, timeout = 30_000 } = {}) {
  async function call(method, path, { query, json, form, doing = 'asking', headers = {}, raw = false, signal } = {}) {
    const url = new URL(`${key.origin}/api/v1${path}`);
    for (const [name, value] of Object.entries(query ?? {})) if (value != null && value !== '') url.searchParams.set(name, String(value));
    const init = { method, headers: { 'X-API-KEY': key.apiKey, accept: 'application/json', ...headers }, redirect: 'error',
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeout)]) : AbortSignal.timeout(timeout) };
    if (json) { init.headers['content-type'] = 'application/json'; init.body = JSON.stringify(json); }
    if (form) {
      const body = new FormData();
      for (const [name, value] of Object.entries(form)) if (value != null) body.append(name, typeof value === 'string' ? value : JSON.stringify(value));
      init.body = body;
    }
    let res;
    try { res = await send(url, init); } catch (error) {
      if (signal?.aborted) throw error;
      // Transport errors may include request details; never echo them with a key.
      throw new InboxError(`Unipile could not be reached while ${doing}${error.name === 'TimeoutError' ? ' (timed out)' : ''}`, 502);
    }
    if (raw && res.ok) return res;
    const text = await res.text();
    if (!res.ok) {
      const error = unipileFailure(res.status, text, doing);
      // Scrub after parsing too: a JSON-escaped credential must not come back
      // decoded in a provider error. Non-JSON response bodies are never echoed.
      error.message = error.message.split(key.apiKey).join('[redacted]');
      error.type = error.type.split(key.apiKey).join('[redacted]');
      throw error;
    }
    try { return text ? JSON.parse(text) : {}; } catch { throw new InboxError(`Unipile answered something that is not JSON while ${doing}`, 502); }
  }
  // Every page of a list, following the cursor, up to most items.
  async function all(path, query = {}, most = 500, doing) {
    const items = [];
    let cursor = null;
    do {
      const page = await call('GET', path, { query: { ...query, limit: Math.min(250, most - items.length), ...(cursor ? { cursor } : {}) }, doing });
      items.push(...(page.items ?? []));
      cursor = page.cursor || null;
    } while (cursor && items.length < most);
    return items;
  }
  return { call, all, get: (path, query, doing, signal) => call('GET', path, { query, doing, signal }) };
}

/* ------------------------------------------------- what the API's things are */

const ms = value => { const at = Date.parse(value ?? ''); return Number.isFinite(at) ? at : 0; };
const one = value => String(value ?? '').replace(/\s+/g, ' ').trim();
const clip = (text, most) => (text.length > most ? `${text.slice(0, most - 1).trimEnd()}…` : text);
const STATUS_ORDER = ['CREDENTIALS', 'PERMISSIONS', 'ERROR', 'STOPPED', 'CONNECTING', 'OK'];

export function accountOf(raw) {
  const kind = SOURCES[raw?.type];
  if (!kind || typeof raw.id !== 'string') return null;
  const params = raw.connection_params ?? {};
  const handle = one(params.mail?.username || params.im?.username || params.im?.phone_number || params.im?.publicIdentifier || '');
  const statuses = (raw.sources ?? []).map(source => String(source?.status ?? ''));
  const status = STATUS_ORDER.find(name => statuses.includes(name)) ?? 'OK';
  return { id: raw.id, source: kind.source, label: kind.label, kind: kind.kind, name: one(raw.name) || handle || kind.label, handle, status: status.toLowerCase() };
}

// A conversation's key: what it is, whose, and its id there. A chat's id is
// Unipile's; an email thread's is its thread id, and an email without one
// stands alone by its own id.
export function keyOf(kind, account, id) { return `${kind}:${account}:${id}`; }
export function parseKey(key) {
  const match = /^(chat|mail|email):([A-Za-z0-9_-]{1,128}):(.{1,512})$/s.exec(String(key ?? ''));
  if (!match || /[\0\n]/.test(match[3])) throw new InboxError('That is not a conversation in Messages (its key is wrong). Search or list again for its key.', 400);
  return { kind: match[1], account: match[2], id: match[3] };
}

// Named characters as emails write them, and the invisible ones that pad a
// newsletter's preview line: said, or left out.
const ENTITIES = { nbsp: ' ', lt: '<', gt: '>', quot: '"', apos: "'", amp: '&', shy: '', zwnj: '', zwj: '', lrm: '', rlm: '', ensp: ' ', emsp: ' ', thinsp: ' ',
  mdash: '—', ndash: '–', hellip: '…', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', bull: '•', middot: '·', copy: '©', reg: '®', trade: '™', euro: '€', pound: '£', times: '×', laquo: '«', raquo: '»', deg: '°' };
const INVISIBLE = /[\u00ad\u034f\u061c\u115f\u1160\u17b4\u17b5\u180b-\u180e\u200b-\u200f\u202a-\u202e\u2060-\u2064\u206a-\u206f\u3164\ufeff\uffa0]/g;
export function plainText(text) {
  return String(text ?? '').replace(/&(#\d{1,7}|#x[0-9a-f]{1,6}|[a-z]{2,8});/gi, (all, name) => {
    if (name[0] !== '#') return ENTITIES[name.toLowerCase()] ?? all;
    const code = name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : Number(name.slice(1));
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
  }).replace(INVISIBLE, '');
}
// Plain text from an email's HTML: the window shows it as text, never as a page.
export function htmlText(html) {
  const decoded = plainText(String(html ?? '')
    .replace(/<(head|style|script|title)\b[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6]|blockquote|table|section)\s*>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '• ')
    .replace(/<[^>]*>/g, ''));
  return decoded.split('\n').map(line => line.replace(/[ \t\u00a0]+/g, ' ').trimEnd()).join('\n').replace(/\n{3,}/g, '\n\n').trim();
}
// An email's words: its plain part, else its HTML said as text.
const emailText = raw => plainText(String(raw?.body_plain ?? '')).trim() || htmlText(raw?.body);
// What a reply quotes ("On … wrote:" and below, or the > lines at its end), apart.
export function splitQuoted(text) {
  const lines = String(text ?? '').split('\n');
  let at = lines.findIndex(line => /^\s*(On .{4,200} wrote:|-{2,} ?Original Message ?-{2,}|Le .{4,200} a écrit ?:|From: .+)$/i.test(line));
  if (at < 0) {
    at = lines.length;
    while (at > 0 && (/^\s*>/.test(lines[at - 1]) || (!lines[at - 1].trim() && at < lines.length))) at--;
    if (at === lines.length || !lines.slice(at).some(line => /^\s*>/.test(line))) at = -1;
  }
  if (at <= 0) return { text: String(text ?? '').trim(), quoted: '' };
  return { text: lines.slice(0, at).join('\n').trim(), quoted: lines.slice(at).join('\n').trim() };
}

const person = attendee => ({ name: one(attendee?.display_name), address: one(attendee?.identifier) });
const personName = who => who.name || who.address || 'Someone';
// Who an email is with, for the list: its sender, or, when the account
// itself sent it, whoever it went to.
function withWhom(raw, account) {
  const from = person(raw.from_attendee);
  if (!account.handle || from.address.toLowerCase() !== account.handle.toLowerCase()) return personName(from);
  const to = (raw.to_attendees ?? []).map(person).filter(who => who.address.toLowerCase() !== account.handle.toLowerCase());
  return to.length ? to.map(personName).join(', ') : 'You';
}

// What an attachment is called, and where its bytes are (through the PC).
function attachmentOf(item, key, message) {
  const type = String(item?.type ?? '');
  const names = { img: 'Picture', video: item?.gif ? 'GIF' : 'Video', audio: item?.voice_note ? 'Voice message' : 'Audio', linkedin_post: 'LinkedIn post', video_meeting: 'Video meeting', poll: 'Poll' };
  let name = one(item?.file_name || item?.name) || names[type] || 'Attachment';
  if (type === 'profile') name = `Profile: ${one(item.profile?.full_name || item.profile?.username) || 'someone'}`;
  if (type === 'contact_card') name = `Contact: ${one(item.display_name) || 'someone'}`;
  if (type === 'poll') name = `Poll: ${one(item.poll?.question)}`;
  const external = [item?.post?.url, item?.link?.url, item?.story?.url].find(url => /^https:\/\//i.test(String(url ?? '')));
  if (type === 'media_share') name = one(item.link?.title || item.post?.description) || 'Shared post';
  const bytes = Boolean(item?.id) && !item.unavailable && ['img', 'video', 'audio', 'file'].includes(type) && Boolean(key);
  return {
    name: clip(name, 120), type: type || 'file', size: Number(item?.file_size ?? item?.size) || 0,
    href: external ? String(external) : bytes ? `/inbox/attachment?${new URLSearchParams({ key, message, id: item.id })}` : '',
  };
}

function chatMessage(raw, key, names) {
  if (raw?.hidden === 1 || raw?.hidden === true) return null;
  const me = raw.is_sender === 1 || raw.is_sender === true;
  const deleted = raw.deleted === 1 || raw.deleted === true;
  const text = deleted ? '' : String(raw.text ?? '');
  const from = me ? 'You' : names.get(raw.sender_attendee_id) || names.get(raw.sender_id) || one(raw.sender_id) || 'Someone';
  return {
    id: String(raw.id), at: ms(raw.timestamp), me, from, text, deleted,
    event: raw.is_event === 1 || raw.is_event === true,
    quoted: raw.quoted?.text ? clip(one(raw.quoted.text), 200) : '',
    attachments: deleted ? [] : (raw.attachments ?? []).map(item => attachmentOf(item, key, String(raw.id))),
  };
}

function emailMessage(raw, key, account) {
  const from = person(raw.from_attendee);
  const me = Boolean(account.handle) && from.address.toLowerCase() === account.handle.toLowerCase();
  const { text, quoted } = splitQuoted(emailText(raw));
  return {
    id: String(raw.id), at: ms(raw.date), me, from: me ? 'You' : personName(from), address: from.address,
    to: (raw.to_attendees ?? []).map(person), cc: (raw.cc_attendees ?? []).map(person),
    subject: one(raw.subject), text, quoted,
    attachments: (raw.attachments ?? []).filter(item => !item?.inline).map(item => attachmentOf({ ...item, type: 'file', file_name: item.name }, key, String(raw.id))),
  };
}

// The words a conversation is listed with.
const preview = (text, attachments = []) => clip(one(text) || (attachments.length ? attachments.map(item => item.name).join(', ') : ''), 160);

/* ----------------------------------------------------------- the store */

// <state>/inbox/store.json: what the list is drawn from, kept between
// asks so the list is there at once and only changes are asked for.
const EMPTY = () => ({ version: 1, accounts: [], conversations: [], names: {}, people: {}, chatNames: {}, previews: {}, folders: {}, recent: [], seen: {}, drafts: {}, refreshedAt: 0, problems: [] });

async function loadStore(dir) {
  try {
    const stored = JSON.parse(await readFile(join(dir, 'store.json'), 'utf8'));
    return stored?.version === 1 ? { ...EMPTY(), ...stored } : EMPTY();
  } catch { return EMPTY(); }
}

/* ------------------------------------------------- the PC's own messages */

// The inbox on the computer that holds the key. keyFile: where the key is;
// dir: where what Unipile says is kept; tell(message): every open window
// here; now: the clock (the tests').
export function createLocalInbox({ keyFile = credentialsFile(), dir, send = fetch, now = () => Date.now(), tell = () => {}, maxAge = 60_000 } = {}) {
  let store = null, saving = Promise.resolve(), refreshing = null, lastForced = 0;
  const sent = new Map(); // nonce -> answer, so a second press of Send is the first
  const loaded = async () => (store ??= await loadStore(dir));
  const save = () => (saving = saving.then(async () => {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const next = join(dir, `.store.${process.pid}.tmp`);
    await writeFile(next, JSON.stringify(store), { mode: 0o600 });
    await rename(next, join(dir, 'store.json'));
  }).catch(error => console.error(`inbox: could not keep the store: ${error.message}`)));
  async function api() {
    const key = await readKey(keyFile);
    if (!key) throw new InboxError(NO_KEY(keyFile), 409, { missing: 'key' });
    return unipile(key, { send });
  }

  // Each chat's name: its own, or the other person's (a one-to-one chat has none).
  async function chatNames(u, chats, accounts) {
    const wanted = accounts.filter(account => account.kind === 'chat');
    const stale = now() - (store.namesAt ?? 0) > 10 * 60_000;
    if (stale) {
      await Promise.allSettled(wanted.map(async account => {
        const people = await u.all('/chat_attendees', { account_id: account.id }, 1000, `reading ${account.label}'s people`);
        const names = store.names[account.id] = {};
        const ids = store.people[account.id] = {};
        for (const p of people) {
          if (!p || p.is_self === 1 || p.is_self === true) continue;
          if (p.name) { names[p.provider_id] = one(p.name); names[p.id] = one(p.name); }
          if (p.id && p.provider_id) ids[p.provider_id] = p.id;
        }
      }));
      store.namesAt = now();
    }
    const unnamed = chats.filter(chat => !one(chat.name) && !store.chatNames[chat.id] && !store.names[chat.account_id]?.[chat.attendee_provider_id]).slice(0, 30);
    await pool(unnamed, 4, async chat => {
      const people = (await u.get(`/chats/${encodeURIComponent(chat.id)}/attendees`, {}, 'reading who is in a chat')).items ?? [];
      const others = people.filter(p => !(p.is_self === 1 || p.is_self === true)).map(p => one(p.name)).filter(Boolean);
      if (others.length) store.chatNames[chat.id] = others.join(', ');
    });
  }
  // Each email account's inbox, then its newest emails, a thread each. Gmail's
  // is its Primary inbox, as Gmail shows it (not Updates, Promotions or
  // Social); a thread whose newest letter is the person's own reply says so.
  async function mailbox(u, account) {
    let folder = store.folders[account.id];
    if (!folder || folder.v !== 2 || now() - folder.at > 6 * 3600_000) {
      const items = (await u.get('/folders', { account_id: account.id }, `reading ${account.label}'s folders`)).items ?? [];
      const inbox = items.find(item => item.role === 'inbox')?.provider_id ?? '';
      const primary = account.source === 'gmail' ? items.find(item => item.provider_id === 'CATEGORY_PERSONAL')?.provider_id ?? '' : '';
      folder = store.folders[account.id] = { v: 2, id: primary || inbox, primary: Boolean(primary), sent: items.find(item => item.role === 'sent')?.provider_id ?? '', at: now() };
    }
    const [got, sent] = await Promise.all([
      u.get('/emails', { account_id: account.id, limit: 50, ...(folder.id ? { folder: folder.id } : {}) }, `reading ${account.name}`),
      folder.sent ? u.get('/emails', { account_id: account.id, limit: 25, folder: folder.sent }, `reading ${account.name}'s sent mail`).catch(() => ({ items: [] })) : { items: [] },
    ]);
    const threads = new Map();
    for (const raw of got.items ?? []) {
      if (!raw?.id || ['spam', 'trash', 'drafts'].includes(raw.role)) continue;
      // Primary is a label: what has been archived out of the inbox is done.
      if (folder.primary && !(raw.folders ?? []).includes('INBOX')) continue;
      const kind = raw.thread_id ? 'mail' : 'email';
      const key = keyOf(kind, account.id, raw.thread_id || raw.id);
      const at = ms(raw.date);
      if (threads.has(key) && threads.get(key).at >= at) continue;
      threads.set(key, {
        key, kind, account: account.id, source: account.source, name: withWhom(raw, account), subject: one(raw.subject),
        preview: preview(splitQuoted(emailText(raw)).text), at,
        unread: (raw.folders ?? []).some(name => /^unread$/i.test(String(name))) ? 1 : 0,
        attachments: Boolean(raw.has_attachments),
      });
    }
    for (const raw of sent.items ?? []) {
      const listed = raw?.thread_id && threads.get(keyOf('mail', account.id, raw.thread_id));
      if (!listed || ms(raw.date) <= listed.at) continue;
      Object.assign(listed, { at: ms(raw.date), preview: `You: ${preview(splitQuoted(emailText(raw)).text)}`, unread: 0 });
    }
    return [...threads.values()];
  }

  async function refresh() {
    store = await loaded();
    const u = await api();
    const accounts = (await u.all('/accounts', {}, 500, 'listing the accounts')).map(accountOf).filter(Boolean);
    store.accounts = accounts;
    const problems = [];
    const known = new Map(accounts.map(account => [account.id, account]));
    const chatting = accounts.some(account => account.kind === 'chat');
    const [chats, recent, ...mail] = await Promise.allSettled([
      chatting ? u.all('/chats', {}, 150, 'listing the chats') : [],
      chatting ? u.all('/messages', {}, 250, 'reading the newest messages') : [],
      ...accounts.filter(account => account.kind === 'mail').map(account => mailbox(u, account).catch(error => { problems.push(`${account.name}: ${error.message}`); return []; })),
    ]);
    if (chats.status === 'rejected') problems.push(chats.reason.message);
    const chatList = (chats.value ?? []).filter(chat => known.has(chat.account_id) && !chat.archived);
    const newest = new Map();
    // A chat's newest words: not an event (a reaction, someone joining) nor a message with nothing in it.
    const said = message => message && !message.hidden && !(message.is_event === 1 || message.is_event === true) && (one(message.text) || (message.attachments ?? []).length);
    for (const message of recent.value ?? []) if (message?.chat_id && said(message) && !newest.has(message.chat_id)) newest.set(message.chat_id, message);
    if (chatList.length) await chatNames(u, chatList, accounts).catch(error => problems.push(error.message));
    // Previews the newest messages did not reach: asked once per change.
    // The newest first, so the top of the list is whole; the rest on the next asks.
    const missing = chatList.filter(chat => !newest.has(chat.id) && store.previews[chat.id]?.at !== ms(chat.timestamp)).slice(0, 60);
    await pool(missing, 6, async chat => {
      const last = ((await u.get(`/chats/${encodeURIComponent(chat.id)}/messages`, { limit: 4 }, 'reading a chat')).items ?? []).find(said);
      store.previews[chat.id] = { at: ms(chat.timestamp), text: last ? preview(last.text, (last.attachments ?? []).map(item => attachmentOf(item, '', ''))) : '', me: last?.is_sender === 1 };
    }).catch(() => {});
    for (const [id, message] of newest) store.previews[id] = { at: ms(message.timestamp), text: preview(message.text, (message.attachments ?? []).map(item => attachmentOf(item, '', ''))), me: message.is_sender === 1 || message.is_sender === true };
    const conversations = chatList.map(chat => {
      const account = known.get(chat.account_id);
      const said = store.previews[chat.id];
      return {
        key: keyOf('chat', account.id, chat.id), kind: 'chat', account: account.id, source: account.source,
        name: one(chat.name) || store.chatNames[chat.id] || store.names[account.id]?.[chat.attendee_provider_id] || one(chat.subject) || account.label,
        subject: one(chat.subject), preview: said?.text ? `${said.me ? 'You: ' : ''}${said.text}` : '', at: Math.max(ms(chat.timestamp), said?.at ?? 0),
        unread: Number(chat.unread_count) || 0, group: chat.type === 1 || chat.type === 2, readOnly: Boolean(chat.read_only),
        // The other person's picture, by Unipile's id for them (/inbox/avatar).
        avatar: chat.type === 1 || chat.type === 2 ? '' : String(chat.attendee_id || store.people[account.id]?.[chat.attendee_provider_id] || ''),
      };
    });
    for (const result of mail) conversations.push(...(result.value ?? []));
    conversations.sort((a, b) => b.at - a.at);
    // What was said lately, for search: names, and the newest messages' words.
    store.recent = (recent.value ?? []).filter(message => message?.chat_id && known.has(message.account_id) && message.text).slice(0, 250)
      .map(message => ({ key: keyOf('chat', message.account_id, message.chat_id), at: ms(message.timestamp), text: clip(String(message.text), 600) }));
    // A failed account keeps what it last showed rather than vanishing.
    const failed = new Set();
    if (chats.status === 'rejected') for (const account of accounts) if (account.kind === 'chat') failed.add(account.id);
    for (const [i, account] of accounts.filter(a => a.kind === 'mail').entries()) if (!mail[i]?.value?.length && problems.some(p => p.startsWith(`${account.name}:`))) failed.add(account.id);
    const kept = (store.conversations ?? []).filter(item => failed.has(item.account) && !conversations.some(c => c.key === item.key));
    store.conversations = [...conversations, ...kept].sort((a, b) => b.at - a.at);
    store.problems = problems;
    store.refreshedAt = now();
    await save();
  }

  const view = conversation => {
    const seen = store.seen[conversation.key] ?? 0;
    return { ...conversation, avatar: Boolean(conversation.avatar), unread: conversation.unread && conversation.at > seen ? conversation.unread : 0, draft: Boolean(store.drafts[conversation.key]) };
  };
  // What Unipile says is asked again after maxAge. A list already kept is
  // answered at once and asked for behind it, the windows told when it
  // changes ('inbox-changed'); the first, or Refresh pressed, waits for it.
  async function list({ refresh: force = false } = {}) {
    store = await loaded();
    const key = await readKey(keyFile).catch(error => error);
    if (!key) return { state: 'no-key', message: NO_KEY(keyFile), accounts: [], conversations: [], notYet: NOT_YET };
    if (key instanceof Error) return { state: 'error', message: key.message, accounts: [], conversations: [], notYet: NOT_YET };
    const old = now() - store.refreshedAt > maxAge;
    // Refresh asked for (the button) is honoured, but not more than every few seconds.
    const forced = force && now() - lastForced > 5000;
    if (old || forced) {
      if (forced) lastForced = now();
      const before = store.refreshedAt;
      refreshing ??= refresh().then(() => { if (before) tell({ type: 'inbox-changed' }); }).finally(() => { refreshing = null; });
      const wait = refreshing.catch(error => {
        if (!store.refreshedAt) throw error;
        store.problems = [error.message];
      });
      if (!before || forced) {
        try { await wait; } catch (error) { return { state: 'error', message: error.message, accounts: store.accounts, conversations: [], notYet: NOT_YET }; }
      }
    }
    return {
      state: store.accounts.length ? 'ready' : 'no-accounts', accounts: store.accounts, conversations: store.conversations.map(view),
      refreshedAt: store.refreshedAt, problems: store.problems, notYet: NOT_YET,
    };
  }

  async function accountFor(id) {
    store = await loaded();
    let account = store.accounts.find(item => item.id === id);
    if (!account) { await list({}); account = store.accounts.find(item => item.id === id); }
    if (!account) throw new InboxError('That account is not connected to Unipile any more.', 404);
    return account;
  }
  async function thread(key, { cursor = '', seen = false, limit = 40 } = {}) {
    const { kind, account: id, id: thing } = parseKey(key);
    const account = await accountFor(id);
    const u = await api();
    const listed = store.conversations.find(item => item.key === key);
    let answer;
    if (kind === 'chat') {
      const [page, people, chat] = await Promise.all([
        u.get(`/chats/${encodeURIComponent(thing)}/messages`, { limit, ...(cursor ? { cursor } : {}) }, 'reading the chat'),
        u.get(`/chats/${encodeURIComponent(thing)}/attendees`, {}, 'reading who is in the chat').catch(() => ({ items: [] })),
        listed ? null : u.get(`/chats/${encodeURIComponent(thing)}`, {}, 'reading the chat').catch(() => null),
      ]);
      const names = new Map();
      for (const p of people.items ?? []) if (p?.name) { names.set(p.id, one(p.name)); names.set(p.provider_id, one(p.name)); }
      const others = (people.items ?? []).filter(p => !(p.is_self === 1 || p.is_self === true)).map(p => one(p.name)).filter(Boolean);
      answer = {
        key, kind, account, source: account.source,
        title: listed?.name || one(chat?.name) || others.join(', ') || account.label,
        people: others, readOnly: Boolean(listed?.readOnly ?? chat?.read_only), avatar: Boolean(listed?.avatar),
        messages: (page.items ?? []).map(raw => chatMessage(raw, key, names)).filter(Boolean).reverse(),
        cursor: page.cursor || '',
      };
    } else {
      const items = await emailThread(u, kind, account, thing);
      const messages = items.map(raw => emailMessage(raw, key, account)).sort((a, b) => a.at - b.at);
      const mine = address => Boolean(account.handle) && address.toLowerCase() === account.handle.toLowerCase();
      answer = {
        key, kind, account, source: account.source, title: messages.find(m => m.subject)?.subject || listed?.subject || '(no subject)',
        people: [...new Set(messages.flatMap(m => [m.me ? null : { name: m.from, address: m.address }, ...m.to]).filter(who => who && !mine(who.address)).map(personName))],
        messages, cursor: '', reply: messages.length ? replyOf(items, account) : null,
      };
    }
    if (seen) { store.seen[key] = Math.max(listed?.at ?? 0, ...answer.messages.map(m => m.at)); void save(); }
    return { ...answer, draft: store.drafts[key] ?? null };
  }

  async function search(query, { limit = 20, source = '', account = '' } = {}) {
    const words = String(query ?? '').toLowerCase().split(/\s+/).filter(Boolean);
    const most = Math.max(1, Math.min(50, Number(limit) || 20));
    const listed = await list({});
    if (listed.state !== 'ready') return { ...listed, conversations: [] };
    const wanted = conversation => (!source || conversation.source === source) && (!account || conversation.account === account);
    if (!words.length) return { ...listed, conversations: listed.conversations.filter(wanted).slice(0, most) };
    const holds = text => { const lower = String(text ?? '').toLowerCase(); return words.every(word => lower.includes(word)); };
    const found = new Map();
    const accounts = new Map(listed.accounts.map(a => [a.id, a]));
    for (const c of listed.conversations) {
      if (!wanted(c)) continue;
      const a = accounts.get(c.account);
      if (holds(`${c.name} ${c.subject} ${c.preview} ${a?.name ?? ''} ${a?.label ?? ''}`)) found.set(c.key, { ...c, match: c.preview });
    }
    for (const said of store.recent) {
      const c = listed.conversations.find(item => item.key === said.key);
      if (c && wanted(c) && !found.has(c.key) && holds(said.text)) found.set(c.key, { ...c, match: clip(one(said.text), 160) });
    }
    // Email is searched where it is: Unipile looks in every subject and body.
    const u = await api();
    const problems = [];
    await Promise.all(listed.accounts.filter(a => a.kind === 'mail' && (!source || a.source === source) && (!account || a.id === account)).map(async a => {
      try {
        const items = (await u.get('/emails', { account_id: a.id, search: words.join(' '), limit: 15 }, `searching ${a.name}`)).items ?? [];
        for (const raw of items) {
          const key = keyOf(raw.thread_id ? 'mail' : 'email', a.id, raw.thread_id || raw.id);
          if (found.has(key) || ['spam', 'trash', 'drafts'].includes(raw.role)) continue;
          const body = preview(splitQuoted(emailText(raw)).text);
          // A thread already listed is shown as listed, with the words found.
          const listedOne = listed.conversations.find(c => c.key === key);
          found.set(key, listedOne ? { ...listedOne, match: body } : view({ key, kind: raw.thread_id ? 'mail' : 'email', account: a.id, source: a.source,
            name: withWhom(raw, a), subject: one(raw.subject), preview: body, at: ms(raw.date), unread: 0, match: body }));
        }
      } catch (error) { problems.push(`${a.name}: ${error.message}`); }
    }));
    return { ...listed, conversations: [...found.values()].sort((a, b) => b.at - a.at).slice(0, most), problems: [...listed.problems ?? [], ...problems] };
  }

  async function attachment(key, message, id) {
    const { kind } = parseKey(key);
    if (![message, id].every(part => /^[^\0-\x1f]{1,512}$/.test(String(part ?? '')))) throw new InboxError('not an attachment', 400);
    const u = await api();
    const path = kind === 'chat' ? `/messages/${encodeURIComponent(message)}/attachments/${encodeURIComponent(id)}` : `/emails/${encodeURIComponent(message)}/attachments/${encodeURIComponent(id)}`;
    return u.call('GET', path, { raw: true, doing: 'fetching an attachment', headers: { accept: '*/*' } });
  }

  // The other person's picture in a one-to-one chat, from Unipile, kept here
  // a week (a missing one a day): { type, bytes }, or 404.
  const PICTURE = /^image\/(jpeg|png|webp|gif)$/;
  async function avatar(key) {
    const { kind } = parseKey(key);
    store = await loaded();
    const id = kind === 'chat' ? store.conversations.find(item => item.key === key)?.avatar : '';
    if (!id || typeof id !== 'string') throw new InboxError('no picture', 404);
    const file = join(dir, 'avatars', createHash('sha256').update(id).digest('hex').slice(0, 32));
    const kept = await readFile(`${file}.json`, 'utf8').then(JSON.parse).catch(() => null);
    if (kept && now() - kept.at < (kept.type ? 7 : 1) * 86400_000) {
      if (!kept.type) throw new InboxError('no picture', 404);
      const bytes = await readFile(file).catch(() => null);
      if (bytes) return { type: kept.type, bytes };
    }
    const u = await api();
    let type = '', bytes = null;
    try {
      const res = await u.call('GET', `/chat_attendees/${encodeURIComponent(id)}/picture`, { raw: true, doing: 'fetching a picture', headers: { accept: 'image/*' } });
      type = String(res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
      bytes = Buffer.from(await res.arrayBuffer());
      if (!PICTURE.test(type) || !bytes.length || bytes.length > 2_000_000) { type = ''; bytes = null; }
    } catch (error) { if (error.status !== 404) throw error; }
    await mkdir(join(dir, 'avatars'), { recursive: true, mode: 0o700 });
    if (bytes) await writeFile(file, bytes, { mode: 0o600 });
    await writeFile(`${file}.json`, JSON.stringify({ at: now(), type }), { mode: 0o600 });
    if (!bytes) throw new InboxError('no picture', 404);
    return { type, bytes };
  }

  // Unipile's sign-in page for an account: new (one source, or Noah's four),
  // or again for one that needs it.
  async function connect({ provider = '', reconnect = '' } = {}) {
    const key = await readKey(keyFile);
    if (!key) throw new InboxError(NO_KEY(keyFile), 409, { missing: 'key' });
    if (provider === 'x') throw new InboxError(NOT_YET[0].note, 400);
    if (provider && !CONNECTS[provider]) throw new InboxError(`Messages cannot connect ${provider}.`, 400);
    if (reconnect && !/^[A-Za-z0-9_-]{1,128}$/.test(reconnect)) throw new InboxError('not an account', 400);
    const body = {
      type: reconnect ? 'reconnect' : 'create',
      ...(reconnect ? { reconnect_account: reconnect } : { providers: provider ? [CONNECTS[provider]] : ['GOOGLE', 'WHATSAPP', 'LINKEDIN', 'INSTAGRAM'] }),
      api_url: key.origin, expiresOn: new Date(now() + 60 * 60_000).toISOString(), name: 'imperfect',
    };
    const answer = await unipile(key, { send }).call('POST', '/hosted/accounts/link', { json: body, doing: 'making a sign-in link' });
    const url = String(answer?.url ?? '');
    let parsed = null;
    try { parsed = new URL(url); } catch { /* refused below */ }
    if (!parsed || !(parsed.protocol === 'https:' || ['127.0.0.1', 'localhost'].includes(parsed.hostname))) throw new InboxError('Unipile did not answer with a sign-in link.', 502);
    store = await loaded();
    store.refreshedAt = 0; // the next list asks again, for the new account
    return { url };
  }

  // An email thread, every message of it (up to a hundred), or one email alone.
  async function emailThread(u, kind, account, thing) {
    const items = kind === 'mail'
      ? await u.all('/emails', { account_id: account.id, thread_id: thing }, 100, 'reading the email thread')
      : [await u.get(`/emails/${encodeURIComponent(thing)}`, {}, 'reading the email')];
    return items.filter(raw => raw?.id && !['spam', 'trash', 'drafts'].includes(raw.role));
  }
  // Who an email reply goes to: whoever last wrote that was not the
  // account itself (their Reply-To if they set one), under the thread's subject.
  function replyOf(items, account) {
    const mine = address => Boolean(account.handle) && address.toLowerCase() === account.handle.toLowerCase();
    const sorted = items.filter(raw => raw?.id).sort((a, b) => ms(a.date) - ms(b.date));
    const theirs = sorted.filter(raw => !mine(person(raw.from_attendee).address)).at(-1);
    const last = sorted.at(-1);
    const target = theirs ?? last;
    const to = theirs
      ? ((target.reply_to_attendees ?? []).length ? target.reply_to_attendees : [target.from_attendee]).map(person)
      : (last.to_attendees ?? []).map(person);
    const subject = one(target.subject);
    return { to: to.filter(who => who.address), subject: /^re\s?:/i.test(subject) ? subject : `Re: ${subject}`, inReplyTo: String(target.id) };
  }

  // The person pressed Send. A nonce already used answers as it did.
  async function sendReply({ key, text, nonce = '' } = {}) {
    const words = String(text ?? '').replace(/\r\n/g, '\n').trim();
    if (!words) throw new InboxError('There is nothing to send.', 400);
    if (words.length > 20_000) throw new InboxError('That is too long to send as one message.', 413);
    const once = /^[\w-]{8,80}$/.test(String(nonce)) ? String(nonce) : '';
    if (once && sent.has(once)) return sent.get(once);
    const { kind, account: id, id: thing } = parseKey(key);
    const account = await accountFor(id);
    const u = await api();
    let answer;
    if (kind === 'chat') {
      const done = await u.call('POST', `/chats/${encodeURIComponent(thing)}/messages`, { form: { text: words, account_id: account.id }, doing: `sending on ${account.label}` });
      answer = { sent: true, id: String(done?.message_id ?? '') };
    } else {
      const items = await emailThread(u, kind, account, thing);
      if (!items.length) throw new InboxError('That email thread is empty, so there is no one to reply to.', 404);
      const reply = replyOf(items, account);
      if (!reply.to.length) throw new InboxError('There is no one to reply to in that thread.', 400);
      const body = `<div>${words.replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`).replace(/\n/g, '<br>')}</div>`;
      const done = await u.call('POST', '/emails', {
        form: { account_id: account.id, to: reply.to.map(who => ({ ...(who.name ? { display_name: who.name } : {}), identifier: who.address })), subject: reply.subject, body, reply_to: reply.inReplyTo },
        headers: { 'Idempotency-Key': once || randomUUID() }, doing: `sending from ${account.name}`,
      });
      answer = { sent: true, id: String(done?.provider_id ?? done?.tracking_id ?? '') };
    }
    store = await loaded();
    delete store.drafts[key];
    const listed = store.conversations.find(item => item.key === key);
    if (listed) { listed.at = now(); listed.preview = `You: ${preview(words)}`; store.seen[key] = listed.at; }
    store.refreshedAt = Math.min(store.refreshedAt, now() - maxAge + 5000); // ask again soon, for what the provider made of it
    void save();
    if (once) { sent.set(once, answer); if (sent.size > 200) sent.delete(sent.keys().next().value); }
    return answer;
  }

  // An agent's draft: kept here until sent or put away, and shown in the
  // composer of every window open on Messages. Never sent from here.
  async function draft({ key, text, by = '' } = {}) {
    const words = String(text ?? '').replace(/\r\n/g, '\n').trim();
    if (!words) throw new InboxError('A draft needs its words.', 400);
    if (words.length > 20_000) throw new InboxError('That draft is too long.', 413);
    const { account } = parseKey(key);
    await accountFor(account);
    store = await loaded();
    const entry = { text: words, by: clip(one(by), 40), at: now() };
    store.drafts[key] = entry;
    await save();
    const listed = store.conversations.find(item => item.key === key);
    tell({ type: 'inbox-draft', key, ...entry });
    return { key, title: listed ? (listed.subject && listed.kind !== 'chat' ? `${listed.name} · ${listed.subject}` : listed.name) : key, ...entry };
  }
  async function discard({ key } = {}) {
    parseKey(key);
    store = await loaded();
    delete store.drafts[key];
    await save();
    return { key, discarded: true };
  }

  return { list, thread, search, attachment, avatar, connect, send: sendReply, draft, discard, home: true };
}

async function pool(items, size, run) {
  const queue = [...items];
  await Promise.all(Array.from({ length: Math.min(size, queue.length) }, async () => {
    while (queue.length) { try { await run(queue.shift()); } catch { /* one at a time; the rest go on */ } }
  }));
}

/* -------------------------------------- every other computer: ask the PC */

// url: the PC's address as this computer reaches it. Its /inbox/ answers;
// the origin said is the PC's own, as recall says it. headers: what else
// each ask carries (a lent computer's token). refused(answer): an answer
// that means "not for this computer" (null: none does).
export function createRemoteInbox({ url, name = 'the PC', send = fetch, tell = () => {}, headers = async () => ({}) }) {
  const away = () => new InboxError(`Messages are kept on ${name}, and this computer cannot reach it right now. Try again once ${name} is on.`, 503);
  async function fetchFrom(path, { method = 'GET', body, signal } = {}) {
    if (!url) throw away();
    try {
      return await send(`${url}${path}`, { method, headers: { origin: url, ...await headers(), ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined, redirect: 'error',
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(45_000)]) : AbortSignal.timeout(45_000) });
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new InboxError(`${name}, which keeps Messages, could not be reached: it may be off, or the way to it down. Try again soon.`, 503);
    }
  }
  async function ask(path, options) {
    const res = await fetchFrom(path, options);
    const answer = await res.json().catch(() => ({}));
    if (!res.ok) throw new InboxError(answer.error || `${name}, which keeps Messages, answered ${res.status}`, res.status, answer.lent === false ? { refused: true } : {});
    return answer;
  }
  const query = values => { const q = new URLSearchParams(Object.entries(values).filter(([, v]) => v != null && v !== '' && v !== false).map(([k, v]) => [k, String(v)])).toString(); return q ? `?${q}` : ''; };
  return {
    home: false, url, name,
    list: ({ refresh } = {}) => ask(`/inbox/list${query({ refresh: refresh ? 1 : '' })}`),
    thread: (key, { cursor = '', seen = false } = {}) => ask(`/inbox/thread${query({ key, cursor, seen: seen ? 1 : '' })}`),
    search: (q, { limit, source, account } = {}) => ask(`/inbox/search${query({ q, limit, source, account })}`),
    connect: body => ask('/inbox/connect', { method: 'POST', body }),
    send: body => ask('/inbox/send', { method: 'POST', body }),
    async draft(body) { const answer = await ask('/inbox/draft', { method: 'POST', body }); tell({ type: 'inbox-draft', key: answer.key, text: answer.text, by: answer.by, at: answer.at }); return answer; },
    discard: body => ask('/inbox/discard', { method: 'POST', body }),
    // The bytes, as the PC answers them.
    attachment: (key, message, id) => fetchFrom(`/inbox/attachment${query({ key, message, id })}`),
    async avatar(key) {
      const res = await fetchFrom(`/inbox/avatar${query({ key })}`);
      if (!res.ok) throw new InboxError('no picture', res.status === 403 ? 403 : 404, res.status === 403 ? { refused: true } : {});
      return { type: String(res.headers.get('content-type') ?? ''), bytes: Buffer.from(await res.arrayBuffer()) };
    },
  };
}

// A computer the PC lends its inbox to (a cloud computer behind the site's
// lock, while Noah wants it real there): it asks the PC's lent inbox at url
// (a loopback address the PC's tunnel reaches it at), with the token in
// tokenFile. No token, or the PC saying it is not lent (any more), and it
// is the demo inbox instead: the PC decides, not this computer.
export function createLentInbox({ url, tokenFile, demo, send = fetch, tell = () => {}, now = () => Date.now() }) {
  let refusedAt = -Infinity;
  const token = async () => (await readFile(tokenFile, 'utf8').catch(() => '')).trim();
  const remote = createRemoteInbox({ url, name: 'the PC', send, tell, headers: async () => ({ authorization: `Bearer ${await token()}` }) });
  // The PC's answer, or the demo's when the PC does not lend to this computer.
  const either = name => async (...args) => {
    if (now() - refusedAt < 60_000 || !/^[\w-]{20,200}$/.test(await token())) return demo[name](...args);
    try { return await remote[name](...args); } catch (error) {
      if (!error.refused) throw error;
      refusedAt = now();
      return demo[name](...args);
    }
  };
  return { home: false, lent: true, url, ...Object.fromEntries(['list', 'thread', 'search', 'attachment', 'avatar', 'connect', 'send', 'draft', 'discard'].map(name => [name, either(name)])) };
}

/* ------------------------------------------------------- which inbox here */

// Which inbox this computer shows: one setting of its own, "inbox" in
// machine.json (system/machine.mjs), and whether it is hosted.
//   absent      the person's own computer: the key here, or the PC's (the
//               authority) through the tailnet. A hosted computer: the demo.
//   "demo"      the staged demo inbox (system/inbox-demo.json), always.
//   "own"       a key of this computer's own, even hosted (a renter's).
//   "http://127.0.0.1:PORT"   the PC's inbox, lent to this computer through
//               a tunnel, with credentials/inbox-token (system/inbox-lend.mjs).
// Anything else is the default: a hosted computer never reads a key or
// asks the PC unless it says so.
export function inboxSource({ hosted = false, inbox = '' } = {}) {
  if (inbox === 'demo') return { kind: 'demo' };
  if (inbox === 'own') return { kind: 'own' };
  if (lentAddress(inbox)) return { kind: 'lent', url: inbox };
  return { kind: hosted ? 'demo' : 'personal' };
}
export const lentAddress = value => typeof value === 'string' && /^http:\/\/127\.0\.0\.1:\d{2,5}$/.test(value) && Number(value.split(':')[2]) < 65536;

/* ------------------------------------------------------------ the route */

// Where the inbox is, told by the machine server: this computer's own, the
// PC's through it, lent, or the demo. The tools below ask it.
let current = null;
const located = async () => {
  if (!current) throw new InboxError('Messages is not running here: this agent is not inside imperfect.', 503);
  return current();
};

const PAGE_READS = new Set(['/inbox/list', '/inbox/thread', '/inbox/search', '/inbox/attachment', '/inbox/avatar']);
const ACTIONS = new Set(['/inbox/connect', '/inbox/send', '/inbox/draft', '/inbox/discard']);
export const isInboxPath = path => PAGE_READS.has(path) || ACTIONS.has(path);

// One ask of /inbox/, answered by box. lent: the computer the PC lends its
// inbox to, asking through the tunnel ({ id, send }), or null for a page
// here. A lent computer reads without marking anything read, drafts as
// itself, connects nothing, and sends only if the PC says it may.
export async function serveInbox(req, res, path, search, box, { lent = null } = {}) {
  const json = (status, value) => { if (!res.headersSent) { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(value)); } };
  const isRead = PAGE_READS.has(path);
  if (isRead ? req.method !== 'GET' : req.method !== 'POST') { json(405, { error: 'wrong method' }); return; }
  const query = new URLSearchParams(search);
  try {
    if (path === '/inbox/attachment') {
      const upstream = await box.attachment(query.get('key'), query.get('message'), query.get('id'));
      if (!upstream.ok) { json(upstream.status, await upstream.json().catch(() => ({ error: `attachment ${upstream.status}` }))); return; }
      const headers = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };
      for (const name of ['content-type', 'content-length', 'content-disposition']) { const value = upstream.headers.get(name); if (value) headers[name] = value; }
      // Shown by the window as a download or in its own tab, never as a page of this origin.
      if (/html|xml|javascript/i.test(headers['content-type'] ?? '')) headers['content-type'] = 'application/octet-stream';
      headers['content-security-policy'] = "default-src 'none'; sandbox";
      res.writeHead(200, headers);
      if (!upstream.body) { res.end(); return; }
      Readable.fromWeb(upstream.body).on('error', () => res.destroy()).pipe(res);
      return;
    }
    if (path === '/inbox/avatar') {
      const { type, bytes } = await box.avatar(query.get('key'));
      if (!/^image\/(jpeg|png|webp|gif)$/.test(type)) throw new InboxError('no picture', 404);
      res.writeHead(200, { 'content-type': type, 'content-length': bytes.length, 'cache-control': 'no-store', 'content-security-policy': "default-src 'none'; sandbox" });
      res.end(bytes);
      return;
    }
    const capabilities = answer => lent ? { ...answer, canSend: lent.send, canConnect: false } : answer;
    if (path === '/inbox/list') { json(200, capabilities(await box.list({ refresh: query.get('refresh') === '1' }))); return; }
    if (path === '/inbox/thread') { json(200, capabilities(await box.thread(query.get('key'), { cursor: query.get('cursor') ?? '', seen: !lent && query.get('seen') === '1' }))); return; }
    if (path === '/inbox/search') { json(200, capabilities(await box.search(query.get('q') ?? '', { limit: query.get('limit'), source: query.get('source') ?? '', account: query.get('account') ?? '' }))); return; }
    let body = '';
    req.setEncoding('utf8');
    for await (const chunk of req) { body += chunk; if (body.length > 64 * 1024) throw new InboxError('too long', 413); }
    let asked;
    try { asked = JSON.parse(body || '{}'); } catch { throw new InboxError('not JSON', 400); }
    if (!asked || typeof asked !== 'object' || Array.isArray(asked)) throw new InboxError('not JSON', 400);
    if (path === '/inbox/connect') {
      if (lent) throw new InboxError('Accounts are connected on the PC itself, not from a computer it lends Messages to.', 403);
      json(200, await box.connect({ provider: String(asked.provider ?? ''), reconnect: String(asked.reconnect ?? '') }));
    } else if (path === '/inbox/send') {
      if (lent && !lent.send) throw new InboxError(`Sending is off on ${lent.id}: Noah lends it his messages to read and draft. Send from his own computer.`, 403);
      json(200, await box.send({ key: asked.key, text: asked.text, nonce: asked.nonce }));
    } else if (path === '/inbox/draft') {
      json(200, capabilities(await box.draft({ key: asked.key, text: asked.text, by: lent ? `${String(asked.by ?? '').slice(0, 20) || 'An agent'} on ${lent.id}` : asked.by })));
    } else json(200, await box.discard({ key: asked.key }));
  } catch (error) {
    json(Number(error.status) || 500, { error: error.message, ...(error.missing ? { missing: error.missing } : {}) });
  }
}

// source: inboxSource(this computer's settings). authority(): null when
// this computer keeps Messages (it is the PC, or follows none), else the
// PC's { url, name } (url '' while unreachable). guard(req): why a request
// may not have this computer's messages, or '' (the PC's: only its own
// screen and the person's own devices; system/server.mjs). tell(message):
// this computer's open windows. local: the PC's own inbox, when made
// already (it is shared with the lent inbox's listener).
export function createInboxRoute({ source = { kind: 'personal' }, authority = async () => null, dir, keyFile = credentialsFile(), tokenFile = join(dirname(keyFile), 'inbox-token'),
  send = fetch, tell = () => {}, now, maxAge, guard = async () => '', local = null, demoFile } = {}) {
  const demo = createDemoInbox({ file: demoFile, tell, now });
  const own = () => (local ??= createLocalInbox({ keyFile, dir, send, now, tell, maxAge }));
  const lent = source.kind === 'lent' ? createLentInbox({ url: source.url, tokenFile, demo, send, tell, now }) : null;
  const remotes = new Map();
  const inbox = async () => {
    if (source.kind === 'demo') return demo;
    if (lent) return lent;
    if (source.kind === 'own') return own();
    const there = await authority();
    if (!there) return own();
    const id = `${there.url}|${there.name}`;
    if (!remotes.has(id)) remotes.set(id, createRemoteInbox({ url: there.url, name: there.name, send, tell }));
    return remotes.get(id);
  };
  current = inbox;
  const handle = async function handle(req, res, path, search = '') {
    if (!isInboxPath(path)) return false;
    const refuse = (status, error) => { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify({ error })); };
    // A page elsewhere never reads the person's messages (as with Files);
    // and an action needs a page's exact origin, which /peer/ drops.
    const site = req.headers['sec-fetch-site'];
    if (site && site !== 'same-origin' && site !== 'none') { refuse(403, 'Messages are read only from imperfect\'s own window'); return true; }
    if (!PAGE_READS.has(path) && req.method === 'POST' && !req.headers.origin) { refuse(403, 'exact origin required'); return true; }
    const why = await guard(req);
    if (why) { refuse(403, why); return true; }
    let box;
    try { box = await inbox(); } catch (error) { refuse(Number(error.status) || 500, error.message); return true; }
    await serveInbox(req, res, path, search, box);
    return true;
  };
  handle.inbox = inbox;
  // The PC's own inbox, which it may lend (system/inbox-lend.mjs): only where the key is kept.
  handle.local = async () => (source.kind === 'own' || (source.kind === 'personal' && !await authority()) ? own() : null);
  return handle;
}

/* ------------------------------------------------------- the agents' tools */

const SOURCE_NAMES = Object.fromEntries(Object.values(SOURCES).map(({ source, label }) => [source, label]));
const when = at => (at ? `${new Date(at).toISOString().slice(0, 16).replace('T', ' ')} UTC` : '');

export const MESSAGES_SEARCH_TOOL = {
  name: 'messages_search',
  description: "Search Noah's own messages in Messages, imperfect's unified inbox: his Gmail accounts, WhatsApp, LinkedIn and Instagram (through Unipile), newest first. With words, finds the conversations holding them (names, subjects and recent messages; email is searched in full); with no words, lists his newest conversations. Each result has a key: give it to messages_read to read the whole conversation, or to messages_draft to put a reply in front of him. Read-only: nothing is marked read, sent or changed.",
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'words that must all appear (empty: the newest conversations)' },
      source: { type: 'string', enum: ['gmail', 'whatsapp', 'linkedin', 'instagram', 'outlook', 'telegram', 'mail'], description: 'only conversations from this service' },
      limit: { type: 'number', description: 'how many conversations, at most (default 15, up to 50)' },
    },
  },
};
export const MESSAGES_READ_TOOL = {
  name: 'messages_read',
  description: "Read one conversation from Noah's Messages (imperfect's unified inbox), by the key messages_search gave: a chat's newest messages, or an email thread with its bodies as plain text, oldest first, with who said each and when. Attachments are named, never opened. Read-only: it does not mark anything read or reply.",
  parameters: {
    type: 'object',
    properties: { key: { type: 'string', description: "the conversation's key, from messages_search" } },
    required: ['key'],
  },
};
export const MESSAGES_DRAFT_TOOL = {
  name: 'messages_draft',
  description: "Put a reply into the composer of one conversation in Noah's Messages, for him to read, change and send himself. It never sends: there is no way for an agent to send a message, email or DM, and Noah's rule is to ask before anything is sent. The draft replaces any earlier draft for that conversation and appears in every window open on Messages, marked as drafted by you; an email reply goes to whoever last wrote, under the thread's subject. Write the words exactly as they should go, in Noah's voice, with no placeholders or notes to him inside them; tell him in your answer that it is waiting for him to press Send.",
  parameters: {
    type: 'object',
    properties: {
      key: { type: 'string', description: "the conversation's key, from messages_search" },
      text: { type: 'string', description: 'the reply, exactly as it would be sent' },
    },
    required: ['key', 'text'],
  },
};

function listing(answer, words) {
  if (answer.state === 'no-key') return answer.message;
  if (answer.state === 'no-accounts') return 'Messages has a Unipile key but no accounts connected yet. Ask Noah to connect them from Messages in imperfect\'s sidebar (Connect account).';
  if (answer.state === 'error') return `Messages could not be read: ${answer.message}`;
  const names = new Map(answer.accounts.map(a => [a.id, a]));
  const rows = answer.conversations;
  const head = (answer.demo ? 'This is the demo inbox: invented conversations, for showing Messages; nothing in it is real and nothing can be sent from it.\n' : '')
    + (rows.length ? `${rows.length} conversation${rows.length === 1 ? '' : 's'}${words ? ` holding "${words}"` : ', newest first'}:` : `No conversation holds "${words}".`);
  const lines = rows.map((c, i) => {
    const a = names.get(c.account);
    return `${i + 1}. ${SOURCE_NAMES[c.source] ?? c.source}${a && a.name !== (SOURCE_NAMES[c.source] ?? '') ? ` (${a.name})` : ''} · ${c.name}${c.subject && c.kind !== 'chat' ? ` · ${c.subject}` : ''} · ${when(c.at)}${c.unread ? ' · unread' : ''}${c.draft ? ' · has a draft' : ''}\n   ${c.match || c.preview || ''}\n   key: ${c.key}`;
  });
  const problems = (answer.problems ?? []).length ? `\n\nNot everything answered: ${answer.problems.join('; ')}` : '';
  return [head, ...lines].join('\n') + problems;
}

export async function runMessagesSearch({ query = '', source = '', limit, signal } = {}, { inbox = located } = {}) {
  signal?.throwIfAborted();
  const words = String(query ?? '').trim();
  const box = await inbox();
  return listing(await box.search(words, { limit: Math.max(1, Math.min(50, Number(limit) || 15)), source: String(source ?? '') }), words);
}

export async function runMessagesRead({ key, signal } = {}, { inbox = located } = {}) {
  signal?.throwIfAborted();
  const box = await inbox();
  const t = await box.thread(String(key ?? ''), {});
  const label = SOURCE_NAMES[t.source] ?? t.source;
  const head = [`${label}${t.account.name && t.account.name !== label ? ` (${t.account.name})` : ''} · ${t.title}`, t.people.length ? `with ${t.people.join(', ')}` : ''].filter(Boolean).join('\n');
  const body = t.messages.map(m => {
    const files = m.attachments.length ? `\n   [attached: ${m.attachments.map(a => a.name).join(', ')}]` : '';
    if (t.kind === 'chat') return `[${when(m.at)}] ${m.from}: ${m.deleted ? '(deleted)' : m.event ? `(${m.text || 'event'})` : m.text}${m.quoted ? `\n   (replying to: ${m.quoted})` : ''}${files}`;
    return `--- ${when(m.at)} from ${m.from}${m.address && m.from !== 'You' ? ` <${m.address}>` : ''} to ${m.to.map(personName).join(', ')}\n${m.text}${m.quoted ? '\n[quoted earlier messages left out]' : ''}${files}`;
  });
  const reply = t.reply ? `\nA reply would go to ${t.reply.to.map(who => who.address).join(', ')} as "${t.reply.subject}".` : t.readOnly ? '\nThis conversation cannot be replied to.' : '';
  const draft = t.draft ? `\nA draft is waiting in the composer (${t.draft.by || 'an agent'}): ${clip(one(t.draft.text), 200)}` : '';
  return `${t.demo ? '(The demo inbox: invented, not anyone\'s real messages.)\n' : ''}${head}\n\n${body.join('\n\n') || '(no messages)'}${t.cursor ? '\n\n(older messages not shown)' : ''}\n${reply}${draft}`.trim();
}

const HARNESSES = { claude: 'Claude', codex: 'Codex', pi: 'Pi' };
export async function runMessagesDraft({ key, text, harness, signal } = {}, { inbox = located } = {}) {
  signal?.throwIfAborted();
  const box = await inbox();
  const done = await box.draft({ key: String(key ?? ''), text, by: HARNESSES[harness] ?? 'an agent' });
  if (done.demo) return `Drafted into the composer of "${done.title}" in Messages. This is the demo inbox, so nothing can be sent from it: the draft is there to be seen.`;
  if (done.canSend === false) return `Drafted into the composer of "${done.title}" in Messages. Nothing was sent. Sending is off on this computer; Noah can review the draft here and send from his own computer.`;
  return `Drafted into the composer of "${done.title}" in Messages. Nothing was sent: it waits for Noah to read it, change it if he likes, and press Send himself.`;
}
