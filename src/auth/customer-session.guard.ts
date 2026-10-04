import {
  type CanActivate,
  type ExecutionContext,
  Injectable,
} from '@nestjs/common';
import { SessionService, type AuthenticatedRequest } from './session.service';

@Injectable()
export class CustomerSessionGuard implements CanActivate {
  constructor(private readonly sessions: SessionService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    request.customerSession = await this.sessions.authenticate(
      this.sessions.readToken(request),
    );
    return true;
  }
}
