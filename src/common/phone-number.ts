const BENGALI_ZERO = 0x09e6;
const BENGALI_NINE = 0x09ef;

/**
 * Turns whatever a user typed into the dialling form a Bangladeshi SMS gateway
 * accepts: `8801XXXXXXXXX`, country code included, no `+`.
 *
 * Normalising here rather than at the DTO is deliberate. `UpdateUserSettingsDto`
 * accepts a loosely-bounded string on purpose — people write `+8801700000000`,
 * `01700000000`, `+880 1700-000000`, and, on a Bengali keyboard, `০১৭০০০০০০০০`,
 * and rejecting those at the API would reject numbers that are merely typed
 * differently. The cost of that leniency is that the value reaching a gateway
 * is untrusted, so this is the one place that has to be strict.
 *
 * Returns null when the input cannot be a Bangladeshi mobile number. Null is a
 * routing decision, not an error: it means "this channel has nowhere to go",
 * which callers handle by skipping the channel rather than by failing the
 * notification.
 */
export function toBangladeshMsisdn(
  raw: string | null | undefined,
): string | null {
  if (!raw) return null;

  // Bengali digits are folded before stripping punctuation, not after — they
  // are not \d, so a number typed on a Bengali keyboard would otherwise be
  // stripped down to nothing and read as "no number on file".
  let digits = [...raw]
    .map((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code >= BENGALI_ZERO && code <= BENGALI_NINE
        ? String(code - BENGALI_ZERO)
        : character;
    })
    .join('')
    .replace(/\D/g, '');

  // The international dialling prefix, from a number copied out of a phone's
  // call log. Dropped before the length tests below, which count from the
  // country code.
  if (digits.startsWith('00')) digits = digits.slice(2);

  const national = toNationalNumber(digits);

  // Every Bangladeshi mobile number is 1 followed by nine digits (the operator
  // prefixes 013–019, plus whatever the regulator allocates next). Landlines
  // and truncated input fail here rather than at the gateway, where the failure
  // costs a round trip and reads as a provider fault.
  return national && /^1\d{9}$/.test(national) ? `880${national}` : null;
}

function toNationalNumber(digits: string): string | null {
  if (digits.length === 13 && digits.startsWith('880')) return digits.slice(3);
  if (digits.length === 11 && digits.startsWith('0')) return digits.slice(1);
  if (digits.length === 10) return digits;

  return null;
}
