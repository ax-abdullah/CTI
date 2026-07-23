import { ConfigService } from '@nestjs/config';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RecordingsService } from './recordings.service';

const SECRET = 'recordings-url-secret';
const BASE_URL = 'http://cti.test';

function makeService(dir: string): RecordingsService {
  const values: Record<string, string> = {
    RECORDINGS_BASE_DIR: dir,
    RECORDINGS_URL_SECRET: SECRET,
    PUBLIC_BASE_URL: BASE_URL,
  };
  const config = {
    get: (k: string) => values[k],
    getOrThrow: (k: string) => values[k],
  } as unknown as ConfigService;
  return new RecordingsService(config);
}

/** Pull the `:token` path segment out of a signed recording URL. */
const tokenOf = (url: string) => url.slice(`${BASE_URL}/v1/recordings/`.length);

describe('RecordingsService', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cti-rec-'));
    writeFileSync(join(dir, '1784589088.0.wav'), 'RIFFfake-wav-bytes');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('signs a URL that opens the right file', async () => {
    const svc = makeService(dir);
    const url = svc.signedUrlFor('/var/spool/asterisk/monitor/1784589088.0.wav')!;
    expect(url.startsWith(`${BASE_URL}/v1/recordings/`)).toBe(true);

    const opened = svc.open(tokenOf(url));
    expect(opened).not.toBeNull();
    expect(opened!.file).toBe('1784589088.0.wav');
    // Drain the stream so the file handle closes before afterEach removes it.
    const body = await new Promise<string>((resolve) => {
      let data = '';
      opened!.stream.on('data', (c) => (data += c));
      opened!.stream.on('close', () => resolve(data));
    });
    expect(body).toContain('fake-wav-bytes');
  });

  it('rejects a tampered token', () => {
    const svc = makeService(dir);
    const token = tokenOf(svc.signedUrlFor('1784589088.0.wav')!);
    expect(svc.open(`${token}x`)).toBeNull();
  });

  it('rejects an expired token', () => {
    const svc = makeService(dir);
    const url = svc.signedUrlFor('1784589088.0.wav')!;
    const token = tokenOf(url);
    // Advance well past the 15-minute TTL.
    jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 16 * 60_000);
    expect(svc.open(token)).toBeNull();
    jest.restoreAllMocks();
  });

  it('is traversal-proof: only the basename is honored', () => {
    const svc = makeService(dir);
    // A signed token for a path that basename()s to a real file still only
    // resolves that basename inside the base dir — never an escape.
    const url = svc.signedUrlFor('../../../../etc/passwd')!;
    expect(svc.open(tokenOf(url))).toBeNull();
  });

  it('is unconfigured (no signed URLs) when env is incomplete', () => {
    const config = { get: () => undefined, getOrThrow: () => '' } as unknown as ConfigService;
    const svc = new RecordingsService(config);
    expect(svc.configured).toBe(false);
    expect(svc.signedUrlFor('x.wav')).toBeUndefined();
  });
});
