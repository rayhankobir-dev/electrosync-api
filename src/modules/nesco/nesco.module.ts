import { Module } from '@nestjs/common';

import { NescoController } from './nesco.controller';
import { NescoPortalClient } from './portal/nesco-portal.client';
import { NescoService } from './nesco.service';

@Module({
  controllers: [NescoController],
  providers: [NescoService, NescoPortalClient],
  exports: [NescoService],
})
export class NescoModule {}
