import { createHash, timingSafeEqual } from 'node:crypto';

export const digest = value => createHash('sha256').update(String(value)).digest('hex');

// Compare fixed-size digests, including when the input lengths differ. Never
// coerce missing/non-string CSRF tokens into something that could compare equal.
export function equal(a, b) {
  // UTF-16 preserves every JS code unit (unlike UTF-8's replacement of lone
  // surrogates), so distinct strings cannot share an encoding accidentally.
  const fixed = value => createHash('sha256').update(Buffer.from(typeof value === 'string' ? value : '', 'utf16le')).digest();
  const same = timingSafeEqual(fixed(a), fixed(b));
  return same && typeof a === 'string' && typeof b === 'string';
}
