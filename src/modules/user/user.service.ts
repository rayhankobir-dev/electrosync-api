import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';

import { DRIZZLE } from '@/database/constants/database.constants';
import type { DrizzleDb } from '@/database/types/drizzle';
import { user } from '@/database/schema';
import {
  DEFAULT_USER_SETTINGS,
  UserSettings,
} from '@/database/types/user-settings.type';

import { UpdateProfileDto } from './dto/update-profile.dto';
import { UpdateUserSettingsDto } from './dto/update-user-settings.dto';

/**
 * Named explicitly rather than selecting the whole row: the `user` table also
 * holds `settings` and the columns behind authentication, and none of that
 * belongs in a profile response.
 */
const PROFILE_COLUMNS = {
  id: user.id,
  name: user.name,
  email: user.email,
  emailVerified: user.emailVerified,
  mobile: user.mobile,
  createdAt: user.createdAt,
} as const;

@Injectable()
export class UserService {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDb) {}

  async getProfile(userId: string) {
    const [row] = await this.db
      .select(PROFILE_COLUMNS)
      .from(user)
      .where(eq(user.id, userId))
      .limit(1);

    if (!row) {
      throw new NotFoundException('User not found.');
    }

    return row;
  }

  async updateProfile(userId: string, dto: UpdateProfileDto) {
    const patch: { name?: string; mobile?: string | null } = {};

    // Built key by key rather than spreading the DTO: a key present with an
    // `undefined` value would still reach drizzle's `set` and blank the column.
    if (dto.name !== undefined) patch.name = dto.name.trim();
    // An empty string means "remove my number", and the column is nullable.
    if (dto.mobile !== undefined) patch.mobile = dto.mobile.trim() || null;

    if (Object.keys(patch).length === 0) {
      return this.getProfile(userId);
    }

    const [row] = await this.db
      .update(user)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(user.id, userId))
      .returning(PROFILE_COLUMNS);

    if (!row) {
      throw new NotFoundException('User not found.');
    }

    return row;
  }

  async getSettings(userId: string): Promise<Required<UserSettings>> {
    const [row] = await this.db
      .select({ settings: user.settings })
      .from(user)
      .where(eq(user.id, userId))
      .limit(1);

    if (!row) {
      throw new NotFoundException('User not found.');
    }

    return this.withDefaults(row.settings);
  }

  async updateSettings(
    userId: string,
    patch: UpdateUserSettingsDto,
  ): Promise<Required<UserSettings>> {
    if (Object.keys(patch).length === 0) {
      return this.getSettings(userId);
    }

    const [row] = await this.db
      .update(user)
      .set({
        settings: sql`coalesce(${user.settings}, '{}'::jsonb) || ${JSON.stringify(patch)}::jsonb`,
        updatedAt: new Date(),
      })
      .where(eq(user.id, userId))
      .returning({ settings: user.settings });

    if (!row) {
      throw new NotFoundException('User not found.');
    }

    return this.withDefaults(row.settings);
  }

  private withDefaults(
    stored: UserSettings | null | undefined,
  ): Required<UserSettings> {
    return { ...DEFAULT_USER_SETTINGS, ...(stored ?? {}) };
  }
}
