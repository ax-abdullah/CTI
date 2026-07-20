import { Logger } from '@nestjs/common';
import { OnGatewayConnection, WebSocketGateway } from '@nestjs/websockets';
import type { IncomingMessage } from 'node:http';
import { createWebSocketStream, type WebSocket } from 'ws';
import { TenantRegistryService } from '../tenants/tenant-registry.service';
import { PbxSupervisorService } from './pbx-supervisor.service';

/**
 * Entry point for on-prem connector agents (scripts/connector-agent.mjs).
 * The agent dials OUT to wss://cti/connector-ws?token=... from inside the
 * customer network and pipes the local AMI socket over the WebSocket, so
 * the customer opens no inbound ports. After token auth the raw byte
 * stream is handed to the SupervisedConnection, which logs in with the
 * credentials stored (encrypted) in the cloud registry — the agent itself
 * never holds AMI credentials.
 */
@WebSocketGateway({ path: '/connector-ws' })
export class ReverseConnectorGateway implements OnGatewayConnection {
  private readonly logger = new Logger(ReverseConnectorGateway.name);

  constructor(
    private readonly registry: TenantRegistryService,
    private readonly supervisor: PbxSupervisorService,
  ) {}

  handleConnection(socket: WebSocket, request: IncomingMessage): void {
    const url = new URL(request.url ?? '/', 'http://localhost');
    const token = url.searchParams.get('token') ?? '';
    const connection = token ? this.registry.connectionByConnectorToken(token) : undefined;
    if (!connection) {
      this.logger.warn('Reverse connector rejected: invalid token');
      socket.close(4401, 'invalid token');
      return;
    }
    this.logger.log(`Reverse connector attached for '${connection.name}'`);
    const stream = createWebSocketStream(socket);

    // The duplex wrapper does not reliably surface remote death; watch the
    // socket itself and tear the stream down explicitly. Heartbeats catch
    // the FIN-less case (agent host power loss, NAT timeout).
    let alive = true;
    const heartbeat = setInterval(() => {
      if (!alive) {
        this.logger.warn(`Reverse connector '${connection.name}' missed heartbeat; terminating`);
        socket.terminate();
        return;
      }
      alive = false;
      socket.ping();
    }, 15_000);
    socket.on('pong', () => (alive = true));
    socket.on('close', () => {
      clearInterval(heartbeat);
      stream.destroy();
    });
    socket.on('error', () => stream.destroy());

    void this.supervisor.attachReverseStream(connection.id, stream);
  }
}
