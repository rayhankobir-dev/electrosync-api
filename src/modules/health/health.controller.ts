import { Controller, Get } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';

import { DatabaseHealthService } from '@/database/database.health';
import { Public } from '@/modules/auth/decorators/public.decorator';

import { HealthDto } from './dto/health.dto';

/**
 * Liveness and readiness for whatever is in front of this process.
 *
 * A deployment can be unreachable, restarting, or running an older build than
 * you think. Without an unauthenticated endpoint, the only way to ask "is it
 * actually up?" is to attempt a real request and read the failure — which
 * conflates an unreachable host, a dead process and a dead database into one
 * indistinguishable timeout.
 *
 * Deliberately outside the `api/v1` prefix contract in spirit but not in
 * routing: it sits at `/api/v1/health` like everything else, so a single base
 * URL covers it and no extra ingress rule is needed.
 */
@Public()
@ApiTags('Health')
@Controller('health')
export class HealthController {
  constructor(private readonly databaseHealth: DatabaseHealthService) {}

  @Get()
  @ApiOperation({
    summary: 'Liveness of the process and its database connection.',
  })
  @ApiOkResponse({ type: HealthDto })
  async check(): Promise<HealthDto> {
    const database = await this.databaseHealth.check();

    return {
      // Always 200, database included. A platform health check that sees a
      // non-2xx takes the instance out of rotation, and "Postgres blipped" is
      // not a reason to stop answering — the routes that need it will fail on
      // their own terms, and the ones that do not keep working.
      status: 'ok',
      database: database.status,
      uptimeSeconds: Math.floor(process.uptime()),
    };
  }
}
