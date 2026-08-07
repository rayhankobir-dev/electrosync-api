/**
 * Advisory-lock key for the sweep.
 *
 * PostgreSQL advisory locks live in a single global namespace keyed by a
 * bigint, so the number itself is arbitrary but must not collide with any
 * other lock this application takes. Recorded here as the one place to check
 * before adding a second scheduled job.
 */
export const SWEEP_LOCK_KEY = 728_401;

/** Every six hours, on the hour. */
export const DEFAULT_SWEEP_CRON = '0 */6 * * *';

/** Name the job is registered under in Nest's `SchedulerRegistry`. */
export const SWEEP_JOB_NAME = 'meter-balance-sweep';

/**
 * Meters scraped at a time.
 *
 * The NESCO portal is a scraped public website with no rate-limit contract and
 * no API, and each poll costs it two requests (session + report). Three at a
 * time keeps the sweep polite while still clearing a few hundred meters well
 * inside the six-hour window.
 */
export const DEFAULT_SWEEP_CONCURRENCY = 3;

/**
 * Spend per hour above which a usage sample is treated as bad data.
 *
 * Sized to be generous rather than tight: a large industrial connection is a
 * legitimate customer, and rejecting its real consumption would be a worse
 * failure than admitting the occasional inflated reading. What this actually
 * catches is the parser returning a balance in the wrong units or off by
 * orders of magnitude — failures that miss this ceiling by a mile.
 */
export const DEFAULT_MAX_COST_PER_HOUR = 500;

/**
 * Days of history the usage-anomaly baseline averages over.
 *
 * Two weeks is long enough that one heavy weekend cannot drag the mean up
 * behind a genuine spike, and short enough to track the seasonal drift that
 * dominates consumption here — a baseline built over a quarter would call
 * every day of a Rajshahi summer an anomaly against a March average.
 */
export const ANOMALY_BASELINE_DAYS = 14;

/**
 * Baseline days required before the alert arms at all.
 *
 * Half the full window. Waiting for all fourteen would leave a new meter silent
 * for a fortnight; fewer than seven and a single unusual day is a seventh of
 * the "normal" it is being measured against, which is how a baseline ends up
 * chasing the noise it is supposed to filter.
 */
export const ANOMALY_MIN_BASELINE_DAYS = 7;

/**
 * Daily spend below which the baseline is treated as too small to compare
 * against, in BDT.
 *
 * The guard that stops the whole feature from crying wolf. A ratio is unstable
 * near zero: on a meter idling at ৳2/day, somebody boiling a kettle is a 150%
 * rise and every threshold in the settings screen fires. ৳15/day is roughly a
 * small flat's floor consumption, so anything under it is a meter nobody is
 * really living behind — a holiday home, or one just added.
 */
export const ANOMALY_MIN_BASELINE_COST = 15;

/**
 * Window length past which a sample is flagged as stale.
 *
 * Two days is comfortably more than the four sweeps a day the default schedule
 * runs, so a handful of consecutive portal failures still produces clean rows.
 * Anything longer means the sweep itself was down, and spreading that
 * consumption evenly across days nobody observed is a guess worth labelling.
 */
export const DEFAULT_MAX_WINDOW_HOURS = 48;
