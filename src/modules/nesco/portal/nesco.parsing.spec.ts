import {
  MONTHLY_CONSUMPTION_PAGE,
  NON_NUMERIC_BALANCE_PAGE,
  PRECOMPOSED_HEADING_PAGE,
  RECHARGE_HISTORY_PAGE,
  RENAMED_COLUMN_PAGE,
  UNKNOWN_CUSTOMER_PAGE,
  UNREADABLE_STAMP_PAGE,
  UNSTAMPED_BALANCE_PAGE,
} from './__fixtures__/nesco-pages';
import { NescoPortalError } from './nesco.errors';
import {
  parseAmount,
  parseBalance,
  parseCustomerInfo,
  parseInstallationDate,
  parseMonthlyConsumption,
  parseRechargeDate,
  parseRechargeHistory,
} from './nesco.parsing';

const CUSTOMER_NO = '33009605';

/** Asserts the thrown value is a portal error with the expected reason. */
function expectPortalError(run: () => unknown, reason: string): void {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(NescoPortalError);
    expect((error as NescoPortalError).reason).toBe(reason);
    return;
  }
  throw new Error(`Expected a ${reason} error, but nothing was thrown`);
}

describe('parseAmount', () => {
  it('parses plain and comma-grouped numbers', () => {
    expect(parseAmount('500', 'field')).toBe(500);
    expect(parseAmount('1,523.45', 'field')).toBe(1523.45);
  });

  it('treats a blank cell as zero, since the portal omits inapplicable charges', () => {
    expect(parseAmount('', 'field')).toBe(0);
    expect(parseAmount('   ', 'field')).toBe(0);
    expect(parseAmount('-', 'field')).toBe(0);
  });

  it('accepts Bengali numerals', () => {
    expect(parseAmount('১২৩', 'field')).toBe(123);
    expect(parseAmount('১,৫২৩.৪৫', 'field')).toBe(1523.45);
  });

  it('fails loudly instead of yielding NaN', () => {
    expectPortalError(
      () => parseAmount('প্রযোজ্য নয়', 'field'),
      'LAYOUT_CHANGED',
    );
    expectPortalError(() => parseAmount(undefined, 'field'), 'LAYOUT_CHANGED');
  });
});

describe('parseInstallationDate', () => {
  it('reads the stamp as Bangladesh local time, not server local time', () => {
    // 2021-03-15 14:22:31 +06:00 === 2021-03-15T08:22:31Z
    expect(parseInstallationDate('15/03/2021 14:22:31')).toBe(1615796551);
  });

  it('defaults to midnight when the portal omits the time', () => {
    // 2021-03-15 00:00:00 +06:00 === 2021-03-14T18:00:00Z
    expect(parseInstallationDate('15/03/2021')).toBe(1615744800);
  });

  it('rejects dates that do not exist rather than rolling them over', () => {
    expectPortalError(
      () => parseInstallationDate('31/02/2021 00:00:00'),
      'LAYOUT_CHANGED',
    );
  });

  it('rejects an unrecognised format', () => {
    expectPortalError(
      () => parseInstallationDate('2021-03-15'),
      'LAYOUT_CHANGED',
    );
  });
});

describe('parseRechargeDate', () => {
  it('converts afternoon times from the 12-hour clock', () => {
    // 2025-02-05 14:30 +06:00 === 2025-02-05T08:30:00Z
    expect(parseRechargeDate('05-FEB-2025 02:30 PM')).toBe(1738744200);
  });

  it('handles midnight, where 12 AM means hour zero', () => {
    // 2025-01-01 00:05 +06:00 === 2024-12-31T18:05:00Z
    expect(parseRechargeDate('01-JAN-2025 12:05 AM')).toBe(1735668300);
  });

  it('handles noon, where 12 PM stays hour twelve', () => {
    // 2025-01-01 12:05 +06:00 === 2025-01-01T06:05:00Z
    expect(parseRechargeDate('01-JAN-2025 12:05 PM')).toBe(1735711500);
  });

  it('rejects an unknown month abbreviation', () => {
    expectPortalError(
      () => parseRechargeDate('01-XXX-2025 12:05 PM'),
      'LAYOUT_CHANGED',
    );
  });
});

describe('parseCustomerInfo', () => {
  it('maps every labelled field, including the renamed feeder', () => {
    const info = parseCustomerInfo(RECHARGE_HISTORY_PAGE, CUSTOMER_NO);

    expect(info).toEqual({
      consumerNo: CUSTOMER_NO,
      name: 'MD. RAJU AHMED',
      address: 'HOLDING 12, WARD 5, RAJSHAHI',
      office: 'RAJSHAHI SALES & DIST. DIVISION-1',
      feeder: 'GREATER ROAD 11KV',
      meterNo: '000012345678',
      meterType: 'SINGLE PHASE',
      meterStatus: 'ACTIVE',
      meterInstalledAt: 1615796551,
      approvedLoad: 2,
      minimumRecharge: 200,
      currentBalance: 1523.45,
      balanceAsOf: 1738296000,
    });
  });

  it('finds the balance despite its changing timestamp suffix', () => {
    expect(parseBalance(RECHARGE_HISTORY_PAGE, CUSTOMER_NO).balance).toBe(
      1523.45,
    );
  });

  it('reads the settlement stamp out of the balance label', () => {
    // "অবশিষ্ট ব্যালেন্স (৩১/০১/২০২৫ ১০:০০)" — 31 Jan 2025 10:00 Bangladesh
    // time. The portal publishes the balance in batches and stamps the label
    // with the instant it settles, which is the only period boundary we get.
    expect(parseBalance(RECHARGE_HISTORY_PAGE, CUSTOMER_NO).asOf).toBe(
      1738296000,
    );
  });

  it('reports a missing stamp as absent rather than failing the read', () => {
    expect(parseBalance(UNSTAMPED_BALANCE_PAGE, CUSTOMER_NO)).toEqual({
      balance: 1523.45,
      asOf: null,
    });
  });

  it('keeps the balance readable when the stamp format is unrecognised', () => {
    // The fixture's stamp format is our best reading of the portal, not a
    // capture of it. If the real page words it differently, losing the stamp
    // must cost us attribution accuracy — which the sweep logs — and not the
    // balance itself, which every alert and the home screen depend on.
    expect(parseBalance(UNREADABLE_STAMP_PAGE, CUSTOMER_NO)).toEqual({
      balance: 1523.45,
      asOf: null,
    });
  });

  it('reports an unknown customer rather than an empty record', () => {
    expectPortalError(
      () => parseCustomerInfo(UNKNOWN_CUSTOMER_PAGE, CUSTOMER_NO),
      'CUSTOMER_NOT_FOUND',
    );
  });

  it('reports a layout change when a field stops being numeric', () => {
    expectPortalError(
      () => parseBalance(NON_NUMERIC_BALANCE_PAGE, CUSTOMER_NO),
      'LAYOUT_CHANGED',
    );
  });
});

describe('parseRechargeHistory', () => {
  it('reads charge columns by value, not by column position', () => {
    // Regression guard. The original script wrote `Number(idx.demandCharge)`
    // and `Number(idx.concessionAmount)` — the column INDEX rather than the
    // cell. With this fixture that bug yields 3 and 5; the real values are
    // 35 and 12.5.
    const [first] = parseRechargeHistory(RECHARGE_HISTORY_PAGE);

    expect(first.demandChargeAmount).toBe(35);
    expect(first.concessionAmount).toBe(12.5);
  });

  it('maps a full recharge row', () => {
    const [first] = parseRechargeHistory(RECHARGE_HISTORY_PAGE);

    expect(first).toEqual({
      sn: 1,
      token: '1234-5678-9012-3456-7890',
      meterRentAmount: 40,
      demandChargeAmount: 35,
      vatAmount: 25.5,
      concessionAmount: 12.5,
      rechargeAmount: 500,
      usableAmount: 399.5,
      rechargeMethod: 'bKash',
      rechargedDate: 1738744200,
      rechargeStatus: 'success',
    });
  });

  it('lower-cases the status and zeroes an omitted concession', () => {
    const [, second] = parseRechargeHistory(RECHARGE_HISTORY_PAGE);

    expect(second.rechargeStatus).toBe('pending');
    expect(second.concessionAmount).toBe(0);
  });

  it('matches headings regardless of Bengali Unicode composition', () => {
    // The live portal spells `য়` as the precomposed U+09DF while these
    // constants use U+09AF + U+09BC. Identical on screen, different strings —
    // so without NFC canonicalisation every heading containing it misses.
    const [first] = parseRechargeHistory(PRECOMPOSED_HEADING_PAGE);

    expect(first.concessionAmount).toBe(12.5);
  });

  it('fails when the portal renames a column', () => {
    expectPortalError(
      () => parseRechargeHistory(RENAMED_COLUMN_PAGE),
      'LAYOUT_CHANGED',
    );
  });

  it('fails when the report table is missing entirely', () => {
    expectPortalError(
      () => parseRechargeHistory(NON_NUMERIC_BALANCE_PAGE),
      'LAYOUT_CHANGED',
    );
  });
});

describe('parseMonthlyConsumption', () => {
  it('maps a full month row', () => {
    const [january] = parseMonthlyConsumption(MONTHLY_CONSUMPTION_PAGE);

    expect(january).toEqual({
      year: 2025,
      month: 'জানুয়ারি',
      totalRechargeAmount: 1500,
      totalConcessionAmount: 0,
      totalElectricityChargeAmount: 1180.25,
      meterRentAmount: 40,
      demandChargeAmount: 35,
      totalVatAmount: 62.75,
      totalUsageAmount: 1318,
      remainingMeterBalance: 182,
      totalUsageInKwh: 210.5,
    });
  });

  it('distinguishes the two similarly named electricity columns', () => {
    const [january] = parseMonthlyConsumption(MONTHLY_CONSUMPTION_PAGE);

    expect(january.totalElectricityChargeAmount).toBe(1180.25);
    expect(january.totalUsageInKwh).toBe(210.5);
  });
});
