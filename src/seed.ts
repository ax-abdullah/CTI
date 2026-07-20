import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { randomBytes, createHash, createCipheriv } from 'node:crypto';
import { PbxConnection } from './tenants/entities/pbx-connection.entity';
import { Tenant } from './tenants/entities/tenant.entity';
import { Agent } from './tenants/entities/agent.entity';

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

  const ds = new DataSource({
    type: 'postgres',
    url: process.env.DATABASE_URL,
    entities: [PbxConnection, Tenant, Agent],
    synchronize: true, // dev only — real migrations before production
  });
  await ds.initialize();

  await ds.getRepository(Agent).createQueryBuilder().delete().execute();
  await ds.getRepository(Tenant).createQueryBuilder().delete().execute();
  await ds.getRepository(PbxConnection).createQueryBuilder().delete().execute();

  const connection = await ds.getRepository(PbxConnection).save({
    name: 'lab-asterisk',
    host: process.env.SEED_AMI_HOST ?? '127.0.0.1',
    port: Number(process.env.SEED_AMI_PORT ?? 5038),
    username: process.env.SEED_AMI_USERNAME ?? 'cti',
    secretEnc: encrypt(key, amiSecret),
  });

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
        { ext: '1000', displayName: 'A Echo Test' },
        { ext: '1001', displayName: 'A Agent 1001' },
      ],
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
        { ext: '2000', displayName: 'B Echo Test' },
        { ext: '2001', displayName: 'B Agent 2001' },
      ],
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
      await ds.getRepository(Agent).save({ tenantId: tenant.id, ...agent, crmRefs: {} });
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
