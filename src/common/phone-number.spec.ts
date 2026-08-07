import { toBangladeshMsisdn } from './phone-number';

describe('toBangladeshMsisdn', () => {
  it.each([
    ['+8801700000000', '8801700000000'],
    ['8801700000000', '8801700000000'],
    ['01700000000', '8801700000000'],
    ['1700000000', '8801700000000'],
    ['008801700000000', '8801700000000'],
  ])('normalises %s', (input, expected) => {
    expect(toBangladeshMsisdn(input)).toBe(expected);
  });

  it('strips the punctuation people type between groups', () => {
    expect(toBangladeshMsisdn('+880 1700-000 000')).toBe('8801700000000');
  });

  it('accepts a number typed on a Bengali keyboard', () => {
    // The reason folding happens before punctuation is stripped: these digits
    // are not \d, so stripping first would leave an empty string and the user
    // would be told they have no number on file.
    expect(toBangladeshMsisdn('০১৭০০০০০০০০')).toBe('8801700000000');
  });

  it('accepts every allocated operator prefix, and ones not yet allocated', () => {
    for (const prefix of ['013', '014', '015', '016', '017', '018', '019']) {
      expect(toBangladeshMsisdn(`${prefix}00000000`)).toBe(
        `880${prefix.slice(1)}00000000`,
      );
    }

    // Deliberately not pinned to 3–9: the regulator allocates new prefixes, and
    // a stricter test here would mean rejecting real customers to satisfy it.
    expect(toBangladeshMsisdn('01200000000')).toBe('8801200000000');
  });

  it.each([
    ['', 'empty'],
    ['   ', 'whitespace'],
    ['0170000000', 'one digit short'],
    ['017000000000', 'one digit long'],
    ['0212345678', 'a Dhaka landline'],
    ['+14155550100', 'a foreign number'],
    ['not a number', 'free text'],
  ])('rejects %s (%s)', (input) => {
    expect(toBangladeshMsisdn(input)).toBeNull();
  });

  it('treats null and undefined as no number on file', () => {
    expect(toBangladeshMsisdn(null)).toBeNull();
    expect(toBangladeshMsisdn(undefined)).toBeNull();
  });
});
