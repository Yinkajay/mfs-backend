import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { ServicesController } from './services.controller';
import { ServicesExceptionFilter } from './services-exception.filter';
import { ServicesService } from './services.service';

@Module({
  imports: [PrismaModule],
  controllers: [ServicesController],
  providers: [ServicesService, ServicesExceptionFilter],
})
export class ServicesModule {}
