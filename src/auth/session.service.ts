import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, randomBytes } from 'node:crypto';
import type { CookieOptions, Request, Response } from 'express';
import type { Environment } from '../config/environment';
import { PrismaService } from '../prisma/prisma.service';
import { PUBLIC_USER_SELECT, type PublicUser } from '../users/user.dto';

export interface CustomerSession {
  id: string;
  user: PublicUser;
}
export type AuthenticatedRequest = Request & {
  customerSession?: CustomerSession;
};

export function sessionTokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

@Injectable()
export class SessionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<Environment, true>,
  ) {}

  get cookieName(): string {
    return this.config.get('SESSION_COOKIE_SECURE', { infer: true })
      ? '__Host-mfs_session'
      : 'mfs_session';
  }

  private get cookieOptions(): CookieOptions {
    return {
      httpOnly: true,
      secure: this.config.get('SESSION_COOKIE_SECURE', { infer: true }),
      sameSite: 'lax',
      path: '/',
    };
  }

  readToken(request: Request): string | null {
    const matches = (request.headers.cookie ?? '')
      .split(';')
      .map((cookie) => cookie.trim())
      .filter((cookie) => cookie.startsWith(`${this.cookieName}=`));
    if (matches.length !== 1) return null;
    const token = matches[0].slice(this.cookieName.length + 1);
    return /^[A-Za-z0-9_-]{43}$/.test(token) ? token : null;
  }

  async create(userId: string, previousToken: string | null) {
    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(
      Date.now() +
        this.config.get('SESSION_TTL_SECONDS', { infer: true }) * 1000,
    );
    // Login always creates a fresh token; never adopt a supplied cookie (fixation).
    await this.prisma.$transaction(async (transaction) => {
      if (previousToken) {
        await transaction.session.updateMany({
          where: {
            tokenHash: sessionTokenHash(previousToken),
            revokedAt: null,
          },
          data: { revokedAt: new Date() },
        });
      }
      await transaction.session.create({
        data: { userId, tokenHash: sessionTokenHash(token), expiresAt },
        select: { id: true },
      });
    });
    return { token, expiresAt };
  }

  setCookie(response: Response, token: string, expiresAt: Date): void {
    response.cookie(this.cookieName, token, {
      ...this.cookieOptions,
      expires: expiresAt,
    });
  }

  clearCookie(response: Response): void {
    response.clearCookie(this.cookieName, this.cookieOptions);
  }

  async authenticate(token: string | null): Promise<CustomerSession> {
    if (!token) throw new UnauthorizedException('Authentication required');
    const now = new Date();
    const validSession = {
      tokenHash: sessionTokenHash(token),
      revokedAt: null,
      expiresAt: { gt: now },
      lastSeenAt: {
        gt: new Date(
          now.getTime() -
            this.config.get('SESSION_IDLE_TTL_SECONDS', { infer: true }) * 1000,
        ),
      },
      user: { status: 'ACTIVE' as const, kind: 'CUSTOMER' as const },
    };
    return this.prisma.$transaction(async (transaction) => {
      const session = await transaction.session.findFirst({
        where: validSession,
        select: { id: true, user: { select: PUBLIC_USER_SELECT } },
      });
      if (!session) throw new UnauthorizedException('Authentication required');
      const touched = await transaction.session.updateMany({
        where: { ...validSession, id: session.id },
        data: { lastSeenAt: now },
      });
      if (touched.count !== 1)
        throw new UnauthorizedException('Authentication required');
      return session;
    });
  }

  async revoke(token: string | null): Promise<void> {
    if (token)
      await this.prisma.session.updateMany({
        where: { tokenHash: sessionTokenHash(token), revokedAt: null },
        data: { revokedAt: new Date() },
      });
  }
}
