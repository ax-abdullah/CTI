import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
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

  @Get('health')
  health() {
    const connections = this.supervisor.statuses();
    return {
      status: connections.every((c) => c.connected) ? 'ok' : 'degraded',
      connections,
    };
  }

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

  @UseGuards(TenantApiKeyGuard)
  @Get('v1/calls')
  activeCalls(@Req() req: { tenant: ResolvedTenant }) {
    return { calls: this.callState.activeCalls(req.tenant.entity.slug) };
  }

  @UseGuards(TenantApiKeyGuard)
  @Get('v1/agents/state')
  agentStates(@Req() req: { tenant: ResolvedTenant }) {
    return { agents: this.presence.snapshot(req.tenant.entity.slug) };
  }
}
