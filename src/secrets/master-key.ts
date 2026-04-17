import { existsSync, readFileSync, writeFileSync, chmodSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';

/**
 * Resolve the master key with this priority:
 * 1. AUTOME_MASTER_KEY env var (hex or base64, 32 bytes)
 * 2. <dataDir>/.master-key file contents (hex)
 * 3. Generate random 32 bytes, save to .master-key with 0600 perms
 *
 * Returns a 32-byte Buffer.
 * Also returns a flag indicating if the key was loaded from disk (so doctor can warn).
 */
export function resolveMasterKey(dataDir: string): { key: Buffer; source: 'env' | 'file' | 'generated' } {
  const envVal = process.env.AUTOME_MASTER_KEY;
  if (envVal) {
    const buf = envVal.length === 64 ? Buffer.from(envVal, 'hex') : Buffer.from(envVal, 'base64');
    if (buf.length !== 32) throw new Error('AUTOME_MASTER_KEY must be 32 bytes (64 hex chars or 44 base64 chars)');
    return { key: buf, source: 'env' };
  }

  const keyPath = join(dataDir, '.master-key');
  if (existsSync(keyPath)) {
    const hex = readFileSync(keyPath, 'utf-8').trim();
    const buf = Buffer.from(hex, 'hex');
    if (buf.length !== 32) throw new Error(`Master key file at ${keyPath} is corrupt`);
    return { key: buf, source: 'file' };
  }

  // Generate
  const buf = randomBytes(32);
  mkdirSync(dirname(keyPath), { recursive: true });
  writeFileSync(keyPath, buf.toString('hex'), { mode: 0o600 });
  try { chmodSync(keyPath, 0o600); } catch {}
  console.warn(`[secrets] Generated master key at ${keyPath} — move to AUTOME_MASTER_KEY env var for production.`);
  return { key: buf, source: 'generated' };
}
