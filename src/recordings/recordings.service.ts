import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { basename, join } from 'node:path';
import { Readable } from 'node:stream';
import { ConnectorFileService } from '../connector-files/connector-file.service';
import { TenantRegistryService } from '../tenants/tenant-registry.service';

/**
 * Signed short-lived URLs for call recordings, served through the CTI so the
 * PBX filesystem is never exposed. Only the recording's basename is ever
 * embedded in a token, and files resolve strictly inside RECORDINGS_BASE_DIR
 * — path traversal is structurally impossible.
 *
 * Source of the bytes:
 *  - direct connections: RECORDINGS_BASE_DIR (a mount/sync of the monitor dir)
 *  - reverse connections: pulled from the on-prem agent over its file channel
 *    (ConnectorFileService), so NAT'd customers need no shared mount.
 * The connectionId is embedded in the token so `open` knows which source to use.
 */
@Injectable()
export class RecordingsService {
  private readonly logger = new Logger(RecordingsService.name);
  private readonly urlTtlSec = 15 * 60;

  constructor(
    private readonly config: ConfigService,
    private readonly registry: TenantRegistryService,
    private readonly connectorFiles: ConnectorFileService,
  ) {}

  /** Can sign/serve URLs (a base dir is only needed for direct connections). */
  get configured(): boolean {
    return Boolean(this.config.get('RECORDINGS_URL_SECRET') && this.config.get('PUBLIC_BASE_URL'));
  }

  /** Turns a PBX-side recording path into a signed public URL, if enabled. */
  signedUrlFor(recordingPath: string, connectionId?: string): string | undefined {
    if (!this.configured) return undefined;
    const file = basename(recordingPath);
    const exp = Math.floor(Date.now() / 1000) + this.urlTtlSec;
    const payload = Buffer.from(JSON.stringify({ f: file, c: connectionId, exp })).toString('base64url');
    const sig = this.hmac(payload);
    return `${this.config.get('PUBLIC_BASE_URL')}/v1/recordings/${payload}.${sig}`;
  }

  /** Verifies a token and opens the file (local or over the tunnel); null on failure. */
  async open(token: string): Promise<{ stream: Readable; file: string } | null> {
    const parts = token.split('.');
    if (parts.length !== 2) return null;
    const [payload, sig] = parts;
    const expected = this.hmac(payload);
    const sigBuf = Buffer.from(sig);
    const expBuf = Buffer.from(expected);
    if (sigBuf.length !== expBuf.length || !timingSafeEqual(sigBuf, expBuf)) return null;

    let claims: { f: string; c?: string; exp: number };
    try {
      claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    } catch {
      return null;
    }
    if (claims.exp * 1000 < Date.now()) return null;

    const file = basename(claims.f); // defense in depth — already a basename

    // Reverse connection: pull the file from the on-prem agent.
    if (claims.c) {
      const connection = this.registry.connectionById(claims.c);
      if (connection?.mode === 'reverse') {
        const buf = await this.connectorFiles.fetch(claims.c, file);
        if (!buf) {
          this.logger.warn(`Recording ${file} unavailable over tunnel for ${claims.c}`);
          return null;
        }
        return { stream: Readable.from(buf), file };
      }
    }

    // Direct connection: read from the local mount.
    const dir = this.config.get<string>('RECORDINGS_BASE_DIR');
    if (!dir) return null;
    const path = join(dir, file);
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
