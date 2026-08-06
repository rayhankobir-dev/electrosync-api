import { USAGE_ANOMALY } from '@/database/types/usage.type';
import type { NescoRechargeDto } from '@/modules/nesco/dto/nesco-response.dto';

import {
  buildUsageSample,
  type UsageSampleInput,
  type UsageSamplingLimits,
} from './usage-sampling';

const LIMITS: UsageSamplingLimits = {
  maxCostPerHour: 500,
  maxWindowHours: 48,
};

/** 2026-08-01T00:00:00Z, so window arithmetic reads in whole hours. */
const T0 = new Date('2026-08-01T00:00:00.000Z');

function at(hoursFromT0: number): Date {
  return new Date(T0.getTime() + hoursFromT0 * 3600 * 1000);
}

function recharge(over: Partial<NescoRechargeDto> = {}): NescoRechargeDto {
  return {
    sn: 1,
    token: 'token-a',
    meterRentAmount: 40,
    demandChargeAmount: 35,
    vatAmount: 25,
    concessionAmount: 0,
    rechargeAmount: 500,
    usableAmount: 399.5,
    rechargeMethod: 'bKash',
    rechargedDate: at(3).getTime() / 1000,
    rechargeStatus: 'success',
    ...over,
  };
}

function input(over: Partial<UsageSampleInput> = {}): UsageSampleInput {
  return {
    openingBalance: 850,
    closingBalance: 812,
    windowStart: T0,
    windowEnd: at(6),
    recharges: [],
    ...over,
  };
}

describe('buildUsageSample', () => {
  it('derives cost from the balance drop', () => {
    const sample = buildUsageSample(input(), LIMITS);

    expect(sample).toMatchObject({ consumedCost: 38, rawDelta: 38 });
    expect(sample?.anomaly).toBeNull();
  });

  it('adds recharges back so a top-up is not read as negative consumption', () => {
    // Without the correction: 601 - 904.5 = -303.5, which would both look
    // absurd and drag the week's total down when summed.
    const sample = buildUsageSample(
      input({
        openingBalance: 601,
        closingBalance: 904.5,
        recharges: [recharge()],
      }),
      LIMITS,
    );

    expect(sample).toMatchObject({
      consumedCost: 96,
      rechargeCredited: 399.5,
      rechargePaid: 500,
      anomaly: null,
    });
  });

  it('reports paid and credited separately', () => {
    // These differ by meter rent, demand charge and VAT. The arithmetic needs
    // the credited figure; the user wants to see what left their wallet.
    const sample = buildUsageSample(
      input({ closingBalance: 1211.5, recharges: [recharge()] }),
      LIMITS,
    );

    expect(sample?.rechargeCredited).toBe(399.5);
    expect(sample?.rechargePaid).toBe(500);
  });

  it('sums several recharges in one window', () => {
    const sample = buildUsageSample(
      input({
        closingBalance: 1411.5,
        recharges: [
          recharge({ token: 'a', rechargedDate: at(1).getTime() / 1000 }),
          recharge({
            token: 'b',
            rechargedDate: at(4).getTime() / 1000,
            usableAmount: 200,
            rechargeAmount: 250,
          }),
        ],
      }),
      LIMITS,
    );

    expect(sample?.rechargeCredited).toBe(599.5);
    expect(sample?.rechargePaid).toBe(750);
    expect(sample?.consumedCost).toBe(38);
  });

  it('ignores recharges outside the window', () => {
    const sample = buildUsageSample(
      input({
        recharges: [
          recharge({ token: 'before', rechargedDate: at(-1).getTime() / 1000 }),
          recharge({ token: 'after', rechargedDate: at(9).getTime() / 1000 }),
        ],
      }),
      LIMITS,
    );

    expect(sample?.rechargeCredited).toBe(0);
    expect(sample?.consumedCost).toBe(38);
  });

  it('excludes a recharge landing exactly on windowStart', () => {
    // windowStart is the previous poll's instant, so that recharge is already
    // baked into openingBalance. Counting it again would credit it twice.
    const sample = buildUsageSample(
      input({ recharges: [recharge({ rechargedDate: T0.getTime() / 1000 })] }),
      LIMITS,
    );

    expect(sample?.rechargeCredited).toBe(0);
  });

  it('includes a recharge landing exactly on windowEnd', () => {
    const sample = buildUsageSample(
      input({
        closingBalance: 1211.5,
        recharges: [recharge({ rechargedDate: at(6).getTime() / 1000 })],
      }),
      LIMITS,
    );

    expect(sample?.rechargeCredited).toBe(399.5);
  });

  it.each(['pending', 'failed', 'reversed'])(
    'ignores a %s recharge, which never moved the balance',
    (rechargeStatus) => {
      const sample = buildUsageSample(
        input({ recharges: [recharge({ rechargeStatus })] }),
        LIMITS,
      );

      expect(sample?.rechargeCredited).toBe(0);
      expect(sample?.anomaly).toBeNull();
    },
  );

  it('suppresses a balance that rose with nothing to explain it', () => {
    const sample = buildUsageSample(
      input({ openingBalance: 300, closingBalance: 1800 }),
      LIMITS,
    );

    expect(sample).toMatchObject({
      consumedCost: 0,
      rawDelta: -1500,
      anomaly: USAGE_ANOMALY.NEGATIVE_DELTA,
    });
  });

  it('keeps the raw value when suppressing, so the reading stays inspectable', () => {
    const sample = buildUsageSample(
      input({ openingBalance: 300, closingBalance: 1800 }),
      LIMITS,
    );

    expect(sample?.rawDelta).toBe(-1500);
    expect(sample?.openingBalance).toBe(300);
    expect(sample?.closingBalance).toBe(1800);
  });

  it('treats sub-cent negatives as an idle meter, not an anomaly', () => {
    const sample = buildUsageSample(
      input({ openingBalance: 850, closingBalance: 850.005 }),
      LIMITS,
    );

    expect(sample?.consumedCost).toBe(0);
    expect(sample?.anomaly).toBeNull();
  });

  it('suppresses an implausible spend rate', () => {
    const sample = buildUsageSample(
      input({ openingBalance: 50_000, closingBalance: 0 }),
      LIMITS,
    );

    expect(sample).toMatchObject({
      consumedCost: 0,
      anomaly: USAGE_ANOMALY.IMPLAUSIBLE_RATE,
    });
  });

  it('judges implausibility by rate, so a long recovery window still counts', () => {
    // 72h of real usage at ~14/h. A flat ceiling on the total would reject the
    // very windows that recover data after an outage.
    const sample = buildUsageSample(
      input({ openingBalance: 1050, closingBalance: 42, windowEnd: at(72) }),
      LIMITS,
    );

    expect(sample?.consumedCost).toBe(1008);
    expect(sample?.anomaly).toBe(USAGE_ANOMALY.STALE_WINDOW);
  });

  it('flags a stale window but keeps its cost, which really was spent', () => {
    const sample = buildUsageSample(
      input({ openingBalance: 900, closingBalance: 500, windowEnd: at(49) }),
      LIMITS,
    );

    expect(sample).toMatchObject({
      consumedCost: 400,
      anomaly: USAGE_ANOMALY.STALE_WINDOW,
    });
  });

  it('does not flag a window exactly at the stale limit', () => {
    const sample = buildUsageSample(
      input({ openingBalance: 900, closingBalance: 500, windowEnd: at(48) }),
      LIMITS,
    );

    expect(sample?.anomaly).toBeNull();
  });

  it('prefers the negative-delta diagnosis over staleness', () => {
    const sample = buildUsageSample(
      input({ openingBalance: 100, closingBalance: 900, windowEnd: at(72) }),
      LIMITS,
    );

    expect(sample?.anomaly).toBe(USAGE_ANOMALY.NEGATIVE_DELTA);
  });

  it('returns null for a zero-length window', () => {
    // The replay case: a second sweep arrives before the clock advances.
    expect(buildUsageSample(input({ windowEnd: T0 }), LIMITS)).toBeNull();
  });

  it('returns null when the clock went backwards', () => {
    expect(buildUsageSample(input({ windowEnd: at(-1) }), LIMITS)).toBeNull();
  });

  it('rounds money to two decimals', () => {
    const sample = buildUsageSample(
      input({ openingBalance: 850.005, closingBalance: 812.001 }),
      LIMITS,
    );

    expect(sample?.rawDelta).toBe(38);
  });
});
