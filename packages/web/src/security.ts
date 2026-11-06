import {
  createHash, createHmac, createPublicKey, randomBytes, timingSafeEqual, verify,
  type JsonWebKey,
} from 'node:crypto';

const stamp = (secret: string, data: string): string =>
  createHmac('sha256', secret).update(data).digest('base64url');

const equal = (a: string, b: string): boolean => {
  if (a.length === 0 || a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
};

export function signEnvelope(payload: Record<string, unknown>, secret: string): string {
  if (secret.length < 32) throw new Error('Web secret must be at least 32 characters');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return body + '.' + stamp(secret, body);
}
export function verifyEnvelope(raw: string | undefined, secret: string): Record<string, unknown> | null {
  if (!raw || raw.length > 2048 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(raw)) return null;
  const [body, sig] = raw.split('.');
  if (!equal(stamp(secret, body), sig)) return null;
  try {
    const data: unknown = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    return data && typeof data === 'object' && !Array.isArray(data)
      ? data as Record<string, unknown> : null;
  } catch { return null; }
}

/** The PKCE verifier is encrypted in transit (HTTPS) and signed in an HttpOnly cookie. */
export function createLoginChallenge(secret: string, now = Date.now()): {
  cookie: string; state: string; codeChallenge: string;
} {
  const state = randomBytes(24).toString('base64url');
  const verifier = randomBytes(32).toString('base64url');
  return {
    cookie: signEnvelope({ state, verifier, issuedAt: now }, secret),
    state,
    codeChallenge: createHash('sha256').update(verifier).digest('base64url'),
  };
}
export function consumeLoginChallenge(
  raw: string | undefined, state: string | null, secret: string, now = Date.now(),
): string | null {
  if (!state || !/^[A-Za-z0-9_-]{32}$/.test(state)) return null;
  const data = verifyEnvelope(raw, secret);
  if (!data || !equal(String(data.state), state) ||
      typeof data.issuedAt !== 'number' || now < data.issuedAt ||
      now - data.issuedAt > 5 * 60_000 ||
      typeof data.verifier !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(data.verifier)) return null;
  return data.verifier;
}

const SESSION_MS = 12 * 60 * 60_000;
export function issueSession(telegramId: number, secret: string, now = Date.now()): string {
  if (!Number.isSafeInteger(telegramId) || telegramId <= 0) throw new Error('Invalid Telegram identity');
  return signEnvelope({ telegramId, issuedAt: now, expiresAt: now + SESSION_MS }, secret);
}
export function readSession(raw: string | undefined, secret: string, now = Date.now()): number | null {
  const data = verifyEnvelope(raw, secret);
  if (!data || !Number.isSafeInteger(data.telegramId) || Number(data.telegramId) <= 0 ||
      typeof data.issuedAt !== 'number' || typeof data.expiresAt !== 'number' ||
      data.issuedAt > now + 60_000 || data.expiresAt < now ||
      data.expiresAt - data.issuedAt !== SESSION_MS) return null;
  return Number(data.telegramId);
}
export function csrfForSession(raw: string, secret: string): string {
  return stamp(secret, 'csrf:' + raw);
}
export function isValidCsrf(given: string | undefined, raw: string, secret: string): boolean {
  return typeof given === 'string' && equal(given, csrfForSession(raw, secret));
}

type Jwk = JsonWebKey & { kid?: string; kty?: string; alg?: string; use?: string };
export interface Jwks { keys: Jwk[]; }

/** Telegram OIDC: do not trust unsigned user JSON or an arbitrary JWT JWK URL. */
export function verifyTelegramIdToken(
  token: string, jwks: Jwks, clientId: string, now = Date.now(),
): number {
  if (token.length > 16_384) throw new Error('Oversized ID token');
  const parts = token.split('.');
  if (parts.length !== 3 || parts.some(v => !/^[A-Za-z0-9_-]+$/.test(v)))
    throw new Error('Invalid ID token format');
  const [h, p, s] = parts;
  const header = JSON.parse(Buffer.from(h, 'base64url').toString('utf8')) as Record<string, unknown>;
  const claims = JSON.parse(Buffer.from(p, 'base64url').toString('utf8')) as Record<string, unknown>;
  if (header.alg !== 'RS256' || typeof header.kid !== 'string') throw new Error('Unapproved JWT algorithm');
  if (!jwks || !Array.isArray(jwks.keys)) throw new Error('Missing trusted Telegram keys');
  const jwk = jwks.keys.find(k =>
    k.kid === header.kid && k.kty === 'RSA' &&
    (k.alg === undefined || k.alg === 'RS256') &&
    (k.use === undefined || k.use === 'sig'));
  if (!jwk) throw new Error('Unknown Telegram signing key');
  if (!verify('RSA-SHA256', Buffer.from(h + '.' + p),
    createPublicKey({ key: jwk, format: 'jwk' }), Buffer.from(s, 'base64url')))
    throw new Error('Invalid Telegram ID token signature');
  const seconds = Math.floor(now / 1000);
  const aud = claims.aud;
  if (claims.iss !== 'https://oauth.telegram.org' ||
      !(aud === clientId || (Array.isArray(aud) && aud.includes(clientId))) ||
      typeof claims.sub !== 'string' || !claims.sub ||
      !Number.isSafeInteger(claims.iat) || !Number.isSafeInteger(claims.exp) ||
      Number(claims.iat) > seconds + 60 || Number(claims.exp) <= seconds ||
      (claims.nbf !== undefined && (!Number.isSafeInteger(claims.nbf) || Number(claims.nbf) > seconds + 60)) ||
      !Number.isSafeInteger(claims.id) || Number(claims.id) <= 0)
    throw new Error('Invalid Telegram OIDC claims');
  return Number(claims.id);
}
