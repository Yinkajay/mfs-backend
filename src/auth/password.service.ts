import { Injectable, HttpException, HttpStatus } from '@nestjs/common';
import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

// OWASP's scrypt profile. Node's stable crypto API avoids native addon builds.
const COST = 131072;
const BLOCK_SIZE = 8;
const PARALLELISM = 1;
const KEY_LENGTH = 64;
const SALT_LENGTH = 16;

@Injectable()
export class PasswordService {
  private activeDerivations = 0;
  private readonly dummyHash = this.hash(randomBytes(32).toString('base64url'));

  async hash(password: string): Promise<string> {
    const salt = randomBytes(SALT_LENGTH);
    const key = await this.derive(password, salt);
    return `$scrypt$${COST}$${BLOCK_SIZE}$${PARALLELISM}$${salt.toString('base64url')}$${key.toString('base64url')}`;
  }

  async verify(password: string, encoded: string | null): Promise<boolean> {
    const fallback = await this.dummyHash;
    const candidate = encoded ?? fallback;
    const parts = candidate.split('$');
    const validEncoding =
      parts.length === 7 &&
      parts[1] === 'scrypt' &&
      parts[2] === String(COST) &&
      parts[3] === String(BLOCK_SIZE) &&
      parts[4] === String(PARALLELISM) &&
      /^[A-Za-z0-9_-]{22}$/.test(parts[5]) &&
      /^[A-Za-z0-9_-]{86}$/.test(parts[6]);
    const effective = validEncoding ? parts : fallback.split('$');
    const actual = await this.derive(
      password,
      Buffer.from(effective[5], 'base64url'),
    );
    const expected = Buffer.from(effective[6], 'base64url');
    return (
      timingSafeEqual(actual, expected) && encoded !== null && validEncoding
    );
  }

  private async derive(password: string, salt: Buffer): Promise<Buffer> {
    // No unbounded queue of expensive password work under an attack.
    if (this.activeDerivations >= 2) {
      throw new HttpException(
        'Too many requests. Try again later.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    this.activeDerivations += 1;
    try {
      return await new Promise<Buffer>((resolve, reject) => {
        scrypt(
          password,
          salt,
          KEY_LENGTH,
          { N: COST, r: BLOCK_SIZE, p: PARALLELISM, maxmem: 160 * 1024 * 1024 },
          (error, key) => (error ? reject(error) : resolve(key)),
        );
      });
    } finally {
      this.activeDerivations -= 1;
    }
  }
}
