import { createHmac } from 'node:crypto';
import { webhookSignature } from './webhook-signature';

const SECRET = 'tenant-webhook-secret';

describe('webhookSignature', () => {
  it('matches an independent HMAC-SHA256 of `${ts}.${body}`', () => {
    const ts = '1784589088123';
    const body = JSON.stringify({ id: 'abc', type: 'call.ended' });
    const expected = createHmac('sha256', SECRET).update(`${ts}.${body}`).digest('hex');
    expect(webhookSignature(SECRET, ts, body)).toBe(expected);
  });

  it('changes when the timestamp changes (replay protection)', () => {
    const body = '{}';
    expect(webhookSignature(SECRET, '1', body)).not.toBe(webhookSignature(SECRET, '2', body));
  });

  it('changes when the body changes', () => {
    expect(webhookSignature(SECRET, '1', '{"a":1}')).not.toBe(webhookSignature(SECRET, '1', '{"a":2}'));
  });

  it('is deterministic for the same inputs', () => {
    expect(webhookSignature(SECRET, '1', '{}')).toBe(webhookSignature(SECRET, '1', '{}'));
  });
});
