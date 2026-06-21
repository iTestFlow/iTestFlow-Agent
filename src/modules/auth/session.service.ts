import "server-only";

import { cookies } from "next/headers";
import { createHash, randomBytes } from "crypto";
import { createId, nowIso, sqlGet, sqlRun } from "@/modules/shared/infrastructure/database/db";
import { SESSION_COOKIE } from "./session-cookie";

export { SESSION_COOKIE };

/**
 * Server-side, stateful sessions (ADR-4). The cookie carries only an opaque,
 * unguessable token; the database stores its SHA-256 hash, never the raw value,
 * so a database leak cannot be replayed as a session. SESSION_SECRET is reserved
 * for optional cookie HMAC hardening and is not required for this model.
 *
 * Cookie I/O (which needs a request scope) is kept separate from the DB-only
 * helpers so the persistence/resolution logic is unit-testable.
 */

const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 7; // 7 days

export type SessionUser = {
  sessionId: string;
  userId: string;
};

export class SessionError extends Error {
  constructor(message = "Authentication required.") {
    super(message);
    this.name = "SessionError";
  }
}

type SessionRow = {
  id: string;
  user_id: string;
  expires_at: string;
  revoked_at: string | null;
};

function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * DB-only: create a session row for `userId` and return the raw token (shown to
 * the client once, via the cookie) plus the session id. The raw token is never
 * persisted — only its hash.
 */
export async function persistSession(input: {
  userId: string;
  ip?: string | null;
  userAgent?: string | null;
  ttlMs?: number;
}): Promise<{ sessionId: string; token: string; expiresAt: string }> {
  const token = randomBytes(32).toString("base64url");
  const sessionId = createId("sess");
  const now = nowIso();
  const expiresAt = new Date(Date.now() + (input.ttlMs ?? SESSION_TTL_MS)).toISOString();

  await sqlRun(
    `INSERT INTO sessions (id, user_id, hashed_token, ip, user_agent, created_at, last_seen_at, expires_at)
     VALUES (@id, @userId, @hashedToken, @ip, @userAgent, @createdAt, @lastSeenAt, @expiresAt)`,
    {
      id: sessionId,
      userId: input.userId,
      hashedToken: hashToken(token),
      ip: input.ip ?? null,
      userAgent: input.userAgent ?? null,
      createdAt: now,
      lastSeenAt: now,
      expiresAt,
    },
  );

  return { sessionId, token, expiresAt };
}

/** DB-only: resolve a raw token to an active (non-revoked, non-expired) session. */
export async function resolveSessionToken(token: string): Promise<SessionUser | null> {
  if (!token) return null;
  const row = await sqlGet<SessionRow>(
    `SELECT id, user_id, expires_at, revoked_at FROM sessions WHERE hashed_token = @hashedToken LIMIT 1`,
    { hashedToken: hashToken(token) },
  );
  if (!row || row.revoked_at) return null;
  if (new Date(row.expires_at).getTime() < Date.now()) return null;
  return { sessionId: row.id, userId: row.user_id };
}

/** DB-only: revoke a session by its raw token (idempotent). */
export async function revokeSessionToken(token: string): Promise<void> {
  if (!token) return;
  await sqlRun(`UPDATE sessions SET revoked_at = @now WHERE hashed_token = @hashedToken AND revoked_at IS NULL`, {
    now: nowIso(),
    hashedToken: hashToken(token),
  });
}

function sessionCookieOptions() {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    path: "/",
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
  };
}

/** Request-scoped: create a session and set the opaque session cookie. */
export async function createSession(input: { userId: string; ip?: string | null; userAgent?: string | null }) {
  const { sessionId, token } = await persistSession(input);
  const store = await cookies();
  store.set(SESSION_COOKIE, token, sessionCookieOptions());
  return { sessionId };
}

/** Request-scoped: resolve the current session from the cookie, or null. */
export async function getOptionalSession(): Promise<SessionUser | null> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (!token) return null;
  return resolveSessionToken(token);
}

/** Request-scoped: resolve the current session or throw {@link SessionError}. */
export async function requireSession(): Promise<SessionUser> {
  const session = await getOptionalSession();
  if (!session) throw new SessionError();
  return session;
}

/** Request-scoped: revoke the current session and clear the cookie. */
export async function destroySession(): Promise<void> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (token) await revokeSessionToken(token);
  store.delete(SESSION_COOKIE);
}
