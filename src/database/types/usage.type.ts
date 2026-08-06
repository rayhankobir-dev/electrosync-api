/**
 * Why a usage sample's arithmetic could not be trusted.
 *
 * The balance behind these numbers is scraped from a public website, so the
 * formula `opening - closing + recharged` occasionally produces something no
 * meter could have done. Recording *which* way it went wrong is what makes a
 * broken parser findable later — `WHERE anomaly IS NOT NULL` is the alarm.
 */
export const USAGE_ANOMALY = {
  /**
   * Balance rose with no recharge to explain it. Seen when the portal serves a
   * stale page, NESCO posts a billing correction, or the physical meter is
   * swapped and its balance resets.
   */
  NEGATIVE_DELTA: 'NEGATIVE_DELTA',
  /**
   * The implied spend per hour exceeds what any connection on the platform
   * could draw. Almost always a parse failure rather than a real reading.
   */
  IMPLAUSIBLE_RATE: 'IMPLAUSIBLE_RATE',
  /**
   * The window is far longer than a sweep interval, so the sweep was down or
   * the meter was dormant. Unlike the two above this does *not* zero the cost —
   * that consumption really happened — but it marks the row so a week-long
   * outage cannot masquerade as one very expensive day.
   */
  STALE_WINDOW: 'STALE_WINDOW',
} as const;

export type UsageAnomaly = (typeof USAGE_ANOMALY)[keyof typeof USAGE_ANOMALY];

/** How the analytics endpoint buckets samples. */
export const USAGE_GRANULARITY = {
  /** One point per Dhaka calendar day. */
  DAILY: 'daily',
  /** One point per Dhaka week, Monday-anchored (Postgres `date_trunc`). */
  WEEKLY: 'weekly',
  /**
   * Exactly seven points — the mean cost for each day of the week across the
   * whole range. Only says something the daily series doesn't when the range
   * spans several weeks, which is why the client gates it on sample history.
   */
  WEEKDAY: 'weekday',
} as const;

export type UsageGranularity =
  (typeof USAGE_GRANULARITY)[keyof typeof USAGE_GRANULARITY];

/**
 * Every timestamp the analytics layer buckets by is converted to this zone.
 *
 * Bangladesh is UTC+6 and does not observe DST. Bucketing by UTC instead would
 * start every user's day at 6am local — their whole evening would land on the
 * following day's chart.
 */
export const REPORTING_TIME_ZONE = 'Asia/Dhaka';
