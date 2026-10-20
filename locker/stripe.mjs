// The smallest Stripe client that will do: form-encoded requests over fetch,
// and webhook signatures checked by hand. No SDK, so nothing to update and
// nothing to audit but this file.

import { createHmac, timingSafeEqual } from 'node:crypto';

export const STRIPE_API = 'https://api.stripe.com';
// Pinned so the account default can change without changing what we get back.
export const STRIPE_VERSION = '2026-08-26.dahlia';

// Stripe reads nested params in bracket form: line_items[0][price]=price_x.
export function encodeForm(value, prefix = '', out = new URLSearchParams()) {
  if (value === null || value === undefined) return out;
  if (Array.isArray(value)) {
    value.forEach((item, index) => encodeForm(item, `${prefix}[${index}]`, out));
  } else if (typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) encodeForm(item, prefix ? `${prefix}[${key}]` : key, out);
  } else {
    out.append(prefix, String(value));
  }
  return out;
}

export class StripeError extends Error {
  constructor(status, body) {
    super(body?.error?.message || `stripe ${status}`);
    this.status = status;
    this.code = body?.error?.code || '';
    this.type = body?.error?.type || '';
  }
}

export function createStripe({ secretKey, fetchImpl = fetch, base = STRIPE_API } = {}) {
  if (!secretKey) throw new Error('STRIPE_SECRET_KEY is required');
  async function request(method, path, params = null, { idempotencyKey = '' } = {}) {
    const headers = { authorization: `Bearer ${secretKey}`, 'stripe-version': STRIPE_VERSION };
    let body;
    if (params) {
      headers['content-type'] = 'application/x-www-form-urlencoded';
      body = encodeForm(params).toString();
    }
    if (idempotencyKey) headers['idempotency-key'] = idempotencyKey;
    const response = await fetchImpl(`${base}${path}`, { method, headers, body, signal: AbortSignal.timeout(20_000) });
    const json = await response.json().catch(() => ({}));
    if (!response.ok) throw new StripeError(response.status, json);
    return json;
  }
  return {
    request,
    checkoutSession(params, options) { return request('POST', '/v1/checkout/sessions', params, options); },
    retrieveSubscription(id) { return request('GET', `/v1/subscriptions/${encodeURIComponent(id)}?expand[]=latest_invoice`); },
    portalSession(params) { return request('POST', '/v1/billing_portal/sessions', params); },
    retrieveSession(sessionId) { return request('GET', `/v1/checkout/sessions/${encodeURIComponent(sessionId)}?expand[]=customer`); },
  };
}

// `Stripe-Signature: t=1492774577,v1=5257a869e7...,v0=...`
export function parseSignatureHeader(header) {
  const out = { t: '', v1: [] };
  for (const part of String(header ?? '').split(',')) {
    const [key, value] = part.split('=', 2).map(s => s?.trim() ?? '');
    if (key === 't') out.t = value;
    else if (key === 'v1' && value) out.v1.push(value);
  }
  return out;
}

export function verifyWebhook(payload, header, secret, { toleranceSeconds = 300, now = () => Date.now() } = {}) {
  if (!secret) throw new Error('STRIPE_WEBHOOK_SECRET is required');
  const { t, v1 } = parseSignatureHeader(header);
  if (!/^\d+$/.test(t) || !v1.length) throw new Error('missing Stripe signature');
  const age = Math.abs(now() / 1000 - Number(t));
  if (age > toleranceSeconds) throw new Error('Stripe signature is too old');
  const raw = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8');
  const expected = createHmac('sha256', secret).update(`${t}.`).update(raw).digest('hex');
  const ok = v1.some(candidate => candidate.length === expected.length && timingSafeEqual(Buffer.from(candidate), Buffer.from(expected)));
  if (!ok) throw new Error('Stripe signature does not match');
  return JSON.parse(raw.toString('utf8'));
}

// The same helper a test uses to sign a fake event.
export function signWebhook(payload, secret, timestamp = Math.floor(Date.now() / 1000)) {
  const raw = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8');
  const v1 = createHmac('sha256', secret).update(`${timestamp}.`).update(raw).digest('hex');
  return `t=${timestamp},v1=${v1}`;
}
