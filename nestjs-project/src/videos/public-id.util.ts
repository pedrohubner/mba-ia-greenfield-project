import { randomBytes } from 'crypto';

const PUBLIC_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;

export function generatePublicId(): string {
  return randomBytes(8).toString('base64url');
}

export function isValidPublicId(value: string): boolean {
  return PUBLIC_ID_PATTERN.test(value);
}
