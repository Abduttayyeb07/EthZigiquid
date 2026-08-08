import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import pg from "pg";
import type { AutomationSettings, BotStatistics } from "@zig/shared";

export interface PersistedRuntimeState {
  settings: AutomationSettings;
  stats: BotStatistics;
  walletPrivateKey: string | null;
  pendingSellAmountRaw: string | null;
  shouldResume: boolean;
}

/**
 * Creates the runtime table once for the whole process. Every operator session
 * shares one connection pool, so schema setup must not run per session.
 */
export async function initializeRuntimeStateSchema(pool: pg.Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS automation_runtime (
      id TEXT PRIMARY KEY,
      encrypted_payload TEXT NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
}

export class RuntimeStateStore {
  private readonly key: Buffer;

  /**
   * The pool is owned by the caller and shared across every operator session.
   * One pool per session exhausts PostgreSQL connections as sessions grow.
   */
  constructor(
    private readonly pool: pg.Pool,
    encryptionKeyHex: string,
    private readonly runtimeId = "primary",
  ) {
    this.key = Buffer.from(encryptionKeyHex, "hex");
  }

  async load(): Promise<PersistedRuntimeState | null> {
    const result = await this.pool.query<{ encrypted_payload: string }>(
      "SELECT encrypted_payload FROM automation_runtime WHERE id = $1",
      [this.runtimeId],
    );
    const payload = result.rows[0]?.encrypted_payload;
    return payload ? this.decrypt(payload) : null;
  }

  async save(state: PersistedRuntimeState): Promise<void> {
    const payload = this.encrypt(state);
    await this.pool.query(
      `INSERT INTO automation_runtime (id, encrypted_payload, updated_at)
       VALUES ($1, $2, now())
       ON CONFLICT (id) DO UPDATE SET encrypted_payload = EXCLUDED.encrypted_payload, updated_at = now()`,
      [this.runtimeId, payload],
    );
  }

  async clear(): Promise<void> {
    await this.pool.query("DELETE FROM automation_runtime WHERE id = $1", [this.runtimeId]);
  }

  async listIds(prefix: string): Promise<string[]> {
    const result = await this.pool.query<{ id: string }>(
      "SELECT id FROM automation_runtime WHERE id LIKE $1 ORDER BY updated_at DESC",
      [`${prefix}%`],
    );
    return result.rows.map((row) => row.id);
  }

  private encrypt(state: PersistedRuntimeState): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(state), "utf8"), cipher.final()]);
    return [iv, cipher.getAuthTag(), ciphertext].map((value) => value.toString("base64url")).join(".");
  }

  private decrypt(payload: string): PersistedRuntimeState {
    const [ivValue, tagValue, ciphertextValue] = payload.split(".");
    if (!ivValue || !tagValue || !ciphertextValue) throw new Error("Persisted runtime state is malformed.");
    const decipher = createDecipheriv("aes-256-gcm", this.key, Buffer.from(ivValue, "base64url"));
    decipher.setAuthTag(Buffer.from(tagValue, "base64url"));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(ciphertextValue, "base64url")),
      decipher.final(),
    ]);
    return JSON.parse(plaintext.toString("utf8")) as PersistedRuntimeState;
  }
}
