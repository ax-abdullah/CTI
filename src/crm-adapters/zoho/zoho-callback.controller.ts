import {
  BadRequestException,
  Body,
  Controller,
  Headers,
  NotFoundException,
  Param,
  Post,
  UnauthorizedException,
} from '@nestjs/common';
import { timingSafeEqual } from 'node:crypto';
import { ApiOperation, ApiParam, ApiProperty, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { IsString, Matches } from 'class-validator';
import { TenantRegistryService } from '../../tenants/tenant-registry.service';
import { PbxSupervisorService } from '../../pbx-connector/pbx-supervisor.service';

class ZohoClickToCallDto {
  @ApiProperty({ description: 'The Zoho user who clicked the dial icon', example: 'zuid-1001' })
  @IsString()
  zohoUserId: string;

  @ApiProperty({ description: 'Number Zoho asked us to dial', example: '+966501234567' })
  @IsString()
  @Matches(/^\+?\d{3,15}$/, { message: 'number must be digits with optional leading +' })
  number: string;
}

/**
 * Zoho click-to-call lands here: when an agent clicks a phone number inside
 * Zoho CRM, Zoho POSTs to the callback URL registered for the integration.
 * Authenticated by the per-integration callback token (X-Zoho-Token),
 * stored encrypted in the integration secrets. The Zoho user is mapped to
 * an agent extension via Agent.crmRefs.zoho, then it's a normal
 * agent-leg-first originate.
 */
@Controller('v1/integrations/zoho')
export class ZohoCallbackController {
  constructor(
    private readonly registry: TenantRegistryService,
    private readonly supervisor: PbxSupervisorService,
  ) {}

  @ApiTags('Zoho integration')
  @ApiSecurity('zoho-callback-token')
  @ApiParam({ name: 'tenantSlug', example: 'tenant-a' })
  @ApiOperation({
    summary: "Zoho click-to-call callback (Zoho's dial icon lands here)",
    description:
      'Registered as the click-to-call URL of the PhoneBridge integration. Maps the Zoho user ' +
      'to an agent extension (Agent.crmRefs.zoho) and performs an agent-leg-first originate.',
  })
  @Post(':tenantSlug/click-to-call')
  async clickToCall(
    @Param('tenantSlug') tenantSlug: string,
    @Headers('x-zoho-token') token: string | undefined,
    @Body() dto: ZohoClickToCallDto,
  ) {
    const integration = this.registry.integrationFor(tenantSlug, 'zoho');
    if (!integration) throw new NotFoundException('No Zoho integration for this tenant');

    const expected = this.registry.integrationSecrets(integration).callbackToken;
    if (
      !token ||
      !expected ||
      token.length !== expected.length ||
      !timingSafeEqual(Buffer.from(token), Buffer.from(expected))
    ) {
      throw new UnauthorizedException('Invalid callback token');
    }

    const tenant = this.registry.tenantBySlug(tenantSlug)!;
    const agent = tenant.entity.agents?.find((a) => a.crmRefs?.zoho === dto.zohoUserId);
    if (!agent) {
      throw new BadRequestException(`Zoho user ${dto.zohoUserId} is not mapped to an agent`);
    }

    const { callRef } = await this.supervisor.originate(tenant, agent.ext, dto.number);
    return { status: 'originating', callRef, agentExt: agent.ext, number: dto.number };
  }
}
