import { Injectable } from '@nestjs/common';
import type { RegisterInput } from '../auth/auth.validation';
import { PrismaService } from '../prisma/prisma.service';
import { PUBLIC_USER_SELECT } from './user.dto';

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

  createCustomer(input: RegisterInput, passwordHash: string) {
    return this.prisma.user.create({
      data: {
        firstName: input.firstName,
        lastName: input.lastName,
        email: input.email,
        phone: input.phone,
        passwordHash,
        kind: 'CUSTOMER',
        status: 'ACTIVE',
      },
      select: { id: true },
    });
  }

  findCredentials(email: string) {
    return this.prisma.user.findUnique({
      where: { email },
      select: { id: true, passwordHash: true, status: true, kind: true },
    });
  }

  getPublicUser(id: string) {
    return this.prisma.user.findUniqueOrThrow({
      where: { id },
      select: PUBLIC_USER_SELECT,
    });
  }
}
