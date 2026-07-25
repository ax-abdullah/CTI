import { Column, Entity, OneToMany, PrimaryGeneratedColumn } from 'typeorm';
import { Tenant } from './tenant.entity';

export type PbxConnectionMode = 'direct' | 'reverse';
export type PbxDriver = 'ami' | 'ari';

/**
 * One PBX connection target. Several tenants may share a connection when a
 * single Asterisk box hosts multiple tenants (contexts partition them).
 *
 * driver 'ami' (default): the primary event + originate surface.
 *   mode 'direct'  — the cloud dials out to host:port (VPN / ACL'd 5038).
 *   mode 'reverse' — the on-prem connector agent dials OUT to us
 *     (/connector-ws) and tunnels AMI — no inbound firewall holes.
 * driver 'ari' (Phase 11): host:port is the ARI HTTP endpoint (e.g. :8088),
 *   username/secret are the ARI user, `ariApp` is the Stasis app name. Used
 *   for media control (coaching snoop) and CRM-driven IVR; emits the same
 *   normalized call.* vocabulary from Stasis events.
 */
@Entity('pbx_connections')
export class PbxConnection {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ unique: true })
  name: string;

  @Column({ type: 'varchar', default: 'ami' })
  driver: PbxDriver;

  /** Stasis application name (ari driver only). */
  @Column({ type: 'varchar', nullable: true })
  ariApp: string | null;

  @Column({ type: 'varchar', default: 'direct' })
  mode: PbxConnectionMode;

  /** sha256 of the reverse-connector token (reverse mode only). */
  @Column({ type: 'varchar', nullable: true })
  connectorTokenHash: string | null;

  @Column()
  host: string;

  @Column({ type: 'int', default: 5038 })
  port: number;

  @Column()
  username: string;

  /** AES-256-GCM ciphertext (CryptoService), never plaintext. */
  @Column()
  secretEnc: string;

  @OneToMany(() => Tenant, (t) => t.pbxConnection)
  tenants: Tenant[];
}
