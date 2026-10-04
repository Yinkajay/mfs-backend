import {
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  Req,
  Res,
  UseFilters,
  UseGuards,
} from '@nestjs/common';
import {
  ApiAcceptedResponse,
  ApiBody,
  ApiCookieAuth,
  ApiForbiddenResponse,
  ApiHeader,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiResponse,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { UserDto } from '../users/user.dto';
import { AuthBoundaryGuard } from './auth-boundary.guard';
import { AuthExceptionFilter } from './auth-exception.filter';
import { AuthService } from './auth.service';
import {
  AuthValidationPipe,
  loginSchema,
  registerSchema,
  type LoginInput,
  type RegisterInput,
} from './auth.validation';
import { LoginDto, RegisterDto, RegistrationResponse } from './auth.dto';
import { CustomerSessionGuard } from './customer-session.guard';
import { SessionService, type AuthenticatedRequest } from './session.service';

@ApiTags('customer authentication')
@ApiHeader({
  name: 'X-MFS-CSRF',
  required: true,
  description:
    'Set to 1 on auth mutations; required even for non-browser clients',
})
@ApiForbiddenResponse({
  description: 'Origin or CSRF protection rejected the request',
})
@ApiResponse({
  status: 429,
  description: 'Rate limited; Retry-After is provided for persistent counters',
})
@ApiResponse({
  status: 503,
  description: 'Authentication storage is unavailable',
})
@UseFilters(AuthExceptionFilter)
@UseGuards(AuthBoundaryGuard)
@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly sessions: SessionService,
  ) {}

  @Post('register')
  @HttpCode(202)
  @ApiBody({ type: RegisterDto })
  @ApiOperation({
    summary:
      'Register a customer; new and existing emails receive the same response. Sign in separately.',
  })
  @ApiAcceptedResponse({ type: RegistrationResponse })
  @ApiResponse({ status: 400, description: 'Input validation failed' })
  register(@Body(new AuthValidationPipe(registerSchema)) input: RegisterInput) {
    return this.auth.register(input);
  }

  @Post('login')
  @HttpCode(200)
  @ApiBody({ type: LoginDto })
  @ApiOperation({
    summary: 'Sign in a customer and set a new HttpOnly session cookie',
  })
  @ApiOkResponse({ type: UserDto })
  @ApiUnauthorizedResponse({
    description:
      'Invalid email/password or unavailable customer account; deliberately indistinguishable',
  })
  async login(
    @Body(new AuthValidationPipe(loginSchema)) input: LoginInput,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    const result = await this.auth.login(
      input,
      this.sessions.readToken(request),
    );
    this.sessions.setCookie(response, result.token, result.expiresAt);
    return result.user;
  }

  @Post('logout')
  @HttpCode(204)
  @ApiCookieAuth('customerSession')
  @ApiOperation({
    summary:
      'Revoke this session and clear its cookie; idempotent even for missing/expired sessions',
  })
  @ApiNoContentResponse()
  async logout(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<void> {
    await this.sessions.revoke(this.sessions.readToken(request));
    this.sessions.clearCookie(response);
  }
}

@ApiTags('customer profile')
@ApiCookieAuth('customerSession')
@UseFilters(AuthExceptionFilter)
@UseGuards(AuthBoundaryGuard, CustomerSessionGuard)
@Controller('me')
export class MeController {
  @Get()
  @ApiOperation({
    summary:
      'Return the signed-in customer profile; excludes password hashes and session tokens',
  })
  @ApiOkResponse({ type: UserDto })
  @ApiUnauthorizedResponse({
    description:
      'Session missing, invalid, expired, revoked, or account unavailable',
  })
  @ApiResponse({ status: 429, description: 'Rate limited' })
  @ApiResponse({
    status: 503,
    description: 'Authentication storage is unavailable',
  })
  me(@Req() request: AuthenticatedRequest) {
    return request.customerSession!.user;
  }
}
