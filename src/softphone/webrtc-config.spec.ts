import { ConfigService } from '@nestjs/config';
import { BadRequestException } from '@nestjs/common';
import { CryptoService } from '../tenants/crypto.service';
import { TenantRegistryService } from '../tenants/tenant-registry.service';
import { SoftphoneController } from './softphone.controller';
import { signAgentToken } from './agent-token.util';

const JWT_SECRET = 'softphone-jwt-secret';

function makeController(opts: { sipPasswordEnc?: string | null; webrtcEnv?: boolean } = {}) {
  const env: Record<string, string | undefined> = {
    SOFTPHONE_JWT_SECRET: JWT_SECRET,
    WEBRTC_WSS_URL: opts.webrtcEnv === false ? undefined : 'wss://pbx.test:8089/ws',
    WEBRTC_SIP_DOMAIN: opts.webrtcEnv === false ? undefined : 'pbx.test',
    WEBRTC_STUN_URL: 'stun:stun.test:3478',
  };
  const config = {
    get: (k: string) => env[k],
    getOrThrow: (k: string) => env[k],
  } as unknown as ConfigService;
  const registry = {
    tenantBySlug: (slug: string) =>
      slug === 'tenant-a'
        ? { entity: { slug, agents: [{ ext: '1001', sipUsername: '1001', sipPasswordEnc: 'sipPasswordEnc' in opts ? opts.sipPasswordEnc : 'enc' }] } }
        : undefined,
  } as unknown as TenantRegistryService;
  const crypto = { decrypt: (v: string) => (v ? 'sip-secret' : '') } as unknown as CryptoService;
  return new SoftphoneController(config, registry, {} as any, crypto);
}

const bearer = (ext = '1001', slug = 'tenant-a') =>
  `Bearer ${signAgentToken({ tenantSlug: slug, ext, exp: Math.floor(Date.now() / 1000) + 3600 }, JWT_SECRET)}`;

describe('SoftphoneController.webrtcConfig', () => {
  it('returns JsSIP registration params for the agent', () => {
    const cfg = makeController().webrtcConfig(bearer());
    expect(cfg).toMatchObject({
      wssUrl: 'wss://pbx.test:8089/ws',
      sipUri: 'sip:1001@pbx.test',
      authUser: '1001',
      password: 'sip-secret',
    });
    expect(cfg.iceServers).toEqual([{ urls: 'stun:stun.test:3478' }]);
  });

  it('rejects when the agent has no SIP password', () => {
    expect(() => makeController({ sipPasswordEnc: null }).webrtcConfig(bearer())).toThrow(BadRequestException);
  });

  it('rejects when WebRTC env is not configured', () => {
    expect(() => makeController({ webrtcEnv: false }).webrtcConfig(bearer())).toThrow(BadRequestException);
  });

  it('rejects an invalid agent token', () => {
    expect(() => makeController().webrtcConfig('Bearer garbage')).toThrow();
  });
});
