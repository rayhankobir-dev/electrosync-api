import * as cheerio from 'cheerio';

import {
  CONSUMPTION_COLUMN,
  DHAKA_UTC_OFFSET_MINUTES,
  LABEL,
  RECHARGE_COLUMN,
  SELECTOR,
} from './nesco.constants';
import {
  NescoCustomerInfoDto,
  NescoMonthlyConsumptionDto,
  NescoRechargeDto,
} from '../dto/nesco-response.dto';
import { NescoPortalError } from './nesco.errors';

/**
 * Pure functions turning portal HTML into typed domain objects.
 *
 * Nothing here performs I/O or touches NestJS, which is what lets the whole
 * parsing surface be tested by calling a function with a fixture string.
 *
 * The governing rule: a value we cannot parse is a `LAYOUT_CHANGED` error, not
 * a `NaN`. Scrapers rot silently when the source page changes; failing loudly
 * is the only way that rot ever reaches a human.
 */

const BENGALI_ZERO = 0x09e6;

const MONTH_ABBREVIATIONS: Readonly<Record<string, number>> = {
  JAN: 0,
  FEB: 1,
  MAR: 2,
  APR: 3,
  MAY: 4,
  JUN: 5,
  JUL: 6,
  AUG: 7,
  SEP: 8,
  OCT: 9,
  NOV: 10,
  DEC: 11,
};

/**
 * Canonicalises portal text so Bengali labels compare reliably.
 *
 * The NFC pass is not cosmetic. The portal writes `য়` as the precomposed
 * U+09DF, while the same grapheme typed elsewhere is U+09AF + U+09BC. They
 * render identically but are different strings, so a heading like
 * "রেয়াত (টাকা)" would never match by `indexOf`. U+09DF is on Unicode's
 * composition exclusion list, which means NFC decomposes it — converging both
 * spellings on the same codepoints.
 */
function normalizeText(value: string): string {
  return value.normalize('NFC').replace(/\s+/g, ' ').trim();
}

/**
 * The portal is Bengali-language and may render numerals in either Bengali
 * (০-৯) or ASCII digits depending on the field. Normalising both to ASCII means
 * a portal-side switch between the two cannot silently produce NaN.
 */
function toAsciiDigits(value: string): string {
  return value.replace(/[০-৯]/g, (digit) =>
    String(digit.charCodeAt(0) - BENGALI_ZERO),
  );
}

function layoutError(message: string): NescoPortalError {
  return new NescoPortalError('LAYOUT_CHANGED', message);
}

/**
 * Parses a monetary/numeric cell.
 *
 * A blank cell means "nothing applied" and yields 0 — the portal leaves
 * concession and demand-charge columns empty rather than writing a zero. Any
 * other unparseable value is a layout change, not a zero.
 */
export function parseAmount(raw: string | undefined, field: string): number {
  if (raw === undefined) {
    throw layoutError(
      `Expected a value for "${field}" but the field was absent`,
    );
  }

  const cleaned = toAsciiDigits(raw).replace(/,/g, '').trim();
  if (cleaned === '' || cleaned === '-') {
    return 0;
  }

  const parsed = Number(cleaned);
  if (!Number.isFinite(parsed)) {
    throw layoutError(`Expected a number for "${field}" but received "${raw}"`);
  }

  return parsed;
}

/**
 * Converts Bangladesh-local wall-clock components to Unix epoch seconds.
 *
 * Deliberately does not use the local-timezone `new Date(y, m, d, ...)`
 * constructor: that would make every timestamp depend on the deploy host's TZ,
 * so the same meter would report different install times from a developer
 * laptop and a production container.
 */
function dhakaTimeToEpochSeconds(
  parts: {
    year: number;
    monthIndex: number;
    day: number;
    hour: number;
    minute: number;
    second: number;
  },
  field: string,
  raw: string,
): number {
  const { year, monthIndex, day, hour, minute, second } = parts;
  const asUtc = new Date(Date.UTC(year, monthIndex, day, hour, minute, second));

  // Date.UTC silently rolls over impossible dates (Feb 31 -> Mar 3). Comparing
  // the components back tells us whether the input was actually a real date.
  const rolledOver =
    asUtc.getUTCFullYear() !== year ||
    asUtc.getUTCMonth() !== monthIndex ||
    asUtc.getUTCDate() !== day;

  if (rolledOver) {
    throw layoutError(`"${field}" is not a real date: "${raw}"`);
  }

  const epochMs = asUtc.getTime() - DHAKA_UTC_OFFSET_MINUTES * 60_000;
  return Math.floor(epochMs / 1000);
}

/** Parses the meter installation stamp: `dd/MM/yyyy HH:mm:ss` (time optional). */
export function parseInstallationDate(raw: string): number {
  const match =
    /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(
      toAsciiDigits(raw).trim(),
    );

  if (!match) {
    throw layoutError(
      `Expected meter installation date as "dd/MM/yyyy HH:mm:ss" but received "${raw}"`,
    );
  }

  const [, day, month, year, hour, minute, second] = match;

  return dhakaTimeToEpochSeconds(
    {
      year: Number(year),
      monthIndex: Number(month) - 1,
      day: Number(day),
      hour: Number(hour ?? '0'),
      minute: Number(minute ?? '0'),
      second: Number(second ?? '0'),
    },
    'meterInstalledAt',
    raw,
  );
}

/** Parses a recharge stamp: `dd-MMM-yyyy hh:mm AM|PM`. */
export function parseRechargeDate(raw: string): number {
  const match =
    /^(\d{1,2})-([A-Za-z]{3})-(\d{4})\s+(\d{1,2}):(\d{2})\s*(AM|PM)$/i.exec(
      toAsciiDigits(raw).trim(),
    );

  if (!match) {
    throw layoutError(
      `Expected recharge date as "dd-MMM-yyyy hh:mm AM/PM" but received "${raw}"`,
    );
  }

  const [, day, monthName, year, rawHour, minute, meridiem] = match;

  const monthIndex = MONTH_ABBREVIATIONS[monthName.toUpperCase()];
  if (monthIndex === undefined) {
    throw layoutError(
      `Unrecognised month "${monthName}" in recharge date "${raw}"`,
    );
  }

  let hour = Number(rawHour);
  if (hour < 1 || hour > 12) {
    throw layoutError(`Hour out of range for a 12-hour clock in "${raw}"`);
  }
  if (meridiem.toUpperCase() === 'PM' && hour !== 12) hour += 12;
  if (meridiem.toUpperCase() === 'AM' && hour === 12) hour = 0;

  return dhakaTimeToEpochSeconds(
    {
      year: Number(year),
      monthIndex,
      day: Number(day),
      hour,
      minute: Number(minute),
      second: 0,
    },
    'rechargedDate',
    raw,
  );
}

/**
 * Reads the customer detail form into a label -> input-value map.
 *
 * Returns an empty map when the form is absent, which the caller treats as
 * "no such customer" rather than as a layout change.
 */
export function extractLabelledInputs(
  html: string,
): ReadonlyMap<string, string> {
  const $ = cheerio.load(html);
  const values = new Map<string, string>();

  $(SELECTOR.DETAIL_FORM_LABEL).each((_, label) => {
    const key = normalizeText($(label).text());
    const input = $(label).next().find('input').first();

    if (input.length > 0) {
      values.set(key, (input.attr('value') ?? '').trim());
    }
  });

  return values;
}

/**
 * Looks a label up by exact match, falling back to prefix match.
 *
 * The balance label carries a trailing "as of <timestamp>" suffix that changes
 * on every request, so an exact-only lookup would never find it.
 */
function requireLabelled(
  values: ReadonlyMap<string, string>,
  label: string,
): string {
  const target = normalizeText(label);

  const exact = values.get(target);
  if (exact !== undefined) {
    return exact;
  }

  for (const [key, value] of values) {
    if (key.startsWith(target)) {
      return value;
    }
  }

  throw layoutError(`Customer detail form has no field labelled "${label}"`);
}

export interface PortalTable {
  readonly headers: readonly string[];
  readonly rows: readonly (readonly string[])[];
}

/** Reads the first report table. Absent table yields `null`, not an error. */
export function extractTable(html: string): PortalTable | null {
  const $ = cheerio.load(html);
  const table = $(SELECTOR.REPORT_TABLE).first();

  if (table.length === 0) {
    return null;
  }

  const headers = table
    .find('thead th')
    .map((_, th) => normalizeText($(th).text()))
    .get();

  const rows: string[][] = [];
  table.find('tbody tr').each((_, tr) => {
    rows.push(
      $(tr)
        .find('td')
        .map((_, td) => normalizeText($(td).text()))
        .get(),
    );
  });

  return { headers, rows };
}

/**
 * Resolves a column heading to its index, failing when it is missing.
 *
 * This is the guard the original script lacked: an unmatched heading gave -1,
 * `row[-1]` gave undefined, and `Number(undefined)` gave NaN — a corrupt value
 * served with a 200 OK.
 */
function requireColumn(headers: readonly string[], heading: string): number {
  // Both sides go through normalizeText so the comparison cannot depend on how
  // the constant in nesco.constants.ts happened to be typed or pasted.
  const index = headers.indexOf(normalizeText(heading));
  if (index === -1) {
    throw layoutError(
      `Report table has no "${heading}" column (found: ${headers.join(', ')})`,
    );
  }
  return index;
}

function requireCell(
  row: readonly string[],
  index: number,
  heading: string,
): string {
  const cell = row[index];
  if (cell === undefined) {
    throw layoutError(`Row is missing the "${heading}" cell`);
  }
  return cell;
}

export function parseCustomerInfo(
  html: string,
  customerNumber: string,
): NescoCustomerInfoDto {
  const values = extractLabelledInputs(html);

  if (values.size === 0) {
    throw new NescoPortalError(
      'CUSTOMER_NOT_FOUND',
      `The portal returned no customer details for "${customerNumber}"`,
    );
  }

  const installedAt = requireLabelled(values, LABEL.METER_INSTALLED_AT);

  return {
    consumerNo: customerNumber,
    name: requireLabelled(values, LABEL.NAME),
    address: requireLabelled(values, LABEL.ADDRESS),
    office: requireLabelled(values, LABEL.OFFICE),
    feeder: requireLabelled(values, LABEL.FEEDER),
    meterNo: requireLabelled(values, LABEL.METER_NO),
    meterType: requireLabelled(values, LABEL.METER_TYPE),
    meterStatus: requireLabelled(values, LABEL.METER_STATUS),
    meterInstalledAt: parseInstallationDate(installedAt),
    approvedLoad: parseAmount(
      requireLabelled(values, LABEL.APPROVED_LOAD),
      'approvedLoad',
    ),
    minimumRecharge: parseAmount(
      requireLabelled(values, LABEL.MIN_RECHARGE),
      'minimumRecharge',
    ),
    currentBalance: parseAmount(
      requireLabelled(values, LABEL.BALANCE),
      'currentBalance',
    ),
  };
}

export function parseBalance(html: string, customerNumber: string): number {
  const values = extractLabelledInputs(html);

  if (values.size === 0) {
    throw new NescoPortalError(
      'CUSTOMER_NOT_FOUND',
      `The portal returned no customer details for "${customerNumber}"`,
    );
  }

  return parseAmount(requireLabelled(values, LABEL.BALANCE), 'balance');
}

export function parseRechargeHistory(html: string): NescoRechargeDto[] {
  const table = extractTable(html);
  if (table === null) {
    throw layoutError('Recharge history response contained no report table');
  }

  const { headers, rows } = table;
  const column = {
    sn: requireColumn(headers, RECHARGE_COLUMN.SN),
    token: requireColumn(headers, RECHARGE_COLUMN.TOKEN),
    meterRent: requireColumn(headers, RECHARGE_COLUMN.METER_RENT),
    demandCharge: requireColumn(headers, RECHARGE_COLUMN.DEMAND_CHARGE),
    vat: requireColumn(headers, RECHARGE_COLUMN.VAT),
    concession: requireColumn(headers, RECHARGE_COLUMN.CONCESSION),
    usable: requireColumn(headers, RECHARGE_COLUMN.USABLE),
    rechargeAmount: requireColumn(headers, RECHARGE_COLUMN.RECHARGE_AMOUNT),
    method: requireColumn(headers, RECHARGE_COLUMN.RECHARGE_METHOD),
    date: requireColumn(headers, RECHARGE_COLUMN.RECHARGE_DATE),
    status: requireColumn(headers, RECHARGE_COLUMN.RECHARGE_STATUS),
  };

  return rows.map((row) => ({
    sn: parseAmount(requireCell(row, column.sn, RECHARGE_COLUMN.SN), 'sn'),
    token: requireCell(row, column.token, RECHARGE_COLUMN.TOKEN),
    meterRentAmount: parseAmount(
      requireCell(row, column.meterRent, RECHARGE_COLUMN.METER_RENT),
      'meterRentAmount',
    ),
    demandChargeAmount: parseAmount(
      requireCell(row, column.demandCharge, RECHARGE_COLUMN.DEMAND_CHARGE),
      'demandChargeAmount',
    ),
    vatAmount: parseAmount(
      requireCell(row, column.vat, RECHARGE_COLUMN.VAT),
      'vatAmount',
    ),
    concessionAmount: parseAmount(
      requireCell(row, column.concession, RECHARGE_COLUMN.CONCESSION),
      'concessionAmount',
    ),
    rechargeAmount: parseAmount(
      requireCell(row, column.rechargeAmount, RECHARGE_COLUMN.RECHARGE_AMOUNT),
      'rechargeAmount',
    ),
    usableAmount: parseAmount(
      requireCell(row, column.usable, RECHARGE_COLUMN.USABLE),
      'usableAmount',
    ),
    rechargeMethod: requireCell(
      row,
      column.method,
      RECHARGE_COLUMN.RECHARGE_METHOD,
    ),
    rechargedDate: parseRechargeDate(
      requireCell(row, column.date, RECHARGE_COLUMN.RECHARGE_DATE),
    ),
    rechargeStatus: requireCell(
      row,
      column.status,
      RECHARGE_COLUMN.RECHARGE_STATUS,
    ).toLowerCase(),
  }));
}

export function parseMonthlyConsumption(
  html: string,
): NescoMonthlyConsumptionDto[] {
  const table = extractTable(html);
  if (table === null) {
    throw layoutError('Monthly consumption response contained no report table');
  }

  const { headers, rows } = table;
  const column = {
    year: requireColumn(headers, CONSUMPTION_COLUMN.YEAR),
    month: requireColumn(headers, CONSUMPTION_COLUMN.MONTH),
    rechargeAmount: requireColumn(headers, CONSUMPTION_COLUMN.RECHARGE_AMOUNT),
    concession: requireColumn(headers, CONSUMPTION_COLUMN.CONCESSION),
    electricityCharge: requireColumn(
      headers,
      CONSUMPTION_COLUMN.ELECTRICITY_CHARGE,
    ),
    meterRent: requireColumn(headers, CONSUMPTION_COLUMN.METER_RENT),
    demandCharge: requireColumn(headers, CONSUMPTION_COLUMN.DEMAND_CHARGE),
    vat: requireColumn(headers, CONSUMPTION_COLUMN.VAT),
    usageAmount: requireColumn(headers, CONSUMPTION_COLUMN.USAGE_AMOUNT),
    remainBalance: requireColumn(headers, CONSUMPTION_COLUMN.REMAIN_BALANCE),
    usageKwh: requireColumn(headers, CONSUMPTION_COLUMN.USAGE_KWH),
  };

  return rows.map((row) => ({
    year: parseAmount(
      requireCell(row, column.year, CONSUMPTION_COLUMN.YEAR),
      'year',
    ),
    month: requireCell(row, column.month, CONSUMPTION_COLUMN.MONTH),
    totalRechargeAmount: parseAmount(
      requireCell(
        row,
        column.rechargeAmount,
        CONSUMPTION_COLUMN.RECHARGE_AMOUNT,
      ),
      'totalRechargeAmount',
    ),
    totalConcessionAmount: parseAmount(
      requireCell(row, column.concession, CONSUMPTION_COLUMN.CONCESSION),
      'totalConcessionAmount',
    ),
    totalElectricityChargeAmount: parseAmount(
      requireCell(
        row,
        column.electricityCharge,
        CONSUMPTION_COLUMN.ELECTRICITY_CHARGE,
      ),
      'totalElectricityChargeAmount',
    ),
    meterRentAmount: parseAmount(
      requireCell(row, column.meterRent, CONSUMPTION_COLUMN.METER_RENT),
      'meterRentAmount',
    ),
    demandChargeAmount: parseAmount(
      requireCell(row, column.demandCharge, CONSUMPTION_COLUMN.DEMAND_CHARGE),
      'demandChargeAmount',
    ),
    totalVatAmount: parseAmount(
      requireCell(row, column.vat, CONSUMPTION_COLUMN.VAT),
      'totalVatAmount',
    ),
    totalUsageAmount: parseAmount(
      requireCell(row, column.usageAmount, CONSUMPTION_COLUMN.USAGE_AMOUNT),
      'totalUsageAmount',
    ),
    remainingMeterBalance: parseAmount(
      requireCell(row, column.remainBalance, CONSUMPTION_COLUMN.REMAIN_BALANCE),
      'remainingMeterBalance',
    ),
    totalUsageInKwh: parseAmount(
      requireCell(row, column.usageKwh, CONSUMPTION_COLUMN.USAGE_KWH),
      'totalUsageInKwh',
    ),
  }));
}
