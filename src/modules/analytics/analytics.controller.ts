import { Controller, Get, Query } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';

import { CurrentUser } from '@/modules/auth/decorators/current-user.decorator';
import { type AuthenticatedUser } from '@/modules/auth/types';

import { AnalyticsService } from './analytics.service';
import {
  UsageAnalyticsDto,
  UsageAnalyticsQueryDto,
} from './dto/usage-analytics.dto';

/** Read-only views over the samples the balance sweep writes. */
@ApiTags('Analytics')
@ApiBearerAuth()
@ApiUnauthorizedResponse({ description: 'Missing or invalid token.' })
@Controller('analytics')
export class AnalyticsController {
  constructor(private readonly analytics: AnalyticsService) {}

  @Get('usage')
  @ApiOperation({
    summary: 'Consumption cost over time, bucketed in Asia/Dhaka.',
    description:
      'Derived from the balance readings taken by the scheduled sweep, so resolution is bounded by how often it runs. Check `coverage` before presenting a figure as a total: below 1 the bucket is missing readings, and the cost is a floor rather than the full amount.',
  })
  @ApiOkResponse({ type: UsageAnalyticsDto })
  @ApiBadRequestResponse({
    description: 'Malformed dates, inverted range, or a range over 366 days.',
  })
  usage(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: UsageAnalyticsQueryDto,
  ): Promise<UsageAnalyticsDto> {
    return this.analytics.usage(user.id, query);
  }
}
