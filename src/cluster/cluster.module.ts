import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ClusterBusService } from './cluster-bus.service';
import { ClusterRpcService } from './cluster-rpc.service';
import { LeaseService } from './lease.service';
import { POD_ID, POD_IDENTITY } from './cluster.types';

/**
 * The three primitives that make more than one replica safe (ADR-0012):
 * leases for single-writer ownership of a PBX, a Redis-backed event bus so
 * events reach the pod holding an agent's socket, and a command channel so a
 * request can reach the pod holding a PBX socket.
 *
 * Global because ownership is a cross-cutting concern — the supervisors, the
 * gateways and the admin controller all need it without re-importing.
 */
@Global()
@Module({
  providers: [
    {
      provide: POD_IDENTITY,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => config.get<string>('POD_ID') ?? POD_ID,
    },
    LeaseService,
    ClusterBusService,
    ClusterRpcService,
  ],
  exports: [POD_IDENTITY, LeaseService, ClusterBusService, ClusterRpcService],
})
export class ClusterModule {}
