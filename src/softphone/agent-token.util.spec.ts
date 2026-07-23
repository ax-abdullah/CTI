import { signAgentToken, verifyAgentToken } from './agent-token.util';

const SECRET = 'softphone-jwt-secret';
const future = () => Math.floor(Date.now() / 1000) + 3600;

describe('agent token', () => {
  it('verifies a token it signed', () => {
    const claims = { tenantSlug: 'tenant-a', ext: '1001', exp: future() };
    const token = signAgentToken(claims, SECRET);
    expect(token.split('.')).toHaveLength(3);
    expect(verifyAgentToken(token, SECRET)).toMatchObject({ tenantSlug: 'tenant-a', ext: '1001' });
  });

  it('rejects a wrong secret', () => {
    const token = signAgentToken({ tenantSlug: 't', ext: '1001', exp: future() }, SECRET);
    expect(verifyAgentToken(token, 'other-secret')).toBeNull();
  });

  it('rejects an expired token', () => {
    const token = signAgentToken({ tenantSlug: 't', ext: '1001', exp: Math.floor(Date.now() / 1000) - 1 }, SECRET);
    expect(verifyAgentToken(token, SECRET)).toBeNull();
  });

  it('rejects a tampered payload', () => {
    const token = signAgentToken({ tenantSlug: 't', ext: '1001', exp: future() }, SECRET);
    const [h, , s] = token.split('.');
    const forged = Buffer.from(JSON.stringify({ tenantSlug: 't', ext: '9999', exp: future() })).toString('base64url');
    expect(verifyAgentToken(`${h}.${forged}.${s}`, SECRET)).toBeNull();
  });

  it('rejects malformed tokens', () => {
    expect(verifyAgentToken('not-a-token', SECRET)).toBeNull();
    expect(verifyAgentToken('a.b', SECRET)).toBeNull();
    expect(verifyAgentToken('', SECRET)).toBeNull();
  });
});
