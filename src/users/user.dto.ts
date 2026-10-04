import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Prisma } from '../generated/prisma/client';

export const PUBLIC_USER_SELECT = {
  id: true,
  firstName: true,
  lastName: true,
  email: true,
  phone: true,
  emailVerifiedAt: true,
  phoneVerifiedAt: true,
  status: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.UserSelect;

export type PublicUser = Prisma.UserGetPayload<{
  select: typeof PUBLIC_USER_SELECT;
}>;

export class UserDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() firstName!: string;
  @ApiProperty() lastName!: string;
  @ApiProperty({ format: 'email' }) email!: string;
  @ApiProperty({ description: 'E.164 phone number' }) phone!: string;
  @ApiPropertyOptional({ type: String, format: 'date-time', nullable: true })
  emailVerifiedAt!: Date | null;
  @ApiPropertyOptional({ type: String, format: 'date-time', nullable: true })
  phoneVerifiedAt!: Date | null;
  @ApiProperty({ enum: ['ACTIVE', 'DISABLED'] }) status!: string;
  @ApiProperty({ type: String, format: 'date-time' }) createdAt!: Date;
  @ApiProperty({ type: String, format: 'date-time' }) updatedAt!: Date;
}
