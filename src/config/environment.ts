import { z } from 'zod';

const originList = z.string().transform((value, context) => {
  const origins = value.split(',').map((origin) => origin.trim());
  if (
    origins.length === 0 ||
    origins.some((origin) => {
      try {
        const url = new URL(origin);
        return (
          !['http:', 'https:'].includes(url.protocol) ||
          url.origin !== origin ||
          Boolean(url.username || url.password)
        );
      } catch {
        return true;
      }
    })
  ) {
    context.addIssue({
      code: 'custom',
      message: 'Use exact HTTP(S) origins without paths or wildcards',
    });
    return z.NEVER;
  }
  return [...new Set(origins)];
});

const environmentSchema = z
  .object({
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
    AUTH_ALLOWED_ORIGINS: originList.prefault(
      'http://localhost:3000,http://127.0.0.1:3000,http://localhost:3001,http://127.0.0.1:3001',
    ),
    SESSION_COOKIE_SECURE: z
      .enum(['true', 'false'])
      .transform((value) => value === 'true'),
    SESSION_TTL_SECONDS: z.coerce
      .number()
      .int()
      .min(300)
      .max(2592000)
      .default(604800),
    SESSION_IDLE_TTL_SECONDS: z.coerce
      .number()
      .int()
      .min(60)
      .max(2592000)
      .default(86400),
    AUTH_RATE_LIMIT_NAMESPACE: z
      .string()
      .regex(/^[a-zA-Z0-9:_-]{1,80}$/)
      .default('customer-auth'),
    AUTH_RATE_WINDOW_SECONDS: z.coerce
      .number()
      .int()
      .min(60)
      .max(3600)
      .default(900),
    AUTH_LOGIN_IP_LIMIT: z.coerce.number().int().min(1).max(1000).default(30),
    AUTH_LOGIN_ACCOUNT_LIMIT: z.coerce
      .number()
      .int()
      .min(1)
      .max(100)
      .default(10),
    AUTH_REGISTER_IP_LIMIT: z.coerce.number().int().min(1).max(100).default(10),
    AUTH_REGISTER_ACCOUNT_LIMIT: z.coerce
      .number()
      .int()
      .min(1)
      .max(20)
      .default(3),
    TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(0),
  })
  .superRefine((value, context) => {
    if (value.SESSION_IDLE_TTL_SECONDS > value.SESSION_TTL_SECONDS) {
      context.addIssue({
        code: 'custom',
        path: ['SESSION_IDLE_TTL_SECONDS'],
        message: 'Must not exceed the absolute session lifetime',
      });
    }
    if (
      (value.NODE_ENV === 'production' || value.SESSION_COOKIE_SECURE) &&
      value.AUTH_ALLOWED_ORIGINS.some(
        (origin) => !origin.startsWith('https://'),
      )
    ) {
      context.addIssue({
        code: 'custom',
        path: ['AUTH_ALLOWED_ORIGINS'],
        message: 'Secure browser origins must use HTTPS',
      });
    }
    if (value.NODE_ENV === 'production' && !value.SESSION_COOKIE_SECURE) {
      context.addIssue({
        code: 'custom',
        path: ['SESSION_COOKIE_SECURE'],
        message: 'Production cookies must be Secure',
      });
    }
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
    SESSION_COOKIE_SECURE:
      config.SESSION_COOKIE_SECURE ??
      (config.NODE_ENV === 'production' ? 'true' : 'false'),
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
