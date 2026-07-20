import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { Readable } from 'node:stream';

/**
 * Signed short-lived URLs for call recordings, served through the CTI so
 * the PBX filesystem is never exposed. Only the recording's basename is
 * ever embedded in a token and files resolve strictly inside
 * RECORDINGS_BASE_DIR (path traversal is structurally impossible).
 *
 * Lab: the Asterisk monitor dir is bind-mounted to RECORDINGS_BASE_DIR.
 * Production with reverse connectors: mount/sync the recordings share, or
 * extend the connector agent with a file channel — deliberately deferred.
 */
@Injectable()
export class RecordingsService {
  private readonly logger = new Logger(RecordingsService.name);
  private readonly urlTtlSec = 15 * 60;

  constructor(private readonly config: ConfigService) {}

  get configured(): boolean {
    return Boolean(
      this.config.get('RECORDINGS_BASE_DIR') &&
        this.config.get('RECORDINGS_URL_SECRET') &&
        this.config.get('PUBLIC_BASE_URL'),
    );
  }

  /** Turns a PBX-side recording path into a signed public URL, if enabled. */
  signedUrlFor(recordingPath: string): string | undefined {
    if (!this.configured) return undefined;
    const file = basename(recordingPath);
    const exp = Math.floor(Date.now() / 1000) + this.urlTtlSec;
    const payload = Buffer.from(JSON.stringify({ f: file, exp })).toString('base64url');
    const sig = this.hmac(payload);
    return `${this.config.get('PUBLIC_BASE_URL')}/v1/recordings/${payload}.${sig}`;
  }

  /** Verifies a token and opens the file; null on any failure. */
  open(token: string): { stream: Readable; file: string } | null {
    const parts = token.split('.');
    if (parts.length !== 2) return null;
    const [payload, sig] = parts;
    const expected = this.hmac(payload);
    const sigBuf = Buffer.from(sig);
    const expBuf = Buffer.from(expected);
    if (sigBuf.length !== expBuf.length || !timingSafeEqual(sigBuf, expBuf)) return null;

    let claims: { f: string; exp: number };
    try {
      claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    } catch {
      return null;
    }
    if (claims.exp * 1000 < Date.now()) return null;

    const file = basename(claims.f); // defense in depth — already a basename
    const path = join(this.config.getOrThrow<string>('RECORDINGS_BASE_DIR'), file);
    if (!existsSync(path)) {
      this.logger.warn(`Recording not found: ${file}`);
      return null;
    }
    return { stream: createReadStream(path), file };
  }

  private hmac(payload: string): string {
    return createHmac('sha256', this.config.getOrThrow<string>('RECORDINGS_URL_SECRET'))
      .update(payload)
      .digest('base64url');
  }
}
