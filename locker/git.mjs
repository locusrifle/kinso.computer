// The product is a git repository, and a key is what opens it.
//
// Members clone https://<host>/imperfect.git with their key as the
// password (or the user name; git asks for both and people put it anywhere).
// Git's own smart-HTTP server, `git http-backend`, does the protocol work;
// this file only decides who may ask.
//
// Members clone and fetch. Only Locus pushes, main, with his own key, as the
// handle hooks/pre-receive names; it also refuses anything that looks like a
// secret. Any other path under the repository is refused rather than served
// as a dumb file.

import { spawn } from 'node:child_process';
import { basename, dirname, join } from 'node:path';
import { MAINTAINER } from './hooks/pre-receive.mjs';

export const REPO_NAME = 'imperfect.git';
export const OS_REPO_NAME = 'imperfect-os.git';
const HOOKS = join(import.meta.dirname, 'hooks');

// "Basic base64(user:password)" -> the first ic_ key found in either half.
export function keyFromAuthorization(header, pattern) {
  const match = /^Basic\s+([A-Za-z0-9+/=]+)\s*$/i.exec(String(header ?? ''));
  if (!match) return '';
  const decoded = Buffer.from(match[1], 'base64').toString('utf8');
  const at = decoded.indexOf(':');
  const parts = at < 0 ? [decoded] : [decoded.slice(at + 1), decoded.slice(0, at)];
  return parts.find(part => pattern.test(part)) ?? '';
}

export function isGitPath(path, name = REPO_NAME) {
  return path === `/${name}` || path.startsWith(`/${name}/`);
}

export function createGitHost({ repo, store, keyPattern, limiter, clientKey, log = console, git = 'git', name = REPO_NAME, product = 'code', readOnly = false }) {
  const REFS = `/${name}/info/refs`;
  const UPLOAD = `/${name}/git-upload-pack`;
  const RECEIVE = `/${name}/git-receive-pack`;
  const refuse = (res, status, message, headers = {}) => {
    res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', vary: 'Authorization', ...headers });
    res.end(`${message}\n`);
  };
  const challenge = (res, message) => refuse(res, 401, message, { 'www-authenticate': 'Basic realm="the imperfect repo", charset="UTF-8"' });

  return async function serveGit(req, res, path, search) {
    if (!repo) return refuse(res, 404, 'the imperfect repo has not been published yet');
    const params = new URLSearchParams(search);
    const service = req.method === 'GET' && path === REFS ? params.get('service') : '';
    const push = service === 'git-receive-pack' || (req.method === 'POST' && path === RECEIVE);
    if (!push && service !== 'git-upload-pack' && !(req.method === 'POST' && path === UPLOAD)) return refuse(res, 403, 'this repository is cloned, fetched and pushed to, nothing else');

    const key = keyFromAuthorization(req.headers.authorization, keyPattern);
    if (!key) return challenge(res, 'use your imperfect repo key as the password');
    const license = store.activeLicense(key, product);
    if (!license) {
      // A wrong guess costs a minute's budget; a right key never counts.
      if (!limiter.allow(`git-miss:${clientKey(req)}`)) return refuse(res, 429, 'slow down');
      return challenge(res, 'that key does not open anything (revoked, or mistyped)');
    }
    if (push && readOnly) return refuse(res, 403, 'members clone and fetch; this repository is read-only');
    const handle = push ? store.buyer(license.buyer_id)?.handle : '';
    if (push && handle !== MAINTAINER) return refuse(res, 403, 'members clone and fetch; only Locus pushes to this repository');
    if (push && !limiter.allow(`push:${license.key}`)) return refuse(res, 429, 'slow down');
    if (service === 'git-upload-pack') store.countDownload(license.key);

    const env = {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      GIT_PROJECT_ROOT: dirname(repo),
      GIT_HTTP_EXPORT_ALL: '1',
      PATH_INFO: `/${basename(repo)}${path.slice(name.length + 1)}`,
      REQUEST_METHOD: req.method,
      QUERY_STRING: search.replace(/^\?/, ''),
      CONTENT_TYPE: String(req.headers['content-type'] ?? ''),
      REMOTE_USER: `buyer-${license.buyer_id}`,
      REMOTE_ADDR: clientKey(req),
      GIT_CONFIG_NOSYSTEM: '1',
      HOME: dirname(repo),
      // For hooks/pre-receive: whose folder this push may write, and the node
      // that runs it (a service's PATH need not have one).
      IMPERFECT_HANDLE: handle,
      IMPERFECT_NODE: process.execPath,
    };
    if (req.headers['content-length']) env.CONTENT_LENGTH = String(req.headers['content-length']);
    if (req.headers['content-encoding']) env.HTTP_CONTENT_ENCODING = String(req.headers['content-encoding']);
    if (req.headers['git-protocol']) env.GIT_PROTOCOL = String(req.headers['git-protocol']);

    const config = push ? ['-c', 'http.receivepack=true', '-c', `core.hooksPath=${HOOKS}`, '-c', 'receive.maxInputSize=50m'] : ['-c', 'http.receivepack=false'];
    const child = spawn(git, [...config, '-c', 'http.uploadarch=false', 'http-backend'], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', chunk => { if (stderr.length < 4096) stderr += chunk; });
    child.on('error', error => {
      log.error(`git http-backend: ${error.message}`);
      if (!res.headersSent) refuse(res, 500, 'the repository is unavailable');
    });
    req.pipe(child.stdin);
    req.on('aborted', () => child.kill('SIGTERM'));
    res.on('close', () => { if (child.exitCode == null) child.kill('SIGTERM'); });

    // CGI: header lines, a blank line, then the body as-is.
    let head = Buffer.alloc(0);
    let started = false;
    child.stdout.on('data', chunk => {
      if (started) { res.write(chunk); return; }
      head = Buffer.concat([head, chunk]);
      let end = head.indexOf('\r\n\r\n');
      let gap = 4;
      if (end < 0) { end = head.indexOf('\n\n'); gap = 2; }
      if (end < 0) {
        if (head.length > 16 * 1024) { child.kill('SIGTERM'); refuse(res, 502, 'the repository answered strangely'); }
        return;
      }
      started = true;
      let status = 200;
      const headers = { 'cache-control': 'no-store', vary: 'Authorization' };
      for (const line of head.subarray(0, end).toString('latin1').split(/\r?\n/)) {
        const colon = line.indexOf(':');
        if (colon < 0) continue;
        const name = line.slice(0, colon).trim().toLowerCase();
        const value = line.slice(colon + 1).trim();
        if (name === 'status') status = Number.parseInt(value, 10) || 200;
        else if (name !== 'cache-control' && name !== 'expires' && name !== 'vary') headers[name] = value;
      }
      res.writeHead(status, headers);
      const rest = head.subarray(end + gap);
      if (rest.length) res.write(rest);
    });
    child.stdout.on('end', () => {
      if (!started && !res.headersSent) refuse(res, 502, 'the repository answered nothing');
      else res.end();
    });
    child.on('close', code => {
      if (code) log.warn(`git http-backend exited ${code}: ${stderr.trim().slice(0, 500)}`);
    });
  };
}
