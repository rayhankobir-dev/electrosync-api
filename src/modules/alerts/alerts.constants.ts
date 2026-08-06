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
 * Window length past which a sample is flagged as stale.
 *
 * Two days is comfortably more than the four sweeps a day the default schedule
 * runs, so a handful of consecutive portal failures still produces clean rows.
 * Anything longer means the sweep itself was down, and spreading that
 * consumption evenly across days nobody observed is a guess worth labelling.
 */
export const DEFAULT_MAX_WINDOW_HOURS = 48;
