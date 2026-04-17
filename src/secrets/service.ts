import { randomUUID } from 'node:crypto';
import type { OrchestratorDB } from '../db/database.js';
import { encrypt, decrypt } from './crypto.js';

export interface SecretRecord {
  id: string;
  name: string;
  description: string | null;
  created_at: string;
  updated_at: string;
  last_used_at: string | null;
}

export interface SecretsService {
  list(): SecretRecord[];
  /** Get all decrypted secrets as an object keyed by name. Used by child processes. */
  getAll(): Record<string, string>;
  /** Get a single decrypted secret by name. Updates last_used_at. Throws if not found. */
  getValue(name: string): string;
  create(name: string, value: string, description?: string): SecretRecord;
  update(name: string, value: string, description?: string): SecretRecord;
  delete(name: string): boolean;
}

// ---------------------------------------------------------------------------
// Module-level accessor — so the stage executor and trigger lifecycle can read
// secrets without threading the service through every call site.
// ---------------------------------------------------------------------------

let _service: SecretsService | null = null;

/** Register the secrets service so the runtime can read snapshots. Called once at boot. */
export function setSecretsService(svc: SecretsService): void {
  _service = svc;
}

/** Read a fresh snapshot of all decrypted secrets. Returns {} if no service is registered. */
export function getSecretsSnapshot(): Record<string, string> {
  return _service?.getAll() ?? {};
}

export function createSecretsService(db: OrchestratorDB, masterKey: Buffer): SecretsService {
  return {
    list() {
      return db.listSecrets();
    },
    getAll() {
      const result: Record<string, string> = {};
      for (const row of db.listSecretsWithValues()) {
        try {
          result[row.name] = decrypt(row.value_encrypted, masterKey);
        } catch (err) {
          console.error(`[secrets] Failed to decrypt ${row.name}:`, err);
        }
      }
      return result;
    },
    getValue(name) {
      const row = db.getSecretWithValue(name);
      if (!row) throw new Error(`Secret "${name}" not found`);
      db.touchSecretLastUsed(name);
      return decrypt(row.value_encrypted, masterKey);
    },
    create(name, value, description) {
      if (!/^[A-Z][A-Z0-9_]*$/.test(name)) {
        throw new Error(`Invalid secret name "${name}". Must match /^[A-Z][A-Z0-9_]*$/`);
      }
      const encrypted = encrypt(value, masterKey);
      return db.createSecret({ id: randomUUID(), name, value_encrypted: encrypted, description: description ?? null });
    },
    update(name, value, description) {
      const encrypted = encrypt(value, masterKey);
      return db.updateSecret(name, { value_encrypted: encrypted, description: description ?? null });
    },
    delete(name) {
      return db.deleteSecret(name);
    },
  };
}
