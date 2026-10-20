import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
export function claudeExecutable() {
  // Use the same installed Claude Code as the Agent SDK, not a mise shim
  // or an independently upgraded CLI. No standalone terminal install needed.
  const name = `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}`;
  for (const suffix of ['', '-musl']) {
    try { return require.resolve(`${name}${suffix}/${process.platform === 'win32' ? 'claude.exe' : 'claude'}`); }
    catch { /* only this computer's optional native package is installed */ }
  }
  return 'claude';
}

let authRevision = 0;
export const claudeAuthRevision = () => authRevision;

const loginDir = (env = process.env) => join(env.HOME || homedir(), '.imperfect', 'credentials', 'claude');
export const claudeConfigDir = (env = process.env) => env.CLAUDE_CONFIG_DIR?.trim() || join(env.HOME || homedir(), '.claude');
// Keep Claude's sessions/config where its SDK expects them. Only its secure
// storage moves: new sign-ins live in the private credentials tree. Existing
// terminal sign-ins still work until the person signs in here. Logout never
// silently falls back to the old account (the private directory remains).
const credentialDir = (env = process.env, login = false) => login || existsSync(loginDir(env)) ? loginDir(env) : claudeConfigDir(env);

// On a Mac Claude Code keeps a sign-in in the login keychain, not in a file:
// the item "Claude Code-credentials", followed by "-" and eight hex digits of
// its secure storage folder's sha256 when that folder is named (Claude Code's
// own rule). The person's terminal sign-in is the unnamed one, so for
// ~/.claude the folder is left unnamed ('') and imperfect shares it, as both
// share ~/.claude/.credentials.json on Linux; a sign-in made in imperfect is
// kept under its private folder's name.
const MAC = process.platform === 'darwin';
export const secureStorageDir = (env = process.env, login = false, mac = MAC) => {
  const dir = credentialDir(env, login);
  return mac && dir === claudeConfigDir(env) && !env.CLAUDE_CONFIG_DIR?.trim() ? '' : dir;
};
export const keychainService = folder => `Claude Code-credentials${folder ? `-${createHash('sha256').update(folder.normalize('NFC')).digest('hex').slice(0, 8)}` : ''}`;
const keychainAccount = env => { let name; try { name = env.USER || userInfo().username; } catch { name = ''; } return /^[a-zA-Z0-9._-]+$/.test(name ?? '') ? name : 'claude-code-user'; };
// The sign-in in the keychain, asked of `security` as Claude Code asks it;
// kept a few seconds, as it is asked for at every turn.
const keychainKept = new Map();
function keychainOauth(env) {
  const service = keychainService(secureStorageDir(env)), account = keychainAccount(env), key = `${account} ${service}`;
  const kept = keychainKept.get(key);
  if (kept && Date.now() - kept.at < 5000) return kept.oauth;
  let oauth = null;
  try {
    const text = execFileSync('/usr/bin/security', ['find-generic-password', '-a', account, '-w', '-s', service], { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] });
    oauth = JSON.parse(text.trim()).claudeAiOauth ?? null;
  } catch { /* none, or not readable */ }
  keychainKept.set(key, { at: Date.now(), oauth });
  return oauth;
}

// A long-lived Claude Code token (`claude setup-token`) the computer's owner
// put beside the sign-ins, for several accounts to share one subscription
// (e.g. every workbench on a shared computer). It is never refreshed, so
// copies cannot sign each other out. A person's own sign-in comes first.
const tokenFile = (env = process.env) => join(env.HOME || homedir(), '.imperfect', 'credentials', 'claude-token');
export function sharedClaudeToken(env = process.env) {
  try {
    const token = readFileSync(tokenFile(env), 'utf8').trim();
    return /^sk-ant-oat\d\d-[A-Za-z0-9_-]{20,}$/.test(token) ? token : null;
  } catch { return null; }
}

// No API keys, alternate endpoints, helpers or cloud-provider selectors can
// override the subscription. SDK env replaces (rather than merges) its env, so
// keep everything else an agent's tools rely on (systemd's user bus, the
// display, imperfect's port, NixOS's loader) and drop only what could reroute
// billing or inject code.
const BILLING = /^(ANTHROPIC_|AWS_|CLOUD_ML_|GOOGLE_|VERTEX_|CLAUDE_CODE_(OAUTH_TOKEN|USE_|SKIP_|API_KEY|CLIENT_)|NODE_OPTIONS$)/;
export function claudeSubscriptionEnv(env = process.env, { login = false } = {}) {
  const out = {};
  for (const [key, value] of Object.entries(env)) if (value !== undefined && !BILLING.test(key)) out[key] = value;
  out.CLAUDE_CONFIG_DIR = claudeConfigDir(env);
  out.CLAUDE_SECURESTORAGE_CONFIG_DIR = secureStorageDir(env, login);
  // Only the owner's token file, never an inherited variable, and never
  // while signing in (that saves the person's own account).
  const shared = !login && !signedIn(env) && sharedClaudeToken(env);
  if (shared) out.CLAUDE_CODE_OAUTH_TOKEN = shared;
  out.BROWSER = MAC ? '/usr/bin/true' : '/bin/true'; // no separate browser, even on a local desktop
  return out;
}

function signedIn(env) {
  try {
    const oauth = MAC ? keychainOauth(env) : JSON.parse(readFileSync(join(credentialDir(env), '.credentials.json'), 'utf8')).claudeAiOauth;
    return Boolean(oauth?.accessToken && oauth.scopes?.includes('user:inference'));
  } catch { return false; }
}

// 'login' (this account's own sign-in), 'token' (the shared token) or null.
export function claudeAuth(env = process.env) {
  return signedIn(env) ? 'login' : sharedClaudeToken(env) ? 'token' : null;
}

const authorizationURL = text => {
  for (const match of text.matchAll(/https:\/\/[^\s\x00-\x20\x7f<>]+(?=[\s\x00-\x20\x7f<>])/g)) {
    try {
      const url = new URL(match[0]);
      const redirect = new URL(url.searchParams.get('redirect_uri'));
      if (['claude.com', 'claude.ai'].includes(url.hostname) && url.pathname === '/cai/oauth/authorize' && !url.username && !url.password && url.port === '' &&
          ['platform.claude.com', 'console.anthropic.com'].includes(redirect.hostname) && redirect.protocol === 'https:' && redirect.pathname === '/oauth/code/callback' &&
          url.searchParams.get('state') && url.searchParams.get('code_challenge')) return url;
    } catch { /* ignore all non-authorization output */ }
  }
  return null;
};

// Signing in or out never opens a window on this computer: the person uses the web form.
const noWindow = env => { delete env.DISPLAY; delete env.WAYLAND_DISPLAY; return env; };
export function createClaudeSignIn({ spawnImpl = spawn, env = process.env } = {}) {
  const childEnv = () => claudeSubscriptionEnv(env, { login: true });
  // Output is never logged/returned verbatim, including provider errors.
  function run(args, signal, onOutput, onEnd) {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(new Error('Login cancelled'));
      const child = spawnImpl(claudeExecutable(), ['--setting-sources', '', 'auth', ...args], { env: noWindow(args[0] === 'logout' ? claudeSubscriptionEnv(env) : childEnv()), shell: false, stdio: ['pipe', 'pipe', 'ignore'] });
      let ended = false, killTimer;
      const abort = () => { if (ended) return; child.kill('SIGTERM'); killTimer ??= setTimeout(() => child.kill('SIGKILL'), 1000).unref(); };
      signal?.addEventListener('abort', abort, { once: true });
      child.on('error', () => finish(new Error('Claude Code authentication could not start')));
      child.on('close', code => finish(code === 0 && !signal?.aborted ? null : new Error('Claude Code authentication did not complete')));
      child.stdout.on('data', chunk => onOutput?.(String(chunk), child, abort));
      child.stdin.on('error', abort); // e.g. callback won while code was being pasted
      if (signal?.aborted) abort();
      function finish(error) {
        if (ended) return;
        ended = true; clearTimeout(killTimer); signal?.removeEventListener('abort', abort);
        onEnd?.();
        error ? reject(error) : resolve();
      }
    });
  }
  async function verify(signal) {
    let output = '';
    await run(['status', '--json'], signal, chunk => { if (output.length < 16000) output += chunk; });
    const status = JSON.parse(output);
    if (!status.loggedIn || status.authMethod !== 'claude.ai' || status.apiProvider !== 'firstParty' || (status.apiKeySource && status.apiKeySource !== 'none') || !claudeAuth(childEnv())) {
      throw new Error('Claude Code subscription credentials were not saved');
    }
  }
  return {
    configured: () => claudeAuth(env),
    async login(interaction) {
      // A Mac keeps the sign-in in the keychain, so nothing makes the private
      // folder; made here, it says where this computer's sign-in now is.
      if (MAC) mkdirSync(loginDir(env), { recursive: true, mode: 0o700 });
      let output = '', offered = false, input = null;
      const promptController = new AbortController();
      try {
        await run(['login', '--claudeai'], interaction.signal, (chunk, child, abort) => {
          if (offered) return;
          output = (output + chunk).slice(-32000);
          const url = authorizationURL(output);
          if (!url) return;
          offered = true; output = '';
          interaction.notify({ type: 'auth_url', url: url.href, instructions: 'Open this Claude sign-in page, choose your Claude subscription, then copy the full code back here. No terminal or browser on the hosted computer is needed.' });
          input = (async () => {
            const answer = (await interaction.prompt({ type: 'manual_code', message: 'Paste the full Claude authorization code (code#state)', signal: promptController.signal })).trim();
            const parts = answer.split('#');
            if (parts.length !== 2 || !/^[\x21-\x7e]+$/.test(parts[0]) || parts[1] !== url.searchParams.get('state')) throw new Error('Invalid Claude authorization code');
            if (interaction.signal.aborted || promptController.signal.aborted) throw new Error('Login ended');
            child.stdin.write(answer + '\n'); // never argv, transcript, storage or logs
          })().catch(() => { if (!promptController.signal.aborted) abort(); });
        }, () => promptController.abort());
        await verify(interaction.signal);
      } finally {
        authRevision++; // an idle SDK child may have cached the previous account
        keychainKept.clear();
        promptController.abort();
        await input;
      }
    },
    async logout({ signal }) { try { await run(['logout'], signal); } finally { authRevision++; keychainKept.clear(); } },
  };
}

export const claudeSignIn = createClaudeSignIn();
