import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { Prisma, VehicleCategoryCode } from '../generated/prisma/client';

export const PUBLIC_VEHICLE_SELECT = {
  id: true,
  name: true,
  category: true,
  registrationNumber: true,
  registrationNumberNormalized: true,
  make: true,
  model: true,
  year: true,
  colour: true,
  chassisNumber: true,
  engineNumber: true,
  engineCapacity: true,
  usageType: true,
  stateOfRegistration: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.VehicleSelect;

export class CreateVehicleDto {
  @ApiProperty({ enum: VehicleCategoryCode, enumName: 'VehicleCategoryCode' })
  category!: VehicleCategoryCode;
  @ApiPropertyOptional({
    type: String,
    maxLength: 80,
    nullable: true,
    description: 'Optional customer label, for example Family car or Work van',
  })
  name?: string | null;
  @ApiPropertyOptional({
    type: String,
    maxLength: 80,
    nullable: true,
    description:
      'Display value preserved exactly as entered; may be omitted before registration',
  })
  registrationNumber?: string | null;
  @ApiPropertyOptional({ type: String, maxLength: 80, nullable: true }) make?:
    string | null;
  @ApiPropertyOptional({ type: String, maxLength: 80, nullable: true }) model?:
    string | null;
  @ApiPropertyOptional({
    type: Number,
    minimum: 1000,
    maximum: 9999,
    nullable: true,
  })
  year?: number | null;
  @ApiPropertyOptional({ type: String, maxLength: 80, nullable: true })
  colour?: string | null;
  @ApiPropertyOptional({ type: String, maxLength: 80, nullable: true })
  chassisNumber?: string | null;
  @ApiPropertyOptional({ type: String, maxLength: 80, nullable: true })
  engineNumber?: string | null;
  @ApiPropertyOptional({
    type: String,
    maxLength: 40,
    nullable: true,
    description:
      'Capacity including its unit, for example 2.5 L; no unit conversion',
  })
  engineCapacity?: string | null;
  @ApiPropertyOptional({
    type: String,
    maxLength: 40,
    nullable: true,
    description:
      'Usage description, for example PRIVATE or COMMERCIAL; no closed vocabulary yet',
  })
  usageType?: string | null;
  @ApiPropertyOptional({ type: String, maxLength: 80, nullable: true })
  stateOfRegistration?: string | null;
}

export class UpdateVehicleDto extends PartialType(CreateVehicleDto) {}

export class VehicleDto extends CreateVehicleDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'Uppercase NFC registration without whitespace; punctuation is retained',
  })
  registrationNumberNormalized!: string | null;
  @ApiProperty({ type: String, format: 'date-time' }) createdAt!: Date;
  @ApiProperty({ type: String, format: 'date-time' }) updatedAt!: Date;
}

export class VehicleListDto {
  @ApiProperty({ type: [VehicleDto] }) items!: VehicleDto[];
  @ApiProperty() total!: number;
  @ApiProperty() limit!: number;
  @ApiProperty() offset!: number;
}
