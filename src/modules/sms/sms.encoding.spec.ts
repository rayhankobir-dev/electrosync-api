import { describeSms } from './sms.encoding';

describe('describeSms', () => {
  describe('alphabet selection', () => {
    it('sends plain ASCII as GSM-7', () => {
      expect(describeSms('Recharge confirmed').encoding).toBe('text');
    });

    it('sends Bengali as unicode', () => {
      expect(describeSms('মিটারে কম ব্যালেন্স').encoding).toBe('unicode');
    });

    it('sends an English alert as unicode, because of the taka sign', () => {
      // The reason detection reads the message rather than settings.language:
      // alert-messages.ts formats every amount with ৳, so English copy is
      // already outside GSM-7. Keying off the language setting would send this
      // as type=text and deliver mojibake.
      expect(describeSms('Meter A has ৳80 left').encoding).toBe('unicode');
    });

    it('keeps GSM-7 for the accented and Greek characters the alphabet covers', () => {
      expect(describeSms('Grüße Ç Ø å Δ Ω §').encoding).toBe('text');
    });

    it('keeps GSM-7 for the escape-extended characters', () => {
      expect(describeSms('a^b{c}d[e]f~g|h\\i€').encoding).toBe('text');
    });
  });

  describe('segment counting', () => {
    it('bills nothing for an empty message', () => {
      expect(describeSms('').segments).toBe(0);
    });

    it('fits 160 GSM-7 characters in one part', () => {
      expect(describeSms('a'.repeat(160)).segments).toBe(1);
    });

    it('splits at 161 into two parts of 153, not 160 + 1', () => {
      // The UDH header that reassembles the parts eats into each part's
      // payload, which is why the limit drops once a message concatenates.
      expect(describeSms('a'.repeat(161)).segments).toBe(2);
      expect(describeSms('a'.repeat(306)).segments).toBe(2);
      expect(describeSms('a'.repeat(307)).segments).toBe(3);
    });

    it('charges two septets for an escape-extended character', () => {
      // 80 euro signs are 160 septets — exactly one part — and one more tips it
      // over, even though the message is only 81 characters long.
      expect(describeSms('€'.repeat(80)).segments).toBe(1);
      expect(describeSms('€'.repeat(81)).segments).toBe(2);
    });

    it('fits 70 unicode characters in one part', () => {
      expect(describeSms('ম'.repeat(70)).segments).toBe(1);
      expect(describeSms('ম'.repeat(71)).segments).toBe(2);
      expect(describeSms('ম'.repeat(134)).segments).toBe(2);
    });

    it('counts an astral character as the two code units UCS-2 bills it as', () => {
      expect(describeSms('😀'.repeat(35)).segments).toBe(1);
      expect(describeSms('😀'.repeat(36)).segments).toBe(2);
    });
  });
});
