import { ApiProperty } from '@nestjs/swagger';

export class HealthDto {
  @ApiProperty({ example: 'ok', description: 'Always "ok" if this responded.' })
  status: 'ok';

  @ApiProperty({
    example: 'up',
    enum: ['up', 'down'],
    description:
      'Postgres reachability. Reported rather than thrown, so a database blip does not take the instance out of rotation.',
  })
  database: 'up' | 'down';

  @ApiProperty({
    example: 3600,
    description:
      'Seconds since this process started. A value that keeps resetting is the signature of a crash loop — the one failure a plain up/down check cannot show.',
  })
  uptimeSeconds: number;
}
