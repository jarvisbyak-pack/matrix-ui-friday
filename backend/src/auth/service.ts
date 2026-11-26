import { createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { config, parseEmailSet } from "../config.js";
import { pool } from "../db/pool.js";

export type AuthenticatedUser = {
  id: string;
  email: string;
  emailVerified?: boolean;
};

type UserRow = {
  id: string;
  email: string;
  password_hash: string;
  email_verified?: boolean;
  created_at: Date;
};

const DUMMY_PASSWORD_HASH = "scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

function scryptAsync(
  password: string,
  salt: Buffer,
  keylen: number,
  options: { N: number; r: number; p: number }
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, keylen, options, (error, derivedKey) => {
      if (error) reject(error);
      else resolve(derivedKey);
    });
  });
}

async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = await scryptAsync(password, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$16384$8$1$${salt.toString("base64url")}$${derived.toString("base64url")}`;
}

async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const [algorithm, n, r, p, saltEncoded, hashEncoded] = encoded.split("$");
  if (algorithm !== "scrypt" || !n || !r || !p || !saltEncoded || !hashEncoded) return false;
  const expected = Buffer.from(hashEncoded, "base64url");
  const actual = await scryptAsync(password, Buffer.from(saltEncoded, "base64url"), expected.length, {
    N: Number(n),
    r: Number(r),
    p: Number(p)
  });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export class AuthPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthPolicyError";
  }
}

export function isEmailPermittedForSignup(email: string): boolean {
  const normalized = email.trim().toLowerCase();
  const allowed = parseEmailSet(config.ALLOWED_USER_EMAILS);
  const owners = parseEmailSet(config.OWNER_EMAILS);
  if (owners.has(normalized)) return true;
  if (allowed.size > 0) return allowed.has(normalized);
  return config.ALLOW_PUBLIC_REGISTRATION;
}

export class AuthService {
  async createUnusablePasswordHash(): Promise<string> {
    return hashPassword(randomBytes(48).toString("base64url"));
  }

  async register(email: string, password: string): Promise<AuthenticatedUser> {
    const normalizedEmail = email.trim().toLowerCase();
    if (!isEmailPermittedForSignup(normalizedEmail)) {
      throw new AuthPolicyError("Registration is restricted on this Friday deployment.");
    }
    if (password.length < 8) throw new Error("Password must be at least 8 characters.");

    const passwordHash = await hashPassword(password);
    const { rows } = await pool.query<UserRow>(
      `INSERT INTO users (email, password_hash, email_verified)
       VALUES ($1, $2, FALSE)
       RETURNING id, email, password_hash, email_verified, created_at`,
      [normalizedEmail, passwordHash]
    );
    return { id: rows[0]!.id, email: rows[0]!.email, emailVerified: Boolean(rows[0]!.email_verified) };
  }

  async login(email: string, password: string): Promise<{ token: string; user: AuthenticatedUser }> {
    const normalizedEmail = email.trim().toLowerCase();
    const { rows } = await pool.query<UserRow>(
      `SELECT id, email, password_hash, email_verified, created_at FROM users WHERE email = $1`,
      [normalizedEmail]
    );
    const user = rows[0];
    const hashToCheck = user ? user.password_hash : DUMMY_PASSWORD_HASH;
    const verified = await verifyPassword(password, hashToCheck);
    if (!user || !verified) {
      throw new Error("Invalid email or password.");
    }

    const token = randomBytes(32).toString("base64url");
    await pool.query(
      `INSERT INTO sessions (user_id, token_hash, expires_at)
       VALUES ($1, $2, NOW() + ($3::int * INTERVAL '1 day'))`,
      [user.id, hashToken(token), config.AUTH_SESSION_DAYS]
    );

    return {
      token,
      user: { id: user.id, email: user.email, emailVerified: Boolean(user.email_verified) }
    };
  }

  async authenticate(token: string): Promise<AuthenticatedUser | undefined> {
    const { rows } = await pool.query<{ id: string; email: string; email_verified: boolean }>(
      `SELECT u.id, u.email, u.email_verified
       FROM sessions s
       JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = $1
         AND s.revoked_at IS NULL
         AND s.expires_at > NOW()`,
      [hashToken(token)]
    );
    const row = rows[0];
    return row ? { id: row.id, email: row.email, emailVerified: Boolean(row.email_verified) } : undefined;
  }

  async revoke(token: string): Promise<void> {
    await pool.query(
      `UPDATE sessions SET revoked_at = NOW()
       WHERE token_hash = $1 AND revoked_at IS NULL`,
      [hashToken(token)]
    );
  }

  async cleanupExpired(): Promise<void> {
    await Promise.all([
      pool.query("DELETE FROM sessions WHERE expires_at <= NOW() OR (revoked_at IS NOT NULL AND revoked_at < NOW() - INTERVAL '7 days')"),
      pool.query("DELETE FROM oauth_states WHERE expires_at <= NOW()"),
      pool.query("DELETE FROM oauth_codes WHERE expires_at <= NOW() OR consumed_at < NOW() - INTERVAL '1 day'")
    ]);
  }
}
