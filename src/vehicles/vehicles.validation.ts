import { BadRequestException, type PipeTransform } from '@nestjs/common';
import { z } from 'zod';
import { VehicleCategoryCode } from '../generated/prisma/client';

const safeText = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .refine((value) => !/[\p{Cc}\p{Cf}]/u.test(value), 'Unsupported characters')
    .transform((value) => value.normalize('NFC'));

// Preserve the display value exactly, including spacing and letter case.
const registration = z
  .string()
  .min(1)
  .max(80)
  .refine(
    (value) => value.trim().length > 0 && !/[\p{Cc}\p{Cf}]/u.test(value),
    'Enter a nonblank registration without control characters',
  );

export function normalizeRegistration(value: string): string {
  return value.normalize('NFC').toUpperCase().replace(/\s+/gu, '');
}

export const createVehicleSchema = z.strictObject({
  category: z.enum(VehicleCategoryCode),
  name: safeText(80).pipe(z.string().max(80)).nullable().optional(),
  registrationNumber: registration.nullable().optional(),
  make: safeText(80).nullable().optional(),
  model: safeText(80).nullable().optional(),
  year: z.number().int().min(1000).max(9999).nullable().optional(),
  colour: safeText(80).nullable().optional(),
  chassisNumber: safeText(80).nullable().optional(),
  engineNumber: safeText(80).nullable().optional(),
  // Units and a closed usage-type vocabulary require business confirmation.
  engineCapacity: safeText(40).nullable().optional(),
  usageType: safeText(40).nullable().optional(),
  stateOfRegistration: safeText(80).nullable().optional(),
});

export const updateVehicleSchema = createVehicleSchema
  .partial()
  .refine(
    (value) => Object.keys(value).length > 0,
    'Provide at least one vehicle detail',
  );

const unsignedInteger = (max: number) =>
  z.string().regex(/^\d+$/).transform(Number).pipe(z.number().int().max(max));

export const listVehiclesSchema = z.strictObject({
  limit: unsignedInteger(100).pipe(z.number().min(1)).optional().default(20),
  offset: unsignedInteger(100000).optional().default(0),
  registrationNumber: registration.transform(normalizeRegistration).optional(),
});

export type CreateVehicleInput = z.infer<typeof createVehicleSchema>;
export type UpdateVehicleInput = z.infer<typeof updateVehicleSchema>;
export type ListVehiclesInput = z.infer<typeof listVehiclesSchema>;

const inputFields = new Set([
  ...Object.keys(createVehicleSchema.shape),
  'limit',
  'offset',
]);

export class VehiclesValidationPipe<T> implements PipeTransform<unknown, T> {
  constructor(private readonly schema: z.ZodType<T>) {}

  transform(value: unknown): T {
    const result = this.schema.safeParse(value);
    if (!result.success) {
      throw new BadRequestException({
        message: 'Invalid request',
        errors: result.error.issues.map((issue) => ({
          field: inputFields.has(String(issue.path[0]))
            ? String(issue.path[0])
            : 'body',
          message:
            issue.code === 'unrecognized_keys'
              ? 'Unknown fields are not allowed'
              : 'Invalid value',
        })),
      });
    }
    return result.data;
  }
}
