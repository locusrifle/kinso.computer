import { bindInstallation, resolveOS, validOS } from './shop-platform.mjs';

export function parseAmount(value) {
  const text = String(value).trim();
  if (!/^\d+(?:\.\d{1,2})?$/.test(text)) throw new Error('Enter an amount in USD, with at most two decimal places.');
  const amount = Number(text);
  if (amount < 1 || amount > 10000) throw new Error('Choose an amount from US$1 to US$10,000.');
  return amount;
}

export function checkoutURL(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.hostname !== 'checkout.stripe.com' || url.username || url.password || url.port) {
    throw new Error('The store returned an invalid Stripe address. Please retry.');
  }
  return url.href;
}

export function readOffer(offer) {
  const { rent, code } = offer || {};
  if (typeof rent?.open !== 'boolean' || rent.price !== 40 || rent.currency !== 'usd' || rent.period !== 'month' || rent.href !== '/account'
      || typeof code?.open !== 'boolean' || code.min !== 1 || code.currency !== 'usd') {
    throw new Error('The store offer could not be read. Please retry.');
  }
  return { rent: { ...rent }, code: { ...code } };
}

// One page, one same-tab checkout. Free installation never depends on the till.
export function createShopController({ fetch: request = globalThis.fetch, navigate, render, os = 'linux' }) {
  const state = { offer: null, phase: 'idle', error: '', retryable: false, codeVisible: false };
  let retryAction;
  const emit = () => render({ ...state });
  async function json(path, options = {}) {
    const response = await request(path, { credentials: 'same-origin', cache: 'no-store', ...options });
    const data = await response.json();
    if (!response.ok) throw new Error(typeof data?.error === 'string' ? data.error.slice(0, 400) : 'The store is unavailable. Please retry.');
    return data;
  }
  function fail(error, retry) {
    state.phase = 'idle'; state.error = error?.message || 'The store could not be reached. Please retry.';
    retryAction = retry; state.retryable = Boolean(retry); emit();
  }
  async function loadOffer() {
    if (state.phase !== 'idle') return;
    state.phase = 'loading'; state.error = ''; state.retryable = false; emit();
    try {
      state.offer = readOffer(await json('/shop/offer'));
      state.phase = 'idle'; emit();
    } catch (error) { fail(error, loadOffer); }
  }
  async function buy(value) {
    if (state.phase !== 'idle' || !state.offer?.code.open) return;
    let amount;
    try { amount = parseAmount(value); }
    catch (error) { fail(error, null); return; }
    state.phase = 'creating'; state.error = ''; state.retryable = false; emit();
    try {
      const result = await json('/shop/code', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ amount, os: validOS(os) || 'linux' }) });
      navigate(checkoutURL(result.url));
    } catch (error) { fail(error, () => buy(value)); }
  }
  return {
    loadOffer, buy,
    showCode() { state.codeVisible = true; emit(); },
    retry() { if (state.phase === 'idle') return retryAction?.(); },
    snapshot: () => ({ ...state }),
  };
}

function initShop() {
  const find = selector => document.querySelector(selector);
  const os = resolveOS(location.search, navigator);
  bindInstallation(document, os, command => navigator.clipboard.writeText(command));
  const input = find('#shop-amount'), form = find('#shop-code-form'), buy = form.querySelector('[type="submit"]');
  const controller = createShopController({
    os,
    navigate: url => location.assign(url),
    render(state) {
      const rent = state.offer?.rent, code = state.offer?.code;
      find('[data-rent-note]').textContent = rent ? (rent.open ? 'Your computer, ready when you are.' : 'Monthly rental isn’t open yet. Early testers join free by invitation.')
        : state.error ? 'Availability could not be checked. Please retry.' : 'Checking availability…';
      find('[data-rent-link]').hidden = !rent?.open;
      find('[data-invite]').hidden = !rent || rent.open;
      input.disabled = buy.disabled = state.phase !== 'idle' || !code?.open;
      buy.textContent = state.phase === 'creating' ? 'Opening Stripe…' : 'Buy';
      find('[data-code-note]').textContent = state.phase === 'loading' ? 'Checking availability…'
        : code && !code.open ? 'Source-code checkout isn’t open yet. The code is free either way.' : '';
      find('#install-panel').hidden = !state.codeVisible;
      find('[data-code-bypass]').hidden = state.codeVisible;
      find('[data-error]').textContent = state.error;
      find('[data-retry]').hidden = !state.retryable;
    },
  });
  form.addEventListener('submit', event => { event.preventDefault(); controller.buy(input.value); });
  find('[data-code-bypass]').addEventListener('click', () => controller.showCode());
  find('[data-retry]').addEventListener('click', () => controller.retry());
  controller.loadOffer();
}

if (typeof document !== 'undefined' && document.querySelector('#shop-code-form')) initShop();
