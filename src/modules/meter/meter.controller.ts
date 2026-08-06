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
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
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

import { AddMeterDto, MeterDto, UpdateMeterDto } from './dto/meter.dto';
import { MeterService } from './meter.service';

/** Every route is scoped to the authenticated user's own meters. */
@ApiTags('Meters')
@ApiBearerAuth()
@ApiUnauthorizedResponse({ description: 'Missing or invalid token.' })
@Controller('meters')
export class MeterController {
  constructor(private readonly meters: MeterService) {}

  @Get()
  @ApiOperation({ summary: 'List your meters, primary first.' })
  @ApiOkResponse({ type: MeterDto, isArray: true })
  list(@CurrentUser() user: AuthenticatedUser) {
    return this.meters.list(user.id);
  }

  @Post()
  @ApiOperation({ summary: 'Add a meter. The first one becomes primary.' })
  @ApiCreatedResponse({ type: MeterDto })
  @ApiConflictResponse({ description: 'You have already added that meter.' })
  add(@CurrentUser() user: AuthenticatedUser, @Body() dto: AddMeterDto) {
    return this.meters.add(user.id, dto);
  }

  @Patch(':id')
  @ApiOperation({
    summary: 'Rename a meter or make it primary.',
    description:
      'Making a meter primary demotes whichever meter currently holds it, in ' +
      'the same transaction.',
  })
  @ApiOkResponse({ type: MeterDto })
  @ApiBadRequestResponse({
    description: 'Tried to un-set primary. Promote another meter instead.',
  })
  @ApiNotFoundResponse({ description: 'No such meter.' })
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: UpdateMeterDto,
  ) {
    return this.meters.update(user.id, id, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Remove a meter. Removing the primary promotes another.',
  })
  @ApiNoContentResponse({ description: 'The meter is removed.' })
  @ApiNotFoundResponse({ description: 'No such meter.' })
  async remove(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ): Promise<void> {
    await this.meters.remove(user.id, id);
  }
}
