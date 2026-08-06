import { Body, Controller, Get, Patch } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';

import { type AuthenticatedUser } from '@/modules/auth/types';
import { CurrentUser } from '@/modules/auth/decorators/current-user.decorator';
import { UserProfileDto } from '@/modules/auth/dto/auth-response.dto';

import { UpdateProfileDto } from './dto/update-profile.dto';
import { UpdateUserSettingsDto } from './dto/update-user-settings.dto';
import { UserService } from './user.service';

@ApiTags('User')
@ApiBearerAuth()
@ApiUnauthorizedResponse({ description: 'Missing or invalid access token.' })
@Controller('users/me')
export class UserController {
  constructor(private readonly users: UserService) {}

  @Patch()
  @ApiOperation({
    summary: 'Update your profile. Omitted keys keep their stored value.',
  })
  @ApiOkResponse({ type: UserProfileDto })
  @ApiNotFoundResponse({ description: 'User not found.' })
  updateProfile(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: UpdateProfileDto,
  ) {
    return this.users.updateProfile(user.id, dto);
  }

  @Get('settings')
  @ApiOperation({ summary: 'Your settings, with defaults applied.' })
  @ApiOkResponse({ description: 'The complete settings object.' })
  @ApiNotFoundResponse({ description: 'User not found.' })
  getSettings(@CurrentUser() user: AuthenticatedUser) {
    return this.users.getSettings(user.id);
  }

  @Patch('settings')
  @ApiOperation({
    summary: 'Update settings. Omitted keys keep their stored value.',
  })
  @ApiOkResponse({ description: 'The settings after the merge.' })
  @ApiNotFoundResponse({ description: 'User not found.' })
  updateSettings(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: UpdateUserSettingsDto,
  ) {
    return this.users.updateSettings(user.id, dto);
  }
}
