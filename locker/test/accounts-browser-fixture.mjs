// Loopback-only services. No real account, credential or installed service is used.
import { createServer, request } from 'node:http';
import { createServer as createTLS, request as tlsRequest } from 'node:https';
import { randomBytes, sign } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

const exec = promisify(execFile);
export const STORE = 'https://imperfect.computer';
export const COMPUTER = 'https://alder.imperfect.computer';
export const random = () => randomBytes(32).toString('base64url');
export function jwt(key, claims) {
  const input = [{ alg: 'EdDSA', typ: 'JWT' }, claims].map(x => Buffer.from(JSON.stringify(x)).toString('base64url')).join('.');
  return `${input}.${sign(null, Buffer.from(input), key).toString('base64url')}`;
}
export async function listen(server) {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return server.address().port;
}
export async function close(server) {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
// Generate a throwaway certificate, never use a machine certificate or a secret file.
export async function httpsProxy(root, python, storePort) {
  await exec(python, ['-c', `
import datetime, pathlib, sys
from cryptography import x509
from cryptography.x509.oid import NameOID
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
root = pathlib.Path(sys.argv[1])
key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, 'accounts loopback fixture')])
now = datetime.datetime.now(datetime.timezone.utc)
cert = (x509.CertificateBuilder().subject_name(name).issuer_name(name).public_key(key.public_key())
 .serial_number(x509.random_serial_number()).not_valid_before(now - datetime.timedelta(minutes=1))
 .not_valid_after(now + datetime.timedelta(days=1))
 .add_extension(x509.SubjectAlternativeName([x509.DNSName('imperfect.computer'), x509.DNSName('*.imperfect.computer')]), False)
 .sign(key, hashes.SHA256()))
(root / 'tls-key.pem').write_bytes(key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()))
(root / 'tls-cert.pem').write_bytes(cert.public_bytes(serialization.Encoding.PEM))
`, root]);
  let doorPort;
  const forward = (req, res, port, path = req.url, headers = req.headers) => {
    const upstream = request({ host: '127.0.0.1', port, path, method: req.method, headers }, response => {
      res.writeHead(response.statusCode, response.headers); response.pipe(res);
    });
    upstream.on('error', () => { if (!res.headersSent) res.writeHead(503); res.end('fixture upstream offline'); });
    req.pipe(upstream);
  };
  const server = createTLS({ key: await readFile(join(root, 'tls-key.pem')), cert: await readFile(join(root, 'tls-cert.pem')) }, (req, res) => {
    const hostname = req.headers.host?.split(':')[0];
    if (hostname === 'imperfect.computer') return forward(req, res, storePort);
    if (hostname !== 'alder.imperfect.computer' || !doorPort) { res.writeHead(503); res.end(); return; }
    // Like Caddy, overwrite forwarded client headers; never trust the caller's.
    const headers = { ...req.headers, 'x-forwarded-for': '127.0.0.1', 'x-forwarded-proto': 'https' };
    if (req.url.startsWith('/door/')) return forward(req, res, doorPort, req.url, headers);
    const check = request({ host: '127.0.0.1', port: doorPort, path: '/door/check', headers: {
      ...headers, 'x-forwarded-method': req.method, 'x-forwarded-uri': req.url,
    } }, response => {
      response.resume();
      if (response.statusCode !== 200) { res.writeHead(response.statusCode, response.headers); res.end(); return; }
      res.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' });
      res.end('<!doctype html><h1>Your fixture computer</h1>');
    });
    check.on('error', () => { res.writeHead(503); res.end('fixture door offline'); }); check.end();
  });
  const port = await listen(server);
  const call = (origin, path, { method = 'GET', headers = {}, body } = {}) => new Promise((resolve, reject) => {
    const req = tlsRequest({ host: '127.0.0.1', port, servername: new URL(origin).hostname, rejectUnauthorized: false,
      path, method, headers: { host: new URL(origin).host, ...headers } }, res => {
      const chunks = []; res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject); req.end(body);
  });
  return { server, port, call, setDoorPort(value) { doorPort = value; } };
}

export async function startDoor({ root, python, source, registry }) {
  const state = join(root, 'door-state'); await mkdir(state, { recursive: true });
  const publicKey = join(root, 'store-public.pem'); await writeFile(publicKey, registry.publicKey);
  const portServer = createServer(); const port = await listen(portServer); await close(portServer);
  const child = spawn(python, [source], { env: { PATH: process.env.PATH, LANG: 'C.UTF-8',
    DOOR_PORT: String(port), DOOR_USER: 'fixture-not-an-os-account', STATE_DIRECTORY: state,
    DOOR_PAGE: join(source, '../login.html'), DOOR_FONT: join(source, '../SpaceMono-Regular.woff2'),
    DOOR_SSO_STORE: registry.store, DOOR_SSO_COMPUTER: registry.computerId,
    DOOR_SSO_OWNER: registry.owner, DOOR_SSO_PUBLIC_KEY: publicKey,
  }, stdio: ['ignore', 'pipe', 'pipe'] });
  let logs = ''; child.stdout.on('data', b => { logs += b; }); child.stderr.on('data', b => { logs += b; });
  let exited = false; child.once('exit', () => { exited = true; });
  const stop = async () => { if (exited) return; await new Promise(resolve => { child.once('exit', resolve); child.kill('SIGTERM'); }); };
  try {
    for (let i = 0; i < 100; i++) {
      if (exited) throw new Error(`Python door exited: ${logs}`);
      try { await fetch(`http://127.0.0.1:${port}/door/check`); return { port, stop, logs: () => logs }; } catch {}
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error('Python door did not become ready');
  } catch (error) { await stop(); throw error; }
}
