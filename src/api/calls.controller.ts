import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { PbxSupervisorService } from '../pbx-connector/pbx-supervisor.service';
import { CallStateService } from '../call-state/call-state.service';
import { PresenceService } from '../presence/presence.service';
import { ResolvedTenant } from '../tenants/tenant-registry.service';
import { TenantApiKeyGuard } from './api-key.guard';
import { OriginateDto } from './originate.dto';

@Controller()
export class CallsController {
  constructor(
    private readonly supervisor: PbxSupervisorService,
    private readonly callState: CallStateService,
    private readonly presence: PresenceService,
  ) {}

  @ApiTags('Health')
  @ApiOperation({ summary: 'Liveness + per-PBX-connection state (no auth)' })
  @Get('health')
  health() {
    const connections = this.supervisor.statuses();
    return {
      status: connections.every((c) => c.connected) ? 'ok' : 'degraded',
      connections,
    };
  }

  @ApiTags('Tenant API')
  @ApiSecurity('tenant-key')
  @ApiOperation({
    summary: 'Click-to-call (agent-leg-first originate)',
    description:
      "Rings the agent's phone first; when answered, the PBX dials the destination. " +
      'Returns a callRef that reappears on the resulting call.* events.',
  })
  @UseGuards(TenantApiKeyGuard)
  @Post('v1/calls/originate')
  async originate(@Req() req: { tenant: ResolvedTenant }, @Body() dto: OriginateDto) {
    const tenant = req.tenant;
    // A tenant's key can only ring that tenant's own extensions.
    if (!tenant.extensionRegex.test(dto.agentExt)) {
      throw new BadRequestException(
        `agentExt ${dto.agentExt} is not an extension of tenant ${tenant.entity.slug}`,
      );
    }
    const { callRef } = await this.supervisor.originate(tenant, dto.agentExt, dto.number);
    return { status: 'originating', callRef, agentExt: dto.agentExt, number: dto.number };
  }

  @ApiTags('Tenant API')
  @ApiSecurity('tenant-key')
  @ApiOperation({ summary: "Snapshot of the tenant's in-flight calls" })
  @UseGuards(TenantApiKeyGuard)
  @Get('v1/calls')
  activeCalls(@Req() req: { tenant: ResolvedTenant }) {
    return { calls: this.callState.activeCalls(req.tenant.entity.slug) };
  }

  @ApiTags('Tenant API')
  @ApiSecurity('tenant-key')
  @ApiOperation({ summary: 'Current presence of every agent in the tenant' })
  @UseGuards(TenantApiKeyGuard)
  @Get('v1/agents/state')
  agentStates(@Req() req: { tenant: ResolvedTenant }) {
    return { agents: this.presence.snapshot(req.tenant.entity.slug) };
  }
}
