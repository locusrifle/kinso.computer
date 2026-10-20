import { randomUUID } from 'node:crypto';
import { CredentialSynchronizationError } from '@earendil-works/pi-coding-agent';
import { claudeSignIn } from './claude-auth.mjs';
import { codexSignIn } from './codex-auth.mjs';

// Claude Code owns Claude's OAuth and persistence, Codex its own ChatGPT
// sign-in; Pi owns all other providers. Only interaction/lifecycle state
// enters snapshots, never credentials or answers.
//
// One ChatGPT subscription offered three sign-ins (Noah, 18 Oct: "3 openai
// codex etc and two don't work"): Codex's, Pi's legacy one and Pi's newer
// "OpenAI" one. The newer one waits for the browser to come back to
// 127.0.0.1 on the computer itself, which a hosted computer or a phone never
// does, so its subscription sign-in is not offered (its API key still is).
// The two that work by a code are named for the harness they sign in.
const HIDDEN_OAUTH = new Set(['openai']);
const CHATGPT_NAMES = { 'openai-codex': 'ChatGPT · Pi' };
export function createAuth({ models, changed, assertIdle, onAuthChanged, claude = claudeSignIn, codex = codexSignIn, timeoutMs = 10 * 60 * 1000 }) {
  let flow = null;
  let state = { status: 'idle', prompt: null, events: [] };
  let view = null;
  const update = () => { view = null; changed(); };
  function providers() {
    const runtime = models();
    const pi = runtime.getProviders().filter(p => p.id !== 'anthropic').map(p => ({
      id: p.id, name: CHATGPT_NAMES[p.id] ?? p.name,
      configured: runtime.getProviderAuthStatus(p.id).configured,
      methods: [
        ...(p.auth.oauth && !HIDDEN_OAUTH.has(p.id) ? [{ type: 'oauth', name: p.auth.oauth.name, label: p.auth.oauth.loginLabel ?? 'Use a subscription / sign in', subscription: Boolean(p.auth.oauth.isSubscription) }] : []),
        ...(p.auth.apiKey ? [{ type: 'api_key', name: p.auth.apiKey.name, label: 'Use an API key', ambient: !p.auth.apiKey.login }] : []),
      ],
    }));
    return [{ id: 'claude-agent', name: 'Claude', configured: Boolean(claude.configured()),
      methods: [{ type: 'oauth', name: 'Claude Code · Claude subscription (extra usage if enabled in Claude)', label: 'Sign in to Claude Code', subscription: true }] },
    { id: 'codex', name: 'ChatGPT · Codex', configured: Boolean(codex.configured()),
      methods: [{ type: 'oauth', name: 'Codex · ChatGPT subscription', label: 'Sign in to Codex', subscription: true }] }, ...pi.filter(p => p.methods.length)];
  }
  function notify(event, current) {
    if (flow !== current || current.controller.signal.aborted) return;
    // Deliberate event allowlist: never expose provider objects or credentials.
    let item;
    if (event.type === 'auth_url') item = { type: event.type, url: event.url, instructions: event.instructions };
    else if (event.type === 'device_code') item = { type: event.type, userCode: event.userCode, verificationUri: event.verificationUri };
    else if (event.type === 'info') item = { type: event.type, message: event.message, links: event.links?.map(l => ({ url: l.url, label: l.label })) };
    else if (event.type === 'progress') item = { type: event.type, message: event.message };
    if (item) { state.events = [...state.events, item].slice(-20); update(); }
  }
  function prompt(request, current) {
    if (flow !== current || current.controller.signal.aborted || request.signal?.aborted) return Promise.reject(new Error('Login cancelled'));
    if (current.pending) return Promise.reject(new Error('Overlapping login prompts'));
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const finish = (error, value) => {
        request.signal?.removeEventListener('abort', abort);
        current.controller.signal.removeEventListener('abort', abort);
        if (current.pending?.id === id) { current.pending = null; state.prompt = null; update(); }
        error ? reject(error) : resolve(value);
      };
      const abort = () => finish(new Error('Login cancelled'));
      current.pending = { id, finish };
      state.prompt = { id, type: request.type, message: request.message, placeholder: request.placeholder,
        ...(request.type === 'select' ? { options: request.options.map(o => ({ id: o.id, label: o.label, description: o.description })) } : {}) };
      request.signal?.addEventListener('abort', abort, { once: true });
      current.controller.signal.addEventListener('abort', abort, { once: true });
      update();
    });
  }
  // Claude Code's and Codex's sign-ins are their own, so Pi at work does not
  // hold them up (the tab host waits for their own sessions); one sign-in at
  // a time still.
  const ownSignIn = providerId => ['claude-agent', 'codex'].includes(providerId);
  function ready(providerId) {
    if (!ownSignIn(providerId)) assertIdle();
    else if (flow) throw new Error('Finish or cancel the sign-in already under way');
  }
  function begin(providerId, method, logout = false) {
    ready(providerId);
    const provider = providers().find(p => p.id === providerId) ?? (logout ? { id: providerId, name: providerId } : null);
    if (!provider) throw new Error('Unknown login provider');
    if (!logout && !provider.methods.some(m => m.type === method && !m.ambient)) throw new Error('Unsupported login method; ambient credentials are configured outside this console');
    const current = { controller: new AbortController(), pending: null, done: null };
    flow = current;
    state = { id: randomUUID(), status: 'working', providerId, providerName: provider.name, method, prompt: null, events: [], message: logout ? 'Removing stored credentials…' : providerId === 'claude-agent' ? 'Starting Claude Code subscription sign-in…' : providerId === 'codex' ? 'Starting Codex sign-in…' : 'Starting Pi sign-in…' };
    update();
    const timer = setTimeout(() => current.controller.abort(), logout ? 15000 : timeoutMs);
    current.done = (async () => {
      const runtime = models();
      try {
        const interaction = { signal: current.controller.signal, prompt: p => prompt(p, current), notify: e => notify(e, current) };
        const harness = { 'claude-agent': claude, codex }[providerId];
        if (harness) {
          if (logout) await harness.logout(interaction);
          else await harness.login(interaction);
        } else if (logout) await runtime.logout(providerId, { signal: current.controller.signal });
        else await runtime.login(providerId, method, interaction);
        state.status = 'success';
        state.message = logout ? 'Stored credentials removed. Environment and cloud credentials are unchanged.' : 'Signed in. Credentials saved in this console’s own profile.';
        // The same supported catalog refresh used after terminal Pi login. This
        // fetches metadata only, not a model turn; failure cannot undo login.
        if (!logout && providerId === 'claude-agent') state.message = 'Signed in to Claude Code. Claude uses your Claude subscription, including extra usage if you enabled it in Claude. Pi Anthropic credentials are never used.';
        if (!logout && providerId === 'codex') state.message = 'Signed in to Codex. Codex uses your ChatGPT subscription.';
        if (!logout && !harness) {
          state.message = 'Signed in. Updating the provider’s model list…'; update();
          const refreshSignal = AbortSignal.any([current.controller.signal, AbortSignal.timeout(15000)]);
          try {
            const result = await runtime.refresh({ providers: [providerId], allowNetwork: true, signal: refreshSignal });
            state.message = result.aborted || result.errors.size
              ? 'Signed in, but the model list could not be refreshed. A cached model is used until it can be.'
              : 'Signed in.';
          } catch { state.message = 'Signed in, but the model list could not be refreshed. A cached model is used until it can be.'; }
        }
      } catch (error) {
        // A cancellation racing the commit can leave saved credentials. Pi tells
        // us explicitly; don't misreport that as an unsaved/cancelled login.
        if (error instanceof CredentialSynchronizationError) {
          state.status = 'warning';
          state.message = logout ? 'Credentials removed, but local model state could not be updated. Restart this console.' : 'Credentials saved, but local model state could not be updated. Restart this console; do not repeat sign-in blindly.';
        } else {
          state.status = current.controller.signal.aborted ? 'cancelled' : 'error';
          // Provider exceptions may contain submitted keys/codes. Never log or
          // return them to a transcript/browser; the user can retry explicitly.
          state.message = current.controller.signal.aborted ? 'Sign-in cancelled or timed out; check accounts before retrying if authorization just completed.' : providerId === 'claude-agent' ? 'Claude Code could not complete sign-in. Check your Claude subscription and try again.' : providerId === 'codex' ? 'Codex could not complete sign-in. Check your ChatGPT account allows device code sign-in, and try again.' : 'Pi could not complete sign-in. Check the provider/account and try again.';
        }
      } finally {
        clearTimeout(timer);
        // Cancellation/error can race a credential commit too. Refresh every
        // conversation's independent model snapshot before admitting prompts.
        if (!ownSignIn(providerId)) {
          try { await onAuthChanged?.(); }
          catch { state.status = 'warning'; state.message = 'Sign-in changed, but open sessions could not refresh their account state. Check sign-in before sending.'; }
        }
        current.pending?.finish(new Error('Login ended'));
        state.prompt = null; state.events = []; flow = null; update();
      }
    })();
    return { started: true };
  }
  return {
    get busy() { return Boolean(flow); },
    // Made again only when sign-in changes; listing the providers each time
    // a word streamed was most of a snapshot's work.
    snapshot() {
      return view ??= {
        ...state, busy: Boolean(flow),
        configured: providers().some(p => p.configured),
        availableModels: models().getAvailableSnapshot().filter(m => m.provider !== 'anthropic').length + (claude.configured() ? 1 : 0) + (codex.configured() ? 1 : 0),
      };
    },
    providers,
    async accounts() {
      const runtime = models();
      const pi = (await runtime.listCredentials({ signal: AbortSignal.timeout(15000) })).map(c => ({ id: c.providerId, name: c.providerId === 'anthropic' ? 'Pi Anthropic · NOT USED' : CHATGPT_NAMES[c.providerId] ?? runtime.getProvider(c.providerId)?.name ?? c.providerId, type: c.type,
        ...(c.providerId === 'anthropic' ? { note: 'Not used. Claude runs only in Claude Code; you can remove this old Pi credential.' } : {}) }));
      return [...(claude.configured() ? [{ id: 'claude-agent', name: 'Claude Code · Claude subscription', type: 'oauth' }] : []),
        ...(codex.configured() ? [{ id: 'codex', name: 'Codex · ChatGPT subscription', type: 'oauth' }] : []), ...pi];
    },
    login: (providerId, method) => begin(providerId, method),
    async logout(providerId) {
      ready(providerId);
      const stored = await this.accounts();
      if (!stored.some(c => c.id === providerId)) throw new Error('No stored credential to remove; environment credentials are unchanged');
      return begin(providerId, undefined, true); // rechecks idle after enumeration
    },
    answer(id, value) {
      if (!flow?.pending || flow.pending.id !== id) throw new Error('Login prompt expired or already answered');
      if (typeof value !== 'string' || value.length > 20000 || !value.trim()) throw new Error('A nonempty answer is required (maximum 20000 characters)');
      if (state.prompt.type === 'select' && !state.prompt.options.some(o => o.id === value)) throw new Error('Invalid login choice');
      flow.pending.finish(null, value); // never return/persist an answer ourselves
    },
    async cancel() { if (flow) { const current = flow; current.controller.abort(); await current.done; } },
    dismiss() { if (flow) throw new Error('Cancel sign-in before dismissing it'); state = { status: 'idle', prompt: null, events: [] }; update(); },
  };
}
