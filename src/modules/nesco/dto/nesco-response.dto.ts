import { ApiProperty } from '@nestjs/swagger';

export class NescoBalanceDto {
  @ApiProperty({
    example: '33009605',
    description: 'Customer (consumer) number.',
  })
  consumerNo: string;

  @ApiProperty({
    example: 1523.45,
    description: 'Remaining meter balance in BDT.',
  })
  balance: number;
}

export class NescoCustomerInfoDto {
  @ApiProperty({ example: '33009605' })
  consumerNo: string;

  @ApiProperty({ example: 'MD. RAJU AHMED' })
  name: string;

  @ApiProperty({ example: 'HOLDING 12, WARD 5, RAJSHAHI' })
  address: string;

  @ApiProperty({ description: 'Responsible NESCO office.' })
  office: string;

  @ApiProperty({ description: 'Name of the feeder supplying this meter.' })
  feeder: string;

  @ApiProperty({ example: '000012345678' })
  meterNo: string;

  @ApiProperty({ description: 'Meter model / type as reported by the portal.' })
  meterType: string;

  @ApiProperty({ description: 'Meter status as reported by the portal.' })
  meterStatus: string;

  @ApiProperty({
    example: 1614556800,
    description: 'Meter installation time, Unix epoch seconds (UTC).',
  })
  meterInstalledAt: number;

  @ApiProperty({ example: 2, description: 'Approved load in kilowatts.' })
  approvedLoad: number;

  @ApiProperty({
    example: 200,
    description: 'Minimum permitted recharge in BDT.',
  })
  minimumRecharge: number;

  @ApiProperty({
    example: 1523.45,
    description: 'Remaining meter balance in BDT.',
  })
  currentBalance: number;
}

export class NescoRechargeDto {
  @ApiProperty({ example: 1, description: 'Serial number within the report.' })
  sn: number;

  @ApiProperty({ example: '1234-5678-9012-3456-7890' })
  token: string;

  @ApiProperty({ example: 40 })
  meterRentAmount: number;

  @ApiProperty({ example: 35 })
  demandChargeAmount: number;

  @ApiProperty({ example: 25.5 })
  vatAmount: number;

  @ApiProperty({ example: 0 })
  concessionAmount: number;

  @ApiProperty({ example: 500, description: 'Gross amount paid in BDT.' })
  rechargeAmount: number;

  @ApiProperty({
    example: 399.5,
    description: 'Amount credited as usable electricity after charges, in BDT.',
  })
  usableAmount: number;

  @ApiProperty({ example: 'bKash' })
  rechargeMethod: string;

  @ApiProperty({
    example: 1738368000,
    description: 'Unix epoch seconds (UTC).',
  })
  rechargedDate: number;

  @ApiProperty({
    example: 'success',
    description: 'Lower-cased portal status.',
  })
  rechargeStatus: string;
}

export class NescoMonthlyConsumptionDto {
  @ApiProperty({ example: 2025 })
  year: number;

  @ApiProperty({
    example: 'জানুয়ারি',
    description: 'Month as rendered by the portal.',
  })
  month: string;

  @ApiProperty({ example: 1500 })
  totalRechargeAmount: number;

  @ApiProperty({ example: 0 })
  totalConcessionAmount: number;

  @ApiProperty({ example: 1180.25 })
  totalElectricityChargeAmount: number;

  @ApiProperty({ example: 40 })
  meterRentAmount: number;

  @ApiProperty({ example: 35 })
  demandChargeAmount: number;

  @ApiProperty({ example: 62.75 })
  totalVatAmount: number;

  @ApiProperty({ example: 1318 })
  totalUsageAmount: number;

  @ApiProperty({
    example: 182,
    description: 'Meter balance at month end, in BDT.',
  })
  remainingMeterBalance: number;

  @ApiProperty({ example: 210.5, description: 'Electricity consumed, in kWh.' })
  totalUsageInKwh: number;
}
