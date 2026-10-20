import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { digest } from './account-security.mjs';

const common = new Set(['common-passwords.txt', 'common-passwords-extra.txt'].flatMap(file => readFileSync(new URL(file, import.meta.url), 'utf8').split(/\r?\n/).filter(line => line && !line.startsWith('#'))));
const CURRENT = { version: 2, N: 2 ** 17, r: 8, p: 1 };
const failure = message => Object.assign(new Error(message), { status: 400 });
// Reject malformed Unicode, whose lone surrogates UTF-8 would silently map to
// the replacement character, otherwise making distinct inputs hash identically.
const passwordSize = value => typeof value === 'string' && value.length <= 512 && value.isWellFormed() && [...value].length <= 256;

export function validatePassword(password, username) {
  if (!passwordSize(password) || [...password].length < 10) throw failure('choose a password of 10–256 characters; a passphrase works well');
  const folded = password.normalize('NFKC').toLowerCase();
  if (common.has(folded)) throw failure('that password is too common; choose a different password or passphrase');
  if (typeof username === 'string' && username && folded.includes(username.toLowerCase())) throw failure('choose a password that does not contain your username');
}

// One 128 MiB scrypt allocation at a time per process. A bounded FIFO prevents
// the libuv thread pool (or an unbounded request queue) from exhausting memory.
let active = false;
const waiting = [];
async function work(fn) {
  if (active) {
    if (waiting.length >= 32) throw Object.assign(new Error('busy; try again shortly'), { status: 429 });
    await new Promise(resolve => waiting.push(resolve));
  } else active = true;
  try { return await fn(); }
  finally {
    const next = waiting.shift();
    if (next) next();
    else active = false;
  }
}
const deriveRaw = (password, salt, { N, r, p }) => new Promise((resolve, reject) => {
  scrypt(password, salt, 32, { N, r, p, maxmem: 256 * 1024 * 1024 }, (error, key) => error ? reject(new Error('password work failed')) : resolve(key));
});
const derive = (password, salt, params) => work(() => deriveRaw(password, salt, params));
const verificationWork = Object.freeze(Array.from({ length: Math.log2(CURRENT.N) - 13 }, (_, i) => 2 ** (14 + i)));
const encode = (params, salt, key) => `scrypt$v${params.version}$N=${params.N},r=${params.r},p=${params.p}$${salt.toString('hex')}$${key.toString('hex')}`;
function parse(encoded) {
  if (typeof encoded !== 'string' || encoded.length > 200) return null;
  const match = /^scrypt\$v([12])\$N=([1-9]\d{0,5}),r=8,p=1\$([a-f0-9]{32})\$([a-f0-9]{64})$/.exec(encoded);
  if (!match) return null;
  const version = Number(match[1]), N = Number(match[2]);
  // Accept historical work factors, never attacker-selected unbounded work.
  if (N < 2 ** 14 || N > CURRENT.N || (N & (N - 1))) return null;
  return { version, N, r: 8, p: 1, salt: Buffer.from(match[3], 'hex'), key: Buffer.from(match[4], 'hex') };
}
// Fixed salt/key: no startup hash or random work-factor variance for unknown
// users. Verification ALWAYS returns false for this path, even if guessed.
const DUMMY = parse('scrypt$v2$N=131072,r=8,p=1$328b067edaee65a8bbf4ad03ff315741$4dc5f95acad76055c230cef3c00686741fc1ae006ffbb413f7394d7e06e7a493');
export async function hashPassword(password) {
  if (!passwordSize(password) || [...password].length < 10) throw failure('choose a password of 10–256 characters; a passphrase works well');
  const salt = randomBytes(16);
  return encode(CURRENT, salt, await derive(password, salt, CURRENT));
}
export async function verifyPassword(password, encoded) {
  const params = parse(encoded), validInput = passwordSize(password);
  const target = params ?? DUMMY;
  // Identical work schedule for current, historical, corrupt and nonexistent
  // records. Merely padding a legacy record's summed N leaves its different
  // allocation/cache profile distinguishable. Hold one FIFO slot throughout.
  return work(async () => {
    let key;
    for (const N of verificationWork) {
      const candidate = await deriveRaw(validInput ? password : 'invalid password input', target.salt, { ...CURRENT, N });
      if (N === target.N) key = candidate;
    }
    const same = timingSafeEqual(key, target.key);
    const ok = !!params && validInput && same;
    return { ok, needsUpgrade: ok && (params.version < CURRENT.version || params.N < CURRENT.N) };
  });
}

export function generateRecoveryCodes() {
  // 128 bits each, grouped for copying; no ambiguous Base64 case handling.
  return Array.from({ length: 8 }, () => randomBytes(16).toString('hex').match(/.{8}/g).join('-'));
}
export const recoveryDigest = code => digest(String(code ?? '').normalize('NFKC').replace(/[\s-]/g, '').toLowerCase());
