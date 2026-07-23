import { ConfigService } from '@nestjs/config';
import { CryptoService } from './crypto.service';

const KEY = '0f2b9d4f8a1c6e3b7d5a9c8e2f4b6d8a1c3e5f7a9b1d3f5a7c9e1b3d5f7a9c1e';

function makeService(key = KEY): CryptoService {
  const config = { getOrThrow: () => key } as unknown as ConfigService;
  return new CryptoService(config);
}

describe('CryptoService', () => {
  it('round-trips a value through encrypt/decrypt', () => {
    const svc = makeService();
    const plaintext = 'AMI_Manager_Secret_123!';
    const ciphertext = svc.encrypt(plaintext);

    expect(ciphertext).not.toContain(plaintext);
    expect(ciphertext.split('.')).toHaveLength(3); // iv.tag.data
    expect(svc.decrypt(ciphertext)).toBe(plaintext);
  });

  it('produces a fresh IV each call (ciphertexts differ)', () => {
    const svc = makeService();
    expect(svc.encrypt('same')).not.toBe(svc.encrypt('same'));
  });

  it('rejects tampered ciphertext (GCM auth tag)', () => {
    const svc = makeService();
    const [iv, tag, data] = svc.encrypt('secret').split('.');
    const flipped = data[0] === 'A' ? 'B' : 'A';
    const tampered = `${iv}.${tag}.${flipped}${data.slice(1)}`;
    expect(() => svc.decrypt(tampered)).toThrow();
  });

  it('cannot decrypt with a different key', () => {
    const a = makeService(KEY);
    const b = makeService('1'.repeat(64));
    expect(() => b.decrypt(a.encrypt('x'))).toThrow();
  });

  it('requires a 64-hex-char key', () => {
    expect(() => makeService('too-short')).toThrow(/64 hex/);
  });

  it('hashApiKey is stable and one-way', () => {
    const h = CryptoService.hashApiKey('tenant-a-abc123');
    expect(h).toBe(CryptoService.hashApiKey('tenant-a-abc123'));
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(h).not.toContain('tenant-a');
  });
});
