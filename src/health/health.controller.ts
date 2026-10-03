import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import {
  ApiOkResponse,
  ApiOperation,
  ApiServiceUnavailableResponse,
  ApiTags,
} from '@nestjs/swagger';
import { PrismaService } from '../prisma/prisma.service';
import { HealthResponse, ReadinessResponse } from './health.dto';

@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  @ApiOperation({ summary: 'Check whether the API process is running' })
  @ApiOkResponse({ type: HealthResponse })
  health(): HealthResponse {
    return { status: 'ok' };
  }

  @Get('ready')
  @ApiOperation({ summary: 'Check whether PostgreSQL is reachable' })
  @ApiOkResponse({ type: ReadinessResponse })
  @ApiServiceUnavailableResponse({
    description: 'PostgreSQL is unavailable',
    type: ReadinessResponse,
  })
  async readiness(): Promise<ReadinessResponse> {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      return { status: 'ready', checks: { database: 'up' } };
    } catch {
      // Database errors may contain connection details; do not expose them.
      throw new ServiceUnavailableException({
        status: 'not_ready',
        checks: { database: 'down' },
      } satisfies ReadinessResponse);
    }
  }
}
