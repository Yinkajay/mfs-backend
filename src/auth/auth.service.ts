import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Environment } from '../config/environment';
import { Prisma } from '../generated/prisma/client';
import { UsersService } from '../users/users.service';
import { AuthRateLimitService } from './auth-rate-limit.service';
import type { LoginInput, RegisterInput } from './auth.validation';
import { PasswordService } from './password.service';
import { SessionService } from './session.service';

@Injectable()
export class AuthService {
  constructor(
    private readonly users: UsersService,
    private readonly passwords: PasswordService,
    private readonly sessions: SessionService,
    private readonly limits: AuthRateLimitService,
    private readonly config: ConfigService<Environment, true>,
  ) {}

  async register(input: RegisterInput): Promise<{ message: string }> {
    await this.limits.consume(
      'register:account',
      input.email,
      this.config.get('AUTH_REGISTER_ACCOUNT_LIMIT', { infer: true }),
      this.config.get('AUTH_RATE_WINDOW_SECONDS', { infer: true }),
    );
    // Hash before the insert for both new and duplicate registrations.
    const passwordHash = await this.passwords.hash(input.password);
    try {
      await this.users.createCustomer(input, passwordHash);
    } catch (error) {
      if (!(
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ))
        throw error;
    }
    // No auto-login, user object, or existence signal on this endpoint.
    return {
      message: 'Registration request received. You can now try signing in.',
    };
  }

  async login(input: LoginInput, previousToken: string | null) {
    await this.limits.consume(
      'login:account',
      input.email,
      this.config.get('AUTH_LOGIN_ACCOUNT_LIMIT', { infer: true }),
      this.config.get('AUTH_RATE_WINDOW_SECONDS', { infer: true }),
    );
    const user = await this.users.findCredentials(input.email);
    const correctPassword = await this.passwords.verify(
      input.password,
      user?.passwordHash ?? null,
    );
    if (
      !user ||
      !correctPassword ||
      user.status !== 'ACTIVE' ||
      user.kind !== 'CUSTOMER'
    )
      throw new UnauthorizedException('Invalid email or password');
    const publicUser = await this.users.getPublicUser(user.id);
    const session = await this.sessions.create(user.id, previousToken);
    return { user: publicUser, ...session };
  }
}
