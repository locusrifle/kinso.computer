// Every push to the repository passes here before it lands (git.mjs points
// core.hooksPath at this folder for pushes over the store, and hands over the
// pusher's handle). Only Locus pushes, and only main; what he pushes must not
// look like a secret, because every member can read it.
//
// Git feeds "<old> <new> <ref>" lines on stdin; anything written to stderr
// reaches the pusher as "remote: …", and exiting non-zero refuses the lot.
// A push straight into the bare repository on the PC has no handle and is not
// checked; ship over the store (git push origin main) so it is.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

export const MAINTAINER = 'locus';

// What must never reach the repository.
export const SECRETS = [
  [/sk_(live|test)_[A-Za-z0-9]{16,}/, 'Stripe secret key'],
  [/rk_(live|test)_[A-Za-z0-9]{16,}/, 'Stripe restricted key'],
  [/whsec_[A-Za-z0-9]{16,}/, 'Stripe webhook secret'],
  [/\bam_[a-z]{2}_[a-f0-9]{32,}/, 'an AgentMail key'],
  [/\bic_[a-f0-9]{40}\b/, 'a membership key'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'a private key'],
  [/\btskey-[a-z]+-[A-Za-z0-9]{8,}/, 'a Tailscale key'],
  [/\bsk-ant-[A-Za-z0-9_-]{20,}/, 'an Anthropic key'],
  [/\bsk-(proj-)?[A-Za-z0-9_-]{32,}/, 'an OpenAI-style key'],
  [/\bgh[pousr]_[A-Za-z0-9]{30,}/, 'a GitHub token'],
  [/\bxox[abpr]-[A-Za-z0-9-]{10,}/, 'a Slack token'],
];

const handle = process.env.IMPERFECT_HANDLE ?? '';
const ZERO = /^0+$/;

export function check(lines, handle, patchOf) {
  const problems = [];
  for (const line of lines) {
    const [, next, ref] = line.trim().split(/\s+/);
    if (!ref) continue;
    const main = handle === MAINTAINER && ref === 'refs/heads/main';
    if (!main) { problems.push(`${ref.replace(/^refs\/heads\//, '')}: only Locus pushes, and only main`); continue; }
    if (ZERO.test(next)) { problems.push('main: it cannot be deleted'); continue; }
    const patch = patchOf(next);
    for (const [pattern, what] of SECRETS) {
      if (pattern.test(patch)) problems.push(`${ref.replace(/^refs\/heads\//, '')}: it holds what looks like ${what}; take it out of the commits (not just the last one) and push again`);
    }
  }
  return problems;
}

// What this push adds: every new commit's message and changes, and nothing
// already in the repository.
const patchOf = next => execFileSync('git', ['log', '-p', '--format=%B', next, '--not', '--all'], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });

if (process.argv[1] === import.meta.filename && handle) {
  const problems = check(readFileSync(0, 'utf8').split('\n'), handle, patchOf);
  if (problems.length) {
    process.stderr.write(`refused:\n${problems.map(p => `  ${p}`).join('\n')}\n`);
    process.exitCode = 1;
  }
}
