import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';

import { type AuthenticatedUser } from '@/modules/auth/types';
import { CurrentUser } from '@/modules/auth/decorators/current-user.decorator';

import { ListNotificationsQueryDto } from './dto/list-notifications.query.dto';
import { RegisterDeviceTokenDto } from './dto/register-device-token.dto';
import { NotificationService } from './notification.service';

@ApiTags('Notifications')
@ApiBearerAuth()
@ApiUnauthorizedResponse({ description: 'Missing or invalid access token.' })
@Controller('notifications')
export class NotificationController {
  constructor(private readonly notifications: NotificationService) {}

  @Get()
  @ApiOperation({ summary: 'List your notifications, newest first.' })
  @ApiOkResponse({ description: 'Your notifications.' })
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: ListNotificationsQueryDto,
  ) {
    return this.notifications.listForUser(user.id, query);
  }

  /**
   * Declared before `:id/read` for readability only — the two cannot collide,
   * since this path is one segment and that one is two.
   */
  @Patch('read-all')
  @ApiOperation({
    summary: 'Mark all your unread notifications read. Idempotent.',
  })
  @ApiOkResponse({ description: 'How many rows were marked read.' })
  markAllAsRead(@CurrentUser() user: AuthenticatedUser) {
    return this.notifications.markAllAsRead(user.id);
  }

  @Patch(':id/read')
  @ApiOperation({ summary: 'Mark one of your notifications read. Idempotent.' })
  @ApiOkResponse({ description: 'The updated notification.' })
  @ApiNotFoundResponse({ description: 'No such notification for this user.' })
  markAsRead(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.notifications.markAsRead(id, user.id);
  }

  @Delete()
  @ApiOperation({
    summary:
      'Clear your notification list. Archives rather than deletes, so the ' +
      'history stays available via ?includeArchived=true.',
  })
  @ApiOkResponse({ description: 'How many rows were archived.' })
  archiveAll(@CurrentUser() user: AuthenticatedUser) {
    return this.notifications.archiveAll(user.id);
  }

  @Post('tokens')
  @ApiOperation({ summary: 'Register or refresh this device’s push token.' })
  @ApiCreatedResponse({ description: 'The stored device token.' })
  registerToken(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: RegisterDeviceTokenDto,
  ) {
    return this.notifications.registerDeviceToken(user.id, dto);
  }

  @Delete('tokens/:token')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Unregister one of your device tokens.' })
  @ApiNoContentResponse({ description: 'The token is no longer active.' })
  @ApiNotFoundResponse({ description: 'That device token is not registered.' })
  async unregisterToken(
    @CurrentUser() user: AuthenticatedUser,
    @Param('token') token: string,
  ): Promise<void> {
    await this.notifications.unregisterDeviceToken(user.id, token);
  }
}
