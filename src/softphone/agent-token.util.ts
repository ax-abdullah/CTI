import { createHmac, timingSafeEqual } from 'node:crypto';

export interface AgentClaims {
  tenantSlug: string;
  ext: string;
  exp: number; // epoch seconds
}

const b64url = (buf: Buffer) => buf.toString('base64url');

/**
 * Compact HS256 JWT for softphone sessions (header.payload.signature).
 * Hand-rolled to keep dependencies down — we only ever sign and verify our
 * own tokens with a single symmetric secret (SOFTPHONE_JWT_SECRET).
 */
export function signAgentToken(claims: AgentClaims, secret: string): string {
  const header = b64url(Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
  const payload = b64url(Buffer.from(JSON.stringify(claims)));
  const signature = b64url(
    createHmac('sha256', secret).update(`${header}.${payload}`).digest(),
  );
  return `${header}.${payload}.${signature}`;
}

export function verifyAgentToken(token: string, secret: string): AgentClaims | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [header, payload, signature] = parts;
  const expected = b64url(createHmac('sha256', secret).update(`${header}.${payload}`).digest());
  const sigBuf = Buffer.from(signature);
  const expBuf = Buffer.from(expected);
  if (sigBuf.length !== expBuf.length || !timingSafeEqual(sigBuf, expBuf)) return null;
  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as AgentClaims;
    if (typeof claims.exp !== 'number' || claims.exp * 1000 < Date.now()) return null;
    if (typeof claims.tenantSlug !== 'string' || typeof claims.ext !== 'string') return null;
    return claims;
  } catch {
    return null;
  }
}
