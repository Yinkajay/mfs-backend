import { ApiProperty } from '@nestjs/swagger';

export class RegisterDto {
  @ApiProperty({ maxLength: 80 }) firstName!: string;
  @ApiProperty({ maxLength: 80 }) lastName!: string;
  @ApiProperty({ format: 'email', maxLength: 254 }) email!: string;
  @ApiProperty({
    description: 'International number or Nigerian national format',
    maxLength: 40,
  })
  phone!: string;
  @ApiProperty({ minLength: 8, maxLength: 128, writeOnly: true })
  password!: string;
}

export class LoginDto {
  @ApiProperty({ format: 'email' }) email!: string;
  @ApiProperty({ maxLength: 128, writeOnly: true }) password!: string;
}

export class RegistrationResponse {
  @ApiProperty({
    example: 'Registration request received. You can now try signing in.',
  })
  message!: string;
}
