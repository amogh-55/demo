import "server-only";
import crypto from "node:crypto";
import { cookies } from "next/headers";
import { ObjectId } from "mongodb";
import { collections, getDb } from "./db";
import { appError } from "./errors";
import { log } from "./log";

const SESSION_COOKIE = "turf_admin_session";
const SESSION_TTL_SECONDS = 60 * 60 * 8; // 8 hours
const SCRYPT_KEYLEN = 64;

function secret(): string {
  const value = process.env.ADMIN_AUTH_SECRET;
  if (!value || value.length < 32) {
    throw new Error("ADMIN_AUTH_SECRET must be set to a random string of at least 32 characters");
  }
  return value;
}

/* ── Passwords ─────────────────────────────────────────────────────────── */

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(password, salt, SCRYPT_KEYLEN);
  return `scrypt$${salt.toString("hex")}$${key.toString("hex")}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [scheme, saltHex, keyHex] = stored.split("$");
  if (scheme !== "scrypt" || !saltHex || !keyHex) return false;
  const expected = Buffer.from(keyHex, "hex");
  let actual: Buffer;
  try {
    actual = crypto.scryptSync(password, Buffer.from(saltHex, "hex"), expected.length);
  } catch {
    return false;
  }
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

/* ── Sessions ──────────────────────────────────────────────────────────── */

export interface AdminSession {
  id: string;
  username: string;
  displayName: string;
}

interface SessionPayload extends AdminSession {
  exp: number;
}

const b64url = (buf: Buffer) => buf.toString("base64url");

function sign(data: string): string {
  return b64url(crypto.createHmac("sha256", secret()).update(data).digest());
}

function serialise(payload: SessionPayload): string {
  const body = b64url(Buffer.from(JSON.stringify(payload)));
  return `${body}.${sign(body)}`;
}

function deserialise(token: string): SessionPayload | null {
  const [body, signature] = token.split(".");
  if (!body || !signature) return null;
  // Compare BYTE lengths, not string lengths. A forged cookie can hold multi-byte
  // characters that make a 43-character signature 86 bytes long, and handing
  // mismatched buffers to timingSafeEqual throws — which would turn a bad cookie
  // into a 500 instead of a clean sign-out.
  const actual = Buffer.from(signature, "utf8");
  const expected = Buffer.from(sign(body), "utf8");
  if (actual.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(actual, expected)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString()) as SessionPayload;
    if (typeof payload.exp !== "number" || payload.exp * 1000 < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

export async function startSession(session: AdminSession): Promise<void> {
  const token = serialise({ ...session, exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS });
  (await cookies()).set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_TTL_SECONDS,
  });
}

export async function endSession(): Promise<void> {
  (await cookies()).set(SESSION_COOKIE, "", { httpOnly: true, path: "/", maxAge: 0 });
}

export async function getSession(): Promise<AdminSession | null> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return null;
  const payload = deserialise(token);
  if (!payload) return null;
  const { exp: _exp, ...session } = payload;
  return session;
}

/**
 * Gate for every privileged operation. Called inside the route handler itself —
 * never relies on the URL being secret or on middleware alone.
 */
export async function requireAdmin(): Promise<AdminSession> {
  const session = await getSession();
  if (!session) throw appError("UNAUTHORIZED");
  return session;
}

export async function authenticateAdmin(username: string, password: string): Promise<AdminSession | null> {
  const db = await getDb();
  const user = await collections.adminUsers(db).findOne({ username: username.toLowerCase() });

  // Hash even when the user is missing so response time does not reveal existence.
  const stored = user?.passwordHash ?? "scrypt$00$00";
  const ok = verifyPassword(password, stored);

  if (!user || !user.active || !ok) {
    log.warn("admin_login_failed", { username });
    return null;
  }

  await collections.adminUsers(db).updateOne({ _id: user._id }, { $set: { lastLoginAt: new Date() } });
  return { id: user._id.toHexString(), username: user.username, displayName: user.displayName };
}

/* ── Signed customer cookies ───────────────────────────────────────────── */

/**
 * A booking reference in a cookie is a bearer token: it lets the holder see that
 * customer's name and phone number on the success page and attach payment
 * screenshots to their booking. References travel in WhatsApp messages and on
 * printed receipts, so anyone forwarded one could otherwise set the cookie by
 * hand and read a stranger's details. Signing the value ties the cookie to this
 * server instead.
 */
export function signCookieValue(value: string): string {
  return `${value}.${sign(value)}`;
}

/** Returns the value only if this server issued it; null for anything else. */
export function readSignedCookieValue(raw: string | undefined): string | null {
  if (!raw) return null;
  const index = raw.lastIndexOf(".");
  if (index <= 0) return null;

  const value = raw.slice(0, index);
  const actual = Buffer.from(raw.slice(index + 1), "utf8");
  const expected = Buffer.from(sign(value), "utf8");
  if (actual.length !== expected.length) return null;
  try {
    return crypto.timingSafeEqual(actual, expected) ? value : null;
  } catch {
    return null;
  }
}

/* ── Audit log ─────────────────────────────────────────────────────────── */

export async function recordAudit(
  admin: AdminSession,
  action: string,
  entityType: string,
  entityId: string,
  metadata: Record<string, unknown> = {},
): Promise<void> {
  const db = await getDb();
  await collections.auditLogs(db).insertOne({
    _id: new ObjectId(),
    adminId: admin.id,
    adminUsername: admin.username,
    action,
    entityType,
    entityId,
    metadata,
    createdAt: new Date(),
  });
}
