import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { Request } from 'express';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { JwtPayload } from '../auth.service';
import { PrismaService } from '../../../database/prisma.service';
import { RecordStatus, SessionStatus } from '../../../generated/prisma/enums';

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (isPublic) {
      return true;
    }

    const request = context.switchToHttp().getRequest<Request>();
    const token = this.extractTokenFromHeader(request);

    if (!token) {
      throw new UnauthorizedException('Authentication token missing.');
    }

    try {
      const payload: JwtPayload = await this.jwtService.verifyAsync(token, {
        secret: this.configService.getOrThrow<string>('JWT_SECRET'),
      });

      // Verify active session exists in DB
      if (payload.sessionId) {
        const session = await this.prisma.userSession.findUnique({
          where: { id: payload.sessionId },
        });

        if (
          !session ||
          session.status !== SessionStatus.ACTIVE ||
          new Date() > session.expiresAt
        ) {
          throw new UnauthorizedException(
            'Session expired or revoked. Please log in again.',
          );
        }
      }

      // Verify user exists and is active
      const user = await this.prisma.user.findFirst({
        where: { id: payload.sub, deletedAt: null },
      });

      if (!user || user.status !== RecordStatus.ACTIVE) {
        throw new UnauthorizedException(
          'User account is disabled or deactivated.',
        );
      }

      // Attach decoded user payload to request
      (request as any).user = payload;
      return true;
    } catch (error) {
      if (error instanceof UnauthorizedException) {
        throw error;
      }
      throw new UnauthorizedException('Invalid or expired authentication token.');
    }
  }

  private extractTokenFromHeader(request: Request): string | undefined {
    const [type, token] = request.headers.authorization?.split(' ') ?? [];
    return type === 'Bearer' ? token : undefined;
  }
}

