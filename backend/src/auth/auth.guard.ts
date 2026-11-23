import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { Reflector } from '@nestjs/core';
import { PUBLIC_ROUTE } from './public.decorator';
import { hashPassword, verifyPassword } from './password';
import { cleanName, isReservedBotName } from '../common/input.util';
import { isUniqueCollision } from '../prisma/transaction';
import { markRequestProcessing } from '../common/http-security';

/**
 * Parses the Authorization header in the form:
 *   Authorization: Basic <USERNAME>:<PASSWORD>
 *
 * The course uses raw Basic credentials, not RFC Basic's base64 encoding.
 * First use registers a human account; legacy accounts without hashes fail closed.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService, private readonly reflector: Reflector) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    markRequestProcessing(request);
    if (this.reflector.getAllAndOverride<boolean>(PUBLIC_ROUTE, [context.getHandler(), context.getClass()])) {
      return true;
    }
    const authHeader: string = request.headers['authorization'];

    if (typeof authHeader !== 'string' || authHeader.length > 1600 || !authHeader.startsWith('Basic ')) {
      throw new UnauthorizedException(
        'Missing or invalid Authorization header. Expected: Basic <username>:<password>',
      );
    }

    // Strip "Basic " prefix
    const credentials = authHeader.slice(6).trim();
    const colonIndex = credentials.indexOf(':');

    if (colonIndex === -1) {
      throw new UnauthorizedException(
        'Invalid Basic auth format. Expected: Basic <username>:<password>',
      );
    }

    let username: string;
    try { username = cleanName(credentials.substring(0, colonIndex)); } catch {
      throw new UnauthorizedException('Invalid credentials');
    }
    const password = credentials.substring(colonIndex + 1).trim();

    if (!password || Buffer.byteLength(password, 'utf8') > 1024 || /[\x00-\x1f\x7f-\x9f]/.test(password) || isReservedBotName(username)) {
      throw new UnauthorizedException('Username and password must not be empty');
    }

    const select = { id: true, name: true, bio: true, passwordHash: true, isBot: true } as const;
    let user = await this.prisma.user.findUnique({
      where: { name: username },
      select,
    });

    if (!user) {
      const passwordHash = await hashPassword(password);
      try {
        user = await this.prisma.user.create({
          data: { name: username, passwordHash, isBot: false, conversationIds: [] }, select,
        });
      } catch (error) {
        if (!isUniqueCollision(error)) throw error;
        user = await this.prisma.user.findUnique({ where: { name: username }, select });
      }
    }
    if (!user || user.isBot || !(await verifyPassword(password, user.passwordHash))) {
      throw new UnauthorizedException('Invalid credentials');
    }
    request.user = { id: user.id, name: user.name, bio: user.bio };
    return true;
  }
}
