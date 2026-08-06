import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsInt, IsOptional, Max, Min } from 'class-validator';

export class ListNotificationsQueryDto {
  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @Transform(({ value }) => value === 'true' || value === true)
  @IsBoolean()
  includeArchived?: boolean = false;

  @ApiPropertyOptional({ default: 50, maximum: 200 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number = 50;
}
