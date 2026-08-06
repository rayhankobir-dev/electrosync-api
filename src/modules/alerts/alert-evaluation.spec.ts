import { ALERT_KIND, ALERT_SEVERITY } from '@/database/types/alert.type';
import type { UserSettings } from '@/database/types/user-settings.type';
import type { NescoRechargeDto } from '@/modules/nesco/dto/nesco-response.dto';

import {
  INITIAL_STATE,
  evaluate,
  latestRecharge,
  severityFor,
  type PreviousState,
} from './alert-evaluation';

function recharge(over: Partial<NescoRechargeDto> = {}): NescoRechargeDto {
  return {
    sn: 1,
    token: 'token-a',
    meterRentAmount: 40,
    demandChargeAmount: 35,
    vatAmount: 25,
    concessionAmount: 0,
    rechargeAmount: 500,
    usableAmount: 400,
    rechargeMethod: 'bKash',
    rechargedDate: 1_738_368_000,
    rechargeStatus: 'success',
    ...over,
  };
}

function state(over: Partial<PreviousState> = {}): PreviousState {
  return { ...INITIAL_STATE, ...over };
}

describe('severityFor', () => {
  it.each([
    [500, 100, ALERT_SEVERITY.OK],
    [100, 100, ALERT_SEVERITY.OK],
    [99.99, 100, ALERT_SEVERITY.LOW],
    [0.01, 100, ALERT_SEVERITY.LOW],
    [0, 100, ALERT_SEVERITY.DEPLETED],
    [-42, 100, ALERT_SEVERITY.DEPLETED],
  ])('classifies %p against threshold %p as %s', (balance, threshold, want) => {
    expect(severityFor(balance, threshold)).toBe(want);
  });
});

describe('latestRecharge', () => {
  it('returns null when there is no history', () => {
    expect(latestRecharge([])).toBeNull();
  });

  it('picks the newest by date, not by row order', () => {
    const newest = latestRecharge([
      recharge({ token: 'old', rechargedDate: 1_000 }),
      recharge({ token: 'new', rechargedDate: 9_000 }),
      recharge({ token: 'middle', rechargedDate: 5_000 }),
    ]);

    expect(newest?.token).toBe('new');
  });

  it('ignores recharges that did not succeed', () => {
    const newest = latestRecharge([
      recharge({ token: 'landed', rechargedDate: 1_000 }),
      recharge({
        token: 'pending',
        rechargedDate: 9_000,
        rechargeStatus: 'pending',
      }),
    ]);

    expect(newest?.token).toBe('landed');
  });
});

describe('evaluate — low balance crossings', () => {
  it('alerts when the balance first drops below the threshold', () => {
    const result = evaluate(state(), { balance: 80, recharges: [] }, null);

    expect(result.alerts).toEqual([ALERT_KIND.LOW_BALANCE]);
    expect(result.severity).toBe(ALERT_SEVERITY.LOW);
  });

  it('stays silent while the balance remains low', () => {
    const result = evaluate(
      state({ severity: ALERT_SEVERITY.LOW }),
      { balance: 40, recharges: [] },
      null,
    );

    expect(result.alerts).toEqual([]);
    expect(result.severity).toBe(ALERT_SEVERITY.LOW);
  });

  it('escalates from low to depleted', () => {
    const result = evaluate(
      state({ severity: ALERT_SEVERITY.LOW }),
      { balance: 0, recharges: [] },
      null,
    );

    expect(result.alerts).toEqual([ALERT_KIND.BALANCE_DEPLETED]);
  });

  it('goes straight to depleted when a sweep is missed', () => {
    const result = evaluate(state(), { balance: -5, recharges: [] }, null);

    expect(result.alerts).toEqual([ALERT_KIND.BALANCE_DEPLETED]);
  });

  it('re-arms silently once the balance recovers', () => {
    const recovered = evaluate(
      state({ severity: ALERT_SEVERITY.DEPLETED }),
      { balance: 900, recharges: [] },
      null,
    );

    expect(recovered.alerts).toEqual([]);
    expect(recovered.severity).toBe(ALERT_SEVERITY.OK);

    // ...and the next crossing alerts again.
    const again = evaluate(
      state({ severity: recovered.severity }),
      { balance: 12, recharges: [] },
      null,
    );

    expect(again.alerts).toEqual([ALERT_KIND.LOW_BALANCE]);
  });

  it('honours a per-user threshold', () => {
    const settings: UserSettings = { lowBalanceThreshold: 500 };
    const result = evaluate(state(), { balance: 300, recharges: [] }, settings);

    expect(result.alerts).toEqual([ALERT_KIND.LOW_BALANCE]);
  });
});

describe('evaluate — recharge detection', () => {
  it('does not alert on the first sight of a meter', () => {
    const result = evaluate(
      state(),
      { balance: 900, recharges: [recharge({ token: 'historic' })] },
      null,
    );

    expect(result.alerts).toEqual([]);
    expect(result.lastRechargeToken).toBe('historic');
  });

  it('alerts when a token it has not seen appears', () => {
    const result = evaluate(
      state({ lastRechargeToken: 'old' }),
      {
        balance: 900,
        recharges: [
          recharge({ token: 'old', rechargedDate: 1_000 }),
          recharge({
            token: 'fresh',
            rechargedDate: 2_000,
            rechargeAmount: 750,
          }),
        ],
      },
      null,
    );

    expect(result.alerts).toEqual([ALERT_KIND.RECHARGE_DETECTED]);
    expect(result.newRecharge?.rechargeAmount).toBe(750);
    expect(result.lastRechargeToken).toBe('fresh');
  });

  it('stays silent when the newest token is unchanged', () => {
    const result = evaluate(
      state({ lastRechargeToken: 'same' }),
      { balance: 900, recharges: [recharge({ token: 'same' })] },
      null,
    );

    expect(result.alerts).toEqual([]);
  });

  it('reports a recharge that did not clear the threshold alongside the crossing', () => {
    const result = evaluate(
      state({ lastRechargeToken: 'old' }),
      {
        balance: 50,
        recharges: [recharge({ token: 'small', rechargedDate: 2_000 })],
      },
      null,
    );

    expect(result.alerts).toEqual([
      ALERT_KIND.RECHARGE_DETECTED,
      ALERT_KIND.LOW_BALANCE,
    ]);
  });
});

describe('evaluate — user settings', () => {
  it('sends nothing when push is off, but still records state', () => {
    const result = evaluate(
      state({ lastRechargeToken: 'old' }),
      { balance: 10, recharges: [recharge({ token: 'new' })] },
      { pushEnabled: false },
    );

    expect(result.alerts).toEqual([]);
    expect(result.severity).toBe(ALERT_SEVERITY.LOW);
    expect(result.lastRechargeToken).toBe('new');
  });

  it('suppresses only the muted category', () => {
    const result = evaluate(
      state({ lastRechargeToken: 'old' }),
      { balance: 10, recharges: [recharge({ token: 'new' })] },
      { lowBalanceAlerts: false },
    );

    expect(result.alerts).toEqual([ALERT_KIND.RECHARGE_DETECTED]);
  });

  it('does not replay a crossing that happened while alerts were off', () => {
    // Balance fell below the threshold with alerts muted...
    const muted = evaluate(
      state(),
      { balance: 10, recharges: [] },
      { lowBalanceAlerts: false },
    );
    expect(muted.alerts).toEqual([]);
    expect(muted.severity).toBe(ALERT_SEVERITY.LOW);

    // ...so re-enabling them does not fire for a crossing already past.
    const unmuted = evaluate(
      state({ severity: muted.severity }),
      { balance: 9, recharges: [] },
      { lowBalanceAlerts: true },
    );
    expect(unmuted.alerts).toEqual([]);
  });
});
