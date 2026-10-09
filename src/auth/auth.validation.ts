import { BadRequestException, type PipeTransform } from '@nestjs/common';
import { parsePhoneNumberFromString } from 'libphonenumber-js/max';
import { z } from 'zod';

const name = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .refine(
    (value) => !/[\p{Cc}\p{Cf}]/u.test(value),
    'Name contains unsupported characters',
  )
  .transform((value) => value.normalize('NFC').replace(/\s+/gu, ' '));

const email = z.string().trim().max(254).toLowerCase().pipe(z.email());
const password = z
  .string()
  .refine(
    (value) =>
      [...value].length <= 128 && Buffer.byteLength(value, 'utf8') <= 1024,
    'Password is too long',
  );

const phone = z
  .string()
  .trim()
  .min(5)
  .max(40)
  .transform((value, context) => {
    const parsed = parsePhoneNumberFromString(value, {
      defaultCountry: 'NG',
      extract: false,
    });
    if (!parsed?.isPossible() || parsed.ext) {
      context.addIssue({
        code: 'custom',
        message: 'Use a phone number with the correct number of digits',
      });
      return z.NEVER;
    }
    return parsed.number as string;
  });

export const registerSchema = z.strictObject({
  firstName: name,
  lastName: name,
  email,
  phone,
  password: password.refine(
    (value) => [...value].length >= 8,
    'Use at least 8 characters',
  ),
});

export const loginSchema = z.strictObject({
  email,
  password: password.refine(
    (value) => value.length > 0,
    'Password is required',
  ),
});
export type RegisterInput = z.infer<typeof registerSchema>;
export type LoginInput = z.infer<typeof loginSchema>;

export class AuthValidationPipe<T> implements PipeTransform<unknown, T> {
  constructor(private readonly schema: z.ZodType<T>) {}

  transform(value: unknown): T {
    const result = this.schema.safeParse(value);
    if (!result.success) {
      const fields = new Set([
        'firstName',
        'lastName',
        'email',
        'phone',
        'password',
      ]);
      throw new BadRequestException({
        message: 'Invalid request',
        errors: result.error.issues.map((issue) => ({
          field: fields.has(String(issue.path[0]))
            ? String(issue.path[0])
            : 'body',
          message:
            issue.code === 'unrecognized_keys'
              ? 'Unknown fields are not allowed'
              : issue.message,
        })),
      });
    }
    return result.data;
  }
}
