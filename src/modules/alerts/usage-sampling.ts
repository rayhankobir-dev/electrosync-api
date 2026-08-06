import {
  USAGE_ANOMALY,
  type UsageAnomaly,
} from '@/database/types/usage.type';
import { type NescoRechargeDto } from '@/modules/nesco/dto/nesco-response.dto';

/** Balances below this apart are floating-point noise, not a real movement. */
const EPSILON = 0.01;

/** The portal reports money to two decimals; so do we. */
const MONEY_DP = 2;

const SECONDS_PER_HOUR = 3600;
const MS_PER_HOUR = SECONDS_PER_HOUR * 1000;

export interface UsageSamplingLimits {
  /**
   * Spend per hour above which a reading is treated as a parse failure rather
   * than a very hungry customer.
   */
  readonly maxCostPerHour: number;
  /** Window length beyond which the reading is flagged (but still counted). */
  readonly maxWindowHours: number;
}

export interface UsageSampleInput {
  /** Balance at the previous successful poll. */
  readonly openingBalance: number;
  /** Balance just read. */
  readonly closingBalance: number;
  /** `meter_alert_state.last_balance_at` — when `openingBalance` was read. */
  readonly windowStart: Date;
  /** Now. */
  readonly windowEnd: Date;
  /** Full recharge history from the same scrape; filtered to the window here. */
  readonly recharges: readonly NescoRechargeDto[];
}

export interface UsageSample {
  readonly windowStart: Date;
  readonly windowEnd: Date;
  readonly openingBalance: number;
  readonly closingBalance: number;
  readonly rechargeCredited: number;
  readonly rechargePaid: number;
  readonly consumedCost: number;
  readonly rawDelta: number;
  readonly anomaly: UsageAnomaly | null;
}

function round(value: number): number {
  const factor = 10 ** MONEY_DP;
  return Math.round(value * factor) / factor;
}

/**
 * Sums the recharges that landed inside the window.
 *
 * The bound is half-open — `(start, end]` — because `start` is the instant of
 * the *previous* poll, and any recharge at exactly that instant was already
 * reflected in the opening balance. Counting it again would credit it twice
 * and show the window as more expensive than it was.
 *
 * Only successful recharges move the balance, so pending and failed ones are
 * excluded; including them would invent consumption that never happened.
 */
function rechargesWithin(
  recharges: readonly NescoRechargeDto[],
  windowStart: Date,
  windowEnd: Date,
): { credited: number; paid: number } {
  const startSeconds = windowStart.getTime() / 1000;
  const endSeconds = windowEnd.getTime() / 1000;

  let credited = 0;
  let paid = 0;

  for (const recharge of recharges) {
    if (recharge.rechargeStatus !== 'success') continue;
    if (recharge.rechargedDate <= startSeconds) continue;
    if (recharge.rechargedDate > endSeconds) continue;

    credited += recharge.usableAmount;
    paid += recharge.rechargeAmount;
  }

  return { credited: round(credited), paid: round(paid) };
}

/**
 * Derives what a meter consumed between two balance readings.
 *
 * The portal never reports a cost, only a remaining balance, so consumption is
 * inferred from how far that balance fell — corrected for anything that topped
 * it back up:
 *
 *     cost = opening - closing + credited
 *
 * Without the correction a ৳500 recharge reads as ৳500 of negative
 * consumption, which is both nonsense and, once summed, quietly destroys the
 * week's total.
 *
 * Returns `null` when there is no window to measure. That is not an error: it
 * is the first poll of a meter's life (nothing to subtract from) and any
 * replay that arrives with a non-advancing clock.
 */
export function buildUsageSample(
  input: UsageSampleInput,
  limits: UsageSamplingLimits,
): UsageSample | null {
  const elapsedMs = input.windowEnd.getTime() - input.windowStart.getTime();
  if (elapsedMs <= 0) return null;

  const windowHours = elapsedMs / MS_PER_HOUR;
  const { credited, paid } = rechargesWithin(
    input.recharges,
    input.windowStart,
    input.windowEnd,
  );

  const rawDelta = round(
    input.openingBalance - input.closingBalance + credited,
  );

  const base = {
    windowStart: input.windowStart,
    windowEnd: input.windowEnd,
    openingBalance: input.openingBalance,
    closingBalance: input.closingBalance,
    rechargeCredited: credited,
    rechargePaid: paid,
    rawDelta,
  };

  // A balance that rose on its own means the reading is not describing
  // consumption at all — a stale page, a billing correction, or a swapped
  // meter. Suppressed rather than dropped, so the evidence survives.
  if (rawDelta < -EPSILON) {
    return { ...base, consumedCost: 0, anomaly: USAGE_ANOMALY.NEGATIVE_DELTA };
  }

  // Checked as a *rate*, not a total: a legitimately long window after an
  // outage accumulates a large cost without being implausible, and a flat
  // ceiling would reject exactly those recoveries.
  if (rawDelta / windowHours > limits.maxCostPerHour) {
    return {
      ...base,
      consumedCost: 0,
      anomaly: USAGE_ANOMALY.IMPLAUSIBLE_RATE,
    };
  }

  // Clamped, not flagged: everything from -EPSILON to 0 is rounding noise
  // around a genuinely idle meter, and flagging it would bury the real
  // anomalies in thousands of harmless rows.
  const consumedCost = Math.max(rawDelta, 0);

  // Annotation only. The consumption is real; what is unreliable is
  // attributing it to particular days, since a multi-day window gets spread
  // evenly across dates nobody actually observed.
  if (windowHours > limits.maxWindowHours) {
    return { ...base, consumedCost, anomaly: USAGE_ANOMALY.STALE_WINDOW };
  }

  return { ...base, consumedCost, anomaly: null };
}
