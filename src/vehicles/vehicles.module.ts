import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { PrismaModule } from '../prisma/prisma.module';
import { VehiclesController } from './vehicles.controller';
import { VehiclesExceptionFilter } from './vehicles-exception.filter';
import { VehiclesService } from './vehicles.service';

@Module({
  imports: [AuthModule, PrismaModule],
  controllers: [VehiclesController],
  providers: [VehiclesService, VehiclesExceptionFilter],
})
export class VehiclesModule {}
