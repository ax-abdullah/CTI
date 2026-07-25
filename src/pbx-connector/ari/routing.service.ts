import { Injectable, Logger } from '@nestjs/common';

/** What a caller lookup yields (from a CRM or a cached contact store). */
export interface ResolvedContact {
  name?: string;
  vip?: boolean;
  /** Preferred queue/skill for this contact, if any. */
  queue?: string;
}

export interface RoutingDecision {
  known: boolean;
  contactName?: string;
  priority: 'vip' | 'normal';
  /** Target queue/skill the dialplan should send the caller to. */
  queue: string;
  /** Optional media to play before routing (e.g. a personalized greeting). */
  prompt?: string;
  /** Channel variables the Stasis connector sets before continue-in-dialplan. */
  variables: Record<string, string>;
}

/**
 * CRM-driven IVR: turns a caller lookup into a routing decision the ARI
 * Stasis connector applies (set channel vars + continue-in-dialplan). The
 * lookup itself is a pluggable hook (a real CRM call); this service is the
 * pure, testable decision layer, so routing policy is verifiable without a
 * live PBX.
 */
@Injectable()
export class RoutingService {
  private readonly logger = new Logger(RoutingService.name);
  private readonly defaultQueue = 'general';
  private readonly vipQueue = 'priority';

  decide(number: string, contact: ResolvedContact | null): RoutingDecision {
    if (!contact) {
      return {
        known: false,
        priority: 'normal',
        queue: this.defaultQueue,
        variables: { CTI_KNOWN: 'false', CTI_PRIORITY: 'normal', CTI_QUEUE: this.defaultQueue },
      };
    }
    const priority = contact.vip ? 'vip' : 'normal';
    const queue = contact.vip ? this.vipQueue : contact.queue ?? this.defaultQueue;
    const decision: RoutingDecision = {
      known: true,
      contactName: contact.name,
      priority,
      queue,
      prompt: contact.name ? `sound:welcome` : undefined,
      variables: {
        CTI_KNOWN: 'true',
        CTI_PRIORITY: priority,
        CTI_QUEUE: queue,
        ...(contact.name ? { CTI_CONTACT_NAME: contact.name } : {}),
      },
    };
    this.logger.debug(`routing ${number} -> ${queue} (${priority}, known=${decision.known})`);
    return decision;
  }
}
