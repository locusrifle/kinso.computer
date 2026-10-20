// A fake Unipile, as its API reference describes it (developer.unipile.com/reference):
// the X-API-KEY header, lists as { object, items, cursor } with a cursor
// until the last page, its errors as { title, detail, type, status }, the
// account, chat, message, attendee, folder and email objects as documented,
// multipart sends and the hosted auth link. Everything asked is kept in
// `requests` (with the key as it arrived), everything sent in `sent`.
//
// The people and their words are made up; nothing here reaches Unipile.
import { createServer } from 'node:http';
import { Readable } from 'node:stream';

const at = minutesAgo => new Date(Date.parse('2026-10-19T09:30:00.000Z') - minutesAgo * 60_000).toISOString();
const source = status => [{ id: `src-${status}`, status }];
const account = (id, type, name, params, status = 'OK') => ({ object: 'Account', type, id, name, created_at: at(60 * 24 * 30), connection_params: params, groups: [], sources: source(status) });

export function unipileData() {
  const accounts = [
    account('acc_gmail_home', 'GOOGLE_OAUTH', 'noah@fleming.example', { mail: { id: 'g1', username: 'noah@fleming.example' }, calendar: { id: 'g1', username: 'noah@fleming.example' } }),
    account('acc_gmail_work', 'GOOGLE_OAUTH', 'noah@imperfect.example', { mail: { id: 'g2', username: 'noah@imperfect.example' } }),
    account('acc_linkedin', 'LINKEDIN', 'Noah Fleming', { im: { id: 'ACoAAnoah', username: 'Noah Fleming', publicIdentifier: 'noahfleming', premiumId: null, premiumContractId: null, organizations: [] } }),
    account('acc_whatsapp', 'WHATSAPP', '+61 400 000 001', { im: { phone_number: '+61400000001' } }),
    account('acc_instagram', 'INSTAGRAM', 'noah.makes', { im: { id: '1789', username: 'noah.makes' } }),
    account('acc_calendar', 'GOOGLE_CALENDAR', 'noah@fleming.example', { calendar: 'primary' }),
  ];
  const people = [
    ['att_mum', 'acc_whatsapp', '61411111111@s.whatsapp.net', 'Mum'],
    ['att_sam', 'acc_whatsapp', '61422222222@s.whatsapp.net', 'Sam Okafor'],
    ['att_lena', 'acc_whatsapp', '61433333333@s.whatsapp.net', 'Lena'],
    ['att_priya', 'acc_linkedin', 'ACoAApriya', 'Priya Shah'],
    ['att_tom', 'acc_linkedin', 'ACoAAtom', 'Tom Becker'],
    ['att_jules', 'acc_instagram', '5501', 'jules.draws'],
    ['att_self_wa', 'acc_whatsapp', '61400000001@s.whatsapp.net', 'Noah', 1],
    ['att_self_li', 'acc_linkedin', 'ACoAAnoah', 'Noah Fleming', 1],
  ].map(([id, account_id, provider_id, name, self = 0]) => ({ object: 'ChatAttendee', id, account_id, provider_id, name, is_self: self, hidden: 0, picture_url: '', profile_url: '' }));
  const chat = (id, account_id, account_type, name, attendee_provider_id, minutes, unread, extra = {}) => ({
    object: 'Chat', id, account_id, account_type, provider_id: `p-${id}`, attendee_provider_id, name, type: name ? 1 : 0, timestamp: at(minutes),
    unread_count: unread, archived: 0, muted_until: null, read_only: 0, disabledFeatures: [], folder: ['INBOX'], pinned: 0, ...extra,
  });
  const chats = [
    chat('chat_mum', 'acc_whatsapp', 'WHATSAPP', null, '61411111111@s.whatsapp.net', 4, 2),
    chat('chat_priya', 'acc_linkedin', 'LINKEDIN', null, 'ACoAApriya', 26, 1),
    chat('chat_climb', 'acc_whatsapp', 'WHATSAPP', 'Thursday climbing', undefined, 95, 0),
    chat('chat_jules', 'acc_instagram', 'INSTAGRAM', null, '5501', 60 * 5, 0),
    chat('chat_tom', 'acc_linkedin', 'LINKEDIN', null, 'ACoAAtom', 60 * 30, 0),
    chat('chat_old', 'acc_whatsapp', 'WHATSAPP', 'Archived group', undefined, 60 * 24 * 40, 0, { archived: 1 }),
  ];
  const message = (id, chat_id, account_id, sender, attendee, minutes, text, extra = {}) => ({
    object: 'Message', id, provider_id: `p-${id}`, account_id, chat_id, chat_provider_id: `p-${chat_id}`, sender_id: sender, sender_attendee_id: attendee,
    text, attachments: [], timestamp: at(minutes), is_sender: 0, reactions: [], seen: 0, seen_by: {}, hidden: 0, deleted: 0, edited: 0, is_event: 0, delivered: 1,
    behavior: null, original: '{}', ...extra,
  });
  const messages = [
    message('m1', 'chat_mum', 'acc_whatsapp', '61400000001@s.whatsapp.net', 'att_self_wa', 60 * 20, 'Landed safe, call you tomorrow', { is_sender: 1 }),
    message('m2', 'chat_mum', 'acc_whatsapp', '61411111111@s.whatsapp.net', 'att_mum', 9, 'Are you still coming for lunch on Sunday?'),
    message('m3', 'chat_mum', 'acc_whatsapp', '61411111111@s.whatsapp.net', 'att_mum', 4, 'Dad is doing the roast. Bring the good bread x'),
    message('m4', 'chat_priya', 'acc_linkedin', 'ACoAApriya', 'att_priya', 60 * 26, 'Hi Noah, I saw the imperfect demo on X. Would you be open to a call about a pilot with our team?'),
    message('m5', 'chat_priya', 'acc_linkedin', 'ACoAAnoah', 'att_self_li', 60 * 25, 'Happy to. What does your week look like?', { is_sender: 1 }),
    message('m6', 'chat_priya', 'acc_linkedin', 'ACoAApriya', 'att_priya', 26, 'Thursday 2pm works. I have attached the brief so you can see what we are after.', {
      attachments: [{ id: 'a6', type: 'file', file_name: 'pilot-brief.pdf', file_size: 182044, mimetype: 'application/pdf', unavailable: false }] }),
    message('m7', 'chat_climb', 'acc_whatsapp', '61422222222@s.whatsapp.net', 'att_sam', 95, 'Gym at 6:30? Lena is bringing the new shoes'),
    message('m8', 'chat_climb', 'acc_whatsapp', '61433333333@s.whatsapp.net', 'att_lena', 96, '', { is_event: 1, event_type: 5, hidden: 1 }),
    message('m9', 'chat_jules', 'acc_instagram', '5501', 'att_jules', 60 * 5, 'that galaxy render is unreal. what did you make it with?', {
      attachments: [{ id: 'a9', type: 'img', mimetype: 'image/jpeg', unavailable: false, size: { width: 1080, height: 1350 }, sticker: false }] }),
    message('m10', 'chat_tom', 'acc_linkedin', 'ACoAAtom', 'att_tom', 60 * 30, 'Congrats on the launch!'),
  ];
  const mail = (id, account_id, thread_id, minutes, from, to, subject, body_plain, extra = {}) => ({
    object: 'Email', id, deprecated_id: `d-${id}`, kind: '2_full', account_id, type: 'GOOGLE_OAUTH', date: at(minutes), role: 'inbox', folders: ['INBOX'], folderIds: ['INBOX'],
    read_date: null, message_id: `<${id}@mail.example>`, provider_id: `prov-${id}`, from_attendee: { display_name: from[0], identifier: from[1], identifier_type: 'EMAIL_ADDRESS' },
    to_attendees: to.map(([display_name, identifier]) => ({ display_name, identifier, identifier_type: 'EMAIL_ADDRESS' })), cc_attendees: [], bcc_attendees: [], reply_to_attendees: [],
    subject, body: '', body_plain, has_attachments: false, attachments: [], origin: 'external', thread_id, headers: [], ...extra,
  });
  const home = ['Noah Fleming', 'noah@fleming.example'], work = ['Noah Fleming', 'noah@imperfect.example'];
  const emails = [
    mail('e1', 'acc_gmail_home', 'th_dinner', 14, ['Ellie Fleming', 'ellie@fleming.example'], [home], 'Dinner Saturday?', 'Are you two free Saturday night? Thinking the Thai place at 7.\n\nE', { folders: ['CATEGORY_PERSONAL', 'INBOX', 'UNREAD'] }),
    mail('e2', 'acc_gmail_work', 'th_pilot', 60 * 3, ['Marcus Lee', 'marcus@northwind.example'], [work], 'Pilot timeline', 'Hi Noah,\n\nCould we start the pilot on the 3rd? Plan attached.\n\nMarcus', {
      has_attachments: true, attachments: [{ id: 'att-plan', name: 'pilot-plan.pdf', size: 88021, extension: 'pdf', mime: 'application/pdf' }] }),
    mail('e3', 'acc_gmail_work', 'th_pilot', 60 * 2, work, [['Marcus Lee', 'marcus@northwind.example']], 'Re: Pilot timeline', 'The 3rd works. I will send the setup notes on Friday.\n\nOn Sun, 19 Oct 2026, Marcus Lee wrote:\n> Could we start the pilot on the 3rd?', { role: 'sent', folders: ['SENT'] }),
    mail('e4', 'acc_gmail_work', 'th_pilot', 50, ['Marcus Lee', 'marcus@northwind.example'], [work], 'Re: Pilot timeline', 'Perfect, thank you. Looking forward to it.\n\n> The 3rd works.', { reply_to_attendees: [{ display_name: 'Northwind Pilots', identifier: 'pilots@northwind.example', identifier_type: 'EMAIL_ADDRESS' }] }),
    mail('e5', 'acc_gmail_home', 'th_receipt', 60 * 8, ['Hardware Store', 'orders@store.example'], [home], 'Your order has shipped', '', { folders: ['CATEGORY_PERSONAL', 'INBOX'], body: '<html><head><style>p{color:red}</style></head><body><p>Your order <b>#4471</b> is on its way.</p><p>Track it&nbsp;online &amp; enjoy.</p></body></html>' }),
    // Gmail's Promotions, in the inbox but not its Primary: never listed.
    mail('e7', 'acc_gmail_home', 'th_sale', 3, ['Shoe Shop', 'deals@shoes.example'], [home], 'Everything 40% off', 'Today only&shy;&zwnj;\u034f', { folders: ['CATEGORY_PROMOTIONS', 'INBOX', 'UNREAD'] }),
    // Primary, but archived out of the inbox: done.
    mail('e9', 'acc_gmail_home', 'th_done', 60 * 9, ['Ellie Fleming', 'ellie@fleming.example'], [home], 'Old plans', 'Sorted, thanks', { folders: ['CATEGORY_PERSONAL'] }),
    mail('e6', 'acc_gmail_home', 'th_spam', 60, ['Prize Desk', 'win@spam.example'], [home], 'You won', 'Claim now', { role: 'spam', folders: ['SPAM'] }),
  ];
  const folders = ['acc_gmail_home', 'acc_gmail_work'].flatMap(account_id => [
    { object: 'Folder', id: `${account_id}-inbox`, name: 'INBOX', account_id, role: 'inbox', provider_id: 'INBOX' },
    { object: 'Folder', id: `${account_id}-sent`, name: 'SENT', account_id, role: 'sent', provider_id: 'SENT' },
  ]);
  // Gmail's Primary tab, as Gmail labels it; the work account has none (as some do not).
  folders.push({ object: 'Folder', id: 'acc_gmail_home-personal', name: 'CATEGORY_PERSONAL', account_id: 'acc_gmail_home', role: 'unknown', provider_id: 'CATEGORY_PERSONAL' });
  return { accounts, people, chats, messages, emails, folders };
}

const error = (status, title, detail, type) => ({ status, body: { title, detail, type, status } });

// key: the access token the fake accepts. maxPage: the most items a page
// holds, whatever limit is asked, to make the client follow cursors.
export async function startFakeUnipile({ key = 'fake-unipile-key', maxPage = 250, data = unipileData() } = {}) {
  const fake = { key, data, requests: [], sent: [], links: [], failAccounts: new Set(), maxPage };
  const page = (items, query) => {
    const limit = Math.min(Number(query.get('limit')) || 100, fake.maxPage);
    const from = query.get('cursor') ? Number(Buffer.from(query.get('cursor'), 'base64url').toString()) : 0;
    const next = from + limit < items.length ? Buffer.from(String(from + limit)).toString('base64url') : null;
    return { items: items.slice(from, from + limit), cursor: next };
  };
  const newest = (a, b) => Date.parse(b.timestamp ?? b.date) - Date.parse(a.timestamp ?? a.date);
  async function answer(req, url) {
    const q = url.searchParams, path = url.pathname, m = req.method;
    if (req.headers['x-api-key'] !== fake.key) return error(401, 'Unauthorized', 'Missing credentials', 'errors/missing_credentials');
    let hit;
    if (m === 'GET' && path === '/api/v1/accounts') return { body: { object: 'AccountList', ...page(fake.data.accounts, q) } };
    if (m === 'GET' && path === '/api/v1/chats') {
      const ids = q.get('account_id')?.split(',');
      return { body: { object: 'ChatList', ...page(fake.data.chats.filter(c => !ids || ids.includes(c.account_id)).sort(newest), q) } };
    }
    if ((hit = /^\/api\/v1\/chats\/([^/]+)$/.exec(path)) && m === 'GET') {
      const chat = fake.data.chats.find(c => c.id === decodeURIComponent(hit[1]));
      if (!chat) return error(404, 'Not Found', 'Chat not found', 'errors/resource_not_found');
      const last = fake.data.messages.filter(x => x.chat_id === chat.id).sort(newest)[0];
      return { body: { ...chat, lastMessage: last ?? null } };
    }
    if ((hit = /^\/api\/v1\/chats\/([^/]+)\/messages$/.exec(path))) {
      const chat = fake.data.chats.find(c => c.id === decodeURIComponent(hit[1]));
      if (!chat) return error(404, 'Not Found', 'Chat not found', 'errors/resource_not_found');
      if (m === 'POST') {
        const form = await new Request(url, { method: 'POST', headers: req.headers, body: Readable.toWeb(req), duplex: 'half' }).formData();
        if (form.get('account_id') && form.get('account_id') !== chat.account_id) return error(403, 'Forbidden', 'Account mismatch', 'errors/account_mismatch');
        const id = `sent${fake.sent.length + 1}`;
        fake.sent.push({ kind: 'chat', chat: chat.id, text: form.get('text'), account_id: form.get('account_id') });
        fake.data.messages.push({ ...fake.data.messages[0], id, chat_id: chat.id, account_id: chat.account_id, text: form.get('text'), timestamp: new Date().toISOString(), is_sender: 1, attachments: [] });
        return { status: 201, body: { object: 'MessageSent', message_id: id } };
      }
      return { body: { object: 'MessageList', ...page(fake.data.messages.filter(x => x.chat_id === chat.id).sort(newest), q) } };
    }
    if ((hit = /^\/api\/v1\/chats\/([^/]+)\/attendees$/.exec(path)) && m === 'GET') {
      const chat = fake.data.chats.find(c => c.id === decodeURIComponent(hit[1]));
      if (!chat) return error(404, 'Not Found', 'Chat not found', 'errors/resource_not_found');
      const senders = new Set(fake.data.messages.filter(x => x.chat_id === chat.id).map(x => x.sender_attendee_id));
      const items = fake.data.people.filter(p => p.account_id === chat.account_id && (senders.has(p.id) || p.provider_id === chat.attendee_provider_id || p.is_self));
      return { body: { object: 'ChatAttendeeList', items, cursor: null } };
    }
    if (m === 'GET' && path === '/api/v1/messages') {
      const id = q.get('account_id');
      return { body: { object: 'MessageList', ...page(fake.data.messages.filter(x => !id || x.account_id === id).sort(newest), q) } };
    }
    if (m === 'GET' && path === '/api/v1/chat_attendees') {
      const id = q.get('account_id');
      return { body: { object: 'ChatAttendeeList', ...page(fake.data.people.filter(p => !id || p.account_id === id), q) } };
    }
    if ((hit = /^\/api\/v1\/(messages|emails)\/([^/]+)\/attachments\/([^/]+)$/.exec(path)) && m === 'GET') {
      const [, kind, id, attachment] = hit.map(decodeURIComponent);
      const owner = kind === 'messages' ? fake.data.messages.find(x => x.id === id) : fake.data.emails.find(x => x.id === id);
      if (!owner?.attachments.some(a => a.id === attachment)) return error(404, 'Not Found', 'Attachment not found', 'errors/resource_not_found');
      return { status: 200, raw: Buffer.from(`%PDF-1.4 fake ${attachment}`), type: 'application/pdf' };
    }
    // A person's picture: Priya has one, the rest do not.
    if ((hit = /^\/api\/v1\/chat_attendees\/([^/]+)\/picture$/.exec(path)) && m === 'GET') {
      if (decodeURIComponent(hit[1]) !== 'att_priya') return error(404, 'Not Found', 'No picture', 'errors/resource_not_found');
      return { status: 200, raw: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]), type: 'image/jpeg' };
    }
    if (m === 'GET' && path === '/api/v1/folders') return { body: { object: 'FolderList', items: fake.data.folders.filter(f => !q.get('account_id') || f.account_id === q.get('account_id')) } };
    if (m === 'GET' && path === '/api/v1/emails') {
      const id = q.get('account_id');
      if (!id) return error(400, 'Invalid parameters', 'account_id must be a string', 'errors/invalid_parameters');
      if (!fake.data.accounts.some(a => a.id === id)) return error(404, 'Not Found', 'Account not found', 'errors/resource_not_found');
      if (fake.failAccounts.has(id)) return error(503, 'Service Unavailable', 'Network is down on server side.', 'errors/network_down');
      const words = q.get('search')?.toLowerCase();
      const items = fake.data.emails.filter(e => e.account_id === id && (!q.get('folder') || e.folders.includes(q.get('folder')))
        && (!q.get('thread_id') || e.thread_id === q.get('thread_id')) && (!words || `${e.subject} ${e.body_plain} ${e.body}`.toLowerCase().includes(words))).sort(newest);
      return { body: { object: 'EmailList', ...page(items, q) } };
    }
    if ((hit = /^\/api\/v1\/emails\/([^/]+)$/.exec(path)) && m === 'GET') {
      const email = fake.data.emails.find(e => e.id === decodeURIComponent(hit[1]));
      return email ? { body: email } : error(404, 'Not Found', 'Email not found', 'errors/resource_not_found');
    }
    if (m === 'POST' && path === '/api/v1/emails') {
      const form = await new Request(url, { method: 'POST', headers: req.headers, body: Readable.toWeb(req), duplex: 'half' }).formData();
      if (!form.get('account_id') || !form.get('to') || !form.get('body')) return error(400, 'Invalid parameters', 'account_id, to and body are required', 'errors/invalid_parameters');
      const replied = form.get('reply_to') && fake.data.emails.find(e => e.id === form.get('reply_to') || e.provider_id === form.get('reply_to'));
      if (form.get('reply_to') && !replied) return error(422, 'Unprocessable Entity', 'Parent mail not found', 'errors/parent_mail_not_found');
      const idem = req.headers['idempotency-key'];
      if (idem && fake.sent.some(s => s.idempotency === idem)) return { status: 201, body: { object: 'EmailSent', tracking_id: 'same', provider_id: 'same' } };
      fake.sent.push({ kind: 'email', account_id: form.get('account_id'), to: JSON.parse(form.get('to')), subject: form.get('subject'), body: form.get('body'), reply_to: form.get('reply_to'), idempotency: idem });
      return { status: 201, body: { object: 'EmailSent', tracking_id: `t${fake.sent.length}`, provider_id: `sent-${fake.sent.length}` } };
    }
    if (m === 'POST' && path === '/api/v1/hosted/accounts/link') {
      let body = '';
      for await (const chunk of req) body += chunk;
      const asked = JSON.parse(body || '{}');
      const iso = /^[1-2]\d{3}-[0-1]\d-[0-3]\dT\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
      if (!['create', 'reconnect'].includes(asked.type) || !iso.test(asked.expiresOn ?? '') || !asked.api_url) return error(400, 'Invalid parameters', 'type, expiresOn and api_url are required', 'errors/invalid_parameters');
      if (asked.type === 'create' && !(asked.providers === '*' || (Array.isArray(asked.providers) && asked.providers.every(p => ['LINKEDIN', 'WHATSAPP', 'INSTAGRAM', 'MESSENGER', 'TELEGRAM', 'GOOGLE', 'OUTLOOK', 'TWITTER', 'MAIL'].includes(p))))) return error(400, 'Invalid parameters', 'providers', 'errors/invalid_parameters');
      if (asked.type === 'reconnect' && !asked.reconnect_account) return error(400, 'Invalid parameters', 'reconnect_account', 'errors/missing_parameters');
      fake.links.push(asked);
      return { body: { object: 'HostedAuthUrl', url: `https://account.unipile.com/fake-${fake.links.length}` } };
    }
    return error(404, 'Not Found', 'The requested resource were not found.', 'errors/resource_not_found');
  }
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://fake');
    fake.requests.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), key: req.headers['x-api-key'] });
    try {
      const out = await answer(req, url);
      if (out.raw) { res.writeHead(out.status ?? 200, { 'content-type': out.type, 'content-disposition': 'attachment; filename="file.pdf"' }); res.end(out.raw); return; }
      res.writeHead(out.status ?? 200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(out.body));
    } catch (err) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ title: 'Internal Server Error', detail: err.message, type: 'errors/unexpected_error', status: 500 }));
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  fake.origin = `http://127.0.0.1:${server.address().port}`;
  fake.close = () => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); };
  return fake;
}
