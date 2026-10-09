import { ApiProperty } from '@nestjs/swagger';
import { VehicleCategoryCode } from '../generated/prisma/client';

export class CatalogueVehicleCategoryDto {
  @ApiProperty({ enum: VehicleCategoryCode, enumName: 'VehicleCategoryCode' })
  code!: VehicleCategoryCode;

  @ApiProperty() name!: string;
}

export class ServiceVariantDto {
  @ApiProperty() code!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ type: String, nullable: true }) description!: string | null;
}

export class ServiceDto {
  @ApiProperty() code!: string;
  @ApiProperty() name!: string;
  @ApiProperty() slug!: string;
  @ApiProperty({ type: String, nullable: true }) description!: string | null;
  @ApiProperty({ type: [CatalogueVehicleCategoryDto] })
  vehicleCategories!: CatalogueVehicleCategoryDto[];
  @ApiProperty({ type: [ServiceVariantDto] })
  variants!: ServiceVariantDto[];
}

export class ServiceListDto {
  @ApiProperty({ type: [ServiceDto] }) items!: ServiceDto[];
}
