import { Controller, Get, Param, UseFilters } from '@nestjs/common';
import {
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { ServiceDto, ServiceListDto } from './services.dto';
import { ServicesExceptionFilter } from './services-exception.filter';
import { ServicesService } from './services.service';

@ApiTags('public services')
@ApiResponse({
  status: 503,
  description: 'The service catalogue is temporarily unavailable',
})
@UseFilters(ServicesExceptionFilter)
@Controller('services')
export class ServicesController {
  constructor(private readonly services: ServicesService) {}

  @Get()
  @ApiOkResponse({ type: ServiceListDto })
  @ApiOperation({
    summary: 'List the active public service catalogue and active variants',
  })
  list() {
    return this.services.list();
  }

  @Get(':slug')
  @ApiParam({ name: 'slug', example: 'new-drivers-licence' })
  @ApiOkResponse({ type: ServiceDto })
  @ApiNotFoundResponse({ description: 'Active service not found' })
  @ApiOperation({
    summary: 'Fetch one active public service and its active variants by slug',
  })
  read(@Param('slug') slug: string) {
    return this.services.read(slug);
  }
}
