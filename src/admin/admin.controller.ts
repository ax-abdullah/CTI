import { InjectQueue } from '@nestjs/bullmq';
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Header,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBody, ApiExcludeEndpoint, ApiOperation, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { InjectRepository } from '@nestjs/typeorm';
import { Queue } from 'bullmq';
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Repository } from 'typeorm';
import { CallStateService } from '../call-state/call-state.service';
import { PbxSupervisorService } from '../pbx-connector/pbx-supervisor.service';
import { CryptoService } from '../tenants/crypto.service';
import { Agent } from '../tenants/entities/agent.entity';
import { CrmIntegration, CrmType } from '../tenants/entities/crm-integration.entity';
import { PbxConnection } from '../tenants/entities/pbx-connection.entity';
import { Tenant } from '../tenants/entities/tenant.entity';
import { TenantRegistryService } from '../tenants/tenant-registry.service';
import { WEBHOOK_QUEUE } from '../webhooks/webhook.types';
import { ZOHO_QUEUE } from '../crm-adapters/zoho/zoho.types';
import { SALESFORCE_QUEUE } from '../crm-adapters/salesforce/salesforce.types';
import { AdminKeyGuard } from './admin-key.guard';

/**
 * Platform administration: registry CRUD + hot reload (replaces the
 * reseed-and-restart workflow) and an operational overview consumed by the
 * dashboard at /admin. Generated credentials (tenant API keys, connector
 * tokens) are returned exactly once and stored only as hashes.
 */
@ApiTags('Admin')
@ApiSecurity('admin-key')
@Controller('admin')
export class AdminController {
  constructor(
    private readonly registry: TenantRegistryService,
    private readonly supervisor: PbxSupervisorService,
    private readonly callState: CallStateService,
    private readonly crypto: CryptoService,
    @InjectRepository(PbxConnection) private readonly connectionRepo: Repository<PbxConnection>,
    @InjectRepository(Tenant) private readonly tenantRepo: Repository<Tenant>,
    @InjectRepository(Agent) private readonly agentRepo: Repository<Agent>,
    @InjectRepository(CrmIntegration) private readonly integrationRepo: Repository<CrmIntegration>,
    @InjectQueue(WEBHOOK_QUEUE) private readonly webhookQueue: Queue,
    @InjectQueue(ZOHO_QUEUE) private readonly zohoQueue: Queue,
    @InjectQueue(SALESFORCE_QUEUE) private readonly salesforceQueue: Queue,
  ) {}

  @ApiExcludeEndpoint()
  @Get()
  @Header('Content-Type', 'text/html; charset=utf-8')
  dashboard(): string {
    return readFileSync(join(__dirname, '..', '..', 'public', 'admin.html'), 'utf8');
  }

  @ApiOperation({ summary: 'Operational overview: connections, tenants, active calls, queue health' })
  @UseGuards(AdminKeyGuard)
  @Get('overview')
  async overview() {
    const [webhook, zoho, salesforce] = await Promise.all([
      this.webhookQueue.getJobCounts(),
      this.zohoQueue.getJobCounts(),
      this.salesforceQueue.getJobCounts(),
    ]);
    const tenants = await this.tenantRepo.find({ relations: { agents: true } });
    const integrations = await this.integrationRepo.find();
    return {
      connections: this.supervisor.statuses(),
      tenants: tenants.map((t) => ({
        slug: t.slug,
        name: t.name,
        agents: t.agents.length,
        webhookUrl: t.webhookUrl,
        integrations: integrations.filter((i) => i.tenantId === t.id).map((i) => i.type),
      })),
      activeCalls: await this.callState.activeCalls(),
      queues: { webhook, zoho, salesforce },
    };
  }

  /** Reloads the registry from the DB and re-diffs PBX connections. */
  @ApiOperation({
    summary: 'Hot-reload the registry',
    description: 'Re-reads tenants/connections/integrations from the DB; only changed PBX connections restart.',
  })
  @UseGuards(AdminKeyGuard)
  @Post('reload')
  async reload() {
    await this.registry.onModuleInit();
    this.supervisor.reload();
    return { status: 'reloaded' };
  }

  @ApiOperation({
    summary: 'Register a PBX connection',
    description:
      'mode "direct" dials out to host:port; mode "reverse" waits for the on-prem connector ' +
      'agent — the returned connectorToken is shown exactly once. Run /admin/reload to apply.',
  })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['name', 'host', 'username', 'secret'],
      properties: {
        name: { type: 'string', example: 'customer-freepbx' },
        mode: { type: 'string', enum: ['direct', 'reverse'], default: 'direct' },
        host: { type: 'string', example: '10.20.0.5' },
        port: { type: 'number', default: 5038 },
        username: { type: 'string', example: 'cti' },
        secret: { type: 'string', example: 'ami-manager-secret' },
      },
    },
  })
  @UseGuards(AdminKeyGuard)
  @Post('pbx-connections')
  async createConnection(
    @Body()
    body: {
      name: string;
      mode?: 'direct' | 'reverse';
      host: string;
      port?: number;
      username: string;
      secret: string;
    },
  ) {
    if (!body?.name || !body?.host || !body?.username || !body?.secret) {
      throw new BadRequestException('name, host, username, secret are required');
    }
    const mode = body.mode ?? 'direct';
    const connectorToken = mode === 'reverse' ? `conn-${randomBytes(24).toString('hex')}` : null;
    const row = await this.connectionRepo.save({
      name: body.name,
      mode,
      connectorTokenHash: connectorToken
        ? createHash('sha256').update(connectorToken).digest('hex')
        : null,
      host: body.host,
      port: body.port ?? 5038,
      username: body.username,
      secretEnc: this.crypto.encrypt(body.secret),
    });
    return { id: row.id, name: row.name, mode, connectorToken };
  }

  @ApiOperation({
    summary: 'Create a tenant',
    description: 'Returns the tenant API key exactly once (stored as sha256). Run /admin/reload to apply.',
  })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['slug', 'name', 'pbxConnectionId', 'extensionPattern', 'originateContext', 'originateChannelTemplate'],
      properties: {
        slug: { type: 'string', example: 'acme' },
        name: { type: 'string', example: 'Acme Corp' },
        pbxConnectionId: { type: 'string', format: 'uuid' },
        extensionPattern: { type: 'string', example: '^1\\d{3}$' },
        contexts: { type: 'array', items: { type: 'string' }, example: ['from-internal'] },
        originateContext: { type: 'string', example: 'from-internal' },
        originateChannelTemplate: { type: 'string', example: 'PJSIP/{ext}' },
        webhookUrl: { type: 'string', example: 'https://crm.acme.com/cti-events' },
        webhookSecret: { type: 'string' },
      },
    },
  })
  @UseGuards(AdminKeyGuard)
  @Post('tenants')
  async createTenant(
    @Body()
    body: {
      slug: string;
      name: string;
      pbxConnectionId: string;
      extensionPattern: string;
      contexts: string[];
      originateContext: string;
      originateChannelTemplate: string;
      webhookUrl?: string;
      webhookSecret?: string;
    },
  ) {
    for (const field of ['slug', 'name', 'pbxConnectionId', 'extensionPattern', 'originateContext', 'originateChannelTemplate'] as const) {
      if (!body?.[field]) throw new BadRequestException(`${field} is required`);
    }
    const apiKey = `${body.slug}-${randomBytes(24).toString('hex')}`;
    const row = await this.tenantRepo.save({
      slug: body.slug,
      name: body.name,
      pbxConnectionId: body.pbxConnectionId,
      extensionPattern: body.extensionPattern,
      contexts: body.contexts ?? [],
      originateContext: body.originateContext,
      originateChannelTemplate: body.originateChannelTemplate,
      apiKeyHash: createHash('sha256').update(apiKey).digest('hex'),
      webhookUrl: body.webhookUrl ?? null,
      webhookSecretEnc: body.webhookSecret ? this.crypto.encrypt(body.webhookSecret) : null,
    });
    return { id: row.id, slug: row.slug, apiKey };
  }

  @ApiOperation({ summary: 'Add an agent (extension) to a tenant' })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['tenantSlug', 'ext', 'displayName'],
      properties: {
        tenantSlug: { type: 'string', example: 'acme' },
        ext: { type: 'string', example: '1001' },
        displayName: { type: 'string', example: 'Sara Al-Harbi' },
        crmRefs: {
          type: 'object',
          additionalProperties: { type: 'string' },
          example: { zoho: 'zuid-1001', salesforce: '005XXXXXXXXXXXX' },
        },
      },
    },
  })
  @UseGuards(AdminKeyGuard)
  @Post('agents')
  async createAgent(
    @Body() body: { tenantSlug: string; ext: string; displayName: string; crmRefs?: Record<string, string> },
  ) {
    const tenant = await this.tenantRepo.findOneBy({ slug: body?.tenantSlug ?? '' });
    if (!tenant) throw new BadRequestException('Unknown tenantSlug');
    if (!body.ext || !body.displayName) throw new BadRequestException('ext and displayName are required');
    const row = await this.agentRepo.save({
      tenantId: tenant.id,
      ext: body.ext,
      displayName: body.displayName,
      crmRefs: body.crmRefs ?? {},
    });
    return { id: row.id, ext: row.ext };
  }

  @ApiOperation({
    summary: 'Attach a CRM integration to a tenant',
    description: 'config is CRM-specific and non-secret; secrets are stored AES-256-GCM encrypted.',
  })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['tenantSlug', 'type', 'config', 'secrets'],
      properties: {
        tenantSlug: { type: 'string', example: 'acme' },
        type: { type: 'string', enum: ['zoho', 'salesforce'] },
        config: {
          type: 'object',
          additionalProperties: { type: 'string' },
          example: { dc: 'sa', accountsBaseUrl: 'https://accounts.zoho.sa', apiBaseUrl: 'https://phonebridge.zoho.sa/phonebridge/v3', clientId: '1000.XXXX' },
        },
        secrets: {
          type: 'object',
          additionalProperties: { type: 'string' },
          example: { clientSecret: '...', refreshToken: '...', callbackToken: '...' },
        },
      },
    },
  })
  @UseGuards(AdminKeyGuard)
  @Post('integrations')
  async createIntegration(
    @Body()
    body: {
      tenantSlug: string;
      type: CrmType;
      config: Record<string, string>;
      secrets: Record<string, string>;
    },
  ) {
    const tenant = await this.tenantRepo.findOneBy({ slug: body?.tenantSlug ?? '' });
    if (!tenant) throw new BadRequestException('Unknown tenantSlug');
    if (!['zoho', 'salesforce'].includes(body.type)) throw new BadRequestException('type must be zoho|salesforce');
    const row = await this.integrationRepo.save({
      tenantId: tenant.id,
      type: body.type,
      enabled: true,
      config: body.config ?? {},
      secretsEnc: this.crypto.encrypt(JSON.stringify(body.secrets ?? {})),
    });
    return { id: row.id, type: row.type };
  }
}
