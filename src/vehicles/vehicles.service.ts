import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { PUBLIC_VEHICLE_SELECT } from './vehicles.dto';
import {
  normalizeRegistration,
  type CreateVehicleInput,
  type UpdateVehicleInput,
  type ListVehiclesInput,
} from './vehicles.validation';

function vehicleData(input: CreateVehicleInput | UpdateVehicleInput) {
  return {
    ...input,
    ...(input.registrationNumber !== undefined
      ? {
          registrationNumberNormalized:
            input.registrationNumber === null
              ? null
              : normalizeRegistration(input.registrationNumber),
        }
      : {}),
  };
}

function missingVehicle(error: unknown): never {
  if (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === 'P2025'
  )
    throw new NotFoundException('Vehicle not found');
  throw error;
}

@Injectable()
export class VehiclesService {
  constructor(private readonly prisma: PrismaService) {}

  create(userId: string, input: CreateVehicleInput) {
    return this.prisma.vehicle.create({
      data: {
        ...vehicleData(input),
        category: input.category,
        ownership: { create: { user: { connect: { id: userId } } } },
      },
      select: PUBLIC_VEHICLE_SELECT,
    });
  }

  async list(userId: string, query: ListVehiclesInput) {
    const where: Prisma.VehicleWhereInput = {
      ownership: { userId },
      ...(query.registrationNumber !== undefined
        ? { registrationNumberNormalized: query.registrationNumber }
        : {}),
    };
    return this.prisma.$transaction(async (transaction) => {
      const items = await transaction.vehicle.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: query.offset,
        take: query.limit,
        select: PUBLIC_VEHICLE_SELECT,
      });
      const total = await transaction.vehicle.count({ where });
      return { items, total, limit: query.limit, offset: query.offset };
    });
  }

  async read(userId: string, id: string) {
    const vehicle = await this.prisma.vehicle.findFirst({
      where: { id, ownership: { userId } },
      select: PUBLIC_VEHICLE_SELECT,
    });
    if (!vehicle) throw new NotFoundException('Vehicle not found');
    return vehicle;
  }

  async update(userId: string, id: string, input: UpdateVehicleInput) {
    try {
      // Ownership is part of the write, not a separate preflight check.
      return await this.prisma.vehicle.update({
        where: { id, ownership: { userId } },
        data: vehicleData(input),
        select: PUBLIC_VEHICLE_SELECT,
      });
    } catch (error) {
      missingVehicle(error);
    }
  }

  async delete(userId: string, id: string): Promise<void> {
    try {
      await this.prisma.vehicle.delete({
        where: { id, ownership: { userId } },
        select: { id: true },
      });
    } catch (error) {
      missingVehicle(error);
    }
  }
}
