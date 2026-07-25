import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { TenantsModule } from '../../tenants/tenants.module';
import { DynamicsTokenService } from './dynamics-token.service';
import { DynamicsDispatcher } from './dynamics.dispatcher';
import { DynamicsProcessor } from './dynamics.processor';
import { DYNAMICS_QUEUE } from './dynamics.types';

@Module({
  imports: [BullModule.registerQueue({ name: DYNAMICS_QUEUE }), TenantsModule],
  providers: [DynamicsTokenService, DynamicsDispatcher, DynamicsProcessor],
})
export class DynamicsModule {}
