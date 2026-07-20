import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

/**
 * AES-256-GCM encryption for credentials at rest (PBX secrets, webhook
 * secrets). Keyed by CREDS_KEY (64 hex chars = 32 bytes) from the
 * environment. Ciphertext format: base64(iv).base64(tag).base64(data).
 *
 * Phase 5 upgrade path: per-tenant data keys wrapped by a KMS master key.
 */
@Injectable()
export class CryptoService {
  private readonly key: Buffer;

  constructor(config: ConfigService) {
    const hex = config.getOrThrow<string>('CREDS_KEY');
    if (!/^[0-9a-f]{64}$/i.test(hex)) {
      throw new Error('CREDS_KEY must be 64 hex characters (32 bytes)');
    }
    this.key = Buffer.from(hex, 'hex');
  }

  encrypt(plaintext: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const data = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return [iv, cipher.getAuthTag(), data].map((b) => b.toString('base64')).join('.');
  }

  decrypt(ciphertext: string): string {
    const [iv, tag, data] = ciphertext.split('.').map((p) => Buffer.from(p, 'base64'));
    const decipher = createDecipheriv('aes-256-gcm', this.key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
  }

  static hashApiKey(apiKey: string): string {
    return createHash('sha256').update(apiKey).digest('hex');
  }
}
