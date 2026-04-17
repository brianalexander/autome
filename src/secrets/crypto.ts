import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';

/**
 * Encrypt with AES-256-GCM.
 * Output format: iv(12) | ciphertext | authTag(16) — single Buffer.
 */
export function encrypt(plaintext: string, key: Buffer): Buffer {
  if (key.length !== 32) throw new Error('Master key must be 32 bytes');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf-8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, ct, tag]);
}

export function decrypt(blob: Buffer, key: Buffer): string {
  if (key.length !== 32) throw new Error('Master key must be 32 bytes');
  const iv = blob.subarray(0, 12);
  const tag = blob.subarray(blob.length - 16);
  const ct = blob.subarray(12, blob.length - 16);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf-8');
}
