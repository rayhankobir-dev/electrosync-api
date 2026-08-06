import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { Request } from 'express';

import { AuthenticatedUser, JwtPayload } from '../types';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';

export interface RequestWithUser extends Request {
  user?: AuthenticatedUser;
}

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly jwt: JwtService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (isPublic) {
      return true;
    }

    const request = context.switchToHttp().getRequest<RequestWithUser>();
    const token = this.extractBearerToken(request);

    if (!token) {
      throw new UnauthorizedException('Missing bearer token.');
    }

    let payload: JwtPayload;
    try {
      payload = await this.jwt.verifyAsync<JwtPayload>(token);
    } catch {
      throw new UnauthorizedException('Invalid or expired token.');
    }

    if (payload.type !== 'access') {
      throw new UnauthorizedException('Invalid or expired token.');
    }

    request.user = { id: payload.sub, email: payload.email };
    return true;
  }

  private extractBearerToken(request: Request): string | undefined {
    const [scheme, value] = request.headers.authorization?.split(' ') ?? [];
    return scheme?.toLowerCase() === 'bearer' ? value : undefined;
  }
}
