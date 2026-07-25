import { ConfigService } from '@nestjs/config';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConnectorFileService } from '../connector-files/connector-file.service';
import { TenantRegistryService } from '../tenants/tenant-registry.service';
import { RecordingsService } from './recordings.service';

const SECRET = 'recordings-url-secret';
const BASE_URL = 'http://cti.test';

function makeService(dir: string | undefined, opts: {
  registry?: Partial<TenantRegistryService>;
  files?: Partial<ConnectorFileService>;
} = {}): RecordingsService {
  const values: Record<string, string | undefined> = {
    RECORDINGS_BASE_DIR: dir,
    RECORDINGS_URL_SECRET: SECRET,
    PUBLIC_BASE_URL: BASE_URL,
  };
  const config = {
    get: (k: string) => values[k],
    getOrThrow: (k: string) => values[k],
  } as unknown as ConfigService;
  const registry = { connectionById: () => undefined, ...opts.registry } as unknown as TenantRegistryService;
  const files = { fetch: async () => null, ...opts.files } as unknown as ConnectorFileService;
  return new RecordingsService(config, registry, files);
}

const tokenOf = (url: string) => url.slice(`${BASE_URL}/v1/recordings/`.length);

describe('RecordingsService', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cti-rec-'));
    writeFileSync(join(dir, '1784589088.0.wav'), 'RIFFfake-wav-bytes');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('signs a URL that opens the right file from the local mount', async () => {
    const svc = makeService(dir);
    const url = svc.signedUrlFor('/var/spool/asterisk/monitor/1784589088.0.wav')!;
    expect(url.startsWith(`${BASE_URL}/v1/recordings/`)).toBe(true);

    const opened = await svc.open(tokenOf(url));
    expect(opened).not.toBeNull();
    expect(opened!.file).toBe('1784589088.0.wav');
    const body = await new Promise<string>((resolve) => {
      let d = '';
      opened!.stream.on('data', (c) => (d += c));
      opened!.stream.on('close', () => resolve(d));
    });
    expect(body).toContain('fake-wav-bytes');
  });

  it('fetches over the tunnel for a reverse connection (no local mount)', async () => {
    const svc = makeService(undefined, {
      registry: { connectionById: () => ({ id: 'conn-x', mode: 'reverse' }) as any },
      files: { fetch: async (id: string, file: string) => Buffer.from(`bytes-of-${file}`) },
    });
    const url = svc.signedUrlFor('/remote/path/rec.wav', 'conn-x')!;
    const opened = await svc.open(tokenOf(url));
    expect(opened).not.toBeNull();
    const body = await new Promise<string>((resolve) => {
      let d = '';
      opened!.stream.on('data', (c) => (d += c));
      opened!.stream.on('close', () => resolve(d));
    });
    expect(body).toBe('bytes-of-rec.wav');
  });

  it('returns null when the tunnel has no file', async () => {
    const svc = makeService(undefined, {
      registry: { connectionById: () => ({ id: 'conn-x', mode: 'reverse' }) as any },
      files: { fetch: async () => null },
    });
    const url = svc.signedUrlFor('rec.wav', 'conn-x')!;
    expect(await svc.open(tokenOf(url))).toBeNull();
  });

  it('rejects a tampered token', async () => {
    const svc = makeService(dir);
    const token = tokenOf(svc.signedUrlFor('1784589088.0.wav')!);
    expect(await svc.open(`${token}x`)).toBeNull();
  });

  it('rejects an expired token', async () => {
    const svc = makeService(dir);
    const token = tokenOf(svc.signedUrlFor('1784589088.0.wav')!);
    jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 16 * 60_000);
    expect(await svc.open(token)).toBeNull();
    jest.restoreAllMocks();
  });

  it('is traversal-proof: only the basename is honored', async () => {
    const svc = makeService(dir);
    const url = svc.signedUrlFor('../../../../etc/passwd')!;
    expect(await svc.open(tokenOf(url))).toBeNull();
  });

  it('is unconfigured (no signed URLs) without secret + base url', () => {
    const config = { get: () => undefined, getOrThrow: () => '' } as unknown as ConfigService;
    const svc = new RecordingsService(config, {} as any, {} as any);
    expect(svc.configured).toBe(false);
    expect(svc.signedUrlFor('x.wav')).toBeUndefined();
  });
});
