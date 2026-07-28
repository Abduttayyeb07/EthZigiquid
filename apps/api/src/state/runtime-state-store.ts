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

export class RuntimeStateStore {
  private readonly pool: pg.Pool;
  private readonly key: Buffer;

  constructor(databaseUrl: string, encryptionKeyHex: string) {
    this.pool = new pg.Pool({ connectionString: databaseUrl, max: 3 });
    this.key = Buffer.from(encryptionKeyHex, "hex");
  }

  async initialize(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS automation_runtime (
        id TEXT PRIMARY KEY,
        encrypted_payload TEXT NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
  }

  async load(): Promise<PersistedRuntimeState | null> {
    const result = await this.pool.query<{ encrypted_payload: string }>(
      "SELECT encrypted_payload FROM automation_runtime WHERE id = $1",
      ["primary"],
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
      ["primary", payload],
    );
  }

  async clear(): Promise<void> {
    await this.pool.query("DELETE FROM automation_runtime WHERE id = $1", ["primary"]);
  }

  async close(): Promise<void> {
    await this.pool.end();
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
