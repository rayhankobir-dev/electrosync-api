/**
 * bulksmsbd's HTTP endpoint.
 *
 * HTTPS rather than the `http://` form their documentation shows. The API key
 * is a query parameter, so over plaintext it is readable by every hop between
 * this server and Dhaka — and it is a bearer credential with a prepaid balance
 * attached. Their TLS endpoint answers identically, so there is nothing to
 * trade away. `SMS_PROVIDER_URL` overrides this if that ever stops being true.
 */
export const DEFAULT_SMS_ENDPOINT = 'https://bulksmsbd.net/api/smsapi';

/**
 * The one `response_code` that means "queued for delivery". Every other value
 * is a failure, reported over HTTP 200 with the reason in `error_message`.
 *
 * The provider's full code table is deliberately not mirrored here. It runs to
 * thirty-odd entries, changes without notice, and every one of them arrives
 * alongside a human-readable `error_message` that we log verbatim — so a copy
 * kept in this file could only ever go stale and start mislabelling failures.
 */
export const SMS_ACCEPTED_CODE = 202;

/**
 * Long enough for a slow international hop, short enough that a hung provider
 * cannot stall a balance sweep. The sweep sends alerts sequentially, so this
 * timeout is the per-alert ceiling on how long a dead provider delays the pass.
 */
export const SMS_REQUEST_TIMEOUT_MS = 15_000;

/** GSM-7 payload limits, in septets: standalone, then per concatenated part. */
export const GSM7_SINGLE_LIMIT = 160;
export const GSM7_CONCATENATED_LIMIT = 153;

/** UCS-2 payload limits, in UTF-16 code units. */
export const UCS2_SINGLE_LIMIT = 70;
export const UCS2_CONCATENATED_LIMIT = 67;
