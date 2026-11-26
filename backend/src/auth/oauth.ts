import { createHash, randomBytes } from "node:crypto";
import { pool } from "../db/pool.js";
import { config } from "../config.js";
import { AuthPolicyError, AuthService, isEmailPermittedForSignup, type AuthenticatedUser } from "./service.js";

export type OAuthProvider = "google" | "github";
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const random = () => randomBytes(32).toString("base64url");

export class OAuthService {
  constructor(private readonly auth = new AuthService()) {}

  isConfigured(provider: OAuthProvider): boolean {
    return provider === "google"
      ? Boolean(config.GOOGLE_CLIENT_ID && config.GOOGLE_CLIENT_SECRET && config.GOOGLE_REDIRECT_URI)
      : Boolean(config.GITHUB_OAUTH_CLIENT_ID && config.GITHUB_OAUTH_CLIENT_SECRET && config.GITHUB_OAUTH_REDIRECT_URI);
  }

  redirectUri(provider: OAuthProvider): string {
    return provider === "google" ? config.GOOGLE_REDIRECT_URI! : config.GITHUB_OAUTH_REDIRECT_URI!;
  }

  async createState(provider: OAuthProvider, frontendRedirectUri?: string): Promise<string> {
    const state = random();
    const target = frontendRedirectUri ?? config.OAUTH_FRONTEND_ORIGIN;
    await pool.query(
      "INSERT INTO oauth_states (state_hash, provider, redirect_uri, expires_at) VALUES ($1, $2, $3, NOW() + INTERVAL '10 minutes')",
      [hash(state), provider, target]
    );
    return state;
  }

  async consumeState(provider: OAuthProvider, state: string): Promise<string> {
    const result = await pool.query<{ redirect_uri: string }>(
      "DELETE FROM oauth_states WHERE state_hash = $1 AND provider = $2 AND expires_at > NOW() RETURNING redirect_uri",
      [hash(state), provider]
    );
    const row = result.rows[0];
    if (!row) throw new Error("Invalid or expired OAuth state.");
    return row.redirect_uri;
  }

  async signInWithIdentity(provider: OAuthProvider, subject: string, email: string): Promise<string> {
    const normalizedEmail = email.trim().toLowerCase();
    if (!normalizedEmail) throw new Error("OAuth provider did not return an email address.");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const existing = await client.query<{ user_id: string }>(
        "SELECT user_id FROM user_auth_identities WHERE provider = $1 AND provider_subject = $2",
        [provider, subject]
      );
      let userId = existing.rows[0]?.user_id;
      if (!userId) {
        const byEmail = await client.query<{ id: string; email_verified: boolean }>(
          "SELECT id, email_verified FROM users WHERE email = $1",
          [normalizedEmail]
        );
        const existingUser = byEmail.rows[0];
        if (existingUser) {
          if (!existingUser.email_verified) {
            throw new AuthPolicyError("An unverified password account already exists for this email. Sign in with your password instead.");
          }
          const linkedSameProvider = await client.query<{ id: string }>(
            "SELECT id FROM user_auth_identities WHERE user_id = $1 AND provider = $2",
            [existingUser.id, provider]
          );
          if (linkedSameProvider.rowCount && linkedSameProvider.rowCount > 0) {
            throw new AuthPolicyError(`A different ${provider} account is already linked to this user.`);
          }
          userId = existingUser.id;
        } else {
          if (!isEmailPermittedForSignup(normalizedEmail)) {
            throw new AuthPolicyError("Registration is restricted on this Friday deployment.");
          }
          const unusableHash = await this.auth.createUnusablePasswordHash();
          const created = await client.query<{ id: string }>(
            "INSERT INTO users (email, password_hash, email_verified) VALUES ($1, $2, TRUE) RETURNING id",
            [normalizedEmail, unusableHash]
          );
          userId = created.rows[0]!.id;
        }
      }
      await client.query(
        `INSERT INTO user_auth_identities (user_id, provider, provider_subject, provider_email)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (provider, provider_subject) DO UPDATE
           SET provider_email = EXCLUDED.provider_email, updated_at = NOW()`,
        [userId, provider, subject, normalizedEmail]
      );
      await client.query("COMMIT");
      return userId;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async createExchangeCode(userId: string): Promise<string> {
    const code = random();
    await pool.query(
      "INSERT INTO oauth_codes (code_hash, user_id, expires_at) VALUES ($1, $2, NOW() + INTERVAL '2 minutes')",
      [hash(code), userId]
    );
    return code;
  }

  async exchangeCode(code: string): Promise<{ token: string; user: AuthenticatedUser }> {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query<{ user_id: string }>(
        "UPDATE oauth_codes SET consumed_at = NOW() WHERE code_hash = $1 AND consumed_at IS NULL AND expires_at > NOW() RETURNING user_id",
        [hash(code)]
      );
      const row = result.rows[0];
      if (!row) throw new Error("Invalid or expired OAuth code.");
      const userResult = await client.query<{ id: string; email: string; email_verified: boolean }>(
        "SELECT id, email, email_verified FROM users WHERE id = $1",
        [row.user_id]
      );
      const user = userResult.rows[0];
      if (!user) throw new Error("OAuth account no longer exists.");
      const token = random();
      await client.query(
        "INSERT INTO sessions (user_id, token_hash, expires_at) VALUES ($1, $2, NOW() + ($3::int * INTERVAL '1 day'))",
        [user.id, hash(token), config.AUTH_SESSION_DAYS]
      );
      await client.query("COMMIT");
      return { token, user: { id: user.id, email: user.email, emailVerified: Boolean(user.email_verified) } };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}
