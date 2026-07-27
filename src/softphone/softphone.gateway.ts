import { Logger, OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OnEvent } from '@nestjs/event-emitter';
import { OnGatewayConnection, OnGatewayDisconnect, WebSocketGateway } from '@nestjs/websockets';
import type { IncomingMessage } from 'node:http';
import type { WebSocket } from 'ws';
import {
  CALL_EVENTS,
  CallAnsweredEvent,
  CallEndedEvent,
  CallRingingEvent,
} from '../call-state/normalized-events';
import { AGENT_STATE_EVENT, AgentStateEvent } from '../presence/presence.service';
import { QUEUE_STATS_EVENT } from '../telephony/queue-stats.service';
import { TenantRegistryService } from '../tenants/tenant-registry.service';
import { verifyAgentToken } from './agent-token.util';

interface AgentSocket {
  socket: WebSocket;
  tenantSlug: string;
  ext: string;
}

/**
 * Real-time channel to embedded softphones (Salesforce Open CTI panel, or
 * any other client). Connect with ws://host/softphone-ws?token=<agent JWT>;
 * each socket receives only its own agent's calls.
 *
 * Every call event carries its own agentExt, so this gateway holds no
 * per-call state — only the live sockets. Any replica can therefore serve
 * any agent, which is what lets the API tier scale independently of the pod
 * that owns the PBX (ADR-0012).
 */
@WebSocketGateway({ path: '/softphone-ws' })
export class SoftphoneGateway
  implements OnGatewayConnection, OnGatewayDisconnect, OnApplicationShutdown
{
  private readonly logger = new Logger(SoftphoneGateway.name);
  private readonly clients = new Map<WebSocket, AgentSocket>();

  constructor(
    private readonly config: ConfigService,
    private readonly registry: TenantRegistryService,
  ) {}

  handleConnection(socket: WebSocket, request: IncomingMessage): void {
    const url = new URL(request.url ?? '/', 'http://localhost');
    const token = url.searchParams.get('token') ?? '';
    const claims = verifyAgentToken(token, this.config.getOrThrow('SOFTPHONE_JWT_SECRET'));
    if (!claims) {
      socket.close(4401, 'invalid token');
      return;
    }
    this.clients.set(socket, { socket, tenantSlug: claims.tenantSlug, ext: claims.ext });
    socket.send(JSON.stringify({ type: 'connected', ext: claims.ext }));
    this.logger.log(`Softphone connected: ${claims.tenantSlug}/${claims.ext}`);
  }

  handleDisconnect(socket: WebSocket): void {
    const client = this.clients.get(socket);
    if (client) this.logger.log(`Softphone disconnected: ${client.tenantSlug}/${client.ext}`);
    this.clients.delete(socket);
  }

  /** Live socket count — the primary scale signal for the api role. */
  clientCount(): number {
    return this.clients.size;
  }

  /**
   * Rolling deploys are routine, so agents must not simply have the socket cut
   * from under them. 1012 ("Service Restart") is the status a client is meant
   * to treat as "come back shortly", which is exactly right here: another
   * replica is already able to serve them.
   */
  onApplicationShutdown(): void {
    for (const { socket, tenantSlug, ext } of this.clients.values()) {
      try {
        socket.close(1012, 'server restarting');
      } catch {
        /* already gone */
      }
      this.logger.log(`Draining softphone ${tenantSlug}/${ext}`);
    }
    this.clients.clear();
  }

  // Each event carries its own agentExt, so no per-call routing state is kept
  // here. That matters across replicas: the pod holding an agent's socket is
  // usually not the pod that owns the PBX, and it receives these events over
  // the cluster bus — often without ever having seen the matching ringing.
  @OnEvent(CALL_EVENTS.ringing)
  onRinging(event: CallRingingEvent): void {
    if (!event.agentExt) return;
    this.push(event.tenantId, event.agentExt, { type: 'call.ringing', ...event });
  }

  @OnEvent(CALL_EVENTS.answered)
  onAnswered(event: CallAnsweredEvent): void {
    if (event.agentExt) this.push(event.tenantId, event.agentExt, { type: 'call.answered', ...event });
  }

  @OnEvent(CALL_EVENTS.ended)
  onEnded(event: CallEndedEvent): void {
    if (event.agentExt) this.push(event.tenantId, event.agentExt, { type: 'call.ended', ...event });
  }

  /** Presence is a team signal: broadcast to every socket of the tenant. */
  @OnEvent(AGENT_STATE_EVENT)
  onAgentState(event: AgentStateEvent): void {
    const payload = JSON.stringify({ type: AGENT_STATE_EVENT, ...event });
    for (const client of this.clients.values()) {
      if (client.tenantSlug === event.tenantId) client.socket.send(payload);
    }
  }

  /** Queue wallboard: stream to every socket of the tenants on that PBX. */
  @OnEvent(QUEUE_STATS_EVENT)
  onQueueStats(stat: { connectionId: string }): void {
    const slugs = this.registry.tenantSlugsForConnection(stat.connectionId);
    if (!slugs.length) return;
    const payload = JSON.stringify({ type: QUEUE_STATS_EVENT, ...stat });
    for (const client of this.clients.values()) {
      if (slugs.includes(client.tenantSlug)) client.socket.send(payload);
    }
  }

  private push(tenantSlug: string, ext: string, message: unknown): void {
    const payload = JSON.stringify(message);
    for (const client of this.clients.values()) {
      if (client.tenantSlug === tenantSlug && client.ext === ext) {
        client.socket.send(payload);
      }
    }
  }
}
