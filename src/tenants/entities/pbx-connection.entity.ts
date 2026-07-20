import { Column, Entity, OneToMany, PrimaryGeneratedColumn } from 'typeorm';
import { Tenant } from './tenant.entity';

/**
 * One AMI connection target. Several tenants may share a connection when a
 * single Asterisk box hosts multiple tenants (contexts partition them).
 */
@Entity('pbx_connections')
export class PbxConnection {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ unique: true })
  name: string;

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
