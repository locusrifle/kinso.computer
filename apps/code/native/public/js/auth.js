// Web interaction for Claude Code, Codex and Pi sign-in. No OAuth logic or secret storage.
import { brand } from './brand.js';
const node = (tag, text, className) => { const e = document.createElement(tag); if (text != null) e.textContent = text; if (className) e.className = className; return e; };
const button = (text, action) => { const e = node('button', text); e.type = 'button'; e.onclick = action; return e; };
function link(url, label) {
  try {
    const parsed = new URL(url);
    if (!['https:', 'http:'].includes(parsed.protocol)) return node('span', 'Unsupported authorization link');
    const a = node('a', label ?? 'Open sign-in page'); a.href = parsed.href; a.target = '_blank'; a.rel = 'noopener noreferrer';
    return a;
  } catch { return node('span', 'Invalid authorization link'); }
}

// Pi offers whatever login methods a provider supports. On a computer you reach over a network,
// browser login cannot work at all: it opens a listener on *this* machine and hands the provider
// a loopback address, so the person's own browser is sent to a localhost that is not this one.
// Where a device code, or a code to copy back, exists it is the only honest choice,
// so it is the only one offered.
function loginMethods(options) {
  const device = options?.filter(o => o.id === 'device_code' || o.id === 'copy_code');
  return device?.length ? device : options;
}

// The server names each harness and billing method before authorization.
const offeredMethods = provider => provider.methods;

const BRAND = brand.name;

export function mountAuth({ command, chooseModel, autoWelcome = true }) {
  const panel = node('dialog', null, 'guey-auth'); panel.id = 'guey-auth';
  panel.setAttribute('aria-labelledby', 'guey-auth-title');
  const title = node('h1', `Welcome to ${BRAND}`); title.id = 'guey-auth-title';
  const subtitle = node('p', 'Claude → Claude Code / Claude subscription. ChatGPT → Codex or Pi / ChatGPT subscription. Claude may charge extra usage if you enabled it. Old Pi Anthropic sign-ins are never used.', 'auth-subtitle');
  const body = node('div', null, 'auth-body');
  const feedback = node('p', '', 'auth-feedback'); feedback.setAttribute('role', 'status');
  const actions = node('div', null, 'auth-actions');
  panel.append(title, subtitle, body, feedback, actions);
  document.body.append(panel);
  const dismissed = new Set();
  let state = null, view = '', first = true, promptId = null;
  // What the flow's links and buttons were last drawn from: the window
  // renders on every update (a working agent sends many a second), and a
  // button replaced between press and release is never clicked.
  let progress, promptArea, message, cancelling = false, drawnEvents = '', drawnActions = '';
  const fail = error => { feedback.textContent = error.message ?? 'Request failed'; };
  // Choose a model for a provider that has just signed in, then get out of the way.
  let settling = false;
  async function settle(providerId) {
    if (settling) return;
    settling = true;
    try {
      // Only fill an empty choice: someone who already picked a model did so on purpose.
      // The current one lives in the snapshot, which is the same thing the status bar reads.
      const now = await command('snapshot').catch(() => null);
      if (now?.model?.id && now.model.provider !== 'anthropic' && providerId !== 'claude-agent') return;
      if (providerId === 'claude-agent' && now?.agent === 'claude') return;
      const models = await command('models');
      const pick = models?.find(m => m.provider === providerId) ?? (providerId === 'claude-agent' ? null : models?.[0]);
      if (!pick) { if (providerId === 'claude-agent') feedback.textContent = 'Signed in, but Claude Code’s models are unavailable. Try the model picker again; no other harness was selected.'; return; }
      await command('model', { provider: pick.provider, modelId: pick.id });
      feedback.textContent = `Default model: ${pick.id}. You can change it any time.`;
    } catch { /* the person can still choose one; this was only a courtesy */ }
    finally { settling = false; }
  }
  const send = (type, fields) => command(type, fields).catch(fail);
  // Not modal: signing in happens in the browser beside it (a link here opens
  // there), so the rest of the window has to stay usable while it is up.
  const open = () => { if (!panel.open) panel.show(); };
  const close = () => { if (state?.id) dismissed.add(state.id); panel.close(); body.replaceChildren(); view = ''; promptId = null; drawnEvents = drawnActions = ''; };
  async function cancel() {
    // Close first, so a dead machine behind it cannot trap a person here.
    const busy = state?.busy;
    close();
    if (busy) await send('auth_cancel');
    else await send('auth_dismiss');
  }
  panel.addEventListener('cancel', event => { event.preventDefault(); void cancel(); });
  panel.addEventListener('keydown', event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); void cancel(); } });
  function picker(rows, heading, footer = 'Choose a provider to continue.') {
    title.textContent = heading; feedback.textContent = footer;
    body.replaceChildren();
    const search = node('input'); search.type = 'search'; search.placeholder = 'Find a provider'; search.setAttribute('aria-label', 'Find a provider');
    const list = node('div', null, 'auth-provider-list');
    const paint = () => {
      list.replaceChildren(...rows.filter(r => r.label.toLowerCase().includes(search.value.toLowerCase())).map(r => {
        const item = button(r.label, r.action); item.className = 'auth-provider';
        if (r.note) item.append(node('small', r.note)); return item;
      }));
      if (!list.childElementCount) list.append(node('p', 'No matching providers.'));
    };
    search.oninput = paint; body.append(search, list); paint();
  }
  async function login(providerId) {
    if (!state) throw new Error('GUI login is not enabled for this service');
    first = false; feedback.textContent = ''; open();
    if (state.busy) { renderFlow(); return; }
    if (state.id) dismissed.add(state.id);
    view = 'picker'; title.textContent = 'Sign in';
    body.replaceChildren(node('p', 'Loading providers…')); actions.replaceChildren(button('Not now', close));
    await send('auth_dismiss');
    const providers = await command('auth_providers');
    if (state.busy || view !== 'picker') return;
    const begin = (p, method) => {
      if (method.ambient) { feedback.textContent = `${method.name} is configured outside ${BRAND} (environment or cloud credentials).`; return; }
      // This click is the consent boundary. Merely opening the picker never
      // starts a provider flow, callback listener, authorization or network request.
      send('auth_login', { provider: p.id, method: method.type });
    };
    function showMethods(p) {
      const methods = offeredMethods(p);
      if (!methods.length) { feedback.textContent = `${p.name} cannot be connected from here.`; return; }
      picker(methods.map(m => ({ label: m.label, note: m.name, action: () => begin(p, m) })), p.name,
        `${p.id === 'claude-agent' ? 'Claude Code handles Claude subscription sign-in' : p.id === 'codex' ? 'Codex handles ChatGPT subscription sign-in' : 'Pi handles this provider’s sign-in'}; ${BRAND} does not receive your account password.`);
      actions.replaceChildren(button('Back', () => showType()), button('Not now', close));
    }
    function showProviders(type) {
      // Picking the provider IS the choice, so it starts that provider's flow. Naming a provider
      // is the consent boundary: nothing is started until one of these rows is pressed.
      const rows = providers.flatMap(p => {
        const method = offeredMethods(p).find(m => m.type === type);
        return method ? [{ label: p.name, note: method.name + (p.configured ? ' · configured' : ''), action: () => begin(p, method) }] : [];
      });
      picker(rows, type === 'oauth' ? 'Use a subscription / sign in' : 'Use an API key');
      actions.replaceChildren(button('Back', showType), button('Not now', close));
    }
    function showType() {
      title.textContent = `Welcome to ${BRAND}`;
      feedback.textContent = 'Choose your subscription or explicitly choose API billing. Claude subscriptions use Claude Code, never Pi.';
      body.replaceChildren(
        button('Use a subscription / sign in', () => showProviders('oauth')),
        button('Use an API key', () => showProviders('api_key')),
      );
      actions.replaceChildren(button('Not now', close));
    }
    if (providerId) { const p = providers.find(p => p.id === providerId); if (!p) throw new Error('Unknown provider'); showMethods(p); }
    else showType();
  }
  async function logout() {
    if (!state) throw new Error('GUI login is not enabled for this service');
    if (state.busy) { open(); renderFlow(); return; }
    first = false; if (state.id) dismissed.add(state.id);
    view = 'picker'; open(); await send('auth_dismiss');
    const providers = await command('auth_accounts');
    picker(providers.map(p => ({ label: p.name, note: p.note, action: () => {
      picker([{ label: `Remove ${p.name} credentials`, action: () => send('auth_logout', { provider: p.id }) }], 'Sign out?', 'Only credentials stored on this machine are removed. Environment/cloud credentials remain.');
    } })), 'Sign out of a provider', 'Only credentials stored in this machine’s own profile can be removed.');
    actions.replaceChildren(button('Close', close));
  }
  function renderFlow() {
    open();
    if (view !== 'flow') {
      view = 'flow'; promptId = null; feedback.textContent = ''; drawnEvents = drawnActions = '';
      progress = node('div', null, 'auth-progress');
      promptArea = node('div', null, 'auth-prompt');
      message = node('p'); message.setAttribute('role', 'status');
      body.replaceChildren(message, progress, promptArea);
    }
    title.textContent = state.providerName ?? 'Sign-in'; message.textContent = state.message ?? '';
    const events = JSON.stringify(state.events ?? []);
    if (events !== drawnEvents) progress.replaceChildren(...(state.events ?? []).map(e => {
      const row = node('div', null, 'auth-event');
      if (e.type === 'auth_url') { row.append(link(e.url)); if (e.instructions) row.append(node('p', e.instructions)); }
      else if (e.type === 'device_code') { row.append(node('p', 'Enter this code on the provider’s page:'), node('code', e.userCode, 'auth-device-code'), link(e.verificationUri, 'Open device verification')); }
      else { row.append(node('p', e.message)); for (const l of e.links ?? []) row.append(link(l.url, l.label)); }
      return row;
    }));
    drawnEvents = events;
    const p = state.prompt;
    if (p?.id !== promptId) {
      promptId = p?.id; promptArea.replaceChildren();
      if (p) {
        const form = node('form'); form.autocomplete = 'off';
        const label = node('label', p.message); label.htmlFor = 'auth-answer';
        const field = node(p.type === 'select' ? 'select' : 'input'); field.id = 'auth-answer';
        // A browser login hands the provider a loopback address, and the listener it opens is on
        // *this* computer -- which is not the one the person is sitting at. The provider sends
        // their browser to localhost and nothing answers. Device code is the flow built for
        // exactly that gap, so it leads and the one that cannot work here says so.
        if (p.type === 'select') for (const o of loginMethods(p.options)) {
          const option = node('option', o.label.replace(/\s*\(headless\)/i, ''));
          option.value = o.id; field.append(option);
        }
        else { field.type = ['secret', 'manual_code'].includes(p.type) ? 'password' : 'text'; field.placeholder = p.placeholder ?? ''; field.autocomplete = 'off'; field.spellcheck = false; }
        const ok = node('button', 'Continue'); ok.type = 'submit';
        form.onsubmit = async event => {
          event.preventDefault(); ok.disabled = true;
          const value = field.value; field.value = ''; // not the composer or draft/localStorage
          try { await command('auth_answer', { promptId: p.id, value }); feedback.textContent = ''; }
          catch (error) { fail(error); ok.disabled = false; }
        };
        form.append(label, field, ok); promptArea.append(form); field.focus();
      }
    }
    const success = state.status === 'success' && Boolean(state.availableModels);
    // A provider that just authenticated gets one of its models (below), each update.
    if (!state.busy && success) settle(state.providerId);
    const drawn = JSON.stringify([state.id, Boolean(state.busy), cancelling, state.status, success, state.providerId]);
    if (drawn === drawnActions) return;
    drawnActions = drawn;
    actions.replaceChildren();
    if (state.busy) actions.append(button(cancelling ? 'Cancelling…' : 'Cancel sign-in', cancel));
    else {
      if (success) {
        // Signing in is the thing the person came to do; picking a model afterwards is
        // bookkeeping they have no basis to decide yet. So a provider that just authenticated
        // gets one of its own models selected straight away and the harness works. The label in
        // the status bar still changes it, and this only ever fills an empty choice -- a model
        // already chosen is never overridden underneath somebody.
        actions.append(button('Choose a default model', async () => { close(); await send('auth_dismiss'); chooseModel(); }));
      }
      if (['error', 'cancelled'].includes(state.status)) actions.append(button('Try again', () => login(state.providerId).catch(fail)));
      actions.append(button('Close', async () => { close(); await send('auth_dismiss'); }));
    }
  }
  return {
    login, logout,
    render(next) {
      if (!next) return;
      state = next;
      if ((next.busy || next.status !== 'idle') && !dismissed.has(next.id)) renderFlow();
      else if (first) { first = false; if (autoWelcome && !next.configured) void login().catch(fail); }
    },
  };
}
