import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';

const PUBLIC_SERVICE_SELECT = {
  code: true,
  name: true,
  slug: true,
  description: true,
  variants: {
    where: { active: true },
    orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
    select: { code: true, name: true, description: true },
  },
  applicableCategories: {
    orderBy: { categoryCode: 'asc' },
    select: {
      category: { select: { code: true, name: true } },
    },
  },
} satisfies Prisma.ServiceSelect;

type SelectedService = Prisma.ServiceGetPayload<{
  select: typeof PUBLIC_SERVICE_SELECT;
}>;

function publicService(service: SelectedService) {
  const { applicableCategories, ...catalogueService } = service;
  return {
    ...catalogueService,
    vehicleCategories: applicableCategories.map(({ category }) => category),
  };
}

@Injectable()
export class ServicesService {
  constructor(private readonly prisma: PrismaService) {}

  async list() {
    const services = await this.prisma.service.findMany({
      where: { active: true },
      orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
      select: PUBLIC_SERVICE_SELECT,
    });
    return { items: services.map(publicService) };
  }

  async read(slug: string) {
    if (slug.length > 120 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug))
      throw new NotFoundException('Service not found');

    const service = await this.prisma.service.findFirst({
      where: { slug, active: true },
      select: PUBLIC_SERVICE_SELECT,
    });
    if (!service) throw new NotFoundException('Service not found');
    return publicService(service);
  }
}
