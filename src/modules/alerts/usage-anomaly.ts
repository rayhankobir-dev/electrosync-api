import {
  DEFAULT_USER_SETTINGS,
  type UserSettings,
} from '@/database/types/user-settings.type';

import {
  ANOMALY_BASELINE_DAYS,
  ANOMALY_MIN_BASELINE_COST,
  ANOMALY_MIN_BASELINE_DAYS,
} from './alerts.constants';

/** One completed Asia/Dhaka day of consumption for a single meter. */
export interface DailyCost {
  /** `YYYY-MM-DD`, Asia/Dhaka. */
  readonly day: string;
  readonly consumedCost: number;
}

export interface AnomalyFinding {
  /** The day that came in high. `YYYY-MM-DD`, Asia/Dhaka. */
  readonly day: string;
  readonly cost: number;
  /** Mean of the days preceding it. */
  readonly baseline: number;
  /** How far above the baseline, rounded to a whole percent. */
  readonly percentAbove: number;
}

/**
 * Why an evaluation produced nothing, when it produced nothing.
 *
 * Returned rather than logged because the two interesting cases are not
 * failures: "not enough history yet" is the normal state of a new meter, and
 * "already reported" is the normal state of three sweeps out of every four.
 * Collapsing them into a bare `null` would make a genuinely broken baseline
 * indistinguishable from a working one with nothing to say.
 */
export type AnomalyOutcome =
  | { readonly kind: 'anomaly'; readonly finding: AnomalyFinding }
  | {
      readonly kind: 'none';
      readonly reason:
        | 'disabled'
        | 'insufficient-history'
        | 'baseline-too-small'
        | 'within-threshold'
        | 'already-reported';
    };

function resolve(settings: UserSettings | null): Required<UserSettings> {
  return { ...DEFAULT_USER_SETTINGS, ...(settings ?? {}) };
}

/**
 * Decides whether the most recent completed day is worth telling the user
 * about.
 *
 * Pure, and deliberately so — the same reason `alert-evaluation.ts` is. Every
 * input is a value, so the interesting cases (a meter with six days of history,
 * a household whose baseline is ৳3, a day that is 39% high against a 40%
 * threshold) are unit-testable without a database or a portal.
 *
 * ### What it compares
 *
 * The last *completed* day against the mean of up to
 * `ANOMALY_BASELINE_DAYS` days before it. Completed matters: today is still
 * accumulating, and comparing a half-finished day against full ones would
 * report every morning as a dramatic saving and never fire at all.
 *
 * ### Three guards, each earning its place
 *
 * 1. **History.** Fewer than `ANOMALY_MIN_BASELINE_DAYS` baseline days and
 *    there is no "normal" to be above yet. A single hot Sunday would otherwise
 *    become the baseline the whole week is judged against.
 * 2. **Floor.** A baseline under `ANOMALY_MIN_BASELINE_COST` is rejected
 *    outright. On a near-idle meter, ৳2 → ৳5 is a 150% rise and means nothing
 *    — somebody ran a kettle. Percentages are unstable near zero, and this is
 *    where a naive implementation generates all of its false alarms.
 * 3. **Threshold.** The user's own sensitivity, as a percentage.
 *
 * ### What it does not do
 *
 * It never fires on a *drop*. Using less than usual is good news, and good news
 * does not need a push notification.
 */
export function evaluateUsageAnomaly(
  days: readonly DailyCost[],
  rawSettings: UserSettings | null,
  lastReportedDay: string | null,
): AnomalyOutcome {
  const settings = resolve(rawSettings);

  if (!settings.pushEnabled || !settings.usageAnomalyAlerts) {
    return { kind: 'none', reason: 'disabled' };
  }

  // Sorted here rather than trusted from the caller: the guard costs nothing
  // and a reversed series would silently compare the oldest day against the
  // newest ones, which looks like working code and reports pure noise.
  const ordered = [...days].sort((a, b) => a.day.localeCompare(b.day));

  const subject = ordered.at(-1);
  if (!subject) return { kind: 'none', reason: 'insufficient-history' };

  // Checked before the arithmetic, not after. Three of every four sweeps land
  // on a day already reported, and there is no reason to spend the work.
  if (lastReportedDay !== null && subject.day <= lastReportedDay) {
    return { kind: 'none', reason: 'already-reported' };
  }

  const baselineDays = ordered.slice(-1 - ANOMALY_BASELINE_DAYS, -1);

  if (baselineDays.length < ANOMALY_MIN_BASELINE_DAYS) {
    return { kind: 'none', reason: 'insufficient-history' };
  }

  const baseline =
    baselineDays.reduce((sum, entry) => sum + entry.consumedCost, 0) /
    baselineDays.length;

  if (baseline < ANOMALY_MIN_BASELINE_COST) {
    return { kind: 'none', reason: 'baseline-too-small' };
  }

  const ratio = subject.consumedCost / baseline;
  const percentAbove = Math.round((ratio - 1) * 100);

  if (percentAbove < settings.usageAnomalyThreshold) {
    return { kind: 'none', reason: 'within-threshold' };
  }

  return {
    kind: 'anomaly',
    finding: {
      day: subject.day,
      cost: round(subject.consumedCost),
      baseline: round(baseline),
      percentAbove,
    },
  };
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
