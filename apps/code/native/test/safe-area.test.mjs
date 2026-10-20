import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const raw = await readFile(new URL('../public/css/imperfect.css', import.meta.url), 'utf8');
// Comments carry selectors' worth of punctuation; drop them before reading.
const css = raw.replace(/\/\*[\s\S]*?\*\//g, '');

// Every rule as { selector, body }, so a declaration can be asked about by
// where it sits rather than by whether the string appears somewhere in a file.
const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(m => ({
  selector: m[1].trim().replace(/\s+/g, ' '),
  body: m[2],
}));
const declaring = name => rules.filter(r => new RegExp(`(^|[;\\s])${name}\\s*:`).test(r.body));

for (const name of ['--safe-top', '--safe-bottom']) {
  test(`${name} is declared on the element the wrap writes to, and nowhere below it`, () => {
    const owners = declaring(name);
    assert.equal(owners.length, 1, `${name} is declared ${owners.length} times: ${owners.map(o => o.selector)}`);
    const [only] = owners;
    // The Android wrap sets these on document.documentElement. A second
    // declaration on body -- even the identical env() -- wins for everything
    // inside body, and env() is 0px in a WebView because a WebView is never
    // told where the cutout is. The composer then sat under the keyboard and
    // under the gesture bar instead of on top of them.
    assert.ok(only.selector.includes('html'), `${name} should be an html declaration, found: ${only.selector}`);
    assert.doesNotMatch(only.selector, /(^|,)\s*body/, `${name} must not be re-declared on body: ${only.selector}`);
  });
}

test('the canvas is inset by those variables, and a phone does not add margins of its own', () => {
  // The canvas stands between the status band and the gesture bar or the keys,
  // on every surface, from the one rule.
  const base = rules.find(r => r.selector === 'body.imperfect .canvas');
  assert.ok(base, 'expected the base canvas rule');
  assert.match(base.body, /top:\s*var\(--safe-top/);
  assert.match(base.body, /bottom:\s*var\(--safe-bottom/);
  // The phone is one app, not a window on a wallpaper: nothing re-insets the
  // canvas on a touch surface, so with the keys up the composer sits on them
  // and with them down the status line sits on the gesture bar.
  assert.equal(rules.filter(r => /\.canvas$/.test(r.selector) && /\b(top|bottom)\s*:/.test(r.body)).length, 1,
    'only the base rule places the canvas');
});

