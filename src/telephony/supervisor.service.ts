import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { ResolvedTenant } from '../tenants/tenant-registry.service';
import { PbxSupervisorService } from '../pbx-connector/pbx-supervisor.service';
import { AriSupervisorService } from '../pbx-connector/ari/ari-supervisor.service';

export type CoachMode = 'spy' | 'whisper' | 'barge';

/**
 * In-call coaching: a supervisor listens to (`spy`), talks to only the agent
 * (`whisper`), or joins (`barge`) a live call.
 *
 * AMI path (default): Originate the supervisor's phone into ChanSpy on the
 * agent's channel with the right options — works on the existing, well-tested
 * AMI connections and the lab. ARI path: a snoop channel via the AriClient
 * (needs the agent's live channel id).
 */
@Injectable()
export class SupervisorService {
  private readonly logger = new Logger(SupervisorService.name);

  constructor(
    private readonly ami: PbxSupervisorService,
    private readonly ari: AriSupervisorService,
  ) {}

  /** ChanSpy(chanprefix,options): q = quiet, w = whisper, B = barge. */
  static chanSpyData(agentChannelPrefix: string, mode: CoachMode): string {
    const opts = 'q' + (mode === 'whisper' ? 'w' : mode === 'barge' ? 'B' : '');
    return `${agentChannelPrefix},${opts}`;
  }

  /** ARI snoop direction for the mode. */
  static snoopOpts(mode: CoachMode): { spy: 'in' | 'both'; whisper: 'none' | 'out' | 'both' } {
    if (mode === 'whisper') return { spy: 'in', whisper: 'out' };
    if (mode === 'barge') return { spy: 'both', whisper: 'both' };
    return { spy: 'in', whisper: 'none' };
  }

  async monitor(
    tenant: ResolvedTenant,
    supervisorExt: string,
    agentExt: string,
    mode: CoachMode,
    agentChannelId?: string,
  ): Promise<{ status: string; mode: CoachMode; agentExt: string }> {
    if (!tenant.extensionRegex.test(supervisorExt) || !tenant.extensionRegex.test(agentExt)) {
      throw new BadRequestException('supervisorExt and agentExt must be extensions of this tenant');
    }
    const connectionId = tenant.entity.pbxConnectionId;

    // ARI connection with a known channel id → snoop.
    const ariClient = this.ari.clientFor(connectionId);
    if (ariClient && agentChannelId) {
      const app = 'cti';
      await ariClient.snoop(agentChannelId, { ...SupervisorService.snoopOpts(mode), app });
      this.logger.log(`[${tenant.entity.slug}] ARI ${mode} on ${agentChannelId} by ${supervisorExt}`);
      return { status: 'coaching', mode, agentExt };
    }

    if (!this.ami.hasConnection(connectionId)) {
      throw new BadRequestException('No live PBX connection for this tenant');
    }
    // AMI ChanSpy: ring the supervisor, then spy the agent's channel.
    const channelPrefix = tenant.entity.originateChannelTemplate.replaceAll('{ext}', agentExt).split('-')[0];
    const res = await this.ami.sendAction(connectionId, {
      Action: 'Originate',
      Channel: tenant.entity.originateChannelTemplate.replaceAll('{ext}', supervisorExt),
      Application: 'ChanSpy',
      Data: SupervisorService.chanSpyData(channelPrefix, mode),
      CallerID: `Coach <${supervisorExt}>`,
      Async: 'true',
      Variable: `CTI_COACH=${randomUUID()}`,
    });
    if (res.Response !== 'Success') throw new BadRequestException(`Coaching Originate rejected: ${res.Message ?? 'unknown'}`);
    this.logger.log(`[${tenant.entity.slug}] AMI ${mode} on ${agentExt} by ${supervisorExt}`);
    return { status: 'coaching', mode, agentExt };
  }
}
