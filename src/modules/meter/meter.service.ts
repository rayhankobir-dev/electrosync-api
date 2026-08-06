import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, asc, desc, eq, ne } from 'drizzle-orm';

import { DRIZZLE } from '@/database/constants/database.constants';
import { isUniqueViolation } from '@/database/database.errors';
import type { DrizzleDb } from '@/database/types/drizzle';
import { meter } from '@/database/schema';
import {
  DEFAULT_METER_PROVIDER,
  DEFAULT_METER_TYPE,
} from '@/database/types/meter.type';

import { AddMeterDto, UpdateMeterDto } from './dto/meter.dto';

const METER_COLUMNS = {
  id: meter.id,
  customerNo: meter.customerNo,
  type: meter.type,
  provider: meter.provider,
  label: meter.label,
  isPrimary: meter.isPrimary,
  createdAt: meter.createdAt,
};

@Injectable()
export class MeterService {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDb) {}

  /**
   * Primary first, then oldest first, so the list order is stable.
   *
   * `desc` on the boolean, not `asc`: Postgres orders `false` before `true`, so
   * ascending would put the primary meter last — the opposite of what every
   * caller and the route's own contract promise.
   */
  async list(userId: string) {
    return this.db
      .select(METER_COLUMNS)
      .from(meter)
      .where(eq(meter.userId, userId))
      .orderBy(desc(meter.isPrimary), asc(meter.createdAt));
  }

  async add(userId: string, dto: AddMeterDto) {
    return this.db.transaction(async (tx) => {
      const [existing] = await tx
        .select({ id: meter.id })
        .from(meter)
        .where(eq(meter.userId, userId))
        .limit(1);

      // The first meter becomes primary automatically. Otherwise a user with
      // exactly one meter would have no default, and every client would need
      // its own fallback rule.
      const isPrimary = !existing;

      try {
        const [row] = await tx
          .insert(meter)
          .values({
            userId,
            customerNo: dto.customerNo,
            // Explicit rather than relying on the column defaults, so the
            // values the API promises are visible here and not only in the
            // schema.
            type: dto.type ?? DEFAULT_METER_TYPE,
            provider: dto.provider ?? DEFAULT_METER_PROVIDER,
            label: dto.label,
            isPrimary,
            updatedAt: new Date(),
          })
          .returning(METER_COLUMNS);

        return row;
      } catch (error) {
        // Relying on the unique index rather than a prior SELECT: two
        // concurrent adds would both pass the check and both insert.
        if (isUniqueViolation(error)) {
          throw new ConflictException('You have already added that meter.');
        }
        throw error;
      }
    });
  }

  async update(userId: string, id: string, dto: UpdateMeterDto) {
    // Promotion is the only direction this flag moves. Writing `false` here
    // would leave an account holding meters but no default — the state `add`
    // and `remove` both go out of their way to prevent. Switching primary is
    // expressed by promoting the meter you want, which demotes the rest below.
    // Rejected before the transaction opens, since nothing can save it.
    if (dto.isPrimary === false) {
      throw new BadRequestException(
        'A meter cannot be un-set as primary. Make another meter primary instead.',
      );
    }

    return this.db.transaction(async (tx) => {
      const [owned] = await tx
        .select({ id: meter.id })
        .from(meter)
        .where(and(eq(meter.id, id), eq(meter.userId, userId)))
        .limit(1);

      if (!owned) {
        throw new NotFoundException('No such meter.');
      }

      // Demote the incumbent before promoting, inside the same transaction, so
      // there is never a moment with two primaries or none.
      //
      // Narrowed to rows that are actually primary: without it every other
      // meter on the account gets its `updatedAt` bumped on each promotion,
      // making untouched rows look edited.
      if (dto.isPrimary === true) {
        await tx
          .update(meter)
          .set({ isPrimary: false, updatedAt: new Date() })
          .where(
            and(
              eq(meter.userId, userId),
              ne(meter.id, id),
              eq(meter.isPrimary, true),
            ),
          );
      }

      const [row] = await tx
        .update(meter)
        .set({
          // Undefined leaves the column alone; Drizzle omits it from the SET.
          label: dto.label,
          isPrimary: dto.isPrimary,
          updatedAt: new Date(),
        })
        .where(eq(meter.id, id))
        .returning(METER_COLUMNS);

      return row;
    });
  }

  async remove(userId: string, id: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      const [removed] = await tx
        .delete(meter)
        // Scoped by owner: an id alone would let anyone delete another user's
        // meter by guessing.
        .where(and(eq(meter.id, id), eq(meter.userId, userId)))
        .returning({ isPrimary: meter.isPrimary });

      if (!removed) {
        throw new NotFoundException('No such meter.');
      }

      if (!removed.isPrimary) {
        return;
      }

      // Deleting the primary would otherwise leave the account with meters but
      // no default. Promote the oldest survivor.
      const [next] = await tx
        .select({ id: meter.id })
        .from(meter)
        .where(eq(meter.userId, userId))
        .orderBy(asc(meter.createdAt))
        .limit(1);

      if (next) {
        await tx
          .update(meter)
          .set({ isPrimary: true, updatedAt: new Date() })
          .where(eq(meter.id, next.id));
      }
    });
  }
}
