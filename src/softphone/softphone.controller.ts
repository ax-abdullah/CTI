import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Header,
  Headers,
  Post,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { IsString, Matches } from 'class-validator';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { TenantApiKeyGuard } from '../api/api-key.guard';
import { PbxSupervisorService } from '../pbx-connector/pbx-supervisor.service';
import { ResolvedTenant, TenantRegistryService } from '../tenants/tenant-registry.service';
import { signAgentToken, verifyAgentToken } from './agent-token.util';

class AgentLoginDto {
  @IsString()
  @Matches(/^\d{3,6}$/)
  ext: string;
}

class SoftphoneDialDto {
  @IsString()
  @Matches(/^\+?\d{3,15}$/, { message: 'number must be digits with optional leading +' })
  number: string;
}

@Controller()
export class SoftphoneController {
  private readonly tokenTtlSec = 8 * 3600; // one shift

  constructor(
    private readonly config: ConfigService,
    private readonly registry: TenantRegistryService,
    private readonly supervisor: PbxSupervisorService,
  ) {}

  /**
   * Issues an agent session token. Guarded by the tenant API key — in the
   * embedded flow the softphone page obtains it from the hosting app's
   * backend; agent-credential SSO is a Phase 5 concern.
   */
  @UseGuards(TenantApiKeyGuard)
  @Post('v1/softphone/login')
  login(@Req() req: { tenant: ResolvedTenant }, @Body() dto: AgentLoginDto) {
    const tenant = req.tenant;
    const agent = tenant.entity.agents?.find((a) => a.ext === dto.ext);
    if (!agent) throw new BadRequestException(`No agent with ext ${dto.ext} in this tenant`);
    const token = signAgentToken(
      {
        tenantSlug: tenant.entity.slug,
        ext: agent.ext,
        exp: Math.floor(Date.now() / 1000) + this.tokenTtlSec,
      },
      this.config.getOrThrow('SOFTPHONE_JWT_SECRET'),
    );
    return { token, ext: agent.ext, displayName: agent.displayName, expiresInSec: this.tokenTtlSec };
  }

  /** Click-to-dial from the softphone page (Open CTI onClickToDial). */
  @Post('v1/softphone/originate')
  async originate(
    @Headers('authorization') authorization: string | undefined,
    @Body() dto: SoftphoneDialDto,
  ) {
    const token = authorization?.startsWith('Bearer ') ? authorization.slice(7) : '';
    const claims = verifyAgentToken(token, this.config.getOrThrow('SOFTPHONE_JWT_SECRET'));
    if (!claims) throw new UnauthorizedException('Invalid agent token');
    const tenant = this.registry.tenantBySlug(claims.tenantSlug);
    if (!tenant) throw new UnauthorizedException('Unknown tenant');

    const { callRef } = await this.supervisor.originate(tenant, claims.ext, dto.number);
    return { status: 'originating', callRef, agentExt: claims.ext, number: dto.number };
  }

  /** The softphone page Salesforce embeds (see callcenter-definition.xml). */
  @Get('softphone')
  @Header('Content-Type', 'text/html; charset=utf-8')
  page(): string {
    return readFileSync(join(__dirname, '..', '..', 'public', 'softphone.html'), 'utf8');
  }

  /** Call Center definition template for the Salesforce admin to import. */
  @Get('softphone/callcenter-definition.xml')
  @Header('Content-Type', 'application/xml; charset=utf-8')
  callCenterXml(): string {
    return readFileSync(join(__dirname, '..', '..', 'public', 'callcenter-definition.xml'), 'utf8');
  }
}
