// The themes the browser tests draw in. imperfect ships Mac · Dark, Mac ·
// Light (themes/); Black and Light · Chalk, a black ground and a
// pale one, and two coloured grounds are kept here, out of the picker, so the
// pixel checks keep the grounds they were written on. Any other id is a
// shipped theme.
import { readFile } from 'node:fs/promises';
import { readTheme } from '../../../../../system/theme.mjs';

export async function testTheme(id) {
  try { return { id, ...JSON.parse(await readFile(new URL(`./themes/${id}.json`, import.meta.url), 'utf8')) }; }
  catch { return readTheme(id, '/nonexistent/imperfect-test-home'); }
}
