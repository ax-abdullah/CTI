import { Column, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { Tenant } from './tenant.entity';

export type CrmType = 'zoho' | 'salesforce' | 'hubspot' | 'dynamics';

/**
 * A tenant's connection to one CRM. Non-secret settings live in `config`
 * (JSON); credentials live in `secretsEnc` — an AES-256-GCM-encrypted JSON
 * blob (CryptoService), e.g. { clientSecret, refreshToken, callbackToken }.
 */
@Entity('crm_integrations')
@Index(['tenantId', 'type'], { unique: true })
export class CrmIntegration {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @ManyToOne(() => Tenant, { nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'tenantId' })
  tenant: Tenant;

  @Column()
  tenantId: string;

  @Column({ type: 'varchar' })
  type: CrmType;

  @Column({ default: true })
  enabled: boolean;

  /** Zoho: { dc, accountsBaseUrl, apiBaseUrl, clientId } */
  @Column({ type: 'jsonb', default: {} })
  config: Record<string, string>;

  @Column()
  secretsEnc: string;
}
