// Messages: the person's conversations -- Gmail, WhatsApp, LinkedIn,
// Instagram -- in one list, newest first, beside the agents: the newest in
// the sidebar after Sites, and the whole of it in the panel beside the
// session (the focus layout's floating panel, where Files and the browser
// are; harness.js). What it shows comes from this computer's /inbox/,
// which the PC answers (system/inbox.mjs), or the demo inbox on a computer
// that is not the person's own.
//
// The list has each conversation's picture or initials with its service's
// mark, who, a line of what was said and when; the bar searches, the chips
// under it keep one service. A conversation opens over the list (beside
// it, where there is room): a chat's messages as bubbles, an email thread
// as its letters, in plain text, attachments by name. Under it, the
// composer. Only the person's own press of Send sends anything; an agent's
// draft (messages_draft) lands in the composer, marked as theirs, and waits.
//
// Everything said by others is set as text, never as markup.
//
//   const messages = mountMessages({ openLink, onChange, showing });   openLink(url, { signIn })
//   messages.el                 the window's body
//   messages.open({ source, account, key })   messages.back()   messages.keys()
//   messages.sidebar({ row, head, active, open })   the sidebar's Messages section
//   messages.sidebarLook()      what the sidebar shows, to know when to draw it again
//   messages.drafted(message)   an agent's draft arrived
//   messages.changed()          the PC's list changed
//   messages.seen()             the window came into view

const ICONS = {
  all: '<path d="M3.5 13.5 6 5.5h12l2.5 8v5h-17z"/><path d="M3.5 13.5h5l1 2h5l1-2h5"/>',
  mail: '<rect x="3.5" y="5.5" width="17" height="13" rx="1.5"/><path d="m4 7 8 6 8-6"/>',
  whatsapp: '<path d="M4.6 19.4 5.7 16A8 8 0 1 1 8.2 18.4z"/><path d="M9.2 8.6c.2 2.6 3.4 5.9 6.2 6.2l.9-1.4-1.8-.9-.8.8c-1-.4-2.6-2-3-3l.8-.8-.9-1.8z"/>',
  linkedin: '<rect x="3.5" y="3.5" width="17" height="17" rx="2.5"/><path d="M8 10.5v6M8 7.5v.1M11.5 16.5v-6M11.5 13c0-1.6 1-2.6 2.4-2.6s2.1.9 2.1 2.6v3.5"/>',
  instagram: '<rect x="3.5" y="3.5" width="17" height="17" rx="5"/><circle cx="12" cy="12" r="3.8"/><path d="M16.8 7.2v.1"/>',
  telegram: '<path d="M20.5 4.5 3.5 11l6 2.2 2 6.3 3-4 4.6 3.4z"/><path d="m9.5 13.2 6-5"/>',
  messenger: '<path d="M12 3.5c-4.8 0-8.5 3.5-8.5 8 0 2.5 1.2 4.7 3 6.1v2.9l2.8-1.5c.9.3 1.8.4 2.7.4 4.8 0 8.5-3.5 8.5-7.9S16.8 3.5 12 3.5z"/>',
  x: '<path d="M5 5l14 14M19 5 5 19"/>',
  plus: '<path d="M12 6v12M6 12h12"/>',
  search: '<circle cx="10.5" cy="10.5" r="6"/><path d="m15 15 5 5"/>',
  refresh: '<path d="M19 12a7 7 0 1 1-2.1-5"/><path d="M19 4.5V8h-3.5"/>',
  back: '<path d="M15 5l-7 7 7 7"/>',
  clip: '<path d="M8.5 12.5 14 7a2.8 2.8 0 0 1 4 4l-7.2 7.2a4.5 4.5 0 0 1-6.4-6.4L11 5.2"/>',
};
const SOURCE = {
  gmail: { label: 'Gmail', icon: 'mail', connect: true },
  whatsapp: { label: 'WhatsApp', icon: 'whatsapp', connect: true },
  linkedin: { label: 'LinkedIn', icon: 'linkedin', connect: true },
  instagram: { label: 'Instagram', icon: 'instagram', connect: true },
  outlook: { label: 'Outlook', icon: 'mail', connect: true },
  telegram: { label: 'Telegram', icon: 'telegram', connect: true },
  mail: { label: 'Email', icon: 'mail', connect: true },
  icloud: { label: 'iCloud Mail', icon: 'mail' },
  exchange: { label: 'Exchange', icon: 'mail' },
  messenger: { label: 'Messenger', icon: 'messenger' },
  slack: { label: 'Slack', icon: 'messenger' },
  x: { label: 'X', icon: 'x' },
};
// The four Noah connects first, then the others Unipile offers.
const CONNECT_ORDER = ['gmail', 'whatsapp', 'linkedin', 'instagram', 'outlook', 'telegram', 'mail'];
// How many of the newest conversations the sidebar lists.
const SIDEBAR_MOST = 3;

const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
};
const button = (className, text, label) => {
  const node = el('button', className, text);
  node.type = 'button';
  if (label) { node.setAttribute('aria-label', label); node.title = label; }
  return node;
};
export function icon(name, className = 'messages-icon') {
  const holder = el('span', className);
  holder.innerHTML = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${ICONS[name] ?? ICONS.all}</svg>`;
  return holder;
}
// A service's mark, in its theme colour (messages.css).
export function badge(source) {
  const mark = icon(SOURCE[source]?.icon ?? 'all', 'messages-badge');
  mark.dataset.source = source;
  mark.title = SOURCE[source]?.label ?? source;
  return mark;
}

// Who a conversation is with: their picture where the service has one (the
// PC asks Unipile for it), else their initials on a colour of their own,
// with the service's mark at its corner.
const HUES = ['red', 'orange', 'yellow', 'green', 'cyan', 'blue', 'magenta'];
export function initials(name) {
  // An address with no name: its first letter.
  if (/^\S+@\S+$/.test(String(name ?? '').trim())) return String(name).trim()[0].toUpperCase();
  const words = String(name ?? '').replace(/[^\p{L}\p{N}\s'-]/gu, ' ').split(/[\s-]+/).filter(word => /[\p{L}\p{N}]/u.test(word));
  return ((words[0]?.[0] ?? '') + (words.length > 1 ? words.at(-1)[0] : words[0]?.[1] ?? '')).toUpperCase() || '·';
}
export function avatar(conversation, { mark = true } = {}) {
  const box = el('span', 'messages-avatar');
  let hash = 0;
  for (const char of String(conversation.name ?? '')) hash = (hash * 31 + char.codePointAt(0)) >>> 0;
  box.dataset.hue = HUES[hash % HUES.length];
  box.append(el('span', 'messages-avatar-initials', initials(conversation.name)));
  if (conversation.avatar && conversation.key) {
    const img = el('img', 'messages-avatar-picture');
    img.alt = ''; img.decoding = 'async'; img.loading = 'lazy'; img.draggable = false;
    img.onload = () => box.classList.add('pictured');
    img.onerror = () => img.remove();
    img.src = `/inbox/avatar?${new URLSearchParams({ key: conversation.key })}`;
    box.append(img);
  }
  if (mark) box.append(badge(conversation.source));
  return box;
}

const sameDay = (a, b) => a.toDateString() === b.toDateString();
export function shortTime(at, now = new Date()) {
  if (!at) return '';
  const date = new Date(at);
  if (sameDay(date, now)) return date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  const yesterday = new Date(now); yesterday.setDate(now.getDate() - 1);
  if (sameDay(date, yesterday)) return 'Yesterday';
  if (now - date < 6 * 86400_000) return date.toLocaleDateString(undefined, { weekday: 'short' });
  return date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', ...(date.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }) });
}
const dayLabel = at => {
  const date = new Date(at), now = new Date();
  if (sameDay(date, now)) return 'Today';
  const yesterday = new Date(now); yesterday.setDate(now.getDate() - 1);
  if (sameDay(date, yesterday)) return 'Yesterday';
  return date.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' });
};
const clock = at => new Date(at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
const size = bytes => (!bytes ? '' : bytes < 1000 ? `${bytes} bytes` : bytes < 1e6 ? `${Math.round(bytes / 1000)} kB` : `${(bytes / 1e6).toFixed(1)} MB`);
const nonce = () => (crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`);

async function ask(path, { method = 'GET', body, signal } = {}) {
  const res = await fetch(path, { method, cache: 'no-store', signal, ...(body ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}) });
  let answer = {};
  try { answer = await res.json(); } catch { answer = { error: `${res.status} ${res.statusText}`.trim() }; }
  if (!res.ok) throw Object.assign(new Error(answer.error || `Messages answered ${res.status}`), { status: res.status, missing: answer.missing });
  return answer;
}

export function mountMessages({ openLink: launchLink = () => { throw new Error('imperfect’s browser is unavailable'); }, onChange = () => {}, showing = () => true } = {}) {
  const doc = document;
  if (!doc.querySelector('link[data-messages-style]')) {
    const link = doc.createElement('link');
    link.rel = 'stylesheet';
    link.href = new URL('../css/messages.css', import.meta.url).href;
    link.dataset.messagesStyle = '';
    doc.head.append(link);
  }
  const root = el('section', 'messages');
  root.tabIndex = -1;
  root.setAttribute('aria-label', 'Messages');
  root.dataset.view = 'list';

  // The bar: the title, search, refresh and connect.
  const bar = el('header', 'messages-bar');
  const title = el('h2', 'messages-title', 'Messages');
  const demoTag = el('span', 'messages-demo-tag', 'Demo');
  demoTag.title = 'A demo inbox: invented conversations. Nothing is sent from here.';
  demoTag.hidden = true;
  title.append(demoTag);
  const searchBox = el('label', 'messages-search');
  const searchInput = el('input');
  searchInput.type = 'search'; searchInput.placeholder = 'Search'; searchInput.spellcheck = false; searchInput.autocomplete = 'off';
  searchInput.setAttribute('aria-label', 'Search messages');
  searchBox.append(icon('search'), searchInput);
  const refreshButton = button('messages-tool', null, 'Refresh');
  refreshButton.append(icon('refresh'));
  const connectButton = button('messages-tool', null, 'Connect an account');
  connectButton.append(icon('plus'));
  bar.append(title, searchBox, refreshButton, connectButton);

  const filters = el('nav', 'messages-filters');
  filters.setAttribute('aria-label', 'Show');
  const note = el('p', 'messages-note');
  note.setAttribute('role', 'status');
  note.hidden = true;

  const body = el('div', 'messages-body');
  const listPane = el('div', 'messages-list-pane');
  const list = el('div', 'messages-list');
  list.tabIndex = -1;
  list.setAttribute('role', 'listbox');
  list.setAttribute('aria-label', 'Conversations');
  const empty = el('div', 'messages-empty');
  empty.hidden = true;
  listPane.append(note, list, empty);

  const thread = el('section', 'messages-thread');
  thread.setAttribute('aria-label', 'Conversation');
  const threadHead = el('header', 'messages-thread-head');
  const backButton = button('messages-tool messages-back', null, 'Back to the list');
  backButton.append(icon('back'));
  const threadTitle = el('div', 'messages-thread-title');
  threadHead.append(backButton, threadTitle);
  const scroll = el('div', 'messages-scroll');
  const composer = el('form', 'messages-composer');
  composer.noValidate = true;
  const replyTo = el('p', 'messages-reply-to');
  const drafted = el('p', 'messages-drafted');
  drafted.hidden = true;
  const field = el('textarea', 'messages-field');
  field.rows = 1;
  field.setAttribute('aria-label', 'Reply');
  const sendButton = el('button', 'look-button primary messages-send', 'Send');
  sendButton.type = 'submit';
  const sendRow = el('div', 'messages-send-row');
  const said = el('span', 'messages-said');
  said.setAttribute('role', 'status');
  sendRow.append(said, sendButton);
  composer.append(replyTo, drafted, field, sendRow);
  const pick = el('div', 'messages-pick', 'Choose a conversation');
  thread.append(threadHead, scroll, composer, pick);

  // Connect: the services, each to Unipile's own sign-in page in the browser.
  const connectSheet = el('div', 'messages-connect');
  connectSheet.hidden = true;
  connectSheet.setAttribute('role', 'dialog');
  connectSheet.setAttribute('aria-label', 'Connect an account');

  body.append(listPane, thread);
  root.append(bar, filters, body, connectSheet);

  let data = { state: 'loading', accounts: [], conversations: [] };
  let results = null; // a search's conversations, while there are words in the box
  let filter = { source: '', account: '' };
  let current = null; // the conversation open: { key, thread?, loading, error }
  let loading = null, polling = null, connectWatch = null, searchTimer = null, searchTurn = 0, threadTurn = 0;
  let sending = false, draftShown = null, lastError = '';

  const accountOf = id => data.accounts.find(account => account.id === id);
  const several = source => data.accounts.filter(account => account.source === source).length > 1;
  const accountName = account => (account ? (several(account.source) ? account.name : account.label) : '');

  async function openLink(url, options) {
    try { await launchLink(url, options); return true; }
    catch {
      note.hidden = false;
      note.replaceChildren(el('span', 'messages-note-line', 'The browser could not be opened. Try again from imperfect’s browser.'));
      return false;
    }
  }

  /* ---- loading ---- */
  async function load({ refresh = false } = {}) {
    if (loading) return loading;
    const turn = loading = (async () => {
      try {
        const answer = await ask(`/inbox/list${refresh ? '?refresh=1' : ''}`);
        // Revocation replaces the whole inbox, not just its list. Do not keep
        // real words, search results or typed replies behind the demo screen.
        if (Boolean(data.demo) !== Boolean(answer.demo)) forgetInbox();
        data = answer;
        lastError = '';
      } catch (error) {
        lastError = error.message;
        if (error.status === 403) {
          forgetInbox();
          data = { state: 'unreachable', message: error.message, accounts: [], conversations: [] };
        } else if (data.state === 'loading') data = { state: 'unreachable', message: error.message, accounts: [], conversations: [] };
      }
      paint();
      onChange();
    })().finally(() => { if (loading === turn) loading = null; });
    return turn;
  }
  function forgetInbox() {
    current = null; results = null; filter = { source: '', account: '' };
    threadTurn++; searchTurn++; clearTimeout(searchTimer);
    typed.clear(); field.value = ''; delete field.dataset.draft;
    drafted.hidden = true; drafted.replaceChildren(); draftShown = null;
    said.textContent = ''; replyTo.textContent = ''; replyTo.title = '';
    threadTitle.replaceChildren(); scroll.replaceChildren(); delete scroll.dataset.key;
    searchInput.value = ''; connectSheet.hidden = true; connectSheet.replaceChildren();
    clearInterval(connectWatch);
  }
  // While the window can be seen, every minute; else every five, for the sidebar's counts.
  function schedule() {
    clearTimeout(polling);
    polling = setTimeout(() => { if (!document.hidden) void load(); schedule(); }, showing() ? 60_000 : 300_000);
  }

  /* ---- the list ---- */
  const shown = () => (results ?? data.conversations ?? []).filter(c => (!filter.source || c.source === filter.source) && (!filter.account || c.account === filter.account));
  function paintFilters() {
    const sources = [...new Set(data.accounts.map(account => account.source))];
    const nodes = sources.map(source => {
      const label = SOURCE[source]?.label ?? source;
      const account = filter.account && accountOf(filter.account);
      const chip = button('messages-chip', account && account.source === source ? accountName(account) : label);
      const on = filter.source === source && (!filter.account || (account && account.source === source));
      chip.setAttribute('aria-pressed', String(on));
      chip.prepend(badge(source));
      chip.onclick = () => { filter = { source: on ? '' : source, account: '' }; paint(); onChange(); };
      return chip;
    });
    filters.replaceChildren(...nodes);
    filters.hidden = data.state !== 'ready' || sources.length < 2;
    // Nothing to search, or no key to connect with: the bar says only Messages.
    searchBox.hidden = !searchInput.value && !(data.state === 'ready' && data.conversations.length);
    connectButton.hidden = data.state === 'no-key' || Boolean(data.demo) || data.canConnect === false;
    demoTag.hidden = !data.demo;
    root.classList.toggle('demo', Boolean(data.demo));
  }
  function row(conversation) {
    const item = button('messages-row');
    item.setAttribute('role', 'option');
    item.dataset.key = conversation.key;
    item.setAttribute('aria-selected', String(current?.key === conversation.key));
    if (conversation.unread) item.classList.add('unread');
    const main = el('span', 'messages-row-main');
    const top = el('span', 'messages-row-top');
    const account = accountOf(conversation.account);
    top.append(el('span', 'messages-row-name', conversation.name || 'Unknown'), el('time', 'messages-row-time', shortTime(conversation.at)));
    const sub = el('span', 'messages-row-sub');
    if (conversation.draft) sub.append(el('span', 'messages-row-draft', 'Draft'));
    if (conversation.subject && conversation.kind !== 'chat') sub.append(el('span', 'messages-row-subject', conversation.subject));
    sub.append(el('span', 'messages-row-preview', conversation.match || conversation.preview || ''));
    // Unread under the time, as a dot or how many, so the times keep one edge.
    const next = el('span', 'messages-row-next');
    next.append(sub);
    if (conversation.unread) next.append(el('span', 'messages-row-unread', conversation.unread > 1 ? String(Math.min(conversation.unread, 99)) : ''));
    main.append(top, next);
    if (several(conversation.source) && !filter.account) main.append(el('span', 'messages-row-account', account?.name ?? ''));
    item.append(avatar(conversation), main);
    item.title = `${SOURCE[conversation.source]?.label ?? ''}${account ? ` · ${account.name}` : ''}`;
    item.onclick = () => select(conversation.key);
    return item;
  }
  function emptyState() {
    const parts = [];
    const heading = text => el('h3', 'messages-empty-title', text);
    const line = text => el('p', 'messages-empty-line', text);
    if (data.state === 'no-key') {
      parts.push(icon('all', 'messages-empty-icon'), heading('Messages needs a Unipile key'),
        line('Unipile connects Gmail, WhatsApp, LinkedIn and Instagram to imperfect. Its key lives on the PC only.'));
      const steps = el('ol', 'messages-steps');
      const signup = el('li');
      const link = el('a', null, 'dashboard.unipile.com');
      link.href = 'https://dashboard.unipile.com/signup';
      link.onclick = event => { event.preventDefault(); openLink(link.href); };
      signup.append('Start the free trial at ', link, '.');
      const file = el('li');
      file.append('On the PC, save the DSN and an access token from the dashboard as ', el('code', null, '~/.imperfect/credentials/unipile.json'), ':');
      file.append(el('code', 'messages-code', '{"dsn": "apiN.unipile.com:PORT", "apiKey": "…"}'));
      steps.append(signup, file, el('li', null, 'Check again, then connect each account.'));
      const again = button('look-button primary', 'Check again');
      again.onclick = () => { data = { ...data, state: 'loading' }; paint(); void load({ refresh: true }); };
      parts.push(steps, again);
    } else if (data.state === 'no-accounts') {
      if (data.canConnect === false) parts.push(heading('No accounts connected'), line('Connect accounts on the PC, not on this lent computer.'));
      else parts.push(icon('all', 'messages-empty-icon'), heading('Connect your accounts'),
        line('Each opens Unipile\'s sign-in page in the browser. Come back here when it says connected.'), connectChoices());
    } else if (data.state === 'unreachable' || data.state === 'error') {
      const retry = button('look-button', 'Try again');
      retry.onclick = () => { void load({ refresh: true }); };
      parts.push(heading(data.state === 'error' ? 'Messages could not be read' : 'Messages are out of reach'), line(data.message || lastError), retry);
    } else if (data.state === 'loading') {
      parts.push(line('Loading…'));
    } else if (results && !shown().length) {
      parts.push(line(`Nothing holds “${searchInput.value.trim()}”.`));
    } else if (!shown().length) {
      parts.push(line(filter.source || filter.account ? 'Nothing here from this account yet.' : 'No conversations yet. New ones appear as Unipile syncs.'));
    }
    empty.replaceChildren(...parts);
    empty.hidden = !parts.length;
  }
  function connectChoices() {
    const box = el('div', 'messages-connect-list');
    for (const source of CONNECT_ORDER) {
      const choice = button('messages-connect-choice');
      choice.append(badge(source), el('span', null, SOURCE[source].label));
      const had = data.accounts.filter(account => account.source === source).length;
      if (had) choice.append(el('span', 'messages-connect-had', had > 1 ? `${had} connected` : 'connected'));
      choice.onclick = () => connect({ provider: source });
      box.append(choice);
    }
    for (const later of data.notYet ?? [{ source: 'x', label: 'X', note: 'Not yet: Unipile no longer maintains X.' }]) {
      const choice = button('messages-connect-choice');
      choice.disabled = true;
      choice.title = later.note;
      choice.append(badge(later.source), el('span', null, later.label), el('span', 'messages-connect-had', 'not yet'));
      box.append(choice);
    }
    return box;
  }
  function paintNote() {
    const problems = data.problems ?? [];
    const needing = data.accounts.filter(account => ['credentials', 'permissions', 'error', 'stopped'].includes(account.status));
    note.replaceChildren();
    for (const account of needing) {
      const again = button('messages-note-action', 'Reconnect');
      again.onclick = () => connect({ reconnect: account.id });
      const line = el('span', 'messages-note-line');
      line.append(badge(account.source), el('span', null, `${accountName(account)} needs signing in again.`));
      if (data.canConnect !== false) line.append(again);
      note.append(line);
    }
    const stale = data.state === 'ready' && lastError;
    if (problems.length || stale) {
      const line = el('span', 'messages-note-line', stale ? `Showing what was there before: ${lastError}` : `Not everything answered: ${problems.join('; ')}`);
      line.title = line.textContent;
      note.append(line);
    }
    note.hidden = !note.childElementCount;
  }
  function paintList() {
    const items = data.state === 'ready' ? shown() : [];
    const keep = list.scrollTop;
    list.replaceChildren(...items.map(row));
    list.scrollTop = keep;
    list.hidden = !items.length;
    emptyState();
  }

  /* ---- a conversation ---- */
  function bubbleOf(message, group) {
    const item = el('div', `messages-msg${message.me ? ' me' : ''}${message.event ? ' event' : ''}`);
    if (message.event) { item.textContent = message.text || 'Something happened in the chat'; return item; }
    if (group && !message.me) item.append(el('span', 'messages-msg-from', message.from));
    const bubble = el('div', 'messages-bubble');
    if (message.quoted) bubble.append(el('span', 'messages-quote', message.quoted));
    if (message.deleted) bubble.append(el('span', 'messages-deleted', 'Message deleted'));
    else if (message.text) bubble.append(el('span', 'messages-text', message.text));
    if (message.attachments.length) bubble.append(attachments(message.attachments));
    bubble.append(el('time', 'messages-msg-time', clock(message.at)));
    item.append(bubble);
    return item;
  }
  function attachments(items) {
    const box = el('div', 'messages-files');
    for (const file of items) {
      const chip = el(file.href ? 'a' : 'span', 'messages-file');
      chip.append(icon('clip'), el('span', 'messages-file-name', file.name));
      if (file.size) chip.append(el('span', 'messages-file-size', size(file.size)));
      if (file.href) {
        chip.href = file.href;
        if (/^https:/.test(file.href)) chip.onclick = event => { event.preventDefault(); openLink(file.href); };
        else chip.download = file.name;
      }
      box.append(chip);
    }
    return box;
  }
  function letterOf(message) {
    const item = el('article', `messages-letter${message.me ? ' me' : ''}`);
    const head = el('header', 'messages-letter-head');
    const who = el('span', 'messages-letter-from', message.from);
    if (message.address && !message.me) who.title = message.address;
    head.append(who, el('time', 'messages-letter-time', `${shortTime(message.at)}${sameDay(new Date(message.at), new Date()) ? '' : ` ${clock(message.at)}`}`));
    const to = message.to.map(person => person.name || person.address).join(', ');
    item.append(head);
    if (to) item.append(el('p', 'messages-letter-to', `to ${to}${message.cc.length ? `, cc ${message.cc.map(person => person.name || person.address).join(', ')}` : ''}`));
    item.append(el('div', 'messages-letter-body', message.text || '(no text)'));
    if (message.quoted) {
      const more = button('messages-letter-more', '•••', 'Show what it quotes');
      const quoted = el('div', 'messages-letter-quoted', message.quoted);
      quoted.hidden = true;
      more.onclick = () => { quoted.hidden = !quoted.hidden; more.setAttribute('aria-expanded', String(!quoted.hidden)); };
      item.append(more, quoted);
    }
    if (message.attachments.length) item.append(attachments(message.attachments));
    return item;
  }
  function paintThread() {
    root.dataset.view = current ? 'thread' : 'list';
    thread.classList.toggle('empty', !current);
    if (!current) { threadTitle.replaceChildren(); scroll.replaceChildren(); return; }
    const t = current.thread;
    const listed = (data.conversations ?? []).find(c => c.key === current.key) ?? results?.find(c => c.key === current.key);
    const source = t?.source ?? listed?.source ?? '';
    const account = t?.account ?? accountOf(listed?.account);
    const name = el('span', 'messages-thread-name', t ? (t.kind === 'chat' ? t.title : listed?.name || t.people[0] || t.title) : listed?.name ?? '');
    const meta = el('span', 'messages-thread-meta');
    meta.append(badge(source), el('span', null, [SOURCE[source]?.label, account && several(source) ? account.name : '', t?.kind !== 'chat' && t?.title ? t.title : ''].filter(Boolean).join(' · ')));
    const words = el('span', 'messages-thread-words');
    words.append(name, meta);
    threadTitle.replaceChildren(avatar({ key: current.key, source, name: name.textContent, avatar: t?.avatar ?? listed?.avatar }, { mark: false }), words);
    if (current.error) { scroll.replaceChildren(el('p', 'messages-thread-error', current.error)); composer.hidden = true; return; }
    if (!t) { scroll.replaceChildren(el('p', 'messages-thread-loading', 'Loading…')); composer.hidden = true; return; }
    const nodes = [];
    if (t.cursor) {
      const earlier = button('messages-earlier', 'Earlier messages');
      earlier.onclick = () => openThread(current.key, { cursor: t.cursor });
      nodes.push(earlier);
    }
    let day = '';
    for (const message of t.messages) {
      const label = dayLabel(message.at);
      if (t.kind === 'chat' && label !== day) { nodes.push(el('p', 'messages-day', label)); day = label; }
      nodes.push(t.kind === 'chat' ? bubbleOf(message, t.people.length > 1) : letterOf(message));
    }
    if (!t.messages.length) nodes.push(el('p', 'messages-thread-loading', 'No messages yet.'));
    // Where it was read to, kept through the repaint: the end stays the
    // end, and earlier messages arriving above leave the words in place.
    const atEnd = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 40;
    const fromEnd = scroll.scrollHeight - scroll.scrollTop;
    const sameThread = scroll.dataset.key === current.key;
    scroll.replaceChildren(...nodes);
    scroll.dataset.key = current.key;
    // The composer: who it goes to, and as whom.
    composer.hidden = Boolean(t.readOnly);
    if (t.demo) replyTo.textContent = 'Demo inbox: Send shows the reply here, and nothing is sent.';
    else if (t.canSend === false) replyTo.textContent = 'Read and draft only: sending is off on this computer.';
    else if (t.kind === 'chat') replyTo.textContent = `Reply on ${SOURCE[source]?.label ?? source}${account ? ` as ${account.name}` : ''}`;
    else replyTo.textContent = t.reply ? `To ${t.reply.to.map(p => (p.name ? `${p.name} <${p.address}>` : p.address)).join(', ')} · ${t.reply.subject}` : 'There is no one to reply to.';
    replyTo.title = replyTo.textContent;
    field.placeholder = t.kind === 'chat' ? 'Message' : 'Reply';
    if (t.draft && draftShown !== `${current.key}|${t.draft.at}` && (!field.value.trim() || field.dataset.draft === field.value)) putDraft(t.draft);
    drafted.hidden = !(field.dataset.draft && field.dataset.draft === field.value);
    sendButton.disabled = sending || t.canSend === false || (t.kind !== 'chat' && !t.reply?.to?.length);
    grow();
    // A chat opens at its end; an email thread at the start of its last letter.
    const last = t.kind !== 'chat' && !sameThread ? [...scroll.querySelectorAll('.messages-letter')].at(-1) : null;
    if (last) scroll.scrollTop = last.getBoundingClientRect().top - scroll.getBoundingClientRect().top + scroll.scrollTop - 4;
    else if (!sameThread || atEnd) scroll.scrollTop = scroll.scrollHeight;
    else scroll.scrollTop = scroll.scrollHeight - fromEnd;
  }
  function putDraft(draft) {
    field.value = draft.text;
    field.dataset.draft = draft.text;
    draftShown = `${current.key}|${draft.at}`;
    drafted.replaceChildren(el('span', null, `Drafted by ${draft.by || 'an agent'}. ${current?.thread?.canSend === false ? 'Read it and change it here. Sending is off here; send from your own computer.' : 'Read it, change it if you like, then press Send.'}`));
    const discard = button('messages-note-action', 'Discard');
    discard.onclick = async () => {
      const key = current?.key;
      field.value = ''; delete field.dataset.draft; drafted.hidden = true; grow();
      if (key) await ask('/inbox/discard', { method: 'POST', body: { key } }).catch(() => {});
      if (current?.thread) current.thread.draft = null;
      const listed = data.conversations.find(c => c.key === key);
      if (listed) listed.draft = false;
      paintList(); onChange();
    };
    drafted.append(discard);
    drafted.hidden = false;
    grow();
  }
  async function openThread(key, { cursor = '', seen = true } = {}) {
    const turn = ++threadTurn;
    if (!cursor) current = { key, thread: current?.key === key ? current.thread : null };
    paint();
    try {
      const t = await ask(`/inbox/thread?${new URLSearchParams({ key, ...(seen ? { seen: '1' } : {}), ...(cursor ? { cursor } : {}) })}`);
      if (turn !== threadTurn || current?.key !== key) return;
      if (cursor && current.thread) t.messages = [...t.messages, ...current.thread.messages.filter(m => !t.messages.some(n => n.id === m.id))];
      current = { key, thread: t };
      const listed = data.conversations.find(c => c.key === key);
      if (listed) listed.unread = 0;
      onChange();
    } catch (error) {
      if (turn !== threadTurn || current?.key !== key) return;
      if (error.status === 403) {
        forgetInbox();
        data = { state: 'unreachable', message: error.message, accounts: [], conversations: [] };
        onChange();
      } else {
        current = { key, error: error.message };
        if (error.status === 404) void load();
      }
    }
    paint();
  }
  function select(key) {
    if (current?.key !== key) {
      if (field.value.trim() && field.dataset.draft !== field.value) keepDraft();
      field.value = restoreDraft(key);
      delete field.dataset.draft; drafted.hidden = true; said.textContent = ''; draftShown = null;
    }
    void openThread(key);
    onChange();
    if (root.dataset.wide !== 'true') field.blur();
  }
  // What the person was typing in one conversation, kept when they look at another.
  const typed = new Map();
  function keepDraft() { if (current) typed.set(current.key, field.value); }
  function restoreDraft(key) { const value = typed.get(key) ?? ''; typed.delete(key); return value; }
  function back() {
    if (!connectSheet.hidden) { connectSheet.hidden = true; return true; }
    if (!current || root.dataset.wide === 'true') return false;
    keepDraft();
    current = null; field.value = ''; threadTurn++;
    paint();
    onChange();
    list.querySelector('[aria-selected="true"]')?.focus({ preventScroll: true });
    return true;
  }
  const grow = () => { field.style.height = 'auto'; field.style.height = `${Math.min(field.scrollHeight, Math.max(120, Math.round(root.clientHeight * 0.4)))}px`; };
  field.addEventListener('input', () => { grow(); drafted.hidden = !(field.dataset.draft && field.dataset.draft === field.value); said.textContent = ''; });

  // Send: the person's press, and only that.
  composer.addEventListener('submit', async event => {
    event.preventDefault();
    if (!current?.thread || current.thread.canSend === false || sending) return;
    const text = field.value.trim();
    if (!text) { field.focus(); return; }
    const key = current.key, once = nonce();
    sending = true; sendButton.disabled = true; sendButton.textContent = 'Sending…'; said.textContent = '';
    try {
      const answer = await ask('/inbox/send', { method: 'POST', body: { key, text, nonce: once } });
      typed.delete(key);
      if (current?.key === key) {
        field.value = ''; delete field.dataset.draft; drafted.hidden = true; grow();
        said.textContent = answer.demo ? 'Demo: shown here, not sent' : 'Sent';
        const t = current.thread;
        if (t) {
          t.draft = null;
          t.messages.push(t.kind === 'chat'
            ? { id: `sent-${once}`, at: Date.now(), me: true, from: 'You', text, attachments: [], quoted: '', deleted: false, event: false }
            : { id: `sent-${once}`, at: Date.now(), me: true, from: 'You', address: '', to: t.reply?.to ?? [], cc: [], subject: t.reply?.subject ?? '', text, quoted: '', attachments: [] });
        }
      }
      const listed = data.conversations.find(c => c.key === key);
      if (listed) { listed.at = Date.now(); listed.preview = `You: ${text}`; listed.draft = false; data.conversations.sort((a, b) => b.at - a.at); }
      if (!answer.demo) setTimeout(() => { if (current?.key === key && !field.value.trim()) void openThread(key); }, 2500);
    } catch (error) {
      said.textContent = error.status && error.status < 500 ? `Not sent: ${error.message}` : `Send not confirmed: ${error.message}. Check the conversation before trying again.`;
      said.classList.add('failed');
    } finally {
      sending = false; sendButton.textContent = 'Send';
      setTimeout(() => said.classList.remove('failed'), 8000);
      paint(); onChange();
    }
  });

  /* ---- connect ---- */
  async function connect(asked) {
    connectSheet.hidden = true;
    said.textContent = '';
    try {
      const { url } = await ask('/inbox/connect', { method: 'POST', body: asked });
      if (!await openLink(url, { signIn: true })) return;
      // Look for the account for a while: Unipile adds it (or says it is
      // well again) once the sign-in is done.
      const before = data.accounts.length, until = Date.now() + 5 * 60_000;
      const done = () => (asked.reconnect ? accountOf(asked.reconnect)?.status === 'ok' : data.accounts.length > before);
      clearInterval(connectWatch);
      connectWatch = setInterval(async () => {
        if (Date.now() > until) { clearInterval(connectWatch); return; }
        await load({ refresh: true });
        if (done()) clearInterval(connectWatch);
      }, 10_000);
    } catch (error) {
      if (error.missing === 'key') { data = { ...data, state: 'no-key', message: error.message }; paint(); onChange(); return; }
      note.hidden = false;
      note.replaceChildren(el('span', 'messages-note-line', `Could not start the sign-in: ${error.message}`));
    }
  }
  connectButton.onclick = () => {
    if (data.state === 'no-key') { connectSheet.hidden = true; current = null; paint(); return; }
    connectSheet.hidden = !connectSheet.hidden;
    if (!connectSheet.hidden) {
      const close = button('messages-tool messages-connect-close', null, 'Close');
      close.append(icon('x'));
      close.onclick = () => { connectSheet.hidden = true; };
      const head = el('header', 'messages-connect-head');
      head.append(el('h3', null, 'Connect an account'), close);
      connectSheet.replaceChildren(head, el('p', 'messages-empty-line', 'Unipile\'s sign-in page opens in the browser.'), connectChoices());
      connectSheet.querySelector('button:not([disabled]).messages-connect-choice')?.focus();
    }
  };
  connectSheet.addEventListener('keydown', event => { if (event.key === 'Escape') { event.stopPropagation(); connectSheet.hidden = true; connectButton.focus(); } });
  refreshButton.onclick = async () => {
    refreshButton.classList.add('turning');
    await load({ refresh: true });
    if (current) await openThread(current.key);
    refreshButton.classList.remove('turning');
  };
  backButton.onclick = () => back();

  /* ---- search ---- */
  searchInput.addEventListener('input', () => {
    clearTimeout(searchTimer);
    const words = searchInput.value.trim();
    const turn = ++searchTurn;
    if (!words) { results = null; paint(); return; }
    searchTimer = setTimeout(async () => {
      try {
        const answer = await ask(`/inbox/search?${new URLSearchParams({ q: words, limit: '50' })}`);
        if (turn === searchTurn) {
          if (Boolean(data.demo) !== Boolean(answer.demo)) { forgetInbox(); await load(); return; }
          results = answer.conversations ?? []; paint();
        }
      } catch (error) {
        if (turn === searchTurn) {
          if (error.status === 403) {
            forgetInbox();
            data = { state: 'unreachable', message: error.message, accounts: [], conversations: [] };
            onChange();
          } else results = [];
          lastError = error.message; paint();
        }
      }
    }, 280);
  });
  searchInput.addEventListener('keydown', event => {
    if (event.key === 'Escape' && searchInput.value) { event.stopPropagation(); searchInput.value = ''; searchInput.dispatchEvent(new Event('input')); }
    if (event.key === 'ArrowDown') { event.preventDefault(); list.querySelector('.messages-row')?.focus(); }
  });
  // Up and down walk the list; Escape goes back to it.
  list.addEventListener('keydown', event => {
    const rows = [...list.querySelectorAll('.messages-row')];
    const at = rows.indexOf(doc.activeElement);
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      rows[Math.max(0, Math.min(rows.length - 1, at + (event.key === 'ArrowDown' ? 1 : -1)))]?.focus();
    }
  });
  root.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !event.defaultPrevented && root.dataset.view === 'thread' && doc.activeElement !== field && back()) event.stopPropagation();
  });

  // Room for the list and the conversation side by side, or one at a time.
  new ResizeObserver(() => {
    const wide = root.clientWidth >= 660;
    if (String(wide) !== root.dataset.wide) { root.dataset.wide = String(wide); paint(); }
  }).observe(root);

  function paint() {
    paintFilters();
    paintNote();
    paintList();
    paintThread();
  }

  void load();
  schedule();
  document.addEventListener('visibilitychange', () => { if (!document.hidden && showing() && Date.now() - (data.refreshedAt ?? 0) > 60_000) void load(); });

  const unreadOf = conversations => conversations.reduce((sum, c) => sum + (c.unread ? 1 : 0), 0);
  return {
    el: root,
    keys() {
      if (root.contains(doc.activeElement)) return;
      if (current?.thread && !composer.hidden) field.focus({ preventScroll: true });
      else (list.querySelector('[aria-selected="true"]') ?? (list.querySelector('.messages-row') ? list : searchBox.hidden ? root : searchInput)).focus({ preventScroll: true });
    },
    open({ source = '', account = '', key = '', connect: connecting = false } = {}) {
      filter = { source: account ? accountOf(account)?.source ?? source : source, account };
      if (Date.now() - (data.refreshedAt ?? 0) > 60_000) void load();
      if (key) select(key);
      // Every conversation: the list, where there is room for only one.
      else if (current && root.dataset.wide !== 'true') { keepDraft(); current = null; field.value = ''; threadTurn++; }
      paint();
      onChange();
      if (connecting && data.state !== 'no-key' && !data.demo && data.canConnect !== false) { connectSheet.hidden = true; connectButton.click(); }
      schedule();
    },
    back,
    seen() { schedule(); if (Date.now() - (data.refreshedAt ?? 0) > 60_000) void load(); },
    // An agent drafted a reply: marked in the list, and into the composer
    // if that conversation is open and nothing of the person's own is in it.
    // Nothing is opened for them, or marked read.
    drafted(message) {
      const listed = data.conversations.find(c => c.key === message.key);
      if (listed) listed.draft = true;
      const draft = { text: String(message.text ?? ''), by: String(message.by ?? ''), at: Number(message.at) || Date.now() };
      if (current?.key === message.key && current.thread) current.thread.draft = draft;
      paint();
      onChange();
    },
    // The PC said its list changed (it asked Unipile behind an answer).
    async changed() {
      const key = current?.key;
      await load();
      // Draft words are fetched through the guarded inbox route, never the
      // session socket. A background update must not mark a thread read.
      if (key && current?.key === key) await openThread(key, { seen: false });
    },
    sidebarLook: () => [data.state, Boolean(data.demo), current?.key ?? '', unreadOf(data.conversations ?? []),
      (data.conversations ?? []).slice(0, SIDEBAR_MOST).map(c => [c.key, c.name, c.unread, c.draft, shortTime(c.at)])],
    // The sidebar's Messages: the newest conversations, each opening in the
    // panel beside the session, then every one of them.
    sidebar({ row, head, active = false, open }) {
      const parts = [head('Messages')];
      const all = data.conversations ?? [];
      if (data.state === 'ready') {
        for (const c of all.slice(0, SIDEBAR_MOST)) {
          const meta = c.draft ? el('span', 'sidebar-meta messages-sidebar-draft', 'Draft') : c.unread ? el('span', 'sidebar-unread') : shortTime(c.at);
          parts.push(row({ icon: doc.createDocumentFragment(), name: c.name || 'Unknown', meta, active: active && current?.key === c.key,
            title: `${SOURCE[c.source]?.label ?? ''}${c.subject && c.kind !== 'chat' ? ` · ${c.subject}` : ''}${c.preview ? `: ${c.preview}` : ''}`, onclick: () => open({ key: c.key }) }));
        }
      }
      const unread = unreadOf(all);
      const name = data.state === 'no-key' ? 'Set up Messages' : data.state === 'no-accounts' && data.canConnect !== false ? 'Connect accounts' : 'All messages';
      const meta = data.state === 'unreachable' || data.state === 'error' ? 'away' : unread ? String(unread) : '';
      parts.push(row({ icon: doc.createDocumentFragment(), name, meta, dim: data.state !== 'ready', active: active && !current, title: 'Every conversation, newest first', onclick: () => open({}) }));
      return parts;
    },
  };
}
