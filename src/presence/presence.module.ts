import { Module } from '@nestjs/common';
import { TenantsModule } from '../tenants/tenants.module';
import { PresenceService } from './presence.service';

@Module({
  imports: [TenantsModule],
  providers: [PresenceService],
  exports: [PresenceService],
})
export class PresenceModule {}
