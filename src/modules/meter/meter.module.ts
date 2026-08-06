import { Module } from '@nestjs/common';

import { MeterController } from './meter.controller';
import { MeterService } from './meter.service';

/**
 * `MeterService` is exported so other modules can resolve a user's meters —
 * a scheduled balance check needs the customer numbers to scrape.
 */
@Module({
  controllers: [MeterController],
  providers: [MeterService],
  exports: [MeterService],
})
export class MeterModule {}
