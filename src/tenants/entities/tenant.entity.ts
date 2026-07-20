import { Column, Entity, JoinColumn, ManyToOne, OneToMany, PrimaryGeneratedColumn } from 'typeorm';
import { PbxConnection } from './pbx-connection.entity';
import { Agent } from './agent.entity';

@Entity('tenants')
export class Tenant {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ unique: true })
  slug: string;

  @Column()
  name: string;

  @ManyToOne(() => PbxConnection, (c) => c.tenants, { nullable: false, eager: true })
  @JoinColumn({ name: 'pbxConnectionId' })
  pbxConnection: PbxConnection;

  @Column()
  pbxConnectionId: string;

  /** Regex for this tenant's extensions, e.g. ^1\d{3}$ */
  @Column()
  extensionPattern: string;

  /** Dialplan contexts owned by this tenant (routes shared-PBX events). */
  @Column('simple-array')
  contexts: string[];

  @Column()
  originateContext: string;

  /** e.g. PJSIP/{ext} in production, Local/{ext}@ctx in the lab. */
  @Column()
  originateChannelTemplate: string;

  /** sha256 hex of the tenant API key; plaintext is shown once at creation. */
  @Column({ unique: true })
  apiKeyHash: string;

  @Column({ type: 'varchar', nullable: true })
  webhookUrl: string | null;

  /** AES-256-GCM ciphertext of the webhook HMAC secret. */
  @Column({ type: 'varchar', nullable: true })
  webhookSecretEnc: string | null;

  @OneToMany(() => Agent, (a) => a.tenant)
  agents: Agent[];
}
