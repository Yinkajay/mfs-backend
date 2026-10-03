import { ApiProperty } from '@nestjs/swagger';

export class HealthResponse {
  @ApiProperty({ enum: ['ok'], example: 'ok' })
  status!: 'ok';
}

export class DatabaseCheck {
  @ApiProperty({ enum: ['up', 'down'], example: 'up' })
  database!: 'up' | 'down';
}

export class ReadinessResponse {
  @ApiProperty({ enum: ['ready', 'not_ready'], example: 'ready' })
  status!: 'ready' | 'not_ready';

  @ApiProperty({ type: DatabaseCheck })
  checks!: DatabaseCheck;
}
