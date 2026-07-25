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
import { ApiExcludeEndpoint, ApiOperation, ApiProperty, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { IsString, Matches } from 'class-validator';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { TenantApiKeyGuard } from '../api/api-key.guard';
import { CtiThrottlerGuard } from '../api/cti-throttler.guard';
import { PbxSupervisorService } from '../pbx-connector/pbx-supervisor.service';
import { ResolvedTenant, TenantRegistryService } from '../tenants/tenant-registry.service';
import { CryptoService } from '../tenants/crypto.service';
import { signAgentToken, verifyAgentToken } from './agent-token.util';

class AgentLoginDto {
  @ApiProperty({ description: 'Agent extension within the calling tenant', example: '1001' })
  @IsString()
  @Matches(/^\d{3,6}$/)
  ext: string;
}

class SoftphoneDialDto {
  @ApiProperty({ description: 'Number to dial', example: '+966501234567' })
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
    private readonly crypto: CryptoService,
  ) {}

  /**
   * Issues an agent session token. Guarded by the tenant API key — in the
   * embedded flow the softphone page obtains it from the hosting app's
   * backend; agent-credential SSO is a Phase 5 concern.
   */
  @ApiTags('Softphone')
  @ApiSecurity('tenant-key')
  @ApiOperation({
    summary: 'Issue an agent session token',
    description:
      'Returns a short-lived HS256 token identifying (tenant, extension). Used as the Bearer ' +
      'token for /v1/softphone/originate and as ?token= on the /softphone-ws WebSocket.',
  })
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

  /**
   * WebRTC registration parameters for the token's agent, so the softphone
   * can register a SIP endpoint over wss and carry real audio in the browser.
   * The SIP password is returned to the browser (standard for WebRTC UAs) —
   * it is protected by the agent token + HTTPS and scoped to that endpoint.
   */
  @ApiTags('Softphone')
  @ApiSecurity('agent-token')
  @ApiOperation({ summary: 'WebRTC (JsSIP) registration config for the agent' })
  @Get('v1/softphone/webrtc-config')
  webrtcConfig(@Headers('authorization') authorization: string | undefined) {
    const claims = this.requireAgent(authorization);
    const tenant = this.registry.tenantBySlug(claims.tenantSlug);
    const agent = tenant?.entity.agents?.find((a) => a.ext === claims.ext);
    if (!agent) throw new UnauthorizedException('Unknown agent');

    const wssUrl = this.config.get<string>('WEBRTC_WSS_URL');
    const domain = this.config.get<string>('WEBRTC_SIP_DOMAIN');
    const password = agent.sipPasswordEnc ? this.crypto.decrypt(agent.sipPasswordEnc) : undefined;
    if (!wssUrl || !domain || !password) {
      throw new BadRequestException('WebRTC is not configured for this agent/tenant');
    }
    const authUser = agent.sipUsername ?? agent.ext;
    const stun = this.config.get<string>('WEBRTC_STUN_URL');
    return {
      wssUrl,
      sipUri: `sip:${authUser}@${domain}`,
      authUser,
      password,
      iceServers: stun ? [{ urls: stun }] : [],
    };
  }

  /** Verifies the Bearer agent token or throws 401. */
  private requireAgent(authorization: string | undefined) {
    const token = authorization?.startsWith('Bearer ') ? authorization.slice(7) : '';
    const claims = verifyAgentToken(token, this.config.getOrThrow('SOFTPHONE_JWT_SECRET'));
    if (!claims) throw new UnauthorizedException('Invalid agent token');
    return claims;
  }

  /** Click-to-dial from the softphone page (Open CTI onClickToDial). */
  @ApiTags('Softphone')
  @ApiSecurity('agent-token')
  @ApiOperation({ summary: "Click-to-dial as the token's agent (agent leg rings first)" })
  @UseGuards(CtiThrottlerGuard)
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
  @ApiExcludeEndpoint()
  @Get('softphone')
  @Header('Content-Type', 'text/html; charset=utf-8')
  page(): string {
    return readFileSync(join(__dirname, '..', '..', 'public', 'softphone.html'), 'utf8');
  }

  /** Call Center definition template for the Salesforce admin to import. */
  @ApiExcludeEndpoint()
  @Get('softphone/callcenter-definition.xml')
  @Header('Content-Type', 'application/xml; charset=utf-8')
  callCenterXml(): string {
    return readFileSync(join(__dirname, '..', '..', 'public', 'callcenter-definition.xml'), 'utf8');
  }

  /** Self-hosted JsSIP bundle for the WebRTC softphone (no external CDN). */
  @ApiExcludeEndpoint()
  @Get('vendor/jssip.js')
  @Header('Content-Type', 'application/javascript; charset=utf-8')
  @Header('Cache-Control', 'public, max-age=86400')
  jssip(): string {
    SoftphoneController.jssipCache ??= readFileSync(
      join(__dirname, '..', '..', 'public', 'vendor', 'jssip.js'),
      'utf8',
    );
    return SoftphoneController.jssipCache;
  }

  private static jssipCache?: string;
}
