/**
 * Thin wrapper around Paystack's REST API (port of billing/paystack.py) —
 * no SDK, just fetch. Each deployment uses its own client's Paystack
 * account, configured via PAYSTACK_SECRET_KEY / PAYSTACK_PUBLIC_KEY.
 */
const crypto = require('crypto');
const config = require('../config');

const BASE_URL = 'https://api.paystack.co';

/** The API call reached Paystack but it reported a failure. */
class PaystackError extends Error {}
/** No secret key is set for this deployment yet. */
class PaystackNotConfigured extends PaystackError {}

function secretKey() {
  if (!config.PAYSTACK_SECRET_KEY) throw new PaystackNotConfigured("Paystack isn't configured for this site yet — set PAYSTACK_SECRET_KEY.");
  return config.PAYSTACK_SECRET_KEY;
}

async function call(method, path, body) {
  const headers = { Authorization: `Bearer ${secretKey()}` };
  if (body) headers['Content-Type'] = 'application/json';
  let resp;
  try {
    resp = await fetch(BASE_URL + path, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(15000) });
  } catch (err) {
    throw new PaystackError(`Could not reach Paystack: ${err.message}`);
  }
  let data;
  try { data = await resp.json(); } catch (_) { data = {}; }
  if (!resp.ok || !data.status) throw new PaystackError(data.message || 'Paystack rejected the request.');
  return data.data;
}

/** Starts a transaction; returns `data` (incl. authorization_url to redirect the student to). */
function initializeTransaction({ email, amountNaira, reference, callbackUrl, metadata = {} }) {
  return call('POST', '/transaction/initialize', {
    email,
    amount: Math.trunc(Number(amountNaira) * 100), // Paystack wants kobo
    reference,
    callback_url: callbackUrl,
    metadata,
  });
}

/** Verifies a transaction by reference; returns `data` (status, amount, customer, …). */
function verifyTransaction(reference) {
  return call('GET', `/transaction/verify/${encodeURIComponent(reference)}`);
}

/** Paystack signs webhook bodies with HMAC-SHA512 of the secret key. */
function verifyWebhookSignature(rawBody, signatureHeader) {
  const secret = config.PAYSTACK_SECRET_KEY;
  if (!secret || !signatureHeader) return false;
  const expected = crypto.createHmac('sha512', secret).update(rawBody).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(String(signatureHeader));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = { PaystackError, PaystackNotConfigured, initializeTransaction, verifyTransaction, verifyWebhookSignature };
