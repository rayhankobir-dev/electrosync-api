import { Controller, Get, Param, applyDecorators } from '@nestjs/common';
import {
  ApiBadGatewayResponse,
  ApiBadRequestResponse,
  ApiGatewayTimeoutResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiServiceUnavailableResponse,
  ApiTags,
} from '@nestjs/swagger';

import { CustomerNumberParamDto } from './dto/customer-number.dto';
import {
  NescoBalanceDto,
  NescoCustomerInfoDto,
  NescoMonthlyConsumptionDto,
  NescoRechargeDto,
} from './dto/nesco-response.dto';
import { Public } from '@/modules/auth/decorators/public.decorator';

import { NescoService } from './nesco.service';

function ApiNescoFailures() {
  return applyDecorators(
    ApiBadRequestResponse({
      description: 'customerNo is not a valid customer number.',
    }),
    ApiNotFoundResponse({
      description: 'The portal has no record of this customer.',
    }),
    ApiBadGatewayResponse({
      description: 'The portal returned unrecognised markup.',
    }),
    ApiServiceUnavailableResponse({
      description: 'The portal is unreachable.',
    }),
    ApiGatewayTimeoutResponse({
      description: 'The portal did not respond in time.',
    }),
  );
}

@Public()
@ApiTags('NESCO')
@ApiParam({
  name: 'customerNo',
  example: '33009605',
  description: 'NESCO customer (consumer) number.',
})
@Controller('nesco/:customerNo')
export class NescoController {
  constructor(private readonly nescoService: NescoService) {}

  @Get('balance')
  @ApiOperation({ summary: 'Current prepaid meter balance.' })
  @ApiOkResponse({ type: NescoBalanceDto })
  @ApiNescoFailures()
  getBalance(
    @Param() params: CustomerNumberParamDto,
  ): Promise<NescoBalanceDto> {
    return this.nescoService.getBalance(params.customerNo);
  }

  @Get('info')
  @ApiOperation({ summary: 'Customer, meter and connection details.' })
  @ApiOkResponse({ type: NescoCustomerInfoDto })
  @ApiNescoFailures()
  getCustomerInfo(
    @Param() params: CustomerNumberParamDto,
  ): Promise<NescoCustomerInfoDto> {
    return this.nescoService.getCustomerInfo(params.customerNo);
  }

  @Get('recharges')
  @ApiOperation({ summary: 'Recharge history, most recent report first.' })
  @ApiOkResponse({ type: NescoRechargeDto, isArray: true })
  @ApiNescoFailures()
  getRechargeHistory(
    @Param() params: CustomerNumberParamDto,
  ): Promise<NescoRechargeDto[]> {
    return this.nescoService.getRechargeHistory(params.customerNo);
  }

  @Get('consumption')
  @ApiOperation({ summary: 'Month-by-month consumption and charges.' })
  @ApiOkResponse({ type: NescoMonthlyConsumptionDto, isArray: true })
  @ApiNescoFailures()
  getMonthlyConsumption(
    @Param() params: CustomerNumberParamDto,
  ): Promise<NescoMonthlyConsumptionDto[]> {
    return this.nescoService.getMonthlyConsumption(params.customerNo);
  }
}
