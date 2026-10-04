import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';
import type { Environment } from '../config/environment';
import { PrismaService } from '../prisma/prisma.service';

export function rateLimitKey(
  namespace: string,
  scope: string,
  identity: string,
): string {
  return createHash('sha256')
    .update(JSON.stringify([namespace, scope, identity]))
    .digest('hex');
}

export class AuthRateLimitException extends HttpException {
  constructor(readonly retryAfter: number) {
    super('Too many requests. Try again later.', HttpStatus.TOO_MANY_REQUESTS);
  }
}

@Injectable()
export class AuthRateLimitService {
  private nextCleanupAt = 0;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<Environment, true>,
  ) {}

  async consume(
    scope: string,
    identity: string,
    limit: number,
    windowSeconds: number,
  ): Promise<void> {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + windowSeconds * 1000);
    const key = rateLimitKey(
      this.config.get('AUTH_RATE_LIMIT_NAMESPACE', { infer: true }),
      scope,
      identity,
    );
    // One atomic statement, including the window reset: safe across processes.
    const [bucket] = await this.prisma.$queryRaw<
      { attempts: number; expires_at: Date }[]
    >`
      INSERT INTO "auth_rate_limits" ("key_hash", "attempts", "expires_at")
      VALUES (${key}, 1, ${expiresAt})
      ON CONFLICT ("key_hash") DO UPDATE SET
        "attempts" = CASE WHEN "auth_rate_limits"."expires_at" <= ${now}
          THEN 1 ELSE LEAST("auth_rate_limits"."attempts", 2147483646) + 1 END,
        "expires_at" = CASE WHEN "auth_rate_limits"."expires_at" <= ${now}
          THEN EXCLUDED."expires_at" ELSE "auth_rate_limits"."expires_at" END
      RETURNING "attempts", "expires_at"
    `;
    if (!bucket) throw new Error('Auth rate-limit storage unavailable');
    if (bucket.attempts > limit) {
      throw new AuthRateLimitException(
        Math.max(
          1,
          Math.ceil((bucket.expires_at.getTime() - now.getTime()) / 1000),
        ),
      );
    }
    // Bounded opportunistic cleanup; no worker or Redis dependency in this slice.
    if (Date.now() >= this.nextCleanupAt) {
      this.nextCleanupAt = Date.now() + 60000;
      await this.prisma.$executeRaw`
        DELETE FROM "auth_rate_limits" WHERE "expires_at" <= ${now} AND "key_hash" IN (
          SELECT "key_hash" FROM "auth_rate_limits" WHERE "expires_at" <= ${now}
          ORDER BY "expires_at" LIMIT 1000
        )
      `;
    }
  }
}
