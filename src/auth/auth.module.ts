import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { UsersModule } from '../users/users.module';
import { AuthBoundaryGuard } from './auth-boundary.guard';
import { AuthController, MeController } from './auth.controller';
import { AuthExceptionFilter } from './auth-exception.filter';
import { AuthRateLimitService } from './auth-rate-limit.service';
import { AuthService } from './auth.service';
import { CustomerSessionGuard } from './customer-session.guard';
import { PasswordService } from './password.service';
import { SessionService } from './session.service';

@Module({
  imports: [PrismaModule, UsersModule],
  controllers: [AuthController, MeController],
  providers: [
    AuthService,
    PasswordService,
    SessionService,
    AuthRateLimitService,
    AuthBoundaryGuard,
    CustomerSessionGuard,
    AuthExceptionFilter,
  ],
})
export class AuthModule {}
