import { z } from 'zod';

const environmentSchema = z.object({
  NODE_ENV: z
    .enum(['development', 'test', 'production'])
    .default('development'),
  HOST: z.string().trim().min(1).default('127.0.0.1'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3001),
  DATABASE_URL: z.string().refine(
    (value) => {
      try {
        const url = new URL(value);
        return (
          ['postgres:', 'postgresql:'].includes(url.protocol) &&
          url.hostname.length > 0 &&
          url.pathname.length > 1
        );
      } catch {
        return false;
      }
    },
    { message: 'Use a PostgreSQL URL with a host and database name' },
  ),
  SWAGGER_ENABLED: z
    .enum(['true', 'false'])
    .transform((value) => value === 'true'),
});

export type Environment = z.infer<typeof environmentSchema>;

export function validateEnvironment(
  config: Record<string, unknown>,
): Environment {
  const result = environmentSchema.safeParse({
    ...config,
    SWAGGER_ENABLED:
      config.SWAGGER_ENABLED ??
      (config.NODE_ENV === 'production' ? 'false' : 'true'),
  });

  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('; ');
    // Include field names and validation messages, never their supplied values.
    throw new Error(`Invalid backend environment: ${issues}`);
  }

  return result.data;
}
