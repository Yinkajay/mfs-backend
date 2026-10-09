import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Injectable,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request, Response } from 'express';
import type { Environment } from '../config/environment';
import { AuthRateLimitService } from './auth-rate-limit.service';

@Injectable()
export class AuthBoundaryGuard implements CanActivate {
  constructor(
    private readonly config: ConfigService<Environment, true>,
    private readonly limits: AuthRateLimitService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    context
      .switchToHttp()
      .getResponse<Response>()
      .setHeader('Cache-Control', 'no-store');
    if (
      this.config.get('SESSION_COOKIE_SECURE', { infer: true }) &&
      !request.secure
    )
      throw new ForbiddenException('HTTPS is required');
    const origin = request.headers.origin;
    if (
      origin !== undefined &&
      !this.config.get('AUTH_ALLOWED_ORIGINS', { infer: true }).includes(origin)
    )
      throw new ForbiddenException('Request origin is not allowed');
    const address = request.ip || request.socket.remoteAddress || 'unknown';
    if (['POST', 'PATCH', 'DELETE'].includes(request.method)) {
      // Strict JSON + a non-simple custom header + exact-origin CORS is the
      // CSRF defense, including login CSRF. SameSite is an additional layer.
      if (request.method !== 'DELETE' && !request.is('application/json'))
        throw new UnsupportedMediaTypeException('Use application/json');
      if (request.headers['x-mfs-csrf'] !== '1')
        throw new ForbiddenException('X-MFS-CSRF: 1 is required');
      const register = context.getHandler().name === 'register';
      const login = context.getHandler().name === 'login';
      if (register || login) {
        await this.limits.consume(
          register ? 'register:ip' : 'login:ip',
          address,
          this.config.get(
            register ? 'AUTH_REGISTER_IP_LIMIT' : 'AUTH_LOGIN_IP_LIMIT',
            { infer: true },
          ),
          this.config.get('AUTH_RATE_WINDOW_SECONDS', { infer: true }),
        );
        return true;
      }
    }
    await this.limits.consume('session:ip', address, 120, 60);
    return true;
  }
}
