// Messages (system/inbox.mjs): the unified inbox on Unipile, against a fake
// Unipile that answers as its API reference says (fixtures/unipile.mjs). The
// key is a made-up one; nothing here reaches Unipile or sends anything real.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import { createGueyServer } from '../../../system/server.mjs';
import {
  MESSAGES_DRAFT_TOOL, MESSAGES_READ_TOOL, MESSAGES_SEARCH_TOOL, accountOf, createLocalInbox, credentialsFile, htmlText, parseKey, readKey,
  runMessagesDraft, runMessagesRead, runMessagesSearch, splitQuoted, unipile, unipileOrigin,
} from '../../../system/inbox.mjs';
import { TOOLS } from '../native/tools.mjs';
import { startFakeUnipile, unipileData } from './fixtures/unipile.mjs';

const KEY = 'unipile-SECRET-access-token-7f3a9c';

async function world(t, { maxPage, data, key = KEY, file = true } = {}) {
  const fake = await startFakeUnipile({ key: KEY, ...(maxPage ? { maxPage } : {}), ...(data ? { data } : {}) });
  const root = await mkdtemp(join(tmpdir(), 'inbox-'));
  t.after(async () => { await fake.close(); await rm(root, { recursive: true, force: true }); });
  const keyFile = join(root, 'credentials', 'unipile.json');
  await mkdir(join(root, 'credentials'));
  if (file) await writeFile(keyFile, JSON.stringify({ dsn: fake.origin, apiKey: key }), { mode: 0o600 });
  const told = [];
  const dir = join(root, 'state', 'inbox');
  const inbox = createLocalInbox({ keyFile, dir, tell: message => told.push(message) });
  return { fake, root, keyFile, dir, inbox, told };
}

const keys = answer => answer.conversations.map(c => c.key);

test('the key: unipile.json on this computer, its dsn an https address as the dashboard gives it', async t => {
  assert.equal(credentialsFile({ IMPERFECT_PREFIX: '/home/x/.imperfect' }), '/home/x/.imperfect/credentials/unipile.json');
  assert.equal(unipileOrigin('api8.unipile.com:13851'), 'https://api8.unipile.com:13851');
  assert.equal(unipileOrigin('https://api8.unipile.com:13851/api/v1/'), 'https://api8.unipile.com:13851');
  assert.equal(unipileOrigin('http://127.0.0.1:4000'), 'http://127.0.0.1:4000', 'plain http only to this computer');
  for (const bad of ['', 'http://api8.unipile.com:13851', 'https://me:pw@api8.unipile.com', 'https://api8.unipile.com/elsewhere', 'https://api8.unipile.com/?x=1']) {
    assert.throws(() => unipileOrigin(bad), /not an address like apiN\.unipile\.com:PORT/, bad);
  }
  const root = await mkdtemp(join(tmpdir(), 'inbox-key-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.equal(await readKey(join(root, 'none.json')), null, 'no file: no key yet');
  await writeFile(join(root, 'broken.json'), `{"apiKey": "${KEY}"`);
  await assert.rejects(readKey(join(root, 'broken.json')), error => /is not JSON/.test(error.message) && !error.message.includes(KEY));
  await writeFile(join(root, 'half.json'), JSON.stringify({ apiKey: KEY }));
  await assert.rejects(readKey(join(root, 'half.json')), error => /needs both "dsn" and "apiKey"/.test(error.message) && !error.message.includes(KEY));
  await writeFile(join(root, 'good.json'), JSON.stringify({ dsn: 'api8.unipile.com:13851', apiKey: ` ${KEY} ` }));
  assert.deepEqual(await readKey(join(root, 'good.json')), { origin: 'https://api8.unipile.com:13851', apiKey: KEY });
});

test('what the API says, as Messages says it: keys, accounts, HTML and quoted replies', () => {
  assert.deepEqual(parseKey('chat:acc_1:abc:def'), { kind: 'chat', account: 'acc_1', id: 'abc:def' });
  assert.deepEqual(parseKey('mail:acc_gmail_work:th_pilot'), { kind: 'mail', account: 'acc_gmail_work', id: 'th_pilot' });
  for (const bad of ['', 'chat:acc', 'sms:acc:1', 'chat:a/b:1', 'chat:acc:one\ntwo']) assert.throws(() => parseKey(bad), /its key is wrong/, JSON.stringify(bad));

  const [gmail, , linkedin, whatsapp, , calendar] = unipileData().accounts;
  assert.deepEqual(accountOf(gmail), { id: 'acc_gmail_home', source: 'gmail', label: 'Gmail', kind: 'mail', name: 'noah@fleming.example', handle: 'noah@fleming.example', status: 'ok' });
  assert.equal(accountOf(linkedin).source, 'linkedin');
  assert.equal(accountOf(whatsapp).handle, '+61400000001');
  assert.equal(accountOf(calendar), null, 'a calendar is not conversations');
  assert.equal(accountOf({ ...linkedin, sources: [{ id: 's', status: 'CREDENTIALS' }] }).status, 'credentials');

  assert.equal(htmlText('<html><head><style>p{color:red}</style><script>x()</script></head><body><p>One &amp; <b>two</b></p><ul><li>a</li><li>b</li></ul>3&nbsp;&lt;4&gt; &#8212; &#x2713;</body></html>'),
    'One & two\n• a\n• b\n3 <4> — ✓');
  assert.deepEqual(splitQuoted('Sounds good.\n\nOn Sun, 19 Oct 2026, Marcus wrote:\n> earlier'), { text: 'Sounds good.', quoted: 'On Sun, 19 Oct 2026, Marcus wrote:\n> earlier' });
  assert.deepEqual(splitQuoted('Thanks!\n\n> The 3rd works.\n> ok'), { text: 'Thanks!', quoted: '> The 3rd works.\n> ok' });
  assert.deepEqual(splitQuoted('> a quote I answer below\nmy answer'), { text: '> a quote I answer below\nmy answer', quoted: '' });
});

test('no key yet: Messages says how to get one, and nothing is asked of anyone', async t => {
  const w = await world(t, { file: false });
  const listed = await w.inbox.list();
  assert.equal(listed.state, 'no-key');
  assert.match(listed.message, /dashboard\.unipile\.com/);
  assert.ok(listed.message.includes(w.keyFile), 'the exact file to save');
  assert.deepEqual(listed.notYet.map(item => item.source), ['x'], 'X is said as not yet');
  await assert.rejects(w.inbox.connect({}), { status: 409 });
  assert.match(await runMessagesSearch({ query: 'pilot' }, { inbox: async () => w.inbox }), /no Unipile key yet/);
  assert.equal(w.fake.requests.length, 0);
});

test('the list: every account\'s conversations newest first, following Unipile\'s cursors, kept on this computer', async t => {
  const w = await world(t, { maxPage: 2 });
  const listed = await w.inbox.list();
  assert.equal(listed.state, 'ready');
  assert.deepEqual(listed.accounts.map(a => a.id), ['acc_gmail_home', 'acc_gmail_work', 'acc_linkedin', 'acc_whatsapp', 'acc_instagram'], 'six accounts over three pages, the calendar left out');
  assert.deepEqual(keys(listed), [
    'chat:acc_whatsapp:chat_mum', 'mail:acc_gmail_home:th_dinner', 'chat:acc_linkedin:chat_priya', 'mail:acc_gmail_work:th_pilot',
    'chat:acc_whatsapp:chat_climb', 'chat:acc_instagram:chat_jules', 'mail:acc_gmail_home:th_receipt', 'chat:acc_linkedin:chat_tom',
  ], 'archived chats and spam left out');
  const by = Object.fromEntries(listed.conversations.map(c => [c.key, c]));
  assert.equal(by['chat:acc_whatsapp:chat_mum'].name, 'Mum', 'a one-to-one chat named for the other person');
  assert.equal(by['chat:acc_whatsapp:chat_mum'].preview, 'Dad is doing the roast. Bring the good bread x');
  assert.equal(by['chat:acc_whatsapp:chat_mum'].unread, 2);
  assert.equal(by['chat:acc_whatsapp:chat_climb'].name, 'Thursday climbing');
  assert.equal(by['chat:acc_whatsapp:chat_climb'].group, true);
  assert.equal(by['mail:acc_gmail_home:th_dinner'].unread, 1, 'Gmail\'s UNREAD label');
  assert.equal(by['mail:acc_gmail_work:th_pilot'].name, 'Marcus Lee');
  assert.equal(by['mail:acc_gmail_work:th_pilot'].subject, 'Re: Pilot timeline');
  assert.equal(by['mail:acc_gmail_work:th_pilot'].preview, 'Perfect, thank you. Looking forward to it.', 'the quote left out');
  assert.equal(by['mail:acc_gmail_home:th_receipt'].preview, 'Your order #4471 is on its way. Track it online & enjoy.', 'HTML said as text');
  assert.ok(!keys(listed).some(key => /th_sale|th_done/.test(key)), 'Gmail\'s Promotions, and Primary mail archived out of the inbox, left out');
  assert.ok(w.fake.requests.some(r => r.path === '/api/v1/emails' && r.query.account_id === 'acc_gmail_home' && r.query.folder === 'CATEGORY_PERSONAL'), 'Gmail\'s Primary inbox');
  assert.ok(w.fake.requests.some(r => r.path === '/api/v1/emails' && r.query.account_id === 'acc_gmail_work' && r.query.folder === 'INBOX'), 'the inbox, where there is no Primary');
  assert.ok(w.fake.requests.some(r => r.path === '/api/v1/accounts' && r.query.cursor), 'the cursor followed');
  assert.ok(w.fake.requests.every(r => r.method === 'GET'), 'listing only reads');
  assert.ok(w.fake.requests.every(r => r.key === KEY));

  const asked = w.fake.requests.length;
  assert.deepEqual(keys(await w.inbox.list()), keys(listed));
  assert.equal(w.fake.requests.length, asked, 'kept for a minute, not asked again');

  const kept = await stat(join(w.dir, 'store.json'));
  assert.equal(kept.mode & 0o777, 0o600, 'only Noah reads it');
  const store = await readFile(join(w.dir, 'store.json'), 'utf8');
  assert.ok(store.includes('Bring the good bread'));
  assert.ok(!store.includes(KEY));
});

test('real mail as it comes: named characters said, invisible padding gone, the person\'s own reply newest, pictures kept a week', async t => {
  const data = unipileData();
  const [home] = [['Noah Fleming', 'noah@fleming.example']];
  const sale = data.emails.find(e => e.id === 'e1');
  // Noah answered the dinner email, from Gmail: the thread says so, and is read.
  data.emails.push({ ...sale, id: 'e8', date: new Date(Date.parse(sale.date) + 5 * 60_000).toISOString(), role: 'sent', folders: ['SENT'], from_attendee: { display_name: home[0], identifier: home[1] },
    to_attendees: [{ display_name: 'Ellie Fleming', identifier: 'ellie@fleming.example' }], subject: 'Re: Dinner Saturday?', body_plain: 'Yes&nbsp;please &mdash; 7 is perfect\u200b\u034f' });
  let clock = Date.parse('2026-10-19T09:30:00.000Z');
  const fake = await startFakeUnipile({ key: KEY, data });
  const root = await mkdtemp(join(tmpdir(), 'inbox-real-'));
  t.after(async () => { await fake.close(); await rm(root, { recursive: true, force: true }); });
  await writeFile(join(root, 'unipile.json'), JSON.stringify({ dsn: fake.origin, apiKey: KEY }));
  const told = [];
  const inbox = createLocalInbox({ keyFile: join(root, 'unipile.json'), dir: join(root, 'inbox'), now: () => clock, tell: m => told.push(m) });
  const listed = await inbox.list();
  const dinner = listed.conversations.find(c => c.key === 'mail:acc_gmail_home:th_dinner');
  assert.equal(dinner.preview, 'You: Yes please — 7 is perfect');
  assert.equal(dinner.unread, 0);
  assert.equal(htmlText('<p>Hello&shy; there&zwnj;&#8203;</p><p>&hellip; &rsquo;</p>'), 'Hello there\n… ’');

  // Priya's picture: asked of Unipile once, then kept; Tom has none, and that is kept too.
  const priya = listed.conversations.find(c => c.key === 'chat:acc_linkedin:chat_priya');
  assert.equal(priya.avatar, true);
  const picture = await inbox.avatar(priya.key);
  assert.equal(picture.type, 'image/jpeg');
  assert.equal(picture.bytes[0], 0xff);
  await inbox.avatar(priya.key);
  await assert.rejects(inbox.avatar('chat:acc_linkedin:chat_tom'), { status: 404 });
  await assert.rejects(inbox.avatar('chat:acc_linkedin:chat_tom'), { status: 404 });
  await assert.rejects(inbox.avatar('mail:acc_gmail_home:th_dinner'), { status: 404 }, 'an email has no picture');
  assert.equal(fake.requests.filter(r => r.path.endsWith('/picture')).length, 2, 'each asked once');
  assert.equal((await stat(join(root, 'inbox', 'avatars'))).mode & 0o777, 0o700);

  // A minute on, the list is answered at once from what was kept and asked for behind it; the windows are told.
  clock += 61_000;
  const asked = fake.requests.length;
  const again = await inbox.list();
  assert.deepEqual(keys(again), keys(listed), 'answered from what was kept');
  for (const until = Date.now() + 3000; !told.some(m => m.type === 'inbox-changed'); await new Promise(done => setTimeout(done, 10))) assert.ok(Date.now() < until, 'told when it was asked again');
  assert.ok(fake.requests.length > asked);
});

test('a chat, oldest first: who said what, attachments by name, earlier messages by cursor; reading clears unread here only', async t => {
  const w = await world(t, { maxPage: 2 });
  await w.inbox.list();
  const priya = await w.inbox.thread('chat:acc_linkedin:chat_priya', { seen: true });
  assert.equal(priya.title, 'Priya Shah');
  assert.deepEqual(priya.people, ['Priya Shah']);
  assert.deepEqual(priya.messages.map(m => [m.from, m.me]), [['You', true], ['Priya Shah', false]], 'a page of two, the newest');
  assert.ok(priya.cursor);
  const [file] = priya.messages[1].attachments;
  assert.deepEqual(file, { name: 'pilot-brief.pdf', type: 'file', size: 182044, href: '/inbox/attachment?key=chat%3Aacc_linkedin%3Achat_priya&message=m6&id=a6' });
  const earlier = await w.inbox.thread('chat:acc_linkedin:chat_priya', { cursor: priya.cursor });
  assert.deepEqual(earlier.messages.map(m => m.id), ['m4']);
  assert.equal(earlier.cursor, '');
  const climb = await w.inbox.thread('chat:acc_whatsapp:chat_climb');
  assert.deepEqual(climb.messages.map(m => m.id), ['m7'], 'a hidden event left out');
  assert.equal(climb.messages[0].from, 'Sam Okafor');

  const after = await w.inbox.list();
  assert.equal(after.conversations.find(c => c.key === 'chat:acc_linkedin:chat_priya').unread, 0);
  assert.equal(after.conversations.find(c => c.key === 'chat:acc_whatsapp:chat_mum').unread, 2, 'only what was read');
  assert.ok(w.fake.requests.every(r => r.method === 'GET'), 'nothing is marked read at the provider');
});

test('an email thread: every letter, quotes apart, and a reply goes to the last sender\'s Reply-To', async t => {
  const w = await world(t, { maxPage: 2 });
  await w.inbox.list();
  const pilot = await w.inbox.thread('mail:acc_gmail_work:th_pilot');
  assert.equal(pilot.title, 'Pilot timeline');
  assert.deepEqual(pilot.messages.map(m => m.id), ['e2', 'e3', 'e4'], 'all three, over two pages, sent mail too');
  assert.deepEqual(pilot.messages.map(m => m.from), ['Marcus Lee', 'You', 'Marcus Lee']);
  assert.equal(pilot.messages[1].text, 'The 3rd works. I will send the setup notes on Friday.');
  assert.match(pilot.messages[1].quoted, /^On Sun, 19 Oct 2026, Marcus Lee wrote:/);
  assert.deepEqual(pilot.messages[0].attachments.map(a => [a.name, a.href]), [['pilot-plan.pdf', '/inbox/attachment?key=mail%3Aacc_gmail_work%3Ath_pilot&message=e2&id=att-plan']]);
  assert.ok(!pilot.people.includes('Noah Fleming'), 'Noah is not among the people he writes to');
  assert.deepEqual(pilot.reply, { to: [{ name: 'Northwind Pilots', address: 'pilots@northwind.example' }], subject: 'Re: Pilot timeline', inReplyTo: 'e4' });
  const receipt = await w.inbox.thread('mail:acc_gmail_home:th_receipt');
  assert.equal(receipt.messages[0].text, 'Your order #4471 is on its way.\nTrack it online & enjoy.');
});

test('search: names and recent words here, email at Unipile; an account that does not answer is said', async t => {
  const w = await world(t);
  await w.inbox.list();
  assert.deepEqual(keys(await w.inbox.search('roast')), ['chat:acc_whatsapp:chat_mum']);
  assert.deepEqual(keys(await w.inbox.search('LUNCH sunday')), ['chat:acc_whatsapp:chat_mum'], 'an older message, from the newest messages kept');
  assert.deepEqual(keys(await w.inbox.search('priya')), ['chat:acc_linkedin:chat_priya']);
  const notes = await w.inbox.search('setup notes');
  assert.deepEqual(keys(notes), ['mail:acc_gmail_work:th_pilot'], 'found by Unipile in a sent email of the thread');
  assert.deepEqual((({ name, subject, match }) => ({ name, subject, match }))(notes.conversations[0]),
    { name: 'Marcus Lee', subject: 'Re: Pilot timeline', match: 'The 3rd works. I will send the setup notes on Friday.' }, 'the thread as listed, with the words found');
  assert.ok(w.fake.requests.some(r => r.path === '/api/v1/emails' && r.query.search === 'setup notes'));
  assert.deepEqual(keys(await w.inbox.search('', { source: 'whatsapp' })), ['chat:acc_whatsapp:chat_mum', 'chat:acc_whatsapp:chat_climb']);
  w.fake.failAccounts.add('acc_gmail_home');
  const partial = await w.inbox.search('pilot');
  assert.ok(keys(partial).includes('mail:acc_gmail_work:th_pilot'));
  assert.equal(partial.problems.length, 1);
  assert.match(partial.problems[0], /^noah@fleming\.example: Unipile answered 503 while searching noah@fleming\.example: Service Unavailable: Network is down/);
});

test('Send: a chat through its account, an email to the thread\'s Reply-To, and a second press is the first', async t => {
  const w = await world(t);
  await w.inbox.list();
  await w.inbox.draft({ key: 'chat:acc_linkedin:chat_priya', text: 'drafted', by: 'Claude' });
  const chat = await w.inbox.send({ key: 'chat:acc_linkedin:chat_priya', text: '  Thursday at 2 works.  ', nonce: 'press-0001' });
  assert.deepEqual(chat, { sent: true, id: 'sent1' });
  assert.deepEqual(await w.inbox.send({ key: 'chat:acc_linkedin:chat_priya', text: 'Thursday at 2 works.', nonce: 'press-0001' }), chat);
  assert.deepEqual(w.fake.sent, [{ kind: 'chat', chat: 'chat_priya', text: 'Thursday at 2 works.', account_id: 'acc_linkedin' }]);
  const listed = (await w.inbox.list()).conversations.find(c => c.key === 'chat:acc_linkedin:chat_priya');
  assert.equal(listed.preview, 'You: Thursday at 2 works.');
  assert.equal(listed.draft, false, 'the draft goes once sent');

  await w.inbox.send({ key: 'mail:acc_gmail_work:th_pilot', text: 'See you on the 3rd <then> & after.\nNoah', nonce: 'press-0002' });
  await w.inbox.send({ key: 'mail:acc_gmail_work:th_pilot', text: 'See you on the 3rd <then> & after.\nNoah', nonce: 'press-0002' });
  assert.equal(w.fake.sent.length, 2);
  assert.deepEqual(w.fake.sent[1], {
    kind: 'email', account_id: 'acc_gmail_work', to: [{ display_name: 'Northwind Pilots', identifier: 'pilots@northwind.example' }],
    subject: 'Re: Pilot timeline', body: '<div>See you on the 3rd &#60;then&#62; &#38; after.<br>Noah</div>', reply_to: 'e4', idempotency: 'press-0002',
  });
  await assert.rejects(w.inbox.send({ key: 'chat:acc_linkedin:chat_priya', text: '   ' }), { status: 400 });
  await assert.rejects(w.inbox.send({ key: 'chat:acc_gone:chat_x', text: 'hi' }), { status: 404 });
  assert.equal(w.fake.sent.length, 2);
});

test('Connect: Unipile\'s sign-in page for Noah\'s four, for one service, or again for one account; X is not yet', async t => {
  const w = await world(t);
  const before = Date.now();
  assert.deepEqual(await w.inbox.connect({}), { url: 'https://account.unipile.com/fake-1' });
  const [link] = w.fake.links;
  assert.equal(link.type, 'create');
  assert.deepEqual(link.providers, ['GOOGLE', 'WHATSAPP', 'LINKEDIN', 'INSTAGRAM']);
  assert.equal(link.api_url, w.fake.origin);
  const expires = Date.parse(link.expiresOn);
  assert.ok(expires >= before + 59 * 60_000 && expires <= Date.now() + 61 * 60_000, 'an hour to sign in');
  await w.inbox.connect({ provider: 'gmail' });
  assert.deepEqual(w.fake.links[1].providers, ['GOOGLE']);
  await w.inbox.connect({ reconnect: 'acc_linkedin' });
  assert.equal(w.fake.links[2].type, 'reconnect');
  assert.equal(w.fake.links[2].reconnect_account, 'acc_linkedin');
  await assert.rejects(w.inbox.connect({ provider: 'x' }), /Not yet: Unipile no longer maintains X/);
  await assert.rejects(w.inbox.connect({ provider: 'myspace' }), { status: 400 });
  assert.equal(w.fake.links.length, 3);
});

test('a key Unipile refuses is said plainly, and the key itself is never said, kept or answered', async t => {
  const w = await world(t, { key: 'not-the-right-key-0000' });
  const listed = await w.inbox.list();
  assert.equal(listed.state, 'error');
  assert.match(listed.message, /Unipile did not accept the key \(401\)/);
  assert.ok(!JSON.stringify(listed).includes('not-the-right-key-0000'));

  const right = await world(t);
  const said = [];
  said.push(await right.inbox.list(), await right.inbox.thread('chat:acc_linkedin:chat_priya', { seen: true }), await right.inbox.thread('mail:acc_gmail_work:th_pilot'));
  said.push(await right.inbox.search('pilot'), await right.inbox.connect({}), await right.inbox.draft({ key: 'chat:acc_whatsapp:chat_mum', text: 'See you Sunday', by: 'Pi' }));
  said.push(await runMessagesSearch({ query: '' }, { inbox: async () => right.inbox }), await runMessagesRead({ key: 'mail:acc_gmail_work:th_pilot' }, { inbox: async () => right.inbox }));
  right.fake.failAccounts.add('acc_gmail_work');
  said.push(await right.inbox.thread('mail:acc_gmail_work:th_pilot').catch(error => ({ error: error.message })));
  said.push(right.told);
  for (const thing of said) assert.ok(!JSON.stringify(thing).includes(KEY), JSON.stringify(thing).slice(0, 200));
  assert.ok(!(await readFile(join(right.dir, 'store.json'), 'utf8')).includes(KEY));
});

test('the agents\' tools: search, read and draft, and none of them sends', async t => {
  const names = TOOLS.map(([tool]) => tool.name);
  for (const [tool, run] of [[MESSAGES_SEARCH_TOOL, runMessagesSearch], [MESSAGES_READ_TOOL, runMessagesRead], [MESSAGES_DRAFT_TOOL, runMessagesDraft]]) {
    assert.ok(TOOLS.some(([t, r]) => t === tool && r === run), tool.name);
  }
  assert.ok(!names.some(name => /messag|inbox|mail|dm/i.test(name) && /send|reply|post/i.test(name)), 'no tool sends a message');
  assert.match(MESSAGES_DRAFT_TOOL.description, /It never sends/);
  assert.match(MESSAGES_DRAFT_TOOL.description, /press Send himself|Noah's rule is to ask before anything is sent/);

  const w = await world(t);
  const inbox = async () => w.inbox;
  const found = await runMessagesSearch({ query: 'pilot' }, { inbox });
  assert.match(found, /conversations? holding "pilot":/);
  assert.match(found, /Gmail \(noah@imperfect\.example\) · Marcus Lee · Re: Pilot timeline/);
  assert.match(found, /key: mail:acc_gmail_work:th_pilot/);
  assert.match(found, /key: chat:acc_linkedin:chat_priya/);
  const read = await runMessagesRead({ key: 'chat:acc_linkedin:chat_priya' }, { inbox });
  assert.match(read, /^LinkedIn \(Noah Fleming\) · Priya Shah\nwith Priya Shah/);
  assert.match(read, /Priya Shah: Thursday 2pm works\. I have attached the brief so you can see what we are after\.\n {3}\[attached: pilot-brief\.pdf\]/);
  const mail = await runMessagesRead({ key: 'mail:acc_gmail_work:th_pilot' }, { inbox });
  assert.match(mail, /A reply would go to pilots@northwind\.example as "Re: Pilot timeline"\./);
  assert.match(mail, /\[quoted earlier messages left out\]/);
  assert.equal((await w.inbox.list()).conversations.find(c => c.key === 'chat:acc_linkedin:chat_priya').unread, 1, 'an agent reading is not Noah reading');

  const drafted = await runMessagesDraft({ key: 'chat:acc_linkedin:chat_priya', text: 'Thursday at 2 works. Talk then.', harness: 'claude' }, { inbox });
  assert.match(drafted, /^Drafted into the composer of "Priya Shah" in Messages\. Nothing was sent/);
  assert.deepEqual(w.told.map(({ type, key, text, by }) => ({ type, key, text, by })), [{ type: 'inbox-draft', key: 'chat:acc_linkedin:chat_priya', text: 'Thursday at 2 works. Talk then.', by: 'Claude' }]);
  assert.equal((await w.inbox.thread('chat:acc_linkedin:chat_priya')).draft.text, 'Thursday at 2 works. Talk then.');
  assert.match(await runMessagesRead({ key: 'chat:acc_linkedin:chat_priya' }, { inbox }), /A draft is waiting in the composer \(Claude\)/);
  await assert.rejects(runMessagesDraft({ key: 'chat:acc_linkedin:chat_priya', text: '  ' }, { inbox }), /needs its words/);
  await assert.rejects(runMessagesDraft({ key: 'nonsense', text: 'hi' }, { inbox }), /its key is wrong/);
  assert.deepEqual(w.fake.sent, []);
  assert.ok(w.fake.requests.every(r => r.method === 'GET'), 'the tools only ever read from Unipile');
});

/* ------------------------------------------------- through imperfect's server */

const runtime = name => ({
  events: new EventEmitter(), command: async () => ({}), close: async () => {},
  snapshot: () => ({ sessionId: `${name}-session`, cwd: '/', busy: false, failed: null, messages: [], tabs: [{ id: 't', sessionId: `${name}-session`, focused: true }] }),
});

// Two computers, the PC keeping Messages: each one's server, as imperfect runs it.
async function computers(t, { laptopKey = true } = {}) {
  const fake = await startFakeUnipile({ key: KEY });
  const root = await mkdtemp(join(tmpdir(), 'inbox-computers-'));
  const urls = {}, apps = {}, online = { pc: true, laptop: true };
  t.after(async () => {
    for (const app of Object.values(apps)) await app.close();
    await fake.close();
    await rm(root, { recursive: true, force: true });
  });
  const names = ['pc', 'laptop'];
  for (const id of names) {
    const other = names.find(name => name !== id);
    await mkdir(join(root, id, 'credentials'), { recursive: true });
    const keyFile = join(root, id, 'credentials', 'unipile.json');
    // The laptop is given a key of its own, to show it is never the one used.
    if (id === 'pc') await writeFile(keyFile, JSON.stringify({ dsn: fake.origin, apiKey: KEY }));
    else if (laptopKey) await writeFile(keyFile, JSON.stringify({ dsn: fake.origin, apiKey: 'the-laptops-own-key' }));
    const machines = {
      self: async () => id, selfId: async () => id, origins: async () => [], published: async () => '',
      list: async () => [{ id, name: id, url: urls[id], self: true, reachable: true }, { id: other, name: other === 'pc' ? 'desktop' : other, url: urls[other], self: false, reachable: online[other] }],
      peer: async asked => (asked === other && online[other] ? { id: other, name: other === 'pc' ? 'desktop' : other, url: urls[other] } : null),
    };
    apps[id] = await createGueyServer({
      stateDir: join(root, id, 'state'), runtime: runtime(id), machines, sessionToken: `${id}-token`,
      authority: { id: 'pc', name: 'desktop' }, identityOptions: { status: async () => ({ Self: { StableID: id } }) },
      inbox: { keyFile },
    });
    urls[id] = `http://127.0.0.1:${(await apps[id].listen()).port}`;
  }
  const page = (id, path, { body, headers = {} } = {}) => fetch(`${urls[id]}${path}`, body === undefined
    ? { headers: { origin: urls[id], ...headers } }
    : { method: 'POST', headers: { origin: urls[id], 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  return { fake, root, urls, apps, online, page };
}

test('the route: read only from imperfect\'s own pages; an action needs the page\'s exact origin; drafts reach every window', async t => {
  const c = await computers(t);
  const listed = await (await c.page('pc', '/inbox/list')).json();
  assert.equal(listed.state, 'ready');
  assert.equal(listed.conversations.length, 8);
  assert.equal((await c.page('pc', '/inbox/list', { headers: { 'sec-fetch-site': 'cross-site' } })).status, 403);
  assert.equal((await c.page('pc', '/inbox/list', { headers: { 'sec-fetch-site': 'same-site' } })).status, 403);
  assert.equal((await c.page('pc', '/inbox/send')).status, 405, 'Send is never a GET');
  assert.equal((await c.page('pc', '/inbox/list', { body: {} })).status, 405);
  const bare = await fetch(`${c.urls.pc}/inbox/send`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key: 'chat:acc_linkedin:chat_priya', text: 'hi' }) });
  assert.equal(bare.status, 403, 'no origin, no Send');
  const foreign = await c.page('pc', '/inbox/send', { body: { key: 'chat:acc_linkedin:chat_priya', text: 'hi' }, headers: { origin: 'https://evil.example' } });
  assert.equal(foreign.status, 403);
  assert.deepEqual(c.fake.sent, []);

  const ws = new WebSocket(`${c.urls.pc.replace(/^http/, 'ws')}/pi`);
  const heard = [];
  ws.on('message', raw => heard.push(JSON.parse(raw)));
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  t.after(() => ws.terminate());
  const drafted = await c.page('pc', '/inbox/draft', { body: { key: 'chat:acc_linkedin:chat_priya', text: 'Talk Thursday.', by: 'Codex' } });
  assert.equal(drafted.status, 200);
  for (const until = Date.now() + 3000; !heard.some(m => m.type === 'inbox-changed'); await new Promise(done => setTimeout(done, 10))) assert.ok(Date.now() < until, 'the window heard the invalidation');
  assert.deepEqual(heard.find(m => m.type === 'inbox-changed'), { type: 'inbox-changed' });
  assert.ok(!heard.some(m => m.type === 'inbox-draft'), 'no draft words or keys on the general session socket');
  assert.doesNotMatch(JSON.stringify(heard), /Talk Thursday/);
  assert.deepEqual(c.fake.sent, [], 'a draft is not sent');

  const file = await c.page('pc', '/inbox/attachment?key=chat%3Aacc_linkedin%3Achat_priya&message=m6&id=a6');
  assert.equal(file.status, 200);
  assert.equal(file.headers.get('content-type'), 'application/pdf');
  assert.equal(file.headers.get('cache-control'), 'no-store');
  assert.equal(file.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(file.headers.get('content-security-policy'), "default-src 'none'; sandbox");
  assert.equal(await file.text(), '%PDF-1.4 fake a6');
  assert.equal((await c.page('pc', '/inbox/attachment?key=chat%3Aacc_linkedin%3Achat_priya&message=m6&id=nope')).status, 404);

  const sent = await c.page('pc', '/inbox/send', { body: { key: 'chat:acc_linkedin:chat_priya', text: 'Talk Thursday.', nonce: 'press-route-1' } });
  assert.deepEqual(await sent.json(), { sent: true, id: 'sent1' });
  assert.equal(c.fake.sent.length, 1, 'only the person\'s own Send, from the page');
});

test('another computer asks the PC for Messages: the PC\'s key, the PC\'s store, and the PC away is said', async t => {
  const c = await computers(t);
  const listed = await (await c.page('laptop', '/inbox/list')).json();
  assert.equal(listed.state, 'ready');
  assert.equal(listed.conversations[0].key, 'chat:acc_whatsapp:chat_mum');
  const thread = await (await c.page('laptop', '/inbox/thread?key=mail%3Aacc_gmail_work%3Ath_pilot')).json();
  assert.deepEqual(thread.messages.map(m => m.id), ['e2', 'e3', 'e4']);
  const found = await (await c.page('laptop', '/inbox/search?q=roast')).json();
  assert.deepEqual(keys(found), ['chat:acc_whatsapp:chat_mum']);

  // An agent on the laptop drafts; the PC keeps it, and the laptop's windows hear it.
  const drafted = await runMessagesDraft({ key: 'chat:acc_whatsapp:chat_mum', text: 'Bringing the bread.', harness: 'pi' });
  assert.match(drafted, /^Drafted into the composer of "Mum"/);
  const onPc = await (await c.page('pc', '/inbox/thread?key=chat%3Aacc_whatsapp%3Achat_mum')).json();
  assert.deepEqual((({ text, by }) => ({ text, by }))(onPc.draft), { text: 'Bringing the bread.', by: 'Pi' });
  assert.match(await runMessagesSearch({ query: 'bread' }), /key: chat:acc_whatsapp:chat_mum/);

  // Through /peer/, a page's origin is dropped, so nothing is sent that way.
  const relayed = await fetch(`${c.urls.laptop}/peer/pc/inbox/send`, { method: 'POST', headers: { origin: c.urls.laptop, 'content-type': 'application/json' }, body: JSON.stringify({ key: 'chat:acc_whatsapp:chat_mum', text: 'hi' }) });
  assert.equal(relayed.status, 403);
  assert.equal((await fetch(`${c.urls.laptop}/peer/pc/inbox/list`, { headers: { origin: c.urls.laptop, 'sec-fetch-site': 'cross-site' } })).status, 403);
  assert.deepEqual(c.fake.sent, []);

  // The person's Send on the laptop goes once, through the PC.
  const sent = await c.page('laptop', '/inbox/send', { body: { key: 'chat:acc_whatsapp:chat_mum', text: 'Bringing the bread.', nonce: 'press-laptop-1' } });
  assert.equal(sent.status, 200);
  assert.deepEqual(c.fake.sent, [{ kind: 'chat', chat: 'chat_mum', text: 'Bringing the bread.', account_id: 'acc_whatsapp' }]);

  assert.ok(c.fake.requests.length > 0);
  assert.ok(c.fake.requests.every(r => r.key === KEY), 'only the PC\'s key ever reached Unipile');
  await assert.rejects(stat(join(c.root, 'laptop', 'state', 'inbox', 'store.json')), { code: 'ENOENT' }, 'nothing of Messages is kept on the laptop');
  assert.ok((await stat(join(c.root, 'pc', 'state', 'inbox', 'store.json'))).isFile());

  c.online.pc = false;
  const away = await c.page('laptop', '/inbox/list');
  assert.equal(away.status, 503);
  assert.match((await away.json()).error, /^Messages are kept on desktop, and this computer cannot reach it right now/);
  await assert.rejects(runMessagesSearch({ query: 'bread' }), /Messages are kept on desktop/);
});


test('Unipile failures never echo a credential from an upstream or transport error', async () => {
  const key = { origin: 'https://api.example', apiKey: KEY };
  const upstream = unipile(key, { send: async () => new Response(JSON.stringify({ title: 'Refused', detail: KEY }), { status: 403 }) });
  await assert.rejects(upstream.get('/accounts'), error => error.status === 403 && !error.message.includes(KEY));
  const escaped = JSON.stringify({ detail: KEY, type: KEY }).replaceAll('u', '\\u0075');
  const encoded = unipile(key, { send: async () => new Response(escaped, { status: 403 }) });
  await assert.rejects(encoded.get('/accounts'), error => !error.message.includes(KEY) && !error.type.includes(KEY));
  const raw = unipile(key, { send: async () => new Response(`private diagnostic ${KEY}`, { status: 500 }) });
  await assert.rejects(raw.get('/accounts'), error => !error.message.includes('private diagnostic') && !error.message.includes(KEY));
  const transport = unipile(key, { send: async () => { throw new Error(`request ${KEY}`); } });
  await assert.rejects(transport.get('/accounts'), error => error.status === 502 && !error.message.includes(KEY));
});
