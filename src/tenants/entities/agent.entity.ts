import { Column, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { Tenant } from './tenant.entity';

@Entity('agents')
@Index(['tenantId', 'ext'], { unique: true })
export class Agent {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @ManyToOne(() => Tenant, (t) => t.agents, { nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'tenantId' })
  tenant: Tenant;

  @Column()
  tenantId: string;

  @Column()
  ext: string;

  @Column()
  displayName: string;

  /** Per-CRM user ids, filled by the Zoho/Salesforce adapters (Phases 3-4). */
  @Column({ type: 'jsonb', default: {} })
  crmRefs: Record<string, string>;
}
