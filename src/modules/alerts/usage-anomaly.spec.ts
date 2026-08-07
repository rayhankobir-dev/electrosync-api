import type { UserSettings } from '@/database/types/user-settings.type';

import {
  ANOMALY_BASELINE_DAYS,
  ANOMALY_MIN_BASELINE_COST,
  ANOMALY_MIN_BASELINE_DAYS,
} from './alerts.constants';
import { evaluateUsageAnomaly, type DailyCost } from './usage-anomaly';

/** Settings that let an alert through, so each test overrides only its subject. */
const ON: UserSettings = {
  pushEnabled: true,
  usageAnomalyAlerts: true,
  usageAnomalyThreshold: 40,
};

/**
 * `count` days ending 2026-08-20, each costing `cost`.
 *
 * Dates are real and sequential because the dedup check compares them as
 * strings — a series of fake labels would pass tests that a real `YYYY-MM-DD`
 * ordering would fail.
 */
function flatDays(count: number, cost: number): DailyCost[] {
  const end = new Date('2026-08-20T00:00:00Z');

  return Array.from({ length: count }, (_, index) => {
    const day = new Date(end);
    day.setUTCDate(day.getUTCDate() - (count - 1 - index));
    return { day: day.toISOString().slice(0, 10), consumedCost: cost };
  });
}

/** A flat baseline with the final day replaced by a spike. */
function withSpike(count: number, baseline: number, spike: number): DailyCost[] {
  const days = flatDays(count, baseline);
  days[days.length - 1] = { ...days[days.length - 1], consumedCost: spike };
  return days;
}

describe('evaluateUsageAnomaly', () => {
  describe('gating', () => {
    it('says nothing when the master push switch is off', () => {
      const outcome = evaluateUsageAnomaly(
        withSpike(10, 100, 500),
        { ...ON, pushEnabled: false },
        null,
      );

      expect(outcome).toEqual({ kind: 'none', reason: 'disabled' });
    });

    it('says nothing when only the anomaly alert is off', () => {
      const outcome = evaluateUsageAnomaly(
        withSpike(10, 100, 500),
        { ...ON, usageAnomalyAlerts: false },
        null,
      );

      expect(outcome).toEqual({ kind: 'none', reason: 'disabled' });
    });

    it('treats absent settings as the defaults rather than throwing', () => {
      const outcome = evaluateUsageAnomaly(withSpike(10, 100, 500), null, null);

      expect(outcome.kind).toBe('anomaly');
    });
  });

  describe('history requirements', () => {
    it('stays quiet on an empty series', () => {
      expect(evaluateUsageAnomaly([], ON, null)).toEqual({
        kind: 'none',
        reason: 'insufficient-history',
      });
    });

    it('stays quiet one baseline day short of the minimum', () => {
      // One subject day plus one fewer baseline day than required.
      const days = withSpike(ANOMALY_MIN_BASELINE_DAYS, 100, 500);

      expect(evaluateUsageAnomaly(days, ON, null)).toEqual({
        kind: 'none',
        reason: 'insufficient-history',
      });
    });

    it('fires as soon as the minimum baseline is met', () => {
      const days = withSpike(ANOMALY_MIN_BASELINE_DAYS + 1, 100, 500);

      expect(evaluateUsageAnomaly(days, ON, null).kind).toBe('anomaly');
    });

    it('averages at most ANOMALY_BASELINE_DAYS, ignoring older history', () => {
      // Ten wildly expensive days sit just outside the baseline window. If the
      // mean reached back that far it would land near ৳2000 and the ৳500
      // subject day would read as a saving rather than a spike.
      const total = ANOMALY_BASELINE_DAYS + 11;
      const series = flatDays(total, 100);

      for (let i = 0; i < total - ANOMALY_BASELINE_DAYS - 1; i += 1) {
        series[i] = { ...series[i], consumedCost: 5000 };
      }
      series[total - 1] = { ...series[total - 1], consumedCost: 500 };

      const outcome = evaluateUsageAnomaly(series, ON, null);

      expect(outcome.kind).toBe('anomaly');
      // Exactly the recent average, which is only true if the old days were
      // excluded rather than merely outweighed.
      expect(outcome.kind === 'anomaly' && outcome.finding.baseline).toBe(100);
    });
  });

  describe('the small-baseline floor', () => {
    it('ignores a huge percentage rise on a near-idle meter', () => {
      // ৳2 -> ৳20 is a 900% rise and means nothing: somebody ran a kettle.
      const days = withSpike(14, ANOMALY_MIN_BASELINE_COST - 13, 20);

      expect(evaluateUsageAnomaly(days, ON, null)).toEqual({
        kind: 'none',
        reason: 'baseline-too-small',
      });
    });

    it('reports the same relative rise once the baseline clears the floor', () => {
      const days = withSpike(14, ANOMALY_MIN_BASELINE_COST + 5, 200);

      expect(evaluateUsageAnomaly(days, ON, null).kind).toBe('anomaly');
    });
  });

  describe('the threshold', () => {
    it('does not fire one point below the threshold', () => {
      // 100 -> 139 is 39%, against a 40% setting.
      const outcome = evaluateUsageAnomaly(withSpike(14, 100, 139), ON, null);

      expect(outcome).toEqual({ kind: 'none', reason: 'within-threshold' });
    });

    it('fires exactly at the threshold', () => {
      const outcome = evaluateUsageAnomaly(withSpike(14, 100, 140), ON, null);

      expect(outcome.kind).toBe('anomaly');
    });

    it('honours a stricter setting', () => {
      const days = withSpike(14, 100, 150);

      expect(
        evaluateUsageAnomaly(days, { ...ON, usageAnomalyThreshold: 60 }, null),
      ).toEqual({ kind: 'none', reason: 'within-threshold' });
    });

    it('never fires on a drop, however steep', () => {
      const outcome = evaluateUsageAnomaly(withSpike(14, 100, 1), ON, null);

      expect(outcome).toEqual({ kind: 'none', reason: 'within-threshold' });
    });
  });

  describe('deduplication', () => {
    it('stays quiet on a day already reported', () => {
      const days = withSpike(14, 100, 500);
      const subject = days[days.length - 1].day;

      expect(evaluateUsageAnomaly(days, ON, subject)).toEqual({
        kind: 'none',
        reason: 'already-reported',
      });
    });

    it('stays quiet when the marker is newer than the subject day', () => {
      const days = withSpike(14, 100, 500);

      expect(evaluateUsageAnomaly(days, ON, '2099-01-01')).toEqual({
        kind: 'none',
        reason: 'already-reported',
      });
    });

    it('fires again for a later day', () => {
      const days = withSpike(14, 100, 500);
      const previous = days[days.length - 2].day;

      expect(evaluateUsageAnomaly(days, ON, previous).kind).toBe('anomaly');
    });
  });

  describe('the reported finding', () => {
    it('carries the day, the cost, the baseline and the rounded percent', () => {
      const days = withSpike(14, 100, 175);
      const outcome = evaluateUsageAnomaly(days, ON, null);

      expect(outcome).toEqual({
        kind: 'anomaly',
        finding: {
          day: days[days.length - 1].day,
          cost: 175,
          baseline: 100,
          percentAbove: 75,
        },
      });
    });

    it('sorts an out-of-order series before deciding anything', () => {
      // A reversed series would otherwise judge the oldest day against the
      // newest ones — working code producing pure noise.
      const ordered = withSpike(14, 100, 500);
      const reversed = [...ordered].reverse();

      expect(evaluateUsageAnomaly(reversed, ON, null)).toEqual(
        evaluateUsageAnomaly(ordered, ON, null),
      );
    });
  });
});
