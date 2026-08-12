import { BadRequestException } from '@nestjs/common';

import { type DrizzleDb } from '@/database/types/drizzle';

import { AuthService } from './auth.service';
import { PasswordService } from './password.service';
import { TokenService } from './token.service';

/**
 * Pins the rules of a signed-in password change: prove the old one, don't
 * re-set the same one, and leave a hash behind that the new password actually
 * opens.
 *
 * The real `PasswordService` is used rather than a mock. Argon2 is the thing
 * under test as much as the branching is — a test that stubbed `verify` would
 * pass just as happily against code that wrote the plaintext to the column.
 */
describe('AuthService.changePassword', () => {
  const USER_ID = 'user-1';
  const ACCOUNT_ID = 'account-1';
  const CURRENT = 'correct horse battery staple';

  const passwords = new PasswordService();

  let written: { password?: string | null; updatedAt?: Date } | null;
  let updatedAccountId: string | null;

  /**
   * A service over one account row. `row` is what the credential lookup finds:
   * `undefined` for no such row at all, and a null password for an account that
   * exists without one.
   */
  function serviceFor(row: { id: string; password: string | null } | undefined) {
    written = null;
    updatedAccountId = null;

    const db = {
      select: () => ({
        from: () => ({
          where: () => ({ limit: async () => (row ? [row] : []) }),
        }),
      }),
      update: () => ({
        set: (values: { password?: string | null; updatedAt?: Date }) => ({
          where: async () => {
            written = values;
            // The row is addressed by its own id, so recording that the write
            // happened is enough — there is no user-scoped predicate to assert.
            updatedAccountId = row?.id ?? null;
          },
        }),
      }),
    } as unknown as DrizzleDb;

    return new AuthService(db, passwords, {} as TokenService);
  }

  /** An account whose password is `CURRENT`, as the database would hold it. */
  async function credentialAccount() {
    return { id: ACCOUNT_ID, password: await passwords.hash(CURRENT) };
  }

  it('replaces the stored hash when the current password checks out', async () => {
    const service = serviceFor(await credentialAccount());

    await service.changePassword(USER_ID, {
      currentPassword: CURRENT,
      newPassword: 'a whole new passphrase',
    });

    expect(updatedAccountId).toBe(ACCOUNT_ID);
    expect(written?.password).toBeDefined();

    // The point of the whole feature: the column now opens with the new
    // password and no longer with the old one.
    await expect(
      passwords.verify(written!.password!, 'a whole new passphrase'),
    ).resolves.toBe(true);
    await expect(passwords.verify(written!.password!, CURRENT)).resolves.toBe(
      false,
    );
  });

  it('rejects a wrong current password without writing', async () => {
    const service = serviceFor(await credentialAccount());

    await expect(
      service.changePassword(USER_ID, {
        currentPassword: 'not the password',
        newPassword: 'a whole new passphrase',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(written).toBeNull();
  });

  /**
   * A 400 rather than a silent success. Reporting "saved" for a no-op change
   * teaches the user that the form worked when nothing about their account
   * moved.
   */
  it('rejects reusing the current password', async () => {
    const service = serviceFor(await credentialAccount());

    await expect(
      service.changePassword(USER_ID, {
        currentPassword: CURRENT,
        newPassword: CURRENT,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(written).toBeNull();
  });

  /**
   * An account with no password — an OAuth-only user, once that exists. There
   * is nothing to prove ownership against, so the change cannot be authorised
   * by a current password at all.
   */
  it('rejects an account that has no password', async () => {
    const service = serviceFor({ id: ACCOUNT_ID, password: null });

    await expect(
      service.changePassword(USER_ID, {
        currentPassword: CURRENT,
        newPassword: 'a whole new passphrase',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(written).toBeNull();
  });

  it('rejects a user with no credential account', async () => {
    const service = serviceFor(undefined);

    await expect(
      service.changePassword(USER_ID, {
        currentPassword: CURRENT,
        newPassword: 'a whole new passphrase',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(written).toBeNull();
  });
});
