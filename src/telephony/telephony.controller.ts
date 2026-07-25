import { Body, Controller, Get, Post, Req, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiProperty, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, Matches } from 'class-validator';
import { TenantApiKeyGuard } from '../api/api-key.guard';
import { ResolvedTenant } from '../tenants/tenant-registry.service';
import { PbxSupervisorService } from '../pbx-connector/pbx-supervisor.service';
import { AriSupervisorService } from '../pbx-connector/ari/ari-supervisor.service';
import { CoachMode, SupervisorService } from './supervisor.service';
import { QueueStatsService } from './queue-stats.service';

class MonitorDto {
  @ApiProperty({ example: '1002', description: "Supervisor's extension (rings first)" })
  @IsString() @Matches(/^\d{3,6}$/)
  supervisorExt: string;

  @ApiProperty({ example: '1001', description: 'Agent extension to coach' })
  @IsString() @Matches(/^\d{3,6}$/)
  agentExt: string;

  @ApiProperty({ enum: ['spy', 'whisper', 'barge'], example: 'whisper' })
  @IsIn(['spy', 'whisper', 'barge'])
  mode: CoachMode;

  @ApiProperty({ required: false, description: 'ARI only: the agent live channel id to snoop' })
  @IsOptional() @IsString()
  agentChannelId?: string;
}

@Controller()
export class TelephonyController {
  constructor(
    private readonly supervisor: SupervisorService,
    private readonly queues: QueueStatsService,
    private readonly ami: PbxSupervisorService,
    private readonly ari: AriSupervisorService,
  ) {}

  @ApiTags('Supervisor')
  @ApiSecurity('tenant-key')
  @ApiOperation({ summary: 'In-call coaching: spy / whisper / barge an agent (Phase 11)' })
  @UseGuards(TenantApiKeyGuard)
  @Post('v1/supervisor/monitor')
  monitor(@Req() req: { tenant: ResolvedTenant }, @Body() dto: MonitorDto) {
    return this.supervisor.monitor(req.tenant, dto.supervisorExt, dto.agentExt, dto.mode, dto.agentChannelId);
  }

  @ApiTags('Queues')
  @ApiSecurity('tenant-key')
  @ApiOperation({ summary: 'Live queue/ACD wallboard for the tenant (Phase 11)' })
  @UseGuards(TenantApiKeyGuard)
  @Get('v1/queues')
  queueStats(@Req() req: { tenant: ResolvedTenant }) {
    return { queues: this.queues.snapshot([req.tenant.entity.pbxConnectionId]) };
  }

  @ApiTags('Health')
  @ApiOperation({ summary: 'ARI (Stasis) connection status (no auth)' })
  @Get('health/ari')
  ariStatus() {
    return { connections: this.ari.statuses() };
  }
}
