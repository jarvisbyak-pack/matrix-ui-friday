import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { config } from "../config.js";
import { pool } from "../db/pool.js";

export const TOOL_KEYS = ["github", "web", "files", "sandbox", "firecrawl", "browser"] as const;
export type ToolKey = (typeof TOOL_KEYS)[number];

export type StoredCredentialMetadata = {
  id: string;
  userId: string;
  projectId?: string;
  toolKey: ToolKey;
  credentialType: string;
  encryptionKeyVersion: number;
  enabled: boolean;
  lastTestedAt?: string;
  createdAt: string;
  updatedAt: string;
};

type CredentialRow = {
  id: string;
  user_id: string;
  project_id: string | null;
  tool_key: ToolKey;
  credential_type: string;
  encrypted_secret: string;
  encryption_key_version: number;
  enabled: boolean;
  last_tested_at: Date | null;
  created_at: Date;
  updated_at: Date;
};

function toMetadata(row: CredentialRow): StoredCredentialMetadata {
  return {
    id: row.id,
    userId: row.user_id,
    ...(row.project_id === null ? {} : { projectId: row.project_id }),
    toolKey: row.tool_key,
    credentialType: row.credential_type,
    encryptionKeyVersion: row.encryption_key_version,
    enabled: row.enabled,
    ...(row.last_tested_at === null ? {} : { lastTestedAt: row.last_tested_at.toISOString() }),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString()
  };
}

export class CredentialService {
  constructor(private readonly secretKeyOverride?: string) {}

  private deriveKey(): Buffer {
    const raw = (this.secretKeyOverride !== undefined
      ? this.secretKeyOverride
      : (process.env.TOOL_ENCRYPTION_KEY ?? config.TOOL_ENCRYPTION_KEY ?? "")).trim();
    if (!raw) {
      throw new Error("TOOL_ENCRYPTION_KEY is not configured on the Friday backend.");
    }
    return createHash("sha256").update(raw, "utf8").digest();
  }

  encryptSecret(plaintext: string): string {
    if (!plaintext) {
      throw new Error("Credential secret must not be empty.");
    }
    const key = this.deriveKey();
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `v1:${iv.toString("base64url")}:${tag.toString("base64url")}:${encrypted.toString("base64url")}`;
  }

  decryptSecret(encoded: string): string {
    const [version, ivB64, tagB64, dataB64] = encoded.split(":");
    if (version !== "v1" || !ivB64 || !tagB64 || !dataB64) {
      throw new Error("Invalid encrypted credential format.");
    }
    const key = this.deriveKey();
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivB64, "base64url"));
    decipher.setAuthTag(Buffer.from(tagB64, "base64url"));
    const decrypted = Buffer.concat([
      decipher.update(Buffer.from(dataB64, "base64url")),
      decipher.final()
    ]);
    return decrypted.toString("utf8");
  }

  async save(input: {
    userId: string;
    projectId?: string;
    toolKey: ToolKey;
    credentialType: string;
    secret: string;
    enabled?: boolean;
  }): Promise<StoredCredentialMetadata> {
    const encrypted = this.encryptSecret(input.secret.trim());
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      // Replace any active credential for the same (user, project, tool_key, credential_type) scope.
      if (input.projectId) {
        await client.query(
          `DELETE FROM tool_credentials
           WHERE user_id = $1 AND project_id = $2 AND tool_key = $3 AND credential_type = $4`,
          [input.userId, input.projectId, input.toolKey, input.credentialType.trim()]
        );
      } else {
        await client.query(
          `DELETE FROM tool_credentials
           WHERE user_id = $1 AND project_id IS NULL AND tool_key = $2 AND credential_type = $3`,
          [input.userId, input.toolKey, input.credentialType.trim()]
        );
      }

      const { rows } = await client.query<CredentialRow>(
        `INSERT INTO tool_credentials
           (user_id, project_id, tool_key, credential_type, encrypted_secret, encryption_key_version, enabled)
         VALUES ($1, $2, $3, $4, $5, 1, $6)
         RETURNING id, user_id, project_id, tool_key, credential_type, encrypted_secret,
                   encryption_key_version, enabled, last_tested_at, created_at, updated_at`,
        [
          input.userId,
          input.projectId ?? null,
          input.toolKey,
          input.credentialType.trim(),
          encrypted,
          input.enabled ?? true
        ]
      );
      await client.query("COMMIT");
      return toMetadata(rows[0]!);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async list(userId: string, projectId?: string): Promise<StoredCredentialMetadata[]> {
    const { rows } = await pool.query<CredentialRow>(
      `SELECT id, user_id, project_id, tool_key, credential_type, encrypted_secret,
              encryption_key_version, enabled, last_tested_at, created_at, updated_at
       FROM tool_credentials
       WHERE user_id = $1 AND ($2::uuid IS NULL OR project_id = $2)
       ORDER BY updated_at DESC`,
      [userId, projectId ?? null]
    );
    return rows.map(toMetadata);
  }

  async remove(userId: string, id: string): Promise<boolean> {
    const result = await pool.query(
      "DELETE FROM tool_credentials WHERE id = $1 AND user_id = $2",
      [id, userId]
    );
    return (result.rowCount ?? 0) > 0;
  }

  async resolveSecret(userId: string, toolKey: ToolKey, projectId?: string): Promise<string | undefined> {
    if (projectId) {
      const projectResult = await pool.query<{ encrypted_secret: string }>(
        `SELECT tc.encrypted_secret
         FROM tool_credentials tc
         JOIN projects p ON p.id = tc.project_id
         LEFT JOIN project_members pm ON pm.project_id = p.id AND pm.user_id = $1
         WHERE tc.project_id = $2
           AND tc.tool_key = $3
           AND tc.enabled = TRUE
           AND (tc.user_id = $1 OR p.owner_user_id = $1 OR pm.role IN ('owner', 'admin', 'member'))
         ORDER BY (tc.user_id = $1) DESC, tc.updated_at DESC
         LIMIT 1`,
        [userId, projectId, toolKey]
      );
      const row = projectResult.rows[0];
      if (row) return this.decryptSecret(row.encrypted_secret);
    }

    const userResult = await pool.query<{ encrypted_secret: string }>(
      `SELECT encrypted_secret
       FROM tool_credentials
       WHERE user_id = $1 AND project_id IS NULL AND tool_key = $2 AND enabled = TRUE
       ORDER BY updated_at DESC
       LIMIT 1`,
      [userId, toolKey]
    );
    const row = userResult.rows[0];
    return row ? this.decryptSecret(row.encrypted_secret) : undefined;
  }
}
