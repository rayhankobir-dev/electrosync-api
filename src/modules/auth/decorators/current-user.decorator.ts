import {
  ExecutionContext,
  InternalServerErrorException,
  createParamDecorator,
} from '@nestjs/common';

import { AuthenticatedUser } from '../types';
import { RequestWithUser } from '../guards/jwt-auth.guard';

export const CurrentUser = createParamDecorator(
  (_data: unknown, context: ExecutionContext): AuthenticatedUser => {
    const request = context.switchToHttp().getRequest<RequestWithUser>();

    if (!request.user) {
      throw new InternalServerErrorException(
        'Route uses @CurrentUser() but is not behind the auth guard.',
      );
    }

    return request.user;
  },
);
