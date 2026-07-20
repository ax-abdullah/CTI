import { Column, Entity, OneToMany, PrimaryGeneratedColumn } from 'typeorm';
import { Tenant } from './tenant.entity';

export type PbxConnectionMode = 'direct' | 'reverse';

/**
 * One AMI connection target. Several tenants may share a connection when a
 * single Asterisk box hosts multiple tenants (contexts partition them).
 *
 * mode 'direct': the cloud dials out to host:port (VPN / ACL'd 5038).
 * mode 'reverse': the customer's on-prem connector agent dials OUT to us
 * (/connector-ws) and tunnels AMI — no inbound firewall holes at the
 * customer. host/port then describe the AMI address *as seen by the agent*.
 */
@Entity('pbx_connections')
export class PbxConnection {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ unique: true })
  name: string;

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
