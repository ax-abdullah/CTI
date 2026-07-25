import { Logger } from '@nestjs/common';
import { OnGatewayConnection, OnGatewayDisconnect, WebSocketGateway } from '@nestjs/websockets';
import type { IncomingMessage } from 'node:http';
import type { WebSocket } from 'ws';
import { TenantRegistryService } from '../tenants/tenant-registry.service';
import { ConnectorFileService } from './connector-file.service';

/**
 * The file channel a reverse-mode connector agent opens alongside its AMI
 * tunnel. Authenticated by the same connector token; once attached, the
 * cloud can pull recording files from the agent on demand.
 */
@WebSocketGateway({ path: '/connector-files' })
export class ConnectorFileGateway implements OnGatewayConnection, OnGatewayDisconnect {
  private readonly logger = new Logger(ConnectorFileGateway.name);

  constructor(
    private readonly registry: TenantRegistryService,
    private readonly files: ConnectorFileService,
  ) {}

  handleConnection(socket: WebSocket, request: IncomingMessage): void {
    const url = new URL(request.url ?? '/', 'http://localhost');
    const token = url.searchParams.get('token') ?? '';
    const connection = token ? this.registry.connectionByConnectorToken(token) : undefined;
    if (!connection) {
      socket.close(4401, 'invalid token');
      return;
    }
    (socket as unknown as { _connId?: string })._connId = connection.id;
    this.files.register(connection.id, socket);
    this.logger.log(`File channel attached for '${connection.name}'`);
  }

  handleDisconnect(socket: WebSocket): void {
    const id = (socket as unknown as { _connId?: string })._connId;
    if (id) this.files.unregister(id);
  }
}
