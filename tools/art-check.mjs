// Prove the sampler by making it redraw someone else's logo.
//
// The Omarchy Font reproduces the OMARCHY wordmark pixel for pixel, and
// Omarchy ships that wordmark as a text file. So sampling the word "omarchy"
// has exactly one correct answer, and it is on disk. If the grid maths were
// off by anything at all, this would not match.

import { readFile } from 'node:fs/promises';
import { withSampler } from './sample.mjs';

const OMARCHY_LOGO = process.env.OMARCHY_LOGO ?? '/usr/share/omarchy/logo.txt';

function dedentText(text) {
  const lines = text.replace(/^\n+/, '').replace(/\n+$/, '').split('\n').map((line) => line.replace(/\s+$/, ''));
  let indent = Infinity;
  for (const line of lines) {
    if (line === '') continue;
    indent = Math.min(indent, line.length - line.trimStart().length);
  }
  if (!Number.isFinite(indent) || indent === 0) return lines.join('\n');
  return lines.map((line) => line.slice(indent)).join('\n');
}

await withSampler(async (sample) => {
  let expected = null;
  try {
    expected = await readFile(OMARCHY_LOGO, 'utf8');
  } catch {
    process.stdout.write(`skip: ${OMARCHY_LOGO} is not on this machine\n`);
  }

  if (expected !== null) {
    const want = dedentText(expected);
    const got = await sample('omarchy');
    if (got !== want) {
      process.stdout.write(`want:\n${want}\n\ngot:\n${got}\n`);
      throw new Error("the sampled wordmark does not match Omarchy's own logo.txt");
    }
    process.stdout.write('omarchy: the sampler reproduces logo.txt exactly\n');
  }

  const word = process.env.WORD ?? 'imperfect';
  const art = await sample(word);
  if (art.trim() === '') throw new Error(`${word} sampled empty`);
  const columns = Math.max(...art.split('\n').map((line) => [...line].length));
  process.stdout.write(`${word}: ${art.split('\n').length} rows x ${columns} columns\n\n${art}\n`);
});
