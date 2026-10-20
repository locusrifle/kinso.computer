import { test } from 'node:test';
import assert from 'node:assert/strict';
import { INSTALL_COMMAND, validOS, detectOS, resolveOS, installInstructions, bindInstallation } from '../public/store/shop-platform.mjs';
import { parseAmount, checkoutURL, readOffer, createShopController } from '../public/store/shop.js';

const offer = (codeOpen = true, rentOpen = false) => ({
  rent: { open: rentOpen, price: 40, currency: 'usd', period: 'month', href: '/account' },
  code: { open: codeOpen, min: 1, currency: 'usd' },
});
const response = (data, ok = true) => ({ ok, async json() { return data; } });
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

test('public visitor detection uses only the four canonical OS names', () => {
  for (const [visitor, expected] of [
    [{ platform: 'MacIntel' }, 'mac'],
    [{ userAgentData: { platform: 'macOS' } }, 'mac'],
    [{ platform: 'Win32' }, 'windows'],
    [{ userAgent: 'Windows NT 10.0' }, 'windows'],
    [{ platform: 'Linux x86_64' }, 'linux'],
    [{ userAgent: 'iPhone' }, 'mobile'],
    [{ userAgent: 'Android', platform: 'Linux' }, 'mobile'],
    [{ platform: 'MacIntel', maxTouchPoints: 5 }, 'mobile'],
    [{ userAgentData: { platform: 'Linux', mobile: true } }, 'mobile'],
    [{}, 'linux'],
  ]) assert.equal(detectOS(visitor), expected, JSON.stringify(visitor));
  for (const os of ['mac', 'linux', 'windows', 'mobile']) assert.equal(validOS(os), os);
  for (const os of ['', 'MAC', 'macos', 'phone', null, [], {}, 'mac&os=windows']) assert.equal(validOS(os), null);
});

test('exactly one validated query OS overrides VM navigator; absent, invalid or duplicate falls back', () => {
  const vm = { platform: 'Linux x86_64' };
  const mac = { platform: 'MacIntel' };
  for (const os of ['mac', 'linux', 'windows', 'mobile']) assert.equal(resolveOS(`?os=${os}`, vm), os);
  assert.equal(resolveOS(new URLSearchParams('os=windows'), mac), 'windows');
  for (const query of ['', '?x=mac', '?os=', '?os=MAC', '?os=macos', '?os=%3Cscript%3E', '?os=linux&os=mac', '?os=mac&os=mac', '?os=evil&os=mac']) {
    assert.equal(resolveOS(query, mac), 'mac', query);
    assert.equal(resolveOS(query, vm), 'linux', query);
  }
  assert.equal(resolveOS('?session=cs_test_example&os=mac', vm), 'mac');
});

test('installation switches change wording but never the public command', () => {
  assert.deepEqual(installInstructions('mac'), { platform: 'mac', label: 'Install on your Mac', hint: 'Open Terminal and paste this.', command: INSTALL_COMMAND });
  assert.equal(installInstructions('linux').hint, 'Paste this in a terminal.');
  assert.match(installInstructions('windows').hint, /WSL \(Ubuntu\)/);
  assert.equal(installInstructions('mobile').hint, 'Run this on your computer.');
  for (const os of ['mac', 'linux', 'windows', 'mobile']) {
    for (const platform of ['mac', 'linux']) {
      const info = installInstructions(os, platform);
      assert.equal(info.command, INSTALL_COMMAND); assert.equal(info.platform, platform);
      assert.equal(info.label, platform === 'mac' ? 'Install on your Mac' : 'Install on Linux');
    }
  }
});

test('shared installation bindings select OS, switch, copy and handle unavailable clipboard', async () => {
  function element(dataset = {}) {
    return { dataset, attributes: {}, handlers: {}, textContent: '',
      setAttribute(name, value) { this.attributes[name] = value; },
      addEventListener(name, handler) { this.handlers[name] = handler; },
    };
  }
  const nodes = Object.fromEntries(['install-label', 'install-hint', 'install-command', 'copy-command', 'copy-status'].map(id => ['#' + id, element()]));
  const buttons = [element({ platform: 'linux' }), element({ platform: 'mac' })];
  const root = { querySelector: selector => nodes[selector], querySelectorAll: () => buttons };
  let copied, failed = false;
  bindInstallation(root, 'mac', async command => { if (failed) throw new Error('clipboard blocked'); copied = command; });
  assert.equal(nodes['#install-label'].textContent, 'Install on your Mac');
  assert.equal(buttons[1].attributes['aria-pressed'], 'true');
  buttons[0].handlers.click();
  assert.equal(nodes['#install-label'].textContent, 'Install on Linux');
  assert.equal(buttons[0].attributes['aria-pressed'], 'true');
  assert.equal(buttons[1].attributes['aria-pressed'], 'false');
  await nodes['#copy-command'].handlers.click();
  assert.equal(copied, INSTALL_COMMAND); assert.equal(nodes['#copy-status'].textContent, 'Copied.');
  failed = true;
  await nodes['#copy-command'].handlers.click();
  assert.match(nodes['#copy-status'].textContent, /copy it manually/);
  assert.equal(nodes['#install-command'].textContent, INSTALL_COMMAND);
});

test('amount, offer and Stripe URL validators reject unsafe or malformed values', () => {
  for (const [value, amount] of [['1', 1], ['7.50', 7.5], [' 1.10 ', 1.1], ['10000', 10000]]) assert.equal(parseAmount(value), amount);
  for (const value of ['', '1e2', '-1', '0.99', '10000.01', '1.001', 'abc', Infinity, null]) assert.throws(() => parseAmount(value));
  assert.deepEqual(readOffer(offer()), offer());
  for (const value of [null, {}, { ...offer(), code: { open: true, min: 0, currency: 'usd' } }, { ...offer(), rent: { ...offer().rent, href: 'https://evil.test' } }]) assert.throws(() => readOffer(value));
  assert.equal(checkoutURL('https://checkout.stripe.com/c/pay/cs_test_123'), 'https://checkout.stripe.com/c/pay/cs_test_123');
  for (const value of ['http://checkout.stripe.com/x', 'https://checkout.stripe.com.evil.test/x', 'https://evil.test/', 'javascript:alert(1)', '/checkout', 'https://user@checkout.stripe.com/x', 'https://checkout.stripe.com:444/x']) assert.throws(() => checkoutURL(value));
});

test('free code is immediate while offer is pending or fails, and offer retry works', async () => {
  const pending = deferred(), renders = [];
  let requests = 0;
  const c = createShopController({ fetch: async () => { requests++; return requests === 1 ? pending.promise : response(offer()); }, navigate() { assert.fail('not buying'); }, render: state => renders.push(state) });
  const loading = c.loadOffer();
  assert.equal(c.snapshot().phase, 'loading');
  c.showCode(); assert.equal(c.snapshot().codeVisible, true);
  pending.reject(new Error('offline')); await loading;
  assert.equal(c.snapshot().codeVisible, true); assert.match(c.snapshot().error, /offline/);
  assert.equal(c.snapshot().retryable, true);
  await c.retry();
  assert.equal(requests, 2); assert.equal(c.snapshot().offer.code.open, true);
  assert.equal(c.snapshot().error, ''); assert.equal(c.snapshot().codeVisible, true);
  assert.ok(renders.some(state => state.phase === 'loading' && state.codeVisible));
});

test('closed checkout does not gate public installation or send a purchase', async () => {
  const calls = [];
  const c = createShopController({ fetch: async path => { calls.push(path); return response(offer(false)); }, navigate() { assert.fail('closed'); }, render() {} });
  await c.loadOffer(); c.showCode(); await c.buy('1');
  assert.equal(c.snapshot().codeVisible, true); assert.deepEqual(calls, ['/shop/offer']);
});

test('checkout forwards visitor OS, navigates the same tab once, and never polls', async () => {
  const pending = deferred(), calls = [], destinations = [];
  const c = createShopController({ os: 'mac', fetch: async (path, options) => {
    calls.push({ path, options });
    return path === '/shop/offer' ? response(offer(true, true)) : pending.promise;
  }, navigate: url => destinations.push(url), render() {} });
  await c.loadOffer();
  const buying = c.buy('7.50');
  await c.buy('8'); // Rapid double-submit cannot create a second checkout.
  c.showCode();
  assert.equal(c.snapshot().phase, 'creating'); assert.equal(c.snapshot().codeVisible, true);
  pending.resolve(response({ url: 'https://checkout.stripe.com/pay', session: 'cs_test_checkout' }));
  await buying;
  assert.deepEqual(destinations, ['https://checkout.stripe.com/pay']);
  assert.deepEqual(calls.map(row => row.path), ['/shop/offer', '/shop/code']);
  const options = calls[1].options;
  assert.equal(options.credentials, 'same-origin'); assert.equal(options.method, 'POST');
  assert.deepEqual(JSON.parse(options.body), { amount: 7.5, os: 'mac' });
});

test('malformed Stripe destinations never navigate and a failed checkout can retry', async () => {
  let posts = 0;
  const destinations = [];
  const c = createShopController({ os: 'windows', fetch: async path => {
    if (path === '/shop/offer') return response(offer());
    posts++;
    return response({ url: posts === 1 ? 'https://evil.test/checkout' : 'https://checkout.stripe.com/retry' });
  }, navigate: url => destinations.push(url), render() {} });
  await c.loadOffer();
  await c.buy('0.99'); assert.equal(posts, 0); assert.equal(c.snapshot().retryable, false);
  await c.buy('1'); assert.equal(posts, 1); assert.equal(c.snapshot().retryable, true);
  assert.deepEqual(destinations, []); assert.match(c.snapshot().error, /invalid Stripe/);
  c.showCode(); await c.retry();
  assert.equal(posts, 2); assert.deepEqual(destinations, ['https://checkout.stripe.com/retry']);
  assert.equal(c.snapshot().codeVisible, true);
});

test('JSON checkout failure retains the free code and returns to a usable form', async () => {
  const c = createShopController({ fetch: async path => response(path === '/shop/offer' ? offer() : { error: 'checkout unavailable' }, path === '/shop/offer'), navigate() { assert.fail('failed checkout'); }, render() {} });
  await c.loadOffer(); c.showCode(); await c.buy('1');
  assert.equal(c.snapshot().phase, 'idle'); assert.equal(c.snapshot().error, 'checkout unavailable');
  assert.equal(c.snapshot().codeVisible, true); assert.equal(c.snapshot().retryable, true);
});
