export function databaseConnectionUrl(value: string): string {
  try {
    const url = new URL(value);
    if (url.hostname.endsWith('.neon.tech')) {
      // Keep certificate/hostname verification explicit across pg upgrades,
      // without editing or logging the ignored Neon credentials.
      url.searchParams.set('sslmode', 'verify-full');
    }
    return url.toString();
  } catch {
    throw new Error('Invalid PostgreSQL connection configuration');
  }
}
