import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
  UseFilters,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBody,
  ApiCookieAuth,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiHeader,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiResponse,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { AuthBoundaryGuard } from '../auth/auth-boundary.guard';
import { CustomerSessionGuard } from '../auth/customer-session.guard';
import type { AuthenticatedRequest } from '../auth/session.service';
import {
  CreateVehicleDto,
  UpdateVehicleDto,
  VehicleDto,
  VehicleListDto,
} from './vehicles.dto';
import { VehiclesExceptionFilter } from './vehicles-exception.filter';
import { VehiclesService } from './vehicles.service';
import {
  createVehicleSchema,
  listVehiclesSchema,
  updateVehicleSchema,
  VehiclesValidationPipe,
  type CreateVehicleInput,
  type ListVehiclesInput,
  type UpdateVehicleInput,
} from './vehicles.validation';

@ApiTags('customer vehicles')
@ApiCookieAuth('customerSession')
@ApiUnauthorizedResponse({
  description: 'A valid active customer session is required',
})
@ApiForbiddenResponse({
  description: 'Origin or CSRF protection rejected the request',
})
@ApiBadRequestResponse({
  description:
    'Invalid details, query, or UUID; unknown input fields are rejected',
})
@ApiResponse({
  status: 429,
  description: 'Customer request rate limit exceeded',
})
@ApiResponse({
  status: 503,
  description: 'Vehicle or authentication storage is unavailable',
})
@UseFilters(VehiclesExceptionFilter)
@UseGuards(AuthBoundaryGuard, CustomerSessionGuard)
@Controller('vehicles')
export class VehiclesController {
  constructor(private readonly vehicles: VehiclesService) {}

  @Post()
  @ApiHeader({ name: 'X-MFS-CSRF', required: true, description: 'Set to 1' })
  @ApiBody({ type: CreateVehicleDto })
  @ApiCreatedResponse({ type: VehicleDto })
  @ApiOperation({
    summary:
      'Add a vehicle to the signed-in customer’s garage; category is the only required detail',
  })
  create(
    @Req() request: AuthenticatedRequest,
    @Body(new VehiclesValidationPipe(createVehicleSchema))
    input: CreateVehicleInput,
  ) {
    return this.vehicles.create(request.customerSession!.user.id, input);
  }

  @Get()
  @ApiQuery({
    name: 'limit',
    required: false,
    type: Number,
    example: 20,
    description: '1–100; default 20',
  })
  @ApiQuery({
    name: 'offset',
    required: false,
    type: Number,
    example: 0,
    description: '0–100000; default 0',
  })
  @ApiQuery({
    name: 'registrationNumber',
    required: false,
    type: String,
    description:
      'Exact normalized registration match; whitespace and letter case ignored, punctuation retained',
  })
  @ApiOkResponse({ type: VehicleListDto })
  @ApiOperation({
    summary: 'List only your vehicles, newest first, with bounded pagination',
  })
  list(
    @Req() request: AuthenticatedRequest,
    @Query(new VehiclesValidationPipe(listVehiclesSchema))
    query: ListVehiclesInput,
  ) {
    return this.vehicles.list(request.customerSession!.user.id, query);
  }

  @Get(':id')
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: VehicleDto })
  @ApiNotFoundResponse({
    description:
      'Vehicle missing or not owned by this customer; identical response',
  })
  read(
    @Req() request: AuthenticatedRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.vehicles.read(request.customerSession!.user.id, id);
  }

  @Patch(':id')
  @ApiHeader({ name: 'X-MFS-CSRF', required: true, description: 'Set to 1' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiBody({ type: UpdateVehicleDto })
  @ApiOkResponse({ type: VehicleDto })
  @ApiNotFoundResponse({
    description:
      'Vehicle missing or not owned by this customer; identical response',
  })
  @ApiOperation({
    summary:
      'Update your vehicle; omitted details stay unchanged, null clears optional details',
  })
  update(
    @Req() request: AuthenticatedRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new VehiclesValidationPipe(updateVehicleSchema))
    input: UpdateVehicleInput,
  ) {
    return this.vehicles.update(request.customerSession!.user.id, id, input);
  }

  @Delete(':id')
  @HttpCode(204)
  @ApiHeader({
    name: 'X-MFS-CSRF',
    required: true,
    description: 'Set to 1; no request body needed',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiNoContentResponse()
  @ApiNotFoundResponse({
    description:
      'Vehicle missing or not owned by this customer; identical response',
  })
  @ApiOperation({
    summary:
      'Permanently delete your garage vehicle and its ownership association',
  })
  delete(
    @Req() request: AuthenticatedRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.vehicles.delete(request.customerSession!.user.id, id);
  }
}
