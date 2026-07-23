import { Controller, HttpCode, INestApplication, Post, UseGuards } from '@nestjs/common';
import { ThrottlerModule } from '@nestjs/throttler';
import { Test } from '@nestjs/testing';
import { createHash } from 'node:crypto';
import request from 'supertest';
import { CtiThrottlerGuard } from './cti-throttler.guard';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

describe('CtiThrottlerGuard.getTracker keying', () => {
  const getTracker = (req: any) => (CtiThrottlerGuard.prototype as any).getTracker(req);

  it('keys tenant requests by the API key hash', async () => {
    await expect(getTracker({ headers: { 'x-api-key': 'tenant-a-key' } })).resolves.toBe(`t:${sha('tenant-a-key')}`);
  });

  it('keys softphone requests by the bearer token hash', async () => {
    await expect(getTracker({ headers: { authorization: 'Bearer abc.def.ghi' } })).resolves.toBe(`a:${sha('abc.def.ghi')}`);
  });

  it('falls back to IP when no credential is present', async () => {
    await expect(getTracker({ headers: {}, ip: '10.0.0.9' })).resolves.toBe('10.0.0.9');
  });
});

@Controller()
class RingController {
  @UseGuards(CtiThrottlerGuard)
  @HttpCode(200)
  @Post('ring')
  ring() {
    return { ok: true };
  }
}

describe('CtiThrottlerGuard limiting (integration)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [ThrottlerModule.forRoot({ throttlers: [{ ttl: 60_000, limit: 3 }] })],
      controllers: [RingController],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('allows up to the limit then returns 429 — per API key', async () => {
    const key = 'tenant-a-key';
    for (let i = 0; i < 3; i++) {
      await request(app.getHttpServer()).post('/ring').set('X-API-Key', key).expect(200);
    }
    await request(app.getHttpServer()).post('/ring').set('X-API-Key', key).expect(429);
  });

  it('does not throttle a different tenant (per-key isolation)', async () => {
    await request(app.getHttpServer()).post('/ring').set('X-API-Key', 'tenant-b-key').expect(200);
  });
});
