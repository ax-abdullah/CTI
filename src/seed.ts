import 'reflect-metadata';
import { randomBytes, createHash, createCipheriv } from 'node:crypto';
import { AppDataSource } from './data-source';
import { PbxConnection } from './tenants/entities/pbx-connection.entity';
import { Tenant } from './tenants/entities/tenant.entity';
import { Agent } from './tenants/entities/agent.entity';
import { CrmIntegration } from './tenants/entities/crm-integration.entity';

/**
 * Seeds the lab setup: one PBX connection (the Docker Asterisk) shared by
 * two tenants partitioned by dialplan context and extension range — the
 * same shape as a hosted multi-tenant Asterisk in production.
 *
 * Usage: node dist/seed.js   (reads .env-style vars from the environment;
 * `npm run seed` loads .env first). Prints the generated API keys ONCE.
 */

function encrypt(key: Buffer, plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), data].map((b) => b.toString('base64')).join('.');
}

async function main() {
  const credsKey = process.env.CREDS_KEY;
  if (!credsKey || !/^[0-9a-f]{64}$/i.test(credsKey)) {
    throw new Error('CREDS_KEY env var (64 hex chars) is required');
  }
  const key = Buffer.from(credsKey, 'hex');
  const amiSecret = process.env.SEED_AMI_SECRET;
  if (!amiSecret) throw new Error('SEED_AMI_SECRET env var is required');

  // Shared DataSource (synchronize:false); migrations own the schema.
  const ds = AppDataSource;
  await ds.initialize();
  await ds.runMigrations();

  await ds.getRepository(CrmIntegration).createQueryBuilder().delete().execute();
  await ds.getRepository(Agent).createQueryBuilder().delete().execute();
  await ds.getRepository(Tenant).createQueryBuilder().delete().execute();
  await ds.getRepository(PbxConnection).createQueryBuilder().delete().execute();

  // SEED_PBX_MODE=reverse registers the lab PBX as a customer-style
  // reverse connection: the cloud never dials in, the on-prem agent
  // (scripts/connector-agent.mjs) tunnels AMI out to /connector-ws.
  const mode = process.env.SEED_PBX_MODE === 'reverse' ? 'reverse' : 'direct';
  const connectorToken = mode === 'reverse' ? `conn-${randomBytes(24).toString('hex')}` : null;
  const connection = await ds.getRepository(PbxConnection).save({
    name: 'lab-asterisk',
    mode,
    connectorTokenHash: connectorToken
      ? createHash('sha256').update(connectorToken).digest('hex')
      : null,
    host: process.env.SEED_AMI_HOST ?? '127.0.0.1',
    port: Number(process.env.SEED_AMI_PORT ?? 5038),
    username: process.env.SEED_AMI_USERNAME ?? 'cti',
    secretEnc: encrypt(key, amiSecret),
  });
  if (connectorToken) {
    console.log(`lab-asterisk connector token (shown once): ${connectorToken}`);
  }

  const tenantSpecs = [
    {
      slug: 'tenant-a',
      name: 'Tenant A (lab)',
      extensionPattern: '^1\\d{3}$',
      contexts: ['tenant-a-internal', 'tenant-a-outbound'],
      originateContext: 'tenant-a-internal',
      originateChannelTemplate: 'Local/{ext}@tenant-a-internal',
      webhookUrl: 'http://127.0.0.1:4000/cti-events',
      webhookSecret: 'receiver-a-secret',
      agents: [
        { ext: '1000', displayName: 'A Echo Test', crmRefs: { zoho: 'zuid-1000' } },
        { ext: '1001', displayName: 'A Agent 1001', crmRefs: { zoho: 'zuid-1001' } },
      ],
      // Mock Zoho in the lab; production would be accounts.zoho.sa /
      // phonebridge.zoho.sa with the real client credentials + refresh token.
      zoho: {
        config: {
          dc: 'sa',
          accountsBaseUrl: process.env.SEED_ZOHO_ACCOUNTS_URL ?? 'http://127.0.0.1:4100',
          apiBaseUrl: process.env.SEED_ZOHO_API_URL ?? 'http://127.0.0.1:4100/phonebridge/v3',
          clientId: 'mock-client-id',
        },
        secrets: {
          clientSecret: 'mock-client-secret',
          refreshToken: 'mock-refresh-token',
          callbackToken: 'zoho-callback-token-a',
        },
      },
      // A second CRM on the same tenant — call logging fans out to both.
      hubspot: {
        config: {
          accountsBaseUrl: process.env.SEED_HS_ACCOUNTS_URL ?? 'http://127.0.0.1:4300',
          apiBaseUrl: process.env.SEED_HS_API_URL ?? 'http://127.0.0.1:4300',
          clientId: 'mock-hs-client-id',
        },
        secrets: { clientSecret: 'mock-hs-client-secret', refreshToken: 'mock-hs-refresh-token' },
      },
    },
    {
      slug: 'tenant-b',
      name: 'Tenant B (lab)',
      extensionPattern: '^2\\d{3}$',
      contexts: ['tenant-b-internal', 'tenant-b-outbound'],
      originateContext: 'tenant-b-internal',
      originateChannelTemplate: 'Local/{ext}@tenant-b-internal',
      webhookUrl: 'http://127.0.0.1:4001/cti-events',
      webhookSecret: 'receiver-b-secret',
      agents: [
        { ext: '2000', displayName: 'B Echo Test', crmRefs: { salesforce: 'sfuser-2000' } },
        { ext: '2001', displayName: 'B Agent 2001', crmRefs: { salesforce: 'sfuser-2001' } },
      ],
      zoho: undefined,
      // Mock Salesforce in the lab; production would be the org's
      // login.salesforce.com + instance URL with a real connected app.
      salesforce: {
        config: {
          loginBaseUrl: process.env.SEED_SF_LOGIN_URL ?? 'http://127.0.0.1:4200',
          instanceUrl: process.env.SEED_SF_INSTANCE_URL ?? 'http://127.0.0.1:4200',
          apiVersion: '61.0',
          clientId: 'mock-sf-client-id',
        },
        secrets: {
          clientSecret: 'mock-sf-client-secret',
          refreshToken: 'mock-sf-refresh-token',
        },
      },
      dynamics: {
        config: {
          loginBaseUrl: process.env.SEED_DYN_LOGIN_URL ?? 'http://127.0.0.1:4400',
          orgUrl: process.env.SEED_DYN_ORG_URL ?? 'http://127.0.0.1:4400',
          aadTenantId: 'mock-aad-tenant',
          apiVersion: '9.2',
          clientId: 'mock-dyn-client-id',
        },
        secrets: { clientSecret: 'mock-dyn-client-secret' },
      },
    },
  ];

  for (const spec of tenantSpecs) {
    const apiKey = `${spec.slug}-${randomBytes(24).toString('hex')}`;
    const tenant = await ds.getRepository(Tenant).save({
      slug: spec.slug,
      name: spec.name,
      pbxConnectionId: connection.id,
      extensionPattern: spec.extensionPattern,
      contexts: spec.contexts,
      originateContext: spec.originateContext,
      originateChannelTemplate: spec.originateChannelTemplate,
      apiKeyHash: createHash('sha256').update(apiKey).digest('hex'),
      webhookUrl: spec.webhookUrl,
      webhookSecretEnc: encrypt(key, spec.webhookSecret),
    });
    for (const agent of spec.agents) {
      // Lab WebRTC SIP creds: username = ext, password = webrtc-<ext>. The
      // reference PJSIP webrtc endpoints (config/webrtc.conf) use the same.
      await ds.getRepository(Agent).save({
        tenantId: tenant.id,
        ...agent,
        sipUsername: agent.ext,
        sipPasswordEnc: encrypt(key, `webrtc-${agent.ext}`),
      });
    }
    const crm = spec as {
      zoho?: { config: Record<string, string>; secrets: Record<string, string> };
      salesforce?: { config: Record<string, string>; secrets: Record<string, string> };
      hubspot?: { config: Record<string, string>; secrets: Record<string, string> };
      dynamics?: { config: Record<string, string>; secrets: Record<string, string> };
    };
    for (const [type, integration] of [
      ['zoho', crm.zoho],
      ['salesforce', crm.salesforce],
      ['hubspot', crm.hubspot],
      ['dynamics', crm.dynamics],
    ] as const) {
      if (!integration) continue;
      await ds.getRepository(CrmIntegration).save({
        tenantId: tenant.id,
        type,
        enabled: true,
        config: integration.config,
        secretsEnc: encrypt(key, JSON.stringify(integration.secrets)),
      });
    }
    console.log(`${spec.slug} API key (shown once): ${apiKey}`);
  }

  await ds.destroy();
  console.log('Seed complete.');
}

void main().catch((err) => {
  console.error(err);
  process.exit(1);
});
