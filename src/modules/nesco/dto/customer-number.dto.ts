import { ApiProperty } from '@nestjs/swagger';
import { IsString, Matches } from 'class-validator';

export class CustomerNumberParamDto {
  @ApiProperty({
    example: '33009605',
    description: 'NESCO customer (consumer) number — digits only.',
    pattern: '^\\d{6,20}$',
  })
  @IsString()
  @Matches(/^\d{6,20}$/, {
    message: 'customerNo must be a numeric NESCO customer number (6-20 digits)',
  })
  customerNo: string;
}
