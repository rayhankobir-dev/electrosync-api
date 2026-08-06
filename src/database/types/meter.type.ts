export enum MeterType {
  HOME = 'HOME',
  OFFICE = 'OFFICE',
  INDUSTRY = 'INDUSTRY',
}

export enum MeterProvider {
  NESCO = 'NESCO',
  DESCO = 'DESCO',
  DPDC = 'DPDC',
}

export const DEFAULT_METER_TYPE = MeterType.HOME;

export const DEFAULT_METER_PROVIDER = MeterProvider.NESCO;
