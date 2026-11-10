import crypto from 'node:crypto';

/** Compares as bytes, so a value of the right length in characters but not in bytes is a mismatch and never a crash. */
function same(given, expected) {
  const a = Buffer.from(String(given), 'utf8');
  const b = Buffer.from(String(expected), 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** True when X-Hub-Signature-256 matches these exact bytes. Anything missing or malformed is simply false. */
export function verifyHubSignature(rawBody, header, secret) {
  if (!secret || !Buffer.isBuffer(rawBody) || typeof header !== 'string' || !header.startsWith('sha256=')) return false;
  return same(header.slice('sha256='.length), crypto.createHmac('sha256', secret).update(rawBody).digest('hex'));
}

/**
 * Meta's signed_request, as sent to the deauthorize and deletion callbacks (PRD 4.2, 4.14): the payload as an object,
 * or null when the signature, algorithm or format is wrong.
 */
export function verifySignedRequest(signedRequest, secret) {
  if (!secret || typeof signedRequest !== 'string') return null;
  const [signature, encoded, extra] = signedRequest.split('.');
  if (!signature || !encoded || extra !== undefined) return null;
  if (!same(signature, crypto.createHmac('sha256', secret).update(encoded).digest('base64url'))) return null;
  try {
    const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    return payload?.algorithm === 'HMAC-SHA256' ? payload : null;
  } catch {
    return null;
  }
}
