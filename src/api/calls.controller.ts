import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { AmiConnectionService } from '../pbx-connector/ami-connection.service';
import { CallStateService } from '../call-state/call-state.service';
import { ApiKeyGuard } from './api-key.guard';
import { OriginateDto } from './originate.dto';

@Controller()
export class CallsController {
  constructor(
    private readonly ami: AmiConnectionService,
    private readonly callState: CallStateService,
  ) {}

  @Get('health')
  health() {
    return { status: this.ami.connected ? 'ok' : 'degraded', pbxConnected: this.ami.connected };
  }

  @UseGuards(ApiKeyGuard)
  @Post('v1/calls/originate')
  async originate(@Body() dto: OriginateDto) {
    const { callRef } = await this.ami.originate({ agentExt: dto.agentExt, number: dto.number });
    return { status: 'originating', callRef, agentExt: dto.agentExt, number: dto.number };
  }

  @UseGuards(ApiKeyGuard)
  @Get('v1/calls')
  activeCalls() {
    return { calls: this.callState.activeCalls() };
  }
}
